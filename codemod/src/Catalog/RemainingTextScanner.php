<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Catalog;

use CoolifyKo\Codemod\Blade\HtmlStream;
use CoolifyKo\Codemod\Blade\SegmentKind;
use CoolifyKo\Codemod\Text\TextClassifier;

/** 변환 뒤 템플릿에 남은 "사람이 읽는 영어 텍스트 조각"을 센다(속성 값은 제외). */
final class RemainingTextScanner
{
    /** @return list<array{file: string, line: int, text: string}> */
    public static function scan(string $source, string $file, TextClassifier $classifier): array
    {
        $found = [];
        foreach (HtmlStream::fromSource($source)->segments() as $segment) {
            if ($segment->kind !== SegmentKind::Text || $segment->context->protected) {
                continue;
            }
            $text = html_entity_decode($segment->source, ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $text = trim((string) preg_replace('/\s+/', ' ', (string) preg_replace('/(?<![\w@])@@?[A-Za-z_]\w*(?:\s*\([^()]*\))?/', ' ', $text)));
            if ($text === '' || preg_match('/\p{L}/u', $text) !== 1 || $classifier->skipReason($text) !== null) {
                continue;
            }
            $found[] = [
                'file' => $file,
                'line' => substr_count($source, "\n", 0, $segment->start) + 1,
                'text' => mb_strlen($text) > 120 ? mb_substr($text, 0, 117) . '...' : $text,
            ];
        }

        return $found;
    }
}
