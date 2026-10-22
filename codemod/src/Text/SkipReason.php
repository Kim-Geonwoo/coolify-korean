<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Text;

enum SkipReason: string
{
    case Empty = 'empty';
    case NoLetters = 'no-letters';
    case BrandOnly = 'brand-only';
    case Technical = 'technical';
    case UnsafeForBlade = 'unsafe-for-blade';
    case ComplexExpression = 'complex-expression';
    case RawEcho = 'raw-echo';
    case DynamicTag = 'dynamic-tag';
    case UnbalancedTags = 'unbalanced-tags';
    case NestedBlade = 'nested-blade';
    case ProtectedContext = 'protected-context';
    case LogicProp = 'logic-prop';
    case UnknownAttribute = 'unknown-attribute';
    case DynamicValue = 'dynamic-value';
    case ParseError = 'parse-error';
    case AttributeLike = 'attribute-like';
}
