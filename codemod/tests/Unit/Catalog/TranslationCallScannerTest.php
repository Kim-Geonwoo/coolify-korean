<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Catalog;

use CoolifyKo\Codemod\Catalog\Occurrence;
use CoolifyKo\Codemod\Catalog\TranslationCallScanner;
use PHPUnit\Framework\TestCase;

final class TranslationCallScannerTest extends TestCase
{
    /** @return list<string> */
    private static function keys(string $source): array
    {
        return array_map(static fn (Occurrence $o): string => $o->key, TranslationCallScanner::scan($source, 'x.php'));
    }

    public function testFindsLiteralKeysOfTranslationCalls(): void
    {
        self::assertSame(
            ['A', 'B <0/>', "Don't", 'auth.login'],
            self::keys("__('A') . __h('B <0/>', ['<br>']) . trans('Don\'t') . @lang('auth.login')"),
        );
    }

    public function testFindsMessageHelperKeys(): void
    {
        self::assertSame(['Server :name saved.'], self::keys("\$this->dispatch('success', coolify_ko_message('Server :name saved.', [], ['name' => \$n]));"));
    }

    public function testFindsPluralKeysAsTheirOwnKind(): void
    {
        $found = TranslationCallScanner::scan("{{ trans_choice(':count resource uses|:count resources use', \$n) }} {{ trans('A') }}", 'x.blade.php');

        self::assertSame(
            [[':count resource uses|:count resources use', 'plural'], ['A', 'existing']],
            array_map(static fn (Occurrence $o): array => [$o->key, $o->kind], $found),
        );
    }

    public function testIgnoresMethodsWithTheSameName(): void
    {
        self::assertSame([], self::keys("\$this->__('A') . Foo::trans('B') . \$x->coolify_ko_message('C')"));
    }
}
