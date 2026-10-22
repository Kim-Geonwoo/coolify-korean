<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Php;

use PhpParser\Node\Expr;
use PhpParser\Node\Scalar;
use PhpParser\NodeFinder;
use PhpParser\ParserFactory;
use RuntimeException;

/** config/app.php의 providers 배열 끝에 서비스 프로바이더 한 줄을 더한다(서식은 그대로). */
final class ProviderRegistration
{
    public static function register(string $config, string $providerClass): string
    {
        $line = '\\' . ltrim($providerClass, '\\') . '::class,';
        if (str_contains($config, ltrim($providerClass, '\\') . '::class')) {
            return $config;
        }
        $statements = (new ParserFactory())->createForNewestSupportedVersion()->parse($config) ?? [];
        $providers = null;
        foreach ((new NodeFinder())->findInstanceOf($statements, Expr\ArrayItem::class) as $item) {
            if ($item->key instanceof Scalar\String_ && $item->key->value === 'providers' && $item->value instanceof Expr\Array_) {
                $providers = $item->value;
            }
        }
        if ($providers === null || $providers->items === []) {
            throw new RuntimeException('config/app.php에서 providers 배열을 찾지 못했습니다.');
        }
        $last = $providers->items[array_key_last($providers->items)];
        $insertAt = (int) $last->getEndFilePos() + 1;
        if (($config[$insertAt] ?? '') === ',') {
            $insertAt++;
        } else {
            $config = substr($config, 0, $insertAt) . ',' . substr($config, $insertAt);
            $insertAt++;
        }
        $lineStart = (int) strrpos(substr($config, 0, (int) $last->getStartFilePos()), "\n") + 1;
        $indent = substr($config, $lineStart, (int) $last->getStartFilePos() - $lineStart);

        return substr($config, 0, $insertAt) . "\n" . $indent . $line . substr($config, $insertAt);
    }
}
