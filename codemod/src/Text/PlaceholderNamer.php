<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Text;

use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\Node\Scalar;

/** 치환값 식에서 사람이 읽을 수 있는 Laravel 자리표시자 이름(:name)을 만든다. */
final class PlaceholderNamer
{
    private const FORMATTING_METHODS = [
        'limit', 'trim', 'value', 'tostring', 'diffforhumans', 'format', 'headline', 'title', 'upper', 'lower',
        'ucfirst', 'plural', 'singular', 'words', 'snake', 'kebab', 'studly', 'camel', 'replace', 'after', 'before',
    ];

    public static function baseName(Expr $expr): string
    {
        return self::normalize(self::rawName($expr));
    }

    private static function rawName(Expr $expr): string
    {
        return match (true) {
            $expr instanceof Expr\Variable => is_string($expr->name) ? $expr->name : 'value',
            $expr instanceof Expr\PropertyFetch, $expr instanceof Expr\NullsafePropertyFetch => $expr->name instanceof Identifier ? $expr->name->toString() : 'value',
            $expr instanceof Expr\ArrayDimFetch => $expr->dim instanceof Scalar\String_ ? $expr->dim->value : self::rawName($expr->var),
            $expr instanceof Expr\MethodCall, $expr instanceof Expr\NullsafeMethodCall => self::methodName($expr),
            $expr instanceof Expr\FuncCall => self::functionName($expr),
            $expr instanceof Expr\StaticCall => self::firstArgName($expr->args) ?? 'value',
            $expr instanceof Expr\BinaryOp\Coalesce => self::rawName($expr->left),
            $expr instanceof Expr\Cast => self::rawName($expr->expr),
            default => 'value',
        };
    }

    private static function methodName(Expr\MethodCall|Expr\NullsafeMethodCall $expr): string
    {
        $method = $expr->name instanceof Identifier ? $expr->name->toString() : 'value';
        if (in_array(strtolower($method), self::FORMATTING_METHODS, true)) {
            return self::rawName($expr->var);
        }

        return $method;
    }

    private static function functionName(Expr\FuncCall $expr): string
    {
        $name = $expr->name instanceof Name ? $expr->name->toLowerString() : '';
        if (($name === 'data_get' || $name === 'data_get_str') && isset($expr->args[1]) && $expr->args[1] instanceof Arg && $expr->args[1]->value instanceof Scalar\String_) {
            $path = explode('.', $expr->args[1]->value->value);

            return (string) end($path);
        }
        if ($name === 'count') {
            return 'count';
        }

        return self::firstArgName($expr->args) ?? ($name !== '' ? $name : 'value');
    }

    /** @param array<mixed> $args */
    private static function firstArgName(array $args): ?string
    {
        $first = $args[0] ?? null;

        return $first instanceof Arg ? self::rawName($first->value) : null;
    }

    private static function normalize(string $name): string
    {
        $snake = strtolower((string) preg_replace('/(?<=[a-z0-9])([A-Z])/', '_$1', $name));
        $snake = trim((string) preg_replace('/[^a-z0-9]+/', '_', $snake), '_');
        if ($snake === '') {
            return 'value';
        }

        return ctype_digit($snake[0]) ? 'v' . $snake : $snake;
    }
}
