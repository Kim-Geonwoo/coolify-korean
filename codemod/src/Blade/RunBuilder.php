<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Php\PhpString;
use CoolifyKo\Codemod\Php\SafeExpression;
use CoolifyKo\Codemod\Text\SkipReason;
use Stillat\BladeParser\Nodes\EchoNode;
use Stillat\BladeParser\Nodes\EchoType;

/**
 * 조각 목록을 문장 후보(Run)로 묶는다. 블록 태그·지시어·컴포넌트·보호 구역에서 끊고,
 * 문장 안에 끼면 결과가 달라지는 것(원시 echo, 복잡한 식, 동적 인라인 태그)은 문장을 오염(poison)시킨다.
 */
final class RunBuilder
{
    private const INLINE_PAIRED = [
        'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'del', 'dfn', 'em', 'i', 'ins', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
    ];

    private const INLINE_VOID = ['br', 'wbr'];

    private const INLINE_OPAQUE = ['code', 'kbd', 'samp'];

    private const TITLE_SEPARATOR = '/\s*(?:\||&gt;|>)\s*/';

    /** `name="`·`x-on:click='` 같은 속성 대입 */
    private const ATTRIBUTE_LIKE = '/(?:^|[\s(])[A-Za-z_:@][\w:.@-]*=["\']/';

    /** @var list<RunItem> */
    private array $items = [];

    /** @var list<int> */
    private array $echoStarts = [];

    private ?SkipReason $poison = null;

    /** @var list<Run> */
    private array $runs = [];

    public function __construct(private readonly SafeExpression $expressions)
    {
    }

    /**
     * @param list<Segment> $segments
     * @return list<Run>
     */
    public function build(array $segments, string $source): array
    {
        $this->items = [];
        $this->poison = null;
        $this->runs = [];
        $count = count($segments);
        for ($i = 0; $i < $count; $i++) {
            $segment = $segments[$i];
            $i = match ($segment->kind) {
                SegmentKind::Text => $this->text($segment, $i),
                SegmentKind::Tag => $this->tag($segments, $i, $source),
                SegmentKind::Blade => $this->blade($segment, $source, $i),
                SegmentKind::Comment => $this->breakRun($i),
            };
        }
        $this->flush();

        return $this->runs;
    }

    private function text(Segment $segment, int $index): int
    {
        if ($segment->context->protected) {
            return $this->breakRun($index);
        }
        if (preg_match(self::ATTRIBUTE_LIKE, $segment->source) === 1) {
            // 파서가 태그를 놓쳐 속성을 글자로 읽었을 수 있다. 감싸면 속성이 깨지므로 문장째 건너뛴다.
            $this->poison ??= SkipReason::AttributeLike;
        }
        if ($segment->context->slot !== 'title') {
            $this->items[] = new RunItem(RunItemKind::Text, $segment->start, $segment->end, $segment->source);

            return $index;
        }
        $offset = 0;
        $parts = preg_split(self::TITLE_SEPARATOR, $segment->source, -1, PREG_SPLIT_OFFSET_CAPTURE | PREG_SPLIT_DELIM_CAPTURE) ?: [];
        foreach ($parts as $k => [$piece, $position]) {
            if ($k > 0) {
                $this->flush();
            }
            if ($piece !== '') {
                $start = $segment->start + $position;
                $this->items[] = new RunItem(RunItemKind::Text, $start, $start + strlen($piece), $piece);
            }
            $offset = $position + strlen($piece);
        }
        unset($offset);

        return $index;
    }

    /** @param list<Segment> $segments */
    private function tag(array $segments, int $index, string $source): int
    {
        $segment = $segments[$index];
        $tag = $segment->tag;
        if ($tag === null) {
            return $this->breakRun($index);
        }
        $opaque = in_array($tag->name, self::INLINE_OPAQUE, true)
            || (in_array($tag->name, self::INLINE_PAIRED, true) && HtmlStream::isProtectedElement($tag));
        if ($opaque && !$tag->closing && !$tag->isVoid()) {
            return $this->opaque($segments, $index, $source);
        }
        if (in_array($tag->name, self::INLINE_PAIRED, true)) {
            $kind = $tag->closing ? RunItemKind::Close : ($tag->isVoid() ? RunItemKind::Void : RunItemKind::Open);
            if ($kind === RunItemKind::Open && $tag->name === 'span' && $this->followsClosedSpan()) {
                $this->flush();
            }
            $this->items[] = new RunItem($kind, $segment->start, $segment->end, $segment->source, $tag, null, self::markupCode($segment->source, $tag->isStatic));

            return $index;
        }
        if (in_array($tag->name, self::INLINE_VOID, true)) {
            $this->items[] = new RunItem(RunItemKind::Void, $segment->start, $segment->end, $segment->source, $tag, null, self::markupCode($segment->source, $tag->isStatic));

            return $index;
        }

        return $this->breakRun($index);
    }

