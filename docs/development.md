[← README로 돌아가기](../README.md)

# 개발

이 문서는 한국어판을 만드는 쪽의 안내입니다. 쓰는 방법은 [설치 문서](install.md)를, 만든 결과가 서버에서 어떻게 동작하는지는 [동작 원리와 보안](how-it-works.md)을 보세요.

## 만드는 방식

1. 공식 이미지 `coollabsio/coolify:<버전>`에서 화면 템플릿(Blade)과 Livewire 코드를 꺼냅니다.
2. 코드 변환기(`codemod/`)가 하드코딩된 영어를 Laravel 번역 호출로 바꿉니다.
   - 문장: `<h2>General</h2>` → `<h2>{{ __('General') }}</h2>`
   - 컴포넌트 속성: `label="Name"` → `:label="__('Name')"`
   - 링크가 낀 문장: `__h('Use <0>this link</0> …', [...])` (번역문은 이스케이프하고 원본 태그만 다시 끼웁니다)
   - Livewire 알림·검증 문구: `$this->dispatch('success', 'Saved.')` → `coolify_ko_message('Saved.')` (알림 본문은 HTML로 그려지므로 번역문이 태그를 새로 만들지 못하게 합니다)
   - 메뉴 라벨: 정의는 그대로 두고 출력하는 곳만 `{{ coolify_ko_t($item['label']) }}` (템플릿에 영어로 고정된 라벨만, 사용자 데이터는 제외)
   - 컴포넌트 기본값: `@props(['title' => 'Are you sure?'])` → `@props(['title' => __('Are you sure?')])`
   - 화면에 나가는 값 자리의 문자열: `{{ $ok ? 'Ready' : 'Unavailable' }}`, Alpine `x-text="ok ? 'Yes' : 'No'"`, 알림 제목 `window.toast('Success', …)`처럼 결과로 보이는 문자열만 바꾸고 조건·비교 쪽 문자열은 그대로 둡니다
3. 공식 이미지 위에 바뀐 파일만 덮은 `coolify-ko:<버전>` 이미지를 만듭니다.
4. 번역문 `ko.json`은 이미지 밖(`/var/www/html/lang-runtime`)에 두고 런타임에 읽습니다. 급한 수정에 이 경로를 쓰는 방법은 [한계](how-it-works.md#한계)에 있습니다.

## 개발 환경

필요한 것: Node 24, pnpm 10, Docker.

```bash
pnpm install
pnpm verify
```

`pnpm verify`는 경로 검사, lint, 타입 검사, TypeScript 테스트, 코드 변환기 테스트(Docker 안)를 차례로 돌립니다.

## 변환과 검증

```bash
node pipeline/src/cli.ts extract
```

`extract`는 `i18n/en.json`, `i18n/catalog.json`, `reports/coverage.md`를 갱신합니다.

```bash
node pipeline/src/cli.ts gates
```

`gates`는 컴파일 검사와 정적 동등성 검사를 돌립니다.

```bash
docker build --target overlay -t coolify-ko:4.4.6 .
```

이 명령은 오버레이 이미지를 만듭니다.

- 컴파일 검사: 변환한 템플릿을 모두 컴파일하고 컴파일 결과와 바꾼 PHP의 문법을 검사합니다.
- 정적 동등성: 변경 지점마다 영어 출력이 원본과 같은지 봅니다. 화면 HTML은 DOM으로 정규화해 비교하고 글자 그대로 쓰이는 값(알림·검증 문구, 속성 값)은 공백까지 비교합니다. 가짜 언어(`⟦키⟧`)로도 오류 없이 그려지는지 봅니다.
  - 조각만 떼어서는 평가할 수 없는 곳은 사람이 대조한 뒤 [`tools/equivalence/allow-unverifiable.json`](../tools/equivalence/allow-unverifiable.json)에 이유와 함께 적습니다.
    - 항목은 파일·kind·원본 조각 해시로 찾으므로 업스트림이 줄을 밀어도 유지됩니다.
    - 목록에 없거나, 원본 조각이나 오류 문구가 바뀌면 실패합니다(사람이 다시 대조).

변환 결과는 [`reports/coverage.md`](../reports/coverage.md)에 있습니다(4.4.6 기준).

## 시험 인스턴스(로컬 Docker)

```bash
node pipeline/src/cli.ts test-instance prepare --email <DNS가 있는 도메인의 시험 주소>
```

```bash
bash tools/test-instance/run-smoke.sh coolify-ko:4.4.6 xx overlay-xx
```

시험 인스턴스는 `127.0.0.1:18080`에만 열립니다. 시험을 돌리는 PC의 Docker 소켓은 넘기지 않습니다. 자동 업데이트·스케줄러·Horizon은 꺼 둡니다.
