<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use PhpParser\Node\Expr;

final readonly class RunItem
{
    /**
     * @param string $code Echo면 치환값 식, 태그·덩어리면 그 HTML을 만드는 PHP 식(옮길 수 없으면 빈 문자열)
     */
    public function __construct(
        public RunItemKind $kind,
        public int $start,
        public int $end,
        public string $source,
        public ?Tag $tag = null,
        public ?Expr $expr = null,
        public string $code = '',
    ) {
    }

    public function isContent(): bool
    {
        return match ($this->kind) {
            RunItemKind::Text => preg_match('/\S/', $this->source) === 1,
            RunItemKind::Echo, RunItemKind::Opaque => true,
            default => false,
        };
    }

    public function isMarkup(): bool
    {
        return in_array($this->kind, [RunItemKind::Open, RunItemKind::Close, RunItemKind::Void, RunItemKind::Opaque], true);
    }

    public function isConvertibleMarkup(): bool
    {
        return $this->isMarkup() && $this->code !== '';
    }
}
