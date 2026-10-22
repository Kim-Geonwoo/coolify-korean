<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Catalog;

/**
 * 원문에 이미 있는 번역 호출(__('…'), __h('…'), coolify_ko_message('…'), trans('…'), trans_choice('…'), @lang('…'))의 리터럴 키를 찾는다.
 * 업스트림의 기존 호출과, 이전 변환 결과를 다시 돌릴 때 카탈로그가 같게 나오도록 하는 데 쓴다.
 */
final class TranslationCallScanner
{
    /** trans_choice는 trans보다 먼저 둔다(`trans`가 `trans_choice(`의 앞부분에서 멈추지 않게) */
    private const PATTERN = '/(?<![\w>$:])(__h?|coolify_ko_message|trans_choice|trans|@lang)\(\s*\'((?:[^\'\\\\]|\\\\.)*)\'/';

    /** @return list<Occurrence> */
    public static function scan(string $source, string $file): array
    {
        if (preg_match_all(self::PATTERN, $source, $matches, PREG_OFFSET_CAPTURE) === false) {
            return [];
        }
        $found = [];
        foreach ($matches[2] as $index => [$literal, $offset]) {
            $key = str_replace(['\\\'', '\\\\'], ['\'', '\\'], $literal);
            if ($key === '') {
                continue;
            }
            // 복수형 문자열(`a|b`)은 구간 규칙을 지켜야 해서 따로 표시한다
            $kind = $matches[1][$index][0] === 'trans_choice' ? 'plural' : 'existing';
            $found[] = new Occurrence($key, $file, substr_count($source, "\n", 0, $offset) + 1, $kind);
        }

        return $found;
    }
}
