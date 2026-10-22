<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Php\PhpString;
use CoolifyKo\Codemod\Text\PlaceholderAllocator;
use Illuminate\Support\Str;
use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\Node\Scalar;

/**
 * 개수에 따라 낱말이 바뀌는 echo(복수형)를 알아보고, 그런 echo가 낀 문장을 trans_choice 호출로 만든다.
 * - {{ Str::plural('word', $n) }} → 1이면 'word', 아니면 Str::plural('word')(변환 때 계산)
 * - {{ $n === 1 ? '' : 's' }}·{{ $n !== 1 ? 's' : '' }}·{{ $n === 1 ? 'does' : 'do' }} → 1일 때 가지, 아닐 때 가지
 * 문장 안의 개수 echo({{ $n }})는 :count가 된다. 개수가 둘 이상이면 하나를 바깥 trans_choice로 두고, 나머지는 그 개수 echo부터
 * 마지막 복수형 echo까지의 구절을 안쪽 trans_choice로 만들어 치환값으로 넘긴다("1 domain across 1 service").
 * 영어 출력은 개수가 0 이상 정수일 때 원문과 같다(Str::plural은 |n| = 1, `=== 1`은 정수 1, trans_choice는 n == 1을 단수로 본다).
 */
final class PluralPhrase
{
    /** SafeExpression::parse가 코드 앞에 붙이는 글자 수 */
    private const PREFIX = 6;

    private const STR_CLASSES = ['Str', 'Illuminate\\Support\\Str'];

    /**
     * echo 식이 복수형이면 [개수 식 원문, 1일 때, 아닐 때], 아니면 null.
     *
     * @param string $code SafeExpression::parse에 넘긴 코드
     * @return array{string, string, string}|null
     */
    public static function form(Expr $expr, string $code): ?array
    {
        if ($expr instanceof Expr\StaticCall && $expr->class instanceof Name && in_array($expr->class->toString(), self::STR_CLASSES, true)
            && $expr->name instanceof Identifier && $expr->name->toLowerString() === 'plural' && count($expr->args) === 2) {
            [$word, $count] = $expr->args;
            if (!$word instanceof Arg || !$count instanceof Arg || !$word->value instanceof Scalar\String_ || $word->unpack || $count->unpack) {
                return null;
            }

            return [self::source($count->value, $code), $word->value->value, Str::plural($word->value->value)];
        }
        if (!$expr instanceof Expr\Ternary || $expr->if === null || !$expr->if instanceof Scalar\String_ || !$expr->else instanceof Scalar\String_) {
            return null;
        }
        $cond = $expr->cond;
        $negated = $cond instanceof Expr\BinaryOp\NotIdentical || $cond instanceof Expr\BinaryOp\NotEqual;
        if (!$negated && !$cond instanceof Expr\BinaryOp\Identical && !$cond instanceof Expr\BinaryOp\Equal) {
            return null;
        }
        $count = match (true) {
            $cond->right instanceof Scalar\Int_ && $cond->right->value === 1 => $cond->left,
            $cond->left instanceof Scalar\Int_ && $cond->left->value === 1 => $cond->right,
            default => null,
        };
        if ($count === null || $count instanceof Scalar) {
            return null;
        }
        [$one, $other] = $negated ? [$expr->else->value, $expr->if->value] : [$expr->if->value, $expr->else->value];

        return [self::source($count, $code), $one, $other];
    }

    /**
     * 글자·echo 조각으로 된 문장(태그 없음)을 trans_choice 호출로 만든다. 복수형 echo가 없거나 만들 수 없으면 null.
     * 복수형이 아닌 echo는 치환값으로 옮겨도 안전한 식이어야 한다(호출하는 쪽이 확인한다).
     *
     * @param list<array{0: string, 1: string, 2?: Expr}> $parts ['text', 글자(엔티티 푼 것)] 또는 ['echo', 코드, 식]
     * @return array{code: string, key: string, placeholders: list<string>, counts: list<string>, inner: list<string>}|null
     */
    public static function sentence(array $parts, PlaceholderAllocator $allocator): ?array
    {
        $forms = [];
        $order = [];
        foreach ($parts as $index => $part) {
            if ($part[0] === 'echo' && isset($part[2])) {
                $form = self::form($part[2], $part[1]);
                if ($form !== null) {
                    $forms[$index] = $form;
                    $order[$form[0]] = true;
                }
            } elseif ($part[0] === 'text' && (stripos($part[1], ':count') !== false || str_contains($part[1], '|'))) {
                return null;
            }
        }
        if ($forms === []) {
            return null;
        }
        $allocator->reserveFrom(':count');
        foreach (array_keys($order) as $primary) {
            $phrases = [];
            foreach (array_keys($order) as $count) {
                if ($count !== $primary) {
                    $range = self::phrase($parts, $forms, $count);
                    if ($range === null) {
                        continue 2;
                    }
                    $phrases[$range[0]] = [$range[1], $count];
                }
            }

            return self::compose($parts, $forms, (string) $primary, $phrases, $allocator);
        }

        return null;
    }

