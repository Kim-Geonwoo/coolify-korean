[← README로 돌아가기](../README.md)

# 설치와 되돌리기

자체 호스팅 사용자가 쓸 수 있는 설치 방법은 셋입니다. 무엇을 고를지는 [README](../README.md#현재-서버에-적용추천)에서 정합니다. 서버에서 무엇을 바꾸는지는 [동작 원리](how-it-works.md#동작-원리)에 있습니다.

## 스크립트 받기와 확인

A·B는 같은 스크립트 [`scripts/coolify-ko.sh`](../scripts/coolify-ko.sh)를 씁니다. 이 스크립트는 root로 돌므로 받은 뒤 내용을 읽고 실행하세요. `curl … | bash` 꼴로 바로 실행하지 마세요.

```bash
curl -fsSLo coolify-ko.sh https://coolify-ko.geonwoo.dev/coolify-ko.sh
```

```bash
curl -fsSL https://coolify-ko.geonwoo.dev/coolify-ko.sh.sha256 | sha256sum -c -
```

`coolify-ko.sh: OK`가 나오는지 확인합니다.

## 방법 A: 지금 서버에 얹기

Coolify를 이미 쓰고 있는 서버에 얹습니다.

```bash
sudo bash coolify-ko.sh install
```

공개판 스크립트에는 이미지 저장소와 미러 주소가 기본값으로 들어 있습니다. 다른 곳을 쓰려면 `--image <저장소>`, `--versions-url <주소>`를 줍니다.

`install`은 다음 순서로 동작합니다. 중간에 멈추면 파일을 바꾸지 않습니다.

1. 공식 업그레이드가 컨테이너를 다시 띄우는 중이면(`/data/coolify/source/.upgrade-status`) 멈춥니다.
2. 미러가 응답하는지, 한국어판 미러(`coolify-ko` 키가 있음)인지 확인합니다.
3. 지금 버전(`.env`의 `LATEST_IMAGE`)의 한국어판 이미지가 레지스트리에 있는지 확인합니다.
4. 진행 중이거나 대기 중인 배포가 있으면 멈춥니다. 확인 없이 하려면 `--force`를 붙입니다.
5. `/data/coolify/source/.coolify-ko-backup/`에 두 파일을 백업합니다.
6. 두 파일에 표시 구간을 씁니다.
7. 공식 compose 파일 목록 그대로 coolify 컨테이너만 다시 띄웁니다. 실패하면 백업으로 되돌리고 다시 띄웁니다.
8. 되돌릴 때 쓰도록 스크립트를 `/data/coolify/source/coolify-ko.sh`에 둡니다.

### `coolify` 서비스를 직접 둔 서버

`docker-compose.custom.yml`에 `coolify` 서비스(포트 변경 등)를 이미 직접 둔 서버라면, `install`은 아무것도 바꾸지 않고 멈춥니다. 이때는 그 서비스에 아래 `image:` 줄을 직접 넣습니다.

```yaml
image: "ghcr.io/kim-geonwoo/coolify-ko:${LATEST_IMAGE:?LATEST_IMAGE is required}"
```

그리고 `.env`에는 `VERSIONS_URL=https://coolify-ko.geonwoo.dev/versions.json`과 `COOLIFY_LOCALE=ko`를 넣습니다.

### 상태 확인

```bash
sudo bash /data/coolify/source/coolify-ko.sh status
```

## 방법 B: 새로 설치

공식 설치 전에 파일을 두고 공식 설치 스크립트를 그대로 돌립니다. 첫 부팅부터 한국어로 뜹니다. 먼저 [스크립트를 받고 확인](#스크립트-받기와-확인)합니다.

```bash
sudo bash coolify-ko.sh preinstall
```

`preinstall`은 미러에서 한국어판이 있는 최신 버전을 읽어 그 버전을 넣은 공식 설치 명령을 출력합니다. 되돌릴 때 쓰도록 스크립트도 `/data/coolify/source/coolify-ko.sh`에 둡니다. 출력된 명령을 그대로 실행합니다.

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash -s <출력된 버전>
```

공식 install.sh는 기존 `.env` 줄을 먼저 두고 병합하므로 우리 두 키가 남습니다(4.4.6에서 확인). Coolify가 이미 설치된 서버에서는 `preinstall`이 멈춥니다. 이때는 [방법 A](#방법-a-지금-서버에-얹기)를 쓰세요.

## 방법 C: 브라우저 확장

서버는 그대로 두고 내 브라우저에서 Coolify 화면의 글자만 한국어로 바꿉니다. 설치 링크는 https://coolify-ko.geonwoo.dev 첫 쪽에 있습니다.

- Chrome: [Chrome 웹 스토어](https://chromewebstore.google.com/detail/coolify-%ED%95%9C%EA%B5%AD%EC%96%B4-%EB%B9%84%EA%B3%B5%EC%8B%9D/hjfmiecbkiimkbnhoedjicaccmdaihni)에서 설치합니다.
- Firefox: https://coolify-ko.geonwoo.dev 첫 쪽에서 서명된 설치 파일(.xpi)을 받습니다. 파일 옆의 SHA-256과 내려받은 파일의 해시가 같은지 확인할 수 있습니다(`sha256sum coolify-ko-*.xpi`, Windows는 `Get-FileHash`). 새 판은 자동으로 받습니다.

확장은 내가 고른 Coolify 주소에서만 동작합니다. 누락된 문구는 내 브라우저에만 모아 두고 밖으로 보내지 않습니다. 화면이 갱신될 때 잠깐 영어가 보일 수 있습니다.

## 되돌리기

방법 A·B로 설치한 서버는 한 줄로 공식판에 돌아갑니다. 방법 C는 확장을 지우면 됩니다.

```bash
sudo bash /data/coolify/source/coolify-ko.sh uninstall
```

`uninstall`도 공식 업그레이드가 진행 중이면 멈춥니다. 그다음 공식 이미지부터 받습니다. 받지 못하면 아무것도 바꾸지 않습니다. 받은 뒤에 두 파일의 표시 구간을 지우고 공식판으로 다시 띄웁니다. 우리가 만든 `docker-compose.custom.yml`은 지웁니다.

스크립트 없이 직접 되돌릴 수도 있습니다.

1. `/data/coolify/source/.env`에서 `# >>> coolify-ko`부터 `# <<< coolify-ko`까지 지웁니다.
2. `/data/coolify/source/docker-compose.custom.yml`에서도 같은 구간을 지웁니다. 구간만 남은 파일이면 파일을 지웁니다.
3. 공식 파일만으로 다시 띄웁니다. `docker-compose.custom.yml`이 남아 있으면 `-f docker-compose.custom.yml`도 붙입니다.

```bash
cd /data/coolify/source && sudo docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml up -d --wait coolify
```

백업 폴더 `/data/coolify/source/.coolify-ko-backup/`는 지우지 않고 남깁니다. `.env` 사본이 들어 있으니 필요 없으면 지웁니다.

## 이미지 서명 확인

이미지에는 cosign 서명과 출처 증명이 붙습니다. 서명은 다음 명령으로 확인합니다. 서명 방식과 발행 절차는 [보안 모델](how-it-works.md#보안-모델)에 있습니다.

```bash
cosign verify --key https://coolify-ko.geonwoo.dev/cosign.pub ghcr.io/kim-geonwoo/coolify-ko:<버전>
```
