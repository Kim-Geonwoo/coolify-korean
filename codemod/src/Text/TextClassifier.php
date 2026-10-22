<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Text;

/**
 * 화면 문구 후보가 사람이 읽는 문장인지, 번역하면 안 되는 기술 값인지 가른다.
 * 문장 전체가 기술 값 모양일 때만 건너뛴다(문장 안의 경로·URL은 문장으로 본다).
 */
final class TextClassifier
{
    private const COMMAND_WORDS = 'docker|php|git|curl|wget|sudo|npm|pnpm|npx|yarn|bun|composer|apt|apt-get|cd|ls|ssh|scp|chmod|chown|systemctl|journalctl|kubectl|bash|sh|echo|cat|export|mkdir|rm|cp|mv|tail|grep';

    /** @var list<string> */
    private const TECHNICAL_PATTERNS = [
        '/^[a-z][a-z0-9+.-]*:\/\/\S+$/i',
        '/^(?:~|\.{1,2})?\/\S*$/',
        '/^[\w-]+(?:\.[\w-]+)*\.[a-z0-9]{2,}$/i',
        '/^v?\d+(?:\.\d+)+[\w.+-]*$/i',
        '/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/',
        '/^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,6}$/',
        '/^\w+=\S*$/',
        '/^(?:[\d*\/,-]+\s+){4}[\d*\/,-]+$/',
        '/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/',
        '/^-{3,}[A-Z ]+-{3,}$/',
        '/^(?:' . self::COMMAND_WORDS . ')\s+\S/',
    ];

    /** @var list<string> */
    private array $brands;

    /** @param list<string> $brands */
    public function __construct(array $brands)
    {
        usort($brands, static fn (string $a, string $b): int => strlen($b) <=> strlen($a));
        $this->brands = $brands;
    }

    public function skipReason(string $text): ?SkipReason
    {
        if (self::isConfigExample($text)) {
            return SkipReason::Technical;
        }
        $normalized = trim((string) preg_replace('/\s+/u', ' ', $text));
        if ($normalized === '') {
            return SkipReason::Empty;
        }
        if (preg_match('/\$[A-Za-z_]/', $normalized) === 1 || str_starts_with($normalized, '--')) {
            return SkipReason::Technical;
        }
        foreach (self::TECHNICAL_PATTERNS as $pattern) {
            if (preg_match($pattern, $normalized) === 1) {
                return SkipReason::Technical;
            }
        }
        if (self::isTechnicalToken($normalized)) {
            return SkipReason::Technical;
        }
        $parts = array_map('trim', explode(',', $normalized));
        if (count($parts) > 1 && !in_array('', $parts, true) && array_filter($parts, static fn (string $p): bool => !self::isTechnicalToken($p)) === []) {
            return SkipReason::Technical;
        }
        if (preg_match('/\p{L}/u', $normalized) !== 1) {
            return SkipReason::NoLetters;
        }
        if ($this->isBrandOnly($normalized)) {
            return SkipReason::BrandOnly;
        }

        return null;
    }

    /** 공백 없는 한 덩어리가 경로·주소·해시·식별자 모양인지(예: ghcr.io/org/app, git@host:repo, 2001:db8::1). */
    private static function isTechnicalToken(string $token): bool
    {
        if ($token === '' || preg_match('/\s/', $token) === 1) {
            return false;
        }
        if (preg_match('/[\/@]/', $token) === 1 || str_contains($token, '::') || preg_match('/^[0-9a-f]{12,}$/i', $token) === 1) {
            return true;
        }
        // 소문자 식별자(text-red-500, lg:hidden, deployment_success). 숫자·_·:·. 없이 하이픈만 있는 단어(read-only)는 글자로 둔다.
        if (preg_match('/^[a-z0-9]+(?:[-_.:][a-z0-9]+)+$/', $token) === 1 && preg_match('/[0-9_.:]/', $token) === 1 && preg_match('/[a-z]/', $token) === 1) {
            return true;
        }
        foreach (self::TECHNICAL_PATTERNS as $pattern) {
            if (preg_match($pattern, $token) === 1) {
                return true;
            }
        }

        return false;
    }

    /** 여러 줄이 모두 설정·YAML 예시 모양(# 주석, key:, key=, - 항목)인지. */
    private static function isConfigExample(string $text): bool
    {
        $lines = array_values(array_filter(array_map('trim', preg_split('/\R/', $text) ?: []), static fn (string $l): bool => $l !== ''));
        if (count($lines) < 2) {
            return false;
        }
        foreach ($lines as $line) {
            if (preg_match('/^(?:#|-\s+\S|[\w.\-]+:(?:\s|$)|[\w.\-]+\s*=)/', $line) !== 1) {
                return false;
            }
        }

        return true;
    }

    private function isBrandOnly(string $text): bool
    {
        $rest = $text;
        foreach ($this->brands as $brand) {
            $rest = (string) preg_replace('/(?<!\w)' . preg_quote($brand, '/') . '(?!\w)/u', ' ', $rest);
        }

        return preg_match('/\p{L}/u', $rest) !== 1;
    }
}
