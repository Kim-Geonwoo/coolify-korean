<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\ComponentProps;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Rules\RuleSet;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** 컴포넌트에 넘기는 값이 글자와 식을 이어 붙인 라벨이면 자리표시자 문장으로 바꾼다. */
final class ConcatPropTest extends TestCase
{
    private static function transform(string $source): TransformResult
    {
        $rules = new RuleSet(
            brands: ['Coolify'],
            components: ['forms.input' => ['label', 'ariaLabel'], 'helper' => ['label']],
            componentArrayProps: ['modal-confirmation' => ['actions' => ['*']]],
        );
        $props = ComponentProps::fromTemplates($rules, [
            'forms.input' => "@props(['label' => null, 'id' => null])\n<label>{{ \$label }}</label><input {{ \$attributes->merge(['class' => 'input']) }}>",
            'helper' => "@props(['label' => 'More information'])\n<button aria-label=\"{{ \$label }}\"></button>",
        ]);

        return (new BladeFileTransformer($rules, $props))->transform($source, 'views/livewire/x.blade.php');
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'variable then text' => [
            "<x-forms.input :label=\"\$label . ' URL (internal)'\" />",
            "<x-forms.input :label=\"__(':label URL (internal)', ['label' => \$label])\" />",
        ];
        yield 'text then variable' => [
            "<x-helper :label=\"'More information about '.\$title\" />",
            "<x-helper :label=\"__('More information about :title', ['title' => \$title])\" />",
        ];
        yield 'attribute bag prop from array value' => [
            "<x-forms.input :aria-label=\"\$event['label'] . ' topic ID'\" />",
            "<x-forms.input :aria-label=\"__(':label topic ID', ['label' => \$event['label']])\" />",
        ];
        yield 'colon in text and taken placeholder name' => [
            "<x-forms.input :label=\"'Application: ' . \$item['name']\" /><x-forms.input :label=\"'Rename :name to ' . \$name\" />",
            "<x-forms.input :label=\"__('Application: :name', ['name' => \$item['name']])\" /><x-forms.input :label=\"__('Rename :name to :name2', ['name2' => \$name])\" />",
        ];
        yield 'concatenation in a ternary branch' => [
            "<x-forms.input :label=\"\$ok ? 'Use ' . \$fqdn : 'None'\" />",
            "<x-forms.input :label=\"\$ok ? __('Use :fqdn', ['fqdn' => \$fqdn]) : __('None')\" />",
        ];
        yield 'concatenated items of an array prop' => [
            "<x-modal-confirmation :actions=\"['Change Git source to ' . \$source->name, 'Replace acme.json with the backup from '.\$backup['created_at'].'.']\" />",
            "<x-modal-confirmation :actions=\"[__('Change Git source to :name', ['name' => \$source->name]), __('Replace acme.json with the backup from :created_at.', ['created_at' => \$backup['created_at']])]\" />",
        ];
    }

    #[DataProvider('conversions')]
    public function testTurnsConcatenatedLabelsIntoPlaceholderSentences(string $source, string $expected): void
    {
        self::assertSame($expected, self::transform($source)->output);
    }

    /** @return iterable<string, array{string}> */
    public static function untouched(): iterable
    {
        yield 'part that is not a plain value' => ["<x-forms.input :label=\"'Mode: ' . (\$spa ? 'SPA' : 'static')\" />"];
        yield 'no words around values' => ["<x-forms.input :label=\"\$a . ' / ' . \$b\" />"];
        yield 'only values' => ["<x-forms.input :label=\"\$a . \$b\" />"];
        yield 'prop not in rules' => ["<x-forms.input :id=\"'field for ' . \$x\" />"];
        yield 'echo concatenation' => ["<span>{{ 'Hello ' . \$name }}</span>"];
    }

    #[DataProvider('untouched')]
    public function testLeavesOtherConcatenationsAlone(string $source): void
    {
        self::assertSame($source, self::transform($source)->output);
    }

    public function testRecordsPlaceholders(): void
    {
        $result = self::transform("<x-forms.input :label=\"\$label . ' URL (public)'\" />");

        self::assertSame([[':label URL (public)', 'prop-literal', ['label']]], array_map(static fn ($o): array => [$o->key, $o->kind, $o->placeholders], $result->occurrences));
    }

    public function testTransformIsIdempotent(): void
    {
        $once = self::transform("<x-helper :label=\"'More information about '.\$title\" />")->output;

        self::assertSame($once, self::transform($once)->output);
    }
}
