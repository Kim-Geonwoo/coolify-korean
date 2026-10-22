<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Cli;

use RuntimeException;
use Throwable;

final class Application
{
    /**
     * @param list<string> $argv
     * @param resource $stderr
     */
    public function run(array $argv, $stderr): int
    {
        try {
            $command = $argv[1] ?? '';
            $options = self::options(array_slice($argv, 2));

            return match ($command) {
                'transform' => (new TransformCommand())->execute($options),
                default => throw new RuntimeException('사용법: codemod transform --source DIR --out DIR --artifacts DIR --rules FILE --version V'),
            };
        } catch (Throwable $e) {
            fwrite($stderr, 'codemod: ' . $e->getMessage() . PHP_EOL);

            return 1;
        }
    }

    /**
     * @param list<string> $args
     * @return array<string, string>
     */
    private static function options(array $args): array
    {
        $options = [];
        for ($i = 0, $n = count($args); $i < $n; $i++) {
            if (!str_starts_with($args[$i], '--')) {
                throw new RuntimeException(sprintf('알 수 없는 인자: %s', $args[$i]));
            }
            $name = substr($args[$i], 2);
            $value = $args[$i + 1] ?? null;
            if ($value === null || str_starts_with($value, '--')) {
                throw new RuntimeException(sprintf('--%s 값이 없습니다.', $name));
            }
            $options[$name] = $value;
            $i++;
        }

        return $options;
    }
}
