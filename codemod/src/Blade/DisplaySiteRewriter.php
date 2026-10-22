<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Edit\Edit;
use CoolifyKo\Codemod\Php\PhpString;
use CoolifyKo\Codemod\Php\SafeExpression;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\PlaceholderAllocator;
use CoolifyKo\Codemod\Text\SkipReason;
use CoolifyKo\Codemod\Text\TextClassifier;
use Illuminate\Support\Str;
use PhpParser\Error;
use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\Node\Scalar;
use PhpParser\Node\Stmt;
use PhpParser\Parser;
use PhpParser\ParserFactory;
use Stillat\BladeParser\Nodes\AbstractNode;
use Stillat\BladeParser\Nodes\Components\ComponentNode;
use Stillat\BladeParser\Nodes\Components\ParameterType;
use Stillat\BladeParser\Nodes\DirectiveNode;
use Stillat\BladeParser\Nodes\EchoNode;
use Stillat\BladeParser\Nodes\EchoType;
use Stillat\BladeParser\Nodes\PhpBlockNode;

/**
 * 템플릿에 영어로 정의된 값을 번역한다.
 * - 메뉴 라벨처럼 @php 배열에 정의돼 키·slug·비교에도 쓰이는 값은 정의를 그대로 두고, 화면에 출력하는 곳만
 *   {{ coolify_ko_t($item['label']) }}로 감싼다. 로직은 영어 값으로 계속 돈다. 감싸는 값은 LiteralLabelFlow가
 *   고정 문구만 흘러온다고 확인한 것뿐이다(사용자 데이터 라벨은 그대로).
 * - 고정 문구 변수({{ $dashboardContext }} 등)도 같은 방식으로 감싼다. 컴포넌트에 Text prop으로 넘기면(:label="$group")
 *   넘기는 값을 coolify_ko_t($group)으로 감싼다. 태그 속성 값이 그 echo 하나뿐이어도(title="{{ $directionLabel }}") 감싼다.
 * - 배열 prop에 변수로 넘긴 목록이 고정 라벨을 옮겨 담아 만든 것이고 그 변수가 다른 곳에 쓰이지 않으면,
 *   옮겨 담은 자리('label' => $event['label'])를 정의에서 coolify_ko_t로 감싼다.
 * - 그 밖의 echo는 화면에 나가는 값 자리의 문자열만 번역한다({{ $ok ? 'Ready' : 'Unavailable' }} → 가지마다 __()).
 *   Text prop으로 묶어 넘기는 값(:container-name="$x ? 'A' : 'B'")도 같고, 여기서는 이어 붙인 라벨
 *   (:label="$label . ' URL (internal)'")도 __(':label URL (internal)', ['label' => $label])로 바꾼다.
 * - 출력 지점 번역은 문장 후보 안에 글자 든 다른 내용이 없는 echo에만 한다(문장 속 echo만 바꾸면 반쪽 번역이 된다).
 * - 컴포넌트의 @props 기본값은, 규칙 파일이 번역 후보로 둔 속성이고 템플릿에서 화면 출력에만 쓰일 때 기본값 자리에서
 *   번역한다(호출부가 넘긴 값은 건드리지 않는다. 호출부의 문구는 AttributeRewriter가 같은 규칙으로 바꾼다).
 * - 배열 리터럴로 넘기는 prop(규칙 componentArrayProps, listbox :options의 label 등)과 @include 데이터 배열(규칙 includeArgs)은
 *   화면 글자 키의 값 자리 문자열만 바꾼다(value·id 같은 로직 키는 그대로).
 * - 템플릿이 비교에 쓰는 값(규칙 logicValues, 예: step2ButtonText의 'Continue')은 기본값·호출부에서 영어로 두고,
 *   비교를 거친 변수를 @js()로 내보내는 곳(규칙 displayVariables)만 coolify_ko_t로 감싼다.
 * 라벨 값은 'display' 종류로 카탈로그에 넣는다.
 */
final class DisplaySiteRewriter
{
    /** 첫 인자 목록을 그대로(또는 걸러서) 돌려주는 함수. 배열 prop의 목록이 이 안에 있어도 따라간다. */
    private const LIST_FUNCTIONS = ['collect', 'array_values', 'array_filter'];

    /** 인자 하나를 목록 항목으로 덧붙이는 컬렉션 메서드 */
    private const ITEM_METHODS = ['prepend', 'push'];

    private readonly Parser $parser;

    private readonly LeafRewriter $leaves;

    public function __construct(
        private readonly RuleSet $rules,
        private readonly TextClassifier $classifier,
        private readonly SafeExpression $expressions,
        private readonly ComponentProps $props,
    ) {
        $this->parser = (new ParserFactory())->createForNewestSupportedVersion();
        $this->leaves = new LeafRewriter($classifier, $expressions);
    }

