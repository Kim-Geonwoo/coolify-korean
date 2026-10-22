[← README로 돌아가기](../README.md)

# 설치와 되돌리기

자체 호스팅 환경에서 적용할 수 있는 설치 방법은 총 세 가지입니다. 환경에 맞는 설치 방법은 [README](../README.md#현재-서버에-적용추천)의 설명을 참고하여 선택해 주세요. 서버의 변경 사항에 관한 기술적인 내용은 [동작 원리](how-it-works.md#동작-원리) 문서에 정리되어 있습니다.

## 스크립트 받기와 확인

방법 A와 B는 동일한 스크립트([`scripts/coolify-ko.sh`](../scripts/coolify-ko.sh))를 사용합니다.

```bash
curl -fsSLo coolify-ko.sh https://coolify-ko.geonwoo.dev/coolify-ko.sh
```

```bash
curl -fsSL https://coolify-ko.geonwoo.dev/coolify-ko.sh.sha256 | sha256sum -c -
```

출력 결과로 `coolify-ko.sh: OK`가 나타나는지 확인합니다.

## 방법 A: 지금 서버에 얹기

이미 Coolify를 운영 중인 기존 서버에 한국어 패치를 적용합니다.

```bash
sudo bash coolify-ko.sh install
```

배포된 스크립트에는 기본 이미지 저장소와 미러 주소가 설정되어 있습니다. 사용자 지정 저장소나 미러를 사용하려면 `--image <저장소>`, `--versions-url <주소>` 옵션을 지정할 수 있습니다.

`install` 명령어는 다음 순서로 진행되며, 도중에 오류가 발생해 중단되면 기존 설정 파일을 전혀 변경하지 않습니다.

1. 공식 업그레이드 과정에서 컨테이너를 재시작하는 중인 경우(`/data/coolify/source/.upgrade-status`), 작업을 안전하게 중단합니다.
2. 업데이트 미러가 정상적으로 응답하는지, 유효한 한국어판 미러(`coolify-ko` 키 포함)인지 확인합니다.
3. 현재 실행 중인 버전(`.env`의 `LATEST_IMAGE`)에 해당하는 한국어판 이미지가 컨테이너 레지스트리에 존재하는지 확인합니다.
4. 현재 진행 중이거나 대기 중인 배포 작업이 있으면 중단합니다. 별도 확인 없이 강제로 진행하려면 `--force` 옵션을 지정합니다.
5. `/data/coolify/source/.coolify-ko-backup/` 디렉토리에 변경할 두 설정 파일을 안전하게 백업합니다.
6. 두 파일(`docker-compose.custom.yml`, `.env`)에 한국어 패치 전용 표시 구간(마커)을 작성합니다.
7. 공식 Compose 파일 구성을 그대로 유지한 채 `coolify` 컨테이너만 다시 실행합니다. 실행에 실패할 경우 백업된 파일로 자동 복구한 뒤 재실행합니다.
8. 추후 원상 복구 시 사용할 수 있도록 설치 스크립트를 `/data/coolify/source/coolify-ko.sh` 위치에 보관합니다.

### `coolify` 서비스를 직접 둔 서버

포트 변경 등의 이유로 `docker-compose.custom.yml`에 이미 `coolify` 서비스 설정을 직접 추가해 둔 서버라면, 충돌을 방지하기 위해 `install` 스크립트는 설정을 변경하지 않고 중단됩니다. 이 경우에는 해당 서비스 정의에 아래 `image:` 설정을 직접 추가해 주시면 됩니다.

```yaml
image: "ghcr.io/kim-geonwoo/coolify-ko:${LATEST_IMAGE:?LATEST_IMAGE is required}"
```

이어서 `.env` 파일에 `VERSIONS_URL=https://coolify-ko.geonwoo.dev/versions.json`과 `COOLIFY_LOCALE=ko`를 추가합니다.

### 상태 확인

```bash
sudo bash /data/coolify/source/coolify-ko.sh status
```

## 방법 B: 새로 설치

공식 Coolify를 설치하기 전에 사전 설정을 구성해 두고 공식 설치 스크립트를 그대로 실행하는 방식입니다. 최초 실행 시점부터 한국어로 시작됩니다. 먼저 [스크립트를 받고 확인](#스크립트-받기와-확인) 절차를 진행해 주세요.

```bash
sudo bash coolify-ko.sh preinstall
```

`preinstall` 명령은 미러에서 한국어판이 제공되는 최신 버전을 확인한 뒤, 해당 버전이 포함된 공식 설치 명령을 출력합니다. 또한 원상 복구 시 사용할 수 있도록 스크립트를 `/data/coolify/source/coolify-ko.sh` 위치에 함께 보관합니다. 터미널에 출력된 명령을 그대로 실행하시면 됩니다.

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash -s <출력된 버전>
```

공식 `install.sh`는 기존 `.env` 파일의 설정을 우선하여 병합하므로, 미리 설정해 둔 두 환경 변수 키가 안전하게 유지됩니다(4.4.6 버전 기준 검증 완료). 만약 Coolify가 이미 설치되어 있는 서버라면 `preinstall`이 안전하게 중단되므로, [방법 A](#방법-a-지금-서버에-얹기)를 사용해 주세요.

## 방법 C: 브라우저 확장

서버 설정은 전혀 변경하지 않고, 내 웹 브라우저에서만 Coolify 대시보드 화면의 텍스트를 실시간으로 한국어로 변환합니다. 설치 링크는 공식 웹사이트(https://coolify-ko.geonwoo.dev) 메인 페이지에서 제공됩니다.

- Chrome: [Chrome 웹 스토어](https://chromewebstore.google.com/detail/coolify-%ED%95%9C%EA%B5%AD%EC%96%B4-%EB%B9%84%EA%B3%B5%EC%8B%9D/hjfmiecbkiimkbnhoedjicaccmdaihni)에서 설치합니다.
- Firefox: https://coolify-ko.geonwoo.dev 메인 페이지에서 서명된 설치 파일(.xpi)을 내려받습니다. 파일 옆에 안내된 SHA-256 해시와 다운로드한 파일의 해시가 일치하는지 확인할 수 있으며(`sha256sum coolify-ko-*.xpi`, Windows는 `Get-FileHash`), 새로운 버전 출시 시 자동으로 업데이트됩니다.

확장 프로그램은 사용자가 직접 활성화한 Coolify 주소에서만 동작합니다. 번역되지 않은 누락 문구는 브라우저 로컬 저장소에만 보관되며 외부로 전송되지 않습니다. 실시간 화면 갱신 시점에 일시적으로 영어가 보였다가 한국어로 전환될 수 있습니다.

## 되돌리기

방법 A나 B로 설치한 서버는 명령어 한 줄로 언제든 공식 버전으로 복구할 수 있습니다. 방법 C는 브라우저 확장을 삭제하시면 됩니다.

```bash
sudo bash /data/coolify/source/coolify-ko.sh uninstall
```

`uninstall` 명령어 역시 공식 업그레이드가 진행 중인 경우 안전을 위해 작업을 중단합니다. 이후 공식 이미지를 먼저 정상적으로 다운로드(pull)한 뒤, 설정 파일의 패치 구간을 정리하고 공식 버전 컨테이너를 다시 실행합니다(이미지를 정상적으로 받지 못하면 어떠한 파일도 변경하지 않습니다). 패치 과정에서 새로 생성된 `docker-compose.custom.yml` 파일은 삭제됩니다.

스크립트 없이 직접 되돌릴 수도 있습니다.

1. `/data/coolify/source/.env` 파일에서 `# >>> coolify-ko`부터 `# <<< coolify-ko` 사이의 패치 구간을 삭제합니다.
2. `/data/coolify/source/docker-compose.custom.yml` 파일에서도 동일하게 해당 구간을 삭제합니다(패치 구간 외에 내용이 없다면 파일 자체를 삭제합니다).
3. 공식 파일 구성만으로 컨테이너를 재시작합니다. 다른 커스텀 설정이 있어 `docker-compose.custom.yml`이 남아 있다면 `-f docker-compose.custom.yml` 옵션도 함께 지정합니다.

```bash
cd /data/coolify/source && sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up -d --wait coolify
```

백업 폴더(`/data/coolify/source/.coolify-ko-backup/`)는 자동으로 삭제되지 않고 보존됩니다. 민감한 설정이 포함된 `.env` 사본이 들어 있으므로, 복구가 정상 완료된 후 더 이상 필요하지 않다면 수동으로 삭제해 주세요.

## 이미지 서명 확인

배포되는 컨테이너 이미지에는 cosign 디지털 서명과 빌드 출처 증명(Attestation)이 첨부되어 있습니다. 아래 명령으로 이미지 서명을 검증할 수 있습니다. 구체적인 서명 방식과 발행 절차는 [보안 모델](how-it-works.md#보안-모델)을 참고하세요.

```bash
cosign verify --key https://coolify-ko.geonwoo.dev/cosign.pub ghcr.io/kim-geonwoo/coolify-ko:<버전>
```
