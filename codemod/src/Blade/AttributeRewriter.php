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
use Stillat\BladeParser\Document\Document;
use Stillat\BladeParser\Nodes\Components\ComponentNode;
use Stillat\BladeParser\Nodes\Components\ParameterType;
use Stillat\BladeParser\Nodes\EchoNode;
use Stillat\BladeParser\Nodes\EchoType;
use Stillat\BladeParser\Nodes\LiteralNode;

/**
 * 속성 값을 번역 호출로 바꾼다.
 * - 컴포넌트: label="Name" → :label="__('Name')", HTML로 출력되는 속성은 :helper="(string) __h(...)"
 * - 일반 HTML 요소: title="Copy" → title="{{ __('Copy') }}"
 * Blade가 정적 속성 값을 엔티티 그대로 넘기므로, 이스케이프 출력 속성의 키는 원문 그대로 둔다.
 * 글자로 출력되는 값은 공백도 원문 그대로 둔다(속성·pre-wrap에서는 공백이 보인다).
 * kebab-case 속성(host-label)은 Laravel처럼 camelCase prop(hostLabel)으로 찾고, 속성 이름은 원문대로 쓴다.
 * HTML로 출력되는 속성이 업스트림 JSON 키를 원시 출력하면({!! __('repository.url') !!}) 번역문이 HTML로 들어가므로,
 * 그 영어 문구로 번호 태그 키를 만들어 __h로 바꾼다.
 * 값이 echo 하나뿐이면(title="{{ $on ? 'Stop' : 'Start' }}", label="{{ … }}") 속성은 두고 echo 식의 결과 자리 문자열만 바꾼다.
 */
final class AttributeRewriter
{
    private readonly LeafRewriter $leaves;

    /** @param array<string, string> $upstreamLines 업스트림 lang/en.json(키 → 영어) */
    public function __construct(
        private readonly RuleSet $rules,
        private readonly ComponentProps $props,
        private readonly TextClassifier $classifier,
        private readonly SafeExpression $expressions,
        private readonly array $upstreamLines = [],
    ) {
        $this->leaves = new LeafRewriter($classifier, $expressions);
    }

    /** @return list<SentenceOutcome> */
    public function component(Segment $segment): array
    {
        $node = $segment->node;
        if (!$node instanceof ComponentNode || ($node->isClosingTag && !$node->isSelfClosing) || str_starts_with($node->name, 'slot')) {
            return [];
        }
        $outcomes = [];
        foreach ($node->parameters as $parameter) {
            if ($parameter->type !== ParameterType::Parameter && $parameter->type !== ParameterType::InterpolatedValue) {
                continue;
            }
            $sink = $this->props->resolve($node->name, Str::camel($parameter->name));
            if ($sink === null) {
                continue;
            }
            $located = self::locate($segment->source, $parameter->name);
            if ($located === null) {
                continue;
            }
            [$offset, $length, $value, $quote] = $located;
            $start = $segment->start + $offset;
            $prop = Str::camel($parameter->name);
            if ($parameter->type === ParameterType::Parameter && $this->props->isLogicValue($node->name, $prop, $value)) {
                continue;
            }
            if ($sink instanceof SkipReason) {
                if (preg_match('/\p{L}/u', $value) === 1) {
                    $outcomes[] = SentenceOutcome::skipped($sink, $start, $parameter->name . '="' . $value . '"');
                }
                continue;
            }
            if ($parameter->type === ParameterType::InterpolatedValue) {
                $valueStart = $start + (int) strpos(substr($segment->source, $offset, $length), $quote) + 1;
                $leaves = array_values(array_filter(
                    $this->singleEchoLeaves($value, $valueStart),
                    fn (SentenceOutcome $leaf): bool => !$this->props->isLogicValue($node->name, $prop, $leaf->key),
                ));
                if ($leaves !== []) {
                    array_push($outcomes, ...$leaves);
                    continue;
                }
            }
            $english = $sink === PropSink::Html ? $this->upstreamRawEcho($value) : null;
            $built = match (true) {
                $english !== null => $this->staticCode($english, $sink),
                $parameter->type === ParameterType::Parameter => $this->staticCode($value, $sink),
                default => $this->interpolatedCode($value, $sink),
            };
            if ($built instanceof SkipReason) {
                $outcomes[] = SentenceOutcome::skipped($built, $start, $parameter->name . '="' . $value . '"');
                continue;
            }
            if ($built === null) {
                continue;
            }
            [$code, $key, $placeholders] = $built;
            if (str_contains($code, '"') || !BladeSafety::isSafeInsideEcho($code)) {
                $outcomes[] = SentenceOutcome::skipped(SkipReason::UnsafeForBlade, $start, $parameter->name . '="' . $value . '"');
                continue;
            }
            $outcomes[] = SentenceOutcome::converted(new Edit($start, $start + $length, ':' . $parameter->name . '="' . $code . '"'), $key, $sink === PropSink::Html ? 'prop-html' : 'prop-text', $placeholders);
        }

        return $outcomes;
    }

