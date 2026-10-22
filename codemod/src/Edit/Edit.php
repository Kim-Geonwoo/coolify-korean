<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Edit;

/** 원본 [start, end) 구간을 replacement로 바꾼다. */
final readonly class Edit
{
    public function __construct(
        public int $start,
        public int $end,
        public string $replacement,
    ) {
    }
}
