<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Catalog;

use CoolifyKo\Codemod\Text\SkipReason;

/** 번역 후보였지만 바꾸지 않은 곳과 그 이유(커버리지 보고용). */
final readonly class Skip
{
    public function __construct(
        public string $file,
        public int $line,
        public SkipReason $reason,
        public string $excerpt,
    ) {
    }
}
