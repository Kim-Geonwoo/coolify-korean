<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\JsLeaves;
use PHPUnit\Framework\TestCase;

final class JsLeavesTest extends TestCase
{
    /** @return list<string>|null */
    private static function values(string $js): ?array
    {
        $leaves = JsLeaves::find($js);

        return $leaves === null ? null : array_map(static fn (array $leaf): string => $leaf[2], $leaves);
    }

    public function testFindsBothBranchesOfATopLevelTernary(): void
    {
        self::assertSame(['Disable', 'Enable'], self::values("enabled ? 'Disable' : 'Enable'"));
    }

    public function testLeavesStringsInTheConditionAlone(): void
    {
        self::assertSame(['Running', 'Stopped'], self::values("status === 'running' ? 'Running' : 'Stopped'"));
    }

    public function testFollowsNestedTernariesAndFallbackOperands(): void
    {
        self::assertSame(['A', 'B', 'Untitled'], self::values("a ? 'A' : (b ? 'B' : name || 'Untitled')"));
        self::assertSame(['None'], self::values("item?.label ?? 'None'"));
    }

    public function testAcceptsAWholeLiteral(): void
    {
        self::assertSame(['Copy'], self::values("'Copy'"));
        self::assertSame(['Copy'], self::values(" ( 'Copy' ) "));
    }

    public function testOptionalChainingIsNotATernary(): void
    {
        self::assertSame([], self::values('item?.label'));
        self::assertSame([], self::values('list?.[0]'));
    }

    public function testSkipsConcatenatedSentencesAndNonLiterals(): void
    {
        self::assertSame([], self::values("'Search (' + key + 'K)'"));
        self::assertSame([], self::values("ok ? label : other"));
        self::assertSame(['Off'], self::values("ok ? 'On ' + count : 'Off'"));
    }

    public function testRejectsTemplateLiteralsAndUnknownEscapes(): void
    {
        self::assertNull(JsLeaves::find('ok ? `Hi ${name}` : \'Bye\''));
        self::assertNull(JsLeaves::find("ok ? 'tab\\x41' : 'Bye'"));
    }

    public function testDecodesEscapesAndReportsSourcePositions(): void
    {
        $js = "ok ? 'Don\\'t stop' : \"Say \\\"hi\\\" \\u00e9\"";
        $leaves = JsLeaves::find($js);

        self::assertNotNull($leaves);
        self::assertSame(["Don't stop", "Say \"hi\" \u{e9}"], array_map(static fn (array $leaf): string => $leaf[2], $leaves));
        self::assertSame("'Don\\'t stop'", substr($js, $leaves[0][0], $leaves[0][1] - $leaves[0][0]));
        self::assertSame("\"Say \\\"hi\\\" \\u00e9\"", substr($js, $leaves[1][0], $leaves[1][1] - $leaves[1][0]));
    }

    public function testDecodeHandlesTheEscapesJsFromProduces(): void
    {
        self::assertSame("Don't <b>", JsLeaves::decode("'Don\\u0027t \\u003Cb\\u003E'"));
        self::assertNull(JsLeaves::decode('notALiteral'));
    }
}
