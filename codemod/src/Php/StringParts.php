<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Php;

use PhpParser\Node\Expr;
use PhpParser\Node\InterpolatedStringPart;
use PhpParser\Node\Scalar;

/** 문자열 리터럴·보간 문자열·이어 붙이기를 글자 조각과 식 조각의 목록으로 편다. */
final class StringParts
{
    /**
     * 글자 조각이 하나도 없으면(식만 이어 붙였으면) 문구가 아니므로 null.
     *
     * @return list<string|Expr>|null
     */
    public static function flatten(Expr $expr): ?array
    {
        if ($expr instanceof Scalar\String_) {
            return [$expr->value];
        }
        if ($expr instanceof Scalar\InterpolatedString) {
            $parts = [];
            foreach ($expr->parts as $part) {
                $parts[] = $part instanceof InterpolatedStringPart ? $part->value : $part;
            }

            return $parts;
        }
        if ($expr instanceof Expr\BinaryOp\Concat) {
            $left = self::flatten($expr->left) ?? [$expr->left];
            $right = self::flatten($expr->right) ?? [$expr->right];
            $parts = [...$left, ...$right];

            return array_filter($parts, 'is_string') === [] ? null : $parts;
        }

        return null;
    }
}