    /**
     * @param list<Segment> $segments
     * @param list<array{int, int}> $taken 이미 다른 규칙이 바꾼 구간
     * @param array<int, true> $standaloneEchoes 문장 후보 안에서 혼자 있는 echo의 시작 위치(이런 echo만 출력 지점에서 번역)
     * @return list<SentenceOutcome>
     */
    public function rewrite(array $segments, string $path, array $taken, array $standaloneEchoes = []): array
    {
        $component = self::componentName($path);
        $displayVariables = $component === null ? [] : ($this->rules->displayVariables[$component] ?? []);
        $flow = new LiteralLabelFlow();
        $source = implode('', array_map(static fn (Segment $segment): string => $segment->source, $segments));
        $outcomes = [];
        /** @var array<string, array{int, int}> $display 값 → [템플릿 위치, 원문 순번] */
        $display = [];
        foreach ($segments as $segment) {
            if ($displayVariables !== []) {
                array_push($outcomes, ...$this->displayVariables($segment, $displayVariables, $taken));
            }
            if ($segment->kind === SegmentKind::Tag && $segment->inner !== []) {
                array_push($outcomes, ...$this->attributeEchoes($segment, $flow, $taken, $display));
                continue;
            }
            $node = $segment->node;
            if ($node instanceof PhpBlockNode) {
                $flow->php($node->innerContent, $segment->start, self::codeStart($segment, $node->innerContent));
                continue;
            }
            if ($node instanceof DirectiveNode) {
                $arguments = $node->arguments?->innerContent;
                $name = strtolower($node->content);
                if ($arguments === null) {
                    continue;
                }
                if ($name === 'php') {
                    $flow->php($arguments, $segment->start, self::codeStart($segment, $arguments));
                } elseif ($name === 'foreach' || $name === 'forelse') {
                    $flow->foreach($arguments, $segment->start);
                } elseif ($name === 'props' && $component !== null) {
                    array_push($outcomes, ...$this->propDefaults($segment, $arguments, $component));
                } elseif ($name === 'include' && !self::inside($segment, $taken)) {
                    array_push($outcomes, ...$this->includeArgs($segment, $arguments));
                }
                continue;
            }
            if ($node instanceof ComponentNode) {
                array_push($outcomes, ...$this->boundProps($segment, $node, $flow, $taken, $display, $source));
                continue;
            }
            if (!$node instanceof EchoNode || $node->type !== EchoType::Echo || $segment->context->protected || self::inside($segment, $taken)
                || !isset($standaloneEchoes[$segment->start])) {
                continue;
            }
            $code = trim($node->innerContent);
            $expr = $this->expressions->parse($code);
            $values = $flow->labelValues($expr) ?? $this->fixedValues($path, $code, $segment->start);
            if ($values === null) {
                $codeStart = strpos($segment->source, $code);
                if ($expr !== null && $codeStart !== false) {
                    array_push($outcomes, ...$this->leaves->literals($expr, $segment->start + $codeStart, 'echo-literal'));
                }
                continue;
            }
            $outcomes[] = SentenceOutcome::converted(new Edit($segment->start, $segment->end, '{{ coolify_ko_t(' . $code . ') }}'), '', 'display-site', []);
            self::remember($display, $values);
        }
        uasort($display, static fn (array $a, array $b): int => $a[1] <=> $b[1]);
        foreach ($display as $value => [$offset]) {
            if ($this->classifier->skipReason((string) $value) === null) {
                $outcomes[] = SentenceOutcome::extracted((string) $value, $offset, 'display');
            }
        }

        return $outcomes;
    }

