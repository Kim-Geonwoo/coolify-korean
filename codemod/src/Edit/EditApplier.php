<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Edit;

use LogicException;

final class EditApplier
{
    /** @param list<Edit> $edits */
    public static function apply(string $source, array $edits): string
    {
        usort($edits, static fn (Edit $a, Edit $b): int => $b->start <=> $a->start);
        $limit = strlen($source);
        foreach ($edits as $edit) {
            if ($edit->start < 0 || $edit->end < $edit->start || $edit->end > $limit) {
                throw new LogicException(sprintf('편집 구간이 잘못되었거나 다른 편집과 겹칩니다: [%d, %d)', $edit->start, $edit->end));
            }
            $source = substr($source, 0, $edit->start) . $edit->replacement . substr($source, $edit->end);
            $limit = $edit->start;
        }

        return $source;
    }
}