    /**
     * 개수 $count의 구절: 그 개수 echo에서 시작해 마지막 복수형 echo로 끝나고, 사이에는 글자와 그 개수의 echo만 있는 구간.
     *
     * @param list<array{0: string, 1: string, 2?: Expr}> $parts
     * @param array<int, array{string, string, string}> $forms
     * @return array{int, int}|null [시작, 끝] 조각 번호
     */
    private static function phrase(array $parts, array $forms, string $count): ?array
    {
        $plurals = array_keys(array_filter($forms, static fn (array $form): bool => $form[0] === $count));
        $first = $plurals[0];
        $last = $plurals[count($plurals) - 1];
        $start = null;
        for ($k = $first - 1; $k >= 0; $k--) {
            if ($parts[$k][0] === 'echo') {
                $start = trim($parts[$k][1]) === $count ? $k : null;
                break;
            }
        }
        if ($start === null) {
            return null;
        }
        for ($k = $start; $k <= $last; $k++) {
            $own = $parts[$k][0] === 'text' || trim($parts[$k][1]) === $count || ($forms[$k][0] ?? null) === $count;
            if (!$own) {
                return null;
            }
        }

        return [$start, $last];
    }

    /**
     * @param list<array{0: string, 1: string, 2?: Expr}> $parts
     * @param array<int, array{string, string, string}> $forms
     * @param array<int, array{int, string}> $phrases 구절 시작 → [끝, 개수 식]
     * @return array{code: string, key: string, placeholders: list<string>, counts: list<string>, inner: list<string>}|null
     */
    private static function compose(array $parts, array $forms, string $primary, array $phrases, PlaceholderAllocator $allocator): ?array
    {
        $one = '';
        $other = '';
        $replace = [];
        $inner = [];
        $counts = [$primary];
        $total = count($parts);
        for ($k = 0; $k < $total; $k++) {
            $part = $parts[$k];
            if (isset($phrases[$k])) {
                [$end, $count] = $phrases[$k];
                $built = self::compose(array_slice($parts, $k, $end - $k + 1), self::shift($forms, $k, $end), $count, [], new PlaceholderAllocator());
                if ($built === null || $built['placeholders'] !== ['count']) {
                    return null;
                }
                $words = explode('|', $built['key'])[1];
                $name = $allocator->nameForBase('plural:' . $count, preg_match('/([A-Za-z]+)\W*$/', $words, $m) === 1 ? $m[1] : 'value');
                $one .= ':' . $name;
                $other .= ':' . $name;
                $replace[$name] = $built['code'];
                $inner[] = $built['key'];
                $counts[] = $count;
                $k = $end;
                continue;
            }
            if ($part[0] === 'text') {
                $one .= $part[1];
                $other .= $part[1];
            } elseif (isset($forms[$k])) {
                if ($forms[$k][0] !== $primary) {
                    return null;
                }
                $one .= $forms[$k][1];
                $other .= $forms[$k][2];
            } elseif (trim($part[1]) === $primary) {
                $one .= ':count';
                $other .= ':count';
            } else {
                $name = $allocator->nameFor($part[1], $part[2] ?? null);
                $one .= ':' . $name;
                $other .= ':' . $name;
                $replace[$name] = $part[1];
            }
        }
        $one = self::normalize($one);
        $other = self::normalize($other);
        // 구간 앞의 {0}·[1,*]는 trans_choice가 조건으로 읽는다
        if ($one === $other || $one === '' || preg_match('/^[\[{]/', $one) === 1 || preg_match('/^[\[{]/', $other) === 1) {
            return null;
        }
        $key = $one . '|' . $other;
        $pairs = $replace === [] ? '' : ', [' . implode(', ', array_map(
            static fn (string $name, string $code): string => PhpString::singleQuoted($name) . ' => ' . $code,
            array_keys($replace),
            array_values($replace),
        )) . ']';

        return [
            'code' => 'trans_choice(' . PhpString::singleQuoted($key) . ', ' . $primary . $pairs . ')',
            'key' => $key,
            'placeholders' => ['count', ...array_keys($replace)],
            'counts' => $counts,
            'inner' => $inner,
        ];
    }

    /**
     * @param array<int, array{string, string, string}> $forms
     * @return array<int, array{string, string, string}>
     */
    private static function shift(array $forms, int $from, int $to): array
    {
        $shifted = [];
        foreach ($forms as $index => $form) {
            if ($index >= $from && $index <= $to) {
                $shifted[$index - $from] = $form;
            }
        }

        return $shifted;
    }

    private static function normalize(string $text): string
    {
        return trim((string) preg_replace('/[ \t\r\n\f\v]+/', ' ', $text), " \t\n\r\f\v");
    }

    private static function source(Expr $expr, string $code): string
    {
        return trim(substr($code, (int) $expr->getStartFilePos() - self::PREFIX, (int) $expr->getEndFilePos() + 1 - (int) $expr->getStartFilePos()));
    }
}
