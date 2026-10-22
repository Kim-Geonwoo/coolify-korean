<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use Stillat\BladeParser\Nodes\AbstractNode;
use Stillat\BladeParser\Nodes\Components\ComponentNode;
use Stillat\BladeParser\Nodes\EchoNode;

/** @internal */
final class HtmlStreamBuilder
{
    private const DATA = 0;
    private const TAG = 1;
    private const COMMENT = 2;
    private const RAW = 3;
    private const COMPONENT_TAIL = 4;

    private int $state = self::DATA;

    private int $pendingStart = 0;

    private ?string $quote = null;

    private bool $tagDynamic = false;

    /** @var list<array{int, int, AbstractNode}> 지금 읽는 태그 안의 Blade 노드 */
    private array $tagNodes = [];

    private string $rawElement = '';

    private int $tailDepth = 0;

    private bool $tailPushedComponent = false;

    /** @var list<array{name: string, protected: bool}> */
    private array $elements = [];

    /** @var list<array{name: string, slot: string|null}> */
    private array $components = [];

    /** @var list<Segment> */
    private array $segments = [];

    public function __construct(private readonly string $source)
    {
    }

    public function literal(int $start, int $end): void
    {
        for ($i = $start; $i < $end; $i++) {
            $c = $this->source[$i];
            switch ($this->state) {
                case self::DATA:
                    $this->dataChar($i, $c);
                    break;
                case self::TAG:
                    $this->tagChar($i, $c);
                    break;
                case self::COMMENT:
                    if ($c === '>' && $i >= 2 && substr($this->source, $i - 2, 2) === '--') {
                        $this->emit(SegmentKind::Comment, $this->pendingStart, $i + 1);
                        $this->state = self::DATA;
                        $this->pendingStart = $i + 1;
                    }
                    break;
                case self::RAW:
                    if ($c === '<' && strcasecmp(substr($this->source, $i, 2 + strlen($this->rawElement)), '</' . $this->rawElement) === 0) {
                        $this->emit(SegmentKind::Text, $this->pendingStart, $i);
                        $this->beginTag($i);
                    }
                    break;
                case self::COMPONENT_TAIL:
                    $this->componentTailChar($i, $c);
                    break;
            }
        }
    }

    public function blade(AbstractNode $node, int $start, int $end): void
    {
        if ($this->state === self::TAG) {
            $this->tagDynamic = true;
            $this->tagNodes[] = [$start, $end, $node];

            return;
        }
        if ($this->state === self::COMMENT || $this->state === self::COMPONENT_TAIL) {
            return;
        }
        $open = $this->echoedTagNameStart($node, $start);
        if ($open !== null) {
            // `<{{ $a ? 'a' : 'div' }} …>`: 태그 이름을 echo로 쓴 동적 태그. 뒤따르는 속성을 글자로 읽지 않게 태그로 묶는다.
            $this->emit(SegmentKind::Text, $this->pendingStart, $open);
            $this->beginTag($open);
            $this->tagDynamic = true;
            $this->tagNodes[] = [$start, $end, $node];

            return;
        }
        $this->emit(SegmentKind::Text, $this->pendingStart, $start);
        $tracksComponent = $node instanceof ComponentNode && $this->state === self::DATA;
        $closesComponent = $tracksComponent && $node->isClosingTag && !$node->isSelfClosing;
        if ($closesComponent) {
            $this->trackComponent($node);
        }
        $this->emit(SegmentKind::Blade, $start, $end, null, $node);
        $this->pendingStart = $end;
        $before = count($this->components);
        if ($tracksComponent && !$closesComponent) {
            $this->trackComponent($node);
        }
        if ($node instanceof ComponentNode && !$closesComponent) {
            $balance = self::bracketBalance(substr($this->source, $start, $end - $start));
            if ($balance > 0) {
                // 파서가 속성 안의 `=>`를 태그 끝으로 읽고 잘랐다. 괄호 짝이 맞는 `>`까지를 태그 꼬리로 묶는다.
                $this->state = self::COMPONENT_TAIL;
                $this->tailDepth = $balance;
                $this->quote = null;
                $this->tailPushedComponent = count($this->components) > $before;
            }
        }
    }

    /** echo 바로 앞이 `<`나 `</`(대기 중인 글자 안)이면 그 `<`의 위치. */
    private function echoedTagNameStart(AbstractNode $node, int $start): ?int
    {
        if ($this->state !== self::DATA || !$node instanceof EchoNode) {
            return null;
        }
        if ($start - 1 >= $this->pendingStart && $this->source[$start - 1] === '<') {
            return $start - 1;
        }
        if ($start - 2 >= $this->pendingStart && substr($this->source, $start - 2, 2) === '</') {
            return $start - 2;
        }

        return null;
    }

    private function componentTailChar(int $i, string $c): void
    {
        if ($this->quote !== null) {
            if ($c === $this->quote) {
                $this->quote = null;
            }

            return;
        }
        if ($c === '"' || $c === "'") {
            $this->quote = $c;
        } elseif ($c === '(' || $c === '[' || $c === '{') {
            $this->tailDepth++;
        } elseif ($c === ')' || $c === ']' || $c === '}') {
            $this->tailDepth--;
        } elseif ($c === '>' && $this->tailDepth <= 0) {
            $raw = substr($this->source, $this->pendingStart, $i + 1 - $this->pendingStart);
            $this->emit(SegmentKind::Tag, $this->pendingStart, $i + 1, Tag::parse($raw, false));
            if ($this->tailPushedComponent && str_ends_with(rtrim(substr($raw, 0, -1)), '/')) {
                array_pop($this->components);
            }
            $this->state = self::DATA;
            $this->pendingStart = $i + 1;
        }
    }