    /**
     * 문장·속성 변환이 치환값으로 옮긴 식이 템플릿 고정 문구 변수($resourceLabel처럼 @php의 match로 정한 값)이거나
     * 규칙 displayExpressions의 식이면, 그 치환값을 coolify_ko_t로 감싼다("Delete :resource_label"이 반쪽 번역이 되지 않게).
     * 편집 구간은 그대로 두고 바꾼 글자만 고친다. 감싼 값의 영어는 display 키로 넣는다.
     * 대상은 문장(text·rich·plural)과 컴포넌트 속성 문장(prop-text·prop-html)이다(속성·이어 붙이기 문장은 만들 때 이미 감싼다).
     *
     * @param list<Segment> $segments
     * @param list<SentenceOutcome> $outcomes
     * @return list<SentenceOutcome>
     */
    public function wrapPlaceholders(array $segments, array $outcomes, string $path): array
    {
        $pending = array_keys(array_filter(
            $outcomes,
            static fn (SentenceOutcome $o): bool => $o->edit !== null && in_array($o->kind, ['text', 'rich', 'plural', 'prop-text', 'prop-html'], true),
        ));
        usort($pending, static fn (int $a, int $b): int => $outcomes[$a]->start <=> $outcomes[$b]->start);
        $flow = new LiteralLabelFlow();
        $display = [];
        $next = 0;
        foreach ([...$segments, null] as $segment) {
            while ($next < count($pending) && ($segment === null || $outcomes[$pending[$next]]->start < $segment->start)) {
                $outcomes[$pending[$next]] = $this->wrapOutcome($outcomes[$pending[$next]], $flow, $path, $display);
                $next++;
            }
            if ($segment !== null) {
                self::advance($flow, $segment);
            }
        }
        $known = [];
        foreach ($outcomes as $outcome) {
            if ($outcome->edit === null && $outcome->kind === 'display') {
                $known[$outcome->key] = true;
            }
        }
        uasort($display, static fn (array $a, array $b): int => $a[1] <=> $b[1]);
        foreach ($display as $value => [$offset]) {
            if (!isset($known[(string) $value]) && $this->classifier->skipReason((string) $value) === null) {
                $outcomes[] = SentenceOutcome::extracted((string) $value, $offset, 'display');
            }
        }

        return $outcomes;
    }

    /**
     * 바꾼 글자({{ __('…', [치환]) }}·:prop="__('…', [치환])" 등)의 치환 배열에서 고정 문구 치환값을 coolify_ko_t로 감싼다.
     *
     * @param array<string, array{int, int}> $display
     */
    private function wrapOutcome(SentenceOutcome $outcome, LiteralLabelFlow $flow, string $path, array &$display): SentenceOutcome
    {
        $edit = $outcome->edit;
        if ($edit === null) {
            return $outcome;
        }
        if (preg_match('/^\{\{ (.*) \}\}$/s', $edit->replacement, $m, PREG_OFFSET_CAPTURE) !== 1
            && preg_match('/^:[\w.:-]+="(.*)"$/s', $edit->replacement, $m, PREG_OFFSET_CAPTURE) !== 1) {
            return $outcome;
        }
        [$code, $codeAt] = $m[1];
        $call = $this->expressions->parse($code);
        $call = $call instanceof Expr\Cast\String_ ? $call->expr : $call;
        $index = $call instanceof Expr\FuncCall && $call->name instanceof Name ? ['__' => 1, '__h' => 2, 'trans_choice' => 2][$call->name->toLowerString()] ?? null : null;
        $replace = $index === null ? null : ($call->args[$index] ?? null);
        if (!$replace instanceof Arg || !$replace->value instanceof Expr\Array_) {
            return $outcome;
        }
        $splices = [];
        foreach ($replace->value->items as $item) {
            $target = $item->value;
            if ($target instanceof Expr\FuncCall && $target->name instanceof Name && $target->name->toLowerString() === 'e' && count($target->args) === 1 && $target->args[0] instanceof Arg) {
                $target = $target->args[0]->value;
            }
            $from = (int) $target->getStartFilePos() - strlen('<?php ');
            $to = (int) $target->getEndFilePos() + 1 - strlen('<?php ');
            $values = $this->expressions->isTranslationCall($target) ? null
                : ($flow->labelValues($target) ?? $this->fixedValues($path, substr($code, $from, $to - $from), $edit->start));
            if ($values !== null) {
                $splices[] = [$from, $to];
                self::remember($display, $values);
            }
        }
        foreach (array_reverse($splices) as [$from, $to]) {
            $code = substr($code, 0, $from) . 'coolify_ko_t(' . substr($code, $from, $to - $from) . ')' . substr($code, $to);
        }
        if ($splices === []) {
            return $outcome;
        }
        $replacement = substr($edit->replacement, 0, $codeAt) . $code . substr($edit->replacement, $codeAt + strlen($m[1][0]));

        return SentenceOutcome::converted(new Edit($edit->start, $edit->end, $replacement), $outcome->key, $outcome->kind, $outcome->placeholders, $outcome->counts);
    }

    /** @php·@foreach 조각이면 고정 라벨 흐름에 반영한다. */
    private static function advance(LiteralLabelFlow $flow, Segment $segment): void
    {
        $node = $segment->node;
        if ($node instanceof PhpBlockNode) {
            $flow->php($node->innerContent, $segment->start);
        } elseif ($node instanceof DirectiveNode && $node->arguments !== null) {
            $name = strtolower($node->content);
            if ($name === 'php') {
                $flow->php($node->arguments->innerContent, $segment->start);
            } elseif ($name === 'foreach' || $name === 'forelse') {
                $flow->foreach($node->arguments->innerContent, $segment->start);
            }
        }
    }

