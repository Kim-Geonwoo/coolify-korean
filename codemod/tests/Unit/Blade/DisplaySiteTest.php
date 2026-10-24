<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\ComponentProps;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\SkipReason;
use PHPUnit\Framework\TestCase;

final class DisplaySiteTest extends TestCase
{
    /** @param list<string> $translatableProps 규칙 파일의 컴포넌트 속성 후보 */
    private static function transform(string $source, string $path = 'views/livewire/x.blade.php', string $component = '', array $translatableProps = []): TransformResult
    {
        $rules = new RuleSet(brands: ['Coolify'], components: $component === '' ? [] : [$component => $translatableProps]);
        $props = $component === '' ? ComponentProps::none() : ComponentProps::fromTemplates($rules, [$component => $source]);

        return (new BladeFileTransformer($rules, $props))->transform($source, $path);
    }

    /** @return list<string> */
    private static function keys(TransformResult $result, string $kind): array
    {
        return array_values(array_map(static fn ($o) => $o->key, array_filter($result->occurrences, static fn ($o) => $o->kind === $kind)));
    }

    public function testWrapsLabelsOfLiteralMenuAtDisplaySiteOnly(): void
    {
        $source = "@php\n\$items = [\n    ['label' => 'General', 'route' => 'settings.index', 'active' => \$menu === 'general'],\n    ['label' => 'Danger Zone', 'icon' => 'x'],\n];\n@endphp\n"
            . "@foreach (\$items as \$item)\n<a wire:key=\"{{ str(\$item['label'])->slug() }}\"><span>{{ \$item['label'] }}</span></a>\n@endforeach";
        $result = self::transform($source);

        self::assertStringContainsString("<span>{{ coolify_ko_t(\$item['label']) }}</span>", $result->output);
        self::assertStringContainsString("wire:key=\"{{ str(\$item['label'])->slug() }}\"", $result->output);
        self::assertStringContainsString("['label' => 'General', 'route' => 'settings.index'", $result->output);
        self::assertSame(['General', 'Danger Zone'], self::keys($result, 'display'));
    }

    public function testFollowsCollectionPipelinesNestedLoopsAndGroupKeys(): void
    {
        $source = "@php\n\$menu = [\n    ['label' => 'General', 'group' => 'Settings', 'visible' => \$a],\n"
            . "    ['label' => \$wide ? 'Danger' : 'Danger zone', 'group' => 'Danger', 'children' => [['label' => 'Delete']]],\n];\n"
            . "\$menu = collect(\$menu)->filter(fn (array \$item): bool => \$item['visible'] ?? true)->values();\n"
            . "\$grouped = \$menu->groupBy('group');\n@endphp\n"
            . "@foreach (\$grouped as \$groupLabel => \$groupItems)\n<h3>{{ \$groupLabel }}</h3>\n"
            . "@foreach (\$groupItems as \$menuItem)\n<span>{{ \$menuItem['label'] }}</span>\n"
            . "@foreach (collect(\$menuItem['children'] ?? [])->filter(fn (\$child) => \$child['visible'] ?? true) as \$child)\n<i>{{ \$child['label'] }}</i>\n@endforeach\n@endforeach\n@endforeach";
        $result = self::transform($source);

        self::assertStringContainsString('<h3>{{ coolify_ko_t($groupLabel) }}</h3>', $result->output);
        self::assertStringContainsString("<span>{{ coolify_ko_t(\$menuItem['label']) }}</span>", $result->output);
        self::assertStringContainsString("<i>{{ coolify_ko_t(\$child['label']) }}</i>", $result->output);
        self::assertSame(['General', 'Settings', 'Danger', 'Danger zone', 'Delete'], self::keys($result, 'display'));
    }

    public function testConditionsAndCallbacksDoNotTaintLiteralMenus(): void
    {
        $source = "@php\n\$items = match (\$section) {\n    'team' => [['label' => 'General', 'route' => route('team', [\$team->uuid]), 'active' => request()->routeIs('team.*')]],\n    default => [],\n};\n"
            . "\$items = array_values(array_filter(\$items, fn (array \$item): bool => (\$item['visible'] ?? true) && \$user->can('view')));\n@endphp\n"
            . "@foreach (\$items as \$item)<a>{{ \$item['label'] }}</a>@endforeach\n"
            . "@foreach ([['label' => 'Light', 'value' => 'light']] as \$option)<b>{{ \$option['label'] }}</b>@endforeach";
        $result = self::transform($source);

        self::assertStringContainsString("<a>{{ coolify_ko_t(\$item['label']) }}</a>", $result->output);
        self::assertStringContainsString("<b>{{ coolify_ko_t(\$option['label']) }}</b>", $result->output);
        self::assertSame(['General', 'Light'], self::keys($result, 'display'));
    }

