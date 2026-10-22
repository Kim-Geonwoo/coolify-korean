<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

/** 컴포넌트 속성 값이 화면에 나가는 방식. */
enum PropSink
{
    /** {{ $prop }}처럼 이스케이프해서 출력 */
    case Text;
    /** {!! $prop !!}처럼 HTML 그대로 출력 */
    case Html;
}