    /**
     * 규칙 displayExpressions에 이 뷰의 식으로 적힌 코드면 그 식이 낼 수 있는 영어 값들(템플릿 위치와 함께), 아니면 null.
     * 식은 공백을 빼고 비교한다.
     *
     * @return list<array{string, int, int}>|null
     */
    private function fixedValues(string $path, string $code, int $offset): ?array
    {
        $view = preg_match('#(?:^|/)views/(.+)\.blade\.php$#', $path, $m) === 1 ? str_replace('/', '.', $m[1]) : null;
        $squeeze = static fn (string $text): string => (string) preg_replace('/\s+/', '', $text);
        foreach ($view === null ? [] : ($this->rules->displayExpressions[$view] ?? []) as $expression => $values) {
            if ($squeeze($expression) === $squeeze($code)) {
                return array_map(static fn (string $value, int $order): array => [$value, $offset, PHP_INT_MAX - count($values) + $order], $values, array_keys($values));
            }
        }

        return null;
    }

    /**
     * @include('뷰', [...]) 데이터 배열에서 규칙 includeArgs의 키 값만 바꾼다.
     *
     * @return list<SentenceOutcome>
     */
    private function includeArgs(Segment $segment, string $arguments): array
    {
        $argumentsStart = strpos($segment->source, $arguments);
        $call = $this->expressions->parse('f(' . $arguments . ')');
        if ($argumentsStart === false || !$call instanceof Expr\FuncCall) {
            return [];
        }
        $view = $call->args[0] ?? null;
        $data = $call->args[1] ?? null;
        if (!$view instanceof Arg || !$view->value instanceof Scalar\String_ || !$data instanceof Arg || !$data->value instanceof Expr\Array_) {
            return [];
        }
        $keys = $this->rules->includeArgs[$view->value->value] ?? [];
        $codeStart = $segment->start + $argumentsStart - strlen('f(');
        $outcomes = [];
        foreach ($data->value->items as $item) {
            $sink = $item->key instanceof Scalar\String_ ? ($keys[$item->key->value] ?? null) : null;
            if ($sink !== null && !$item->unpack && !$item->byRef) {
                array_push($outcomes, ...$this->leaves->literals($item->value, $codeStart, 'prop-literal', $sink === 'js'));
            }
        }

        return $outcomes;
    }

    /**
     * 배열 리터럴 prop에서 화면 글자 자리의 식을 모은다. 행 배열(['value' => …, 'label' => …])은 규칙의 키 값만,
     * '*'면 키 없는 항목 자체를 본다. collect()·array_values()·array_filter()로 감싼 목록과 ->prepend()·->push()로
     * 덧붙인 행도 따라간다. 클로저(->map(fn …))가 만드는 행은 데이터에서 오므로 보지 않는다.
     *
     * @param list<string> $keys
     * @return list<Expr>
     */
    private static function arrayDisplayValues(Expr $expr, array $keys): array
    {
        if ($expr instanceof Expr\Array_) {
            $values = [];
            foreach ($expr->items as $item) {
                if ($item->key === null && !$item->unpack && !$item->byRef) {
                    array_push($values, ...self::rowValues($item->value, $keys));
                }
            }

            return $values;
        }
        if ($expr instanceof Expr\FuncCall && $expr->name instanceof Name && in_array($expr->name->toLowerString(), self::LIST_FUNCTIONS, true)) {
            $first = $expr->args[0] ?? null;

            return $first instanceof Arg ? self::arrayDisplayValues($first->value, $keys) : [];
        }
        if ($expr instanceof Expr\MethodCall) {
            $values = self::arrayDisplayValues($expr->var, $keys);
            $first = $expr->args[0] ?? null;
            if ($expr->name instanceof Identifier && in_array($expr->name->toLowerString(), self::ITEM_METHODS, true) && $first instanceof Arg) {
                array_push($values, ...self::rowValues($first->value, $keys));
            }

            return $values;
        }

        return [];
    }

    /**
     * 목록 항목 하나에서 화면 글자 자리의 식. 행 배열이면 규칙 키의 값, 행을 고르는 삼항이면 두 가지, '*'면 항목 자체.
     *
     * @param list<string> $keys
     * @return list<Expr>
     */
    private static function rowValues(Expr $expr, array $keys): array
    {
        if ($expr instanceof Expr\Array_) {
            $values = [];
            foreach ($expr->items as $item) {
                if ($item->key instanceof Scalar\String_ && in_array($item->key->value, $keys, true)) {
                    $values[] = $item->value;
                }
            }

            return $values;
        }
        if ($expr instanceof Expr\Ternary && ($expr->if instanceof Expr\Array_ || $expr->else instanceof Expr\Array_)) {
            return [...($expr->if === null ? [] : self::rowValues($expr->if, $keys)), ...self::rowValues($expr->else, $keys)];
        }

        return in_array('*', $keys, true) ? [$expr] : [];
    }