    /**
     * 일반 HTML 태그의 속성. Blade(echo·지시어)가 낀 태그도 Blade 구간과 겹치지 않는 정적 속성은 바꾼다
     * (<a title="Projects" {{ wireNavigate() }}>, @if … title="A" @else title="B" @endif 의 두 가지).
     *
     * @return list<SentenceOutcome>
     */
    public function html(Segment $segment): array
    {
        $tag = $segment->tag;
        if ($tag === null || $tag->closing || $segment->context->protected
            || str_contains($tag->name, ':') || str_starts_with($tag->name, 'x-') || $tag->name === '!doctype') {
            return [];
        }
        $outcomes = [];
        foreach ($tag->attributeList() as $attribute) {
            if ($attribute['value'] === null || $attribute['quote'] === null) {
                continue;
            }
            if ($tag->overlapsBlade($attribute['start'], $attribute['end'])) {
                if (in_array($attribute['name'], $this->rules->htmlAttributes, true)) {
                    $text = substr($segment->source, $attribute['start'], $attribute['end'] - $attribute['start']);
                    $open = (int) strpos($text, $attribute['quote']) + 1;
                    array_push($outcomes, ...$this->singleEchoLeaves(substr($text, $open, -1), $segment->start + $attribute['start'] + $open));
                }
                continue;
            }
            if (in_array($attribute['name'], $this->rules->htmlAttributes, true)) {
                array_push($outcomes, ...$this->htmlAttribute($segment, $attribute['name'], $attribute['value'], $attribute['quote'], $attribute['start'], $attribute['end']));
            } elseif (in_array($attribute['name'], $this->rules->alpineAttributes, true) && $attribute['quote'] === '"') {
                array_push($outcomes, ...$this->alpineLeaves($segment, $attribute['value'], $attribute['start'], $attribute['end']));
            }
        }

        return $outcomes;
    }

    /**
     * title="Copy" → title="{{ __('Copy') }}". $from·$to는 태그 원문 기준 속성 구간이다.
     *
     * @return list<SentenceOutcome>
     */
    private function htmlAttribute(Segment $segment, string $attribute, string $raw, string $quote, int $from, int $to): array
    {
        $decoded = html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $reason = $this->classifier->skipReason($decoded);
        $start = $segment->start + $from;
        if ($reason !== null) {
            return $reason !== SkipReason::Empty && $reason !== SkipReason::NoLetters ? [SentenceOutcome::skipped($reason, $start, $attribute . '="' . $raw . '"')] : [];
        }
        $key = $decoded;
        if (!BladeSafety::isSafeInsideEcho($key)) {
            return [SentenceOutcome::skipped(SkipReason::UnsafeForBlade, $start, $attribute . '="' . $raw . '"')];
        }
        $replacement = $attribute . '=' . $quote . '{{ __(' . PhpString::singleQuoted($key) . ') }}' . $quote;

        return [SentenceOutcome::converted(new Edit($start, $segment->start + $to, $replacement), $key, 'html-attribute', [])];
    }