    // 4.5.0 navbar: 섹션 이름 → 항목 목록을 블록 클로저가 [...$item, 'children' => …]로 다시 만들고, flatten(1)로 하위 메뉴를 모은다.
    // 4.5.0 판에서 이 흐름을 놓쳐 사이드바 전체가 영어로 나왔다(2026-10-25). 메뉴 전환 비교(@js·data-active-submenu)는 영어로 둔다
    public function testFollowsSectionedMenusThroughBlockClosuresSpreadsAndFlatten(): void
    {
        $source = "@php\n\$navSections = collect([\n"
            . "    'Workspace' => [\n"
            . "        ['label' => 'Dashboard', 'href' => '/', 'active' => request()->is('/')],\n"
            . "        ['label' => 'Monitoring', 'icon' => 'graph', 'children' => [\n"
            . "            ['label' => 'Analytics', 'href' => route('analytics'), 'active' => request()->is('analytics')],\n"
            . "        ]],\n"
            . "    ],\n"
            . "    'Manage' => [\n"
            . "        ['label' => 'Settings', 'visible' => isInstanceAdmin(), 'children' => [\n"
            . "            ['label' => 'General', 'href' => route('settings.index'), 'active' => request()->is('settings')],\n"
            . "        ]],\n"
            . "    ],\n"
            . "])->map(fn (array \$items) => collect(\$items)\n"
            . "    ->filter(fn (array \$item): bool => (bool) (\$item['visible'] ?? true))\n"
            . "    ->map(function (array \$item): array {\n"
            . "        if (! isset(\$item['children'])) {\n"
            . "            return \$item;\n"
            . "        }\n"
            . "        \$children = array_values(array_filter(\$item['children'], fn (array \$child): bool => (bool) (\$child['visible'] ?? true)));\n\n"
            . "        return [...\$item, 'children' => \$children, 'href' => \$children[0]['href'], 'active' => collect(\$children)->contains('active', true)];\n"
            . "    })\n"
            . "    ->all());\n"
            . "\$activeSubmenu = \$navSections->flatten(1)->first(fn (array \$item): bool => isset(\$item['children']) && \$item['active']);\n"
            . "@endphp\n"
            . "@php\n\$renderedSubmenus = \$navSections->flatten(1)->filter(fn (array \$item): bool => isset(\$item['children']));\n@endphp\n"
            . "@foreach (\$renderedSubmenus as \$submenuItem)\n"
            . "<li x-show=\"submenu === @js(\$submenuItem['label'])\" data-active-submenu=\"{{ \$submenuItem['label'] }}\"><span>{{ \$submenuItem['label'] }}</span>\n"
            . "@foreach (\$submenuItem['children'] as \$child)\n<a title=\"{{ \$child['label'] }}\"><span>{{ \$child['label'] }}</span></a>\n@endforeach\n</li>\n@endforeach\n"
            . "@foreach (\$navSections as \$sectionLabel => \$sectionItems)\n<li>{{ \$sectionLabel }}</li>\n"
            . "@foreach (\$sectionItems as \$item)\n<button @click=\"submenu = @js(\$item['label'])\" title=\"{{ \$item['label'] }}\"><span>{{ \$item['label'] }}</span></button>\n@endforeach\n@endforeach";
        $rules = new RuleSet(brands: ['Coolify'], htmlAttributes: ['title', 'aria-label']);
        $result = (new BladeFileTransformer($rules, ComponentProps::none()))->transform($source, 'views/components/navbar.blade.php');

        self::assertStringContainsString('<li>{{ coolify_ko_t($sectionLabel) }}</li>', $result->output);
        self::assertStringContainsString("title=\"{{ coolify_ko_t(\$item['label']) }}\"><span>{{ coolify_ko_t(\$item['label']) }}</span>", $result->output);
        self::assertStringContainsString("<span>{{ coolify_ko_t(\$submenuItem['label']) }}</span>", $result->output);
        self::assertStringContainsString("<a title=\"{{ coolify_ko_t(\$child['label']) }}\"><span>{{ coolify_ko_t(\$child['label']) }}</span></a>", $result->output);
        self::assertStringContainsString("x-show=\"submenu === @js(\$submenuItem['label'])\" data-active-submenu=\"{{ \$submenuItem['label'] }}\"", $result->output);
        self::assertStringContainsString("@click=\"submenu = @js(\$item['label'])\"", $result->output);
        self::assertEqualsCanonicalizing(['Workspace', 'Dashboard', 'Monitoring', 'Analytics', 'Manage', 'Settings', 'General'], self::keys($result, 'display'));
    }