    /**
     * 태그 속성(title·aria-label …) 값에 echo가 낀 것을 번역한다. 속성 값은 화면 글자라 로직에 쓰이지 않는다.
     * - 값이 공백을 빼면 고정 문구 변수 echo 하나뿐이면(title="{{ $directionLabel }}") 그 echo를 {{ coolify_ko_t(…) }}로 감싼다.
     * - 글자와 echo로 된 문장이면 속성째 자리표시자 문장으로 바꾼다(attributeSentence).
     *
     * @param list<array{int, int}> $taken
     * @param array<string, array{int, int}> $display
     * @return list<SentenceOutcome>
     */
    private function attributeEchoes(Segment $segment, LiteralLabelFlow $flow, array $taken, array &$display): array
    {
        $tag = $segment->tag;
        if ($tag === null || $tag->closing || $segment->context->protected || str_contains($tag->name, ':') || str_starts_with($tag->name, 'x-')) {
            return [];
        }
        $outcomes = [];
        foreach ($tag->attributeList() as $attribute) {
            if ($attribute['quote'] === null || !in_array($attribute['name'], $this->rules->htmlAttributes, true)) {
                continue;
            }
            $text = substr($segment->source, $attribute['start'], $attribute['end'] - $attribute['start']);
            $valueStart = $segment->start + $attribute['start'] + (int) strpos($text, $attribute['quote']) + 1;
            $valueEnd = $segment->start + $attribute['end'] - 1;
            $inside = array_values(array_filter($segment->inner, static fn (array $inner): bool => $inner[0] >= $valueStart && $inner[1] <= $valueEnd));
            if ($inside === []) {
                continue;
            }
            [$start, $end, $node] = $inside[0];
            $alone = count($inside) === 1 && $node instanceof EchoNode && $node->type === EchoType::Echo
                && trim(substr($segment->source, $valueStart - $segment->start, $start - $valueStart)) === ''
                && trim(substr($segment->source, $end - $segment->start, $valueEnd - $end)) === '';
            if (!$alone) {
                array_push($outcomes, ...$this->attributeSentence($segment, $attribute, $valueStart, $valueEnd, $inside, $flow, $taken, $display));
                continue;
            }
            $code = trim($node->innerContent);
            $values = $flow->labelValues($this->expressions->parse($code));
            if ($values !== null && !self::overlaps($start, $end, $taken)) {
                $outcomes[] = SentenceOutcome::converted(new Edit($start, $end, '{{ coolify_ko_t(' . $code . ') }}'), '', 'display-site', []);
                self::remember($display, $values);
            }
        }

        return $outcomes;
    }

