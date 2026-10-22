<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Edit\Edit;
use CoolifyKo\Codemod\Php\PhpString;
use CoolifyKo\Codemod\Text\PlaceholderAllocator;
use CoolifyKo\Codemod\Text\SkipReason;
use CoolifyKo\Codemod\Text\TextClassifier;
use PhpParser\Node\Expr;

/**
 * 문장 후보(Run) 하나를 번역 호출로 바꾼다.
 * - 태그가 없으면 {{ __('키', [치환]) }}
 * - 인라인 태그가 끼면 번호 태그 키로 {{ __h('키', [태그], [치환]) }}
 * 앞뒤 공백과 문장 전체를 감싼 태그는 바깥에 남긴다.
 */
final class SentenceBuilder
{
    private const ASCII_SPACE = " \t\n\r\f\v";

    /** @var list<SentenceOutcome> 방금 만든 문장과 함께 카탈로그에 넣을 키(복수형 문장의 안쪽 구절) */
    private array $related = [];

    public function __construct(private readonly TextClassifier $classifier)
    {
    }

    /**
     * 문장 하나를 만든다. 태그 짝이 맞지 않아 문장째 건너뛰게 되면, 태그 없이 이어진 글자 조각마다 따로 만든다
     * (예: 컴포넌트가 끊은 `<a>Docs</a> <span>Deploy <x-icon/>`).
     *
     * @return list<SentenceOutcome>
     */
    public function buildAll(Run $run, string $source): array
    {
        $this->related = [];
        $outcome = $this->build($run, $source);
        if ($outcome->skip !== SkipReason::UnbalancedTags) {
            return [$outcome, ...$this->related];
        }
        $pieces = [];
        $current = [];
        foreach ($run->items as $item) {
            if ($item->kind === RunItemKind::Text || $item->kind === RunItemKind::Echo) {
                $current[] = $item;
                continue;
            }
            if ($current !== []) {
                $pieces[] = $current;
                $current = [];
            }
        }
        if ($current !== []) {
            $pieces[] = $current;
        }

        $outcomes = [];
        foreach ($pieces as $piece) {
            $this->related = [];
            $outcomes[] = $this->build(new Run($piece, null), $source);
            array_push($outcomes, ...$this->related);
        }

        return $outcomes;
    }

    public function build(Run $run, string $source): SentenceOutcome
    {
        $items = $run->items;
        $bounds = $this->contentBounds($items, 0, count($items) - 1);
        if ($bounds === null) {
            return SentenceOutcome::ignored();
        }
        $hasLetters = $this->hasLetters($items, $bounds[0], $bounds[1]);
        if ($run->poison !== null) {
            return $hasLetters ? SentenceOutcome::skipped($run->poison, $items[$bounds[0]]->start, $this->excerpt($items, $bounds)) : SentenceOutcome::ignored();
        }
        $core = $this->balance($items, $bounds[0], $bounds[1]);
        if ($core === null) {
            return SentenceOutcome::skipped(SkipReason::UnbalancedTags, $items[$bounds[0]]->start, $this->excerpt($items, $bounds));
        }
        [$first, $last] = $core;
        if (!$this->hasLetters($items, $first, $last)) {
            return SentenceOutcome::ignored();
        }
        for ($k = $first; $k <= $last; $k++) {
            if ($items[$k]->isMarkup() && !$items[$k]->isConvertibleMarkup()) {
                $dynamic = $items[$k]->tag?->isStatic === false || preg_match('/\{\{|\{!!/', $items[$k]->source) === 1;

                return SentenceOutcome::skipped($dynamic ? SkipReason::DynamicTag : SkipReason::UnsafeForBlade, $items[$first]->start, $this->excerpt($items, [$first, $last]));
            }
        }

        return $this->compose($items, $first, $last, $source);
    }

    /**
     * @param list<RunItem> $items
     * @return array{int, int}|null
     */
    private function contentBounds(array $items, int $from, int $to): ?array
    {
        $first = null;
        $last = null;
        for ($k = $from; $k <= $to; $k++) {
            if ($items[$k]->isContent()) {
                $first ??= $k;
                $last = $k;
            }
        }

        return $first === null || $last === null ? null : [$first, $last];
    }

