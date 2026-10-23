<?php

// coolify-ko 정적 동등성 검사. 오버레이 이미지 안에서 돈다(DB·Redis 불필요).
// 변환 기록(edits.jsonl)의 모든 변경 지점에 대해:
//   1) en 로케일에서 원문 조각과 바꾼 조각의 출력이 같은지
//      - 화면 HTML(text·rich·display-site·prop-html …)은 DOM으로 정규화해 비교한다.
//      - 글자 그대로 쓰이는 값(알림·검증 문구, 속성 값, 글자 prop, prop 기본값)은 공백까지 정확히 비교한다.
//   2) 가짜 언어(⟦키⟧)에서 바꾼 조각이 오류 없이 번역문을 내는지
// 를 본다. 식 자리에는 특수문자가 든 대역 객체를 넣어 이스케이프 차이까지 잡는다.
// 복수형(trans_choice)으로 바꾼 곳은 개수 식에 0·1·2를 넣은 조합마다 비교한다.
// 양쪽이 같은 오류로 평가되지 않는 조각(조각 단독 평가의 한계)은 허용 목록(allow-unverifiable.json)에 있을 때만 통과한다.
// 사용: php harness.php <edits.jsonl> <report.json> <allow-unverifiable.json>
// eval은 변환기가 Coolify 템플릿에서 만든 조각(신뢰하는 입력)을 격리된 빌드 컨테이너 안에서 평가하는 데만 쓴다.

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\HtmlString;

require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

final class Sentinel implements ArrayAccess, IteratorAggregate, Countable, Stringable, JsonSerializable
{
    public const TEXT = "S<b>&\"'";

    public function __get(string $name): self { return new self(); }
    public function __isset(string $name): bool { return true; }
    public function __call(string $name, array $args): self { return new self(); }
    public static function __callStatic(string $name, array $args): self { return new self(); }
    public function __invoke(mixed ...$args): self { return new self(); }
    public function __toString(): string { return self::TEXT; }
    public function offsetExists(mixed $offset): bool { return true; }
    public function offsetGet(mixed $offset): self { return new self(); }
    public function offsetSet(mixed $offset, mixed $value): void {}
    public function offsetUnset(mixed $offset): void {}
    public function getIterator(): ArrayIterator { return new ArrayIterator([]); }
    public function count(): int { return 1; }
    public function jsonSerialize(): string { return self::TEXT; }
}

function coolify_ko_vars(string ...$codes): array
{
    $vars = ['__env' => app('view')];
    foreach ($codes as $code) {
        preg_match_all('/\$([A-Za-z_]\w*)/', $code, $m);
        foreach ($m[1] as $name) {
            if ($name !== 'this' && $name !== '__env') {
                $vars[$name] = new Sentinel();
            }
        }
    }

    return $vars;
}

function coolify_ko_error(Throwable $e): string
{
    // 조각을 eval로 평가해 TypeError에 "called in …harness.php(69) : eval()'d code on line N"이 붙는다.
    // N은 조각을 몇 줄로 썼는지에 따라 달라질 뿐 동작과 무관해 비교에서 뺀다(4.5.0 cloudflare-tunnel: 원본 두 줄, 변환본 한 줄)
    $message = preg_replace('/, called in \S+\(\d+\) : eval\(\)\'d code on line \d+/', '', $e->getMessage()) ?? $e->getMessage();

    return 'ERROR:' . get_class($e) . ': ' . $message;
}

/** Blade 조각을 렌더한다. 예외는 문자열 'ERROR:클래스: 메시지'로 돌려준다. */
function coolify_ko_render_blade(string $fragment, array $vars): string
{
    $php = app('blade.compiler')->compileString($fragment);
    $fn = function () use ($php, $vars): string {
        extract($vars);
        ob_start();
        try {
            eval('?>' . $php);
        } catch (Throwable $e) {
            ob_end_clean();

            return coolify_ko_error($e);
        }

        return (string) ob_get_clean();
    };

    return Closure::bind($fn, new Sentinel(), null)();
}

