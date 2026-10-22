<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Php\PhpString;

/**
 * HTML로 출력되는 속성 값(예: helper)을 번호 태그 키와 태그 목록으로 나눈다.
 * 텍스트는 엔티티를 풀고(__h가 다시 이스케이프한다), 태그는 원문 그대로 보존한다.
 * verbatim이면 엔티티·공백을 원문 그대로 둔다(알림 본문처럼 원문 문자열이 그대로 쓰이는 곳).
 * code·kbd·pre는 내용째 하나의 덩어리로 둔다.
 */
final readonly class HtmlValueKey
{
    private const VOID = ['br', 'wbr', 'hr', 'img', 'input'];

    private const OPAQUE = ['code', 'kbd', 'samp', 'pre'];

    /** @param list<string> $tagCodes 태그별 PHP 식(짝 태그는 '[열기, 닫기]' 형태) */
    private function __construct(
        public string $key,
        public array $tagCodes,
        public string $plain,
    ) {
    }

    public static function parse(string $value, bool $verbatim = false): ?self
    {
        if (preg_match_all('/<\/?([A-Za-z][\w-]*)\b[^<>]*>|[^<]+|</', $value, $tokens, PREG_SET_ORDER) === false) {
            return null;
        }
        $key = '';
        $plain = '';
        /** @var list<array{0: string, 1: string}|string> $tags */
        $tags = [];
        $stack = [];
        $opaque = null;
        $opaqueRaw = '';
        foreach ($tokens as $token) {
            $raw = $token[0];
            $name = strtolower($token[1] ?? '');
            $isTag = $name !== '' && str_starts_with($raw, '<');
            if ($opaque !== null) {
                $opaqueRaw .= $raw;
                if ($isTag && $name === $opaque && str_starts_with($raw, '</')) {
                    $key .= '<' . count($tags) . '/>';
                    $tags[] = $opaqueRaw;
                    $plain .= ' ';
                    $opaque = null;
                }
                continue;
            }
            if (!$isTag) {
                if ($raw === '<') {
                    return null;
                }
                $decoded = html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8');
                if (str_contains($decoded, '<')) {
                    return null;
                }
                $key .= $verbatim ? $raw : $decoded;
                $plain .= $decoded;
                continue;
            }
            if (in_array($name, self::OPAQUE, true) && !str_starts_with($raw, '</')) {
                $opaque = $name;
                $opaqueRaw = $raw;
                continue;
            }
            if (str_starts_with($raw, '</')) {
                $top = array_pop($stack);
                if ($top === null || $top[0] !== $name) {
                    return null;
                }
                $tags[$top[1]] = [$tags[$top[1]][0], $raw];
                $key .= '</' . $top[1] . '>';
                continue;
            }
            if (in_array($name, self::VOID, true) || str_ends_with($raw, '/>')) {
                $key .= '<' . count($tags) . '/>';
                $tags[] = $raw;
                $plain .= ' ';
                continue;
            }
            $n = count($tags);
            $tags[] = [$raw, ''];
            $stack[] = [$name, $n];
            $key .= '<' . $n . '>';
        }
        if ($stack !== [] || $opaque !== null) {
            return null;
        }
        $codes = array_map(
            static fn (array|string $tag): string => is_array($tag)
                ? '[' . PhpString::singleQuoted($tag[0]) . ', ' . PhpString::singleQuoted($tag[1]) . ']'
                : PhpString::singleQuoted($tag),
            $tags,
        );

        return new self($verbatim ? $key : trim((string) preg_replace('/[ \t\r\n\f\v]+/', ' ', $key)), array_values($codes), $plain);
    }

    public function hasTags(): bool
    {
        return $this->tagCodes !== [];
    }
}
