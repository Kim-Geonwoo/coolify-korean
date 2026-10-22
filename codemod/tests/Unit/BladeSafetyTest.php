<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit;

use CoolifyKo\Codemod\Blade\BladeSafety;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class BladeSafetyTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function unsafe(): iterable
    {
        yield 'echo open' => ['Use {{ random }} here'];
        yield 'echo close' => ['ends }} here'];
        yield 'raw echo open' => ['a {!! b'];
        yield 'raw echo close' => ['a !!} b'];
        yield 'directive after space' => ['Use @if to branch'];
        yield 'escaped directive' => ['Type @@{{ random }}'];
        yield 'directive at start' => ['@csrf token'];
        yield 'php open tag' => ['run <?php here'];
        yield 'php short echo' => ['<?= x'];
        yield 'php close tag' => ['done ?> now'];
        yield 'component tag' => ['Use <x-forms.input> here'];
        yield 'component closing tag' => ['end </x-slot>'];
        yield 'colon component tag' => ['<x:alert> now'];
        yield 'spaced component tag' => ['a < x-alert b'];
        yield 'livewire tag' => ['<livewire:server.navbar /> here'];
    }

    #[DataProvider('unsafe')]
    public function testRejectsTextThatBladeWouldCompile(string $text): void
    {
        self::assertFalse(BladeSafety::isSafeInsideEcho($text));
    }

    /** @return iterable<string, array{string}> */
    public static function safe(): iterable
    {
        yield 'plain' => ['Deploy your application'];
        yield 'email' => ['Contact admin@example.com'];
        yield 'single braces' => ['Use {name} and {count}'];
        yield 'laravel placeholder' => ['Delete :name?'];
        yield 'at sign alone' => ['Meet @ 5pm'];
        yield 'x without dash' => ['Use <xmp> or <x> here'];
    }

    #[DataProvider('safe')]
    public function testAcceptsOrdinaryText(string $text): void
    {
        self::assertTrue(BladeSafety::isSafeInsideEcho($text));
    }
}
