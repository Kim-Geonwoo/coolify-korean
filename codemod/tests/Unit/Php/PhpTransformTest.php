<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Php;

use CoolifyKo\Codemod\Php\PhpFileTransformer;
use CoolifyKo\Codemod\Rules\RuleSet;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class PhpTransformTest extends TestCase
{
    private PhpFileTransformer $transformer;

    protected function setUp(): void
    {
        $this->transformer = new PhpFileTransformer(new RuleSet(brands: ['Coolify']));
    }

    private static function wrap(string $body): string
    {
        return "<?php\n\nclass Demo\n{\n    public function save()\n    {\n        {$body}\n    }\n}\n";
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'single quoted toast' => ["\$this->dispatch('success', 'Server saved.');", "\$this->dispatch('success', coolify_ko_message('Server saved.'));"];
        yield 'double quoted without variables' => ["\$this->dispatch('error', \"Could not save.\");", "\$this->dispatch('error', coolify_ko_message('Could not save.'));"];
        yield 'property interpolation' => [
            "\$this->dispatch('success', \"Server {\$server->name} saved.\");",
            "\$this->dispatch('success', coolify_ko_message('Server :name saved.', [], ['name' => \$server->name]));",
        ];
        yield 'simple variable interpolation' => [
            "\$this->dispatch('info', \"Hello \$name\");",
            "\$this->dispatch('info', coolify_ko_message('Hello :name', [], ['name' => \$name]));",
        ];
        yield 'concatenation' => [
            "\$this->dispatch('success', 'Deleted ' . \$count . ' items.');",
            "\$this->dispatch('success', coolify_ko_message('Deleted :count items.', [], ['count' => \$count]));",
        ];
        yield 'html toast keeps markup through helper' => [
            "\$this->dispatch('warning', 'Done.<br>Restart required.');",
            "\$this->dispatch('warning', coolify_ko_message('Done.<0/>Restart required.', ['<br>']));",
        ];
        yield 'html toast keeps entities verbatim' => [
            "\$this->dispatch('info', 'Use &amp; <b>care</b>');",
            "\$this->dispatch('info', coolify_ko_message('Use &amp; <0>care</0>', [['<b>', '</b>']]));",
        ];
        yield 'whitespace is kept because the toast body is pre-wrap' => [
            "\$this->dispatch('info', \"Line one.\n  Line two. \");",
            "\$this->dispatch('info', coolify_ko_message('Line one.\n  Line two. '));",
        ];
        yield 'title is text and body is a message' => [
            "\$this->dispatch('error', ['Saved', 'All good.']);",
            "\$this->dispatch('error', [__('Saved'), coolify_ko_message('All good.')]);",
        ];
        yield 'single item array is a body' => [
            "\$this->dispatch('error', ['All good.']);",
            "\$this->dispatch('error', [coolify_ko_message('All good.')]);",
        ];
    }

    #[DataProvider('conversions')]
    public function testConvertsToastMessages(string $body, string $expected): void
    {
        self::assertSame(self::wrap($expected), $this->transformer->transform(self::wrap($body), 'app/Livewire/Demo.php')->output);
    }

    /** @return iterable<string, array{string}> */
    public static function untouched(): iterable
    {
        yield 'other event' => ["\$this->dispatch('refresh', 'Server saved.');"];
        yield 'no message' => ["\$this->dispatch('success');"];
        yield 'dynamic message' => ["\$this->dispatch('error', \$e->getMessage());"];
        yield 'already translated' => ["\$this->dispatch('success', __('Server saved.'));"];
        yield 'brand only' => ["\$this->dispatch('success', 'Coolify');"];
        yield 'not on this' => ["\$other->dispatch('success', 'Server saved.');"];
        yield 'array the browser does not show' => ["\$this->dispatch('info', ['One thing', 'Two things', 'Three things']);"];
        yield 'keyed array the browser does not show' => ["\$this->dispatch('info', ['title' => 'One thing', 'body' => 'Two things']);"];
    }

    #[DataProvider('untouched')]
    public function testLeavesOtherCallsUnchanged(string $body): void
    {
        self::assertSame(self::wrap($body), $this->transformer->transform(self::wrap($body), 'app/Livewire/Demo.php')->output);
    }

    public function testWrapsValidationMessageValuesOnly(): void
    {
        $source = "<?php\n\nclass Form\n{\n    protected function messages(): array\n    {\n        return [\n            'name.required' => 'The name is required.',\n            'port.min' => 'Port must be at least :min.',\n        ];\n    }\n}\n";
        $expected = "<?php\n\nclass Form\n{\n    protected function messages(): array\n    {\n        return [\n            'name.required' => coolify_ko_message('The name is required.'),\n            'port.min' => coolify_ko_message('Port must be at least :min.'),\n        ];\n    }\n}\n";

        $result = $this->transformer->transform($source, 'app/Livewire/Form.php');

        self::assertSame($expected, $result->output);
        self::assertSame([['The name is required.', 8, 'validation'], ['Port must be at least :min.', 9, 'validation']], array_map(static fn ($o) => [$o->key, $o->line, $o->kind], $result->occurrences));
    }

    public function testUpstreamKeyInToastBecomesMessageHelperFromItsEnglish(): void
    {
        $transformer = new PhpFileTransformer(new RuleSet(brands: ['Coolify']), ['warning.sslip' => "Saved, but <span class='x'>NOT</span> ok. <br><br>Use yours."]);
        $result = $transformer->transform(self::wrap("\$this->dispatch('warning', __('warning.sslip'));"), 'x.php');

        self::assertSame(
            self::wrap("\$this->dispatch('warning', coolify_ko_message('Saved, but <0>NOT</0> ok. <1/><2/>Use yours.', [['<span class=\'x\'>', '</span>'], '<br>', '<br>']));"),
            $result->output,
        );
        self::assertSame([['Saved, but <0>NOT</0> ok. <1/><2/>Use yours.', 'toast-html']], array_map(static fn ($o) => [$o->key, $o->kind], $result->occurrences));
    }

    public function testTranslationCallsWithoutUpstreamJsonLineStay(): void
    {
        $transformer = new PhpFileTransformer(new RuleSet(brands: ['Coolify']), ['warning.sslip' => 'x']);
        $source = self::wrap("\$this->dispatch('error', __('validation.required'));");

        self::assertSame($source, $transformer->transform($source, 'x.php')->output);
    }

    public function testRecordsFilesThatDoNotParse(): void
    {
        $result = $this->transformer->transform("<?php

class {
", 'app/Livewire/Broken.php');

        self::assertSame("<?php

class {
", $result->output);
        self::assertSame([['app/Livewire/Broken.php', 'parse-error']], array_map(static fn ($s) => [$s->file, $s->reason->value], $result->skips));
    }

    public function testTitleKindIsSeparateFromBodyKind(): void
    {
        $result = $this->transformer->transform(self::wrap("\$this->dispatch('error', ['Saved', 'All good.']);"), 'x.php');

        self::assertSame([['Saved', 'toast-title'], ['All good.', 'toast']], array_map(static fn ($o) => [$o->key, $o->kind], $result->occurrences));
    }

    public function testTransformIsIdempotent(): void
    {
        $source = self::wrap("\$this->dispatch('success', \"Server {\$server->name} saved.\");");
        $once = $this->transformer->transform($source, 'x.php')->output;

        self::assertSame($once, $this->transformer->transform($once, 'x.php')->output);
    }
}