    // 4.5.0 메트릭 빈 화면 단추: 삼항 가지마다 문자열을 이어 붙인 echo가 영어로 남았다(2026-10-25). 결과 자리 이어 붙이기는 자리표시자 문장으로
    public function testTurnsConcatenatedEchoBranchesIntoPlaceholderSentences(): void
    {
        $source = "<x-forms.button wire:click=\"enableMetrics\">\n    {{ count(\$servers) === 1\n        ? 'Enable metrics on '.\\Illuminate\\Support\\Str::limit(\$servers[0], 24)\n"
            . "        : 'Enable metrics on '.count(\$servers).' servers' }}\n</x-forms.button>\n<p>{{ 'build-' . \$hash }}</p>";
        $result = self::transform($source);

        self::assertStringContainsString("{{ count(\$servers) === 1\n        ? __('Enable metrics on :servers', ['servers' => \\Illuminate\\Support\\Str::limit(\$servers[0], 24)])", $result->output);
        self::assertStringContainsString(": __('Enable metrics on :count servers', ['count' => count(\$servers)]) }}", $result->output);
        self::assertStringContainsString("<p>{{ 'build-' . \$hash }}</p>", $result->output);
        self::assertSame(['Enable metrics on :servers', 'Enable metrics on :count servers'], self::keys($result, 'echo-literal'));
    }

    public function testBlockClosureLocalsFromOtherDataStillTaintMenus(): void
    {
        $source = "@php\n\$menu = [['label' => 'General', 'children' => [['label' => 'Email']]]];\n"
            . "\$renamed = collect(\$menu)->map(function (array \$item) use (\$server): array {\n    \$item['label'] = \$server->name;\n\n    return \$item;\n});\n"
            . "\$borrowed = collect(\$menu)->map(function (array \$item) use (\$server): array {\n    \$children = \$server->menu;\n\n    return [...\$item, 'children' => \$children];\n});\n@endphp\n"
            . "@foreach (\$renamed as \$a)<a>{{ \$a['label'] }}</a>@endforeach\n"
            . "@foreach (\$borrowed as \$b)<b>{{ \$b['label'] }}</b>@endforeach";
        $result = self::transform($source);

        self::assertStringContainsString("<a>{{ \$a['label'] }}</a>", $result->output);
        self::assertStringContainsString("<b>{{ \$b['label'] }}</b>", $result->output);
    }

    public function testFollowsMappingCallbacksAndEmptyCollections(): void
    {
        $source = "@php\n\$menu = [['label' => 'General', 'route' => 'a'], ['label' => 'Webhooks', 'route' => 'b']];\n"
            . "\$groups = ['Settings' => ['General'], 'Automation' => ['Webhooks']];\n"
            . "\$grouped = collect(\$groups)->map(fn (array \$labels) => collect(\$labels)->map(fn (string \$label) => collect(\$menu)->firstWhere('label', \$label))->filter()->values())->filter(fn (\$items) => \$items->isNotEmpty());\n"
            . "\$pages = \$canUse ? collect([['label' => 'Dashboard']])->filter() : collect();\n"
            . "\$leaked = collect(\$groups)->map(fn (array \$labels) => \$server->menu);\n"
            . "\$menu = collect(\$menu)->map(fn (array \$item): array => [...\$item, 'active' => \$route === \$item['route']]);\n"
            . "\$spreadUser = [...\$userItems, ['label' => 'Extra']];\n@endphp\n"
            . "@foreach (\$menu as \$m)<s>{{ \$m['label'] }}</s>@endforeach\n"
            . "@foreach (\$spreadUser as \$u)<u>{{ \$u['label'] }}</u>@endforeach\n"
            . "@foreach (\$grouped as \$name => \$items)@foreach (\$items as \$item)<a>{{ \$item['label'] }}</a>@endforeach@endforeach\n"
            . "@foreach (\$pages as \$page)<b>{{ \$page['label'] }}</b>@endforeach\n"
            . "@foreach (\$leaked as \$l)<i>{{ \$l['label'] }}</i>@endforeach";
        $result = self::transform($source);

        self::assertStringContainsString("<a>{{ coolify_ko_t(\$item['label']) }}</a>", $result->output);
        self::assertStringContainsString("<b>{{ coolify_ko_t(\$page['label']) }}</b>", $result->output);
        self::assertStringContainsString("<i>{{ \$l['label'] }}</i>", $result->output);
        self::assertStringContainsString("<s>{{ coolify_ko_t(\$m['label']) }}</s>", $result->output);
        self::assertStringContainsString("<u>{{ \$u['label'] }}</u>", $result->output);
        self::assertSame(['General', 'Webhooks', 'Dashboard'], self::keys($result, 'display'));
    }

