<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\ComponentProps;
use CoolifyKo\Codemod\Rules\RuleSet;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** 실제 규칙 파일(rules/coolify.php)로 4.4.6 템플릿 발췌를 바꿔 본다. */
final class RulesFileTest extends TestCase
{
    /** 4.4.6 컴포넌트 템플릿에서 해당 속성이 쓰이는 줄만 옮겼다. */
    private const TEMPLATES = [
        'status-badge' => "@props(['label' => null, 'status' => null, 'type' => 'neutral'])\n"
            . "<span class=\"truncate\">{{ collect([\$label, \$status])->filter()->join(' ') }}</span>",
        'forms.domain-input' => "@props(['id', 'hostLabel' => 'Domain', 'hostPlaceholder' => 'app.example.com'])\n"
            . "<label>{{ \$hostLabel }}</label>\n<input id=\"{{ \$id }}-host\" placeholder=\"{{ \$hostPlaceholder }}\" />",
        'modal-confirmation' => "@props(['step2ButtonText' => 'Continue'])\n"
            . "@php \$effective = (\$skip && \$step2ButtonText === 'Continue') ? 'Confirm' : \$step2ButtonText; @endphp\n"
            . "<div x-data=\"{ step2ButtonText: @js(\$effective) }\"></div>",
        'forms.button' => "@props(['tooltip' => null])\n<button {{ \$attributes->merge(['class' => 'button', 'type' => 'button']) }}>{{ \$slot }}</button>",
        'notification.event-multiselect' => "@props(['id', 'label', 'events' => []])\n"
            . "@php \$selectedLabels = collect(\$events)->where('enabled', true)->pluck('label')->implode(', '); @endphp\n"
            . "<label for=\"{{ \$id }}-trigger\">{{ \$label }}</label>\n@foreach (\$events as \$event)<span>{{ \$event['label'] }}</span>@endforeach",
    ];

    private static function transform(string $source): string
    {
        $rules = RuleSet::fromFile(__DIR__ . '/../../rules/coolify.php');
        $props = ComponentProps::fromTemplates($rules, self::TEMPLATES);

        return (new BladeFileTransformer($rules, $props))->transform($source, 'resources/views/livewire/x.blade.php')->output;
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'status badge status' => [
            '<x-status-badge status="Experimental" type="warning" />',
            "<x-status-badge :status=\"__('Experimental')\" type=\"warning\" />",
        ];
        yield 'bound status badge status' => [
            "<x-status-badge :status=\"\$ok ? 'Valid' : 'Expired'\" />",
            "<x-status-badge :status=\"\$ok ? __('Valid') : __('Expired')\" />",
        ];
        yield 'domain input host placeholder' => [
            '<x-forms.domain-input id="endpoint" host-placeholder="minio.internal or 192.168.1.50" />',
            "<x-forms.domain-input id=\"endpoint\" :host-placeholder=\"__('minio.internal or 192.168.1.50')\" />",
        ];
        yield 'step 2 button text' => [
            '<x-modal-confirmation step2ButtonText="Permanently Delete" />',
            "<x-modal-confirmation :step2ButtonText=\"__('Permanently Delete')\" />",
        ];
        yield 'notification event rows' => [
            "<x-notification.event-multiselect id=\"e\" label=\"Backups\" :events=\"[['property' => 'backupFailureEmailNotifications', 'label' => 'Backup failure', 'enabled' => \$on]]\" />",
            "<x-notification.event-multiselect id=\"e\" :label=\"__('Backups')\" :events=\"[['property' => 'backupFailureEmailNotifications', 'label' => __('Backup failure'), 'enabled' => \$on]]\" />",
        ];
        yield 'button aria label with an echo' => [
            "<x-forms.button type=\"button\" aria-label=\"Generate {{ \$provider['name'] }} webhook secret\">Generate</x-forms.button>",
            "<x-forms.button type=\"button\" :aria-label=\"__('Generate :name webhook secret', ['name' => e(\$provider['name'])])\">{{ __('Generate') }}</x-forms.button>",
        ];
        yield 'step 2 button text compared in the template stays' => [
            '<x-modal-confirmation step2ButtonText="Continue" />',
            '<x-modal-confirmation step2ButtonText="Continue" />',
        ];
    }

    #[DataProvider('conversions')]
    public function testConvertsWithProjectRules(string $source, string $expected): void
    {
        self::assertSame($expected, self::transform($source));
    }
}
