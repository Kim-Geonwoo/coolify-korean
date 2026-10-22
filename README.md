<div align="center">

<img src="extension/static/icons/icon-128.png" width="96" alt="coolify-ko">

# coolify-ko

**자체 호스팅 Coolify를 한국어로.**<br>
공식 이미지 위에 번역만 얹는 비공식 한국어판입니다.

[![Chrome 웹 스토어](https://img.shields.io/chrome-web-store/v/hjfmiecbkiimkbnhoedjicaccmdaihni?label=Chrome&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/coolify-%ED%95%9C%EA%B5%AD%EC%96%B4-%EB%B9%84%EA%B3%B5%EC%8B%9D/hjfmiecbkiimkbnhoedjicaccmdaihni)
[![Firefox](https://img.shields.io/badge/Firefox-.xpi-FF7139?logo=firefoxbrowser&logoColor=white)](https://coolify-ko.geonwoo.dev)
[![Image](https://img.shields.io/badge/ghcr.io-coolify--ko-2496ED?logo=docker&logoColor=white)](https://coolify-ko.geonwoo.dev)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[설치](#현재-서버에-적용추천) · [새로 설치](#번역된-이미지로-새로-설치) · [브라우저 확장](#브라우저-확장) · [로드맵](#로드맵) · [문서](#문서) · [English](#english)

<img src="docs/images/dashboard.jpg" width="800" alt="한국어로 바뀐 Coolify 대시보드">

</div>

> [!NOTE]
> Coolify를 만든 coolLabs와 관계없는 비공식 프로젝트입니다. Coolify는 coolLabs의 Apache-2.0 프로젝트입니다.

## 특징

- **번역만 얹습니다.** 공식 이미지에 번역 파일만 덮고, 업데이트는 공식 `upgrade.sh`로 그대로 합니다.
- **한 줄로 되돌립니다.** 공식 후크 두 개(`docker-compose.custom.yml`의 이미지, `.env`의 `VERSIONS_URL`)만 바꿉니다.
- **서명된 이미지.** amd64·arm64 이미지를 cosign으로 서명해 냅니다.
- **서버를 건드리기 어렵다면** 브라우저 확장으로 내 화면만 바꿀 수 있습니다.

## 로드맵

- [x] Coolify 최신본 자동 번역 및 배포
- [x] AI 번역 및 번역 검수 파이프라인 구축
- [ ] Safari 확장 프로그램 출시
- [ ] 번역 검수 파이프라인 외부 참여 오픈
- [ ] coolify-korean 프로젝트를 자체 호스팅에서 무료 호스팅으로 전환

## 현재 서버에 적용(추천)

Coolify를 이미 쓰고 있다면 이 방법을 권합니다. 그 서버의 모든 사용자가 한국어 화면을 봅니다.

```bash
# 1. 스크립트를 받고 해시를 확인합니다 (coolify-ko.sh: OK)
curl -fsSLo coolify-ko.sh https://coolify-ko.geonwoo.dev/coolify-ko.sh
curl -fsSL https://coolify-ko.geonwoo.dev/coolify-ko.sh.sha256 | sha256sum -c -

# 2. 설치합니다
sudo bash coolify-ko.sh install
```

되돌릴 때는 한 줄이면 됩니다.

```bash
sudo bash /data/coolify/source/coolify-ko.sh uninstall
```

> [!IMPORTANT]
> 스크립트는 root로 돕니다. 받은 뒤 내용을 읽고 실행하세요. `curl … | bash` 꼴로 바로 실행하지 마세요.

`docker-compose.custom.yml`에 `coolify` 서비스를 이미 둔 서버는 [설치 상세](docs/install.md#방법-a-지금-서버에-얹기)를 보세요.

## 번역된 이미지로 새로 설치

새 서버라면 공식 설치 전에 준비해 두세요. 첫 부팅부터 한국어로 뜹니다. 위와 같이 스크립트를 받아 확인한 뒤 실행합니다.

```bash
sudo bash coolify-ko.sh preinstall
```

`preinstall`이 공식 설치 명령을 출력합니다. 그 명령을 그대로 실행하면 됩니다. 순서와 주의점은 [새로 설치 상세](docs/install.md#방법-b-새로-설치)에 있습니다.

## 브라우저 확장

서버는 그대로 두고 내 브라우저에서만 Coolify 화면을 한국어로 바꿉니다.

| 브라우저 | 설치 |
|---|---|
| Chrome | [Chrome 웹 스토어](https://chromewebstore.google.com/detail/coolify-%ED%95%9C%EA%B5%AD%EC%96%B4-%EB%B9%84%EA%B3%B5%EC%8B%9D/hjfmiecbkiimkbnhoedjicaccmdaihni) |
| Firefox | [coolify-ko.geonwoo.dev](https://coolify-ko.geonwoo.dev)에서 `.xpi`를 받습니다(버전·SHA-256 함께 표시, 새 판은 자동 갱신) |

확장은 내가 켠 Coolify 주소에서만 동작하고, 화면 글을 밖으로 보내지 않습니다. 자세한 내용은 [확장 상세](docs/install.md#방법-c-브라우저-확장)와 [개인정보 처리방침](https://coolify-ko.geonwoo.dev/privacy)에 있습니다.

## 문서

| 문서 | 내용 |
|---|---|
| [설치와 되돌리기](docs/install.md) | 설치 방법별 상세, 되돌리기, 이미지 서명 확인(cosign) |
| [동작 원리와 보안](docs/how-it-works.md) | 공식 후크 두 개, 보안 모델, 한계, 종료 정책 |
| [개발](docs/development.md) | 만드는 방식, 개발 환경, 변환과 검증, 시험 인스턴스 |
| [번역 범위](reports/coverage.md) | 4.4.6 기준 변환 결과 |

공개 주소: https://coolify-ko.geonwoo.dev · 이미지: `ghcr.io/kim-geonwoo/coolify-ko`

## 라이선스와 상표

- 이 레포는 [Apache License 2.0](LICENSE)을 따릅니다. Coolify와 같은 라이선스입니다.
- 오버레이 이미지 속 수정 파일과 `i18n/`의 영어 원문은 Coolify에서 왔습니다. 출처와 저작권은 [NOTICE](NOTICE)에 적었고 수정한 파일마다 맨 위에 수정 고지가 있습니다.
- "Coolify" 이름과 로고는 coolLabs Solutions Kft.의 것입니다. 이 프로젝트는 비공식이며 coolLabs와 제휴하거나 보증받지 않았습니다. Coolify 로고를 이 프로젝트의 표지로 쓰지 않습니다.

## 문의

개발자 문의: kgw@geonwoo.dev

Developer contact: kgw@geonwoo.dev

## English

An unofficial Korean build of the Coolify dashboard, not affiliated with coolLabs. Self-hosters can apply it in three ways. Method A switches an existing instance. Method B prepares a new server before running the official installer. Method C is a browser extension that changes nothing on the server. Methods A and B change only two official hooks: the `coolify` image in `docker-compose.custom.yml` and `VERSIONS_URL` in `.env`. Updates still run through the official `upgrade.sh`. To revert, run `sudo bash /data/coolify/source/coolify-ko.sh uninstall`, or delete the marked blocks by hand. Images are built for amd64 and arm64.