/** PHP 식을 평가해 문자열로 돌려준다. */
function coolify_ko_eval(string $code, array $vars): string
{
    $fn = function () use ($code, $vars): string {
        extract($vars);
        try {
            $value = eval('return ' . $code . ';');
        } catch (Throwable $e) {
            return coolify_ko_error($e);
        }
        if (is_array($value)) {
            return json_encode(array_map(static fn ($v) => (string) $v, $value), JSON_UNESCAPED_UNICODE);
        }

        return $value instanceof HtmlString ? $value->toHtml() : (string) $value;
    };

    return Closure::bind($fn, new Sentinel(), null)();
}

function coolify_ko_norm_html(string $html): string
{
    if (str_starts_with($html, 'ERROR:')) {
        return $html;
    }
    $doc = Dom\HTMLDocument::createFromString('<!DOCTYPE html><body>' . $html . '</body>', LIBXML_NOERROR);

    return trim((string) preg_replace('/\s+/u', ' ', $doc->body->innerHTML));
}

function coolify_ko_decode(string $text): string
{
    return str_starts_with($text, 'ERROR:') ? $text : html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}

/**
 * JS 문자열 리터럴 하나('…' 또는 "…")를 값으로 풀어 'JS:값'으로 돌려준다. Js::from이 내는 \uXXXX(대리쌍 포함)·\/도 푼다.
 * 리터럴 하나가 아니면 'ERROR:js …'.
 */
function coolify_ko_js_value(string $literal): string
{
    if (str_starts_with($literal, 'ERROR:')) {
        return $literal;
    }
    $quote = $literal[0] ?? '';
    $length = strlen($literal);
    if (($quote !== "'" && $quote !== '"') || $length < 2 || $literal[$length - 1] !== $quote) {
        return 'ERROR:js not a literal: ' . mb_substr($literal, 0, 80);
    }
    $simple = ['\\' => '\\', "'" => "'", '"' => '"', 'n' => "\n", 'r' => "\r", 't' => "\t", '/' => '/'];
    $units = [];
    $value = '';
    for ($i = 1; $i < $length - 1; $i++) {
        $c = $literal[$i];
        if ($c === $quote) {
            return 'ERROR:js unescaped quote';
        }
        if ($c !== '\\') {
            $value .= $c;
            continue;
        }
        $next = $literal[$i + 1] ?? '';
        if (isset($simple[$next])) {
            $value .= $simple[$next];
            $i++;
            continue;
        }
        if ($next !== 'u' || preg_match('/\G[0-9A-Fa-f]{4}/', $literal, $hex, 0, $i + 2) !== 1) {
            return 'ERROR:js unknown escape';
        }
        $unit = (int) hexdec($hex[0]);
        $i += 5;
        if ($unit >= 0xD800 && $unit <= 0xDBFF && preg_match('/\G\\\\u([dD][c-fC-F][0-9A-Fa-f]{2})/', $literal, $low, 0, $i + 1) === 1) {
            $unit = 0x10000 + (($unit - 0xD800) << 10) + ((int) hexdec($low[1]) - 0xDC00);
            $i += 6;
        }
        $value .= mb_chr($unit, 'UTF-8');
    }

    return 'JS:' . $value;
}

/**
 * Alpine 식 두 개(원문, 바꾼 식)를 node로 실제로 평가해 결과를 견준다. 식 안의 이름은 모두 대역 값 하나를 가리키고
 * (속성 접근도 같은 대역), 그 대역이 문자열로 바뀌면 표본 글자가 된다. 표본에는 $&·:name·:count처럼
 * 치환 방식이 틀리면 드러나는 글자를 넣는다. 결과는 표본마다 'JS:값'(오류면 'ERROR:js …')을 이어 붙인 것이다.
 * 식은 변환기가 Coolify 템플릿에서 만든 조각(신뢰하는 입력)이고, 격리된 빌드 컨테이너 안에서만 평가한다.
 *
 * @return array{string, string}
 */