    public function testWrapsLiteralScalarVariablesOnlyWhereTheyAreShown(): void
    {
        $source = "@php\n\$context = match (true) {\n    request()->routeIs('server.*') => 'Servers',\n    request()->routeIs('team.*') => 'Team',\n    default => null,\n};\n"
            . "[\$statusLabel, \$statusType] = match (true) {\n    \$broken => ['Attention required', 'warning'],\n    default => ['Ready', 'success'],\n};\n"
            . "\$userName = \$user->name;\n\$title = 'Overview';\n\$title = \$page->title;\n@endphp\n"
            . "<b>{{ \$context }}</b><i>{{ \$statusLabel }}</i><u>{{ \$userName }}</u><s>{{ \$title }}</s>\n"
            . "@if (\$context === 'Servers') 1 @endif";
        $result = self::transform($source);

        self::assertStringContainsString('<b>{{ coolify_ko_t($context) }}</b>', $result->output);
        self::assertStringContainsString('<i>{{ coolify_ko_t($statusLabel) }}</i>', $result->output);
        self::assertStringContainsString('<u>{{ $userName }}</u>', $result->output);
        self::assertStringContainsString('<s>{{ $title }}</s>', $result->output);
        self::assertStringContainsString("@if (\$context === 'Servers') 1 @endif", $result->output);
        self::assertSame(['Servers', 'Team', 'Attention required', 'Ready'], self::keys($result, 'display'));
    }

    public function testWrapsLiteralArrayKeysAndPassesThemToTextProps(): void
    {
        $rules = new RuleSet(brands: ['Coolify'], components: ['event-list' => ['label']]);
        $props = ComponentProps::fromTemplates($rules, [
            'event-list' => "@props(['label' => null, 'events' => []])\n<h4>{{ \$label }}</h4>",
        ]);
        $source = "@php\n\$eventGroups = [\n    'Deployments' => [['key' => 'deploy_ok', 'label' => 'Deployment success']],\n    'Backups' => [['key' => 'backup_ok', 'label' => 'Backup success']],\n];\n@endphp\n"
            . "@foreach (\$eventGroups as \$group => \$events)\n<h3>{{ \$group }}</h3>\n<x-event-list :label=\"\$group\" :events=\"\$events\" />\n<x-event-list :label=\"\$server->name\" />\n@endforeach";
        $result = (new BladeFileTransformer($rules, $props))->transform($source, 'views/livewire/x.blade.php');

        self::assertStringContainsString('<h3>{{ coolify_ko_t($group) }}</h3>', $result->output);
        self::assertStringContainsString('<x-event-list :label="coolify_ko_t($group)" :events="$events" />', $result->output);
        self::assertStringContainsString('<x-event-list :label="$server->name" />', $result->output);
        self::assertSame(['Deployments', 'Backups'], self::keys($result, 'display'));
        self::assertCount(1, array_filter($result->occurrences, static fn ($o) => $o->kind === 'prop-display'));
    }

    public function testFollowsGroupKeysThroughKeyPreservingChains(): void
    {
        $source = "@php\n\$menu = [['label' => 'General', 'route' => 'a'], ['label' => 'Webhooks', 'route' => 'b']];\n"
            . "\$groups = ['Settings' => ['General'], 'Automation' => ['Webhooks']];\n"
            . "\$grouped = collect(\$groups)->map(fn (array \$labels) => collect(\$labels)->map(fn (string \$label) => collect(\$menu)->firstWhere('label', \$label))->filter()->values())->filter(fn (\$items) => \$items->isNotEmpty());\n"
            . "\$listed = collect(\$groups)->values();\n"
            . "\$teamGroups = collect(\$teams)->map(fn (\$team) => []);\n@endphp\n"
            . "@foreach (\$grouped as \$groupLabel => \$groupItems)\n<button @click=\"toggle(@js(\$groupLabel))\"><span>{{ \$groupLabel }}</span></button>\n@endforeach\n"
            . "@foreach (\$listed as \$index => \$x)<i>{{ \$index }}</i>@endforeach\n"
            . "@foreach (\$teamGroups as \$name => \$y)<b>{{ \$name }}</b>@endforeach";
        $result = self::transform($source);

        self::assertStringContainsString('<span>{{ coolify_ko_t($groupLabel) }}</span>', $result->output);
        self::assertStringContainsString('@click="toggle(@js($groupLabel))"', $result->output);
        self::assertStringContainsString('<i>{{ $index }}</i>', $result->output);
        self::assertStringContainsString('<b>{{ $name }}</b>', $result->output);
        self::assertSame(['Settings', 'Automation'], self::keys($result, 'display'));
    }

