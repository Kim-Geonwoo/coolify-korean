<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use PhpParser\Error;
use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Scalar;
use PhpParser\Node\Stmt;
use PhpParser\NodeFinder;
use PhpParser\Parser;
use PhpParser\ParserFactory;

/**
 * 템플릿 안에서 "영어 고정 문구로만 된 라벨 배열"이 어느 변수로 흘러가는지 문서 순서대로 따라간다.
 * 사용자 데이터(리소스 이름 등)가 섞일 수 있는 라벨은 번역하지 않기 위해서다.
 * - 출처: 라벨 항목(label·title …)이 모두 문자열(또는 문자열 삼항식)인 배열 리터럴.
 * - 값 자리(키 없는 항목, 하위 목록 키 children …, 함수 인자, 삼항·match의 결과)에 들어오는 것은 출처·파생 변수뿐이어야 한다.
 *   다른 변수나 출처를 모르는 데이터(getItems(), $server->menu, $this->items)가 들어오면 출처가 아니다.
 *   조건(삼항 조건, match 대상)·클로저 본문·라벨이 아닌 항목 값(route, active …)은 라벨을 만들지 않으므로 보지 않는다.
 * - 파생: 라벨 항목 없이 출처·파생 변수만으로 만든 값(collect($m)->filter(...), $m->groupBy('group'))과 @foreach 반복 변수.
 *   groupBy('라벨 키')로 묶은 값을 돌면 키 변수가 그 라벨 값이다. 키가 고정 문구인 배열을 키를 두는 메서드(map·filter …)로만
 *   거른 값을 돌아도 키 변수가 그 고정 문구다.
 * - 옮겨 담기: 라벨 항목 값이 고정 라벨을 그대로 옮긴 식이면(['group' => $group, 'label' => $event['label']]) 고정 문구로 본다.
 *   매핑 클로저(map 등)의 첫 매개변수는 대상 목록의 항목이라, 그 목록이 고정 라벨이면 클로저 안의 $event['label']도 옮겨 담기다.
 * - 오염: 라벨 경로에 다른 값을 넣거나, 출처가 아닌 항목을 덧붙이거나, push 등으로 바꾸면 더는 파생이 아니다.
 * 남는 위험: 클로저가 바깥 데이터를 돌려주는 경우(->map(fn () => $other))는 보지 않는다. 출력은 coolify_ko_t라 문자열이 아니어도 깨지지 않는다.
 */
final class LiteralLabelFlow
{
    public const LABEL_KEYS = ['label', 'title', 'description', 'group', 'section', 'subtitle', 'heading'];

    private const NESTED_KEYS = ['children', 'items', 'sections', 'groups', 'options', 'links'];

    private const MUTATING_METHODS = ['push', 'prepend', 'put', 'add', 'offsetset', 'splice', 'transform', 'merge'];

    private const MUTATING_FUNCTIONS = ['array_push', 'array_unshift', 'array_splice'];

    private const MAPPING_METHODS = ['map', 'flatmap', 'mapwithkeys', 'maptogroups', 'mapspread', 'pipe', 'when', 'unless', 'reduce'];

    /** 클로저의 첫 매개변수로 목록 항목 하나를 넘기는 매핑 메서드(pipe·reduce처럼 목록 전체나 누적값을 넘기는 것은 뺀다) */
    private const ITEM_MAPPING_METHODS = ['map', 'flatmap', 'mapwithkeys'];

    /** 결과의 키가 대상의 키 그대로(또는 그 일부)인 컬렉션 메서드와 함수 */
    private const KEY_PRESERVING_METHODS = ['map', 'filter', 'reject', 'sortby', 'sortbydesc', 'sortkeys', 'sortkeysdesc', 'only', 'except', 'where', 'wherenotnull', 'each'];

    private const KEY_PRESERVING_FUNCTIONS = ['collect', 'array_filter'];

    private readonly Parser $parser;

    private readonly NodeFinder $finder;

    /** @var array<string, array<int, true>> 파생 변수 → 출처 번호 */
    private array $derived = [];

    /** @var array<string, array{string, array<int, true>}> 라벨 값 자체를 담은 변수 → [라벨 키, 출처] */
    private array $scalars = [];

