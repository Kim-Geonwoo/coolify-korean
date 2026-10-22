<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Cli;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\ComponentProps;
use CoolifyKo\Codemod\Catalog\CatalogWriter;
use CoolifyKo\Codemod\Catalog\Occurrence;
use CoolifyKo\Codemod\Catalog\RemainingTextScanner;
use CoolifyKo\Codemod\Catalog\Skip;
use CoolifyKo\Codemod\Catalog\TranslationCallScanner;
use CoolifyKo\Codemod\Php\PhpFileTransformer;
use CoolifyKo\Codemod\Php\ProviderRegistration;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\TextClassifier;
use RuntimeException;

/**
 * codemod transform --source <공식 이미지에서 꺼낸 폴더> --out <바뀐 파일만> --artifacts <산출물> --rules <규칙> --version <버전>
 */
final class TransformCommand
{
    public const BLADE_NOTICE = "{{-- Modified by coolify-ko: hardcoded UI text wrapped in Laravel translation calls (Apache-2.0 section 4(b)). --}}\n";

    public const PHP_NOTICE = "// Modified by coolify-ko: user-facing strings wrapped in Laravel translation calls (Apache-2.0 section 4(b)).\n";

    public const PROVIDER_CLASS = 'App\\Providers\\CoolifyKoServiceProvider';

    /** @param array<string, string> $options */
    public function execute(array $options): int
    {
        $source = self::option($options, 'source');
        $out = self::option($options, 'out');
        $artifacts = self::option($options, 'artifacts');
        $version = self::option($options, 'version');
        $rules = RuleSet::fromFile(self::option($options, 'rules'));
        $viewsRoot = $source . '/resources/views';
        if (!is_dir($viewsRoot)) {
            throw new RuntimeException(sprintf('resources/views가 없습니다: %s', $viewsRoot));
        }

        $views = array_values(array_filter(
            FileTree::list($viewsRoot, '.blade.php'),
            static fn (string $path): bool => !self::excluded($path, $rules->excludedViewDirectories),
        ));
        $props = ComponentProps::fromTemplates($rules, self::componentTemplates($viewsRoot), self::componentClasses($source . '/app/View/Components'));
        $upstreamLines = self::upstreamLines($source . '/lang/en.json');
        $transformer = new BladeFileTransformer($rules, $props, $upstreamLines);
        $classifier = new TextClassifier($rules->brands);

        /** @var list<Occurrence> $occurrences */
        $occurrences = [];
        /** @var list<Skip> $skips */
        $skips = [];
        $remaining = [];
        $changed = 0;
        foreach ($views as $relative) {
            $file = 'resources/views/' . $relative;
            $original = FileTree::read($viewsRoot . '/' . $relative);
            array_push($occurrences, ...TranslationCallScanner::scan($original, $file));
            $result = $transformer->transform($original, $file);
            array_push($occurrences, ...$result->occurrences);
            array_push($skips, ...$result->skips);
            array_push($remaining, ...RemainingTextScanner::scan($result->output, $file, $classifier));
            if ($result->changed($original)) {
                $changed++;
                $output = str_starts_with($result->output, self::BLADE_NOTICE) ? $result->output : self::BLADE_NOTICE . $result->output;
                FileTree::write($out . '/' . $file, $output);
            }
        }

        $phpTransformer = new PhpFileTransformer($rules, $upstreamLines);
        $livewireRoot = $source . '/app/Livewire';
        foreach (is_dir($livewireRoot) ? FileTree::list($livewireRoot, '.php') : [] as $relative) {
            $file = 'app/Livewire/' . $relative;
            $original = FileTree::read($livewireRoot . '/' . $relative);
            array_push($occurrences, ...TranslationCallScanner::scan($original, $file));
            $result = $phpTransformer->transform($original, $file);
            array_push($occurrences, ...$result->occurrences);
            array_push($skips, ...$result->skips);
            if ($result->changed($original)) {
                FileTree::write($out . '/' . $file, self::withPhpNotice($result->output));
            }
        }

        $configApp = $source . '/config/app.php';
        if (is_file($configApp)) {
            FileTree::write($out . '/config/app.php', ProviderRegistration::register(FileTree::read($configApp), self::PROVIDER_CLASS));
        }

        CatalogWriter::write($artifacts, $version, $occurrences, $skips, $upstreamLines, ['views' => count($views), 'changedViews' => $changed], $remaining);

        return 0;
    }

    private static function withPhpNotice(string $php): string
    {
        $open = "<?php\n";
        if (str_contains($php, self::PHP_NOTICE) || !str_starts_with($php, $open)) {
            return $php;
        }

        return $open . self::PHP_NOTICE . substr($php, strlen($open));
    }

    /** @param array<string, string> $options */
    private static function option(array $options, string $name): string
    {
        $value = $options[$name] ?? '';
        if ($value === '') {
            throw new RuntimeException(sprintf('--%s 값이 필요합니다.', $name));
        }

        return rtrim($value, '/');
    }

    /** @param list<string> $excluded */
    private static function excluded(string $relative, array $excluded): bool
    {
        foreach ($excluded as $dir) {
            if (str_starts_with($relative, rtrim($dir, '/') . '/')) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string, string> 컴포넌트 이름(점 표기) → 템플릿 */
    private static function componentTemplates(string $viewsRoot): array
    {
        $dir = $viewsRoot . '/components';
        if (!is_dir($dir)) {
            return [];
        }
        $templates = [];
        foreach (FileTree::list($dir, '.blade.php') as $relative) {
            $name = str_replace('/', '.', substr($relative, 0, -strlen('.blade.php')));
            $content = FileTree::read($dir . '/' . $relative);
            $templates[$name] = $content;
            if (str_ends_with($name, '.index')) {
                $templates[substr($name, 0, -strlen('.index'))] ??= $content;
            }
        }

        return $templates;
    }

    /** @return array<string, string> 컴포넌트 이름 → 클래스 원문(Forms/EnvVarInput.php → forms.env-var-input) */
    private static function componentClasses(string $dir): array
    {
        if (!is_dir($dir)) {
            return [];
        }
        $classes = [];
        foreach (FileTree::list($dir, '.php') as $relative) {
            $segments = explode('/', substr($relative, 0, -strlen('.php')));
            $name = implode('.', array_map(static fn (string $s): string => strtolower((string) preg_replace('/(?<!^)[A-Z]/', '-$0', $s)), $segments));
            $classes[$name] = FileTree::read($dir . '/' . $relative);
        }

        return $classes;
    }

    /** @return array<string, string> */
    private static function upstreamLines(string $path): array
    {
        if (!is_file($path)) {
            return [];
        }
        $decoded = json_decode(FileTree::read($path), true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($decoded)) {
            throw new RuntimeException('업스트림 lang/en.json 형식이 잘못되었습니다.');
        }
        $lines = [];
        foreach ($decoded as $key => $value) {
            if (is_string($value)) {
                $lines[(string) $key] = $value;
            }
        }

        return $lines;
    }
}
