<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

enum SegmentKind
{
    case Text;
    case Tag;
    case Blade;
    case Comment;
}
