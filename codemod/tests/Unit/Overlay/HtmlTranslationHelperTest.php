<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Overlay;

use Illuminate\Container\Container;
use Illuminate\Support\HtmlString;
use Illuminate\Translation\ArrayLoader;
use Illuminate\Translation\Translator;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class HtmlTranslationHelperTest extends TestCase
{
    private const LINK = [['<a href="/docs">', '</a>']];

    private ArrayLoader $loader;

    private Translator $translator;

    public static function setUpBeforeClass(): void
    {
        require_once dirname(__DIR__, 4) . '/overlay/files/bootstrap/helpers/coolify_ko.php';
    }

    protected function setUp(): void
    {
        $this->loader = new ArrayLoader();
        $this->translator = new Translator($this->loader, 'en');
        $container = new Container();
        $container->instance('translator', $this->translator);
        Container::setInstance($container);
    }

    protected function tearDown(): void
    {
        Container::setInstance(null);
    }

    /** @param array<string, string> $lines */
    private function korean(array $lines): void
    {
        $this->loader->addMessages('ko', '*', $lines, '*');
        $this->translator->setLocale('ko');
    }

    public function testRendersEnglishKeyWithTags(): void
    {
        self::assertSame('Use <a href="/docs">this link</a> now.', (string) __h('Use <0>this link</0> now.', self::LINK));
    }

    public function testReturnsHtmlString(): void
    {
        self::assertInstanceOf(HtmlString::class, __h('Plain'));
    }

    public function testEscapesTextAndKeepsVoidTag(): void
    {
        self::assertSame('A &amp; B &lt;i&gt;<br>', (string) __h('A & B <i><0/>', ['<br>']));
    }

    public function testEscapesReplacementValues(): void
    {
        self::assertSame('Hi &lt;b&gt;x&lt;/b&gt;', (string) __h('Hi :name', [], ['name' => '<b>x</b>']));
    }

    public function testDoesNotReplaceInsideReplacedValues(): void
    {
        self::assertSame('A :b and 2', (string) __h('A :a and :b', [], ['a' => ':b', 'b' => '2']));
    }

    public function testTranslationMayReorderTags(): void
    {
        $this->korean(['Use <0>this link</0> now.' => '지금 <0>이 링크</0>를 쓰세요.']);

        self::assertSame('지금 <a href="/docs">이 링크</a>를 쓰세요.', (string) __h('Use <0>this link</0> now.', self::LINK));
    }

    public function testTranslationCannotInjectMarkup(): void
    {
        $this->korean(['Use <0>this link</0> now.' => '<script>alert(1)</script><0>링크</0>']);

        self::assertSame('&lt;script&gt;alert(1)&lt;/script&gt;<a href="/docs">링크</a>', (string) __h('Use <0>this link</0> now.', self::LINK));
    }

    public function testTranslationUsesUppercasePlaceholderVariants(): void
    {
        $this->korean(['Hello :name' => '안녕 :Name, :NAME']);

        self::assertSame('안녕 Kim, KIM', (string) __h('Hello :name', [], ['name' => 'kim']));
    }

    public function testUppercaseReplacementNameKeepsValueLikeLaravel(): void
    {
        self::assertSame('Go to https://x.io now', (string) __h('Go to :URL now', [], ['URL' => 'https://x.io']));
    }

    public function testCrossedPairTagsFallBackToEnglish(): void
    {
        $tags = [['<b>', '</b>'], ['<i>', '</i>']];
        $this->korean(['A <0>b <1>c</1></0>' => '<0>가 <1>나</0></1>']);

        self::assertSame('A <b>b <i>c</i></b>', (string) __h('A <0>b <1>c</1></0>', $tags));
    }

    public function testMessageWithoutTranslationIsTheUpstreamStringVerbatim(): void
    {
        self::assertSame("Don't stop & <b>x</b>\n  now", coolify_ko_message("Don't stop & :name\n  now", [], ['name' => '<b>x</b>']));
    }

    public function testMessageWithoutTranslationRestoresOriginalTagsAndEntities(): void
    {
        self::assertSame("It's done.<br>Restart &amp; go.", coolify_ko_message("It's done.<0/>Restart &amp; go.", ['<br>']));
    }

    public function testMessageReturnsPlainString(): void
    {
        self::assertIsString(coolify_ko_message('Saved.'));
    }

    public function testMessageTranslationCannotOpenTags(): void
    {
        $this->korean(['Saved.' => '<a href="https://evil">저장</a>됨']);

        self::assertSame('&lt;a href="https://evil">저장&lt;/a>됨', coolify_ko_message('Saved.'));
    }

    public function testMessageTranslationKeepsQuotesAndAmpersandsForClipboard(): void
    {
        $this->korean(["Don't" => '"main" & 끝']);

        self::assertSame('"main" & 끝', coolify_ko_message("Don't"));
    }

    public function testMessageTranslationKeepsReplacementValuesRaw(): void
    {
        $this->korean(['Error: :message' => '오류: :message, :Message']);

        self::assertSame('오류: <code>x</code>, <code>x</code>', coolify_ko_message('Error: :message', [], ['message' => '<code>x</code>']));
    }

    public function testMessageTranslationRestoresNumberedTags(): void
    {
        $this->korean(['Done.<0/>Restart required.' => '완료.<0/>재시작 필요.']);

        self::assertSame('완료.<br>재시작 필요.', coolify_ko_message('Done.<0/>Restart required.', ['<br>']));
    }

    public function testMessageBrokenTranslationFallsBackToEnglish(): void
    {
        $this->korean(['Done.<0/>Restart required.' => '완료. 재시작 필요.', 'Value <0> ok' => '<0>값</0>']);

        self::assertSame('Done.<br>Restart required.', coolify_ko_message('Done.<0/>Restart required.', ['<br>']));
        self::assertSame('Value <0> ok', coolify_ko_message('Value <0> ok'));
    }

    public function testDisplayValueTranslatesStrings(): void
    {
        $this->korean(['General' => '일반']);

        self::assertSame('일반', coolify_ko_t('General'));
    }

    public function testDisplayValueLeavesOtherValuesAlone(): void
    {
        $html = new HtmlString('<b>x</b>');
        $this->korean(['5' => '오']);

        self::assertNull(coolify_ko_t(null));
        self::assertSame(5, coolify_ko_t(5));
        self::assertSame($html, coolify_ko_t($html));
    }

    /** @return iterable<string, array{string}> */
    public static function brokenTranslations(): iterable
    {
        yield 'dropped tag' => ['링크를 쓰세요'];
        yield 'unknown tag index' => ['<0>링크</0><5/>'];
        yield 'duplicated tag' => ['<0>링크</0><0>또</0>'];
        yield 'crossed nesting' => ['<0>링크<1/></0>'];
        yield 'unclosed tag' => ['<0>링크'];
        yield 'void used as pair' => ['<0/>링크'];
    }

    #[DataProvider('brokenTranslations')]
    public function testBrokenTranslationFallsBackToEnglish(string $translation): void
    {
        $this->korean(['Use <0>this link</0> now.' => $translation]);

        self::assertSame('Use <a href="/docs">this link</a> now.', (string) __h('Use <0>this link</0> now.', self::LINK));
    }
}
