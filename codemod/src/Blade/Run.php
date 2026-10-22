<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Text\SkipReason;

/** 한 문장 후보: 블록 경계 사이에 이어진 텍스트·echo·인라인 태그. poison이 있으면 통째로 건너뛴다. */
final readonly class Run
{
    /**
     * @param list<RunItem> $items
     * @param list<int> $echoes 이 후보 안 echo의 시작 위치(복잡한 식이라 항목에 넣지 않은 echo 포함)
     */
    public function __construct(
        public array $items,
        public ?SkipReason $poison,
        public array $echoes = [],
    ) {
    }
}
