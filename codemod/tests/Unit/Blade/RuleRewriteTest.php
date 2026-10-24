<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Blade;

use CoolifyKo\Codemod\Blade\BladeFileTransformer;
use CoolifyKo\Codemod\Blade\TransformResult;
use CoolifyKo\Codemod\Rules\RuleSet;
use PHPUnit\Framework\TestCase;

/**
 * 규칙 파일의 수동 치환(rewrites). 식·삼항·단복수가 뒤섞여 변환기가 건너뛰는 문장(4.5.0 패스키·보안 패치 도움말 …)을
 * 사람이 쓴 번역 호출 꼴로 바꾼다. 원문이 정확히 한 번 있을 때만 바꾸고, 상류가 원문을 바꾸면 보고서에 남긴다.
 */
final class RuleRewriteTest extends TestCase
{
    private const FIND = "{{ \$passkey->authenticator ?? 'Passkey' }}\n    · Added {{ \$passkey->created_at->diffForHumans() }}";

    private const REPLACE = "{{ \$passkey->authenticator ?? __('Passkey') }}\n    · {{ __('Added :time', ['time' => \$passkey->created_at->diffForHumans()]) }}";

    private static function transform(string $source, string $path = 'views/livewire/profile/passkeys.blade.php'): TransformResult
    {
        $rules = new RuleSet(brands: ['Coolify'], rewrites: [
            'livewire.profile.passkeys' => [[
                'find' => self::FIND,
                'replace' => self::REPLACE,
                'kind' => 'rich',
                'keys' => [['key' => 'Passkey'], ['key' => 'Added :time', 'placeholders' => ['time']]],
            ]],
        ]);

        return (new BladeFileTransformer($rules))->transform($source, $path);
    }

    public function testReplacesTheExactSnippetOnceAndRecordsItsKeys(): void
    {
        $result = self::transform("<p class=\"x\">\n    " . self::FIND . "\n</p>");

        self::assertSame("<p class=\"x\">\n    " . self::REPLACE . "\n</p>", $result->output);
        self::assertSame([['Passkey', 'rich', []], ['Added :time', 'rich', ['time']]], array_map(static fn ($o): array => [$o->key, $o->kind, $o->placeholders], $result->occurrences));
        self::assertSame(self::FIND, $result->occurrences[0]->original);
        self::assertSame(self::REPLACE, $result->occurrences[0]->replacement);
        // 동등성 게이트의 가짜 언어 검사가 치환에 든 키를 모두 번역해 보도록 편집 기록에 함께 남긴다
        self::assertSame(['Added :time'], $result->occurrences[0]->alsoKeys);
    }

    public function testLeavesTheFileAndReportsWhenTheSnippetIsMissingOrRepeated(): void
    {
        foreach (['<p>Something else</p>', '<p>' . self::FIND . '</p><p>' . self::FIND . '</p>'] as $source) {
            $result = self::transform($source);

            self::assertStringNotContainsString("__('Added :time'", $result->output);
            self::assertContains('rewrite-missed', array_map(static fn ($skip) => $skip->reason->value, $result->skips));
        }
    }

    public function testComparesTheEditByTheRuleKindAndKeepsEachKeyKind(): void
    {
        $rules = new RuleSet(brands: ['Coolify'], rewrites: ['livewire.x' => [[
            'find' => 'description="{{ $n }} {{ Str::plural(\'variable\', $n) }}."',
            'replace' => ':description="trans_choice(\':count variable.|:count variables.\', $n)"',
            'kind' => 'prop-text',
            'counts' => ['$n'],
            'keys' => [['key' => ':count variable.|:count variables.', 'kind' => 'plural', 'placeholders' => ['count']]],
        ]]]);
        $result = (new BladeFileTransformer($rules))->transform('<x-item description="{{ $n }} {{ Str::plural(\'variable\', $n) }}." />', 'views/livewire/x.blade.php');

        self::assertSame([['prop-text', ['$n']], ['plural', []]], array_map(static fn ($o): array => [$o->kind, $o->counts], $result->occurrences));
    }

    public function testOnlyTheNamedViewIsRewritten(): void
    {
        $source = '<p>' . self::FIND . '</p>';

        self::assertStringNotContainsString("__('Added :time'", self::transform($source, 'views/livewire/profile/other.blade.php')->output);
    }
}
