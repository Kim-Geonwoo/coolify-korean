# 보안 정책

coolify-ko는 서버의 Coolify 이미지를 바꿔 끼우는 도구라서 보안 제보를 가장 중요하게 다룹니다.

## 지원 범위

최신 판만 고칩니다.

| 대상 | 지원하는 판 |
|---|---|
| 컨테이너 이미지 `ghcr.io/kim-geonwoo/coolify-ko` | 지금 따라가는 Coolify 판([versions.json](https://coolify-ko.geonwoo.dev/versions.json)의 `v4`) |
| 설치 스크립트 `coolify-ko.sh` | 사이트에 올라간 최신본 |
| 브라우저 확장(Chrome·Firefox) | 최신 판 |
| 미러 사이트 `coolify-ko.geonwoo.dev`(버전 정보·번역 사전) | 지금 사이트 |

## 제보 방법

공개 이슈에 올리지 말고 **kgw@geonwoo.dev**로 메일을 보내 주세요. 아래를 담아 주시면 빨리 확인할 수 있습니다.

- 무엇이 문제인지
- 재현 순서
- 예상되는 영향
- 확인한 판(Coolify 판, 확장 판)

확인하는 대로 답장드립니다. 고친 판을 낸 뒤에 제보자와 공개 시점을 정합니다.

## 이런 문제를 알려 주세요

- 서명(cosign)이나 해시 검증을 우회해 다른 이미지·스크립트가 설치되는 문제
- 설치·되돌리기 스크립트가 표시된 전용 구간 밖을 바꾸거나 권한을 넓히는 문제
- 미러의 버전 정보나 번역 사전이 변조될 수 있는 문제
- 번역 문구에 든 HTML·스크립트가 화면에서 실행되는 문제
- 확장이 사용자가 지정한 주소 밖에서 동작하거나 화면 글·데이터를 밖으로 보내는 문제

## Coolify 자체 취약점

영어 공식판에서도 생기는 문제는 [Coolify 보안 정책](https://github.com/coollabsio/coolify/blob/main/SECURITY.md)대로 Coolify에 알려 주세요. coolify-ko는 공식 이미지 위에 번역만 더하므로, 상류의 보안 수정은 새 판이 나오는 대로 따라갑니다. 늦어질 때의 대비책은 [동작 원리와 보안](docs/how-it-works.md#보안-모델)에 있습니다.

## English

Please do not open a public issue for security problems. Email **kgw@geonwoo.dev** with what is wrong, how to reproduce it, the impact, and the versions you checked. Only the latest release is supported. Vulnerabilities that also affect the official English build belong to [Coolify's security policy](https://github.com/coollabsio/coolify/blob/main/SECURITY.md).
