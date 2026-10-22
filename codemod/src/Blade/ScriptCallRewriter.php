<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Edit\Edit;
use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\TextClassifier;

/**
 * <script> 안에서 규칙 파일의 scriptCalls(예: window.toast의 첫 인자 = 알림 제목)에 해당하는 문자열 리터럴만
 * 번역된 JS 문자열로 바꾼다. 그 밖의 스크립트는 계속 보호한다.
 */
final class ScriptCallRewriter
{
    public function __construct(
        private readonly RuleSet $rules,
        private readonly TextClassifier $classifier,
    ) {
    }

    /** @return list<SentenceOutcome> */
    public function rewrite(Segment $segment): array
    {
        $elements = $segment->context->elements;
        if ($segment->kind !== SegmentKind::Text || $elements === [] || $elements[array_key_last($elements)] !== 'script') {
            return [];
        }
        $outcomes = [];
        foreach (array_keys($this->rules->scriptCalls) as $call) {
            $pattern = '/(?<![\w.$])' . preg_quote($call, '/') . '\s*\(\s*/';
            if (preg_match_all($pattern, $segment->source, $matches, PREG_OFFSET_CAPTURE) === false) {
                continue;
            }
            foreach ($matches[0] as [$text, $at]) {
                $literalStart = $at + strlen($text);
                $literal = JsLeaves::literalAt($segment->source, $literalStart);
                if ($literal === null) {
                    continue;
                }
                [$literalEnd, $value] = $literal;
                if ($this->classifier->skipReason($value) !== null || !BladeSafety::isSafeInsideEcho($value) || str_contains($value, '"')) {
                    continue;
                }
                $outcomes[] = SentenceOutcome::converted(
                    new Edit($segment->start + $literalStart, $segment->start + $literalEnd, AttributeRewriter::jsString($value)),
                    $value,
                    'script-literal',
                    [],
                );
            }
        }

        return $outcomes;
    }
}
