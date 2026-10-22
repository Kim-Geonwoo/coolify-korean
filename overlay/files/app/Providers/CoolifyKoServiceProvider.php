<?php

namespace App\Providers;

use GuzzleHttp\Psr7\Response as GuzzleResponse;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\ServiceProvider;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * coolify-ko: 화면 언어를 정하고, 쓸 수 있는 번역 파일 폴더를 JSON 번역 경로로 더한다.
 * 볼륨(lang_path)의 파일이 깨졌으면 이미지 기본값(default_path, 공개판에만 있음)으로, 그것도 없으면 영어로 둔다.
 * VERSIONS_URL 응답의 버전 값도 셸에 넣기 전에 검사한다(guardVersionsResponse).
 */
class CoolifyKoServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $locale = (string) config('coolify-ko.locale', 'en');
        if (preg_match('/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$/D', $locale) !== 1) {
            $locale = 'en';
        }

        // 언어 폴더 고르기가 어떤 이유로 실패해도 화면을 깨지 않고 영어로 둔다(boot 예외는 모든 요청·큐를 500으로 만든다)
        try {
            $dir = coolify_ko_lang_dir([
                (string) config('coolify-ko.lang_path', ''),
                (string) config('coolify-ko.default_path', ''),
            ], $locale);
        } catch (\Throwable) {
            $dir = null;
        }
        if ($dir !== null) {
            $this->app['translator']->addJsonPath($dir);
        }

        $this->app->setLocale($locale);

        $this->app['router']->pushMiddlewareToGroup('web', \App\Http\Middleware\CoolifyKoNotice::class);

        Http::globalMiddleware(self::guardVersionsResponse(...));
    }

    /**
     * 보안 점검(2026-10-22): 상류는 VERSIONS_URL의 helper·sentinel·v4 버전을 이스케이프 없이 셸 명령에 넣는다.
     * 그 응답에 셸에 넣기 위험한 값이 있으면 응답을 실패(502)로 바꾼다. 받는 쪽(업데이트, 업데이트 확인, helper·sentinel 확인)은
     * 실패 응답이면 갱신하지 않거나 캐시로 돌아간다. 다른 주소의 요청은 건드리지 않는다
     */
    public static function guardVersionsResponse(callable $handler): callable
    {
        return static function (RequestInterface $request, array $options) use ($handler) {
            $promise = $handler($request, $options);
            if (! coolify_ko_is_versions_url((string) $request->getUri(), (string) config('constants.coolify.versions_url', ''))) {
                return $promise;
            }

            return $promise->then(static function (ResponseInterface $response): ResponseInterface {
                $status = $response->getStatusCode();
                // 이 미들웨어는 Guzzle의 리다이렉트 처리 안쪽에 놓인다. 리다이렉트를 따라가면 다음 요청은 다른 주소로 보여
                // 검사를 피하므로, VERSIONS_URL의 3xx는 따라가지 않고 실패로 바꾼다(자동 보안 검토 2026-10-22)
                if ($status >= 300 && $status < 400) {
                    Log::warning('coolify-ko: VERSIONS_URL이 리다이렉트를 돌려줘 쓰지 않습니다', ['status' => $status]);

                    return new GuzzleResponse(502, ['Content-Type' => 'application/json'], '{}');
                }
                if ($status >= 400) {
                    return $response;
                }
                $body = $response->getBody();
                $text = (string) $body;
                if ($body->isSeekable()) {
                    $body->rewind();
                }
                $unsafe = coolify_ko_unsafe_versions(json_decode($text, true));
                if ($unsafe === []) {
                    return $response;
                }
                Log::warning('coolify-ko: VERSIONS_URL 응답의 버전 값이 안전하지 않아 쓰지 않습니다', ['paths' => array_slice($unsafe, 0, 10)]);

                return new GuzzleResponse(502, ['Content-Type' => 'application/json'], '{}');
            });
        };
    }
}
