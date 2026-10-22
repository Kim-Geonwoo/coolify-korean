<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\ComponentProps;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\SkipReason;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class LiteralLeafTest extends TestCase
{
    private const JS = '\Illuminate\Support\Js::from';

    private static function transform(string $source): TransformResult
    {
        $rules = new RuleSet(
            brands: ['Coolify'],
            components: ['status-summary' => ['containerName']],
            htmlAttributes: ['title', 'placeholder'],
            alpineAttributes: ['x-text', ':title', 'x-bind:title', ':placeholder'],
            scriptCalls: ['window.toast' => 0],
        );
        $props = ComponentProps::fromTemplates($rules, [
            'status-summary' => "@props(['containerName' => 'Container', 'size' => 'md'])\n<span>{{ \$containerName }}</span><i class=\"{{ \$size }}\"></i>",
        ]);

        return (new BladeFileTransformer($rules, $props))->transform($source, 'views/livewire/x.blade.php');
    }

    /** @return list<array{string, string}> */
    private static function keys(TransformResult $result): array
    {
        return array_map(static fn ($o): array => [$o->key, $o->kind], $result->occurrences);
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'echo ternary branches' => [
            "<span>{{ \$serverReady ? 'Ready' : 'Unavailable' }}</span>",
            "<span>{{ \$serverReady ? __('Ready') : __('Unavailable') }}</span>",
        ];
        yield 'echo condition strings stay' => [
            "<span>{{ \$status === 'running' ? 'Running' : 'Stopped' }}</span>",
            "<span>{{ \$status === 'running' ? __('Running') : __('Stopped') }}</span>",
        ];
        yield 'echo fallback' => [
            "<span>{{ \$name ?? 'Unnamed' }}</span>",
            "<span>{{ \$name ?? __('Unnamed') }}</span>",
        ];
        yield 'echo concatenated branch stays' => [
            "<span>{{ \$ok ? 'Hello ' . \$name : 'Goodbye' }}</span>",
            "<span>{{ \$ok ? 'Hello ' . \$name : __('Goodbye') }}</span>",
        ];
        yield 'alpine x-text ternary' => [
            "<span x-text=\"enabled ? 'Disable' : 'Enable'\">{{ \$label }}</span>",
            "<span x-text=\"enabled ? {{ " . self::JS . "(__('Disable')) }} : {{ " . self::JS . "(__('Enable')) }}\">{{ \$label }}</span>",
        ];
        yield 'alpine bound title' => [
            "<button type=\"button\" :title=\"copied ? 'Copied' : 'Copy details'\"></button>",
            "<button type=\"button\" :title=\"copied ? {{ " . self::JS . "(__('Copied')) }} : {{ " . self::JS . "(__('Copy details')) }}\"></button>",
        ];
        yield 'alpine bound title on a tag with blade' => [
            "<button class=\"{{ \$c }}\" :title=\"open ? 'Close menu' : 'Open menu'\"></button>",
            "<button class=\"{{ \$c }}\" :title=\"open ? {{ " . self::JS . "(__('Close menu')) }} : {{ " . self::JS . "(__('Open menu')) }}\"></button>",
        ];
        yield 'script call title' => [
            "<script>\n    window.toast('Success', { type: 'success', description: message });\n</script>",
            "<script>\n    window.toast({{ " . self::JS . "(__('Success')) }}, { type: 'success', description: message });\n</script>",
        ];
        yield 'bound component prop ternary' => [
            "<x-status-summary :status=\"\$s\" :container-name=\"\$sel ? 'Container' : 'Containers'\" />",
            "<x-status-summary :status=\"\$s\" :container-name=\"\$sel ? __('Container') : __('Containers')\" />",
        ];
        yield 'bound component prop literal' => [
            "<x-status-summary :container-name=\"'Containers'\" />",
            "<x-status-summary :container-name=\"__('Containers')\" />",
        ];
    }

    #[DataProvider('conversions')]
    public function testConvertsLiteralLeaves(string $source, string $expected): void
    {
        self::assertSame($expected, self::transform($source)->output);
    }

    /** @return iterable<string, array{string}> */
    public static function untouched(): iterable
    {
        yield 'already translated echo' => ["<span>{{ \$ok ? __('A b') : __('C d') }}</span>"];
        yield 'technical echo leaves' => ["<span>{{ \$ok ? 'text-red-500' : 'v1.2.3' }}</span>"];
        yield 'single-quoted alpine attribute' => ["<span x-text='ok ? \"Yes\" : \"No\"'>{{ \$x }}</span>"];
        yield 'alpine attribute not in rules' => ["<span x-show=\"mode === 'Advanced'\">{{ \$x }}</span>"];
        yield 'alpine attribute with blade inside' => ["<span class=\"{{ \$c }}\" x-text=\"ok ? '{{ \$label }}' : 'No label'\"></span>"];
        yield 'alpine concatenation of two values' =>["<span x-text=\"'Search (' + key + ' or ' + other + ')'\">{{ \$x }}</span>"];
        yield 'alpine on component' => ["<x-status-summary x-text=\"'Hello there'\" />"];
        yield 'other script calls' => ["<script>console.log('Saved changes'); notify('Saved changes');</script>"];
        yield 'prop not in rules' => ["<x-status-summary :size=\"\$big ? 'Large size' : 'Small size'\" />"];
    }

    #[DataProvider('untouched')]
    public function testLeavesOtherLiteralsAlone(string $source): void
    {
        self::assertSame($source, self::transform($source)->output);
    }

    public function testRecordsOneOccurrencePerLeaf(): void
    {
        $result = self::transform("<span>{{ \$ready ? 'Ready' : 'Unavailable' }}</span><b x-text=\"ok ? 'Yes' : 'No'\">{{ \$x }}</b>");

        self::assertSame([['Ready', 'echo-literal'], ['Unavailable', 'echo-literal'], ['Yes', 'alpine-literal'], ['No', 'alpine-literal']], self::keys($result));
    }

    public function testTranslatesTextPiecesOfAnUnbalancedRun(): void
    {
        $source = "<div class=\"flex\">\n<a class=\"button\" href=\"/docs\">\n    Docs\n</a>\n<span class=\"button\">\n    Deploy\n    <x-reicon name=\"arrow-right\" />\n</span>\n</div>";
        $result = self::transform($source);

        self::assertStringContainsString("{{ __('Docs') }}", $result->output);
        self::assertStringContainsString("{{ __('Deploy') }}", $result->output);
        self::assertNotContains(SkipReason::UnbalancedTags, array_map(static fn ($s) => $s->reason, $result->skips));
    }

    public function testTransformIsIdempotent(): void
    {
        $source = "<span>{{ \$ok ? 'Ready' : 'Unavailable' }}</span><b x-text=\"ok ? 'Yes' : 'No'\">{{ \$x }}</b>"
            . "<script>window.toast('Error', {});</script><x-status-summary :container-name=\"\$sel ? 'Container' : 'Containers'\" />";
        $once = self::transform($source)->output;

        self::assertSame($once, self::transform($once)->output);
    }
}
