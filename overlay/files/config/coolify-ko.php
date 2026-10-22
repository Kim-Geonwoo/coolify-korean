<?php

// coolify-ko: 화면 언어와 런타임 번역 파일 위치. Coolify는 시작할 때 설정을 캐시하므로 env()는 여기서만 읽는다.

return [
    'locale' => env('COOLIFY_LOCALE', 'en'),
    'lang_path' => env('COOLIFY_LANG_PATH', '/var/www/html/lang-runtime'),
    // 공개판 이미지에 든 검증된 기본 언어 파일(볼륨 파일이 없거나 깨졌을 때)
    'default_path' => env('COOLIFY_LANG_DEFAULT_PATH', '/var/www/html/lang-default'),
    // 미러가 멈추거나 한국어판이 뒤처질 때 되돌리는 방법을 알리는 배너(공식 미러면 나타나지 않음)
    'notice' => (bool) env('COOLIFY_KO_NOTICE', true),
];
