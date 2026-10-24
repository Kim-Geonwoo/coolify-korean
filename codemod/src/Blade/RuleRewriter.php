<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Edit\Edit;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\SkipReason;

/**
 * 규칙 파일의 수동 치환(rewrites). 식·삼항·단복수가 뒤섞여 다른 규칙이 건너뛰는 문장을 사람이 쓴 번역 호출 꼴로 바꾼다.
 * 원문(find)이 파일에 정확히 한 번 있을 때만 바꾸고, 없거나 여러 번이면 바꾸지 않고 rewrite-missed로 보고한다(상류가 바꿨다).
 * 바꾼 구간은 다른 규칙이 건드리지 않는다. 동등성 검사는 규칙의 kind 방식으로 원문과 바꾼 꼴의 영어 출력을 비교한다.
 */
final class RuleRewriter
{
    public function __construct(private readonly RuleSet $rules)
    {
    }

    /** @return array{list<SentenceOutcome>, list<array{int, int}>} 결과와 바꾼 구간 */
    public function rewrite(string $source, string $path): array
    {
        $view = preg_match('#(?:^|/)views/(.+)\.blade\.php$#', $path, $m) === 1 ? str_replace('/', '.', $m[1]) : null;
        $outcomes = [];
        $ranges = [];
        foreach ($view === null ? [] : ($this->rules->rewrites[$view] ?? []) as $rule) {
            $start = strpos($source, $rule['find']);
            if ($start === false || substr_count($source, $rule['find']) !== 1) {
                $outcomes[] = SentenceOutcome::skipped(SkipReason::RewriteMissed, $start === false ? 0 : $start, mb_substr($rule['find'], 0, 120));
                continue;
            }
            $end = $start + strlen($rule['find']);
            $keys = $rule['keys'];
            $head = $keys[0];
            // 편집은 규칙의 kind로 비교한다(속성 치환에 단복수 키가 와도 속성 방식으로). 키 자신의 종류는 따로 카탈로그에 남긴다
            $outcomes[] = SentenceOutcome::converted(new Edit($start, $end, $rule['replace']), $head['key'], $rule['kind'], $head['placeholders'] ?? [], $rule['counts'] ?? [], array_values(array_unique(array_map(static fn (array $key): string => $key['key'], array_slice($keys, 1)))));
            foreach ($keys as $index => $key) {
                $kind = $key['kind'] ?? $rule['kind'];
                if ($index > 0 || $kind !== $rule['kind']) {
                    $outcomes[] = SentenceOutcome::extracted($key['key'], $start, $kind, $key['placeholders'] ?? []);
                }
            }
            $ranges[] = [$start, $end];
        }

        return [$outcomes, $ranges];
    }
}
