<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit;

use CoolifyKo\Codemod\Php\PhpString;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class PhpStringTest extends TestCase
{
    public function testQuotesPlainText(): void
    {
        self::assertSame("'General'", PhpString::singleQuoted('General'));
    }

    public function testEscapesQuoteAndBackslash(): void
    {
        self::assertSame("'It\\'s C:\\\\dir'", PhpString::singleQuoted("It's C:\\dir"));
    }

    /** @return iterable<string, array{string}> */
    public static function trickyStrings(): iterable
    {
        yield 'dollar and braces' => ['Cost {$x} and $y'];
        yield 'trailing backslash' => ['ends with \\'];
        yield 'quote then backslash' => ["a\\'b"];
        yield 'newline and tab' => ["line1\nline2\tend"];
        yield 'unicode' => ['서버 → 컨테이너 “quoted”'];
    }

    #[DataProvider('trickyStrings')]
    public function testRoundTripsThroughPhpParser(string $value): void
    {
        $literal = PhpString::singleQuoted($value);

        // 시험 전용: 고정된 입력으로 만든 리터럴을 PHP 파서 자체로 되읽어 왕복을 확인한다.
        self::assertSame($value, eval('return ' . $literal . ';'));
    }
}
