<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Php;

use CoolifyKo\Codemod\Php\ProviderRegistration;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class ProviderRegistrationTest extends TestCase
{
    private const CONFIG = "<?php\n\nreturn [\n    'locale' => 'en',\n    'providers' => [\n        AppServiceProvider::class,\n        ConfigurationServiceProvider::class,\n    ],\n    'aliases' => [],\n];\n";

    public function testAppendsProviderAfterLastEntry(): void
    {
        self::assertSame(
            "<?php\n\nreturn [\n    'locale' => 'en',\n    'providers' => [\n        AppServiceProvider::class,\n        ConfigurationServiceProvider::class,\n        \\App\\Providers\\CoolifyKoServiceProvider::class,\n    ],\n    'aliases' => [],\n];\n",
            ProviderRegistration::register(self::CONFIG, 'App\\Providers\\CoolifyKoServiceProvider'),
        );
    }

    public function testIsIdempotent(): void
    {
        $once = ProviderRegistration::register(self::CONFIG, 'App\\Providers\\CoolifyKoServiceProvider');

        self::assertSame($once, ProviderRegistration::register($once, 'App\\Providers\\CoolifyKoServiceProvider'));
    }

    public function testFailsLoudlyWhenProvidersArrayIsMissing(): void
    {
        $this->expectException(RuntimeException::class);

        ProviderRegistration::register("<?php return ['locale' => 'en'];", 'App\\Providers\\CoolifyKoServiceProvider');
    }
}
