<?php

declare(strict_types=1);

// Coolify 변환 규칙. 컴포넌트 속성은 "후보"일 뿐이고, 실제로 바꿀지는 템플릿을 분석해서 정한다
// (로직에 쓰이거나 출력 방식이 섞이면 건너뛰고 보고서에 남긴다).
// confirmationText는 사용자가 똑같이 입력해야 하는 확인 문구라 일부러 넣지 않는다.
// modal-confirmation의 dispatchEventMessage는 알림 본문(x-html)으로 가서 __()로 감싸면 안 되고, 4.4.6에는 넘기는 곳도 없어 넣지 않는다.

return [
    'brands' => [
        'Coolify', 'Coolify Cloud', 'Docker', 'Docker Compose', 'Docker Swarm', 'Dockerfile', 'Swarm',
        'GitHub', 'GitHub App', 'GitLab', 'Bitbucket', 'Gitea', 'Git',
        'Traefik', 'Caddy', 'Nginx', 'Nixpacks', 'Railpack', 'Sentinel', 'Horizon', 'Reverb',
        'Hetzner', 'DigitalOcean', 'Vultr', 'Cloudflare', 'Cloudflare Tunnel', 'AWS', 'S3',
        'SSH', 'SSL', 'TLS', 'DNS', 'API', 'OAuth', 'SSO', 'OIDC', 'SMTP', 'HTTP', 'HTTPS', 'URL', 'FQDN', 'IP',
        'Laravel', 'Livewire', 'Discord', 'Slack', 'Telegram', 'Pushover', 'Resend', 'Mattermost', 'Microsoft Teams',
        'PostgreSQL', 'Postgres', 'MySQL', 'MariaDB', 'MongoDB', 'Redis', 'KeyDB', 'DragonFly', 'ClickHouse',
        'Authentik', 'Zitadel', 'Infomaniak', 'Clerk', 'Azure', 'Google', 'Microsoft', 'Stripe', "Let's Encrypt",
        'Ubuntu', 'Debian', 'Alpine', 'Linux', 'Windows', 'macOS', 'PHP', 'Node.js',
    ],

    'components' => [
        'forms.input' => ['label', 'helper', 'placeholder', 'loadingText', 'ariaLabel'],
        'forms.env-var-input' => ['label', 'helper', 'placeholder'],
        'forms.textarea' => ['label', 'helper', 'placeholder'],
        'forms.checkbox' => ['label', 'helper'],
        'forms.listbox' => ['label', 'helper', 'placeholder', 'emptyText', 'searchPlaceholder', 'searchEmptyText'],
        'forms.button' => ['tooltip', 'ariaLabel'],
        'forms.collapsible' => ['title'],
        'forms.copy-input' => ['label'],
        'forms.domain-input' => ['hostLabel', 'hostPlaceholder'],
        'modal-confirmation' => [
            'title', 'buttonTitle', 'warningMessage', 'confirmationLabel', 'shortConfirmationLabel',
            'step1ButtonText', 'step2ButtonText', 'step3ButtonText', 'disabledTooltip',
        ],
        'modal-input' => ['title', 'subtitle', 'buttonTitle'],
        'callout' => ['title'],
        'helper' => ['helper', 'label'],
        'application.settings-section' => ['title', 'description', 'helper'],
        'empty' => ['title', 'description'],
        'error-page' => ['title', 'description', 'primaryLabel'],
        'auth.shell' => ['title', 'description'],
        'danger-zone' => ['title'],
        'section-heading' => ['title', 'subtitle', 'actionLabel'],
        'checkpoint-item' => ['title', 'description'],
        'popup' => ['title', 'description'],
        'popup-small' => ['title', 'description'],
        'unsaved-bar' => ['label'],
        'api-disabled-callout' => ['message'],
        'deploying-indicator' => ['label'],
        'copy-button' => ['label'],
        'loading' => ['text'],
        'loading-on-button' => ['text'],
        'page-loading' => ['text'],
        'table.loading' => ['text'],
        'status-badge' => ['label', 'title', 'status'],
        'status-summary' => ['title', 'containerName'],
        'breadcrumb-switcher' => ['title'],
        'dashboard.navbar' => ['title', 'subtitle'],
        'table.search' => ['placeholder'],
        'table.filter' => ['resetLabel', 'activeText'],
        'shared-variables.view-controls' => ['label'],
        'shared-variables.editor' => ['title', 'variablesLabel'],
        'notification.event-multiselect' => ['label'],
        'server.provider-link-modal' => ['providerLabel', 'manualLabel'],
        'server.provider-token-picker' => ['providerLabel'],
    ],

    // 자동 분석이 보수적으로 막은 속성 중, 4.4.6 템플릿을 직접 읽고 화면 표시용임을 확인한 것(2026-10-16).
    // step2ButtonText는 `=== 'Continue'` 비교가 있어 'Continue'만 logicValues로 남기고 나머지는 번역한다(2026-10-18).
    // status-badge의 status는 collect([$label, $status])->filter()->join(' ')로 표시만 한다(2026-10-18).
    'componentSinks' => [
        'forms.listbox' => ['placeholder' => 'text', 'emptyText' => 'text', 'searchEmptyText' => 'text'],
        'forms.button' => ['tooltip' => 'text'],
        'modal-confirmation' => [
            'buttonTitle' => 'text', 'warningMessage' => 'html', 'step1ButtonText' => 'text',
            'step2ButtonText' => 'text', 'step3ButtonText' => 'text',
        ],
        'application.settings-section' => ['title' => 'text', 'description' => 'html', 'helper' => 'html'],
        'status-badge' => ['label' => 'text', 'status' => 'text'],
        'breadcrumb-switcher' => ['title' => 'text'],
        'dashboard.navbar' => ['title' => 'text'],
        'table.filter' => ['activeText' => 'text'],
        'shared-variables.view-controls' => ['label' => 'text'],
    ],

    // 배열 리터럴로 넘기는 prop에서 화면 글자인 항목 키('*'는 키 없는 항목 자체). value·id 같은 다른 키는 로직이라 그대로 둔다.
    // listbox는 label·description을 표시·검색에만 쓰고(선택은 value로 찾는다), modal-confirmation은 actions를 {{ $action }}로,
    // checkboxes의 label·default_warning을 {{ }}와 forms.checkbox :label로만 쓴다(4.4.6 템플릿 확인, 2026-10-18).
    // notification.event-multiselect는 events의 label을 {{ }}와 선택 요약(pluck('label')->implode)·title로만 쓰고, 선택은 property로 한다.
    // 변수로 넘기면 그 변수를 고정 라벨에서 옮겨 담은 자리를 정의에서 번역한다(event-grid의 map, 2026-10-18).
    'componentArrayProps' => [
        'forms.listbox' => ['options' => ['label', 'description']],
        'modal-confirmation' => ['actions' => ['*'], 'checkboxes' => ['label', 'default_warning']],
        'notification.event-multiselect' => ['events' => ['label']],
    ],

    // @include에 넘기는 데이터 배열에서 화면 글자인 키. js는 템플릿이 JS 작은따옴표 문자열 안('{{ $singular }}')에 넣는 값이라
    // 번역문의 따옴표가 JS를 깨지 않게 addslashes로 감싼다.
    'includeArgs' => [
        'livewire.shared.list-search-controls' => ['placeholder' => 'text', 'singular' => 'js', 'plural' => 'js'],
    ],

    // 템플릿이 비교에 쓰는 값. 호출부·@props 기본값에서 영어 그대로 둔다.
    // modal-confirmation은 비밀번호 단계를 건너뛸 때 step2ButtonText === 'Continue'이면 'Confirm'으로 바꿔 보인다.
    'logicValues' => [
        'modal-confirmation' => ['step2ButtonText' => ['Continue']],
    ],

    // 컴포넌트 템플릿 안에서 위 비교를 거친 뒤 @js(변수)로 화면에 나가는 변수와 그 영어 값. 표시 지점만 coolify_ko_t로 감싼다.
    'displayVariables' => [
        'modal-confirmation' => ['effectiveStep2ButtonText' => ['Continue', 'Confirm']],
    ],

    // 코드 값(리소스 종류·변수 범위)으로 화면 글자를 만드는 식. 식이 낼 수 있는 영어 값을 모두 적고(카탈로그 display 키),
    // 출력 지점(혼자 있는 echo, 문장 치환값)만 coolify_ko_t로 감싼다. 목록에 없는 값은 그대로 나온다.
    // server.resources는 Application·Service·Standalone* 모델의 type()(4.4.6 app/Models 확인), shared-variables.editor의 $type은
    // 호출부 4곳이 넘기는 team·project·environment·server다(2026-10-18).
    'displayExpressions' => [
        'livewire.server.resources' => [
            'str($resource->type())->headline()' => [
                'Application', 'Service', 'Standalone Clickhouse', 'Standalone Dragonfly', 'Standalone Keydb', 'Standalone Mariadb',
                'Standalone Mongodb', 'Standalone Mysql', 'Standalone Postgresql', 'Standalone Redis', 'Standalone Sqlite',
            ],
        ],
        'components.shared-variables.editor' => ['str($type)->headline()' => ['Team', 'Project', 'Environment', 'Server']],
    ],

    'htmlAttributes' => ['title', 'aria-label', 'alt', 'placeholder', 'data-tooltip'],

    // 값이 화면 글자로 쓰이는 Alpine 속성. 식의 결과 자리 문자열만 바꾸고 조건·비교 쪽 문자열은 그대로 둔다.
    'alpineAttributes' => [
        'x-text', ':title', 'x-bind:title', ':aria-label', 'x-bind:aria-label', ':placeholder', 'x-bind:placeholder', ':alt', 'x-bind:alt',
    ],

    // 스크립트 안에서 첫 인자가 화면 글자인 호출. window.toast의 첫 인자는 알림 제목이다(layouts/base.blade.php).
    'scriptCalls' => ['window.toast' => 0],

    // 사람이 읽는 화면이 아닌 곳(메일·패키지 뷰)은 1차 범위 밖이다.
    'excludedViewDirectories' => ['emails', 'vendor', 'components/emails'],
];
