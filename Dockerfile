# syntax=docker/dockerfile:1
# coolify-ko 빌드. 빌드 컨텍스트는 레포 최상위.
#   변환기 시험:   docker build --target app -t coolify-ko-codemod .
#   산출물:        docker build --target artifacts --output type=local,dest=.work/out/4.4.6 .
#   오버레이 이미지: docker build --target overlay -t coolify-ko:4.4.6 .
#   컴파일 검사:   docker build --target compile-check .
# 업스트림 버전은 이미지 다이제스트로 고정한다(태그는 다시 쓰일 수 있다).

ARG COOLIFY_IMAGE=docker.io/coollabsio/coolify:4.4.6@sha256:7c54f42d64c0d20fed4a8f4561df9018a561fecba9931ed3f64a4f3e0d34a3be
ARG COOLIFY_VERSION=4.4.6

# 변환 도구와 변환 입력은 빌드 기계 플랫폼에서 돈다: arm64 판도 같은 변환 결과를 COPY만 하므로 에뮬레이션이 필요 없다(5단계 판결 R3).
# 대신 공식 이미지의 플랫폼별 소스가 같은지는 source-hashes 단계로 확인한다.
FROM --platform=$BUILDPLATFORM ${COOLIFY_IMAGE} AS upstream

# 이 PC(Docker Desktop)의 공유 폴더에서는 PHP SPL 디렉터리 순회가 항목을 빠뜨리므로, 소스를 이미지 안으로 복사해서 돌린다.
FROM --platform=$BUILDPLATFORM php:8.4-cli-alpine@sha256:37c8c64177612b72e7f9d2c00481739c166a3708bea27c1cfd27fea1291d82d1 AS base
COPY --from=composer:2@sha256:af98f42dfff7c68ba8d53c2164fd9fde1087b7d449514baa38c418b1f6bc4bac /usr/bin/composer /usr/bin/composer
RUN apk add --no-cache git unzip
ENV COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1
WORKDIR /work/codemod

FROM base AS deps
COPY codemod/composer.json codemod/composer.lock ./
RUN composer install --no-progress --no-scripts --no-autoloader

FROM deps AS app
COPY codemod/ ./
COPY overlay/ /work/overlay/
RUN composer dump-autoload --optimize

FROM app AS transform
ARG COOLIFY_VERSION
COPY --from=upstream /var/www/html/resources /source/resources
COPY --from=upstream /var/www/html/app /source/app
COPY --from=upstream /var/www/html/config /source/config
COPY --from=upstream /var/www/html/lang /source/lang
RUN php -d memory_limit=2G bin/codemod transform \
      --source /source --out /out --artifacts /artifacts \
      --rules rules/coolify.php --version "${COOLIFY_VERSION}"

FROM scratch AS artifacts
COPY --from=transform /artifacts/ /
COPY --from=transform /out/ /transformed/

FROM ${COOLIFY_IMAGE} AS overlay
ARG COOLIFY_VERSION
COPY --from=transform --chown=www-data:www-data /out/ /var/www/html/
COPY --chown=www-data:www-data overlay/files/ /var/www/html/
# Apache-2.0 4(a)·(d): 이미지를 받는 쪽에 라이선스와 출처 고지를 함께 준다(공식 이미지에는 LICENSE 파일이 없다).
COPY LICENSE NOTICE /usr/share/doc/coolify-ko/
LABEL org.opencontainers.image.title="coolify-ko" \
      org.opencontainers.image.description="Unofficial Korean-ready build of Coolify (translation calls added)" \
      org.opencontainers.image.version="${COOLIFY_VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"

# 다른 사용자용 공개판(5단계): PaaS용 overlay에 검증된 기본 언어 파일만 더한다. 문맥의 lang-default/는 발행 명령이 그 커밋에서 만든다.
#   docker buildx build --platform linux/amd64,linux/arm64 --target public <문맥>
FROM overlay AS public
COPY --chown=www-data:www-data lang-default/ /var/www/html/lang-default/
# source 라벨이 GHCR 패키지를 공개 소스 레포에 잇는다
LABEL org.opencontainers.image.description="Unofficial Korean build of Coolify (with language files)" \
      org.opencontainers.image.source="https://github.com/Kim-Geonwoo/coolify-korean" \
      org.opencontainers.image.url="https://coolify-ko.geonwoo.dev"

# 변경 지점마다 en 출력이 원본과 같은지, 가짜 언어(⟦키⟧)로도 오류 없이 그려지는지 본다(DB·Redis 불필요).
FROM overlay AS equivalence
# DB·Redis에 닿는 식은 즉시 실패하게 둔다(기본 호스트 이름을 찾느라 DNS 대기로 수십 분이 걸렸다).
ENV DB_HOST=127.0.0.1 REDIS_HOST=127.0.0.1
COPY --from=transform /artifacts/reports/edits.jsonl /tmp/coolify-ko/edits.jsonl
COPY tools/equivalence/harness.php tools/equivalence/allow-unverifiable.json /tmp/coolify-ko/
RUN php -d memory_limit=1G /tmp/coolify-ko/harness.php /tmp/coolify-ko/edits.jsonl /tmp/equivalence.json /tmp/coolify-ko/allow-unverifiable.json

FROM scratch AS equivalence-report
COPY --from=equivalence /tmp/equivalence.json /

# 변환한 템플릿이 모두 컴파일되고, 컴파일 결과와 바꾼 PHP가 문법 검사를 통과하는지 본다(DB·Redis 불필요).
FROM overlay AS compile-check
RUN php artisan view:cache \
 && find storage/framework/views -name '*.php' -print0 | xargs -0 -n 50 -P 4 php -l > /tmp/lint.log \
 && find app/Livewire app/Providers app/Http/Middleware config bootstrap/helpers -name '*.php' -print0 | xargs -0 -n 50 -P 4 php -l >> /tmp/lint.log \
 && php artisan view:clear \
 && echo "compile-check ok: $(grep -c 'No syntax errors' /tmp/lint.log) files"

# 공식 이미지의 대상 플랫폼 소스 해시(변환이 읽고 overlay가 덮는 폴더). 해시는 빌드 기계 도구로 계산해 에뮬레이션이 없다.
#   docker buildx build --platform linux/arm64 --target source-hashes-report --output type=local,dest=<폴더> .
FROM ${COOLIFY_IMAGE} AS upstream-target

FROM base AS source-hashes
COPY --from=upstream-target /var/www/html/app /src/app
COPY --from=upstream-target /var/www/html/resources /src/resources
COPY --from=upstream-target /var/www/html/config /src/config
COPY --from=upstream-target /var/www/html/lang /src/lang
COPY --from=upstream-target /var/www/html/bootstrap /src/bootstrap
RUN cd /src && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > /hashes.txt

FROM scratch AS source-hashes-report
COPY --from=source-hashes /hashes.txt /
