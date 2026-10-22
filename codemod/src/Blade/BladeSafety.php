<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

/**
 * Blade는 echo 안의 글자도 지시어·echo·PHP 태그·컴포넌트 태그(<x-…>, <livewire:…>)로 컴파일할 수 있다.
 * 그런 글자가 든 문구는 __('...') 안에 넣지 않는다.
 */
final class BladeSafety
{
    private const FORBIDDEN_SEQUENCES = ['{{', '}}', '{!!', '!!}', '<?', '?>'];

    private const DIRECTIVE_PATTERN = '/(?<![\w@])@@?[A-Za-z_]/';

    private const COMPONENT_TAG_PATTERN = '/<\s*\/?\s*(?:x[-:]|livewire[-:])/i';

    public static function isSafeInsideEcho(string $text): bool
    {
        foreach (self::FORBIDDEN_SEQUENCES as $sequence) {
            if (str_contains($text, $sequence)) {
                return false;
            }
        }

        return preg_match(self::DIRECTIVE_PATTERN, $text) === 0 && preg_match(self::COMPONENT_TAG_PATTERN, $text) === 0;
    }
}
