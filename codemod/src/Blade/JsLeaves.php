<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

/**
 * Alpine 식처럼 짧은 JS 식에서 화면에 나가는 값 자리의 문자열 리터럴을 찾는다.
 * 결과 자리: 식 전체, 최상위 삼항의 두 가지(조건은 제외), 마지막 `||`·`??`의 오른쪽. 감싼 괄호는 벗겨서 본다.
 * `+` 이어 붙이기(문장 조각), 쉼표 식, 그 밖의 식은 결과 자리라도 건너뛴다.
 * 템플릿 리터럴이나 모르는 이스케이프가 있으면 식 전체를 읽지 않는다(null).
 * sentences()는 결과 자리의 문장 조각(글자와 값 하나를 + 로 이은 식, 템플릿 리터럴)을 따로 찾는다.
 */
final class JsLeaves
{
    private const ESCAPES = ['\\' => '\\', "'" => "'", '"' => '"', 'n' => "\n", 'r' => "\r", 't' => "\t", '/' => '/'];

    /** 문장에 끼울 수 있는 값: 이름과 속성 접근(a.b?.c)만. 호출·연산이 낀 값은 문자열로 바뀌는 방식이 달라질 수 있어 받지 않는다. */
    private const SIMPLE_VALUE = '/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/';

    /** @return list<array{int, int, string}>|null [시작, 끝(배타), 값] */
    public static function find(string $expression): ?array
    {
        $tokens = self::tokenize($expression, false);
        if ($tokens === null) {
            return null;
        }
        $leaves = [];
        foreach (self::ranges($tokens, 0, count($tokens)) as [$from, $to]) {
            if ($to - $from === 1 && $tokens[$from]['type'] === 'string') {
                $leaves[] = [$tokens[$from]['start'], $tokens[$from]['end'], $tokens[$from]['value']];
            }
        }

        return $leaves;
    }

    /**
     * 결과 자리의 문장 조각. 값은 하나만, SIMPLE_VALUE 꼴만 받는다.
     * - 'concat': 'Deploy ' + x.name — 문자열 리터럴과 값 하나를 + 로만 이은 식(값이 하나라 언제나 문자열 이어 붙이기다)
     * - 'template': `Open ${item.name}` — 글자 조각에 \가 없고 ${…}가 값 하나인 템플릿 리터럴
     * - 'plural': `${n} ${n === 1 ? 'tag' : 'tags'}` — ${…}가 개수 값과 그 개수의 `=== 1`·`!== 1` 삼항(문자열 가지)뿐인 템플릿 리터럴
     * parts는 ['text', 글자] · ['value', 값 식] · ['form', 1일 때, 아닐 때]의 목록이다.
     *
     * @return list<array{start: int, end: int, kind: string, value: string, parts: list<array{0: string, 1: string, 2?: string}>}>|null
     */
    public static function sentences(string $expression): ?array
    {
        $tokens = self::tokenize($expression, true);
        if ($tokens === null) {
            return null;
        }
        $found = [];
        foreach (self::ranges($tokens, 0, count($tokens)) as [$from, $to]) {
            $sentence = $to - $from === 1 && $tokens[$from]['type'] === 'template'
                ? self::template($tokens[$from])
                : self::concatenation($expression, $tokens, $from, $to);
            if ($sentence !== null) {
                $found[] = ['start' => $tokens[$from]['start'], 'end' => $tokens[$to - 1]['end'], ...$sentence];
            }
        }

        return $found;
    }

    /**
     * @param list<array{type: string, start: int, end: int, value: string}> $tokens
     * @return array{kind: string, value: string, parts: list<array{0: string, 1: string}>}|null
     */
    private static function concatenation(string $expression, array $tokens, int $from, int $to): ?array
    {
        $operands = [[]];
        for ($k = $from; $k < $to; $k++) {
            if ($tokens[$k]['type'] === 'plus') {
                $operands[] = [];
            } else {
                $operands[count($operands) - 1][] = $tokens[$k];
            }
        }
        if (count($operands) < 2) {
            return null;
        }
        $parts = [];
        $value = null;
        foreach ($operands as $operand) {
            if ($operand === []) {
                return null;
            }
            if (count($operand) === 1 && $operand[0]['type'] === 'string') {
                $parts[] = ['text', $operand[0]['value']];
                continue;
            }
            $start = $operand[0]['start'];
            $code = substr($expression, $start, $operand[count($operand) - 1]['end'] - $start);
            if ($value !== null || preg_match(self::SIMPLE_VALUE, $code) !== 1) {
                return null;
            }
            $value = $code;
            $parts[] = ['value', $code];
        }

        return $value === null ? null : ['kind' => 'concat', 'value' => $value, 'parts' => $parts];
    }

