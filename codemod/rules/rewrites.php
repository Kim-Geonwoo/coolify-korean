<?php

declare(strict_types=1);

// 수동 치환(rules/coolify.php의 rewrites). 식·삼항·단복수가 뒤섞여 다른 규칙이 건너뛰는 4.5.0 문장을 사람이 쓴 번역 호출 꼴로 바꾼다.
// find는 공식 4.5.0 원본에서 그대로 잘랐다(공백 포함). 원문이 정확히 한 번 있을 때만 바꾸고, 상류가 바꾸면 보고서에 rewrite-missed로 남는다.
// 동등성 게이트가 kind 방식으로 영어 출력이 같은지 확인한다. 2026-10-25

return [
    'livewire.profile.passkeys' => [
        // 패스키 목록 줄: 기본 이름·추가 시각·마지막 사용
        [
            'find' => '{{ $passkey->authenticator ?? \'Passkey\' }}
                                · Added {{ $passkey->created_at->diffForHumans() }}
                                · {{ $passkey->last_used_at ? \'Last used \'.$passkey->last_used_at->diffForHumans() : \'Not used yet\' }}',
            'replace' => '{{ $passkey->authenticator ?? __(\'Passkey\') }} · {{ __(\'Added :time\', [\'time\' => $passkey->created_at->diffForHumans()]) }} · {{ $passkey->last_used_at ? __(\'Last used :time\', [\'time\' => $passkey->last_used_at->diffForHumans()]) : __(\'Not used yet\') }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => 'Passkey', 'kind' => 'text'],
                ['key' => 'Added :time', 'kind' => 'text', 'placeholders' => ['time']],
                ['key' => 'Last used :time', 'kind' => 'text', 'placeholders' => ['time']],
                ['key' => 'Not used yet', 'kind' => 'text'],
            ],
        ],
    ],
    'livewire.server.security.patches' => [
        // 자동 보안 업데이트 도움말: 패키지 관리자별 두 문장
        [
            'find' => 'helper="{{ $packageManager === \'apt\' ? \'Uses unattended-upgrades for the security origins only.\' : \'Uses dnf-automatic with upgrade_type = security.\' }} Turning it off removes the Coolify configuration and keeps the operating system default."',
            'replace' => ':helper="$packageManager === \'apt\' ? __(\'Uses unattended-upgrades for the security origins only. Turning it off removes the Coolify configuration and keeps the operating system default.\') : __(\'Uses dnf-automatic with upgrade_type = security. Turning it off removes the Coolify configuration and keeps the operating system default.\')"',
            'kind' => 'prop-html',
            'keys' => [
                ['key' => 'Uses unattended-upgrades for the security origins only. Turning it off removes the Coolify configuration and keeps the operating system default.', 'kind' => 'prop-html'],
                ['key' => 'Uses dnf-automatic with upgrade_type = security. Turning it off removes the Coolify configuration and keeps the operating system default.', 'kind' => 'prop-html'],
            ],
        ],
        // 패키지 업데이트 수: 전체·보안 개수를 각각 단복수로
        [
            'find' => 'helper="{{ $totalUpdates }} {{ Str::plural(\'update\', $totalUpdates) }} available{{ $securityUpdates !== null ? \', \' . $securityUpdates . \' of them security \' . Str::plural(\'update\', $securityUpdates) : \'\' }}."',
            'replace' => ':helper="$securityUpdates !== null ? trans_choice(\':count update available, :security.|:count updates available, :security.\', $totalUpdates, [\'security\' => trans_choice(\':count of them security update|:count of them security updates\', $securityUpdates)]) : trans_choice(\':count update available.|:count updates available.\', $totalUpdates)"',
            'kind' => 'prop-html',
            'counts' => ['$totalUpdates', '$securityUpdates'],
            'keys' => [
                ['key' => ':count update available, :security.|:count updates available, :security.', 'kind' => 'plural', 'placeholders' => ['count', 'security']],
                ['key' => ':count of them security update|:count of them security updates', 'kind' => 'plural', 'placeholders' => ['count']],
                ['key' => ':count update available.|:count updates available.', 'kind' => 'plural', 'placeholders' => ['count']],
            ],
        ],
    ],
    'livewire.server.proxy' => [
        // Traefik 패치 안내
        [
            'find' => '{{ $server->detected_traefik_version ? \'Running version\' : \'Configured image\' }}
                                    v{{ ltrim($this->traefikVersionForWarning, \'v\') }}. The latest patch
                                    for this branch is {{ $this->latestTraefikVersion }}. Test the update before applying it
                                    to production servers.',
            'replace' => '{{ __(\':image v:version. The latest patch for this branch is :latest. Test the update before applying it to production servers.\', [\'image\' => $server->detected_traefik_version ? __(\'Running version\') : __(\'Configured image\'), \'version\' => ltrim($this->traefikVersionForWarning, \'v\'), \'latest\' => $this->latestTraefikVersion]) }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => ':image v:version. The latest patch for this branch is :latest. Test the update before applying it to production servers.', 'kind' => 'text', 'placeholders' => ['image', 'version', 'latest']],
                ['key' => 'Running version', 'kind' => 'text'],
                ['key' => 'Configured image', 'kind' => 'text'],
            ],
        ],
    ],
    'livewire.server.show' => [
        // 다른 인스턴스로 이전된 서버 안내(강조·링크 태그)
        [
            'find' => 'This server was transferred to
                                <strong>{{ data_get($server->server_metadata, \'transfer.target_instance_url\') ?: \'another Coolify instance\' }}</strong>,
                                which manages it now. Use that instance. To undo the transfer, use
                                <a href="{{ route(\'server.transfer\', [\'server_uuid\' => $server->uuid]) }}" {{ wireNavigate() }}
                                    class="underline">Transfer back</a>. Keep this archive until you are sure: it is the copy
                                that an undo uses.',
            'replace' => '{{ __h(\'This server was transferred to <0>:target</0>, which manages it now. Use that instance. To undo the transfer, use <1>Transfer back</1>. Keep this archive until you are sure: it is the copy that an undo uses.\', [[\'<strong>\', \'</strong>\'], [\'<a href="\' . e(route(\'server.transfer\', [\'server_uuid\' => $server->uuid])) . \'" \' . e(wireNavigate()) . \' class="underline">\', \'</a>\']], [\'target\' => data_get($server->server_metadata, \'transfer.target_instance_url\') ?: __(\'another Coolify instance\')]) }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => 'This server was transferred to <0>:target</0>, which manages it now. Use that instance. To undo the transfer, use <1>Transfer back</1>. Keep this archive until you are sure: it is the copy that an undo uses.', 'kind' => 'rich', 'placeholders' => ['target']],
                ['key' => 'another Coolify instance', 'kind' => 'text'],
            ],
        ],
    ],
    'livewire.server.transfer' => [
        // 되돌리기 이전 시작 안내
        [
            'find' => '{{ data_get($server->server_metadata, \'transfer.transfer_back.from\') }} started the transfer back at
                                    {{ \\Illuminate\\Support\\Carbon::parse($transferBackAt)->format(\'H:i\') }}. Reload this page in a minute.
                                    When the transfer finishes, this instance manages the server again. If it does not, read
                                    the transfer log of the server on the other instance.',
            'replace' => '{{ __(\':instance started the transfer back at :time. Reload this page in a minute. When the transfer finishes, this instance manages the server again. If it does not, read the transfer log of the server on the other instance.\', [\'instance\' => data_get($server->server_metadata, \'transfer.transfer_back.from\'), \'time\' => \\Illuminate\\Support\\Carbon::parse($transferBackAt)->format(\'H:i\')]) }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => ':instance started the transfer back at :time. Reload this page in a minute. When the transfer finishes, this instance manages the server again. If it does not, read the transfer log of the server on the other instance.', 'kind' => 'text', 'placeholders' => ['instance', 'time']],
            ],
        ],
    ],
    'livewire.project.shared.environment-variable.show' => [
        // Compose 서비스 목록
        [
            'find' => 'Used by: {{ implode(\', \', $composeInfo[\'services\']) }}.',
            'replace' => '{{ __(\'Used by: :services.\', [\'services\' => implode(\', \', $composeInfo[\'services\'])]) }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => 'Used by: :services.', 'kind' => 'text', 'placeholders' => ['services']],
            ],
        ],
        // 공유 변수 참조 팁(중괄호 표시 태그)
        [
            'find' => 'Tip: Type <span
                                    class="font-mono text-coollabs dark:text-brand-light">{{ \'{{\' }}</span> to reference
                                a shared environment variable',
            'replace' => '{{ __h(\'Tip: Type <0/> to reference a shared environment variable\', [\'<span class="font-mono text-coollabs dark:text-brand-light">\' . \'{\' . \'{\' . \'</span>\']) }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => 'Tip: Type <0/> to reference a shared environment variable', 'kind' => 'rich'],
            ],
        ],
    ],
    'livewire.project.shared.environment-variable.add' => [
        // 공유 변수 참조 팁(중괄호 표시 태그)
        [
            'find' => 'Tip: Type <span class="font-mono text-coollabs dark:text-brand-light">{{ \'{{\' }}</span> to reference a
                shared environment variable',
            'replace' => '{{ __h(\'Tip: Type <0/> to reference a shared environment variable\', [\'<span class="font-mono text-coollabs dark:text-brand-light">\' . \'{\' . \'{\' . \'</span>\']) }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => 'Tip: Type <0/> to reference a shared environment variable', 'kind' => 'rich'],
            ],
        ],
    ],
    'livewire.project.database.backup-executions' => [
        // 백업 실행 중 경과 시간
        [
            'find' => 'Running for {{ calculateDuration(data_get($execution, \'created_at\'), now()) }}',
            'replace' => '{{ __(\'Running for :duration\', [\'duration\' => calculateDuration(data_get($execution, \'created_at\'), now())]) }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => 'Running for :duration', 'kind' => 'text', 'placeholders' => ['duration']],
            ],
        ],
    ],
    'livewire.project.application.advanced' => [
        // GPU 정보 확인 시각
        [
            'find' => '· checked
                                            {{ \\Illuminate\\Support\\Carbon::parse(data_get($gpuServer->server_metadata, \'collected_at\'))->diffForHumans() }}',
            'replace' => '· {{ __(\'checked :time\', [\'time\' => \\Illuminate\\Support\\Carbon::parse(data_get($gpuServer->server_metadata, \'collected_at\'))->diffForHumans()]) }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => 'checked :time', 'kind' => 'text', 'placeholders' => ['time']],
            ],
        ],
    ],
    'livewire.project.application.heading' => [
        // Nixpacks 사용 중단 안내의 링크 글
        [
            'find' => 'Switch to Railpack in General settings.',
            'replace' => '{{ __(\'Switch to Railpack in General settings.\') }}',
            'kind' => 'rich',
            'keys' => [
                ['key' => 'Switch to Railpack in General settings.', 'kind' => 'text'],
            ],
        ],
    ],
    'livewire.project.new.partials.env-import-modal' => [
        // 환경 변수 가져오기 단추(단복수)
        [
            'find' => '{{ $envImported ? \'Update\' : \'Import\' }} {{ count($envExampleVars) }} {{ Str::plural(\'variable\', count($envExampleVars)) }}',
            'replace' => '{{ $envImported ? trans_choice(\'Update :count variable|Update :count variables\', count($envExampleVars)) : trans_choice(\'Import :count variable|Import :count variables\', count($envExampleVars)) }}',
            'kind' => 'plural',
            'counts' => ['count($envExampleVars)'],
            'keys' => [
                ['key' => 'Update :count variable|Update :count variables', 'kind' => 'plural', 'placeholders' => ['count']],
                ['key' => 'Import :count variable|Import :count variables', 'kind' => 'plural', 'placeholders' => ['count']],
            ],
        ],
    ],
    'livewire.project.new.partials.smart-scan-summary' => [
        // 스마트 스캔 빌드팩 판정
        [
            'find' => 'title="{{ $buildPackLabels[$suggestedBuildPack] }} {{ $build_pack === $suggestedBuildPack ? \'selected\' : \'suggested\' }}"',
            'replace' => ':title="$build_pack === $suggestedBuildPack ? __(\':build_pack selected\', [\'build_pack\' => e($buildPackLabels[$suggestedBuildPack])]) : __(\':build_pack suggested\', [\'build_pack\' => e($buildPackLabels[$suggestedBuildPack])])"',
            'kind' => 'prop-text',
            'keys' => [
                ['key' => ':build_pack selected', 'kind' => 'prop-text', 'placeholders' => ['build_pack']],
                ['key' => ':build_pack suggested', 'kind' => 'prop-text', 'placeholders' => ['build_pack']],
            ],
        ],
        // 스마트 스캔 환경 변수 수(단복수)
        [
            'find' => 'description="{{ count($envExampleVars) }} {{ Str::plural(\'variable\', count($envExampleVars)) }}{{ $envImported ? \', imported when you continue\' : \'\' }}."',
            'replace' => ':description="$envImported ? trans_choice(\':count variable, imported when you continue.|:count variables, imported when you continue.\', count($envExampleVars)) : trans_choice(\':count variable.|:count variables.\', count($envExampleVars))"',
            'kind' => 'prop-text',
            'counts' => ['count($envExampleVars)'],
            'keys' => [
                ['key' => ':count variable, imported when you continue.|:count variables, imported when you continue.', 'kind' => 'plural', 'placeholders' => ['count']],
                ['key' => ':count variable.|:count variables.', 'kind' => 'plural', 'placeholders' => ['count']],
            ],
        ],
    ],
];