    public function testWrapsLabelVariablesEchoedAsWholeAttributeValues(): void
    {
        $rules = new RuleSet(brands: ['Coolify'], htmlAttributes: ['title', 'data-tooltip', 'aria-label']);
        $source = "@php\n\$directionLabel = match (\$direction) { 'www' => 'Redirect to www', default => 'Both www and non-www' };\n\$serverName = \$server->name;\n@endphp\n"
            . "<div class=\"detail\" title=\"{{ \$directionLabel }}\" data-tooltip=\"{{ \$serverName }}\" data-label=\"{{ \$directionLabel }}\" {{ \$attributes }}></div>\n"
            . "<span aria-label=\" {{ \$directionLabel }} \"></span>";
        $result = (new BladeFileTransformer($rules, ComponentProps::none()))->transform($source, 'views/livewire/x.blade.php');

        self::assertStringContainsString('title="{{ coolify_ko_t($directionLabel) }}"', $result->output);
        self::assertStringContainsString('aria-label=" {{ coolify_ko_t($directionLabel) }} "', $result->output);
        self::assertStringContainsString('data-tooltip="{{ $serverName }}"', $result->output);
        self::assertStringContainsString('data-label="{{ $directionLabel }}"', $result->output);
        self::assertSame(['Redirect to www', 'Both www and non-www'], self::keys($result, 'display'));
        self::assertCount(2, array_filter($result->occurrences, static fn ($o) => $o->kind === 'display-site'));
    }

    public function testFollowsLabelsCopiedIntoNewRowsAndGroups(): void
    {
        $source = "@php\n\$eventGroups = [\n    'Deployments' => [['key' => 'deploymentSuccess', 'label' => 'Deployment success']],\n    'Backups' => [['key' => 'backupFailure', 'label' => 'Backup failure', 'helper' => 'Notify.']],\n];\n"
            . "\$rows = [];\nif (\$threaded) {\n    foreach (\$eventGroups as \$group => \$events) {\n        foreach (\$events as \$event) {\n            if (! \$on) {\n                continue;\n            }\n"
            . "            \$rows[] = ['group' => \$group, 'key' => \$event['key'], 'label' => \$event['label'], 'model' => Str::camel(\$event['key'])];\n        }\n    }\n    \$byGroup = collect(\$rows)->groupBy('group');\n}\n"
            . "\$userRows = collect(\$users)->map(fn (\$user) => ['label' => \$user['label']]);\n"
            . "\$mixed = [];\n\$mixed[] = ['label' => \$event['label'], 'group' => \$server->name];\n\$mixedByGroup = collect(\$mixed)->groupBy('group');\n@endphp\n"
            . "@foreach (\$byGroup as \$group => \$events)<h3>{{ \$group }}</h3>@foreach (\$events as \$event)<p>{{ \$event['label'] }}</p>@endforeach@endforeach\n"
            . "@foreach (\$userRows as \$row)<b>{{ \$row['label'] }}</b>@endforeach\n"
            . "@foreach (\$mixedByGroup as \$name => \$items)<i>{{ \$name }}</i>@endforeach";
        $result = self::transform($source);

        self::assertStringContainsString('<h3>{{ coolify_ko_t($group) }}</h3>', $result->output);
        self::assertStringContainsString("<p>{{ coolify_ko_t(\$event['label']) }}</p>", $result->output);
        self::assertStringContainsString("<b>{{ \$row['label'] }}</b>", $result->output);
        self::assertStringContainsString('<i>{{ $name }}</i>', $result->output);
        self::assertSame(['Deployment success', 'Backup failure', 'Deployments', 'Backups'], self::keys($result, 'display'));
    }

    public function testWrapsCopiedLabelsPassedOnlyToDisplayArrayProps(): void
    {
        $rules = new RuleSet(brands: ['Coolify'], componentArrayProps: ['event-list' => ['events' => ['label']]]);
        $source = "@php\n\$eventGroups = ['Deployments' => [['key' => 'deploy', 'label' => 'Deployment success']]];\n@endphp\n"
            . "@foreach (\$eventGroups as \$group => \$events)\n@php\n"
            . "    \$listed = collect(\$events)\n        ->map(fn (\$event) => [\n            'property' => \$event['key'] . 'Notifications',\n            'label' => \$event['label'],\n            'enabled' => (bool) data_get(\$settings, \$event['key']),\n        ])\n        ->all();\n"
            . "    \$shared = collect(\$events)->map(fn (\$event) => ['property' => 'p', 'label' => \$event['label']])->all();\n"
            . "    \$fromUsers = collect(\$users)->map(fn (\$user) => ['property' => 'p', 'label' => \$user['label']])->all();\n@endphp\n"
            . "<x-event-list :events=\"\$listed\" />\n<x-event-list :events=\"\$shared\" />\n<x-event-list :events=\"\$fromUsers\" />\n"
            . "@if (\$shared[0]['label'] === 'Deployment success') 1 @endif\n@endforeach\n"
            . "<x-event-list :events=\"[['property' => 'p', 'label' => 'Inline label', 'enabled' => \$on]]\" />";
        $result = (new BladeFileTransformer($rules, ComponentProps::fromTemplates($rules, [])))->transform($source, 'views/livewire/x.blade.php');

        self::assertStringContainsString("'label' => coolify_ko_t(\$event['label']),\n", $result->output);
        self::assertStringContainsString("\$shared = collect(\$events)->map(fn (\$event) => ['property' => 'p', 'label' => \$event['label']])->all();", $result->output);
        self::assertStringContainsString("['property' => 'p', 'label' => \$user['label']]", $result->output);
        self::assertStringContainsString("'label' => __('Inline label')", $result->output);
        self::assertSame(['Deployment success'], self::keys($result, 'display'));
        self::assertCount(1, array_filter($result->occurrences, static fn ($o) => $o->kind === 'prop-display'));
    }