    /**
     * 속성 값이 글자와 echo로 된 문장이면(aria-label="Open {{ $project->name }}") 속성째 {{ __('Open :name', [...]) }}로 바꾼다.
     * 개수 문장이면 trans_choice로 만든다(PluralPhrase). echo는 치환값으로 옮겨도 안전한 식이어야 하고, 템플릿의 고정 문구면
     * coolify_ko_t로 감싼다(반쪽 번역 방지). 큰따옴표 속성의 한 줄짜리 값만 바꾼다(속성 값의 공백은 그대로 쓰이므로 키도 원문 그대로 둔다).
     *
     * @param array{name: string, value: string|null, quote: string|null, start: int, end: int} $attribute
     * @param list<array{int, int, AbstractNode}> $inside 값 안의 Blade 노드
     * @param list<array{int, int}> $taken
     * @param array<string, array{int, int}> $display
     * @return list<SentenceOutcome>
     */
    private function attributeSentence(Segment $segment, array $attribute, int $valueStart, int $valueEnd, array $inside, LiteralLabelFlow $flow, array $taken, array &$display): array
    {
        $from = $segment->start + $attribute['start'];
        $to = $segment->start + $attribute['end'];
        $value = substr($segment->source, $valueStart - $segment->start, $valueEnd - $valueStart);
        if ($attribute['quote'] !== '"' || self::overlaps($from, $to, $taken) || preg_match('/[\t\n\r]|^\s|\s$|\s\s/', $value) === 1) {
            return [];
        }
        $parts = [];
        $cursor = $valueStart;
        foreach ($inside as [$start, $end, $node]) {
            $expr = $node instanceof EchoNode && $node->type === EchoType::Echo ? $this->expressions->parse(trim($node->innerContent)) : null;
            // number_format(…)은 동등성 검사의 대역 객체로 평가할 수 없어(양쪽 TypeError) 허용 목록 없이는 검증되지 않는다. 바꾸지 않는다
            if (!$node instanceof EchoNode || $expr === null || preg_match('/\bnumber_format\s*\(/i', $node->innerContent) === 1) {
                return [];
            }
            if ($start > $cursor) {
                $parts[] = ['text', html_entity_decode(substr($segment->source, $cursor - $segment->start, $start - $cursor), ENT_QUOTES | ENT_HTML5, 'UTF-8')];
            }
            $parts[] = ['echo', trim($node->innerContent), $expr];
            $cursor = $end;
        }
        if ($cursor < $valueEnd) {
            $parts[] = ['text', html_entity_decode(substr($segment->source, $cursor - $segment->start, $valueEnd - $cursor), ENT_QUOTES | ENT_HTML5, 'UTF-8')];
        }
        $allocator = new PlaceholderAllocator();
        foreach ($parts as $part) {
            if ($part[0] === 'text') {
                $allocator->reserveFrom($part[1]);
            }
        }
        $name = $attribute['name'];
        $plural = PluralPhrase::sentence($parts, $allocator);
        if ($plural !== null) {
            if (!$this->sayable((string) preg_replace('/:\w+/', ' ', explode('|', $plural['key'])[1]), [$plural['key'], ...$plural['inner']])) {
                return [];
            }
            $outcomes = [SentenceOutcome::converted(new Edit($from, $to, $name . '="{{ ' . $plural['code'] . ' }}"'), $plural['key'], 'plural', $plural['placeholders'], $plural['counts'])];
            foreach ($plural['inner'] as $inner) {
                $outcomes[] = SentenceOutcome::extracted($inner, $from, 'plural', ['count']);
            }

            return $outcomes;
        }
        $key = '';
        $plain = '';
        $replace = [];
        $labels = [];
        foreach ($parts as $part) {
            if ($part[0] === 'text') {
                $key .= $part[1];
                $plain .= $part[1];
                continue;
            }
            [, $code, $expr] = $part;
            if (PluralPhrase::form($expr, $code) !== null || !$this->expressions->isSafePlaceholderValue($expr)) {
                return [];
            }
            $placeholder = $allocator->nameFor($code, $expr);
            $values = $flow->labelValues($expr);
            $replace[$placeholder] = $values === null ? $code : 'coolify_ko_t(' . $code . ')';
            if ($values !== null) {
                $labels[] = $values;
            }
            $key .= ':' . $placeholder;
        }
        if (!$this->sayable($plain, [$key])) {
            return [];
        }
        foreach ($labels as $values) {
            self::remember($display, $values);
        }
        $pairs = implode(', ', array_map(
            static fn (string $placeholder, string $code): string => PhpString::singleQuoted($placeholder) . ' => ' . $code,
            array_keys($replace),
            array_values($replace),
        ));

        return [SentenceOutcome::converted(new Edit($from, $to, $name . '="{{ __(' . PhpString::singleQuoted($key) . ', [' . $pairs . ']) }}"'), $key, 'html-attribute', array_keys($replace))];
    }

    /**
     * 사람이 읽는 글자가 있고(분류기 통과), 키가 큰따옴표 속성 안 echo에 그대로 들어가도 안전한지.
     *
     * @param list<string> $keys
     */
    private function sayable(string $plain, array $keys): bool
    {
        if ($this->classifier->skipReason($plain) !== null) {
            return false;
        }
        foreach ($keys as $key) {
            if (!BladeSafety::isSafeInsideEcho($key) || str_contains($key, '"')) {
                return false;
            }
        }

        return true;
    }

    /**
     * 배열 prop(규칙 componentArrayProps)에 변수로 넘긴 목록이 고정 라벨을 옮겨 담아 만든 것이면, 옮겨 담은 자리를
     * coolify_ko_t(…)로 감싼다(정의 자리 번역). 변수가 정의와 이 prop 말고 다른 곳에 쓰이면 로직에 쓰일 수 있으므로 하지 않는다.
     *
     * @param list<string> $keys
     * @param list<array{int, int}> $taken
     * @param array<string, array{int, int}> $display
     * @return list<SentenceOutcome>
     */
    private function copiedRows(string $variable, array $keys, LiteralLabelFlow $flow, array $taken, array &$display, string $source): array
    {
        $sites = $flow->copySites($variable, $keys);
        if ($sites === [] || preg_match_all('/\$' . preg_quote($variable, '/') . '(?!\w)/', $source) !== 2) {
            return [];
        }
        $outcomes = [];
        foreach ($sites as [$start, $end, $code, $values]) {
            if (!self::overlaps($start, $end, $taken)) {
                $outcomes[] = SentenceOutcome::converted(new Edit($start, $end, 'coolify_ko_t(' . $code . ')'), '', 'prop-display', []);
                self::remember($display, $values);
            }
        }

        return $outcomes;
    }

