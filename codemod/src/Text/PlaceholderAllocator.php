<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Text;

use PhpParser\Node\Expr;

/**
 * 한 문장 안에서 자리표시자 이름을 나눠 준다. 같은 식은 같은 이름을 쓰고,
 * 원문에 이미 있는 :단어(대소문자 무시)와 겹치지 않게 숫자를 붙인다.
 */
final class PlaceholderAllocator
{
    /** @var array<string, true> */
    private array $reserved = [];

    /** @var array<string, string> 식 코드 → 이름 */
    private array $names = [];

    public function reserveFrom(string $text): void
    {
        preg_match_all('/:([A-Za-z_]\w*)/', $text, $m);
        foreach ($m[1] as $word) {
            $this->reserved[strtolower($word)] = true;
        }
    }

    public function nameFor(string $code, ?Expr $expr): string
    {
        return $this->nameForBase($code, $expr === null ? 'value' : PlaceholderNamer::baseName($expr));
    }

    /** nameFor와 같고, 이름 바탕을 직접 준다(복수형 구절이면 그 낱말, 예: 'services'). 바탕은 영문 소문자·숫자·_만 남긴다. */
    public function nameForBase(string $code, string $base): string
    {
        if (isset($this->names[$code])) {
            return $this->names[$code];
        }
        $base = trim((string) preg_replace('/[^a-z0-9]+/', '_', strtolower($base)), '_');
        $base = $base === '' || ctype_digit($base[0]) ? 'value' : $base;
        $name = $base;
        $n = 2;
        while (isset($this->reserved[$name]) || in_array($name, $this->names, true)) {
            $name = $base . $n++;
        }

        return $this->names[$code] = $name;
    }

    /** @return array<string, string> 식 코드 → 이름(등장 순서) */
    public function all(): array
    {
        return $this->names;
    }
}