    /**
     * Alpine 표시 식(x-text, :title …)의 결과 자리 JS 문자열을 번역된 JS 문자열로 바꾼다.
     * Js::from은 작은따옴표 JS 문자열을 내고 큰따옴표는 "로 이스케이프하므로 큰따옴표 속성에서만 한다.
     *
     * @return list<SentenceOutcome>
     */
    private function alpineLeaves(Segment $segment, string $raw, int $from, int $to): array
    {
        $valueStart = $segment->start + $from + (int) strpos(substr($segment->source, $from, $to - $from), '"') + 1;
        $outcomes = [];
        foreach (JsLeaves::find($raw) ?? [] as [$start, $end, $value]) {
            if ($this->classifier->skipReason($value) !== null || !BladeSafety::isSafeInsideEcho($value) || str_contains($value, '"')) {
                continue;
            }
            $outcomes[] = SentenceOutcome::converted(new Edit($valueStart + $start, $valueStart + $end, self::jsString($value)), $value, 'alpine-literal', []);
        }
        // 엔티티가 낀 식은 브라우저가 풀어서 실행하므로 글자를 원문 그대로 키로 쓸 수 없다
        foreach (str_contains($raw, '&') ? [] : JsLeaves::sentences($raw) ?? [] as $sentence) {
            array_push($outcomes, ...$this->alpineSentence($sentence, $valueStart));
        }

        return $outcomes;
    }

    /**
     * Alpine 식의 문장 조각('Deploy ' + x.name, `Open ${item.name}`)을 번역된 JS 문자열에서 자리표시자를 값으로 바꾸는 식으로 만든다:
     * {{ Js::from(__('Deploy :name')) }}.split(':name').join('' + (x.name)). 값은 원문과 같은 방식으로 문자열이 된다
     * (+ 는 '' + (값), 템플릿은 `${값}`). split/join이라 번역문이나 값에 든 $&·:name이 다시 바뀌지 않는다.
     * 개수 템플릿(`${n} ${n === 1 ? 'tag' : 'tags'}`)은 원문의 `n === 1`로 trans_choice의 두 형태 중 하나를 고르고 :count를 값으로 바꾼다.
     *
     * @param array{start: int, end: int, kind: string, value: string, parts: list<array{0: string, 1: string, 2?: string}>} $sentence
     * @return list<SentenceOutcome>
     */
    private function alpineSentence(array $sentence, int $valueStart): array
    {
        $value = $sentence['value'];
        $plural = $sentence['kind'] === 'plural';
        $allocator = new PlaceholderAllocator();
        foreach ($sentence['parts'] as $part) {
            if ($part[0] === 'text') {
                $allocator->reserveFrom($part[1]);
            }
        }
        if ($plural) {
            $allocator->reserveFrom(':count');
        }
        $segments = preg_split('/[^A-Za-z0-9]+/', $value) ?: [];
        $name = $plural ? 'count' : $allocator->nameForBase($value, (string) preg_replace('/(?<=[a-z0-9])([A-Z])/', '_$1', (string) end($segments)));
        [$one, $other, $plain] = ['', '', ''];
        foreach ($sentence['parts'] as $part) {
            [$a, $b] = match ($part[0]) {
                'text' => [$part[1], $part[1]],
                'value' => [':' . $name, ':' . $name],
                default => [$part[1], $part[2] ?? ''],
            };
            $one .= $a;
            $other .= $b;
            $plain .= $part[0] === 'value' ? ' ' : $a . ' ';
        }
        $key = $plural ? $one . '|' . $other : $one;
        // 글자가 낱말 하나 없이 한 글자뿐이면(modKeyLabel + 'K') 문장이 아니다
        $invalid = $this->classifier->skipReason($plain) !== null || preg_match('/\p{L}{2,}/u', $plain) !== 1
            || !BladeSafety::isSafeInsideEcho($key) || str_contains($key, '"') || str_contains($key, '`')
            || ($plural && ($one === $other || str_contains($one . $other, '|') || preg_match('/^[\[{]/', $one . "\n" . $other) === 1 || preg_match('/\n[\[{]/', $one . "\n" . $other) === 1));
        if ($invalid) {
            return [];
        }
        $join = $sentence['kind'] === 'concat' ? "'' + (" . $value . ')' : '`${' . $value . '}`';
        $edit = static fn (string $code): Edit => new Edit($valueStart + $sentence['start'], $valueStart + $sentence['end'], $code);
        if (!$plural) {
            $code = '{{ \Illuminate\Support\Js::from(__(' . PhpString::singleQuoted($key) . ')) }}.split(' . "':" . $name . "').join(" . $join . ')';

            return [SentenceOutcome::converted($edit($code), $key, 'alpine-sentence', [$name])];
        }
        $form = static fn (int $n): string => '{{ \Illuminate\Support\Js::from(trans_choice(' . PhpString::singleQuoted($key) . ', ' . $n . ", ['count' => ':count'])) }}";
        $code = '(' . $value . ' === 1 ? ' . $form(1) . ' : ' . $form(2) . ").split(':count').join(" . $join . ')';

        return [
            SentenceOutcome::converted($edit($code), $key, 'alpine-sentence', ['count'], [$value]),
            SentenceOutcome::extracted($key, $valueStart + $sentence['start'], 'plural', ['count']),
        ];
    }

