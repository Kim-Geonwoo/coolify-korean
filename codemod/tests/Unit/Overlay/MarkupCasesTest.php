<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Overlay;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * TS 하드 검사(pipeline/src/translate/markup-cases.test.ts)와 같은 사례 파일을 읽는다.
 * 두 쪽 판정이 어긋나면 TS는 통과시키고 런타임은 조용히 영어로 그리게 된다.
 */
final class MarkupCasesTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        require_once dirname(__DIR__, 4) . '/overlay/files/bootstrap/helpers/coolify_ko.php';
    }

    /** @return iterable<string, array{string, string, bool}> */
    public static function cases(): iterable
    {
        $data = json_decode((string) file_get_contents(dirname(__DIR__, 2) . '/fixtures/markup-cases.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($data['cases'] as $index => $case) {
            yield "#{$index} {$case['translation']}" => [$case['source'], $case['translation'], $case['valid']];
        }
    }

    #[DataProvider('cases')]
    public function testRendersTranslationOnlyWhenItsTagsMatchTheSource(string $source, string $translation, bool $valid): void
    {
        $tags = [];
        preg_match_all('/<(\/?)(\d+)(\/?)>/', $source, $matches, PREG_SET_ORDER);
        foreach ($matches as [, $closing, $n, $void]) {
            if ($closing === '') {
                $tags[(int) $n] = $void === '/' ? '<br>' : ['<b>', '</b>'];
            }
        }
        $same = static fn (string $text): string => $text;

        self::assertSame($valid, coolify_ko_render_markup($translation, $tags, [], $same, $same) !== null);
    }
}