    /**
     * @param array{type: string, start: int, end: int, value: string} $token
     * @return array{kind: string, value: string, parts: list<array{0: string, 1: string, 2?: string}>}|null
     */
    private static function template(array $token): ?array
    {
        $body = substr($token['value'], 1, -1);
        if (str_contains($body, '\\') || preg_match_all('/\$\{([^{}`]*)\}/', $body, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE) === false) {
            return null;
        }
        $parts = [];
        $cursor = 0;
        $value = null;
        $plural = false;
        foreach ($m as $match) {
            [$whole, $at] = $match[0];
            $inner = trim($match[1][0]);
            if ($at > $cursor) {
                $parts[] = ['text', substr($body, $cursor, $at - $cursor)];
            }
            $cursor = $at + strlen($whole);
            $form = preg_match('/^(\S+?)\s*(===|!==)\s*1\s*\?\s*(\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*")\s*:\s*(\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*")$/', $inner, $f) === 1;
            $code = $form ? $f[1] : $inner;
            if (preg_match(self::SIMPLE_VALUE, $code) !== 1 || ($value !== null && $value !== $code)) {
                return null;
            }
            $value = $code;
            if (!$form) {
                $parts[] = ['value', $code];
                continue;
            }
            [$yes, $no] = [self::decode($f[3]), self::decode($f[4])];
            if ($yes === null || $no === null) {
                return null;
            }
            $plural = true;
            $parts[] = $f[2] === '===' ? ['form', $yes, $no] : ['form', $no, $yes];
        }
        if ($cursor < strlen($body)) {
            $parts[] = ['text', substr($body, $cursor)];
        }
        if ($value === null || str_contains(implode('', array_column($parts, 1)), '${')) {
            return null;
        }

        return ['kind' => $plural ? 'plural' : 'template', 'value' => $value, 'parts' => $parts];
    }

    /** JS 문자열 리터럴 하나를 값으로 푼다. 리터럴 하나가 아니거나 모르는 이스케이프면 null. */
    public static function decode(string $literal): ?string
    {
        $scanned = self::literalAt($literal, 0);

        return $scanned !== null && $scanned[0] === strlen($literal) ? $scanned[1] : null;
    }

    /**
     * $offset의 따옴표에서 시작하는 문자열 리터럴을 읽는다.
     *
     * @return array{int, string}|null [끝(배타), 값]
     */
    public static function literalAt(string $source, int $offset): ?array
    {
        $quote = $source[$offset] ?? '';
        if ($quote !== "'" && $quote !== '"') {
            return null;
        }
        $value = '';
        $length = strlen($source);
        for ($i = $offset + 1; $i < $length; $i++) {
            $c = $source[$i];
            if ($c === $quote) {
                return [$i + 1, $value];
            }
            if ($c === "\n" || $c === "\r") {
                return null;
            }
            if ($c !== '\\') {
                $value .= $c;
                continue;
            }
            $next = $source[$i + 1] ?? '';
            if (isset(self::ESCAPES[$next])) {
                $value .= self::ESCAPES[$next];
                $i++;
                continue;
            }
            if ($next === 'u' && preg_match('/\G[0-9A-Fa-f]{4}/', $source, $hex, 0, $i + 2) === 1) {
                $value .= mb_chr((int) hexdec($hex[0]), 'UTF-8');
                $i += 5;
                continue;
            }

            return null;
        }

        return null;
    }

    /**
     * @param bool $templates 템플릿 리터럴을 'template' 토큰 하나로 읽을지(아니면 식 전체를 읽지 않는다)
     * @return list<array{type: string, start: int, end: int, value: string}>|null
     */
    private static function tokenize(string $source, bool $templates): ?array
    {
        $tokens = [];
        $length = strlen($source);
        for ($i = 0; $i < $length;) {
            $c = $source[$i];
            if (ctype_space($c)) {
                $i++;
                continue;
            }
            if ($c === '`') {
                $end = $templates ? self::templateEnd($source, $i) : null;
                if ($end === null) {
                    return null;
                }
                $tokens[] = ['type' => 'template', 'start' => $i, 'end' => $end, 'value' => substr($source, $i, $end - $i)];
                $i = $end;
                continue;
            }
            if ($c === "'" || $c === '"') {
                $scanned = self::literalAt($source, $i);
                if ($scanned === null) {
                    return null;
                }
                $tokens[] = ['type' => 'string', 'start' => $i, 'end' => $scanned[0], 'value' => $scanned[1]];
                $i = $scanned[0];
                continue;
            }
            $two = substr($source, $i, 2);
            $type = match (true) {
                $two === '?.' && !ctype_digit($source[$i + 2] ?? '') => 'other',
                $two === '??' || $two === '||' => 'fallback',
                $two === '&&' => 'other',
                default => null,
            };
            if ($type !== null) {
                $tokens[] = ['type' => $type, 'start' => $i, 'end' => $i + 2, 'value' => $two];
                $i += 2;
                continue;
            }
            $type = match ($c) {
                '?' => 'question',
                ':' => 'colon',
                '(', '[', '{' => 'open',
                ')', ']', '}' => 'close',
                '+' => 'plus',
                ',' => 'comma',
                default => 'other',
            };
            $tokens[] = ['type' => $type, 'start' => $i, 'end' => $i + 1, 'value' => $c];
            $i++;
        }

        return $tokens;
    }

