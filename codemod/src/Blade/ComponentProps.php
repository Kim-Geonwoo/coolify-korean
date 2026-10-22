<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use CoolifyKo\Codemod\Rules\RuleSet;
use CoolifyKo\Codemod\Text\SkipReason;
use PhpParser\Error;
use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Name;
use PhpParser\NodeFinder;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\ParentConnectingVisitor;
use PhpParser\Parser;
use PhpParser\ParserFactory;

/**
 * 컴포넌트 템플릿을 읽어 속성이 어떻게 쓰이는지 판정한다.
 * - {{ $p }} → Text, {!! $p !!} → Html, :x="$p"로 다른 컴포넌트에 넘기면 그쪽을 따라간다.
 * - @if 등의 조건에서 존재 확인(!, &&, ||, filled, isset …)으로만 쓰이면 상관없다.
 * - 그 밖에 비교·키·JS·문자열 조립에 쓰이면 로직 속성으로 보고 번역하지 않는다.
 * 규칙의 componentSinks(사람이 템플릿을 읽고 확인한 판정)가 있으면 그것이 우선한다.
 */
final class ComponentProps
{
    private const MAX_DEPTH = 4;

    private const PRESENCE_FUNCTIONS = ['filled', 'blank', 'is_null', 'isset', 'empty'];

    /** @var array<string, PropSink|SkipReason> */
    private array $cache = [];

    private readonly Parser $parser;

    /**
     * @param array<string, string> $templates 컴포넌트 이름(점 표기) → 템플릿 원문
     * @param array<string, string> $classSources 컴포넌트 이름 → 클래스 PHP 원문(클래스 기반 컴포넌트만)
     */
    private function __construct(
        private readonly RuleSet $rules,
        private readonly array $templates,
        private readonly array $classSources,
    ) {
        $this->parser = (new ParserFactory())->createForNewestSupportedVersion();
    }

    /**
     * @param array<string, string> $templates
     * @param array<string, string> $classSources
     */
    public static function fromTemplates(RuleSet $rules, array $templates, array $classSources = []): self
    {
        return new self($rules, $templates, $classSources);
    }

    public static function none(): self
    {
        return new self(new RuleSet(), [], []);
    }

    /** 번역 대상이 아니면 null, 대상이면 출력 방식, 대상이지만 쓰면 안 되면 그 이유. */
    public function resolve(string $component, string $prop): PropSink|SkipReason|null
    {
        $manual = $this->rules->componentSinks[$component][$prop] ?? null;
        if ($manual !== null) {
            return $manual === 'html' ? PropSink::Html : PropSink::Text;
        }
        if (!in_array($prop, $this->rules->components[$component] ?? [], true)) {
            return null;
        }

        return $this->analyze($component, $prop, 0);
    }

    /** 템플릿이 이 값과 비교하는 속성이면(규칙 logicValues) 호출부·기본값에서 영어 그대로 둬야 한다. */
    public function isLogicValue(string $component, string $prop, string $value): bool
    {
        return in_array($value, $this->rules->logicValues[$component][$prop] ?? [], true);
    }

    private function analyze(string $component, string $prop, int $depth): PropSink|SkipReason
    {
        $manual = $this->rules->componentSinks[$component][$prop] ?? null;
        if ($manual !== null) {
            return $manual === 'html' ? PropSink::Html : PropSink::Text;
        }
        $cacheKey = $component . "\0" . $prop;
        if (isset($this->cache[$cacheKey])) {
            return $this->cache[$cacheKey];
        }
        $template = $this->templates[$component] ?? null;
        if ($template === null || $depth > self::MAX_DEPTH) {
            return $this->cache[$cacheKey] = SkipReason::UnknownAttribute;
        }
        $class = self::withoutComments($this->classSources[$component] ?? '');
        if ($class !== '' && preg_match('/\$this->' . preg_quote($prop, '/') . '\b/', $class) === 1) {
            return $this->cache[$cacheKey] = SkipReason::LogicProp;
        }

        $sinks = [];
        preg_match_all('/\$' . preg_quote($prop, '/') . '\b/', $template, $matches, PREG_OFFSET_CAPTURE);
        foreach ($matches[0] as [, $offset]) {
            $usage = $this->classify($template, $offset, $prop, $depth);
            if ($usage instanceof SkipReason) {
                return $this->cache[$cacheKey] = $usage;
            }
            if ($usage !== null) {
                $sinks[$usage->name] = $usage;
            }
        }
        if ($sinks === [] && $this->flowsThroughAttributeBag($template, $prop)) {
            $sinks['Text'] = PropSink::Text;
        }
        $result = match (true) {
            count($sinks) === 1 => array_values($sinks)[0],
            count($sinks) > 1 => SkipReason::LogicProp,
            default => SkipReason::UnknownAttribute,
        };

        return $this->cache[$cacheKey] = $result;
    }

