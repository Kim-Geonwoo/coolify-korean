<?php

declare(strict_types=1);

namespace CoolifyKo\Codemod\Tests\Unit\Overlay;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** 볼륨의 언어 파일이 비었거나 깨졌어도 화면이 500이 나지 않게, 쓸 수 있는 첫 폴더만 고른다(5단계 검토 7) */
final class LangDirTest extends TestCase
{
    private string $volume;

    private string $default;

    public static function setUpBeforeClass(): void
    {
        require_once dirname(__DIR__, 4) . '/overlay/files/bootstrap/helpers/coolify_ko.php';
    }

    protected function setUp(): void
    {
        $base = sys_get_temp_dir() . '/coolify-ko-langdir-' . bin2hex(random_bytes(6));
        $this->volume = $base . '/volume';
        $this->default = $base . '/default';
        mkdir($this->volume, 0o777, true);
        mkdir($this->default, 0o777, true);
        file_put_contents($this->default . '/ko.json', '{"Save":"저장"}');
    }

    protected function tearDown(): void
    {
        foreach ([$this->volume, $this->default] as $dir) {
            $path = $dir . '/ko.json';
            if (is_dir($path)) {
                rmdir($path);
            } elseif (is_file($path)) {
                unlink($path);
            }
            rmdir($dir);
        }
        rmdir(dirname($this->volume));
    }

    public function testPrefersAUsableVolumeFile(): void
    {
        file_put_contents($this->volume . '/ko.json', "\n {\"Save\":\"저장하기\"}\n");

        self::assertSame($this->volume, coolify_ko_lang_dir([$this->volume, $this->default], 'ko'));
    }

    public function testFallsBackWhenTheVolumeFileIsMissing(): void
    {
        self::assertSame($this->default, coolify_ko_lang_dir([$this->volume, $this->default], 'ko'));
    }

    /** @return iterable<string, array{string}> */
    public static function brokenFiles(): iterable
    {
        yield 'empty' => [''];
        yield 'blank' => ['   '];
        yield 'list' => ['[]'];
        yield 'string' => ['"str"'];
        yield 'truncated' => ['{"a":'];
    }

    #[DataProvider('brokenFiles')]
    public function testFallsBackWhenTheVolumeFileIsBroken(string $content): void
    {
        file_put_contents($this->volume . '/ko.json', $content);

        self::assertSame($this->default, coolify_ko_lang_dir([$this->volume, $this->default], 'ko'));
    }

    public function testFallsBackWhenTheVolumeFileIsTooLarge(): void
    {
        file_put_contents($this->volume . '/ko.json', '{"Save":"' . str_repeat('가', 40) . '"}');

        self::assertSame($this->default, coolify_ko_lang_dir([$this->volume, $this->default], 'ko', 64));
    }

    public function testSkipsADirectoryNamedLikeTheFile(): void
    {
        mkdir($this->volume . '/ko.json');

        self::assertSame($this->default, coolify_ko_lang_dir([$this->volume, $this->default], 'ko'));
    }

    public function testReturnsNullWhenNothingIsUsable(): void
    {
        file_put_contents($this->volume . '/ko.json', '{');
        file_put_contents($this->default . '/ko.json', '');

        self::assertNull(coolify_ko_lang_dir([$this->volume, $this->default], 'ko'));
    }

    /** 최종 리뷰(2026-10-19): www-data가 못 읽는 root 0600 파일이면 경고가 Laravel 예외가 되어 모든 화면이 500이었다 */
    public function testFallsBackWhenTheVolumeFileCannotBeRead(): void
    {
        file_put_contents($this->volume . '/ko.json', '{"Save":"저장하기"}');
        $read = fn (string $file): string|false => str_starts_with($file, $this->volume) ? false : file_get_contents($file);

        self::assertSame($this->default, coolify_ko_lang_dir([$this->volume, $this->default], 'ko', 8388608, $read));
    }

    public function testFallsBackWhenReadingThrowsLikeLaravelDoes(): void
    {
        file_put_contents($this->volume . '/ko.json', '{"Save":"저장하기"}');
        $read = function (string $file): string|false {
            if (str_starts_with($file, $this->volume)) {
                throw new \ErrorException('file_get_contents(): Failed to open stream: Permission denied');
            }

            return file_get_contents($file);
        };

        self::assertSame($this->default, coolify_ko_lang_dir([$this->volume, $this->default], 'ko', 8388608, $read));
    }

    /** @return iterable<string, array{string}> */
    public static function nonTextValues(): iterable
    {
        yield 'list value' => ['{"Save":["저장"]}'];
        yield 'object value' => ['{"Save":{"a":"저장"}}'];
        yield 'number value' => ['{"Save":1}'];
        yield 'null value' => ['{"Save":null}'];
    }

    /** 값이 글이 아니면 그 키를 쓰는 화면이 e(array) 등으로 500이 된다 */
    #[DataProvider('nonTextValues')]
    public function testFallsBackWhenAValueIsNotText(string $content): void
    {
        file_put_contents($this->volume . '/ko.json', $content);

        self::assertSame($this->default, coolify_ko_lang_dir([$this->volume, $this->default], 'ko'));
    }

    public function testIgnoresEmptyDirectoryNames(): void
    {
        self::assertSame($this->default, coolify_ko_lang_dir(['', $this->default], 'ko'));
    }
}