    /**
     * 속성 값이 공백을 빼면 이스케이프 echo 하나뿐일 때, 그 식의 결과 자리 문자열을 __()로 바꾼다(echo-literal).
     * 글자나 다른 Blade가 섞인 값은 문장째 다뤄야 하므로 여기서 바꾸지 않는다.
     *
     * @param int $valueStart 값이 원본에서 시작하는 위치
     * @return list<SentenceOutcome>
     */
    private function singleEchoLeaves(string $value, int $valueStart): array
    {
        $echo = null;
        $echoStart = 0;
        $offset = 0;
        foreach (Document::fromText($value)->getNodes()->all() as $node) {
            $text = (string) $node;
            if ($node instanceof EchoNode && $node->type === EchoType::Echo && $echo === null) {
                [$echo, $echoStart] = [$node, $offset];
            } elseif (!$node instanceof LiteralNode || trim($text) !== '') {
                return [];
            }
            $offset += strlen($text);
        }
        if ($echo === null || $offset !== strlen($value)) {
            return [];
        }
        $code = trim($echo->innerContent);
        $at = strpos((string) $echo, $code, 2);
        $expr = $this->expressions->parse($code);
        if ($expr === null || $at === false || $code === '') {
            return [];
        }

        return $this->leaves->literals($expr, $valueStart + $echoStart + $at, 'echo-literal');
    }

    /** 번역문을 JS 문자열 리터럴로 내는 Blade 코드. */
    public static function jsString(string $value): string
    {
        return '{{ \Illuminate\Support\Js::from(__(' . PhpString::singleQuoted($value) . ')) }}';
    }