    /** 한 번의 $prop 사용이 출력·전달·존재 확인 중 무엇인지. 존재 확인이면 null. */
    private function classify(string $template, int $offset, string $prop, int $depth): PropSink|SkipReason|null
    {
        $var = '\$' . preg_quote($prop, '/');
        $before = substr($template, 0, $offset);
        $after = substr($template, $offset);

        $rawOpen = strrpos($before, '{!!');
        if ($rawOpen !== false && !str_contains(substr($before, $rawOpen), '!!}')) {
            $close = strpos($after, '!!}');
            $inner = $close === false ? '' : trim(substr($template, $rawOpen + 3, $offset + $close - $rawOpen - 3));

            return preg_match('/^' . $var . '(?:\s*\?\?\s*[^?:]+)?$/', $inner) === 1 ? PropSink::Html : SkipReason::LogicProp;
        }
        $echoOpen = strrpos($before, '{{');
        if ($echoOpen !== false && !str_contains(substr($before, $echoOpen), '}}')) {
            $close = strpos($after, '}}');
            $inner = $close === false ? '' : trim(substr($template, $echoOpen + 2, $offset + $close - $echoOpen - 2));

            return preg_match('/^' . $var . '(?:\s*\?\?\s*[^?:]+)?$/', $inner) === 1 ? PropSink::Text : SkipReason::LogicProp;
        }
        if (preg_match('/:([\w.-]+)\s*=\s*"\s*$/', $before, $bind) === 1 && preg_match('/^' . $var . '\s*"/', $after) === 1) {
            $tagStart = strrpos($before, '<x-');
            if ($tagStart !== false && !str_contains(substr($before, $tagStart), '>') && preg_match('/^<x-([\w.:-]+)/', substr($before, $tagStart), $tag) === 1) {
                return $this->analyze($tag[1], self::camel($bind[1]), $depth + 1);
            }

            return SkipReason::LogicProp;
        }
        $condition = self::conditionAround($template, $offset);
        if ($condition !== null) {
            return $this->onlyPresence($condition, $prop) ? null : SkipReason::LogicProp;
        }

        return SkipReason::LogicProp;
    }

    /** offset을 감싸는 가장 안쪽 @if·@elseif·@unless·@isset·@empty 조건식 원문. */
    private static function conditionAround(string $template, int $offset): ?string
    {
        preg_match_all('/@(?:if|elseif|unless|isset|empty)\s*\(/', $template, $matches, PREG_OFFSET_CAPTURE);
        $found = null;
        foreach ($matches[0] as [$text, $start]) {
            $open = $start + strlen($text) - 1;
            if ($open >= $offset) {
                break;
            }
            $close = self::matchingParen($template, $open);
            if ($close !== null && $close > $offset) {
                $found = substr($template, $open + 1, $close - $open - 1);
            }
        }

        return $found;
    }

    private static function matchingParen(string $text, int $open): ?int
    {
        $depth = 0;
        $quote = null;
        for ($i = $open, $n = strlen($text); $i < $n; $i++) {
            $c = $text[$i];
            if ($quote !== null) {
                if ($c === '\\') {
                    $i++;
                } elseif ($c === $quote) {
                    $quote = null;
                }
                continue;
            }
            if ($c === '"' || $c === "'") {
                $quote = $c;
            } elseif ($c === '(') {
                $depth++;
            } elseif ($c === ')' && --$depth === 0) {
                return $i;
            }
        }

        return null;
    }

    /** 조건식에서 $prop이 존재 확인(!, &&, ||, ??, filled 등)으로만 쓰였는지. */
    private function onlyPresence(string $condition, string $prop): bool
    {
        try {
            $statements = $this->parser->parse('<?php ' . $condition . ';') ?? [];
        } catch (Error) {
            return false;
        }
        $traverser = new NodeTraverser(new ParentConnectingVisitor());
        $statements = $traverser->traverse($statements);
        $variables = (new NodeFinder())->find($statements, static fn (Node $n): bool => $n instanceof Expr\Variable && $n->name === $prop);
        foreach ($variables as $variable) {
            $node = $variable->getAttribute('parent');
            while ($node instanceof Node && !$node instanceof Node\Stmt) {
                $allowed = $node instanceof Expr\BooleanNot
                    || $node instanceof Expr\BinaryOp\BooleanAnd || $node instanceof Expr\BinaryOp\BooleanOr
                    || $node instanceof Expr\BinaryOp\LogicalAnd || $node instanceof Expr\BinaryOp\LogicalOr
                    || $node instanceof Expr\BinaryOp\Coalesce || $node instanceof Expr\Isset_ || $node instanceof Expr\Empty_
                    || $node instanceof Node\Arg
                    || ($node instanceof Expr\FuncCall && $node->name instanceof Name && in_array($node->name->toLowerString(), self::PRESENCE_FUNCTIONS, true));
                if (!$allowed) {
                    return false;
                }
                $node = $node->getAttribute('parent');
            }
        }

        return true;
    }

    private function flowsThroughAttributeBag(string $template, string $prop): bool
    {
        if (preg_match('/@props\s*\(\s*\[[^\]]*[\'"]' . preg_quote($prop, '/') . '[\'"]/s', $template) === 1) {
            return false;
        }

        return preg_match('/\{\{\s*\$attributes(?:->(?:merge|class|except|only)\([^}]*\))?\s*\}\}/', $template) === 1
            || preg_match('/\{\{\s*\$attributes->get\(\s*[\'"]' . preg_quote($prop, '/') . '[\'"]\s*\)\s*\}\}/', $template) === 1;
    }

    private static function withoutComments(string $php): string
    {
        if ($php === '') {
            return '';
        }
        $out = '';
        foreach (\PhpToken::tokenize($php) as $token) {
            if (!$token->is([T_COMMENT, T_DOC_COMMENT])) {
                $out .= $token->text;
            }
        }

        return $out;
    }

    private static function camel(string $kebab): string
    {
        return lcfirst(str_replace(' ', '', ucwords(str_replace(['-', '_'], ' ', $kebab))));
    }
}
