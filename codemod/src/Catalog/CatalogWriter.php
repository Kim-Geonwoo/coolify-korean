<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Catalog;

use CoolifyKo\Codemod\Cli\FileTree;

/**
 * 변환 결과로 산출물을 쓴다.
 * - i18n/en.json: Laravel JSON 번역 형식(키 → 영어 문구). 업스트림 lang/en.json 키도 포함한다.
 * - i18n/catalog.json: 키별 위치·종류·자리표시자, markup(영어에 태그가 있어 번역문의 태그가 영어와 같아야 하는 키)
 * - reports/coverage.json·coverage.md: 변환·건너뜀 집계
 * - reports/edits.jsonl: 변환한 곳의 원문 조각과 바꾼 조각(동등성 검사 입력)
 */
final class CatalogWriter
{
    private const JSON_FLAGS = JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR;

    /**
     * @param list<Occurrence> $occurrences
     * @param list<Skip> $skips
     * @param array<string, string> $upstreamLines 업스트림 lang/en.json(키 → 영어)
     * @param array{views: int, changedViews: int} $files
     * @param list<array{file: string, line: int, text: string}> $remaining
     */
    public static function write(string $dir, string $version, array $occurrences, array $skips, array $upstreamLines, array $files, array $remaining): void
    {
        $english = $upstreamLines;
        $keys = [];
        foreach ($occurrences as $o) {
            if ($o->key === '') {
                continue;
            }
            $english[$o->key] ??= $o->key;
            $entry = $keys[$o->key] ?? ['english' => '', 'kinds' => [], 'placeholders' => [], 'occurrences' => []];
            $entry['kinds'][$o->kind] = true;
            foreach ($o->placeholders as $p) {
                $entry['placeholders'][$p] = true;
            }
            $entry['occurrences'][] = ['file' => $o->file, 'line' => $o->line, 'kind' => $o->kind];
            $keys[$o->key] = $entry;
        }
        foreach ($upstreamLines as $key => $line) {
            $keys[$key] ??= ['english' => '', 'kinds' => [], 'placeholders' => [], 'occurrences' => []];
            $keys[$key]['kinds']['upstream-lang'] = true;
        }
        ksort($english, SORT_STRING);
        ksort($keys, SORT_STRING);
        foreach ($keys as $key => $entry) {
            $keys[$key] = [
                'english' => $english[$key],
                'markup' => preg_match('/<\/?[A-Za-z]|<\/?\d+\/?>/', $english[$key]) === 1,
                'kinds' => array_keys($entry['kinds']),
                'placeholders' => array_keys($entry['placeholders']),
                'occurrences' => $entry['occurrences'],
            ];
        }

        FileTree::write($dir . '/i18n/en.json', json_encode($english, self::JSON_FLAGS) . "\n");
        FileTree::write($dir . '/i18n/catalog.json', json_encode(['version' => $version, 'keys' => $keys], self::JSON_FLAGS) . "\n");

        $conversions = array_values(array_filter($occurrences, static fn (Occurrence $o): bool => $o->isConversion()));
        $byReason = [];
        foreach ($skips as $skip) {
            $byReason[$skip->reason->value] = ($byReason[$skip->reason->value] ?? 0) + 1;
        }
        arsort($byReason);
        $summary = ['views' => $files['views'], 'changedViews' => $files['changedViews'], 'converted' => count($conversions), 'skipped' => count($skips)];
        $coverage = [
            'version' => $version,
            'summary' => $summary,
            'uniqueKeys' => count($english),
            'skippedByReason' => $byReason,
            'remainingTextFragments' => count($remaining),
            'skips' => array_map(static fn (Skip $s): array => ['file' => $s->file, 'line' => $s->line, 'reason' => $s->reason->value, 'excerpt' => $s->excerpt], $skips),
            'remaining' => $remaining,
        ];
        FileTree::write($dir . '/reports/coverage.json', json_encode($coverage, self::JSON_FLAGS) . "\n");
        FileTree::write($dir . '/reports/coverage.md', self::markdown($version, $summary, count($english), $byReason, $skips, $remaining));

        $lines = '';
        foreach ($conversions as $o) {
            $edit = ['file' => $o->file, 'line' => $o->line, 'kind' => $o->kind, 'key' => $o->key, 'original' => $o->original, 'replacement' => $o->replacement];
            if ($o->counts !== []) {
                $edit['counts'] = $o->counts;
            }
            if ($o->alsoKeys !== []) {
                $edit['keys'] = $o->alsoKeys;
            }
            $lines .= json_encode($edit, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
        }
        FileTree::write($dir . '/reports/edits.jsonl', $lines);
    }

    /**
     * @param array{views: int, changedViews: int, converted: int, skipped: int} $summary
     * @param array<string, int> $byReason
     * @param list<Skip> $skips
     * @param list<array{file: string, line: int, text: string}> $remaining
     */
    private static function markdown(string $version, array $summary, int $uniqueKeys, array $byReason, array $skips, array $remaining): string
    {
        $md = "# 변환 커버리지 ({$version})\n\n";
        $md .= "| 항목 | 값 |\n|---|---|\n";
        $md .= "| 대상 템플릿 | {$summary['views']} |\n| 바뀐 템플릿 | {$summary['changedViews']} |\n";
        $md .= "| 바꾼 곳 | {$summary['converted']} |\n| 고유 키(업스트림 포함) | {$uniqueKeys} |\n";
        $md .= "| 건너뛴 곳 | {$summary['skipped']} |\n| 변환 뒤 남은 영어 텍스트 조각 | " . count($remaining) . " |\n\n";
        if ($byReason !== []) {
            $md .= "## 건너뛴 이유\n\n| 이유 | 수 |\n|---|---|\n";
            foreach ($byReason as $reason => $count) {
                $md .= "| `{$reason}` | {$count} |\n";
            }
            $md .= "\n";
        }
        if ($skips !== []) {
            $md .= "## 건너뛴 곳\n\n";
            foreach ($skips as $skip) {
                $md .= '- `' . $skip->reason->value . '` ' . $skip->file . ':' . $skip->line . ' — ' . str_replace('|', '\\|', $skip->excerpt) . "\n";
            }
            $md .= "\n";
        }
        if ($remaining !== []) {
            $md .= "## 남은 영어 텍스트 조각\n\n";
            foreach ($remaining as $r) {
                $md .= '- ' . $r['file'] . ':' . $r['line'] . ' — ' . str_replace('|', '\\|', $r['text']) . "\n";
            }
        }

        return $md;
    }
}
