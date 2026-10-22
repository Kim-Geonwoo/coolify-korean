<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\SkipReason;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class TextRunTransformTest extends TestCase
{
    private BladeFileTransformer $transformer;

    protected function setUp(): void
    {
        $this->transformer = new BladeFileTransformer(new RuleSet(brands: ['Coolify', 'Docker', 'GitHub']));
    }

    private function transform(string $source): string
    {
        return $this->transformer->transform($source, 'views/test.blade.php')->output;
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'plain heading' => ['<h2>General</h2>', "<h2>{{ __('General') }}</h2>"];
        yield 'multi-line text keeps outer whitespace' => [
            "<p>\n    Deploy your\n    application.\n</p>",
            "<p>\n    {{ __('Deploy your application.') }}\n</p>",
        ];
        yield 'entity decoded into key' => ['<p>Tom &amp; Jerry</p>', "<p>{{ __('Tom & Jerry') }}</p>"];
        yield 'single quote escaped' => ["<p>Don't stop</p>", "<p>{{ __('Don\\'t stop') }}</p>"];
        yield 'echo merged as placeholder' => [
            '<p>Delete {{ $server->name }}?</p>',
            "<p>{{ __('Delete :name?', ['name' => \$server->name]) }}</p>",
        ];
        yield 'repeated expression reuses placeholder' => [
            '<p>Use {{ $a }} or {{ $a }} now</p>',
            "<p>{{ __('Use :a or :a now', ['a' => \$a]) }}</p>",
        ];
        yield 'placeholder name avoids existing colon word' => [
            '<p>Scope read:name for {{ $name }}</p>',
            "<p>{{ __('Scope read:name for :name2', ['name2' => \$name]) }}</p>",
        ];
        yield 'link inside sentence becomes numbered tag' => [
            '<p>Use <a href="https://coolify.io/docs" target="_blank">this link</a> to learn more.</p>',
            "<p>{{ __h('Use <0>this link</0> to learn more.', [['<a href=\"https://coolify.io/docs\" target=\"_blank\">', '</a>']]) }}</p>",
        ];
        yield 'line break becomes void tag' => [
            '<p>Line one<br>Line two</p>',
            "<p>{{ __h('Line one<0/>Line two', ['<br>']) }}</p>",
        ];
        yield 'code inside sentence is kept whole' => [
            '<p>Run <code>docker ps</code> on the server.</p>',
            "<p>{{ __h('Run <0/> on the server.', ['<code>docker ps</code>']) }}</p>",
        ];
        yield 'echo inside link attribute becomes escaped expression' => [
            '<p>Visit <a href="{{ $url }}" {{ wireNavigate() }}>docs</a> now</p>',
            "<p>{{ __h('Visit <0>docs</0> now', [['<a href=\"' . e(\$url) . '\" ' . e(wireNavigate()) . '>', '</a>']]) }}</p>",
        ];
        yield 'dynamic wrapper link around whole text stays outside' => [
            '<a href="{{ $url }}">Production</a>',
            "<a href=\"{{ \$url }}\">{{ __('Production') }}</a>",
        ];
        yield 'sibling spans separated by whitespace are separate pieces' => [
            '<a href="#"><span class="badge">Production</span> <span>{{ getUrl($d) }}</span></a>',
            "<a href=\"#\"><span class=\"badge\">{{ __('Production') }}</span> <span>{{ getUrl(\$d) }}</span></a>",
        ];
        yield 'wrapper tag around whole text stays outside' => [
            '<p><strong>Warning</strong></p>',
            "<p><strong>{{ __('Warning') }}</strong></p>",
        ];
        yield 'texts between directives convert separately' => [
            '@if($x) Enabled @else Disabled @endif',
            "@if(\$x) {{ __('Enabled') }} @else {{ __('Disabled') }} @endif",
        ];
        yield 'multibyte text before directive keeps directive intact' => [
            'Status · ok @if ($hasIcon) Yes @endif',
            "{{ __('Status · ok') }} @if (\$hasIcon) {{ __('Yes') }} @endif",
        ];
        yield 'page title keeps separators and brand' => [
            '<x-slot:title>Profile | Coolify</x-slot>',
            "<x-slot:title>{{ __('Profile') }} | Coolify</x-slot>",
        ];
        yield 'dynamic page title keeps echo outside' => [
            "<x-slot:title>{{ data_get_str(\$a, 'name')->limit(10) }} > Configuration | Coolify</x-slot>",
            "<x-slot:title>{{ data_get_str(\$a, 'name')->limit(10) }} > {{ __('Configuration') }} | Coolify</x-slot>",
        ];
    }

    #[DataProvider('conversions')]
    public function testConvertsText(string $source, string $expected): void
    {
        self::assertSame($expected, $this->transform($source));
    }

    /** @return iterable<string, array{string, SkipReason}> */
    public static function untouched(): iterable
    {
        yield 'ternary with english words' => ["<p>{{ \$saved ? 'change' : 'changes' }} pending</p>", SkipReason::ComplexExpression];
        yield 'raw echo inside sentence' => ['<p>Hello {!! $html !!} world</p>', SkipReason::RawEcho];
        yield 'directive inside link tag' => ['<p>Visit <a @if($x) class="a" @endif href="#">docs</a> now</p>', SkipReason::DynamicTag];
        yield 'technical path' => ['<p>/data/coolify/source</p>', SkipReason::Technical];
        yield 'brand only' => ['<span>Coolify</span>', SkipReason::BrandOnly];
        yield 'escaped blade echo text' => ['<p>Type @{{ random }} here</p>', SkipReason::UnsafeForBlade];
    }

    #[DataProvider('untouched')]
    public function testLeavesUnsafeTextUnchangedAndReportsWhy(string $source, SkipReason $reason): void
    {
        $result = $this->transformer->transform($source, 'views/test.blade.php');

        self::assertSame($source, $result->output);
        self::assertContains($reason, array_map(static fn ($skip) => $skip->reason, $result->skips));
    }

    public function testArrowInsideComponentAttributeDirectiveIsNotText(): void
    {
        $source = "<x-forms.button isError @class(['w-full' => \$isFullWidth])>{{ \$buttonTitle }}</x-forms.button>";

        self::assertSame($source, $this->transform($source));
    }

    public function testDirectiveOnlyTextIsNeitherChangedNorReported(): void
    {
        $source = "<body>\n    @livewireScripts\n    @persist('upgrade')\n</body>";
        $result = $this->transformer->transform($source, 'views/test.blade.php');

        self::assertSame($source, $result->output);
        self::assertSame([], $result->skips);
    }

    public function testProtectedTextIsNotTouched(): void
    {
        $source = '<code>docker ps</code><span class="font-mono">x y</span><script>alert("Hi there")</script>';

        self::assertSame($source, $this->transform($source));
    }

    public function testAttributesOfEchoedTagNameAreNotText(): void
    {
        $source = <<<'BLADE'
            <{{ $href ? 'a' : 'div' }} wire:key="app-{{ $row['uuid'] }}"
                @if ($href) href="{{ $href }}" @endif
                x-show="{{ $loop->index }} >= page * per && {{ $loop->index }} < (page + 1) * per"
                @class(['flex' => true])>
                <span>Open logs</span>
            </{{ $href ? 'a' : 'div' }}>
            BLADE;

        self::assertSame(str_replace('<span>Open logs</span>', "<span>{{ __('Open logs') }}</span>", $source), $this->transform($source));
    }

    public function testTextThatLooksLikeAnAttributeIsSkipped(): void
    {
        $result = $this->transformer->transform('<p>x-show="open" hides the panel</p>', 'views/x.blade.php');

        self::assertSame('<p>x-show="open" hides the panel</p>', $result->output);
        self::assertSame([SkipReason::AttributeLike], array_map(static fn ($s) => $s->reason, $result->skips));
    }

    public function testRecordsCatalogOccurrencesWithLines(): void
    {
        $result = $this->transformer->transform("<div>\n<h2>General</h2>\n<p>Delete {{ \$a }}?</p></div>", 'views/x.blade.php');

        $found = array_map(static fn ($o) => [$o->key, $o->line, $o->kind], $result->occurrences);
        self::assertSame([['General', 2, 'text'], ['Delete :a?', 3, 'text']], $found);
    }

    public function testTransformIsIdempotent(): void
    {
        $source = "<x-slot:title>Profile | Coolify</x-slot>\n<p>Delete {{ \$server->name }}?</p>\n"
            . "<p>Use <a href=\"https://x.io\">this</a> now.</p>\n<h2>General</h2>";
        $once = $this->transform($source);

        self::assertSame($once, $this->transform($once));
    }
}
