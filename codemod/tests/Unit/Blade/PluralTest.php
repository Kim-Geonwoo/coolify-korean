<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\SkipReason;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** 개수에 따라 낱말이 바뀌는 문장(Str::plural, `$n === 1 ? '' : 's'`)을 trans_choice로 바꾼다. */
final class PluralTest extends TestCase
{
    private static function transform(string $source): TransformResult
    {
        return (new BladeFileTransformer(new RuleSet(brands: ['Coolify'])))->transform($source, 'views/livewire/x.blade.php');
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'count and Str::plural' => [
            "<p>{{ \$destinations->count() }} {{ Str::plural('network endpoint', \$destinations->count()) }}</p>",
            "<p>{{ trans_choice(':count network endpoint|:count network endpoints', \$destinations->count()) }}</p>",
        ];
        yield 'suffix ternary glued to a word' => [
            "<span>{{ \$configuredCount }} domain{{ \$configuredCount === 1 ? '' : 's' }}</span>",
            "<span>{{ trans_choice(':count domain|:count domains', \$configuredCount) }}</span>",
        ];
        yield 'negated suffix ternary and irregular plural' => [
            "<p>{{ count(\$updates) }} {{ Str::plural('package entry', count(\$updates)) }} left, {{ count(\$updates) !== 1 ? 'they' : 'it' }} will run</p>",
            "<p>{{ trans_choice(':count package entry left, it will run|:count package entries left, they will run', count(\$updates)) }}</p>",
        ];
        yield 'whole-word ternary without a count echo' => [
            "<p>{{ \$n === 1 ? 'change' : 'changes' }} pending</p>",
            "<p>{{ trans_choice('change pending|changes pending', \$n) }}</p>",
        ];
        yield 'other values stay placeholders' => [
            "<p>{{ \$s3->count() }} {{ \$s3->count() === 1 ? 'storage destination' : 'storage destinations' }} for {{ \$team->name }}</p>",
            "<p>{{ trans_choice(':count storage destination for :name|:count storage destinations for :name', \$s3->count(), ['name' => \$team->name]) }}</p>",
        ];
        yield 'second count becomes an inner plural phrase' => [
            "<span>{{ \$configuredCount }} domain{{ \$configuredCount === 1 ? '' : 's' }} across {{ \$domainGroups->count() }} service{{ \$domainGroups->count() === 1 ? '' : 's' }}</span>",
            "<span>{{ trans_choice(':count domain across :services|:count domains across :services', \$configuredCount, ['services' => trans_choice(':count service|:count services', \$domainGroups->count())]) }}</span>",
        ];
        yield 'outer count is the one whose phrase cannot be cut out' => [
            "<span>{{ \$missing }} of {{ \$members->count() }} {{ Str::plural('member', \$members->count()) }} {{ \$missing === 1 ? 'does' : 'do' }} not have two-factor authentication enabled.</span>",
            "<span>{{ trans_choice(':count of :members does not have two-factor authentication enabled.|:count of :members do not have two-factor authentication enabled.', \$missing, ['members' => trans_choice(':count member|:count members', \$members->count())]) }}</span>",
        ];
    }

    public function testLeavesLoneTernaryEchoToBranchTranslation(): void
    {
        $source = "<span>{{ \$n === 1 ? 'Required variable missing' : 'Required variables missing' }}</span>";

        self::assertSame("<span>{{ \$n === 1 ? __('Required variable missing') : __('Required variables missing') }}</span>", self::transform($source)->output);
    }

    #[DataProvider('conversions')]
    public function testTurnsCountPhrasesIntoPluralChoices(string $source, string $expected): void
    {
        self::assertSame($expected, self::transform($source)->output);
    }

    /** @return iterable<string, array{string}> */
    public static function untouched(): iterable
    {
        yield 'plural of a variable word' => ["<span>{{ Str::plural(\$type) }} ({{ \$users->count() }})</span>"];
        yield 'plural without count' => ["<span>{{ Str::plural('server') }}</span>"];
    }

    #[DataProvider('untouched')]
    public function testLeavesOtherPluralsAlone(string $source): void
    {
        self::assertSame($source, self::transform($source)->output);
    }

    /**
     * Str::plural만 낀 문장 중 글자가 있는 것은 지금까지도 문장(:value 치환값)으로 바꿔 왔다. 그 키에는 초안·검수 번역이 있어
     * 키를 바꾸면 번역이 고아가 되므로, 초안 쪽에서 지운 키로 표시하기 전까지는 전처럼 둔다.
     */
    public function testKeepsEarlierStrPluralSentencesWithText(): void
    {
        $source = "<p>{{ \$n }} {{ Str::plural('resource', \$n) }} will be cloned.</p>";

        self::assertSame(
            "<p>{{ __(':n :value will be cloned.', ['n' => \$n, 'value' => Str::plural('resource', \$n)]) }}</p>",
            self::transform($source)->output,
        );
    }

    public function testSkipsSuffixTernaryInsideRichSentence(): void
    {
        $source = "<p>{{ \$n }} item{{ \$n === 1 ? '' : 's' }} in <a href=\"/list\">the list</a></p>";
        $result = self::transform($source);

        self::assertSame($source, $result->output);
        self::assertSame([SkipReason::ComplexExpression], array_map(static fn ($s) => $s->reason, $result->skips));
    }

    public function testRecordsPluralKeysPlaceholdersAndCounts(): void
    {
        $result = self::transform("<span>{{ \$c }} domain{{ \$c === 1 ? '' : 's' }} across {{ \$g->count() }} service{{ \$g->count() === 1 ? '' : 's' }} of {{ \$team->name }}</span>");

        self::assertSame(
            [
                [':count domain across :services of :name|:count domains across :services of :name', 'plural', ['count', 'services', 'name'], ['$c', '$g->count()']],
                [':count service|:count services', 'plural', ['count'], []],
            ],
            array_map(static fn ($o): array => [$o->key, $o->kind, $o->placeholders, $o->counts], $result->occurrences),
        );
    }

    public function testTransformIsIdempotent(): void
    {
        $once = self::transform("<p>{{ \$n }} {{ \$n === 1 ? 'resource' : 'resources' }} will be cloned.</p>")->output;

        self::assertSame("<p>{{ trans_choice(':count resource will be cloned.|:count resources will be cloned.', \$n) }}</p>", $once);
        self::assertSame($once, self::transform($once)->output);
    }
}
