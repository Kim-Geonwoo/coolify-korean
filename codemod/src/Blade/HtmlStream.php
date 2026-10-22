<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Blade;

use RuntimeException;
use Stillat\BladeParser\Document\Document;
use Stillat\BladeParser\Nodes\AbstractNode;
use Stillat\BladeParser\Nodes\LiteralNode;

/**
 * Blade 노드 목록을 HTML 관점의 조각(텍스트·태그·Blade·주석)으로 나눈다.
 * 태그 안에 Blade가 끼면 그 태그를 동적 태그로 표시하고, 번역하면 안 되는 구역(script·code 등)은 보호 문맥으로 표시한다.
 */
final class HtmlStream
{
    private const RAW_TEXT_ELEMENTS = ['script', 'style', 'textarea'];

    private const PROTECTED_ELEMENTS = ['script', 'style', 'textarea', 'svg', 'code', 'pre', 'kbd', 'samp'];

    private const PROTECTED_CLASS_PATTERN = '/(?<![\w-])(?:font-mono|whitespace-pre(?:-line|-wrap)?)(?![\w-])/';

    /** @param list<Segment> $segments */
    private function __construct(private readonly array $segments)
    {
    }

    public static function fromSource(string $source): self
    {
        $document = Document::fromText($source);
        /** @var list<AbstractNode> $nodes */
        $nodes = array_values($document->getNodes()->all());

        return self::fromNodes($source, $nodes);
    }

    /**
     * 파서의 위치 정보는 글자 단위라 멀티바이트 문자 뒤에서 바이트 오프셋과 어긋난다.
     * 그래서 노드 원문 길이를 누적해 바이트 오프셋을 직접 계산하고, 이어 붙인 결과가 원본과 같은지 확인한다.
     *
     * @param list<AbstractNode> $nodes
     */
    public static function fromNodes(string $source, array $nodes): self
    {
        $builder = new HtmlStreamBuilder($source);
        $offset = 0;
        foreach ($nodes as $node) {
            $text = (string) $node;
            $start = $offset;
            $end = $start + strlen($text);
            if (substr($source, $start, $end - $start) !== $text) {
                throw new RuntimeException(sprintf('Blade 노드 원문이 원본과 어긋납니다(바이트 %d).', $start));
            }
            if ($node instanceof LiteralNode) {
                $builder->literal($start, $end);
            } else {
                $builder->blade($node, $start, $end);
            }
            $offset = $end;
        }
        if ($offset !== strlen($source)) {
            throw new RuntimeException('Blade 노드가 원본 전체를 덮지 않습니다.');
        }

        return new self($builder->finish());
    }

    /** @return list<Segment> */
    public function segments(): array
    {
        return $this->segments;
    }

    public static function isProtectedElement(Tag $tag): bool
    {
        if (in_array($tag->name, self::PROTECTED_ELEMENTS, true)) {
            return true;
        }

        return preg_match(self::PROTECTED_CLASS_PATTERN, $tag->raw) === 1;
    }

    public static function isRawTextElement(string $name): bool
    {
        return in_array($name, self::RAW_TEXT_ELEMENTS, true);
    }
}
