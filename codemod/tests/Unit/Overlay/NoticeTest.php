<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Overlay;

use PHPUnit\Framework\TestCase;

/** 미러가 멈추거나 한국어판이 뒤처지면 공식판으로 되돌리는 방법을 알리는 배너(5단계 검토 중대 5) */
final class NoticeTest extends TestCase
{
    private const NOW = 1_800_000_000;

    private const DAY = 86_400;

    public static function setUpBeforeClass(): void
    {
        require_once dirname(__DIR__, 4) . '/overlay/files/bootstrap/helpers/coolify_ko.php';
    }

    /** @return array<string, mixed> */
    private static function versions(int $refreshedAgo, string $upstream = '4.4.6', int $seenAgo = 0, string $ours = '4.4.6'): array
    {
        $at = static fn (int $ago): string => gmdate('Y-m-d\TH:i:s.000\Z', self::NOW - $ago);

        return [
            'coolify' => ['v4' => ['version' => $ours], 'helper' => ['version' => '1.0.17']],
            'coolify-ko' => ['schema' => 1, 'upstream' => $upstream, 'upstreamSeenAt' => $at($seenAgo), 'refreshedAt' => $at($refreshedAgo)],
        ];
    }

    public function testStaysQuietForTheOfficialMirror(): void
    {
        self::assertNull(coolify_ko_notice(['coolify' => ['v4' => ['version' => '4.4.6']]], self::NOW));
        self::assertNull(coolify_ko_notice(null, self::NOW));
    }

    public function testWarnsWhenTheMirrorStoppedRefreshingForThreeDays(): void
    {
        self::assertNull(coolify_ko_notice(self::versions(3 * self::DAY - 3600), self::NOW));
        self::assertSame('stale', coolify_ko_notice(self::versions(3 * self::DAY + 60), self::NOW));
    }

    public function testWarnsWhenTheKoreanBuildLagsTheOfficialOneForAWeek(): void
    {
        self::assertNull(coolify_ko_notice(self::versions(0, '4.4.7', 6 * self::DAY), self::NOW));
        self::assertSame('lagging', coolify_ko_notice(self::versions(0, '4.4.7', 7 * self::DAY + 60), self::NOW));
    }

    public function testIgnoresAMalformedRecord(): void
    {
        $versions = self::versions(0);
        $versions['coolify-ko']['refreshedAt'] = 'yesterday-ish';
        self::assertNull(coolify_ko_notice($versions, self::NOW));

        $versions = self::versions(10 * self::DAY);
        $versions['coolify-ko']['schema'] = 2;
        self::assertNull(coolify_ko_notice($versions, self::NOW));
    }

    public function testInjectsBeforeTheLastClosingBody(): void
    {
        self::assertSame('<html><BODY>a<b>N</BODY></html>', coolify_ko_inject_notice('<html><BODY>a<b></BODY></html>', 'N'));
        self::assertSame('<body></body>x<b>N</body>', coolify_ko_inject_notice('<body></body>x<b></body>', 'N'));
        self::assertSame('{"json":true}', coolify_ko_inject_notice('{"json":true}', 'N'));
    }

    public function testRendersAFixedEscapedMessageWithTheRevertCommand(): void
    {
        $ko = coolify_ko_notice_html('stale', 'ko');
        self::assertStringContainsString('role="status"', $ko);
        self::assertStringContainsString('3일', $ko);
        self::assertStringContainsString('sudo bash /data/coolify/source/coolify-ko.sh uninstall', $ko);
        self::assertStringNotContainsString('<script', $ko);

        $en = coolify_ko_notice_html('lagging', 'en');
        self::assertStringContainsString('7 days', $en);
        self::assertStringContainsString('coolify-ko.sh uninstall', $en);
    }
}