    public function testWrapsLabelValuesUsedAsPlaceholdersOfConcatenatedProps(): void
    {
        $rules = new RuleSet(brands: ['Coolify'], components: ['forms.input' => ['ariaLabel']]);
        $props = ComponentProps::fromTemplates($rules, ['forms.input' => "@props(['label' => null, 'id' => null])\n<label>{{ \$label }}</label><input {{ \$attributes->merge(['class' => 'input']) }}>"]);
        $source = "@php\n\$events = [['key' => 'a', 'label' => 'Backup failure']];\n@endphp\n"
            . "@foreach (\$events as \$event)\n<x-forms.input :aria-label=\"\$event['label'] . ' topic ID'\" />\n<x-forms.input :aria-label=\"\$server->name . ' topic ID'\" />\n@endforeach";
        $result = (new BladeFileTransformer($rules, $props))->transform($source, 'views/livewire/x.blade.php');

        self::assertStringContainsString("<x-forms.input :aria-label=\"__(':label topic ID', ['label' => coolify_ko_t(\$event['label'])])\" />", $result->output);
        self::assertStringContainsString("<x-forms.input :aria-label=\"__(':name topic ID', ['name' => \$server->name])\" />", $result->output);
        self::assertSame(['Backup failure'], self::keys($result, 'display'));
    }

    public function testWrapsTemplateLabelsMovedIntoSentencePlaceholders(): void
    {
        $rules = new RuleSet(brands: ['Coolify'], components: ['danger-zone' => ['title'], 'popup' => ['description']]);
        $props = ComponentProps::fromTemplates($rules, [
            'danger-zone' => "@props(['title' => null])\n<h3>{{ \$title }}</h3>",
            'popup' => "@props(['description' => null])\n<p>{!! \$description !!}</p>",
        ]);
        $source = "@php\n\$resourceLabel = match (\$resource?->type()) {\n    'application' => 'application',\n    'service-database' => 'service database',\n    default => 'resource',\n};\n@endphp\n"
            . "<x-danger-zone title=\"Delete {{ \$resourceLabel }}\">\n<li>This {{ \$resourceLabel }} cannot be restored from {{ \$server->name }}.</li>\n"
            . "<p>Permanently delete <strong>{{ \$resourceName }}</strong> and this {{ \$resourceLabel }}.</p>\n</x-danger-zone>\n"
            . "<x-popup description=\"Removes the {{ \$resourceLabel }}.\" />\n<li>Owned by {{ \$owner }}.</li>";
        $result = (new BladeFileTransformer($rules, $props))->transform($source, 'views/livewire/x.blade.php');

        self::assertStringContainsString(":title=\"__('Delete :resource_label', ['resource_label' => e(coolify_ko_t(\$resourceLabel))])\"", $result->output);
        self::assertStringContainsString("{{ __('This :resource_label cannot be restored from :name.', ['resource_label' => coolify_ko_t(\$resourceLabel), 'name' => \$server->name]) }}", $result->output);
        self::assertStringContainsString("['resource_name' => \$resourceName, 'resource_label' => coolify_ko_t(\$resourceLabel)]", $result->output);
        self::assertStringContainsString(":description=\"(string) __h('Removes the :resource_label.', [], ['resource_label' => coolify_ko_t(\$resourceLabel)])\"", $result->output);
        self::assertStringContainsString("{{ __('Owned by :owner.', ['owner' => \$owner]) }}", $result->output);
        self::assertSame(['application', 'service database', 'resource'], self::keys($result, 'display'));
    }