function coolify_ko_js_outputs(string $original, string $replacement): array
{
    $program = <<<'JS'
        const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        const scope = (sample) => {
          // 호출할 수 없는 대역이어야 replace(…, 값)처럼 값을 함수로 받는 경로가 $& 해석 차이를 숨기지 않는다
          const value = new Proxy({}, {
            get: (target, key) => (key === Symbol.toPrimitive || key === 'toString' || key === 'valueOf' ? () => sample : value),
          });
          return new Proxy({}, { has: (target, key) => typeof key === 'string', get: (target, key) => (key === Symbol.unscopables ? undefined : value) });
        };
        const run = (expression, sample) => {
          try {
            return 'JS:' + String(new Function('scope', 'with (scope) { return (' + expression + '); }')(scope(sample)));
          } catch (error) {
            return 'ERROR:js ' + error.message;
          }
        };
        process.stdout.write(JSON.stringify(input.expressions.map((expression) => input.samples.map((sample) => run(expression, sample)).join(' ‖ '))));
        JS;
    $input = json_encode(['expressions' => [$original, $replacement], 'samples' => ["S<b>&\"'\$&:name:count", '', 'x']], JSON_THROW_ON_ERROR);
    $process = proc_open(['node', '-e', $program], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) {
        return ['ERROR:harness node 실행 실패', 'x'];
    }
    fwrite($pipes[0], $input);
    fclose($pipes[0]);
    $output = (string) stream_get_contents($pipes[1]);
    $errors = (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $status = proc_close($process);
    $results = json_decode($output, true);
    if ($status !== 0 || !is_array($results) || count($results) !== 2) {
        return ['ERROR:harness node ' . $status . ' ' . mb_substr($errors, 0, 200), 'x'];
    }

    return [(string) $results[0], (string) $results[1]];
}

/** @return array{string, string} 이름, 값 */
function coolify_ko_split_attribute(string $attribute): array
{
    if (preg_match('/^:?([\w.:-]+)\s*=\s*(["\'])(.*)\2$/s', $attribute, $m) !== 1) {
        throw new RuntimeException('속성 형식을 읽지 못했습니다: ' . $attribute);
    }

    return [$m[1], $m[3]];
}

/** @return array{string, string} 원문 출력, 바꾼 출력(비교용) */
function coolify_ko_outputs(array $edit): array
{
    $original = $edit['original'];
    $replacement = $edit['replacement'];
    $vars = coolify_ko_vars($original, $replacement);
    switch ($edit['kind']) {
        case 'text':
        case 'rich':
        case 'display-site':
        case 'plural':
            return [coolify_ko_norm_html(coolify_ko_render_blade($original, $vars)), coolify_ko_norm_html(coolify_ko_render_blade($replacement, $vars))];
        case 'prop-text':
        case 'prop-html':
            [, $before] = coolify_ko_split_attribute($original);
            [, $code] = coolify_ko_split_attribute($replacement);
            $old = str_contains($before, '{{') || str_contains($before, '{!!') ? coolify_ko_render_blade($before, $vars) : $before;
            $new = coolify_ko_eval($code, $vars);
            if ($edit['kind'] === 'prop-html') {
                return [coolify_ko_norm_html($old), coolify_ko_norm_html($new)];
            }

            return [$old, $new];
        case 'html-attribute':
            [, $before] = coolify_ko_split_attribute($original);
            [, $after] = coolify_ko_split_attribute($replacement);
            // 원문 값에 echo가 끼어 있으면(aria-label="Open {{ $name }}") 원문 쪽도 Blade로 그린다
            $old = str_contains($before, '{{') || str_contains($before, '{!!') ? coolify_ko_render_blade($before, $vars) : $before;

            return [coolify_ko_decode($old), coolify_ko_decode(coolify_ko_render_blade($after, $vars))];
        case 'prop-default':
        case 'toast':
        case 'toast-title':
        case 'toast-html':
        case 'validation':
        case 'validation-html':
            return [coolify_ko_eval($original, $vars), coolify_ko_eval($replacement, $vars)];
        case 'prop-default-html':
            return [coolify_ko_norm_html(coolify_ko_eval($original, $vars)), coolify_ko_norm_html(coolify_ko_eval($replacement, $vars))];
        case 'echo-literal':
        case 'prop-literal':
        case 'prop-display':
            return [coolify_ko_eval($original, $vars), coolify_ko_eval($replacement, $vars)];
        case 'alpine-literal':
        case 'script-literal':
            return [coolify_ko_js_value($original), coolify_ko_js_value(coolify_ko_render_blade($replacement, $vars))];
        case 'alpine-sentence':
            $after = coolify_ko_render_blade($replacement, $vars);

            return str_starts_with($after, 'ERROR:') ? ['JS', $after] : coolify_ko_js_outputs(html_entity_decode($original, ENT_QUOTES | ENT_HTML5, 'UTF-8'), $after);
        default:
            throw new RuntimeException('알 수 없는 변경 종류: ' . $edit['kind']);
    }
}

/**
 * 복수형(trans_choice)으로 바꾼 곳은 개수 식(edit.counts)에 0·1·2를 넣어 본다. 대역 객체는 개수가 아니어서(count() = 1)
 * 원문의 `=== 1`·Str::plural과 trans_choice가 다르게 고르기 때문이다. 원문·바꾼 조각에서 개수 식을 글자 그대로 숫자로 바꿔
 * 개수 조합마다 그린 결과를 이어 붙여 비교한다. 개수 식이 없으면 한 번만 그린다.
 *
 * @return array{string, string} 원문 출력, 바꾼 출력(비교용)
 */
function coolify_ko_sampled_outputs(array $edit): array
{
    $counts = $edit['counts'] ?? [];
    if ($counts === []) {
        return coolify_ko_outputs($edit);
    }
    usort($counts, static fn (string $a, string $b): int => strlen($b) <=> strlen($a));
    $samples = [[]];
    foreach ($counts as $count) {
        $next = [];
        foreach ($samples as $sample) {
            foreach ([0, 1, 2] as $n) {
                $next[] = $sample + [$count => $n];
            }
        }
        $samples = $next;
    }
    $old = [];
    $new = [];
    foreach ($samples as $sample) {
        $sampled = $edit;
        foreach (['original', 'replacement'] as $side) {
            foreach ($sample as $code => $n) {
                $pattern = '/(?<![\w$>:\\\\])' . preg_quote((string) $code, '/') . '(?![\w(\[]|->|\?->)/';
                $sampled[$side] = (string) preg_replace($pattern, '(' . $n . ')', $sampled[$side]);
            }
        }
        [$o, $r] = coolify_ko_outputs($sampled);
        if (str_starts_with($o, 'ERROR:') || str_starts_with($r, 'ERROR:')) {
            // 오류는 표본 표시 없이 그대로 돌려줘서 "양쪽 같은 오류" 판정(허용 목록)이 그대로 걸리게 한다
            return [$o, $r];
        }
        $label = json_encode($sample, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ' ';
        $old[] = $label . $o;
        $new[] = $label . $r;
    }

    return [implode(' ‖ ', $old), implode(' ‖ ', $new)];
}

/**
 * 허용 목록의 열쇠는 "파일|종류|원본 조각 sha256"이다. 업스트림이 위에 줄을 더해도 허용은 유지되고,
 * 조각이 바뀌면 사람이 다시 대조해야 한다(줄 번호는 사람이 찾기 쉽게 남길 뿐 열쇠가 아니다).
 *
 * @return array<string, string> 열쇠 → 허용한 오류 문구
 */
function coolify_ko_allowlist(string $path): array
{
    $entries = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    $allowed = [];
    foreach ($entries as $entry) {
        $allowed[coolify_ko_allowance_key($entry['file'], $entry['kind'], $entry['originalSha256'])] = $entry['error'];
    }

    return $allowed;
}

function coolify_ko_allowance_key(string $file, string $kind, string $originalSha256): string
{
    return $file . '|' . $kind . '|' . $originalSha256;
}

[, $editsPath, $reportPath, $allowPath] = $argv + [null, null, null, null];
if (!is_string($editsPath) || !is_string($reportPath) || !is_string($allowPath)) {
    fwrite(STDERR, "사용: php harness.php <edits.jsonl> <report.json> <allow-unverifiable.json>\n");
    exit(2);
}
$edits = [];
foreach (file($editsPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
    $edits[] = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
}
$allowed = coolify_ko_allowlist($allowPath);

$translator = app('translator');
$pseudo = [];
foreach ($edits as $edit) {
    if ($edit['key'] !== '') {
        $pseudo[$edit['key']] = '⟦' . $edit['key'] . '⟧';
    }
}

$counts = ['total' => count($edits), 'equal' => 0, 'allowedUnverifiable' => 0, 'different' => 0, 'pseudoOk' => 0, 'pseudoSkipped' => 0, 'pseudoFailed' => 0];
$differences = [];
$unverifiable = [];
$pseudoFailures = [];
$usedAllowances = [];
foreach ($edits as $edit) {
    $id = coolify_ko_allowance_key($edit['file'], $edit['kind'], hash('sha256', $edit['original']));
    $translator->setLocale('en');
    try {
        [$old, $new] = coolify_ko_sampled_outputs($edit);
    } catch (Throwable $e) {
        [$old, $new] = ['ERROR:harness ' . $e->getMessage(), 'x'];
    }
    $bothError = $old === $new && str_starts_with($old, 'ERROR:');
    if ($bothError && ($allowed[$id] ?? null) === $old) {
        $counts['allowedUnverifiable']++;
        $usedAllowances[$id] = true;
        $unverifiable[] = ['file' => $edit['file'], 'line' => $edit['line'], 'kind' => $edit['kind'], 'error' => $old];
    } elseif ($old === $new && !$bothError) {
        $counts['equal']++;
    } else {
        $counts['different']++;
        $differences[] = ['file' => $edit['file'], 'line' => $edit['line'], 'kind' => $edit['kind'], 'original' => $old, 'replacement' => $new, 'note' => $bothError ? '양쪽 오류인데 허용 목록에 없음' : ''];
    }

    if ($edit['kind'] === 'display-site' || $edit['kind'] === 'prop-display') {
        // 출력 지점 감싸기는 대역 객체가 문자열이 아니라 번역되지 않는다(coolify_ko_t는 단위 테스트로 검증).
        $counts['pseudoSkipped']++;
        continue;
    }
    $translator->setLoaded(['*' => ['*' => ['xx' => $pseudo]]]);
    $translator->setLocale('xx');
    try {
        [, $translated] = coolify_ko_sampled_outputs($edit);
    } catch (Throwable $e) {
        $translated = 'ERROR:harness ' . $e->getMessage();
    }
    $translator->setLocale('en');
    if (!str_starts_with($translated, 'ERROR:') && str_contains($translated, '⟦')) {
        $counts['pseudoOk']++;
    } elseif ($bothError && isset($usedAllowances[$id]) && str_starts_with($translated, 'ERROR:')) {
        $counts['pseudoOk']++;
    } else {
        $counts['pseudoFailed']++;
        $pseudoFailures[] = ['file' => $edit['file'], 'line' => $edit['line'], 'kind' => $edit['kind'], 'output' => mb_substr($translated, 0, 200)];
    }
}
$staleAllowances = array_values(array_diff(array_keys($allowed), array_keys($usedAllowances)));

file_put_contents($reportPath, json_encode([
    'counts' => $counts,
    'differences' => $differences,
    'unverifiable' => $unverifiable,
    'staleAllowances' => $staleAllowances,
    'pseudoFailures' => $pseudoFailures,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
echo 'equivalence: ' . json_encode($counts) . PHP_EOL;
foreach (array_slice($differences, 0, 15) as $d) {
    echo "DIFF {$d['file']}:{$d['line']} [{$d['kind']}] {$d['note']}\n  old: " . mb_substr($d['original'], 0, 220) . "\n  new: " . mb_substr($d['replacement'], 0, 220) . "\n";
}
foreach (array_slice($pseudoFailures, 0, 10) as $p) {
    echo "PSEUDO {$p['file']}:{$p['line']} [{$p['kind']}] {$p['output']}\n";
}
foreach ($staleAllowances as $stale) {
    echo "STALE allow-unverifiable: {$stale}\n";
}
exit($counts['different'] === 0 && $counts['pseudoFailed'] === 0 && $staleAllowances === [] ? 0 : 1);
