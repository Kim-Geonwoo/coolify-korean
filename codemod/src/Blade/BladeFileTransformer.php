<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Catalog\Occurrence;
use CoolifyKo\Codemod\Catalog\Skip;
use CoolifyKo\Codemod\Edit\Edit;
use CoolifyKo\Codemod\Edit\EditApplier;
use CoolifyKo\Codemod\Php\SafeExpression;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\TextClassifier;

final class BladeFileTransformer
{
    private readonly RunBuilder $runs;

    private readonly SentenceBuilder $sentences;

    private readonly AttributeRewriter $attributes;

    private readonly DisplaySiteRewriter $displaySites;

    private readonly ScriptCallRewriter $scriptCalls;

    private readonly RuleRewriter $ruleRewrites;

    /** @param array<string, string> $upstreamLines 업스트림 lang/en.json(키 → 영어) */
    public function __construct(RuleSet $rules, ?ComponentProps $props = null, array $upstreamLines = [])
    {
        $expressions = new SafeExpression();
        $classifier = new TextClassifier($rules->brands);
        $this->runs = new RunBuilder($expressions);
        $this->sentences = new SentenceBuilder($classifier);
        $props ??= ComponentProps::none();
        $this->attributes = new AttributeRewriter($rules, $props, $classifier, $expressions, $upstreamLines);
        $this->displaySites = new DisplaySiteRewriter($rules, $classifier, $expressions, $props);
        $this->scriptCalls = new ScriptCallRewriter($rules, $classifier);
        $this->ruleRewrites = new RuleRewriter($rules);
    }

    public function transform(string $source, string $path): TransformResult
    {
        $segments = HtmlStream::fromSource($source)->segments();
        /** @var list<SentenceOutcome> $outcomes */
        $outcomes = [];
        /** @var list<array{int, int}> $sentenceRanges */
        $sentenceRanges = [];
        /** @var array<int, true> $standaloneEchoes 문장 후보 안에서 글자 없이 혼자 있는 echo의 시작 위치 */
        $standaloneEchoes = [];
        foreach ($this->runs->build($segments, $source) as $run) {
            foreach ($this->sentences->buildAll($run, $source) as $outcome) {
                $outcomes[] = $outcome;
                if ($outcome->edit !== null) {
                    $sentenceRanges[] = [$outcome->edit->start, $outcome->edit->end];
                }
            }
            foreach (self::standaloneEchoes($run) as $start) {
                $standaloneEchoes[$start] = true;
            }
        }
        foreach ($segments as $segment) {
            if ($segment->kind === SegmentKind::Blade) {
                array_push($outcomes, ...$this->attributes->component($segment));
            } elseif ($segment->kind === SegmentKind::Tag && !self::insideAny($segment, $sentenceRanges)) {
                array_push($outcomes, ...$this->attributes->html($segment));
            } else {
                array_push($outcomes, ...$this->scriptCalls->rewrite($segment));
            }
        }
        // 규칙 파일의 수동 치환 구간은 다른 규칙의 결과를 버리고 치환만 쓴다
        [$ruleOutcomes, $ruleRanges] = $this->ruleRewrites->rewrite($source, $path);
        $outcomes = array_values(array_filter($outcomes, static fn (SentenceOutcome $outcome): bool => !self::overlapsAny($outcome, $ruleRanges)));
        $taken = $ruleRanges;
        foreach ($outcomes as $outcome) {
            if ($outcome->edit !== null) {
                $taken[] = [$outcome->edit->start, $outcome->edit->end];
            }
        }
        array_push($outcomes, ...$this->displaySites->rewrite($segments, $path, $taken, $standaloneEchoes));
        $outcomes = array_values(array_filter($outcomes, static fn (SentenceOutcome $outcome): bool => !self::overlapsAny($outcome, $ruleRanges)));
        $outcomes = $this->displaySites->wrapPlaceholders($segments, $outcomes, $path);
        array_push($outcomes, ...$ruleOutcomes);
        usort($outcomes, static fn (SentenceOutcome $a, SentenceOutcome $b): int => $a->start <=> $b->start);

        /** @var list<Edit> $edits */
        $edits = [];
        $occurrences = [];
        $skips = [];
        foreach ($outcomes as $outcome) {
            if ($outcome->edit !== null) {
                $edits[] = $outcome->edit;
                $occurrences[] = new Occurrence(
                    $outcome->key,
                    $path,
                    self::line($source, $outcome->edit->start),
                    $outcome->kind,
                    $outcome->placeholders,
                    substr($source, $outcome->edit->start, $outcome->edit->end - $outcome->edit->start),
                    $outcome->edit->replacement,
                    $outcome->counts,
                    $outcome->alsoKeys,
                );
            } elseif ($outcome->skip !== null) {
                $skips[] = new Skip($path, self::line($source, $outcome->start), $outcome->skip, $outcome->excerpt);
            } elseif ($outcome->key !== '') {
                $occurrences[] = new Occurrence($outcome->key, $path, self::line($source, $outcome->start), $outcome->kind, $outcome->placeholders);
            }
        }

        return new TransformResult(EditApplier::apply($source, $edits), $occurrences, $skips);
    }

    /**
     * 문장 후보에 글자가 든 다른 내용(글자·태그 덩어리)이 없으면 그 안의 echo 시작 위치들.
     * 문장 속 echo만 번역하면 "변경 pending" 같은 반쪽 번역이 되므로, 출력 지점 번역은 이런 echo에만 한다.
     *
     * @return list<int>
     */
    private static function standaloneEchoes(Run $run): array
    {
        foreach ($run->items as $item) {
            if ($item->kind === RunItemKind::Echo || !$item->isContent()) {
                continue;
            }
            // code·font-mono 같은 덩어리는 태그 속성(class 이름 등)이 아니라 안쪽 글자만 본다
            $text = html_entity_decode($item->kind === RunItemKind::Opaque ? strip_tags($item->source) : $item->source, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if (preg_match('/\p{L}/u', (string) preg_replace('/\{\{.*?\}\}|\{!!.*?!!\}/s', ' ', $text)) === 1) {
                return [];
            }
        }

        return $run->echoes;
    }

    /** @param list<array{int, int}> $ranges */
    private static function insideAny(Segment $segment, array $ranges): bool
    {
        foreach ($ranges as [$start, $end]) {
            if ($segment->start >= $start && $segment->end <= $end) {
                return true;
            }
        }

        return false;
    }

    /**
     * 결과가 수동 치환 구간과 겹치는지(편집은 구간이 겹치면, 편집 없는 기록은 시작 위치가 안에 있으면).
     *
     * @param list<array{int, int}> $ranges
     */
    private static function overlapsAny(SentenceOutcome $outcome, array $ranges): bool
    {
        foreach ($ranges as [$start, $end]) {
            $overlaps = $outcome->edit !== null
                ? $outcome->edit->start < $end && $outcome->edit->end > $start
                : $outcome->start >= $start && $outcome->start < $end;
            if ($overlaps) {
                return true;
            }
        }

        return false;
    }

    private static function line(string $source, int $offset): int
    {
        return substr_count($source, "\n", 0, $offset) + 1;
    }
}
