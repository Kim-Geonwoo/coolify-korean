<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Php;

use PhpParser\Error;
use PhpParser\Node;
use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\Node\Scalar;
use PhpParser\Node\Stmt;
use PhpParser\Parser;
use PhpParser\ParserFactory;

/**
 * Blade echo 식을 번역 문장의 치환값으로 옮겨도 안전한지 판단한다.
 * 문자열(Stringable 포함)을 돌려줄 것이 분명한 식만 허용한다. HTML 조각을 돌려줄 수 있는 식,
 * 영어 문자열 리터럴을 고르는 삼항식 등은 문장에 묶으면 결과가 달라지므로 거절한다.
 */
final class SafeExpression
{
    private const DENIED_VARIABLES = '/slot|^attributes$|^component$|^__/i';

    private const ALLOWED_FUNCTIONS = [
        'data_get', 'data_get_str', 'str', 'ucfirst', 'lcfirst', 'ucwords', 'strtolower', 'strtoupper',
        'count', 'number_format', 'trim', 'round', 'intval', 'floor', 'ceil', 'abs', 'max', 'min',
    ];

    private const ALLOWED_STATIC_CLASSES = ['Str', 'Illuminate\\Support\\Str'];

    private const ALLOWED_STATIC_METHODS = [
        'headline', 'title', 'limit', 'lower', 'upper', 'plural', 'singular', 'ucfirst', 'words', 'snake', 'kebab', 'studly', 'camel',
    ];

    private const DENIED_METHODS = ['tohtml', 'render', 'markdown', 'inlinemarkdown', 'html', 'tohtmlstring', 'links', 'toarray', 'tojson'];

    private const TRANSLATION_FUNCTIONS = ['__', '__h', 'trans', 'trans_choice'];

    private readonly Parser $parser;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForNewestSupportedVersion();
    }

    public function parse(string $code): ?Expr
    {
        try {
            $statements = $this->parser->parse('<?php ' . $code . ';');
        } catch (Error) {
            return null;
        }
        if ($statements === null || count($statements) !== 1 || !$statements[0] instanceof Stmt\Expression) {
            return null;
        }

        return $statements[0]->expr;
    }

    public function isTranslationCall(Expr $expr): bool
    {
        return $expr instanceof Expr\FuncCall
            && $expr->name instanceof Name
            && in_array($expr->name->toLowerString(), self::TRANSLATION_FUNCTIONS, true);
    }

    public function isSafePlaceholderValue(Expr $expr): bool
    {
        return !$expr instanceof Scalar && $this->isSafe($expr);
    }

    private function isSafe(Node $node): bool
    {
        return match (true) {
            $node instanceof Expr\Variable => is_string($node->name) && preg_match(self::DENIED_VARIABLES, $node->name) !== 1,
            $node instanceof Expr\PropertyFetch, $node instanceof Expr\NullsafePropertyFetch => $node->name instanceof Identifier && $this->isSafe($node->var),
            $node instanceof Expr\ArrayDimFetch => $node->dim !== null
                && ($node->dim instanceof Scalar\String_ || $node->dim instanceof Scalar\Int_)
                && $this->isSafe($node->var),
            $node instanceof Expr\MethodCall, $node instanceof Expr\NullsafeMethodCall => $node->name instanceof Identifier
                && !in_array($node->name->toLowerString(), self::DENIED_METHODS, true)
                && $this->isSafe($node->var)
                && $this->argsSafe($node->args),
            $node instanceof Expr\FuncCall => $node->name instanceof Name
                && in_array($node->name->toLowerString(), self::ALLOWED_FUNCTIONS, true)
                && $this->argsSafe($node->args),
            $node instanceof Expr\StaticCall => $node->class instanceof Name
                && in_array($node->class->toString(), self::ALLOWED_STATIC_CLASSES, true)
                && $node->name instanceof Identifier
                && in_array($node->name->toLowerString(), self::ALLOWED_STATIC_METHODS, true)
                && $this->argsSafe($node->args),
            $node instanceof Expr\BinaryOp\Coalesce => $this->isSafe($node->left) && $this->isLetterFreeOrSafe($node->right),
            // 숫자 계산(4.5.0 "max {{ Server::PROXY_ERROR_PAGE_MAX_BYTES / 1024 }} KB"). 결과가 숫자라 반쪽 번역이 되지 않는다
            $node instanceof Expr\BinaryOp\Plus, $node instanceof Expr\BinaryOp\Minus, $node instanceof Expr\BinaryOp\Mul,
            $node instanceof Expr\BinaryOp\Div, $node instanceof Expr\BinaryOp\Mod => $this->isNumericOperand($node->left) && $this->isNumericOperand($node->right),
            $node instanceof Expr\Cast\String_, $node instanceof Expr\Cast\Int_ => $this->isSafe($node->expr),
            $node instanceof Scalar\String_ => true,
            $node instanceof Scalar\Int_, $node instanceof Scalar\Float_ => true,
            $node instanceof Expr\ConstFetch => in_array($node->name->toLowerString(), ['true', 'false', 'null'], true),
            default => false,
        };
    }

    /** 계산식의 피연산자: 숫자, 클래스 상수(계산 안에서만, 문자열 상수가 문장에 그대로 끼지 않게), 안전한 식 */
    private function isNumericOperand(Expr $expr): bool
    {
        if ($expr instanceof Scalar\Int_ || $expr instanceof Scalar\Float_) {
            return true;
        }
        if ($expr instanceof Expr\ClassConstFetch) {
            return $expr->class instanceof Name && $expr->name instanceof Identifier;
        }

        return !$expr instanceof Scalar\String_ && $this->isSafe($expr);
    }

    private function isLetterFreeOrSafe(Expr $expr): bool
    {
        if ($expr instanceof Scalar\String_) {
            return preg_match('/\p{L}/u', $expr->value) !== 1;
        }

        return $this->isSafe($expr);
    }

    /** @param array<Arg|Node\VariadicPlaceholder> $args */
    private function argsSafe(array $args): bool
    {
        foreach ($args as $arg) {
            if (!$arg instanceof Arg || $arg->unpack || $arg->byRef || !$this->isSafe($arg->value)) {
                return false;
            }
        }

        return true;
    }
}