    public function testWrapsCodeValueLabelsListedInRulesAtDisplaySites(): void
    {
        $rules = new RuleSet(brands: ['Coolify'], displayExpressions: [
            'livewire.server.resources' => ['str($resource->type())->headline()' => ['Application', 'Standalone Mysql']],
        ]);
        $source = "<div>{{ str(\$resource->type())->headline() }}</div>\n<div>{{ str(\$resource->name)->headline() }}</div>\n<p>Type: {{ str(\$resource->type())->headline() }}</p>";
        $transformer = new BladeFileTransformer($rules, ComponentProps::none());
        $result = $transformer->transform($source, 'resources/views/livewire/server/resources.blade.php');
        $elsewhere = $transformer->transform($source, 'resources/views/livewire/server/other.blade.php');

        self::assertStringContainsString('<div>{{ coolify_ko_t(str($resource->type())->headline()) }}</div>', $result->output);
        self::assertStringContainsString('<div>{{ str($resource->name)->headline() }}</div>', $result->output);
        self::assertStringContainsString("<p>{{ __('Type: :type', ['type' => coolify_ko_t(str(\$resource->type())->headline())]) }}</p>", $result->output);
        self::assertSame(['Application', 'Standalone Mysql'], self::keys($result, 'display'));
        self::assertStringNotContainsString('coolify_ko_t', $elsewhere->output);
    }

    public function testEchoBesideMarkupOnlyOpaqueElementIsStillShownAlone(): void
    {
        $rules = new RuleSet(brands: ['Coolify'], displayExpressions: ['components.editor' => ['str($type)->headline()' => ['Server', 'Team']]]);
        $source = "<span class=\"type\">{{ str(\$type)->headline() }}</span>\n<span class=\"font-mono\" title=\"{{ \$env->value }}\">{{ \$env->value }}</span>\n<span>-</span>";
        $result = (new BladeFileTransformer($rules, ComponentProps::none()))->transform($source, 'resources/views/components/editor.blade.php');

        self::assertStringContainsString('<span class="type">{{ coolify_ko_t(str($type)->headline()) }}</span>', $result->output);
        self::assertSame(['Server', 'Team'], self::keys($result, 'display'));
    }

    public function testLeavesLabelsFromCallsAndPropertiesInValuePositions(): void
    {
        $source = "@php\n\$fromCall = [['label' => 'General'], getExtraItems()];\n\$fromProperty = [['label' => 'General', 'children' => \$server->menu]];\n\$fromThis = array_merge([['label' => 'General']], \$this->items);\n@endphp\n"
            . "@foreach (\$fromCall as \$a)<a>{{ \$a['label'] }}</a>@endforeach\n"
            . "@foreach (\$fromProperty as \$b)@foreach (\$b['children'] as \$c)<a>{{ \$c['label'] }}</a>@endforeach@endforeach\n"
            . "@foreach (\$fromThis as \$d)<a>{{ \$d['label'] }}</a>@endforeach";

        self::assertSame($source, self::transform($source)->output);
    }

    public function testLeavesLabelsThatMayHoldUserData(): void
    {
        $source = "@php\n\$pages = [['label' => 'Dashboard'], \$admin ? ['label' => 'Settings'] : null];\n"
            . "\$resources = [['label' => \$project->name]];\n"
            . "\$merged = array_merge([['label' => 'Home']], \$extra);\n"
            . "\$appended = [['label' => 'Team']];\n\$appended[] = ['label' => \$team->name];\n"
            . "\$wrapped = [['label' => 'Keys'], \$custom];\n@endphp\n"
            . "@foreach (\$pages as \$page)<a>{{ \$page['label'] }}</a>@endforeach\n"
            . "@foreach (\$resources as \$resource)<a>{{ \$resource['label'] }}</a>@endforeach\n"
            . "@foreach (\$merged as \$m)<a>{{ \$m['label'] }}</a>@endforeach\n"
            . "@foreach (\$appended as \$p)<a>{{ \$p['label'] }}</a>@endforeach\n"
            . "@foreach (\$wrapped as \$w)<a>{{ \$w['label'] }}</a>@endforeach\n"
            . "@foreach (array_merge(\$pages, \$more) as \$both)<a>{{ \$both['label'] }}</a>@endforeach\n"
            . "<b>{{ \$other['label'] }}</b>";
        $result = self::transform($source);

        self::assertStringContainsString("<a>{{ coolify_ko_t(\$page['label']) }}</a>", $result->output);
        foreach (['resource', 'm', 'p', 'w', 'both', 'other'] as $var) {
            self::assertStringContainsString('{{ $' . $var . "['label'] }}", $result->output, $var);
        }
        self::assertSame(['Dashboard', 'Settings'], self::keys($result, 'display'));
    }

