<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use Stillat\BladeParser\Nodes\AbstractNode;

/** 원본의 [start, end) 구간 하나. 모든 조각을 이어 붙이면 원본이 된다. */
final readonly class Segment
{
    /**
     * @param list<array{int, int, AbstractNode}> $inner 태그 조각 안에 낀 Blade 노드(원본 기준 [시작, 끝), 노드)
     */
    public function __construct(
        public SegmentKind $kind,
        public int $start,
        public int $end,
        public string $source,
        public Context $context,
        public ?Tag $tag = null,
        public ?AbstractNode $node = null,
        public array $inner = [],
    ) {
    }
}