    /** @var array<string, string> groupBy로 묶은 파생 변수 → 라벨 키 */
    private array $groupedBy = [];

    /** @var array<string, int> 키가 모두 문자열인 고정 배열 변수 → 그 키들의 출처 번호 */
    private array $keySources = [];

    /** @var list<list<array{string, string, int, int}>> 출처 번호 → [라벨 키, 값, 템플릿 위치, 원문 순번] 목록 */
    private array $sources = [];

    /** @var array<string, list<array{string, int, int, string, list<array{string, int, int}>}>> 변수 → 정의에서 고정 라벨을 옮겨 담은 자리 [라벨 키, 시작, 끝, 식 원문, 값들] */
    private array $copies = [];

    /** @var list<array{string, int, int, string, list<array{string, int, int}>}> 지금 보는 식에서 찾은 옮겨 담기 자리 */
    private array $found = [];

    private int $offset = 0;

    /** 지금 읽는 @php 코드가 원본에서 시작하는 위치(모르면 null — 옮겨 담기 자리를 기록하지 않는다) */
    private ?int $codeStart = null;

    private string $code = '';

    private int $sequence = 0;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForNewestSupportedVersion();
        $this->finder = new NodeFinder();
    }

    /**
     * @php 블록(또는 @php(...) 인자)의 문장을 순서대로 반영한다.
     *
     * @param int|null $codeStart $code가 원본에서 시작하는 위치. 주면 옮겨 담기 자리(copySites)를 기록한다.
     */
    public function php(string $code, int $offset, ?int $codeStart = null): void
    {
        $statements = $this->parse($code . ';');
        if ($statements !== null) {
            $this->offset = $offset;
            $this->codeStart = $codeStart;
            $this->code = $code;
            $this->walk($statements);
            $this->codeStart = null;
        }
    }

    /** @foreach·@forelse 인자("$items as $item")를 반영한다. */
    public function foreach(string $arguments, int $offset): void
    {
        $statements = $this->parse('foreach (' . $arguments . ') {}');
        $loop = $statements[0] ?? null;
        if ($loop instanceof Stmt\Foreach_) {
            $this->offset = $offset;
            $this->codeStart = null;
            $this->loop($loop->expr, $loop->keyVar, $loop->valueVar);
        }
    }

    /**
     * 출력 식이 고정 라벨 값이면 그 값들(템플릿 위치, 원문 순번과 함께), 아니면 null.
     *
     * @return list<array{string, int, int}>|null
     */
    public function labelValues(?Expr $expr): ?array
    {
        return $expr === null ? null : $this->reference($expr, self::topScope());
    }

    /**
     * 변수를 정의한 식이 고정 라벨을 옮겨 담은 자리 중 라벨 키가 $keys인 것. 변수가 고정 라벨 파생 값이 아니면 빈 목록.
     * 정의 자리에서 번역하려는 쪽이 쓴다(이 변수가 화면 표시용 prop으로만 쓰일 때).
     *
     * @param list<string> $keys
     * @return list<array{int, int, string, list<array{string, int, int}>}> [시작, 끝, 식 원문, 값들]
     */
    public function copySites(string $variable, array $keys): array
    {
        if (!isset($this->derived[$variable])) {
            return [];
        }
        $sites = [];
        foreach ($this->copies[$variable] ?? [] as [$key, $start, $end, $code, $values]) {
            if (in_array($key, $keys, true)) {
                $sites[] = [$start, $end, $code, $values];
            }
        }

        return $sites;
    }

    /** @param array<mixed>|Node $nodes */
    private function walk(array|Node $nodes): void
    {
        foreach (is_array($nodes) ? $nodes : [$nodes] as $node) {
            if (!$node instanceof Node || $node instanceof Node\FunctionLike) {
                continue;
            }
            if ($node instanceof Expr\Assign) {
                if ($node->var instanceof Expr\List_ || $node->var instanceof Expr\Array_) {
                    $this->destructure($node->var, $node->expr);
                } else {
                    $this->assign($node->var, $node->expr);
                }
                continue;
            }
            if ($node instanceof Expr\AssignRef || $node instanceof Expr\AssignOp) {
                $this->taint($node->var);
                continue;
            }
            if ($node instanceof Stmt\Foreach_) {
                $this->loop($node->expr, $node->keyVar, $node->valueVar);
                $this->walk($node->stmts);
                continue;
            }
            if ($node instanceof Expr\MethodCall && $node->name instanceof Node\Identifier && in_array($node->name->toLowerString(), self::MUTATING_METHODS, true)) {
                $this->taint($node->var);
            } elseif ($node instanceof Expr\FuncCall && $node->name instanceof Node\Name && in_array($node->name->toLowerString(), self::MUTATING_FUNCTIONS, true)) {
                $first = $node->getArgs()[0] ?? null;
                if ($first !== null) {
                    $this->taint($first->value);
                }
            }
            foreach ($node->getSubNodeNames() as $name) {
                $sub = $node->$name;
                if ($sub instanceof Node || is_array($sub)) {
                    $this->walk($sub);
                }
            }
        }
    }

    private function assign(Expr $target, Expr $value): void
    {
        $root = self::root($target);
        if ($root === null) {
            return;
        }
        if ($target instanceof Expr\Variable) {
            $origin = $this->origin($value);
            $copied = $this->found;
            $group = $origin === null ? null : $this->groupKey($value);
            $keys = $origin === null ? null : $this->keySource($value);
            $texts = self::scalarTexts($value);
            $this->forget($root);
            if ($origin !== null) {
                $this->derived[$root] = $origin;
                if ($copied !== []) {
                    $this->copies[$root] = $copied;
                }
                if ($group !== null) {
                    $this->groupedBy[$root] = $group;
                }
            }
            if ($keys !== null) {
                $this->keySources[$root] = $keys;
            }
            if ($texts !== null) {
                $this->scalars[$root] = ['*', [$this->addSource(self::scalarPairs($texts)) => true]];
            }

            return;
        }
        if (!isset($this->derived[$root])) {
            return;
        }
        $last = $target instanceof Expr\ArrayDimFetch ? $target->dim : null;
        if ($last instanceof Scalar\String_ && in_array($last->value, self::LABEL_KEYS, true)) {
            if (self::isLiteralText($value)) {
                $pairs = array_map(static fn (string $text): array => [$last->value, $text], self::texts($value));
                $this->derived[$root] += [$this->addSource($pairs) => true];
            } else {
                $this->taint($target);
            }

            return;
        }
        $structural = !$last instanceof Scalar\String_ || in_array($last->value, self::NESTED_KEYS, true) || $this->labelItems($value) !== [];
        if (!$structural) {
            return;
        }
        $origin = $this->origin($value);
        if ($origin === null) {
            $this->taint($target);
        } else {
            $this->derived[$root] += $origin;
            if ($this->found !== []) {
                $this->copies[$root] = [...$this->copies[$root] ?? [], ...$this->found];
            }
        }
    }

    private function loop(Expr $expr, ?Expr $keyVar, Expr $valueVar): void
    {
        $origin = $this->origin($expr);
        $group = $this->groupKey($expr);
        if ($group === null && $expr instanceof Expr\Variable && is_string($expr->name)) {
            $group = $this->groupedBy[$expr->name] ?? null;
        }
        $keySource = $origin === null || $group !== null ? null : $this->keySource($expr);
        foreach ([$keyVar, $valueVar] as $var) {
            if ($var !== null) {
                $this->taint($var);
            }
        }
        if ($origin === null) {
            return;
        }
        if ($valueVar instanceof Expr\Variable && is_string($valueVar->name)) {
            $this->derived[$valueVar->name] = $origin;
        }
        if (!$keyVar instanceof Expr\Variable || !is_string($keyVar->name)) {
            return;
        }
        if ($group !== null) {
            $this->scalars[$keyVar->name] = [$group, $origin];

            return;
        }
        if ($keySource !== null) {
            $this->scalars[$keyVar->name] = ['*', [$keySource => true]];
        }
    }

    /**
     * 식의 키가 모두 고정 문구면 그 키들의 출처 번호. 키가 문자열인 배열 리터럴, 그런 배열을 담은 변수,
     * 그리고 그것을 키를 두는 메서드·함수(collect, ->map, ->filter …)로만 거친 값이다. ->values()·->keys()처럼 키를 바꾸면 null.
     */
    private function keySource(Expr $expr): ?int
    {
        if ($expr instanceof Expr\Variable && is_string($expr->name)) {
            return $this->keySources[$expr->name] ?? null;
        }
        if ($expr instanceof Expr\Array_) {
            $keys = self::literalKeys($expr);

            return $keys === null ? null : $this->addSource(self::scalarPairs($keys));
        }
        if ($expr instanceof Expr\MethodCall && $expr->name instanceof Node\Identifier && in_array($expr->name->toLowerString(), self::KEY_PRESERVING_METHODS, true)) {
            return $this->keySource($expr->var);
        }
        if ($expr instanceof Expr\FuncCall && $expr->name instanceof Node\Name && in_array($expr->name->toLowerString(), self::KEY_PRESERVING_FUNCTIONS, true)) {
            $first = $expr->getArgs()[0] ?? null;

            return $first === null ? null : $this->keySource($first->value);
        }

        return null;
    }

    /**
     * [$a, $b] = match (…) { … => ['Attention required', 'warning'], default => ['Ready', 'success'] }처럼 펼쳐 받을 때,
     * 모든 가지의 같은 자리가 문자열이면 그 자리 변수를 고정 문구 변수로 둔다.
     */
    private function destructure(Expr\List_|Expr\Array_ $pattern, Expr $value): void
    {
        $rows = self::tupleRows($value);
        foreach ($pattern->items as $index => $item) {
            if ($item === null) {
                continue;
            }
            $this->taint($item->value);
            if ($rows === null || $item->key !== null || !$item->value instanceof Expr\Variable || !is_string($item->value->name)) {
                continue;
            }
            $texts = [];
            foreach ($rows as $row) {
                $cell = $row->items[$index] ?? null;
                if ($cell === null || $cell->key !== null || !$cell->value instanceof Scalar\String_) {
                    continue 2;
                }
                $texts[] = $cell->value->value;
            }
            if ($texts !== []) {
                $this->scalars[$item->value->name] = ['*', [$this->addSource(self::scalarPairs($texts)) => true]];
            }
        }
    }

    /** @return list<Expr\Array_>|null 결과 자리(삼항 가지, match 가지)가 모두 배열 리터럴이면 그 배열들 */
    private static function tupleRows(Expr $expr): ?array
    {
        if ($expr instanceof Expr\Array_) {
            return [$expr];
        }
        $branches = self::branches($expr);
        if ($branches === null) {
            return null;
        }
        $rows = [];
        foreach ($branches as $branch) {
            $found = self::tupleRows($branch);
            if ($found === null) {
                return null;
            }
            array_push($rows, ...$found);
        }

        return $rows;
    }

    /** @return list<string>|null 문자열만 내는 식(문자열, 삼항·match의 가지가 모두 문자열 또는 null)의 문자열들 */
    private static function scalarTexts(Expr $expr): ?array
    {
        if ($expr instanceof Scalar\String_) {
            return [$expr->value];
        }
        if ($expr instanceof Expr\ConstFetch && $expr->name->toLowerString() === 'null') {
            return [];
        }
        $branches = self::branches($expr);
        if ($branches === null) {
            return null;
        }
        $texts = [];
        foreach ($branches as $branch) {
            $found = self::scalarTexts($branch);
            if ($found === null) {
                return null;
            }
            array_push($texts, ...$found);
        }

        return $texts === [] ? null : $texts;
    }

    /** @return list<Expr>|null 삼항(`?:` 제외)의 두 가지, match의 가지 결과 */
    private static function branches(Expr $expr): ?array
    {
        if ($expr instanceof Expr\Ternary && $expr->if !== null) {
            return [$expr->if, $expr->else];
        }
        if ($expr instanceof Expr\Match_) {
            return array_map(static fn (Node\MatchArm $arm): Expr => $arm->body, $expr->arms);
        }

        return null;
    }

    /** @return list<string>|null 키가 모두 문자열인 배열 리터럴이면 그 키들 */
    private static function literalKeys(Expr $expr): ?array
    {
        if (!$expr instanceof Expr\Array_ || $expr->items === []) {
            return null;
        }
        $keys = [];
        foreach ($expr->items as $item) {
            if (!$item->key instanceof Scalar\String_) {
                return null;
            }
            $keys[] = $item->key->value;
        }

        return $keys;
    }

    /**
     * @param list<string> $texts
     * @return list<array{string, string}>
     */
    private static function scalarPairs(array $texts): array
    {
        return array_map(static fn (string $text): array => ['*', $text], $texts);
    }

    /**
     * 식이 고정 라벨 출처이거나 그것만으로 만든 값이면 출처 번호 집합, 아니면 null.
     *
     * @return array<int, true>|null
     */
    private function origin(Expr $expr): ?array
    {
        $this->found = [];
        $pairs = $this->labelPairs($expr, self::topScope());
        $names = $pairs === null ? null : $this->valueSources($expr);
        $origin = [];
        foreach ($names ?? [] as $name) {
            if (!isset($this->derived[$name])) {
                $names = null;
                break;
            }
            $origin += $this->derived[$name];
        }
        if ($pairs === null || $names === null) {
            $this->found = [];

            return null;
        }
        if ($pairs === []) {
            return $origin;
        }
        $this->sources[] = $pairs;

        return $origin + [count($this->sources) - 1 => true];
    }

    /**
     * 식 안의 라벨 항목(label·title …)이 내는 [라벨 키, 값, 템플릿 위치, 원문 순번]. 값이 고정 문구도, 고정 라벨을 옮겨 담은 식도
     * 아닌 항목이 하나라도 있으면 null. 옮겨 담은 자리는 $this->found에 모은다.
     *
     * @param array{params: array<string, array<int, true>|null>, isolated: bool} $scope
     * @return list<array{string, string, int, int}>|null
     */
    private function labelPairs(Node $node, array $scope): ?array
    {
        if ($node instanceof Node\ArrayItem && $node->key instanceof Scalar\String_ && in_array($node->key->value, self::LABEL_KEYS, true)) {
            $key = $node->key->value;
            if (self::isLiteralText($node->value)) {
                return array_map(fn (string $text): array => [$key, $text, $this->offset, $this->sequence++], self::texts($node->value));
            }
            $values = $this->reference($node->value, $scope);
            if ($values === null) {
                return null;
            }
            $this->copied($key, $node->value, $values);

            return array_map(static fn (array $value): array => [$key, $value[0], $value[1], $value[2]], $values);
        }
        $item = $this->itemOrigin($node, $scope);
        $pairs = [];
        foreach ($node->getSubNodeNames() as $name) {
            $sub = $node->$name;
            foreach (is_array($sub) ? $sub : [$sub] as $child) {
                if ($child instanceof Node\Arg && $child->value instanceof Node\FunctionLike) {
                    $child = $child->value;
                }
                if (!$child instanceof Node) {
                    continue;
                }
                $found = $this->labelPairs($child, $child instanceof Node\FunctionLike ? $this->closureScope($child, $scope, $item) : $scope);
                if ($found === null) {
                    return null;
                }
                array_push($pairs, ...$found);
            }
        }

        return $pairs;
    }

    /**
     * 항목 매핑 호출(->map(fn ($item) => …), array_map(fn ($item) => …, $list))이면 클로저 첫 매개변수가 받는 항목의 출처.
     * 대상이 출처·파생 변수로만 된 고정 라벨 목록일 때만 준다(대상 자체에 라벨 항목이 있으면 주지 않는다). 그 밖에는 null.
     *
     * @param array{params: array<string, array<int, true>|null>, isolated: bool} $scope
     * @return array<int, true>|null
     */
    private function itemOrigin(Node $node, array $scope): ?array
    {
        $receiver = null;
        if (($node instanceof Expr\MethodCall || $node instanceof Expr\NullsafeMethodCall) && $node->name instanceof Node\Identifier
            && in_array($node->name->toLowerString(), self::ITEM_MAPPING_METHODS, true)) {
            $receiver = $node->var;
        } elseif ($node instanceof Expr\FuncCall && $node->name instanceof Node\Name && $node->name->toLowerString() === 'array_map') {
            $receiver = ($node->getArgs()[1] ?? null)?->value;
        }
        if ($receiver === null || $this->labelItems($receiver) !== []) {
            return null;
        }
        $origin = [];
        foreach ($this->valueSources($receiver) ?? [null] as $name) {
            $found = $name === null ? null : $this->derivedIn($name, $scope);
            if ($found === null) {
                return null;
            }
            $origin += $found;
        }

        return $origin;
    }

    /**
     * 클로저 안의 범위. 매개변수는 바깥 변수를 가리고, 첫 매개변수는 매핑 대상의 항목($item)이다.
     * 화살표 함수가 아닌 클로저는 use로 받은 변수만 바깥에서 읽는다.
     *
     * @param array{params: array<string, array<int, true>|null>, isolated: bool} $scope
     * @param array<int, true>|null $item
     * @return array{params: array<string, array<int, true>|null>, isolated: bool}
     */
    private function closureScope(Node\FunctionLike $function, array $scope, ?array $item): array
    {
        $params = $scope['params'];
        $isolated = $scope['isolated'];
        if ($function instanceof Expr\Closure) {
            $params = [];
            $isolated = true;
            foreach ($function->uses as $use) {
                if (is_string($use->var->name)) {
                    $params[$use->var->name] = $use->byRef ? null : $this->derivedIn($use->var->name, $scope);
                }
            }
        }
        foreach ($function->getParams() as $index => $param) {
            if ($param->var instanceof Expr\Variable && is_string($param->var->name)) {
                $params[$param->var->name] = $index === 0 ? $item : null;
            }
        }

        return ['params' => $params, 'isolated' => $isolated];
    }

    /** @return array{params: array<string, array<int, true>|null>, isolated: bool} */
    private static function topScope(): array
    {
        return ['params' => [], 'isolated' => false];
    }

    /**
     * 식이 고정 라벨 값을 그대로 내면 그 값들: 출처·파생 변수(또는 고정 라벨 목록을 도는 클로저 매개변수)의 라벨 항목,
     * 고정 문구 변수. 아니면 null.
     *
     * @param array{params: array<string, array<int, true>|null>, isolated: bool} $scope
     * @return list<array{string, int, int}>|null [값, 템플릿 위치, 원문 순번]
     */
    private function reference(Expr $expr, array $scope): ?array
    {
        $label = null;
        if ($expr instanceof Expr\ArrayDimFetch && $expr->dim instanceof Scalar\String_ && in_array($expr->dim->value, self::LABEL_KEYS, true)) {
            $root = self::root($expr->var);
            $origin = $root === null ? null : $this->derivedIn($root, $scope);
            $label = $origin === null ? null : [$expr->dim->value, $origin];
        } elseif ($expr instanceof Expr\Variable && is_string($expr->name)) {
            $hidden = array_key_exists($expr->name, $scope['params']) || $scope['isolated'];
            $label = $hidden ? null : ($this->scalars[$expr->name] ?? null);
        }
        if ($label === null) {
            return null;
        }
        [$key, $origins] = $label;
        $values = [];
        foreach (array_keys($origins) as $id) {
            foreach ($this->sources[$id] as [$pairKey, $value, $offset, $order]) {
                if ($pairKey === $key) {
                    $values[] = [$value, $offset, $order];
                }
            }
        }

        return $values;
    }

    /**
     * @param array{params: array<string, array<int, true>|null>, isolated: bool} $scope
     * @return array<int, true>|null
     */
    private function derivedIn(string $name, array $scope): ?array
    {
        if (array_key_exists($name, $scope['params'])) {
            return $scope['params'][$name];
        }

        return $scope['isolated'] ? null : ($this->derived[$name] ?? null);
    }

    /** @param list<array{string, int, int}> $values */
    private function copied(string $key, Expr $value, array $values): void
    {
        if ($this->codeStart === null) {
            return;
        }
        $from = (int) $value->getStartFilePos() - strlen('<?php ');
        $to = (int) $value->getEndFilePos() + 1 - strlen('<?php ');
        $this->found[] = [$key, $this->codeStart + $from, $this->codeStart + $to, substr($this->code, $from, $to - $from), $values];
    }

    /**
     * 식의 값으로 흘러드는 변수 이름. 조건(삼항 조건, match 대상·조건), 판정용 클로저(filter 등), 라벨·하위 목록이 아닌 항목 값은
     * 값이 아니므로 뺀다. 매핑 클로저(map 등)는 반환식이 값이고, 그 안의 클로저 매개변수는 중립이다.
     * 값 자리에서 변수 없이 다른 데이터를 읽으면(getItems(), $server->menu, $this->items) 출처를 모르므로 null.
     * 빈 배열이면 순수 리터럴(문자열·배열·상수)만으로 된 값이다.
     *
     * @param array<string, true> $neutral 클로저 매개변수
     * @return list<string>|null
     */
    private function valueSources(Expr $expr, array $neutral = []): ?array
    {
        if ($expr instanceof Expr\Variable) {
            if (!is_string($expr->name) || $expr->name === 'this') {
                return null;
            }

            return isset($neutral[$expr->name]) ? [] : [$expr->name];
        }
        if ($expr instanceof Scalar || $expr instanceof Expr\ConstFetch || $expr instanceof Expr\ClassConstFetch || $expr instanceof Node\FunctionLike) {
            return [];
        }
        if ($expr instanceof Expr\Array_) {
            $parts = [];
            foreach ($expr->items as $item) {
                if ($item->byRef) {
                    return null;
                }
                $key = $item->key instanceof Scalar\String_ ? $item->key->value : null;
                if ($item->unpack || $item->key === null || ($key !== null && in_array($key, self::NESTED_KEYS, true))) {
                    $parts[] = [$item->value, $neutral];
                }
            }

            return $this->sourcesOf($parts);
        }
        if ($expr instanceof Expr\Ternary) {
            return $this->sourcesOf([[$expr->if ?? $expr->cond, $neutral], [$expr->else, $neutral]]);
        }
        if ($expr instanceof Expr\Match_) {
            return $this->sourcesOf(array_map(static fn (Node\MatchArm $arm): array => [$arm->body, $neutral], $expr->arms));
        }
        if ($expr instanceof Expr\ArrayDimFetch) {
            return $this->valueSources($expr->var, $neutral);
        }
        if ($expr instanceof Expr\FuncCall || $expr instanceof Expr\MethodCall || $expr instanceof Expr\NullsafeMethodCall || $expr instanceof Expr\StaticCall) {
            return $this->callSources($expr, $neutral);
        }
        if ($expr instanceof Expr\BinaryOp) {
            return $this->sourcesOf([[$expr->left, $neutral], [$expr->right, $neutral]]);
        }
        if ($expr instanceof Expr\Cast) {
            return $this->valueSources($expr->expr, $neutral);
        }

        return null;
    }

    /**
     * 호출의 값은 대상·인자에서 온다. 매핑 함수(map·array_map …)의 클로저는 반환식이 값이다.
     * 데이터 입력이 하나도 없는 호출(getItems(), config('x'))은 출처를 모르므로 null. 빈 collect()만 예외다.
     *
     * @param array<string, true> $neutral
     * @return list<string>|null
     */
    private function callSources(Expr\FuncCall|Expr\MethodCall|Expr\NullsafeMethodCall|Expr\StaticCall $call, array $neutral): ?array
    {
        $name = $call->name instanceof Node\Identifier || $call->name instanceof Node\Name ? $call->name->toLowerString() : '';
        $mapping = $call instanceof Expr\FuncCall ? $name === 'array_map' : in_array($name, self::MAPPING_METHODS, true);
        $inputs = $call instanceof Expr\MethodCall || $call instanceof Expr\NullsafeMethodCall ? [$call->var] : [];
        foreach ($call->getArgs() as $arg) {
            $inputs[] = $arg->value;
        }
        $parts = [];
        $hasData = false;
        foreach ($inputs as $input) {
            if ($input instanceof Node\FunctionLike) {
                if ($mapping) {
                    $scope = $neutral + self::params($input);
                    foreach (self::returns($input) as $returned) {
                        $parts[] = [$returned, $scope];
                        $hasData = true;
                    }
                }
                continue;
            }
            $hasData = $hasData || !$input instanceof Scalar;
            $parts[] = [$input, $neutral];
        }
        if (!$hasData) {
            return $call instanceof Expr\FuncCall && $name === 'collect' && $inputs === [] ? [] : null;
        }

        return $this->sourcesOf($parts);
    }

    /**
     * @param list<array{Expr, array<string, true>}> $parts 식과 그 자리의 중립 이름
     * @return list<string>|null
     */
    private function sourcesOf(array $parts): ?array
    {
        $names = [];
        foreach ($parts as [$expr, $neutral]) {
            $found = $this->valueSources($expr, $neutral);
            if ($found === null) {
                return null;
            }
            foreach ($found as $name) {
                $names[$name] = true;
            }
        }

        return array_keys($names);
    }

    /** @return array<string, true> */
    private static function params(Node\FunctionLike $function): array
    {
        $names = [];
        foreach ($function->getParams() as $param) {
            if ($param->var instanceof Expr\Variable && is_string($param->var->name)) {
                $names[$param->var->name] = true;
            }
        }

        return $names;
    }

    /** @return list<Expr> 클로저가 돌려주는 식 */
    private function returns(Node\FunctionLike $function): array
    {
        if ($function instanceof Expr\ArrowFunction) {
            return [$function->expr];
        }
        $returned = [];
        foreach ($this->finder->findInstanceOf($function->getStmts() ?? [], Stmt\Return_::class) as $return) {
            if ($return->expr !== null) {
                $returned[] = $return->expr;
            }
        }

        return $returned;
    }

    /** @return list<Node\ArrayItem> */
    private function labelItems(Expr $expr): array
    {
        return array_values(array_filter(
            $this->finder->findInstanceOf([$expr], Node\ArrayItem::class),
            static fn (Node\ArrayItem $item): bool => $item->key instanceof Scalar\String_ && in_array($item->key->value, self::LABEL_KEYS, true),
        ));
    }

    private function groupKey(Expr $expr): ?string
    {
        for ($call = $expr; $call instanceof Expr\MethodCall; $call = $call->var) {
            $first = $call->getArgs()[0] ?? null;
            if ($call->name instanceof Node\Identifier && $call->name->toLowerString() === 'groupby'
                && $first !== null && $first->value instanceof Scalar\String_ && in_array($first->value->value, self::LABEL_KEYS, true)) {
                return $first->value->value;
            }
        }

        return null;
    }

    /** @param list<array{string, string}> $pairs */
    private function addSource(array $pairs): int
    {
        $numbered = [];
        foreach ($pairs as [$key, $value]) {
            $numbered[] = [$key, $value, $this->offset, $this->sequence++];
        }
        $this->sources[] = $numbered;

        return count($this->sources) - 1;
    }

    private function taint(Expr $target): void
    {
        $root = self::root($target);
        if ($root !== null) {
            $this->forget($root);
        }
    }

    private function forget(string $name): void
    {
        unset($this->derived[$name], $this->scalars[$name], $this->groupedBy[$name], $this->keySources[$name], $this->copies[$name]);
    }

    /** @return list<Node\Stmt>|null */
    private function parse(string $code): ?array
    {
        try {
            return $this->parser->parse('<?php ' . $code);
        } catch (Error) {
            return null;
        }
    }

    private static function root(Expr $expr): ?string
    {
        while ($expr instanceof Expr\ArrayDimFetch) {
            $expr = $expr->var;
        }

        return $expr instanceof Expr\Variable && is_string($expr->name) ? $expr->name : null;
    }

    /** 문자열 리터럴, 또는 가지가 모두 고정 문구인 삼항식. */
    private static function isLiteralText(Expr $expr): bool
    {
        return $expr instanceof Scalar\String_
            || ($expr instanceof Expr\Ternary && $expr->if !== null && self::isLiteralText($expr->if) && self::isLiteralText($expr->else));
    }

    /** @return list<string> */
    private static function texts(Expr $expr): array
    {
        if ($expr instanceof Scalar\String_) {
            return [$expr->value];
        }
        if ($expr instanceof Expr\Ternary && $expr->if !== null) {
            return [...self::texts($expr->if), ...self::texts($expr->else)];
        }

        return [];
    }
}
