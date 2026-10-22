<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\ComponentProps;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Rules\RuleSet;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** 컴포넌트에 배열 리터럴로 넘기는 prop과 @include 데이터 배열 안의 화면 글자. */
final class ArrayPropTest extends TestCase
{
    private static function transform(string $source): TransformResult
    {
        $rules = new RuleSet(
            brands: ['Coolify'],
            componentArrayProps: [
                'forms.listbox' => ['options' => ['label', 'description']],
                'modal-confirmation' => ['actions' => ['*'], 'checkboxes' => ['label', 'default_warning']],
            ],
            includeArgs: ['livewire.shared.list-search-controls' => ['placeholder' => 'text', 'singular' => 'js', 'plural' => 'js']],
        );

        return (new BladeFileTransformer($rules, ComponentProps::fromTemplates($rules, [])))->transform($source, 'views/livewire/x.blade.php');
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'listbox option rows' => [
            "<x-forms.listbox id=\"cache\" :options=\"[\n    ['value' => false, 'label' => 'Use build cache'],\n    ['value' => 'all', 'label' => 'Rebuild every time', 'description' => 'Slower but clean'],\n]\" />",
            "<x-forms.listbox id=\"cache\" :options=\"[\n    ['value' => false, 'label' => __('Use build cache')],\n    ['value' => 'all', 'label' => __('Rebuild every time'), 'description' => __('Slower but clean')],\n]\" />",
        ];
        yield 'listbox row prepended to mapped data' => [
            "<x-forms.listbox id=\"key\" :options=\"collect(\$keys)->map(fn (\$key) => ['value' => \$key->id, 'label' => \$key->name])->prepend(['value' => null, 'label' => 'None'])->values()->all()\" />",
            "<x-forms.listbox id=\"key\" :options=\"collect(\$keys)->map(fn (\$key) => ['value' => \$key->id, 'label' => \$key->name])->prepend(['value' => null, 'label' => __('None')])->values()->all()\" />",
        ];
        yield 'conditional option row' => [
            "<x-forms.listbox id=\"e\" :options=\"array_values(array_filter([\$ok ? ['value' => 'a', 'label' => 'Use the instance endpoint'] : null]))\" />",
            "<x-forms.listbox id=\"e\" :options=\"array_values(array_filter([\$ok ? ['value' => 'a', 'label' => __('Use the instance endpoint')] : null]))\" />",
        ];
        yield 'confirmation actions including ternary items' => [
            "<x-modal-confirmation :actions=\"[\n    'This will delete the selected project',\n    \$exited ? 'The container will be removed.' : 'This application will be stopped.',\n]\" />",
            "<x-modal-confirmation :actions=\"[\n    __('This will delete the selected project'),\n    \$exited ? __('The container will be removed.') : __('This application will be stopped.'),\n]\" />",
        ];
        yield 'confirmation checkboxes' => [
            "<x-modal-confirmation :checkboxes=\"[['id' => 'deleteVolume', 'label' => 'Also delete the volume.', 'default_warning' => 'The volume stays on the server.']]\" />",
            "<x-modal-confirmation :checkboxes=\"[['id' => 'deleteVolume', 'label' => __('Also delete the volume.'), 'default_warning' => __('The volume stays on the server.')]]\" />",
        ];
        yield 'include data, js-quoted values escaped for JS' => [
            "@include('livewire.shared.list-search-controls', ['placeholder' => 'Search destinations', 'singular' => 'destination', 'plural' => 'destinations'])",
            "@include('livewire.shared.list-search-controls', ['placeholder' => __('Search destinations'), 'singular' => addslashes(__('destination')), 'plural' => addslashes(__('destinations'))])",
        ];
    }

    #[DataProvider('conversions')]
    public function testTranslatesDisplayItemsOfArrayLiterals(string $source, string $expected): void
    {
        self::assertSame($expected, self::transform($source)->output);
    }

    /** @return iterable<string, array{string}> */
    public static function untouched(): iterable
    {
        yield 'array prop of another component' => ["<x-forms.select :options=\"[['value' => 'a', 'label' => 'Option A']]\" />"];
        yield 'array prop not in rules' => ["<x-forms.listbox :values=\"[['label' => 'Option A']]\" />"];
        yield 'mapped rows from data' => ["<x-forms.listbox :options=\"\$servers->map(fn (\$s) => ['value' => \$s->id, 'label' => 'Server ' . \$s->name])\" />"];
        yield 'technical labels' => ["<x-forms.listbox :options=\"[['value' => 'https', 'label' => 'https://'], ['value' => 'v', 'label' => 'v1.2.3']]\" />"];
        yield 'other include' => ["@include('livewire.shared.other', ['placeholder' => 'Search servers'])"];
        yield 'include key not in rules' => ["@include('livewire.shared.list-search-controls', ['mode' => 'Grid view'])"];
    }

    #[DataProvider('untouched')]
    public function testLeavesOtherArraysAlone(string $source): void
    {
        self::assertSame($source, self::transform($source)->output);
    }

    public function testRecordsOneOccurrencePerItem(): void
    {
        $result = self::transform("<x-modal-confirmation :actions=\"['Delete it.']\" :checkboxes=\"[['id' => 'x', 'label' => 'Also this.']]\" />\n"
            . "@include('livewire.shared.list-search-controls', ['singular' => 'source'])");

        self::assertSame(
            [['Delete it.', 'prop-literal', 1], ['Also this.', 'prop-literal', 1], ['source', 'prop-literal', 2]],
            array_map(static fn ($o): array => [$o->key, $o->kind, $o->line], $result->occurrences),
        );
    }

    public function testTransformIsIdempotent(): void
    {
        $source = "<x-forms.listbox :options=\"[['value' => 1, 'label' => 'One item']]\" />\n<x-modal-confirmation :actions=\"['Delete it.']\" />\n"
            . "@include('livewire.shared.list-search-controls', ['placeholder' => 'Search sources', 'singular' => 'source'])";
        $once = self::transform($source)->output;

        self::assertSame($once, self::transform($once)->output);
    }
}
