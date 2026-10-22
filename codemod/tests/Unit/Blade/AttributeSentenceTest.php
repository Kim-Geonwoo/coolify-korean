<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Rules\RuleSet;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** 화면 글자 속성(title·aria-label …) 값에 echo가 낀 문장을 자리표시자 문장 하나로 바꾼다. */
final class AttributeSentenceTest extends TestCase
{
    private static function transform(string $source): TransformResult
    {
        $rules = new RuleSet(brands: ['Coolify'], htmlAttributes: ['title', 'aria-label', 'alt', 'placeholder', 'data-tooltip']);

        return (new BladeFileTransformer($rules))->transform($source, 'views/livewire/x.blade.php');
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'text and echo' => [
            '<a href="#" aria-label="Open {{ $project->name }}"></a>',
            "<a href=\"#\" aria-label=\"{{ __('Open :name', ['name' => \$project->name]) }}\"></a>",
        ];
        yield 'two echoes and an entity' => [
            '<button title="Edit {{ $key->name }} &amp; {{ $key->description }}"></button>',
            "<button title=\"{{ __('Edit :name & :description', ['name' => \$key->name, 'description' => \$key->description]) }}\"></button>",
        ];
        yield 'tag that also holds Blade' => [
            '<a title="Open {{ $server->name }}" {{ wireNavigate() }} href="/s"></a>',
            "<a title=\"{{ __('Open :name', ['name' => \$server->name]) }}\" {{ wireNavigate() }} href=\"/s\"></a>",
        ];
        yield 'count phrase becomes a plural choice' => [
            "<span aria-label=\"{{ \$unreadCount }} unread changelog {{ Str::plural('entry', \$unreadCount) }}\"></span>",
            "<span aria-label=\"{{ trans_choice(':count unread changelog entry|:count unread changelog entries', \$unreadCount) }}\"></span>",
        ];
    }

    #[DataProvider('conversions')]
    public function testTurnsAttributeTextWithEchoesIntoOneSentence(string $source, string $expected): void
    {
        self::assertSame($expected, self::transform($source)->output);
    }

    /** @return iterable<string, array{string}> */
    public static function untouched(): iterable
    {
        yield 'expression that is not a plain value' => ["<a title=\"Open {{ \$a ? 'x' : 'y' }} now\"></a>"];
        yield 'raw echo' => ['<a title="Open {!! $html !!}"></a>'];
        yield 'attribute that is not shown' => ['<a data-name="Open {{ $x }}"></a>'];
        yield 'single-quoted attribute' => ["<a title='Open {{ \$x }}'></a>"];
        yield 'line break inside the value' => ["<a title=\"Open\n{{ \$x }}\"></a>"];
        yield 'no words besides the value' => ['<a title="#{{ $x }}"></a>'];
        yield 'number_format value the equivalence check cannot evaluate' => ["<span title=\"{{ number_format(\$row['requests']) }} requests\"></span>"];
    }

    #[DataProvider('untouched')]
    public function testLeavesOtherAttributesAlone(string $source): void
    {
        self::assertSame($source, self::transform($source)->output);
    }

    public function testWrapsTemplateLabelsUsedAsPlaceholders(): void
    {
        $source = "@php\n[\$serverStatus, \$serverStatusType] = match (true) {\n    \$broken => ['Attention required', 'warning'],\n    default => ['Ready', 'success'],\n};\n@endphp\n"
            . '<span data-tooltip="{{ $serverStatus }}" aria-label="Server status: {{ $serverStatus }}"></span>';
        $result = self::transform($source);

        self::assertStringContainsString(
            "<span data-tooltip=\"{{ coolify_ko_t(\$serverStatus) }}\" aria-label=\"{{ __('Server status: :server_status', ['server_status' => coolify_ko_t(\$serverStatus)]) }}\"></span>",
            $result->output,
        );
        self::assertSame(
            [['Attention required', 'display'], ['Ready', 'display'], ['Server status: :server_status', 'html-attribute']],
            array_map(static fn ($o): array => [$o->key, $o->kind], array_values(array_filter($result->occurrences, static fn ($o) => $o->key !== ''))),
        );
    }

    public function testLeavesTagsInsideConvertedSentencesToTheSentence(): void
    {
        $output = self::transform('<p>Click <a href="#" title="Open {{ $x }}">here</a> to continue.</p>')->output;

        self::assertStringNotContainsString("__('Open :x'", $output);
    }

    public function testRecordsPlaceholdersAndCounts(): void
    {
        $result = self::transform("<span title=\"{{ \$n }} {{ Str::plural('entry', \$n) }} for {{ \$team->name }}\"></span>");

        self::assertSame(
            [[':count entry for :name|:count entries for :name', 'plural', ['count', 'name'], ['$n']]],
            array_map(static fn ($o): array => [$o->key, $o->kind, $o->placeholders, $o->counts], $result->occurrences),
        );
    }

    public function testTransformIsIdempotent(): void
    {
        $once = self::transform('<a aria-label="Open {{ $project->name }}"></a>')->output;

        self::assertSame($once, self::transform($once)->output);
    }
}
