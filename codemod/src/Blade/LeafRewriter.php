<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Edit\Edit;
use CoolifyKo\Codemod\Php\LiteralLeaves;
use CoolifyKo\Codemod\Php\PhpString;
use CoolifyKo\Codemod\Php\SafeExpression;
use CoolifyKo\Codemod\Php\StringParts;
use CoolifyKo\Codemod\Text\PlaceholderAllocator;
use CoolifyKo\Codemod\Text\TextClassifier;
use PhpParser\Node\Expr;
use PhpParser\Node\Scalar;

/**
 * 화면에 나가는 값 자리의 문자열 리터럴을 __('…')로 바꾸는 편집을 만든다(식 전체, 삼항 가지, ?? 오른쪽, match 결과).
 * echo·컴포넌트 prop·배열 prop·@include 데이터·속성 값 echo가 함께 쓴다. 조건 쪽 문자열은 건드리지 않는다.
 * 컴포넌트에 넘기는 값이면 이어 붙인 라벨($label . ' URL (internal)')도 자리표시자 문장으로 바꾼다(withConcatenations).
 */
final class LeafRewriter
{
    /** SafeExpression::parse가 코드 앞에 붙이는 글자 수 */
    private const PREFIX = 6;

    public function __construct(
        private readonly TextClassifier $classifier,
        private readonly SafeExpression $expressions,
    ) {
    }

    /**
     * @param int $codeStart SafeExpression::parse에 넘긴 코드가 원본에서 시작하는 위치
     * @param bool $jsQuoted 템플릿이 값을 JS 작은따옴표 문자열('{{ $x }}') 안에 넣으면, 번역문의 '·\가 JS를 깨지 않게 addslashes로 감싼다
     * @return list<SentenceOutcome>
     */
    public function literals(Expr $expr, int $codeStart, string $kind, bool $jsQuoted = false): array
    {
        $outcomes = [];
        foreach (LiteralLeaves::results($expr) as $result) {
            if ($result instanceof Scalar\String_) {
                array_push($outcomes, ...$this->literal($result, $codeStart, $kind, $jsQuoted));
            }
        }

        return $outcomes;
    }

    /**
     * literals와 같고, 결과 자리의 이어 붙이기('More information about '.$title)는
     * __('More information about :title', ['title' => $title])로 바꾼다. 치환값은 문자열이 분명한 식만 받는다.
     * 치환값이 템플릿의 고정 라벨($event['label'] 등, $flow가 아는 값)이면 coolify_ko_t로 감싸고, 그 영어 값들을 $labels에 담는다.
     *
     * @param string $code SafeExpression::parse에 넘긴 코드(치환값 원문을 여기서 자른다)
     * @param list<list<array{string, int, int}>> $labels 감싼 치환값마다 그 고정 라벨 값들(LiteralLabelFlow::labelValues 형식)
     * @return list<SentenceOutcome>
     */
    public function withConcatenations(Expr $expr, string $code, int $codeStart, string $kind, ?LiteralLabelFlow $flow = null, array &$labels = []): array
    {
        $outcomes = [];
        foreach (LiteralLeaves::results($expr) as $result) {
            if ($result instanceof Scalar\String_) {
                array_push($outcomes, ...$this->literal($result, $codeStart, $kind, false));
            } elseif ($result instanceof Expr\BinaryOp\Concat) {
                array_push($outcomes, ...$this->concatenation($result, $code, $codeStart, $kind, $flow, $labels));
            }
        }

        return $outcomes;
    }

    /** @return list<SentenceOutcome> */
    private function literal(Scalar\String_ $node, int $codeStart, string $kind, bool $jsQuoted): array
    {
        $value = $node->value;
        if ($this->classifier->skipReason($value) !== null || !BladeSafety::isSafeInsideEcho($value) || str_contains($value, '"')) {
            return [];
        }
        $call = '__(' . PhpString::singleQuoted($value) . ')';
        [$start, $end] = self::span($node, $codeStart);

        return [SentenceOutcome::converted(new Edit($start, $end, $jsQuoted ? 'addslashes(' . $call . ')' : $call), $value, $kind, [])];
    }

    /**
     * @param list<list<array{string, int, int}>> $labels
     * @return list<SentenceOutcome>
     */
    private function concatenation(Expr\BinaryOp\Concat $node, string $code, int $codeStart, string $kind, ?LiteralLabelFlow $flow, array &$labels): array
    {
        $parts = StringParts::flatten($node);
        if ($parts === null) {
            return [];
        }
        $allocator = new PlaceholderAllocator();
        foreach ($parts as $part) {
            if (is_string($part)) {
                $allocator->reserveFrom($part);
            }
        }
        $key = '';
        $replace = [];
        $wrapped = [];
        foreach ($parts as $part) {
            if (is_string($part)) {
                $key .= $part;
                continue;
            }
            if (!$this->expressions->isSafePlaceholderValue($part)) {
                return [];
            }
            $partCode = substr($code, (int) $part->getStartFilePos() - self::PREFIX, (int) $part->getEndFilePos() + 1 - (int) $part->getStartFilePos());
            $name = $allocator->nameFor($partCode, $part);
            $key .= ':' . $name;
            $values = $flow?->labelValues($part);
            if ($values !== null && !isset($replace[$name])) {
                $wrapped[] = $values;
            }
            $replace[$name] = $values === null ? $partCode : 'coolify_ko_t(' . $partCode . ')';
        }
        if ($this->classifier->skipReason((string) preg_replace('/:\w+/', ' ', $key)) !== null || !BladeSafety::isSafeInsideEcho($key) || str_contains($key, '"')) {
            return [];
        }
        $pairs = implode(', ', array_map(
            static fn (string $name, string $value): string => PhpString::singleQuoted($name) . ' => ' . $value,
            array_keys($replace),
            array_values($replace),
        ));
        [$start, $end] = self::span($node, $codeStart);
        array_push($labels, ...$wrapped);

        return [SentenceOutcome::converted(new Edit($start, $end, '__(' . PhpString::singleQuoted($key) . ', [' . $pairs . '])'), $key, $kind, array_keys($replace))];
    }

    /** @return array{int, int} 노드의 원본 [시작, 끝) */
    private static function span(Expr $node, int $codeStart): array
    {
        return [$codeStart + (int) $node->getStartFilePos() - self::PREFIX, $codeStart + (int) $node->getEndFilePos() + 1 - self::PREFIX];
    }
}
