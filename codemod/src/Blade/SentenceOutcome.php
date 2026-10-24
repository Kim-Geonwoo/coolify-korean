<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Edit\Edit;
use CoolifyKo\Codemod\Text\SkipReason;

final readonly class SentenceOutcome
{
    /**
     * @param list<string> $placeholders
     * @param list<string> $counts 복수형(trans_choice)이 고르는 개수 식. 동등성 검사가 이 식에 0·1·2를 넣어 본다.
     * @param list<string> $alsoKeys 바꾼 꼴이 key 밖에 함께 쓰는 키(수동 치환). 동등성 검사의 가짜 언어가 이 키도 번역한다.
     */
    private function __construct(
        public ?Edit $edit,
        public string $key,
        public string $kind,
        public array $placeholders,
        public ?SkipReason $skip,
        public int $start,
        public string $excerpt,
        public array $counts = [],
        public array $alsoKeys = [],
    ) {
    }

    /**
     * @param list<string> $placeholders
     * @param list<string> $counts
     * @param list<string> $alsoKeys
     */
    public static function converted(Edit $edit, string $key, string $kind, array $placeholders, array $counts = [], array $alsoKeys = []): self
    {
        return new self($edit, $key, $kind, $placeholders, null, $edit->start, '', $counts, $alsoKeys);
    }

    public static function skipped(SkipReason $reason, int $start, string $excerpt): self
    {
        return new self(null, '', '', [], $reason, $start, $excerpt);
    }

    /**
     * 바꾸지 않고 카탈로그에만 넣는 키(예: 배열 리터럴로 정의된 메뉴 라벨, 복수형 문장 안쪽 구절).
     *
     * @param list<string> $placeholders
     */
    public static function extracted(string $key, int $start, string $kind, array $placeholders = []): self
    {
        return new self(null, $key, $kind, $placeholders, null, $start, '');
    }

    public static function ignored(): self
    {
        return new self(null, '', '', [], null, 0, '');
    }
}