    /** $start의 백틱에서 시작한 템플릿 리터럴의 끝(배타). ${…} 안의 중괄호·따옴표도 짝을 맞춘다. 닫히지 않으면 null. */
    private static function templateEnd(string $source, int $start): ?int
    {
        $length = strlen($source);
        $depth = 0;
        $quote = null;
        for ($i = $start + 1; $i < $length; $i++) {
            $c = $source[$i];
            if ($c === '\\') {
                $i++;
                continue;
            }
            if ($quote !== null) {
                $quote = $c === $quote ? null : $quote;
                continue;
            }
            if ($depth === 0 && $c === '`') {
                return $i + 1;
            }
            if ($depth === 0 && $c === '$' && ($source[$i + 1] ?? '') === '{') {
                $depth = 1;
                $i++;
            } elseif ($depth > 0 && ($c === "'" || $c === '"' || $c === '`')) {
                $quote = $c;
            } elseif ($depth > 0 && $c === '{') {
                $depth++;
            } elseif ($depth > 0 && $c === '}') {
                $depth--;
            }
        }

        return null;
    }

    /**
     * 결과 자리의 토큰 구간들: 감싼 괄호를 벗기고, 최상위 삼항이면 두 가지, 마지막 `||`·`??`면 오른쪽, 쉼표 식이면 없음.
     *
     * @param list<array{type: string, start: int, end: int, value: string}> $tokens
     * @return list<array{int, int}> [시작, 끝(배타)] 토큰 번호
     */
    private static function ranges(array $tokens, int $from, int $to): array
    {
        while ($to - $from >= 2 && $tokens[$from]['type'] === 'open' && $tokens[$from]['value'] === '(' && self::closingOf($tokens, $from) === $to - 1) {
            $from++;
            $to--;
        }
        if ($to <= $from) {
            return [];
        }
        $question = null;
        $lastFallback = null;
        $depth = 0;
        for ($k = $from; $k < $to; $k++) {
            $type = $tokens[$k]['type'];
            if ($type === 'open') {
                $depth++;
            } elseif ($type === 'close') {
                $depth--;
            } elseif ($depth === 0) {
                if ($type === 'comma') {
                    return [];
                }
                if ($type === 'question' && $question === null) {
                    $question = $k;
                } elseif ($type === 'fallback' && $question === null) {
                    $lastFallback = $k;
                }
            }
        }
        if ($question !== null) {
            $colon = self::matchingColon($tokens, $question, $to);

            return $colon === null ? [] : [...self::ranges($tokens, $question + 1, $colon), ...self::ranges($tokens, $colon + 1, $to)];
        }
        if ($lastFallback !== null) {
            return self::ranges($tokens, $lastFallback + 1, $to);
        }

        return [[$from, $to]];
    }

    /** @param list<array{type: string, start: int, end: int, value: string}> $tokens */
    private static function closingOf(array $tokens, int $open): ?int
    {
        $depth = 0;
        foreach (array_slice($tokens, $open, null, true) as $k => $token) {
            if ($token['type'] === 'open') {
                $depth++;
            } elseif ($token['type'] === 'close' && --$depth === 0) {
                return $k;
            }
        }

        return null;
    }

    /** @param list<array{type: string, start: int, end: int, value: string}> $tokens */
    private static function matchingColon(array $tokens, int $question, int $to): ?int
    {
        $depth = 0;
        $nested = 0;
        for ($k = $question + 1; $k < $to; $k++) {
            $type = $tokens[$k]['type'];
            if ($type === 'open') {
                $depth++;
            } elseif ($type === 'close') {
                $depth--;
            } elseif ($depth === 0 && $type === 'question') {
                $nested++;
            } elseif ($depth === 0 && $type === 'colon') {
                if ($nested === 0) {
                    return $k;
                }
                $nested--;
            }
        }

        return null;
    }
}
