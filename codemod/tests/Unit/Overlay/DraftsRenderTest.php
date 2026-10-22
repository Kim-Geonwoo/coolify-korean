<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Overlay;

use PHPUnit\Framework\TestCase;

/**
 * 레포의 번역 파일(기계 초안 i18n/drafts, Weblate 승인 i18n/reviewed, 승인 전 i18n/pending)을 런타임 헬퍼로 모두 그려 본다.
 * 태그 구성이 어긋난 번역은 런타임에서 조용히 영어로 그려지므로, TS 하드 검사와 별개로 PHP 쪽에서도
 * 영어로 되돌아가는 키가 없어야 한다. verify가 i18n/을 읽기 전용으로 붙인다(없으면 건너뛴다).
 */
final class DraftsRenderTest extends TestCase
{
    private const FILES = ['drafts/ko.json', 'reviewed/ko.json', 'pending/ko.json'];

    public function testEveryTranslationRendersWithoutFallingBackToEnglish(): void
    {
        $root = dirname(__DIR__, 4);
        if (! is_file($root . '/i18n/drafts/ko.json') || ! is_file($root . '/i18n/catalog.json')) {
            self::markTestSkipped('i18n/drafts가 붙지 않았다');
        }
        require_once $root . '/overlay/files/bootstrap/helpers/coolify_ko.php';
        /** @var array{keys: array<string, array{english: string}>} $catalog */
        $catalog = json_decode((string) file_get_contents($root . '/i18n/catalog.json'), true, 512, JSON_THROW_ON_ERROR);
        $same = static fn (string $text): string => $text;
        $fallbacks = [];
        $rendered = 0;
        foreach (self::FILES as $file) {
            $path = $root . '/i18n/' . $file;
            if (! is_file($path)) {
                continue;
            }
            /** @var array<string, string> $translations */
            $translations = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
            foreach ($translations as $key => $translation) {
                $english = $catalog['keys'][$key]['english'] ?? null;
                if ($english === null) {
                    // removedIn이 달린, 카탈로그에서 빠진 키
                    continue;
                }
                $tags = [];
                preg_match_all('/<(\/?)(\d+)(\/?)>/', $english, $matches, PREG_SET_ORDER);
                foreach ($matches as [, $closing, $n, $void]) {
                    if ($closing === '') {
                        $tags[(int) $n] = $void === '/' ? '<br>' : ['<b>', '</b>'];
                    }
                }
                $rendered++;
                if (coolify_ko_render_markup($translation, $tags, [], $same, $same) === null) {
                    $fallbacks[] = "{$file}: {$key}";
                }
            }
        }

        self::assertGreaterThan(0, $rendered);
        self::assertSame([], $fallbacks);
    }
}
