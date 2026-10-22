<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Cli;

use RuntimeException;

/**
 * 폴더 아래 파일을 정렬된 상대 경로로 돌려준다.
 * SPL 디렉터리 순회는 일부 공유 폴더(Docker Desktop)에서 항목을 빠뜨려 scandir만 쓴다.
 */
final class FileTree
{
    /** @return list<string> */
    public static function list(string $root, string $suffix): array
    {
        if (!is_dir($root)) {
            throw new RuntimeException(sprintf('폴더가 없습니다: %s', $root));
        }
        $found = [];
        self::walk($root, '', $suffix, $found);
        sort($found, SORT_STRING);

        return $found;
    }

    /** @param list<string> $found */
    private static function walk(string $root, string $relative, string $suffix, array &$found): void
    {
        $dir = $relative === '' ? $root : $root . '/' . $relative;
        $entries = scandir($dir);
        if ($entries === false) {
            throw new RuntimeException(sprintf('폴더를 읽지 못했습니다: %s', $dir));
        }
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $relative === '' ? $entry : $relative . '/' . $entry;
            if (is_dir($root . '/' . $path)) {
                self::walk($root, $path, $suffix, $found);
            } elseif (str_ends_with($entry, $suffix)) {
                $found[] = $path;
            }
        }
    }

    public static function write(string $path, string $content): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException(sprintf('폴더를 만들지 못했습니다: %s', $dir));
        }
        if (file_put_contents($path, $content) === false) {
            throw new RuntimeException(sprintf('파일을 쓰지 못했습니다: %s', $path));
        }
    }

    public static function read(string $path): string
    {
        $content = file_get_contents($path);
        if ($content === false) {
            throw new RuntimeException(sprintf('파일을 읽지 못했습니다: %s', $path));
        }

        return $content;
    }
}
