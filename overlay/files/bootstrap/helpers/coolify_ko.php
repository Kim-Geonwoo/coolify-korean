<?php

// coolify-ko: HTML이 섞인 문장을 안전하게 번역해 출력한다.
// Coolify의 bootstrap/includeHelpers.php가 이 폴더의 *.php를 자동으로 불러온다.

use Illuminate\Support\HtmlString;
use Illuminate\Support\Str;

if (! function_exists('__h')) {
    /**
     * 번호 태그(<0>…</0>, <1/>)가 든 키를 번역해 HTML로 돌려준다.
     * 번역문의 글자와 치환값은 모두 이스케이프하고, 태그는 원문 템플릿이 준 것만 다시 끼운다.
     * 번역문의 태그 구성이 원문과 다르면 영어 원문으로 그린다.
     *
     * @param  array<int, array{0: string, 1: string}|string>  $tags
     * @param  array<string, mixed>  $replace
     */
    function __h(string $key, array $tags = [], array $replace = [], ?string $locale = null): HtmlString
    {
        $escape = static fn (string $text): string => e($text);
        $line = __($key, [], $locale);
        $line = is_string($line) ? $line : $key;
        $html = coolify_ko_render_markup($line, $tags, $replace, $escape, $escape);
        if ($html === null && $line !== $key) {
            $html = coolify_ko_render_markup($key, $tags, $replace, $escape, $escape);
        }

        return new HtmlString($html ?? e($key));
    }
}

if (! function_exists('coolify_ko_message')) {
    /**
     * Livewire 알림·검증 문구용 번역. 브라우저는 이 문자열을 HTML로 그리고(x-html), 복사 버튼은 글자 그대로 복사한다.
     * 번역이 없으면 업스트림이 만들던 문자열(원문·태그·치환값 그대로)을 돌려준다.
     * 번역이 있으면 번역문의 '<'만 &lt;로 바꿔 태그를 새로 못 만들게 하고, 태그 구성이 원문과 다르면 영어로 그린다.
     *
     * @param  array<int, array{0: string, 1: string}|string>  $tags
     * @param  array<string, mixed>  $replace
     */
    function coolify_ko_message(string $key, array $tags = [], array $replace = [], ?string $locale = null): string
    {
        $raw = static fn (string $text): string => $text;
        $line = __($key, [], $locale);
        if (is_string($line) && $line !== $key) {
            $translated = coolify_ko_render_markup($line, $tags, $replace, static fn (string $text): string => str_replace('<', '&lt;', $text), $raw);
            if ($translated !== null) {
                return $translated;
            }
        }
        if ($tags === []) {
            return strtr($key, coolify_ko_replacements($replace, $raw));
        }

        return coolify_ko_render_markup($key, $tags, $replace, $raw, $raw) ?? $key;
    }
}

if (! function_exists('coolify_ko_t')) {
    /**
     * 화면에 출력하는 값(템플릿에 영어로 정의된 메뉴 라벨 등)이 문자열일 때만 번역한다. 다른 값은 그대로 돌려준다.
     */
    function coolify_ko_t(mixed $value): mixed
    {
        return is_string($value) ? __($value) : $value;
    }
}

if (! function_exists('coolify_ko_render_markup')) {
    /**
     * 번호 태그를 템플릿이 준 태그로 되돌리며 문장을 그린다. 글자 조각은 $text, 치환값은 $value로 거른다.
     * 태그 구성(쓰인 번호·짝·중첩)이 템플릿과 다르면 null.
     *
     * @param  array<int, array{0: string, 1: string}|string>  $tags
     * @param  array<string, mixed>  $replace
     * @param  Closure(string): string  $text
     * @param  Closure(string): string  $value
     */
    function coolify_ko_render_markup(string $line, array $tags, array $replace, Closure $text, Closure $value): ?string
    {
        $parts = preg_split('/(<\/?\d+\/?>)/', $line, -1, PREG_SPLIT_DELIM_CAPTURE);
        if ($parts === false) {
            return null;
        }
        $replacements = coolify_ko_replacements($replace, $value);
        $html = '';
        $stack = [];
        $used = [];
        foreach ($parts as $index => $part) {
            if ($index % 2 === 0) {
                $html .= strtr($text($part), $replacements);

                continue;
            }
            if (preg_match('/^<(\/?)(\d+)(\/?)>$/', $part, $m) !== 1) {
                return null;
            }
            $n = (int) $m[2];
            $tag = $tags[$n] ?? null;
            $closing = $m[1] === '/';
            $void = $m[3] === '/';
            if ($tag === null || ($closing && $void)) {
                return null;
            }
            if ($void) {
                if (! is_string($tag) || isset($used[$n])) {
                    return null;
                }
                $used[$n] = true;
                $html .= $tag;

                continue;
            }
            if (! is_array($tag)) {
                return null;
            }
            if ($closing) {
                if (array_pop($stack) !== $n) {
                    return null;
                }
                $html .= $tag[1];

                continue;
            }
            if (isset($used[$n])) {
                return null;
            }
            $used[$n] = true;
            $stack[] = $n;
            $html .= $tag[0];
        }

        return $stack === [] && count($used) === count($tags) ? $html : null;
    }
}

