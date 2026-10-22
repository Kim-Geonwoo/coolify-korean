<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Php;

final class PhpString
{
    public static function singleQuoted(string $value): string
    {
        return "'" . str_replace(['\\', "'"], ['\\\\', "\\'"], $value) . "'";
    }
}