    /** @php 코드가 조각 원문 안에서 시작하는 원본 위치. 찾지 못하면 null. */
    private static function codeStart(Segment $segment, string $code): ?int
    {
        $at = $code === '' ? false : strpos($segment->source, $code);

        return $at === false ? null : $segment->start + $at;
    }

    /**
     * 컴포넌트에 묶어 넘기는 값(:prop="…")을 prop이 글자로 출력될 때만 번역한다.
     * 고정 문구 변수면 coolify_ko_t(값)으로 감싸고(prop-display), 아니면 결과 자리 문자열만 바꾼다(prop-literal).
     * 이어 붙인 라벨의 치환값이 고정 문구면 그 값도 coolify_ko_t로 감싼다(반쪽 번역 방지).
     *
     * @param list<array{int, int}> $taken
     * @param array<string, array{int, int}> $display
     * @return list<SentenceOutcome>
     */
    private function boundProps(Segment $segment, ComponentNode $node, LiteralLabelFlow $flow, array $taken, array &$display, string $source): array
    {
        if (($node->isClosingTag && !$node->isSelfClosing) || str_starts_with($node->name, 'slot')) {
            return [];
        }
        $outcomes = [];
        foreach ($node->parameters as $parameter) {
            if ($parameter->type !== ParameterType::DynamicVariable) {
                continue;
            }
            $pattern = '/(?<=\s)' . preg_quote($parameter->name, '/') . '\s*=\s*"([^"]*)"/';
            if (preg_match($pattern, $segment->source, $m, PREG_OFFSET_CAPTURE) !== 1 || $m[1][0] !== $parameter->value) {
                continue;
            }
            $valueStart = $segment->start + $m[1][1];
            $valueEnd = $valueStart + strlen($parameter->value);
            $prop = Str::camel($parameter->materializedName);
            $arrayKeys = $this->rules->componentArrayProps[$node->name][$prop] ?? null;
            if (self::overlaps($valueStart, $valueEnd, $taken)) {
                continue;
            }
            if ($arrayKeys !== null) {
                $expr = $this->expressions->parse($parameter->value);
                if ($expr instanceof Expr\Variable && is_string($expr->name)) {
                    array_push($outcomes, ...$this->copiedRows($expr->name, $arrayKeys, $flow, $taken, $display, $source));
                    continue;
                }
                foreach ($expr === null ? [] : self::arrayDisplayValues($expr, $arrayKeys) as $value) {
                    $labels = [];
                    array_push($outcomes, ...$this->leaves->withConcatenations($value, $parameter->value, $valueStart, 'prop-literal', $flow, $labels));
                    foreach ($labels as $labelValues) {
                        self::remember($display, $labelValues);
                    }
                }
                continue;
            }
            if ($this->props->resolve($node->name, $prop) !== PropSink::Text) {
                continue;
            }
            $expr = $this->expressions->parse($parameter->value);
            $values = $flow->labelValues($expr);
            if ($values !== null) {
                foreach ($values as [$value]) {
                    if ($this->props->isLogicValue($node->name, $prop, $value)) {
                        continue 2;
                    }
                }
                $outcomes[] = SentenceOutcome::converted(new Edit($valueStart, $valueEnd, 'coolify_ko_t(' . $parameter->value . ')'), '', 'prop-display', []);
                self::remember($display, $values);
            } elseif ($expr !== null) {
                $labels = [];
                foreach ($this->leaves->withConcatenations($expr, $parameter->value, $valueStart, 'prop-literal', $flow, $labels) as $leaf) {
                    if (!$this->props->isLogicValue($node->name, $prop, $leaf->key)) {
                        $outcomes[] = $leaf;
                    }
                }
                foreach ($labels as $labelValues) {
                    self::remember($display, $labelValues);
                }
            }
        }

        return $outcomes;
    }

