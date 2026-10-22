<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Php;

use CoolifyKo\Codemod\Blade\HtmlValueKey;
use CoolifyKo\Codemod\Blade\SentenceOutcome;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Catalog\Occurrence;
use CoolifyKo\Codemod\Catalog\Skip;
use CoolifyKo\Codemod\Edit\Edit;
use CoolifyKo\Codemod\Edit\EditApplier;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\PlaceholderAllocator;
use CoolifyKo\Codemod\Text\SkipReason;
use CoolifyKo\Codemod\Text\TextClassifier;
use PhpParser\Error;
use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Identifier;
use PhpParser\Node\Scalar;
use PhpParser\Node\Stmt;
use PhpParser\NodeFinder;
use PhpParser\Parser;
use PhpParser\ParserFactory;

/**
 * Livewire PHP의 사용자 문구를 번역 호출로 바꾼다.
 * - $this->dispatch('success'|'error'|'warning'|'info', 본문 | [본문] | [제목, 본문]): 브라우저(layouts/base.blade.php)는
 *   제목을 x-text로, 본문을 x-html로 그리고 복사 버튼은 본문을 글자 그대로 복사한다.
 *   그래서 제목은 __(), 본문은 coolify_ko_message()로 바꾼다. 보간·이어 붙이기는 :이름 자리표시자가 된다.
 * - messages() 배열은 값만 바꾼다(키는 검증 규칙 경로). 검증 문구도 알림 본문으로 가므로 coolify_ko_message()다.
 * 본문 키는 공백·엔티티를 원문 그대로 둔다(본문은 pre-wrap이고 영어 출력이 업스트림과 같아야 한다).
 * 본문이 업스트림 JSON 키의 번역 호출(__('warning.sslipdomain'))이면 번역문이 HTML로 들어가므로 그 영어 문구로 키를 만든다.
 * 문자열 노드의 바이트 위치만 바꾸므로 나머지 코드 서식은 그대로다.
 */
final class PhpFileTransformer
{
    private const TOAST_EVENTS = ['success', 'error', 'warning', 'info'];

    private readonly Parser $parser;

    private readonly TextClassifier $classifier;

    private readonly SafeExpression $expressions;

    /** @param array<string, string> $upstreamLines 업스트림 lang/en.json(키 → 영어) */
    public function __construct(RuleSet $rules, private readonly array $upstreamLines = [])
    {
        $this->parser = (new ParserFactory())->createForNewestSupportedVersion();
        $this->classifier = new TextClassifier($rules->brands);
        $this->expressions = new SafeExpression();
    }

    public function transform(string $source, string $path): TransformResult
    {
        try {
            $statements = $this->parser->parse($source) ?? [];
        } catch (Error $e) {
            return new TransformResult($source, [], [new Skip($path, max(0, $e->getStartLine()), SkipReason::ParseError, $e->getRawMessage())]);
        }
        $finder = new NodeFinder();
        /** @var list<array{Expr, string}> $targets */
        $targets = [];
        foreach ($finder->findInstanceOf($statements, Expr\MethodCall::class) as $call) {
            $message = $this->toastMessage($call);
            if ($message === null) {
                continue;
            }
            if (!$message instanceof Expr\Array_) {
                $targets[] = [$message, 'toast'];
                continue;
            }
            $items = self::listItems($message);
            if ($items === null || $items === [] || count($items) > 2) {
                continue;
            }
            if (count($items) === 2) {
                $targets[] = [$items[0], 'toast-title'];
            }
            $targets[] = [$items[count($items) - 1], 'toast'];
        }
        foreach ($finder->findInstanceOf($statements, Stmt\ClassMethod::class) as $method) {
            if ($method->name->toLowerString() !== 'messages') {
                continue;
            }
            foreach ($finder->findInstanceOf($method->stmts ?? [], Stmt\Return_::class) as $return) {
                if ($return->expr instanceof Expr\Array_) {
                    foreach ($return->expr->items as $item) {
                        $targets[] = [$item->value, 'validation'];
                    }
                }
            }
        }

        $edits = [];
        $occurrences = [];
        $skips = [];
        foreach ($targets as [$expr, $kind]) {
            $outcome = $this->convert($expr, $source, $kind);
            if ($outcome->edit !== null) {
                $edits[] = $outcome->edit;
                $occurrences[] = new Occurrence($outcome->key, $path, $expr->getStartLine(), $outcome->kind, $outcome->placeholders, substr($source, $outcome->edit->start, $outcome->edit->end - $outcome->edit->start), $outcome->edit->replacement);
            } elseif ($outcome->skip !== null) {
                $skips[] = new Skip($path, $expr->getStartLine(), $outcome->skip, $outcome->excerpt);
            }
        }
        usort($occurrences, static fn (Occurrence $a, Occurrence $b): int => $a->line <=> $b->line);

        return new TransformResult(EditApplier::apply($source, $edits), $occurrences, $skips);
    }