    /** 따옴표 밖의 여는 괄호 수 - 닫는 괄호 수. */
    private static function bracketBalance(string $text): int
    {
        $balance = 0;
        $quote = null;
        for ($k = 0, $n = strlen($text); $k < $n; $k++) {
            $c = $text[$k];
            if ($quote !== null) {
                if ($c === $quote) {
                    $quote = null;
                }
                continue;
            }
            if ($c === '"' || $c === "'") {
                $quote = $c;
            } elseif ($c === '(' || $c === '[' || $c === '{') {
                $balance++;
            } elseif ($c === ')' || $c === ']' || $c === '}') {
                $balance--;
            }
        }

        return $balance;
    }

    /** @return list<Segment> */
    public function finish(): array
    {
        $end = strlen($this->source);
        if ($this->state === self::DATA || $this->state === self::RAW) {
            $this->emit(SegmentKind::Text, $this->pendingStart, $end);
        } else {
            $this->emitProtectedRemainder($this->pendingStart, $end);
        }

        return $this->segments;
    }

    private function dataChar(int $i, string $c): void
    {
        if ($c !== '<') {
            return;
        }
        if (substr($this->source, $i, 4) === '<!--') {
            $this->emit(SegmentKind::Text, $this->pendingStart, $i);
            $this->state = self::COMMENT;
            $this->pendingStart = $i;

            return;
        }
        $next = $this->source[$i + 1] ?? '';
        $afterSlash = $this->source[$i + 2] ?? '';
        if (ctype_alpha($next) || $next === '!' || ($next === '/' && ctype_alpha($afterSlash))) {
            $this->emit(SegmentKind::Text, $this->pendingStart, $i);
            $this->beginTag($i);
        }
    }

    private function beginTag(int $i): void
    {
        $this->state = self::TAG;
        $this->pendingStart = $i;
        $this->quote = null;
        $this->tagDynamic = false;
        $this->tagNodes = [];
    }

    private function tagChar(int $i, string $c): void
    {
        if ($this->quote !== null) {
            if ($c === $this->quote) {
                $this->quote = null;
            }

            return;
        }
        if ($c === '"' || $c === "'") {
            $this->quote = $c;

            return;
        }
        if ($c !== '>') {
            return;
        }
        $raw = substr($this->source, $this->pendingStart, $i + 1 - $this->pendingStart);
        $spans = array_map(fn (array $n): array => [$n[0] - $this->pendingStart, $n[1] - $this->pendingStart], $this->tagNodes);
        $tag = Tag::parse($raw, !$this->tagDynamic, $spans);
        $this->closeTagContext($tag);
        $this->emit(SegmentKind::Tag, $this->pendingStart, $i + 1, $tag, null, $this->tagNodes);
        $this->openTagContext($tag);
        $this->pendingStart = $i + 1;
        if ($tag->opensElement() && HtmlStream::isRawTextElement($tag->name)) {
            $this->state = self::RAW;
            $this->rawElement = $tag->name;
        } else {
            $this->state = self::DATA;
        }
    }

    private function closeTagContext(Tag $tag): void
    {
        if (!$tag->closing) {
            return;
        }
        for ($k = count($this->elements) - 1; $k >= 0; $k--) {
            if ($this->elements[$k]['name'] === $tag->name) {
                $this->elements = array_slice($this->elements, 0, $k);

                return;
            }
        }
    }

    private function openTagContext(Tag $tag): void
    {
        if ($tag->opensElement()) {
            $this->elements[] = ['name' => $tag->name, 'protected' => HtmlStream::isProtectedElement($tag)];
        }
    }

    private function trackComponent(ComponentNode $node): void
    {
        if ($node->isSelfClosing) {
            return;
        }
        if ($node->isClosingTag) {
            array_pop($this->components);

            return;
        }
        $slot = null;
        if (str_starts_with($node->name, 'slot:')) {
            $slot = substr($node->name, 5);
        } elseif ($node->name === 'slot') {
            foreach ($node->parameters as $parameter) {
                if ($parameter->name === 'name') {
                    $slot = $parameter->value;
                }
            }
        }
        $this->components[] = ['name' => $node->name, 'slot' => $slot];
    }

    private function context(): Context
    {
        $protected = $this->state === self::RAW;
        foreach ($this->elements as $element) {
            $protected = $protected || $element['protected'];
        }
        $top = $this->components === [] ? null : $this->components[array_key_last($this->components)];

        return new Context(
            $protected,
            $top['slot'] ?? null,
            array_map(static fn (array $e): string => $e['name'], $this->elements),
            $top['name'] ?? null,
        );
    }

    /** @param list<array{int, int, AbstractNode}> $inner */
    private function emit(SegmentKind $kind, int $start, int $end, ?Tag $tag = null, ?AbstractNode $node = null, array $inner = []): void
    {
        if ($end <= $start) {
            return;
        }
        $this->segments[] = new Segment($kind, $start, $end, substr($this->source, $start, $end - $start), $this->context(), $tag, $node, $inner);
    }

    private function emitProtectedRemainder(int $start, int $end): void
    {
        if ($end <= $start) {
            return;
        }
        $context = $this->context();
        $this->segments[] = new Segment(
            SegmentKind::Text,
            $start,
            $end,
            substr($this->source, $start, $end - $start),
            new Context(true, $context->slot, $context->elements, $context->component),
        );
    }
}