    public function testTranslatesDefaultsOfPropsListedInRulesInsteadOfDisplaySites(): void
    {
        $source = "@props(['label' => 'Save changes', 'heading' => 'Unsaved', 'id' => null, 'size' => 'Large'])\n"
            . "<button id=\"{{ \$id }}\" class=\"{{ \$size }}\"><i>{{ \$heading }}</i>{{ \$label }}</button>";
        $result = self::transform($source, 'views/components/unsaved-bar.blade.php', 'unsaved-bar', ['label']);

        self::assertSame(
            "@props(['label' => __('Save changes'), 'heading' => 'Unsaved', 'id' => null, 'size' => 'Large'])\n"
            . "<button id=\"{{ \$id }}\" class=\"{{ \$size }}\"><i>{{ \$heading }}</i>{{ \$label }}</button>",
            $result->output,
        );
        self::assertSame(['Save changes'], self::keys($result, 'prop-default'));
    }

    public function testHtmlPropDefaultUsesSafeHelper(): void
    {
        $source = "@props(['description' => 'Use <b>care</b>.'])\n<p>{!! \$description !!}</p>";
        $result = self::transform($source, 'views/components/popup.blade.php', 'popup', ['description']);

        self::assertSame("@props(['description' => (string) __h('Use <0>care</0>.', [['<b>', '</b>']])])\n<p>{!! \$description !!}</p>", $result->output);
        self::assertSame(['Use <0>care</0>.'], self::keys($result, 'prop-default-html'));
    }

    public function testPropDefaultUsedInLogicStaysAndIsReported(): void
    {
        $source = "@props(['title' => 'Continue'])\n@if (\$title === 'Continue') 1 @endif\n<h3>{{ \$title }}</h3>";
        $result = self::transform($source, 'views/components/modal.blade.php', 'modal', ['title']);

        self::assertSame($source, $result->output);
        self::assertContains(SkipReason::LogicProp, array_map(static fn ($s) => $s->reason, $result->skips));
    }

    public function testKeepsLogicDefaultAndWrapsItsDisplayVariableInsideTag(): void
    {
        $rules = new RuleSet(
            components: ['modal-confirmation' => ['step1ButtonText', 'step2ButtonText']],
            componentSinks: ['modal-confirmation' => ['step1ButtonText' => 'text', 'step2ButtonText' => 'text']],
            logicValues: ['modal-confirmation' => ['step2ButtonText' => ['Continue']]],
            displayVariables: ['modal-confirmation' => ['effectiveStep2ButtonText' => ['Continue', 'Confirm']]],
        );
        $source = "@props(['step1ButtonText' => 'Continue', 'step2ButtonText' => 'Continue'])\n"
            . "@php\n    \$effectiveStep2ButtonText = (\$skip && \$step2ButtonText === 'Continue') ? 'Confirm' : \$step2ButtonText;\n@endphp\n"
            . "<div x-data=\"{\n    step1ButtonText: @js(\$step1ButtonText),\n    step2ButtonText: @js(\$effectiveStep2ButtonText),\n}\"></div>";
        $props = ComponentProps::fromTemplates($rules, ['modal-confirmation' => $source]);
        $result = (new BladeFileTransformer($rules, $props))->transform($source, 'views/components/modal-confirmation.blade.php');

        self::assertSame(
            "@props(['step1ButtonText' => __('Continue'), 'step2ButtonText' => 'Continue'])\n"
            . "@php\n    \$effectiveStep2ButtonText = (\$skip && \$step2ButtonText === 'Continue') ? 'Confirm' : \$step2ButtonText;\n@endphp\n"
            . "<div x-data=\"{\n    step1ButtonText: @js(\$step1ButtonText),\n    step2ButtonText: @js(coolify_ko_t(\$effectiveStep2ButtonText)),\n}\"></div>",
            $result->output,
        );
        self::assertSame(['Continue', 'Confirm'], self::keys($result, 'display'));
        self::assertCount(1, array_filter($result->occurrences, static fn ($o) => $o->kind === 'prop-display'));
        self::assertSame([], $result->skips);
    }

    public function testDoesNotWrapPlainVariablesOutsideComponents(): void
    {
        $source = "<span>{{ \$label }}</span><span>{{ \$item['name'] }}</span>";

        self::assertSame($source, self::transform($source)->output);
    }

    public function testTransformIsIdempotent(): void
    {
        $source = "@props(['label' => 'Save changes'])\n<b>{{ \$label }}</b>\n@php \$items = [['label' => 'General']]; @endphp\n@foreach (\$items as \$item){{ \$item['label'] }}@endforeach";
        $once = self::transform($source, 'views/components/bar.blade.php', 'bar', ['label'])->output;

        self::assertSame($once, self::transform($once, 'views/components/bar.blade.php', 'bar', ['label'])->output);
    }
}
