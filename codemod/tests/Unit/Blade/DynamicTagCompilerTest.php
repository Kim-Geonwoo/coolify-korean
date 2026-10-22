<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\DynamicTagCompiler;
use PHPUnit\Framework\TestCase;

final class DynamicTagCompilerTest extends TestCase
{
    public function testCompilesEchoesLikeBlade(): void
    {
        self::assertSame("'<a title=\"' . e(\$x) . '\" data-r=\"' . (\$y) . '\">'", DynamicTagCompiler::compile('<a title="{{ $x }}" data-r="{!! $y !!}">'));
    }

    public function testLeavesEscapedEchoesAlone(): void
    {
        self::assertNull(DynamicTagCompiler::compile('<a title="@{{ $x }}">'));
        self::assertNull(DynamicTagCompiler::compile('<a title="{{ $x }}" data-y="@{!! $y !!}">'));
    }
}
