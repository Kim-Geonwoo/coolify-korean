<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Rules\RuleSet;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Alpine 표시 식에서 글자와 값 하나를 이은 문장('Deploy ' + x.name, `Open ${item.name}`)을
 * 번역된 JS 문자열의 자리표시자를 값으로 바꾸는 식으로 만든다(런타임 도우미 없이 split/join).
 */
final class AlpineSentenceTest extends TestCase
{
    private const JS = '\Illuminate\Support\Js::from';

    private static function transform(string $source): TransformResult
    {
        $rules = new RuleSet(brands: ['Coolify'], alpineAttributes: ['x-text', ':title', ':aria-label', ':alt', ':placeholder', 'x-bind:placeholder']);

        return (new BladeFileTransformer($rules))->transform($source, 'views/livewire/x.blade.php');
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        $js = self::JS;
        yield 'text plus value' => [
            "<button :aria-label=\"'Deploy ' + application.name\"></button>",
            "<button :aria-label=\"{{ {$js}(__('Deploy :name')) }}.split(':name').join('' + (application.name))\"></button>",
        ];
        yield 'value inside text in both ternary branches' => [
            "<button :title=\"hasPageSearch\n    ? 'Search this page (Press / or ' + modKeyLabel + 'K)'\n    : 'Search (Press / or ' + modKeyLabel + 'K)'\"></button>",
            "<button :title=\"hasPageSearch\n    ? {{ {$js}(__('Search this page (Press / or :mod_key_labelK)')) }}.split(':mod_key_label').join('' + (modKeyLabel))\n"
            . "    : {{ {$js}(__('Search (Press / or :mod_key_labelK)')) }}.split(':mod_key_label').join('' + (modKeyLabel))\"></button>",
        ];
        yield 'template literal' => [
            '<a :aria-label="`Open settings for ${project.name}`"></a>',
            "<a :aria-label=\"{{ {$js}(__('Open settings for :name')) }}.split(':name').join(`\${project.name}`)\"></a>",
        ];
        yield 'template literal count phrase' => [
            "<span x-text=\"`\${resources.length} \${resources.length === 1 ? 'resource' : 'resources'}`\"></span>",
            "<span x-text=\"(resources.length === 1 ? {{ {$js}(trans_choice(':count resource|:count resources', 1, ['count' => ':count'])) }} : "
            . "{{ {$js}(trans_choice(':count resource|:count resources', 2, ['count' => ':count'])) }}).split(':count').join(`\${resources.length}`)\"></span>",
        ];
    }

    #[DataProvider('conversions')]
    public function testTurnsTextJoinedWithOneValueIntoATranslatedTemplate(string $source, string $expected): void
    {
        self::assertSame($expected, self::transform($source)->output);
    }

    /** @return iterable<string, array{string}> */
    public static function untouched(): iterable
    {
        yield 'two values' => ["<span x-text=\"'From ' + start + ' to ' + end\"></span>"];
        yield 'arithmetic after the text' => ["<span x-text=\"'Page ' + page + 1\"></span>"];
        yield 'value that is a call' => ['<span x-text="`Total ${total.toLocaleString()}`"></span>'];
        yield 'no words' => ['<span x-text="`+${item.tags.length}`"></span>'];
        yield 'single letter beside the value' => ["<kbd x-text=\"modKeyLabel + 'K'\"></kbd>"];
        yield 'escape inside the template' => ['<span x-text="`Open \\`${name}\\``"></span>'];
        yield 'attribute that is not shown' => ["<div :class=\"'text-' + color\"></div>"];
    }

    #[DataProvider('untouched')]
    public function testLeavesOtherExpressionsAlone(string $source): void
    {
        self::assertSame($source, self::transform($source)->output);
    }

    public function testRecordsKeysPlaceholdersAndPluralKind(): void
    {
        $result = self::transform("<a :aria-label=\"`Open \${item.name}`\"></a><span x-text=\"`\${n} \${n === 1 ? 'tag' : 'tags'}`\"></span>");

        self::assertSame(
            [
                ['Open :name', 'alpine-sentence', ['name'], []],
                [':count tag|:count tags', 'alpine-sentence', ['count'], ['n']],
                [':count tag|:count tags', 'plural', ['count'], []],
            ],
            array_map(static fn ($o): array => [$o->key, $o->kind, $o->placeholders, $o->counts], $result->occurrences),
        );
    }

    public function testTransformIsIdempotent(): void
    {
        $once = self::transform("<button :aria-label=\"'Deploy ' + application.name\"></button><a :aria-label=\"`Open \${item.name}`\"></a>")->output;

        self::assertSame($once, self::transform($once)->output);
    }
}