    /**
     * 사람이 읽는 글자가 있는지 본다. 파서가 모르는 지시어(@livewireScripts, @persist(...))는 글자로 치지 않는다.
     *
     * @param list<RunItem> $items
     */
    private function hasLetters(array $items, int $first, int $last, bool $plurals = true): bool
    {
        for ($k = $first; $k <= $last; $k++) {
            $form = $plurals && $items[$k]->kind === RunItemKind::Echo && $items[$k]->expr !== null ? PluralPhrase::form($items[$k]->expr, $items[$k]->code) : null;
            if ($form !== null && preg_match('/\p{L}/u', $form[1] . $form[2]) === 1) {
                return true;
            }
            if ($items[$k]->kind !== RunItemKind::Text) {
                continue;
            }
            $text = html_entity_decode($items[$k]->source, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $text = (string) preg_replace('/(?<![\w@])@@?[A-Za-z_]\w*(?:\s*\([^()]*\))?/', ' ', $text);
            if (preg_match('/\p{L}/u', $text) === 1) {
                return true;
            }
        }

        return false;
    }

    /**
     * 내용 구간 안의 태그가 짝을 이루도록 구간을 넓히고, 문장 전체를 감싼 태그는 벗긴다.
     *
     * @param list<RunItem> $items
     * @return array{int, int}|null
     */
    private function balance(array $items, int $first, int $last): ?array
    {
        $count = count($items);
        while (true) {
            [$pairs, $openLeft, $closeLeft] = $this->scan($items, $first, $last);
            if ($openLeft === [] && $closeLeft === []) {
                break;
            }
            $changed = false;
            foreach ($closeLeft as $k) {
                $match = $this->findOpenBefore($items, $first - 1, $items[$k]->tag?->name ?? '');
                if ($match === null) {
                    return null;
                }
                $first = min($first, $match);
                $changed = true;
            }
            foreach ($openLeft as $k) {
                $match = $this->findCloseAfter($items, $last + 1, $count - 1, $items[$k]->tag?->name ?? '');
                if ($match === null) {
                    return null;
                }
                $last = max($last, $match);
                $changed = true;
            }
            if (!$changed) {
                return null;
            }
        }
        while ($items[$first]->kind === RunItemKind::Open && ($pairs[$first] ?? null) === $last) {
            $inner = $this->contentBounds($items, $first + 1, $last - 1);
            if ($inner === null) {
                return null;
            }
            [$first, $last] = $inner;
            [$pairs, $openLeft, $closeLeft] = $this->scan($items, $first, $last);
            if ($openLeft !== [] || $closeLeft !== []) {
                return $this->balance($items, $first, $last);
            }
        }

        return [$first, $last];
    }

    /**
     * @param list<RunItem> $items
     * @return array{array<int, int>, list<int>, list<int>}
     */
    private function scan(array $items, int $first, int $last): array
    {
        $pairs = [];
        $stack = [];
        $closeLeft = [];
        for ($k = $first; $k <= $last; $k++) {
            $item = $items[$k];
            if ($item->kind === RunItemKind::Open) {
                $stack[] = $k;
            } elseif ($item->kind === RunItemKind::Close) {
                $top = $stack === [] ? null : $stack[array_key_last($stack)];
                if ($top !== null && $items[$top]->tag?->name === $item->tag?->name) {
                    array_pop($stack);
                    $pairs[$top] = $k;
                } else {
                    $closeLeft[] = $k;
                }
            }
        }

        return [$pairs, $stack, $closeLeft];
    }

    /** @param list<RunItem> $items */
    private function findOpenBefore(array $items, int $from, string $name): ?int
    {
        for ($k = $from; $k >= 0; $k--) {
            if ($items[$k]->kind === RunItemKind::Open && $items[$k]->tag?->name === $name) {
                return $k;
            }
        }

        return null;
    }

    /** @param list<RunItem> $items */
    private function findCloseAfter(array $items, int $from, int $to, string $name): ?int
    {
        for ($k = $from; $k <= $to; $k++) {
            if ($items[$k]->kind === RunItemKind::Close && $items[$k]->tag?->name === $name) {
                return $k;
            }
        }

        return null;
    }

    /** @param list<RunItem> $items */
    private function compose(array $items, int $first, int $last, string $source): SentenceOutcome
    {
        $start = $items[$first]->start;
        $end = $items[$last]->end;
        if ($items[$first]->kind === RunItemKind::Text) {
            $start += strlen($items[$first]->source) - strlen(ltrim($items[$first]->source, self::ASCII_SPACE));
        }
        if ($items[$last]->kind === RunItemKind::Text) {
            $end -= strlen($items[$last]->source) - strlen(rtrim($items[$last]->source, self::ASCII_SPACE));
        }

        $allocator = new PlaceholderAllocator();
        for ($k = $first; $k <= $last; $k++) {
            if ($items[$k]->kind === RunItemKind::Text) {
                $allocator->reserveFrom(html_entity_decode($items[$k]->source, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            }
        }
        $plural = $this->plural($items, $first, $last, $start, $end, $allocator);
        if ($plural !== null) {
            return $plural;
        }

        $key = '';
        $plain = '';
        $tags = [];
        $openIndex = [];
        $rich = false;
        for ($k = $first; $k <= $last; $k++) {
            $item = $items[$k];
            switch ($item->kind) {
                case RunItemKind::Text:
                    $text = $item->source;
                    if ($k === $first) {
                        $text = ltrim($text, self::ASCII_SPACE);
                    }
                    if ($k === $last) {
                        $text = rtrim($text, self::ASCII_SPACE);
                    }
                    $decoded = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
                    $key .= $decoded;
                    $plain .= $decoded;
                    break;
                case RunItemKind::Echo:
                    $key .= ':' . $allocator->nameFor($item->code, $item->expr);
                    break;
                case RunItemKind::Open:
                    $rich = true;
                    $n = count($tags);
                    $openIndex[$k] = $n;
                    $tags[$n] = [$item->code, ''];
                    $key .= '<' . $n . '>';
                    break;
                case RunItemKind::Close:
                    $n = $this->matchingOpenIndex($items, $k, $openIndex);
                    $open = $tags[$n] ?? ['', ''];
                    $tags[$n] = [is_array($open) ? $open[0] : $open, $item->code];
                    $key .= '</' . $n . '>';
                    break;
                case RunItemKind::Void:
                case RunItemKind::Opaque:
                    $rich = true;
                    $n = count($tags);
                    $tags[$n] = $item->code;
                    $key .= '<' . $n . '/>';
                    $plain .= ' ';
                    break;
            }
        }
        $key = trim((string) preg_replace('/[ \t\r\n\f\v]+/', ' ', $key), self::ASCII_SPACE);
        $excerpt = $this->excerpt($items, [$first, $last]);

        $reason = $this->classifier->skipReason($plain);
        if ($reason !== null) {
            return SentenceOutcome::skipped($reason, $start, $excerpt);
        }
        if (!BladeSafety::isSafeInsideEcho($key) || ($rich && str_contains($plain, '<'))) {
            return SentenceOutcome::skipped(SkipReason::UnsafeForBlade, $start, $excerpt);
        }

        $names = $allocator->all();
        $replace = $names === [] ? '' : ', [' . implode(', ', array_map(
            static fn (string $code, string $name): string => PhpString::singleQuoted($name) . ' => ' . $code,
            array_keys($names),
            array_values($names),
        )) . ']';
        if ($rich) {
            $tagList = '[' . implode(', ', array_map(
                static fn (array|string $tag): string => is_array($tag) ? '[' . $tag[0] . ', ' . $tag[1] . ']' : $tag,
                $tags,
            )) . ']';
            $replacement = '{{ __h(' . PhpString::singleQuoted($key) . ', ' . $tagList . $replace . ') }}';
        } else {
            $replacement = '{{ __(' . PhpString::singleQuoted($key) . $replace . ') }}';
        }

        return SentenceOutcome::converted(new Edit($start, $end, $replacement), $key, $rich ? 'rich' : 'text', array_values($names));
    }

    /**
     * 복수형 echo({{ Str::plural('x', $n) }}, {{ $n === 1 ? '' : 's' }})가 낀 문장을 {{ trans_choice(…) }}로 만든다.
     * 복수형 echo가 없으면 null(보통 문장으로 만든다). 태그가 끼었거나 trans_choice로 만들 수 없을 때, 삼항 복수형이 있으면
     * 문장째 건너뛰고(치환값으로 옮기면 영어 낱말이 남는다) Str::plural뿐이면 null(지금까지처럼 치환값으로 둔다).
     *
     * @param list<RunItem> $items
     */
    private function plural(array $items, int $first, int $last, int $start, int $end, PlaceholderAllocator $allocator): ?SentenceOutcome
    {
        $parts = [];
        $forms = 0;
        $ternary = false;
        $markup = false;
        for ($k = $first; $k <= $last; $k++) {
            $item = $items[$k];
            if ($item->kind === RunItemKind::Echo && $item->expr !== null) {
                if (PluralPhrase::form($item->expr, $item->code) !== null) {
                    $forms++;
                    $ternary = $ternary || $item->expr instanceof Expr\Ternary;
                }
                $parts[] = ['echo', $item->code, $item->expr];
                continue;
            }
            if ($item->kind !== RunItemKind::Text) {
                $markup = true;
                continue;
            }
            $text = $k === $first ? ltrim($item->source, self::ASCII_SPACE) : $item->source;
            $text = $k === $last ? rtrim($text, self::ASCII_SPACE) : $text;
            $parts[] = ['text', html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8')];
        }
        if ($forms === 0) {
            return null;
        }
        if ($ternary && count($parts) === 1) {
            // 삼항 echo 하나뿐이면 가지 문자열을 따로 번역한다(DisplaySiteRewriter의 echo-literal)
            return SentenceOutcome::ignored();
        }
        if (!$ternary && $this->hasLetters($items, $first, $last, false)) {
            // Str::plural만 낀 글자 있는 문장은 지금까지 :value 치환값 문장으로 바꿔 왔고 그 키에 초안·검수 번역이 있다.
            // 키를 바꾸면 번역이 고아가 되므로 초안에서 지운 키로 표시하기 전까지는 전처럼 둔다
            return null;
        }
        $excerpt = $this->excerpt($items, [$first, $last]);
        $fallback = $ternary ? SentenceOutcome::skipped(SkipReason::ComplexExpression, $start, $excerpt) : null;
        $built = $markup ? null : PluralPhrase::sentence($parts, $allocator);
        if ($built === null) {
            return $fallback;
        }
        $plain = (string) preg_replace('/:\w+/', ' ', explode('|', $built['key'])[1]);
        if ($this->classifier->skipReason($plain) !== null) {
            return $fallback;
        }
        foreach ([$built['key'], ...$built['inner']] as $key) {
            if (!BladeSafety::isSafeInsideEcho($key)) {
                return SentenceOutcome::skipped(SkipReason::UnsafeForBlade, $start, $excerpt);
            }
        }
        foreach ($built['inner'] as $key) {
            $this->related[] = SentenceOutcome::extracted($key, $start, 'plural', ['count']);
        }

        return SentenceOutcome::converted(new Edit($start, $end, '{{ ' . $built['code'] . ' }}'), $built['key'], 'plural', $built['placeholders'], $built['counts']);
    }

    /**
     * @param list<RunItem> $items
     * @param array<int, int> $openIndex
     */
    private function matchingOpenIndex(array $items, int $closeAt, array $openIndex): int
    {
        $depth = 0;
        for ($k = $closeAt - 1; $k >= 0; $k--) {
            $item = $items[$k];
            if ($item->kind === RunItemKind::Close && $item->tag?->name === $items[$closeAt]->tag?->name) {
                $depth++;
            } elseif ($item->kind === RunItemKind::Open && $item->tag?->name === $items[$closeAt]->tag?->name) {
                if ($depth === 0) {
                    return $openIndex[$k] ?? 0;
                }
                $depth--;
            }
        }

        return 0;
    }

    /**
     * @param list<RunItem> $items
     * @param array{int, int} $bounds
     */
    private function excerpt(array $items, array $bounds): string
    {
        $text = '';
        for ($k = $bounds[0]; $k <= $bounds[1]; $k++) {
            $text .= $items[$k]->source;
        }
        $text = trim((string) preg_replace('/\s+/', ' ', $text));

        return mb_strlen($text) > 160 ? mb_substr($text, 0, 157) . '...' : $text;
    }
}
