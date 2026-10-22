<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Rules;

use RuntimeException;

final readonly class RuleSet
{
    /**
     * @param list<string> $brands 단독으로 나오면 번역하지 않는 고유명사
     * @param array<string, list<string>> $components 컴포넌트 이름 → 번역 후보 속성(출력 방식은 템플릿을 분석해 정한다)
     * @param list<string> $htmlAttributes 일반 HTML 요소에서 번역할 속성
     * @param list<string> $excludedViewDirectories resources/views 기준으로 건너뛸 폴더
     * @param array<string, array<string, string>> $componentSinks 템플릿을 사람이 읽고 확인한 출력 방식('text'|'html'). 분석보다 우선한다.
     * @param list<string> $alpineAttributes 값이 화면 글자로 쓰이는 Alpine 속성(x-text, :title …). 결과 자리의 JS 문자열만 바꾼다.
     * @param array<string, int> $scriptCalls 스크립트 안 함수 이름 → 화면 글자로 쓰이는 인자 번호(지금은 0만 지원)
     * @param array<string, array<string, list<string>>> $logicValues 컴포넌트 → 속성 → 템플릿이 비교에 쓰는 값. 이 값은 호출부·기본값에서 그대로 둔다.
     * @param array<string, array<string, list<string>>> $displayVariables 컴포넌트 → 템플릿 안에서 로직을 거친 뒤 @js(변수)로 화면에 나가는 변수 → 그 영어 값
     * @param array<string, array<string, list<string>>> $componentArrayProps 컴포넌트 → 배열 리터럴 prop → 항목에서 화면 글자인 키('*'는 키 없는 항목 자체)
     * @param array<string, array<string, string>> $includeArgs @include 뷰 이름 → 데이터 배열에서 화면 글자인 키 → 'text'|'js'(템플릿이 JS 작은따옴표 문자열 안에 넣는 값)
     * @param array<string, array<string, list<string>>> $displayExpressions 뷰 이름 → 코드 값으로 화면 글자를 만드는 식(원문 그대로) → 그 식이 낼 수 있는 영어 값 전부
     */
    public function __construct(
        public array $brands = [],
        public array $components = [],
        public array $htmlAttributes = [],
        public array $excludedViewDirectories = [],
        public array $componentSinks = [],
        public array $alpineAttributes = [],
        public array $scriptCalls = [],
        public array $logicValues = [],
        public array $displayVariables = [],
        public array $componentArrayProps = [],
        public array $includeArgs = [],
        public array $displayExpressions = [],
    ) {
    }

    public static function fromFile(string $path): self
    {
        if (!is_file($path)) {
            throw new RuntimeException(sprintf('규칙 파일이 없습니다: %s', $path));
        }
        $config = require $path;
        if (!is_array($config)) {
            throw new RuntimeException('규칙 파일은 배열을 돌려줘야 합니다.');
        }

        return new self(
            self::stringList($config['brands'] ?? []),
            self::componentMap($config['components'] ?? []),
            self::stringList($config['htmlAttributes'] ?? []),
            self::stringList($config['excludedViewDirectories'] ?? []),
            self::sinkMap($config['componentSinks'] ?? []),
            self::stringList($config['alpineAttributes'] ?? []),
            self::callMap($config['scriptCalls'] ?? []),
            self::valueMap($config['logicValues'] ?? [], 'logicValues'),
            self::valueMap($config['displayVariables'] ?? [], 'displayVariables'),
            self::valueMap($config['componentArrayProps'] ?? [], 'componentArrayProps'),
            self::includeMap($config['includeArgs'] ?? []),
            self::valueMap($config['displayExpressions'] ?? [], 'displayExpressions'),
        );
    }

    /** @return array<string, int> */
    private static function callMap(mixed $value): array
    {
        if (!is_array($value)) {
            throw new RuntimeException('scriptCalls는 배열이어야 합니다.');
        }
        $out = [];
        foreach ($value as $name => $index) {
            if (!is_int($index) || $index !== 0) {
                throw new RuntimeException(sprintf('scriptCalls.%s는 0(첫 인자)만 지원합니다.', $name));
            }
            $out[(string) $name] = $index;
        }

        return $out;
    }

    /** @return array<string, array<string, list<string>>> */
    private static function valueMap(mixed $value, string $name): array
    {
        if (!is_array($value)) {
            throw new RuntimeException(sprintf('%s는 배열이어야 합니다.', $name));
        }
        $out = [];
        foreach ($value as $component => $entries) {
            if (!is_array($entries)) {
                throw new RuntimeException(sprintf('%s.%s 값은 배열이어야 합니다.', $name, $component));
            }
            foreach ($entries as $entry => $values) {
                $out[(string) $component][(string) $entry] = self::stringList($values);
            }
        }

        return $out;
    }

    /** @return array<string, array<string, string>> */
    private static function includeMap(mixed $value): array
    {
        if (!is_array($value)) {
            throw new RuntimeException('includeArgs는 배열이어야 합니다.');
        }
        $out = [];
        foreach ($value as $view => $keys) {
            if (!is_array($keys)) {
                throw new RuntimeException(sprintf('includeArgs.%s 값은 배열이어야 합니다.', $view));
            }
            foreach ($keys as $key => $sink) {
                if ($sink !== 'text' && $sink !== 'js') {
                    throw new RuntimeException(sprintf('includeArgs.%s.%s는 text 또는 js여야 합니다.', $view, $key));
                }
                $out[(string) $view][(string) $key] = $sink;
            }
        }

        return $out;
    }

    /** @return list<string> */
    private static function stringList(mixed $value): array
    {
        if (!is_array($value)) {
            throw new RuntimeException('규칙 값은 문자열 목록이어야 합니다.');
        }
        $out = [];
        foreach ($value as $item) {
            if (!is_string($item)) {
                throw new RuntimeException('규칙 목록에 문자열이 아닌 값이 있습니다.');
            }
            $out[] = $item;
        }

        return $out;
    }

    /** @return array<string, array<string, string>> */
    private static function sinkMap(mixed $value): array
    {
        if (!is_array($value)) {
            throw new RuntimeException('componentSinks는 배열이어야 합니다.');
        }
        $out = [];
        foreach ($value as $component => $props) {
            if (!is_array($props)) {
                throw new RuntimeException('componentSinks 값은 배열이어야 합니다.');
            }
            foreach ($props as $prop => $sink) {
                if ($sink !== 'text' && $sink !== 'html') {
                    throw new RuntimeException(sprintf('componentSinks.%s.%s는 text 또는 html이어야 합니다.', $component, $prop));
                }
                $out[(string) $component][(string) $prop] = $sink;
            }
        }

        return $out;
    }

    /** @return array<string, list<string>> */
    private static function componentMap(mixed $value): array
    {
        if (!is_array($value)) {
            throw new RuntimeException('components는 배열이어야 합니다.');
        }
        $out = [];
        foreach ($value as $name => $props) {
            $out[(string) $name] = self::stringList($props);
        }

        return $out;
    }
}
