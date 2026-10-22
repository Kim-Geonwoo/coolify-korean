[← README로 돌아가기](../README.md)

# 개발

이 문서는 Coolify 한국어판을 직접 빌드하고 개발하는 분들을 위한 가이드입니다. 일반 사용자를 위한 설치 방법은 [설치 문서](install.md)를, 빌드된 결과물의 동작 구조는 [동작 원리와 보안](how-it-works.md) 문서를 참고하세요.

## 만드는 방식

1. 공식 이미지 `coollabsio/coolify:<버전>`에서 화면 템플릿(Blade)과 Livewire 코드를 추출합니다.
2. 코드 변환기(`codemod/`)가 하드코딩된 영어를 Laravel 번역 함수 호출로 변환합니다.
   - 문장: `<h2>General</h2>` → `<h2>{{ __('General') }}</h2>`
   - 컴포넌트 속성: `label="Name"` → `:label="__('Name')"`
   - 링크가 포함된 문장: `__h('Use <0>this link</0> …', [...])` (번역문은 안전하게 이스케이프하고 원본 HTML 태그만 다시 결합합니다)
   - Livewire 알림 및 검증 문구: `$this->dispatch('success', 'Saved.')` → `coolify_ko_message('Saved.')` (알림 본문은 HTML로 렌더링되므로, 번역문에서 의도치 않은 임의 태그가 생성되지 않도록 방지합니다)
   - 메뉴 라벨: 데이터 정의는 그대로 두고 화면 출력부에만 `{{ coolify_ko_t($item['label']) }}` 적용 (템플릿에 영어로 고정된 라벨만 대상이며, 사용자 입력 데이터는 제외합니다)
   - 컴포넌트 기본값: `@props(['title' => 'Are you sure?'])` → `@props(['title' => __('Are you sure?')])`
   - 화면 출력부 문자열: `{{ $ok ? 'Ready' : 'Unavailable' }}`, Alpine `x-text="ok ? 'Yes' : 'No'"`, 알림 제목 `window.toast('Success', …)`처럼 화면에 직접 보이는 문자열만 치환하며, 조건식이나 비교문 내부의 문자열은 원본 그대로 유지합니다
3. 공식 이미지 위에 변환된 파일만 덮어씌운 `coolify-ko:<버전>` 이미지를 생성합니다.
4. 번역 파일 `ko.json`은 이미지 외부(`/var/www/html/lang-runtime`)에 두고 런타임에 동적으로 로드합니다. 긴급 패치에 이 경로를 활용하는 방법은 [한계](how-it-works.md#한계)에 있습니다.

## 개발 환경

필수 요구사항: Node 24 이상, pnpm 10 이상, Docker.

```bash
pnpm install
pnpm verify
```

`pnpm verify`는 경로 검사, 린트(ESLint), 정적 타입 검사, TypeScript 테스트, 그리고 Docker 컨테이너 내 코드 변환기 테스트를 순서대로 실행하여 전체 무결성을 검증합니다.

## 변환과 검증

```bash
node pipeline/src/cli.ts extract
```

`extract` 명령은 `i18n/en.json`, `i18n/catalog.json`, `reports/coverage.md`를 최신 상태로 갱신합니다.

```bash
node pipeline/src/cli.ts gates
```

`gates` 명령은 컴파일 검사와 정적 동등성 검사를 실행합니다.

```bash
docker build --target overlay -t coolify-ko:4.4.6 .
```

이 명령은 한국어 패치가 적용된 오버레이 컨테이너 이미지를 빌드합니다.

- 컴파일 검사: 변환된 템플릿을 모두 컴파일하고, 컴파일 결과물과 수정한 PHP 코드의 문법 오류(Syntax Error)를 전수 검사합니다.
- 정적 동등성: 코드 변경 지점마다 영문 기본 출력이 원본과 같은지 비교 검증합니다. 화면 HTML은 DOM 구조로 정규화하여 대조하며, 알림·검증 문구나 속성값처럼 글자 그대로 쓰이는 리터럴 값은 공백 단위까지 엄격히 비교합니다. 또한 의사 로캘(`⟦키⟧`) 환경에서도 템플릿 오류 없이 정상 렌더링되는지 확인합니다.
  - 독립된 코드 조각만으로는 자동 평가하기 어려운 영역은 사람이 직접 대조한 뒤 [`tools/equivalence/allow-unverifiable.json`](../tools/equivalence/allow-unverifiable.json)에 사유와 함께 등록합니다.
    - 등록 항목은 파일 경로, 변환 유형(kind), 원본 코드 조각의 해시로 식별되므로 업스트림의 줄 번호가 바뀌어도 안정적으로 유지됩니다.
    - 예외 목록에 없거나, 원본 코드 조각 또는 오류 문구가 변경되면 테스트가 실패하여 사람의 재검증을 요구합니다.

구체적인 변환 통계는 [`reports/coverage.md`](../reports/coverage.md)에서 확인하실 수 있습니다 (4.4.6 버전 기준).

## 시험 인스턴스(로컬 Docker)

```bash
node pipeline/src/cli.ts test-instance prepare --email <DNS가 있는 도메인의 시험 주소>
```

```bash
bash tools/test-instance/run-smoke.sh coolify-ko:4.4.6 xx overlay-xx
```

테스트 인스턴스는 `127.0.0.1:18080` 로컬 포트로만 열립니다. 보안을 위해 테스트를 실행하는 호스트 머신의 Docker 소켓은 컨테이너에 전달하지 않습니다. 또한 자동 업데이트, 작업 스케줄러, Laravel Horizon 프로세스는 자동으로 비활성화됩니다.
