<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\HtmlStream;
use CoolifyKo\Codemod\Blade\Segment;
use CoolifyKo\Codemod\Blade\SegmentKind;
use PHPUnit\Framework\TestCase;

final class HtmlStreamTest extends TestCase
{
    /** @return list<string> */
    private static function describe(string $source): array
    {
        $out = [];
        foreach (HtmlStream::fromSource($source)->segments() as $segment) {
            $out[] = self::label($segment);
        }

        return $out;
    }

    private static function label(Segment $s): string
    {
        $flags = ($s->context->protected ? '!' : '') . ($s->context->slot !== null ? '@' . $s->context->slot : '');
        return match ($s->kind) {
            SegmentKind::Text => 'T' . $flags . ':' . $s->source,
            SegmentKind::Tag => ($s->tag?->isStatic === true ? 'S' : 'D') . $flags . ':' . ($s->tag?->closing === true ? '/' : '') . ($s->tag?->name ?? '?'),
            SegmentKind::Blade => 'B' . $flags . ':' . trim($s->source),
            SegmentKind::Comment => 'C',
        };
    }

    public function testSplitsStaticTagsAndText(): void
    {
        self::assertSame(
            ['S:div', 'S:h2', 'T:General', 'S:/h2', 'S:/div'],
            self::describe('<div title="Copy"><h2>General</h2></div>'),
        );
    }

    public function testParsesStaticAttributes(): void
    {
        $tag = HtmlStream::fromSource('<input title="Copy it" disabled data-x=\'a > b\'>')->segments()[0]->tag;

        self::assertNotNull($tag);
        self::assertSame(['title' => 'Copy it', 'disabled' => null, 'data-x' => 'a > b'], $tag->attributes);
    }

    public function testMarksTagWithBladeInsideAsDynamic(): void
    {
        self::assertSame(
            ['D:a', 'T:Docs', 'S:/a'],
            self::describe('<a href="{{ $url }}" class="x">Docs</a>'),
        );
    }

    public function testListsAttributesOfDynamicTagOutsideBladeSpans(): void
    {
        $source = "<a title=\"Projects\" {{ wireNavigate() }} class=\"{{ \$a ? 'x' : \"y\" }}\" @if (\$b) data-x='1' @endif>";
        $tag = HtmlStream::fromSource($source)->segments()[0]->tag;

        self::assertNotNull($tag);
        self::assertSame(
            ['{{ wireNavigate() }}', "{{ \$a ? 'x' : \"y\" }}", '@if ($b)', '@endif'],
            array_map(static fn (array $s): string => trim(substr($source, $s[0], $s[1] - $s[0])), $tag->bladeSpans),
        );
        $attributes = array_values(array_filter($tag->attributeList(), static fn (array $a): bool => !$tag->overlapsBlade($a['start'], $a['end'])));
        self::assertSame(
            [['title', 'Projects', '"', 'title="Projects"'], ['data-x', '1', "'", "data-x='1'"]],
            array_map(static fn (array $a): array => [$a['name'], $a['value'], $a['quote'], substr($source, $a['start'], $a['end'] - $a['start'])], $attributes),
        );
        self::assertContains('class', array_column($tag->attributeList(), 'name'));
    }

    public function testProtectsScriptContentEvenWithMarkupInside(): void
    {
        self::assertSame(
            ['S:script', 'T!:let a = "<b>', 'B!:{{ $x }}', 'T!:</b>";', 'S:/script', 'S:p', 'T:Hi', 'S:/p'],
            self::describe('<script>let a = "<b>{{ $x }}</b>";</script><p>Hi</p>'),
        );
    }

    public function testProtectsCodeAndMonospaceText(): void
    {
        self::assertSame(
            ['S:code', 'T!:docker ps', 'S:/code', 'T: and ', 'S:span', 'T!:x', 'S:/span', 'T: text'],
            self::describe('<code>docker ps</code> and <span class="text-sm font-mono">x</span> text'),
        );
    }

    public function testSkipsHtmlComments(): void
    {
        self::assertSame(['C', 'T:Hello'], self::describe('<!-- note <b> -->Hello'));
    }

    public function testKeepsEchoBetweenTextAsBladeSegment(): void
    {
        self::assertSame(['T:Delete ', 'B:{{ $name }}', 'T:?'], self::describe('Delete {{ $name }}?'));
    }

    public function testTracksSlotName(): void
    {
        self::assertSame(
            ['B:<x-slot:title>', 'T@title:Profile | Coolify', 'B:</x-slot>', 'T:after'],
            self::describe('<x-slot:title>Profile | Coolify</x-slot>after'),
        );
    }

    public function testVoidElementsDoNotOpenContext(): void
    {
        self::assertSame(
            ['S:code', 'S!:br', 'S:/code', 'T:after'],
            self::describe('<code><br></code>after'),
        );
        self::assertSame(['T:Line', 'S:br', 'T:Next'], self::describe('Line<br>Next'));
    }

    public function testLessThanNotFollowedByLetterIsText(): void
    {
        self::assertSame(['T:a < b and 3<5'], self::describe('a < b and 3<5'));
    }

    public function testEchoedTagNameStartsADynamicTag(): void
    {
        self::assertSame(
            ['T:Go ', 'D:?', 'T:Open logs', 'D:?'],
            self::describe(<<<'BLADE'
                Go <{{ $href ? 'a' : 'div' }} x-show="{{ $i }} >= page * per" @class(['x' => $y])>Open logs</{{ $href ? 'a' : 'div' }}>
                BLADE),
        );
    }

    public function testLivewireTagIsAStaticSelfClosingTag(): void
    {
        $segments = HtmlStream::fromSource('<livewire:server.navbar :server="$server" />')->segments();

        self::assertCount(1, $segments);
        self::assertSame('livewire:server.navbar', $segments[0]->tag?->name);
        self::assertTrue($segments[0]->tag?->selfClosing);
    }

    public function testUsesByteOffsetsAfterMultibyteCharacters(): void
    {
        self::assertSame(
            ['T:Status · ok ', 'B:@if ($hasIcon)', 'T: Yes ', 'B:@endif'],
            self::describe('Status · ok @if ($hasIcon) Yes @endif'),
        );
    }

    public function testSegmentsCoverTheWholeSourceInOrder(): void
    {
        $source = "<div x-data=\"{ open: false }\" @click=\"open = !open\">\n  <x-forms.input label=\"Name\" />\n  "
            . "Hi {{ \$a }} <!-- c --> @if(\$b) <b>x</b> @endif {!! \$raw !!}\n  <style>.a > .b {}</style>\n</div>";
        $rebuilt = '';
        $cursor = 0;
        foreach (HtmlStream::fromSource($source)->segments() as $segment) {
            self::assertSame($cursor, $segment->start);
            self::assertSame(substr($source, $segment->start, $segment->end - $segment->start), $segment->source);
            $rebuilt .= $segment->source;
            $cursor = $segment->end;
        }

        self::assertSame($source, $rebuilt);
    }
}
