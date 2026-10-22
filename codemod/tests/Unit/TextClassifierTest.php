<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit;

use CoolifyKo\Codemod\Text\SkipReason;
use CoolifyKo\Codemod\Text\TextClassifier;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class TextClassifierTest extends TestCase
{
    private TextClassifier $classifier;

    protected function setUp(): void
    {
        $this->classifier = new TextClassifier(brands: ['Coolify', 'Docker', 'GitHub', 'Traefik']);
    }

    /** @return iterable<string, array{string}> */
    public static function translatable(): iterable
    {
        yield 'single word' => ['General'];
        yield 'sentence' => ['Deploy your application to a server.'];
        yield 'brand inside sentence' => ['Connect your GitHub account'];
        yield 'two brands with words' => ['Use Docker with Traefik proxy'];
        yield 'question with placeholder' => ['Delete :name?'];
        yield 'sentence with path inside' => ['Files are stored in /data/coolify on the server.'];
        yield 'abbreviation word' => ['SSL certificate'];
        yield 'label with default value' => ['Default: 22'];
        yield 'slash between words with spaces' => ['IP Address/Hostname'];
        yield 'show hide with spaces' => ['Show/hide Server-Timing history'];
        yield 'plain lowercase word' => ['running'];
        yield 'lowercase hyphenated word' => ['read-only'];
    }

    #[DataProvider('translatable')]
    public function testTranslatableText(string $text): void
    {
        self::assertNull($this->classifier->skipReason($text));
    }

    /** @return iterable<string, array{string, SkipReason}> */
    public static function skipped(): iterable
    {
        yield 'empty' => ['   ', SkipReason::Empty];
        yield 'punctuation' => ['— • |', SkipReason::NoLetters];
        yield 'number' => ['404', SkipReason::NoLetters];
        yield 'brand only' => ['Coolify', SkipReason::BrandOnly];
        yield 'brands with separators' => ['GitHub / Docker', SkipReason::BrandOnly];
        yield 'absolute path' => ['/data/coolify/source', SkipReason::Technical];
        yield 'home path' => ['~/.docker/config.json', SkipReason::Technical];
        yield 'url' => ['https://coolify.io/docs', SkipReason::Technical];
        yield 'hostname' => ['app.example.com', SkipReason::Technical];
        yield 'env name' => ['APP_ENV', SkipReason::Technical];
        yield 'key value' => ['KEY=value', SkipReason::Technical];
        yield 'cron' => ['0 0 * * *', SkipReason::Technical];
        yield 'version' => ['v4.4.6', SkipReason::Technical];
        yield 'shell command' => ['docker compose up -d', SkipReason::Technical];
        yield 'artisan command' => ['php artisan cleanup:redis --clear-locks', SkipReason::Technical];
        yield 'filename' => ['docker-compose.yml', SkipReason::Technical];
        yield 'ip and port' => ['127.0.0.1:8000', SkipReason::Technical];
        yield 'pem header' => ['-----BEGIN OPENSSH PRIVATE KEY-----', SkipReason::Technical];
        yield 'cli flags' => ['--cap-add SYS_ADMIN --device=/dev/fuse', SkipReason::Technical];
        yield 'ipv6' => ['2001:db8::1', SkipReason::Technical];
        yield 'hex hash' => ['59e02939b1bf39f16c93138a28727aec', SkipReason::Technical];
        yield 'image path' => ['ghcr.io/your-org/your-app', SkipReason::Technical];
        yield 'slug path' => ['my-app/production', SkipReason::Technical];
        yield 'ssh git url' => ['git@github.com:owner/repository.git', SkipReason::Technical];
        yield 'host and cidr list' => ['hooks.company.local, 10.50.0.0/16', SkipReason::Technical];
        yield 'config example lines' => ["# maxmemory 256mb\n# maxmemory-policy allkeys-lru\n# timeout 300", SkipReason::Technical];
        yield 'yaml example lines' => ["placement:\n    constraints:\n        - 'node.role == worker'", SkipReason::Technical];
        yield 'php variable fragment' => ['$isFullWidth])>', SkipReason::Technical];
        yield 'php variable inside words' => ['Uses $config value', SkipReason::Technical];
        yield 'css class token' => ['text-red-500', SkipReason::Technical];
        yield 'tailwind variant' => ['lg:hidden', SkipReason::Technical];
        yield 'snake identifier' => ['deployment_success', SkipReason::Technical];
    }

    #[DataProvider('skipped')]
    public function testSkippedText(string $text, SkipReason $reason): void
    {
        self::assertSame($reason, $this->classifier->skipReason($text));
    }
}
