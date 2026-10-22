<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

final readonly class Tag
{
    private const VOID_ELEMENTS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'];

    /** 속성 하나: 이름, 값(없으면 null), 따옴표 문자(없으면 null). 같은 이름 속성이 여러 번 나와도 각각 잡는다. */
    private const ATTRIBUTE_PATTERN = '/([^\s"\'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?/';

    /** Blade 구간을 가리는 글자. 속성 이름·값·따옴표로 읽히지 않는다. */
    private const MASK = "\x01";

    /**
     * @param array<string, string|null> $attributes 정적 태그에서만 채운다. 값 없는 속성은 null.
     * @param list<array{int, int}> $bladeSpans 태그 원문 안에 낀 Blade 노드 구간(원문 기준 [시작, 끝))
     */
    public function __construct(
        public string $name,
        public bool $closing,
        public bool $selfClosing,
        public bool $isStatic,
        public array $attributes,
        public string $raw,
        public array $bladeSpans = [],
    ) {
    }

    /** @param list<array{int, int}> $bladeSpans */
    public static function parse(string $raw, bool $isStatic, array $bladeSpans = []): self
    {
        if (str_starts_with($raw, '<!')) {
            return new self('!doctype', false, false, $isStatic, [], $raw, $bladeSpans);
        }
        if (preg_match('/^<(\/)?([A-Za-z][\w:.-]*)/', $raw, $m) !== 1) {
            return new self('?', false, false, false, [], $raw, $bladeSpans);
        }
        $closing = $m[1] === '/';
        $name = strtolower($m[2]);
        $selfClosing = preg_match('/\/\s*>$/', $raw) === 1;
        $attributes = $isStatic && !$closing ? self::parseAttributes(substr($raw, strlen($m[0]), -1)) : [];

        return new self($name, $closing, $selfClosing, $isStatic, $attributes, $raw, $bladeSpans);
    }

    public function isVoid(): bool
    {
        return $this->selfClosing || in_array($this->name, self::VOID_ELEMENTS, true);
    }

    public function opensElement(): bool
    {
        return !$this->closing && !$this->isVoid() && $this->name !== '!doctype' && $this->name !== '?';
    }

    /**
     * 여는 태그의 속성을 원문 순서대로 위치와 함께 돌려준다. Blade 구간은 가린 채로 읽어서, 구간 안의 따옴표·글자가
     * 속성으로 읽히지 않게 한다. Blade 구간과 겹치는 속성(값에 echo가 낀 것, Blade가 찍는 속성)은 overlapsBlade로 가린다.
     * @if … @else … @endif 안의 같은 이름 속성은 가지마다 하나씩 나온다.
     *
     * @return list<array{name: string, value: string|null, quote: string|null, start: int, end: int}> 위치는 원문 기준 [시작, 끝)
     */
    public function attributeList(): array
    {
        if ($this->closing || $this->name === '?' || $this->name === '!doctype' || preg_match('/^<[A-Za-z][\w:.-]*/', $this->raw, $m) !== 1) {
            return [];
        }
        $masked = $this->raw;
        foreach ($this->bladeSpans as [$start, $end]) {
            $masked = substr_replace($masked, str_repeat(self::MASK, $end - $start), $start, $end - $start);
        }
        $bodyStart = strlen($m[0]);
        $body = substr($masked, $bodyStart, -1);
        preg_match_all(self::ATTRIBUTE_PATTERN, $body, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE | PREG_UNMATCHED_AS_NULL);
        $list = [];
        foreach ($matches as $match) {
            [$name, $at] = $match[0];
            $quote = match (true) {
                isset($match[2][0]) => '"',
                isset($match[3][0]) => "'",
                default => null,
            };
            $list[] = [
                'name' => (string) $match[1][0],
                'value' => $match[2][0] ?? $match[3][0] ?? $match[4][0] ?? null,
                'quote' => $quote,
                'start' => $bodyStart + (int) $at,
                'end' => $bodyStart + (int) $at + strlen((string) $name),
            ];
        }

        return $list;
    }

    /** [시작, 끝)이 태그 안의 Blade 구간과 겹치는지(원문 기준). */
    public function overlapsBlade(int $start, int $end): bool
    {
        foreach ($this->bladeSpans as [$from, $to]) {
            if ($start < $to && $end > $from) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string, string|null> */
    private static function parseAttributes(string $body): array
    {
        $body = (string) preg_replace('/\/\s*$/', '', $body);
        preg_match_all(self::ATTRIBUTE_PATTERN, $body, $matches, PREG_SET_ORDER | PREG_UNMATCHED_AS_NULL);
        $attributes = [];
        foreach ($matches as $match) {
            $value = $match[2] ?? $match[3] ?? $match[4] ?? null;
            $attributes[(string) $match[1]] = $value;
        }

        return $attributes;
    }
}
