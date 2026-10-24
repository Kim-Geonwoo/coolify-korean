<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Catalog;

/** 번역 키 하나가 원본의 어디에서 어떤 형태로 나왔는지. 변환한 곳이면 원문 조각과 바꾼 조각도 담는다. */
final readonly class Occurrence
{
    /**
     * @param list<string> $placeholders
     * @param list<string> $counts 복수형(trans_choice)이 고르는 개수 식(동등성 검사가 0·1·2를 넣어 본다)
     * @param list<string> $alsoKeys 바꾼 꼴이 key 밖에 함께 쓰는 키(수동 치환, 가짜 언어 검사용)
     */
    public function __construct(
        public string $key,
        public string $file,
        public int $line,
        public string $kind,
        public array $placeholders = [],
        public string $original = '',
        public string $replacement = '',
        public array $counts = [],
        public array $alsoKeys = [],
    ) {
    }

    public function isConversion(): bool
    {
        return $this->replacement !== '';
    }
}
