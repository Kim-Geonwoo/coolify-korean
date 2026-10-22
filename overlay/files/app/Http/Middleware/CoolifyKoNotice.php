<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpFoundation\Response as BaseResponse;
use Throwable;

/**
 * coolify-ko: 미러가 멈추거나 한국어판이 뒤처지면 로그인한 화면 아래에 되돌리는 방법을 보여 준다(5단계 검토 중대 5).
 * 공식 미러(coolify-ko 기록 없음)·Livewire 요청·HTML이 아닌 응답에는 아무것도 하지 않고, 판정 실패는 화면에 영향을 주지 않는다
 */
class CoolifyKoNotice
{
    public function handle(Request $request, Closure $next): BaseResponse
    {
        $response = $next($request);
        try {
            if (! config('coolify-ko.notice', true)
                || ! $response instanceof Response
                || $response->getStatusCode() !== 200
                || $request->hasHeader('X-Livewire')
                || ! str_contains((string) $response->headers->get('Content-Type', ''), 'text/html')
                || ! auth()->check()
                || ! function_exists('get_versions_data')) {
                return $response;
            }
            $kind = coolify_ko_notice(get_versions_data(), time());
            $content = $response->getContent();
            if ($kind !== null && is_string($content)) {
                $response->setContent(coolify_ko_inject_notice($content, coolify_ko_notice_html($kind, app()->getLocale())));
            }
        } catch (Throwable) {
            // 배너는 부가 기능이다: 캐시·파일 오류로 화면을 깨지 않는다
        }

        return $response;
    }
}
