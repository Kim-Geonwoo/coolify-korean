<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Integration;

use CoolifyKo\Codemod\Cli\Application;
use PHPUnit\Framework\TestCase;

final class TransformCommandTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/codemod-test-' . bin2hex(random_bytes(4));
        $files = [
            'source/resources/views/livewire/server/show.blade.php' => "<div>\n    <h2>General</h2>\n    <x-forms.input id=\"name\" label=\"Name\" helper=\"Shown on <b>all</b> pages.\" />\n</div>\n",
            'source/resources/views/livewire/server/empty.blade.php' => "<div>{{ \$server->name }}</div>\n",
            'source/resources/views/components/forms/input.blade.php' => "<label>{{ \$label }}</label>\n@if (\$helper)\n<x-helper :helper=\"\$helper\" />\n@endif\n",
            'source/resources/views/components/helper.blade.php' => "<div>{!! \$helper !!}</div>\n",
            'source/resources/views/emails/welcome.blade.php' => "<p>Welcome aboard</p>\n",
            'source/app/Livewire/Server/Show.php' => "<?php\n\nclass Show\n{\n    public function save()\n    {\n        \$this->dispatch('success', 'Server saved.');\n    }\n}\n",
            'source/config/app.php' => "<?php\n\nreturn [\n    'providers' => [\n        AppServiceProvider::class,\n    ],\n];\n",
            'source/lang/en.json' => '{"auth.login": "Login"}',
            'rules.php' => "<?php return ['brands' => ['Coolify'], 'components' => ['forms.input' => ['label', 'helper']], 'htmlAttributes' => ['title'], 'excludedViewDirectories' => ['emails']];",
        ];
        foreach ($files as $path => $content) {
            $full = $this->root . '/' . $path;
            if (!is_dir(dirname($full))) {
                mkdir(dirname($full), 0777, true);
            }
            file_put_contents($full, $content);
        }
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
    }

    private function run_(string ...$args): int
    {
        ob_start();
        try {
            return (new Application())->run(['codemod', ...$args], STDERR);
        } finally {
            ob_end_clean();
        }
    }

    private function transform(): int
    {
        return $this->run_(
            'transform',
            '--source', $this->root . '/source',
            '--out', $this->root . '/out',
            '--artifacts', $this->root . '/artifacts',
            '--rules', $this->root . '/rules.php',
            '--version', '9.9.9',
        );
    }

    /** @return array<mixed> */
    private function json(string $relative): array
    {
        $decoded = json_decode((string) file_get_contents($this->root . '/artifacts/' . $relative), true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($decoded);

        return $decoded;
    }

    public function testWritesOnlyChangedViewsWithNotice(): void
    {
        self::assertSame(0, $this->transform());

        $out = (string) file_get_contents($this->root . '/out/resources/views/livewire/server/show.blade.php');
        self::assertStringStartsWith("{{-- Modified by coolify-ko", $out);
        self::assertStringContainsString("<h2>{{ __('General') }}</h2>", $out);
        self::assertStringContainsString(":label=\"__('Name')\"", $out);
        self::assertStringContainsString(":helper=\"(string) __h('Shown on <0>all</0> pages.', [['<b>', '</b>']])\"", $out);
        self::assertFileDoesNotExist($this->root . '/out/resources/views/livewire/server/empty.blade.php');
        self::assertFileDoesNotExist($this->root . '/out/resources/views/emails/welcome.blade.php');
    }

    public function testTransformsLivewireToastsAndRegistersProvider(): void
    {
        self::assertSame(0, $this->transform());

        $php = (string) file_get_contents($this->root . '/out/app/Livewire/Server/Show.php');
        self::assertStringStartsWith("<?php
// Modified by coolify-ko", $php);
        self::assertStringContainsString("\$this->dispatch('success', coolify_ko_message('Server saved.'));", $php);
        self::assertStringContainsString('\App\Providers\CoolifyKoServiceProvider::class,', (string) file_get_contents($this->root . '/out/config/app.php'));
    }

    public function testWritesEnglishCatalogAndCoverage(): void
    {
        self::assertSame(0, $this->transform());

        self::assertSame(
            ['General' => 'General', 'Name' => 'Name', 'Server saved.' => 'Server saved.', 'Shown on <0>all</0> pages.' => 'Shown on <0>all</0> pages.', 'auth.login' => 'Login'],
            $this->json('i18n/en.json'),
        );
        $catalog = $this->json('i18n/catalog.json');
        self::assertSame('9.9.9', $catalog['version']);
        self::assertSame(
            [['file' => 'resources/views/livewire/server/show.blade.php', 'line' => 2, 'kind' => 'text']],
            $catalog['keys']['General']['occurrences'],
        );
        self::assertFalse($catalog['keys']['General']['markup']);
        self::assertTrue($catalog['keys']['Shown on <0>all</0> pages.']['markup']);
        $coverage = $this->json('reports/coverage.json');
        self::assertSame(['views' => 4, 'changedViews' => 1, 'converted' => 4, 'skipped' => 0], $coverage['summary']);
        self::assertFileExists($this->root . '/artifacts/reports/coverage.md');
        self::assertFileExists($this->root . '/artifacts/reports/edits.jsonl');
    }

    public function testSecondRunOnOutputChangesNothing(): void
    {
        self::assertSame(0, $this->transform());
        $first = (string) file_get_contents($this->root . '/out/resources/views/livewire/server/show.blade.php');
        copy($this->root . '/out/resources/views/livewire/server/show.blade.php', $this->root . '/source/resources/views/livewire/server/show.blade.php');
        exec('rm -rf ' . escapeshellarg($this->root . '/out'));

        self::assertSame(0, $this->transform());

        self::assertFileDoesNotExist($this->root . '/out/resources/views/livewire/server/show.blade.php');
        self::assertSame(['General', 'Name', 'Server saved.', 'Shown on <0>all</0> pages.', 'auth.login'], array_keys($this->json('i18n/en.json')));
        self::assertNotSame('', $first);
    }

    public function testFailsWhenSourceIsMissing(): void
    {
        self::assertSame(1, $this->run_('transform', '--source', $this->root . '/nope', '--out', $this->root . '/out', '--artifacts', $this->root . '/a', '--rules', $this->root . '/rules.php', '--version', 'x'));
    }
}