    private function toastMessage(Expr\MethodCall $call): ?Expr
    {
        if (!$call->var instanceof Expr\Variable || $call->var->name !== 'this' || !$call->name instanceof Identifier || $call->name->toLowerString() !== 'dispatch') {
            return null;
        }
        $args = $call->getArgs();
        if (count($args) < 2 || !$args[0]->value instanceof Scalar\String_ || !in_array($args[0]->value->value, self::TOAST_EVENTS, true)) {
            return null;
        }

        return $args[1]->value;
    }

    /** @return list<Expr>|null 키 없는 배열이면 값 목록, 아니면 null */
    private static function listItems(Expr\Array_ $array): ?array
    {
        $items = [];
        foreach ($array->items as $item) {
            if ($item->key !== null || $item->unpack || $item->byRef) {
                return null;
            }
            $items[] = $item->value;
        }

        return $items;
    }

    private function convert(Expr $expr, string $source, string $kind): SentenceOutcome
    {
        $isMessage = $kind !== 'toast-title';
        $english = $isMessage ? $this->upstreamLine($expr) : null;
        $parts = $english !== null ? [$english] : StringParts::flatten($expr);
        if ($parts === null) {
            return SentenceOutcome::ignored();
        }
        $start = (int) $expr->getStartFilePos();
        $end = (int) $expr->getEndFilePos() + 1;
        $excerpt = trim((string) preg_replace('/\s+/', ' ', substr($source, $start, min(160, $end - $start))));
        $allocator = new PlaceholderAllocator();
        $literal = '';
        foreach ($parts as $part) {
            if (is_string($part)) {
                $allocator->reserveFrom($part);
                $literal .= $part;
            }
        }
        $hasMarkup = $isMessage && preg_match('/<\/?[A-Za-z]/', $literal) === 1;
        $exprCount = count(array_filter($parts, static fn (string|Expr $p): bool => $p instanceof Expr));
        if ($hasMarkup && $exprCount > 0) {
            return SentenceOutcome::skipped(SkipReason::DynamicValue, $start, $excerpt);
        }

        $key = '';
        $replace = [];
        foreach ($parts as $part) {
            if (is_string($part)) {
                $key .= $part;
                continue;
            }
            if (!$this->expressions->isSafePlaceholderValue($part)) {
                return SentenceOutcome::skipped(SkipReason::ComplexExpression, $start, $excerpt);
            }
            $code = substr($source, (int) $part->getStartFilePos(), (int) $part->getEndFilePos() + 1 - (int) $part->getStartFilePos());
            $name = $allocator->nameFor($code, $part);
            $key .= ':' . $name;
            $replace[$name] = $code;
        }

        if ($hasMarkup) {
            $parsed = HtmlValueKey::parse($key, verbatim: true);
            if ($parsed === null) {
                return SentenceOutcome::skipped(SkipReason::UnsafeForBlade, $start, $excerpt);
            }
            $reason = $this->classifier->skipReason($parsed->plain);
            if ($reason !== null) {
                return self::skipOrIgnore($reason, $start, $excerpt);
            }
            $tags = $parsed->hasTags() ? ', [' . implode(', ', $parsed->tagCodes) . ']' : '';
            $replacement = 'coolify_ko_message(' . PhpString::singleQuoted($parsed->key) . $tags . ')';

            return SentenceOutcome::converted(new Edit($start, $end, $replacement), $parsed->key, $kind . '-html', []);
        }

        $reason = $this->classifier->skipReason((string) preg_replace('/:\w+/', ' ', $key));
        if ($reason !== null) {
            return self::skipOrIgnore($reason, $start, $excerpt);
        }
        $pairs = '[' . implode(', ', array_map(
            static fn (string $name, string $code): string => PhpString::singleQuoted($name) . ' => ' . $code,
            array_keys($replace),
            array_values($replace),
        )) . ']';
        $call = match (true) {
            !$isMessage => '__(' . PhpString::singleQuoted($key) . ($replace === [] ? '' : ', ' . $pairs) . ')',
            default => 'coolify_ko_message(' . PhpString::singleQuoted($key) . ($replace === [] ? '' : ', [], ' . $pairs) . ')',
        };

        return SentenceOutcome::converted(new Edit($start, $end, $call), $key, $kind, array_keys($replace));
    }

    /** 식이 업스트림 JSON 키 하나의 번역 호출(__('key'))이면 그 키의 영어 문구 */
    private function upstreamLine(Expr $expr): ?string
    {
        if (!$expr instanceof Expr\FuncCall || !$expr->name instanceof Node\Name || $expr->name->toString() !== '__') {
            return null;
        }
        $args = $expr->getArgs();
        if (count($args) !== 1 || !$args[0]->value instanceof Scalar\String_) {
            return null;
        }

        return $this->upstreamLines[$args[0]->value->value] ?? null;
    }

    private static function skipOrIgnore(SkipReason $reason, int $start, string $excerpt): SentenceOutcome
    {
        return $reason === SkipReason::Empty || $reason === SkipReason::NoLetters ? SentenceOutcome::ignored() : SentenceOutcome::skipped($reason, $start, $excerpt);
    }
}
