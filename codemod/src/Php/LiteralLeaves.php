<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Php;

use PhpParser\Node\Expr;
use PhpParser\Node\Scalar;

/**
 * PHP 식에서 화면에 나가는 값 자리의 문자열 리터럴을 찾는다.
 * 결과 자리: 식 전체, 삼항의 두 가지(조건 제외, `?:`는 오른쪽만), `??`의 오른쪽, match 가지의 결과(조건 제외).
 * 이어 붙이기·호출·보간 문자열은 결과 자리라도 건너뛴다(이어 붙이기는 results로 받아 따로 다룰 수 있다).
 */
final class LiteralLeaves
{
    /**
     * @param int $prefix 식을 읽을 때 앞에 붙인 글자 수(SafeExpression은 '<?php ')
     * @return list<array{int, int, string}> [시작, 끝(배타), 값] — 위치는 읽은 코드 기준
     */
    public static function find(Expr $expr, int $prefix): array
    {
        $leaves = [];
        foreach (self::results($expr) as $result) {
            if ($result instanceof Scalar\String_) {
                $leaves[] = [(int) $result->getStartFilePos() - $prefix, (int) $result->getEndFilePos() + 1 - $prefix, $result->value];
            }
        }

        return $leaves;
    }

    /**
     * 결과 자리의 식들. 삼항·??·match는 가지로 풀고, 그 밖의 식은 그대로 하나다.
     *
     * @return list<Expr>
     */
    public static function results(Expr $expr): array
    {
        return match (true) {
            $expr instanceof Expr\Ternary => [...($expr->if === null ? [] : self::results($expr->if)), ...self::results($expr->else)],
            $expr instanceof Expr\BinaryOp\Coalesce => self::results($expr->right),
            $expr instanceof Expr\Match_ => array_merge([], ...array_map(static fn ($arm): array => self::results($arm->body), $expr->arms)),
            default => [$expr],
        };
    }
}
