<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\ComponentProps;
use CoolifyKo\Codemod\Rules\RuleSet;
use PHPUnit\Framework\TestCase;

/**
 * 4.5.0 프록시·유지보수 도움말: "max {{ \App\Models\Server::PROXY_ERROR_PAGE_MAX_BYTES / 1024 }} KB"처럼 클래스 상수 계산이 든 문장이
 * 자리표시자 값으로 받지 않아 영어로 남았다(2026-10-25). 상수·숫자 계산은 사용자 데이터가 아니라 그대로 치환값으로 옮긴다.
 */
final class ConstantPlaceholderTest extends TestCase
{
    private static function transform(string $source): string
    {
        $rules = new RuleSet(brands: ['Coolify', 'CSS', 'HTML'], components: ['forms.textarea' => ['helper']]);
        $props = ComponentProps::fromTemplates($rules, ['forms.textarea' => "@props(['helper' => null])\n<div>{{ \$helper }}</div>"]);

        return (new BladeFileTransformer($rules, $props))->transform($source, 'views/livewire/x.blade.php')->output;
    }

    public function testMovesClassConstantArithmeticIntoAPlaceholder(): void
    {
        $output = self::transform("<x-forms.textarea id=\"page\" helper=\"One self-contained HTML file (max {{ \App\Models\Server::PROXY_ERROR_PAGE_MAX_BYTES / 1024 }} KB) with inline CSS and images.\" />");

        self::assertStringContainsString(":helper=\"__('One self-contained HTML file (max :value KB) with inline CSS and images.', ['value' => e(\App\Models\Server::PROXY_ERROR_PAGE_MAX_BYTES / 1024)])\"", $output);
        self::assertStringNotContainsString('helper="One self-contained', $output);
    }

    public function testStillLeavesArithmeticOnUnknownCalls(): void
    {
        $source = "<x-forms.textarea id=\"page\" helper=\"Max {{ secret_size() / 1024 }} KB.\" />";

        self::assertSame($source, self::transform($source));
    }
}
