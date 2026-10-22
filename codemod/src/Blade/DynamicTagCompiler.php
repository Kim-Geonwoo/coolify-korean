<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Php\PhpString;
use Stillat\BladeParser\Document\Document;
use Stillat\BladeParser\Nodes\EchoNode;
use Stillat\BladeParser\Nodes\EchoType;
use Stillat\BladeParser\Nodes\LiteralNode;

/**
 * 속성에 echo가 낀 인라인 태그 원문을, Blade가 출력하는 것과 같은 HTML을 만드는 PHP 식으로 옮긴다.
 * Blade는 {{ x }}를 e(x)로, {!! x !!}를 x 그대로 출력하므로 같은 규칙으로 이어 붙인다.
 * 지시어 등 echo가 아닌 Blade가 끼면 옮기지 않는다(null).
 */
final class DynamicTagCompiler
{
    public static function compile(string $raw): ?string
    {
        $parts = [];
        $literal = '';
        foreach (Document::fromText($raw)->getNodes() as $node) {
            if ($node instanceof LiteralNode) {
                $literal .= (string) $node;
                continue;
            }
            if (!$node instanceof EchoNode || $node->type === EchoType::TripleEcho) {
                return null;
            }
            if ($literal !== '') {
                if (!BladeSafety::isSafeInsideEcho($literal)) {
                    return null;
                }
                $parts[] = PhpString::singleQuoted($literal);
                $literal = '';
            }
            $code = trim($node->innerContent);
            if ($code === '' || !BladeSafety::isSafeInsideEcho($code)) {
                return null;
            }
            $parts[] = $node->type === EchoType::RawEcho ? '(' . $code . ')' : 'e(' . $code . ')';
        }
        if ($literal !== '') {
            if (!BladeSafety::isSafeInsideEcho($literal)) {
                return null;
            }
            $parts[] = PhpString::singleQuoted($literal);
        }

        return $parts === [] ? null : implode(' . ', $parts);
    }
}