if (! function_exists('coolify_ko_replacements')) {
    /**
     * Laravel 번역기(makeReplacements)와 같은 규칙으로 치환표를 만든다: :Name·:NAME 변형을 먼저 넣고 원래 이름을 마지막에
     * 넣어 같은 이름이면 원래 값이 이긴다. strtr가 긴 이름부터 바꾼다.
     *
     * @param  array<string, mixed>  $replace
     * @param  Closure(string): string  $value
     * @return array<string, string>
     */
    function coolify_ko_replacements(array $replace, Closure $value): array
    {
        $map = [];
        foreach ($replace as $name => $raw) {
            $text = (string) $raw;
            $name = (string) $name;
            $map[':'.Str::ucfirst($name)] = $value(Str::ucfirst($text));
            $map[':'.Str::upper($name)] = $value(Str::upper($text));
            $map[':'.$name] = $value($text);
        }

        return $map;
    }
}

if (! function_exists('coolify_ko_lang_dir')) {
    /**
     * 언어 파일(<폴더>/<locale>.json)을 쓸 수 있는 첫 폴더. 볼륨 파일이 비었거나 잘렸거나 객체가 아니면 다음 폴더(이미지 기본값)로,
     * 모두 못 쓰면 null(영어). Laravel은 깨진 JSON 번역 파일에서 예외를 던져 모든 화면이 500이 되므로 미리 거른다(5단계 검토 7).
     * 읽을 수 없는 파일(www-data가 못 읽는 root 0600 등)과 값이 글이 아닌 파일도 건너뛴다(최종 리뷰 2026-10-19).
     * json_decode는 0.44MB에 약 1.1ms(PHP 8.4.23, 2026-10-18 실측). $read는 시험용(기본은 경고를 내지 않는 읽기)
     *
     * @param  list<string>  $dirs
     * @param  (Closure(string): (string|false))|null  $read
     */
    function coolify_ko_lang_dir(array $dirs, string $locale, int $maxBytes = 8388608, ?Closure $read = null): ?string
    {
        $read ??= static fn (string $file): string|false => is_readable($file) ? @file_get_contents($file) : false;
        foreach ($dirs as $dir) {
            if ($dir === '') {
                continue;
            }
            $file = $dir.'/'.$locale.'.json';
            if (! is_file($file)) {
                continue;
            }
            $size = filesize($file);
            if ($size === false || $size < 2 || $size > $maxBytes) {
                continue;
            }
            try {
                $text = $read($file);
                if ($text === false || ! str_starts_with(ltrim($text), '{')) {
                    continue;
                }
                $data = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
            } catch (Throwable) {
                continue;
            }
            if (! is_array($data)) {
                continue;
            }
            foreach ($data as $value) {
                if (! is_string($value)) {
                    continue 2;
                }
            }

            return $dir;
        }

        return null;
    }
}

if (! function_exists('coolify_ko_notice')) {
    /**
     * versions.json(Coolify가 VERSIONS_URL 응답을 그대로 저장한 것)의 coolify-ko 기록으로 낡음을 판정한다.
     * 'stale': 미러가 3일 넘게 갱신되지 않음, 'lagging': 상류 새 버전이 나온 지 7일이 넘었는데 한국어판이 따라가지 못함.
     * 기록이 없거나(공식 미러) 형식이 틀리면 null. 우리 파이프라인이 사라져도 사용자가 되돌리는 법을 알 수 있게 한다(5단계 검토 5)
     *
     * @param  array<string, mixed>|null  $versions
     */
    function coolify_ko_notice(?array $versions, int $now): ?string
    {
        $info = $versions['coolify-ko'] ?? null;
        $ours = $versions['coolify']['v4']['version'] ?? null;
        if (! is_array($info) || ($info['schema'] ?? null) !== 1 || ! is_string($ours)) {
            return null;
        }
        $upstream = $info['upstream'] ?? null;
        $refreshed = is_string($info['refreshedAt'] ?? null) ? strtotime($info['refreshedAt']) : false;
        $seen = is_string($info['upstreamSeenAt'] ?? null) ? strtotime($info['upstreamSeenAt']) : false;
        if (! is_string($upstream) || preg_match('/^\d+\.\d+\.\d+$/', $upstream) !== 1 || $refreshed === false || $seen === false) {
            return null;
        }
        if ($now - $refreshed > 3 * 86400) {
            return 'stale';
        }
        if (version_compare($upstream, $ours, '>') && $now - $seen > 7 * 86400) {
            return 'lagging';
        }

        return null;
    }
}