    /** @return array{string, string, list<string>}|SkipReason|null 코드, 키, 자리표시자 */
    private function staticCode(string $value, PropSink $sink): array|SkipReason|null
    {
        if ($sink === PropSink::Text) {
            $reason = $this->classifier->skipReason(html_entity_decode($value, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            if ($reason !== null) {
                return self::reportable($reason);
            }
            if (!BladeSafety::isSafeInsideEcho($value)) {
                return SkipReason::UnsafeForBlade;
            }

            return ['__(' . PhpString::singleQuoted($value) . ')', $value, []];
        }
        $parsed = HtmlValueKey::parse($value);
        if ($parsed === null) {
            return SkipReason::UnsafeForBlade;
        }
        $reason = $this->classifier->skipReason($parsed->plain);
        if ($reason !== null) {
            return self::reportable($reason);
        }
        if (!BladeSafety::isSafeInsideEcho($parsed->key)) {
            return SkipReason::UnsafeForBlade;
        }
        $tags = $parsed->hasTags() ? ', [' . implode(', ', $parsed->tagCodes) . ']' : '';

        return ['(string) __h(' . PhpString::singleQuoted($parsed->key) . $tags . ')', $parsed->key, []];
    }

    /** @return array{string, string, list<string>}|SkipReason|null */
    private function interpolatedCode(string $value, PropSink $sink): array|SkipReason|null
    {
        $allocator = new PlaceholderAllocator();
        $nodes = Document::fromText($value)->getNodes()->all();
        $plain = '';
        foreach ($nodes as $node) {
            if ($node instanceof LiteralNode) {
                $text = (string) $node;
                if ($sink === PropSink::Html && str_contains($text, '<')) {
                    return SkipReason::DynamicValue;
                }
                $allocator->reserveFrom($text);
                $plain .= $text;
            }
        }
        $key = '';
        $replace = [];
        foreach ($nodes as $node) {
            if ($node instanceof LiteralNode) {
                $text = (string) $node;
                $key .= $sink === PropSink::Html ? html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8') : $text;
                continue;
            }
            if (!$node instanceof EchoNode || $node->type !== EchoType::Echo) {
                return SkipReason::DynamicValue;
            }
            $code = trim($node->innerContent);
            $expr = $this->expressions->parse($code);
            if ($expr === null || !$this->expressions->isSafePlaceholderValue($expr)) {
                return SkipReason::ComplexExpression;
            }
            $name = $allocator->nameFor($code, $expr);
            $key .= ':' . $name;
            $replace[$name] = $sink === PropSink::Text ? 'e(' . $code . ')' : $code;
        }
        $reason = $this->classifier->skipReason(html_entity_decode($plain, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        if ($reason !== null) {
            return self::reportable($reason);
        }
        if ($sink === PropSink::Html) {
            $key = trim((string) preg_replace('/[ \t\r\n\f\v]+/', ' ', $key));
        }
        if (!BladeSafety::isSafeInsideEcho($key)) {
            return SkipReason::UnsafeForBlade;
        }
        $pairs = implode(', ', array_map(
            static fn (string $name, string $code): string => PhpString::singleQuoted($name) . ' => ' . $code,
            array_keys($replace),
            array_values($replace),
        ));
        $code = $sink === PropSink::Text
            ? '__(' . PhpString::singleQuoted($key) . ', [' . $pairs . '])'
            : '(string) __h(' . PhpString::singleQuoted($key) . ', [], [' . $pairs . '])';

        return [$code, $key, array_keys($replace)];
    }

    /** 값이 업스트림 JSON 키 하나의 원시 출력({!! __('key') !!})뿐이면 그 키의 영어 문구 */
    private function upstreamRawEcho(string $value): ?string
    {
        if (preg_match('/^\s*\{!!\s*__\(\s*\'([^\'\\\\]+)\'\s*\)\s*!!\}\s*$/', $value, $m) !== 1) {
            return null;
        }

        return $this->upstreamLines[$m[1]] ?? null;
    }

    private static function reportable(SkipReason $reason): ?SkipReason
    {
        return $reason === SkipReason::Empty || $reason === SkipReason::NoLetters ? null : $reason;
    }

    /**
     * 태그 원문에서 name="value" 구간을 찾는다(앞에 공백이 있어야 하며 :name은 제외).
     *
     * @return array{int, int, string, string}|null 오프셋, 길이, 값 원문, 따옴표
     */
    private static function locate(string $tagSource, string $name): ?array
    {
        $pattern = '/(?<=\s)' . preg_quote($name, '/') . '\s*=\s*(?:"([^"]*)"|\'([^\']*)\')/';
        if (preg_match($pattern, $tagSource, $m, PREG_OFFSET_CAPTURE | PREG_UNMATCHED_AS_NULL) !== 1) {
            return null;
        }
        $double = $m[1][0] !== null;

        return [(int) $m[0][1], strlen((string) $m[0][0]), (string) ($double ? $m[1][0] : $m[2][0]), $double ? '"' : "'"];
    }
}
