<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\ComponentProps;
use CoolifyKo\Codemod\Blade\PropSink;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\SkipReason;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class AttributeTransformTest extends TestCase
{
    private BladeFileTransformer $transformer;

    private RuleSet $rules;

    private ComponentProps $props;

    protected function setUp(): void
    {
        $this->rules = $rules = new RuleSet(
            brands: ['Coolify'],
            components: [
                'forms.input' => ['label', 'helper', 'placeholder', 'hostLabel'],
                'modal-confirmation' => ['title', 'step2ButtonText', 'confirmationText'],
            ],
            htmlAttributes: ['title', 'aria-label', 'alt', 'placeholder'],
        );
        $templates = [
            'forms.input' => "@props(['label' => null])\n<label>{{ \$label }}</label><span>{{ \$hostLabel }}</span>\n@if (\$helper)\n<x-helper :helper=\"\$helper\" />\n@endif\n"
                . "<input {{ \$attributes->merge(['class' => 'input']) }} placeholder=\"{{ \$attributes->get('placeholder') }}\">",
            'helper' => '<div class="helper">{!! $helper !!}</div>',
            'modal-confirmation' => "<h3>{{ \$title }}</h3>\n@if (\$step2ButtonText === 'Continue') x @endif\n<button>{{ \$step2ButtonText }}</button>\n"
                . '<input x-model="typed"><span x-show="typed === @js($confirmationText)">ok</span>',
        ];
        $this->props = ComponentProps::fromTemplates($rules, $templates);
        $this->transformer = new BladeFileTransformer($rules, $this->props);
    }

    private function transform(string $source): string
    {
        return $this->transformer->transform($source, 'views/test.blade.php')->output;
    }

    /** @return iterable<string, array{string, string}> */
    public static function conversions(): iterable
    {
        yield 'static label on escaped prop' => [
            '<x-forms.input id="name" label="Name" />',
            "<x-forms.input id=\"name\" :label=\"__('Name')\" />",
        ];
        yield 'helper reaches raw output through nested component' => [
            '<x-forms.input id="a" helper="Line one<br>Line two" />',
            "<x-forms.input id=\"a\" :helper=\"(string) __h('Line one<0/>Line two', ['<br>'])\" />",
        ];
        yield 'helper keeps single-quoted link markup' => [
            "<x-forms.input id=\"a\" helper=\"See <a href='https://coolify.io/docs'>docs</a> first.\" />",
            "<x-forms.input id=\"a\" :helper=\"(string) __h('See <0>docs</0> first.', [['<a href=\\'https://coolify.io/docs\\'>', '</a>']])\" />",
        ];
        yield 'interpolated label escapes value like blade' => [
            '<x-forms.input id="a" label="Name of {{ $server->name }}" />',
            "<x-forms.input id=\"a\" :label=\"__('Name of :name', ['name' => e(\$server->name)])\" />",
        ];
        yield 'undeclared placeholder flows through attribute bag' => [
            '<x-forms.input id="a" placeholder="Search servers" />',
            "<x-forms.input id=\"a\" :placeholder=\"__('Search servers')\" />",
        ];
        yield 'title attribute on plain element' => [
            '<button title="Copy to clipboard"><svg></svg></button>',
            "<button title=\"{{ __('Copy to clipboard') }}\"><svg></svg></button>",
        ];
        yield 'kebab-case attribute resolves to the camelCase prop' => [
            '<x-forms.input id="a" host-label="Host name" />',
            "<x-forms.input id=\"a\" :host-label=\"__('Host name')\" />",
        ];
        yield 'plain attribute keeps its spacing' => [
            "<button title=\"Copy
  now \"><svg></svg></button>",
            "<button title=\"{{ __('Copy
  now ') }}\"><svg></svg></button>",
        ];
        yield 'interpolated label keeps its spacing' => [
            '<x-forms.input id="a" label="Name  of {{ $server->name }} " />',
            "<x-forms.input id=\"a\" :label=\"__('Name  of :name ', ['name' => e(\$server->name)])\" />",
        ];
        yield 'aria label with entity' => [
            '<span aria-label="Tom &amp; Jerry"></span>',
            "<span aria-label=\"{{ __('Tom & Jerry') }}\"></span>",
        ];
        yield 'static attribute next to blade echo in the tag' => [
            '<a title="Projects" {{ wireNavigate() }} href="/projects"><svg></svg></a>',
            "<a title=\"{{ __('Projects') }}\" {{ wireNavigate() }} href=\"/projects\"><svg></svg></a>",
        ];
        yield 'static attribute next to echo with both quote kinds' => [
            "<a title=\"Projects\" class=\"{{ \$a ? 'x' : \"y\" }}\"><svg></svg></a>",
            "<a title=\"{{ __('Projects') }}\" class=\"{{ \$a ? 'x' : \"y\" }}\"><svg></svg></a>",
        ];
        yield 'static attribute next to directive inside another value' => [
            "<nav aria-label=\"Configuration sections\" x-data=\"menu({ group: @js(\$group) })\"><svg></svg></nav>",
            "<nav aria-label=\"{{ __('Configuration sections') }}\" x-data=\"menu({ group: @js(\$group) })\"><svg></svg></nav>",
        ];
        yield 'attribute whose value is one literal ternary echo' => [
            "<button title=\"{{ \$streaming ? 'Stop Streaming' : 'Stream Logs' }}\"><svg></svg></button>",
            "<button title=\"{{ \$streaming ? __('Stop Streaming') : __('Stream Logs') }}\"><svg></svg></button>",
        ];
        yield 'component argument whose value is one literal ternary echo' => [
            "<x-forms.input id=\"p\" label=\" {{ \$initial ? 'Initial password' : 'Password' }} \" />",
            "<x-forms.input id=\"p\" label=\" {{ \$initial ? __('Initial password') : __('Password') }} \" />",
        ];
        yield 'both branches of an if inside the tag' => [
            "<div @if (\$ok) title=\"New version available\" @else title=\"No upgrade available\" @endif class=\"x\"><svg></svg></div>",
            "<div @if (\$ok) title=\"{{ __('New version available') }}\" @else title=\"{{ __('No upgrade available') }}\" @endif class=\"x\"><svg></svg></div>",
        ];
    }

    #[DataProvider('conversions')]
    public function testConvertsAttributes(string $source, string $expected): void
    {
        self::assertSame($expected, $this->transform($source));
    }

    /** @return iterable<string, array{string}> */
    public static function untouched(): iterable
    {
        yield 'identifier props stay' => ['<x-forms.input id="name" submitAction="delete" />'];
        yield 'unknown component stays' => ['<x-foo title="Hello there" />'];
        yield 'technical placeholder stays' => ['<input placeholder="https://example.com">'];
        yield 'dynamic attribute stays' => ['<a title="{{ $x }}"><svg></svg></a>'];
        yield 'two echoes in an attribute stay' => ["<a title=\"{{ \$a }} {{ \$b ? 'Open it' : 'Close it' }}\"><svg></svg></a>"];
        yield 'text and ternary echo in an attribute stay' => ["<a title=\"Open {{ \$b ? 'the app' : 'the service' }}\"><svg></svg></a>"];
        yield 'raw ternary echo in an attribute stays' => ["<a title=\"{!! \$b ? 'Open it' : 'Close it' !!}\"><svg></svg></a>"];
        yield 'ternary echo in an attribute not in rules stays' => ["<a data-label=\"{{ \$b ? 'Open it' : 'Close it' }}\"><svg></svg></a>"];
        yield 'ternary echo in a logic prop stays' => ["<x-modal-confirmation step2ButtonText=\"{{ \$b ? 'Open it' : 'Close it' }}\" />"];
        yield 'attribute-like text printed by blade stays' => ["<a {{ \$x ? 'title=\"Hi there\"' : '' }} href=\"/\"><svg></svg></a>"];
        yield 'attribute-like text inside another value stays' => ["<div data-x=\"a title='Hello there'\"><svg></svg></div>"];
        yield 'attribute-like text inside another value of a dynamic tag stays' => ["<div data-x=\"a title='Hello there'\" class=\"{{ \$c }}\"><svg></svg></div>"];
        yield 'bound attribute stays' => ['<x-forms.input :label="$label" />'];
        yield 'attribute inside script stays' => ['<script>let a = \'<b title="Hi there">\';</script>'];
        yield 'livewire tag stays' => ['<livewire:server.navbar title="Server details" />'];
    }

    #[DataProvider('untouched')]
    public function testLeavesNonDisplayAttributesUnchanged(string $source): void
    {
        self::assertSame($source, $this->transform($source));
    }

    public function testPropUsedInLogicIsNotTranslated(): void
    {
        $source = '<x-modal-confirmation title="Delete server?" step2ButtonText="Continue" confirmationText="my-server" />';
        $result = $this->transformer->transform($source, 'views/test.blade.php');

        self::assertSame(
            "<x-modal-confirmation :title=\"__('Delete server?')\" step2ButtonText=\"Continue\" confirmationText=\"my-server\" />",
            $result->output,
        );
        self::assertContains(SkipReason::LogicProp, array_map(static fn ($s) => $s->reason, $result->skips));
    }

    public function testLogicValueOfDisplayPropStaysLiteralAtCallSites(): void
    {
        $rules = new RuleSet(
            components: ['modal-confirmation' => ['step2ButtonText']],
            componentSinks: ['modal-confirmation' => ['step2ButtonText' => 'text']],
            logicValues: ['modal-confirmation' => ['step2ButtonText' => ['Continue']]],
        );
        $props = ComponentProps::fromTemplates($rules, ['modal-confirmation' => "@if (\$step2ButtonText === 'Continue') x @endif {{ \$step2ButtonText }}"]);
        $source = "<x-modal-confirmation step2ButtonText=\"Continue\" />\n<x-modal-confirmation step2ButtonText=\"Permanently Delete\" />\n"
            . "<x-modal-confirmation :step2ButtonText=\"\$app ? 'Continue' : 'Restart Database'\" />";
        $result = (new BladeFileTransformer($rules, $props))->transform($source, 'views/livewire/x.blade.php');

        self::assertSame(
            "<x-modal-confirmation step2ButtonText=\"Continue\" />\n<x-modal-confirmation :step2ButtonText=\"__('Permanently Delete')\" />\n"
            . "<x-modal-confirmation :step2ButtonText=\"\$app ? 'Continue' : __('Restart Database')\" />",
            $result->output,
        );
        self::assertSame([], $result->skips);
    }

    public function testBooleanPresenceChecksAndCommentedCodeAreNotLogic(): void
    {
        $rules = new RuleSet(components: ['card' => ['label', 'helper']]);
        $props = ComponentProps::fromTemplates(
            $rules,
            ['card' => "@if (!\$label && \$helper)\n<i>{{ \$helper }}</i>\n@endif\n@if (filled(\$label ?? \$helper)) <b>{{ \$label }}</b> @endif"],
            ['card' => "<?php class Card { public function render() { // \$this->label = Str::title(\$this->label);\n return view('x'); } }"],
        );

        self::assertSame(PropSink::Text, $props->resolve('card', 'label'));
        self::assertSame(PropSink::Text, $props->resolve('card', 'helper'));
    }

    public function testComparisonInsideConditionIsLogic(): void
    {
        $rules = new RuleSet(components: ['card' => ['label']]);
        $props = ComponentProps::fromTemplates($rules, ['card' => "@if (\$ready && \$label === 'Continue') x @endif {{ \$label }}"]);

        self::assertSame(SkipReason::LogicProp, $props->resolve('card', 'label'));
    }

    public function testManualSinkOverridesAnalysis(): void
    {
        $rules = new RuleSet(components: ['section' => ['title']], componentSinks: ['section' => ['title' => 'text']]);
        $props = ComponentProps::fromTemplates($rules, ['section' => "<section data-title=\"{{ 'About '.\$title }}\">{{ \$title }}</section>"]);

        self::assertSame(PropSink::Text, $props->resolve('section', 'title'));
    }

    public function testPassThroughFollowsManualSinkOfTargetComponent(): void
    {
        $rules = new RuleSet(components: ['modal' => ['disabledTooltip']], componentSinks: ['button' => ['tooltip' => 'text']]);
        $props = ComponentProps::fromTemplates($rules, [
            'modal' => '<x-button :tooltip="$disabledTooltip" />',
            'button' => "{{ \$tooltip ?: 'Default' }}",
        ]);

        self::assertSame(PropSink::Text, $props->resolve('modal', 'disabledTooltip'));
    }

    public function testRawEchoOfUpstreamKeyBecomesSafeHelperFromItsEnglish(): void
    {
        $transformer = new BladeFileTransformer($this->rules, $this->props, [
            'repository.url' => "<span class='text-helper'>Examples</span><br>Use it.",
            'plain.key' => 'Plain words.',
        ]);
        $result = $transformer->transform(
            "<x-forms.input id=\"a\" helper=\"{!! __('repository.url') !!}\" />
<x-forms.input id=\"b\" helper=\"{!! __('plain.key') !!}\" />",
            'v.blade.php',
        );

        self::assertSame(
            "<x-forms.input id=\"a\" :helper=\"(string) __h('<0>Examples</0><1/>Use it.', [['<span class=\'text-helper\'>', '</span>'], '<br>'])\" />
"
            . "<x-forms.input id=\"b\" :helper=\"(string) __h('Plain words.')\" />",
            $result->output,
        );
        self::assertSame([['<0>Examples</0><1/>Use it.', 'prop-html'], ['Plain words.', 'prop-html']], array_map(static fn ($o) => [$o->key, $o->kind], $result->occurrences));
    }

    public function testRawEchoOfUnknownKeyStays(): void
    {
        $transformer = new BladeFileTransformer($this->rules, $this->props, ['repository.url' => 'x']);
        $source = "<x-forms.input id=\"a\" helper=\"{!! __('other.key') !!}\" />";

        self::assertSame($source, $transformer->transform($source, 'v.blade.php')->output);
    }

    public function testRecordsLiteralTernaryAttributesAsEchoLiterals(): void
    {
        $result = $this->transformer->transform(
            "<button title=\"{{ \$on ? 'Stop it' : 'Start it' }}\"></button>\n<x-forms.input id=\"p\" label=\"{{ \$a ? 'Initial password' : 'Password' }}\" />",
            'views/x.blade.php',
        );

        self::assertSame(
            [['Stop it', 1, 'echo-literal'], ['Start it', 1, 'echo-literal'], ['Initial password', 2, 'echo-literal'], ['Password', 2, 'echo-literal']],
            array_map(static fn ($o) => [$o->key, $o->line, $o->kind], $result->occurrences),
        );
        self::assertSame([], $result->skips);
    }

    public function testRecordsAttributeOccurrences(): void
    {
        $result = $this->transformer->transform("<div>\n<x-forms.input id=\"n\" label=\"Name\" />\n</div>", 'views/x.blade.php');

        self::assertSame([['Name', 2, 'prop-text']], array_map(static fn ($o) => [$o->key, $o->line, $o->kind], $result->occurrences));
    }
}
