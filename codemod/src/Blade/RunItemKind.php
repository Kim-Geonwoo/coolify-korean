<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

enum RunItemKind
{
    case Text;
    case Echo;
    case Open;
    case Close;
    case Void;
    case Opaque;
}