    /**
     * 규칙 displayVariables의 변수를 @js(변수)로 내보내는 곳을 @js(coolify_ko_t(변수))로 바꾸고, 그 영어 값을 카탈로그에 넣는다.
     * 변수는 앞에서 영어 값으로 비교된 뒤 여기서 화면(JS 데이터)으로 나간다. 태그 속성 안(x-data)의 @js도 본다.
     *
     * @param array<string, list<string>> $variables
     * @param list<array{int, int}> $taken
     * @return list<SentenceOutcome>
     */
    private function displayVariables(Segment $segment, array $variables, array $taken): array
    {
        $nodes = $segment->node !== null ? [[$segment->start, $segment->end, $segment->node]] : $segment->inner;
        $outcomes = [];
        foreach ($nodes as [$start, , $node]) {
            if (!$node instanceof DirectiveNode || strtolower($node->content) !== 'js' || $node->arguments === null) {
                continue;
            }
            $code = trim($node->arguments->innerContent);
            $text = (string) $node;
            $open = strpos($text, '(');
            $at = $open === false ? false : strpos($text, $code, $open);
            if (preg_match('/^\$(\w+)$/', $code, $m) !== 1 || !isset($variables[$m[1]]) || $at === false) {
                continue;
            }
            $codeStart = $start + $at;
            if (self::overlaps($codeStart, $codeStart + strlen($code), $taken)) {
                continue;
            }
            $outcomes[] = SentenceOutcome::converted(new Edit($codeStart, $codeStart + strlen($code), 'coolify_ko_t(' . $code . ')'), '', 'prop-display', []);
            foreach ($variables[$m[1]] as $value) {
                if ($this->classifier->skipReason($value) === null) {
                    $outcomes[] = SentenceOutcome::extracted($value, $codeStart, 'display');
                }
            }
        }

        return $outcomes;
    }

    /**
     * @param array<string, array{int, int}> $display
     * @param list<array{string, int, int}> $values
     */
    private static function remember(array &$display, array $values): void
    {
        foreach ($values as [$value, $offset, $order]) {
            if (!isset($display[$value]) || $display[$value][1] > $order) {
                $display[$value] = [$offset, $order];
            }
        }
    }

    /** @param list<array{int, int}> $ranges */
    private static function overlaps(int $start, int $end, array $ranges): bool
    {
        foreach ($ranges as [$from, $to]) {
            if ($start < $to && $end > $from) {
                return true;
            }
        }

        return false;
    }

    /** @return list<SentenceOutcome> */
    private function propDefaults(Segment $segment, string $arguments, string $component): array
    {
        $argumentsStart = strpos($segment->source, $arguments);
        $array = $this->parseArray($arguments);
        if ($argumentsStart === false || $array === null) {
            return [];
        }
        $outcomes = [];
        foreach ($array->items as $item) {
            if (!$item->key instanceof Scalar\String_ || !$item->value instanceof Scalar\String_) {
                continue;
            }
            $prop = $item->key->value;
            $value = $item->value->value;
            if ($this->props->isLogicValue($component, $prop, $value)) {
                continue;
            }
            $start = $segment->start + $argumentsStart + $item->value->getStartFilePos() - strlen('<?php ');
            $end = $segment->start + $argumentsStart + $item->value->getEndFilePos() + 1 - strlen('<?php ');
            $excerpt = $prop . ' => ' . substr($segment->source, $start - $segment->start, $end - $start);
            $plain = html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if ($this->classifier->skipReason($plain) !== null) {
                continue;
            }
            $sink = $this->props->resolve($component, $prop);
            if ($sink === null) {
                continue;
            }
            if ($sink instanceof SkipReason) {
                $outcomes[] = SentenceOutcome::skipped($sink, $start, $excerpt);
                continue;
            }
            if ($sink === PropSink::Text) {
                $outcomes[] = SentenceOutcome::converted(new Edit($start, $end, '__(' . PhpString::singleQuoted($value) . ')'), $value, 'prop-default', []);
                continue;
            }
            $parsed = HtmlValueKey::parse($value);
            if ($parsed === null) {
                $outcomes[] = SentenceOutcome::skipped(SkipReason::UnsafeForBlade, $start, $excerpt);
                continue;
            }
            $tags = $parsed->hasTags() ? ', [' . implode(', ', $parsed->tagCodes) . ']' : '';
            $outcomes[] = SentenceOutcome::converted(new Edit($start, $end, '(string) __h(' . PhpString::singleQuoted($parsed->key) . $tags . ')'), $parsed->key, 'prop-default-html', []);
        }

        return $outcomes;
    }

    private function parseArray(string $arguments): ?Expr\Array_
    {
        try {
            $statements = $this->parser->parse('<?php ' . $arguments . ';') ?? [];
        } catch (Error) {
            return null;
        }
        $first = $statements[0] ?? null;

        return $first instanceof Stmt\Expression && $first->expr instanceof Expr\Array_ ? $first->expr : null;
    }

    private static function componentName(string $path): ?string
    {
        return preg_match('#(?:^|/)views/components/(.+)\.blade\.php$#', $path, $m) === 1 ? str_replace('/', '.', $m[1]) : null;
    }

    /** @param list<array{int, int}> $ranges */
    private static function inside(Segment $segment, array $ranges): bool
    {
        foreach ($ranges as [$start, $end]) {
            if ($segment->start < $end && $segment->end > $start) {
                return true;
            }
        }

        return false;
    }
}
