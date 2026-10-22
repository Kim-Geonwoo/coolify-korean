<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Catalog\Occurrence;
use CoolifyKo\Codemod\Catalog\Skip;

final readonly class TransformResult
{
    /**
     * @param list<Occurrence> $occurrences
     * @param list<Skip> $skips
     */
    public function __construct(
        public string $output,
        public array $occurrences,
        public array $skips,
    ) {
    }

    public function changed(string $source): bool
    {
        return $this->output !== $source;
    }
}