if (! function_exists('coolify_ko_notice_html')) {
    /** 배너 HTML. 고정 문구만 이스케이프해 넣는다(스크립트 없음) */
    function coolify_ko_notice_html(string $kind, string $locale): string
    {
        $ko = str_starts_with($locale, 'ko');
        $reason = match ($kind) {
            'stale' => $ko ? '한국어판 업데이트 정보가 3일 넘게 갱신되지 않았습니다.' : 'The Korean build update feed has not been refreshed for more than 3 days.',
            default => $ko ? '공식 Coolify에 새 버전이 나왔지만 한국어판이 7일 넘게 따라가지 못했습니다.' : 'A new official Coolify version has been out for more than 7 days without a Korean build.',
        };
        $revert = $ko ? '공식판으로 되돌리려면 서버에서:' : 'To switch back to the official build, run on the server:';
        $style = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:8px 16px;background:#7c2d12;color:#fff;font:13px/1.5 system-ui,sans-serif';

        return '<div role="status" data-coolify-ko-notice style="'.$style.'">'.htmlspecialchars($reason, ENT_QUOTES).' '.htmlspecialchars($revert, ENT_QUOTES).' <code>sudo bash /data/coolify/source/coolify-ko.sh uninstall</code></div>';
    }
}

if (! function_exists('coolify_ko_inject_notice')) {
    /** 마지막 </body> 앞에 넣는다(대소문자 무시). 없으면 그대로 */
    function coolify_ko_inject_notice(string $html, string $notice): string
    {
        $at = strripos($html, '</body>');

        return $at === false ? $html : substr($html, 0, $at).$notice.substr($html, $at);
    }
}

if (! function_exists('coolify_ko_unsafe_versions')) {
    /**
     * VERSIONS_URL 응답에서 셸에 넣기 위험한 값의 경로를 찾는다(없으면 빈 배열, versions.json 꼴이 아니면 ['versions']).
     * 상류 Coolify는 coolify.helper·sentinel·v4 버전을 이스케이프 없이 docker·업그레이드 명령에 넣으므로, 미러가 뚫려도
     * 서버에서 명령이 돌지 않게 한다(보안 점검 2026-10-22, 미러 쪽 검사와 같은 규칙). coolify-ko 기록 같은 다른 키는 보지 않는다
     */
    function coolify_ko_unsafe_versions(mixed $versions): array
    {
        if (! is_array($versions) || ! is_array($versions['coolify'] ?? null)) {
            return ['versions'];
        }
        $walk = static function (mixed $value, string $path) use (&$walk): array {
            if (is_array($value)) {
                $found = [];
                foreach ($value as $key => $child) {
                    $found = [...$found, ...(is_string($key) && preg_match('/^[A-Za-z0-9._-]{1,40}$/D', $key) === 1 ? $walk($child, $path.'.'.$key) : [$path])];
                }

                return $found;
            }
            $pattern = str_ends_with($path, '.digest') ? '/^sha256:[0-9a-f]{64}$/D' : '/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/D';

            return is_string($value) && preg_match($pattern, $value) === 1 ? [] : [$path];
        };

        return [...$walk($versions['coolify'], 'coolify'), ...(array_key_exists('traefik', $versions) ? $walk($versions['traefik'], 'traefik') : [])];
    }
}

if (! function_exists('coolify_ko_is_versions_url')) {
    /** 요청 주소가 설정된 VERSIONS_URL인지(스킴·호스트·포트·경로가 같으면, 질의 문자열은 무시) */
    function coolify_ko_is_versions_url(string $url, string $configured): bool
    {
        $strip = static function (string $value): ?string {
            $parts = parse_url($value);
            if (! is_array($parts) || ! isset($parts['scheme'], $parts['host'])) {
                return null;
            }

            return strtolower($parts['scheme']).'://'.strtolower($parts['host']).(isset($parts['port']) ? ':'.$parts['port'] : '').($parts['path'] ?? '/');
        };
        $target = $strip($configured);

        return $target !== null && $strip($url) === $target;
    }
}
