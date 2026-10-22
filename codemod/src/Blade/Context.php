<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

final readonly class Context
{
    /**
     * @param list<string> $elements 바깥부터 안쪽까지 열린 HTML 요소 이름
     * @param string|null $slot 가장 안쪽 컴포넌트가 이름 있는 슬롯이면 그 이름
     * @param string|null $component 가장 안쪽에 열린 Blade 컴포넌트 이름
     */
    public function __construct(
        public bool $protected,
        public ?string $slot,
        public array $elements,
        public ?string $component,
    ) {
    }
}