    /** 공백만 사이에 둔 형제 span(배지와 값 등)은 따로 떨어진 화면 조각으로 본다. */
    private function followsClosedSpan(): bool
    {
        for ($k = count($this->items) - 1; $k >= 0; $k--) {
            $item = $this->items[$k];
            if ($item->kind === RunItemKind::Text && preg_match('/\S/', $item->source) !== 1) {
                continue;
            }

            return $item->kind === RunItemKind::Close && $item->tag?->name === 'span';
        }

        return false;
    }

    /** 태그 HTML을 만드는 PHP 식. 옮길 수 없으면 빈 문자열(문장 안에 남으면 그 문장은 건너뛴다). */
    private static function markupCode(string $raw, bool $isStatic): string
    {
        if ($isStatic) {
            return BladeSafety::isSafeInsideEcho($raw) ? PhpString::singleQuoted($raw) : '';
        }

        return DynamicTagCompiler::compile($raw) ?? '';
    }

    /**
     * code·kbd처럼 내용째 보존할 인라인 요소를 하나의 덩어리로 넣는다.
     *
     * @param list<Segment> $segments
     */
    private function opaque(array $segments, int $index, string $source): int
    {
        $open = $segments[$index];
        $name = $open->tag?->name ?? '';
        $depth = 0;
        $static = $open->tag?->isStatic ?? false;
        $count = count($segments);
        for ($j = $index; $j < $count; $j++) {
            $s = $segments[$j];
            if ($s->kind === SegmentKind::Blade) {
                $static = false;
            }
            if ($s->kind === SegmentKind::Tag && $s->tag !== null && $s->tag->name === $name) {
                if (!$s->tag->closing && !$s->tag->isVoid()) {
                    $depth++;
                } elseif ($s->tag->closing) {
                    $depth--;
                    if ($depth === 0) {
                        $raw = substr($source, $open->start, $s->end - $open->start);
                        $this->items[] = new RunItem(RunItemKind::Opaque, $open->start, $s->end, $raw, null, null, self::markupCode($raw, $static));

                        return $j;
                    }
                }
            }
        }

        return $this->breakRun($index);
    }

    private function blade(Segment $segment, string $source, int $index): int
    {
        $node = $segment->node;
        if (!$node instanceof EchoNode) {
            return $this->breakRun($index);
        }
        if ($segment->start > 0 && $source[$segment->start - 1] === '@') {
            $this->poison ??= SkipReason::UnsafeForBlade;

            return $index;
        }
        if ($node->type !== EchoType::Echo) {
            $this->poison ??= SkipReason::RawEcho;

            return $index;
        }
        $code = trim($node->innerContent);
        $expr = $this->expressions->parse($code);
        if ($expr !== null && $this->expressions->isTranslationCall($expr)) {
            return $this->breakRun($index);
        }
        $this->echoStarts[] = $segment->start;
        // 복수형 삼항({{ $n === 1 ? '' : 's' }})은 문장째 trans_choice로 바꿀 수 있을 때만 쓴다(SentenceBuilder가 판단)
        if ($expr === null || (!$this->expressions->isSafePlaceholderValue($expr) && PluralPhrase::form($expr, $code) === null)) {
            $this->poison ??= SkipReason::ComplexExpression;

            return $index;
        }
        $this->items[] = new RunItem(RunItemKind::Echo, $segment->start, $segment->end, $segment->source, null, $expr, $code);

        return $index;
    }

    private function breakRun(int $index): int
    {
        $this->flush();

        return $index;
    }

    private function flush(): void
    {
        if ($this->items !== [] || $this->echoStarts !== []) {
            $this->runs[] = new Run($this->items, $this->poison, $this->echoStarts);
        }
        $this->items = [];
        $this->echoStarts = [];
        $this->poison = null;
    }
}
