#!/usr/bin/env bash
# coolify-ko.sh — 공식 Coolify에 한국어판(비공식)을 얹고 되돌린다.
#
# 바꾸는 것은 두 파일의 표시 구간(# >>> coolify-ko … # <<< coolify-ko)뿐이다.
#   /data/coolify/source/docker-compose.custom.yml  coolify 서비스의 이미지
#   /data/coolify/source/.env                       VERSIONS_URL, COOLIFY_LOCALE
# 업데이트는 공식 upgrade.sh가 그대로 한다. 이 스크립트는 설치·제거 때만 돈다.
#
# 사용법: sudo bash coolify-ko.sh install|uninstall|status|preinstall [옵션]
set -euo pipefail
shopt -s inherit_errexit

# 공개 이미지와 미러 주소(5단계 공개). --image·--versions-url로 바꿀 수 있다(시험·다른 레지스트리).
DEFAULT_IMAGE="ghcr.io/kim-geonwoo/coolify-ko"
DEFAULT_VERSIONS_URL="https://coolify-ko.geonwoo.dev/versions.json"

OFFICIAL_INSTALL_URL="https://cdn.coollabs.io/coolify/install.sh"
SRC="${COOLIFY_KO_SOURCE_DIR:-/data/coolify/source}"
CUSTOM_FILE="$SRC/docker-compose.custom.yml"
ENV_FILE="$SRC/.env"
BACKUP_ROOT="$SRC/.coolify-ko-backup"
INSTALLED_SCRIPT="$SRC/coolify-ko.sh"
UPGRADE_STATUS="$SRC/.upgrade-status"
BEGIN_YAML="# >>> coolify-ko (managed by coolify-ko.sh)"
BEGIN_ENV="# >>> coolify-ko"
END_MARK="# <<< coolify-ko"
WAIT_TIMEOUT=300
DEPLOYMENT_SQL="select count(*) from application_deployment_queues where status in ('queued','in_progress')"

USAGE="사용법: sudo bash coolify-ko.sh <명령> [옵션]
  install      지금 Coolify에 한국어판을 얹는다(방법 A)
  uninstall    공식판으로 되돌린다
  status       지금 상태를 보여 준다
  preinstall   새 서버에서 공식 install.sh 전에 파일을 준비한다(방법 B)
옵션(install·preinstall):
  --image REPO         한국어판 이미지 저장소(태그 없이, 예: ghcr.io/owner/coolify-ko)
  --versions-url URL   versions.json 미러 주소
  --locale ko          화면 언어(지금은 ko만)
  --force              진행 중 배포가 있어도 계속한다(install만)"

WORK=""
ROLLBACK_DIR=""

say() { printf '%s\n' "$*"; }
warn() { printf 'coolify-ko: 경고: %s\n' "$*" >&2; }
die() {
  printf 'coolify-ko: %s\n' "$*" >&2
  exit 1
}
usage_error() {
  printf 'coolify-ko: %s\n%s\n' "$*" "$USAGE" >&2
  exit 2
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "$ROLLBACK_DIR" ]; then
    if restore_backup "$ROLLBACK_DIR"; then
      printf 'coolify-ko: 바꾼 파일을 되돌렸습니다(백업: %s)\n' "$ROLLBACK_DIR" >&2
    else
      printf 'coolify-ko: 파일을 되돌리지 못했습니다. 백업에서 직접 복원하세요: %s\n' "$ROLLBACK_DIR" >&2
    fi
  fi
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}
trap on_exit EXIT

# ---------- 인자 ----------

COMMAND="${1:-}"
if [ $# -gt 0 ]; then shift; fi
IMAGE="$DEFAULT_IMAGE"
VERSIONS_URL="$DEFAULT_VERSIONS_URL"
LOCALE="ko"
FORCE=0
OPTIONS_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image | --versions-url | --locale)
      [ $# -ge 2 ] || usage_error "$1 값이 없습니다"
      case "$1" in
        --image) IMAGE="$2" ;;
        --versions-url) VERSIONS_URL="$2" ;;
        --locale) LOCALE="$2" ;;
      esac
      shift 2
      ;;
    --force) FORCE=1 && shift ;;
    -h | --help)
      say "$USAGE"
      exit 0
      ;;
    *) usage_error "알 수 없는 인자: $1" ;;
  esac
  OPTIONS_GIVEN=1
done

validate_target() {
  local repo_re='^[a-z0-9][a-z0-9._-]*(:[0-9]{1,5})?(/[a-z0-9][a-z0-9._-]*)+$'
  local url_re='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%/?=&+-]*)?$'
  [[ $IMAGE =~ $repo_re ]] || usage_error "--image 형식이 틀렸습니다(태그·다이제스트 없이 저장소만): $IMAGE"
  [[ $VERSIONS_URL =~ $url_re ]] || usage_error "--versions-url 형식이 틀렸습니다: $VERSIONS_URL"
  [ "$LOCALE" = "ko" ] || usage_error "지원하는 언어는 ko뿐입니다: $LOCALE"
  case "$VERSIONS_URL" in
    https://*) ;;
    *) warn "https가 아닌 미러 주소입니다: $VERSIONS_URL" ;;
  esac
}

# ---------- 파일 읽기 ----------

require_root() {
  [ "$(id -u)" = "0" ] || die "root로 실행하세요: sudo bash coolify-ko.sh $COMMAND …"
}

require_installation() {
  local file
  for file in "$SRC/docker-compose.yml" "$SRC/docker-compose.prod.yml" "$ENV_FILE"; do
    [ -f "$file" ] || die "Coolify 설치 파일이 없습니다: $file"
  done
}

# 공식 upgrade.sh(4.4.6)는 컨테이너 재시작을 백그라운드로 돌리며 진행 단계(1~6, error)를 이 파일에 쓰고,
# 끝나면 지운다. 그 사이에 compose를 돌리면 두 쪽이 같은 컨테이너를 다룬다
require_no_upgrade() {
  local step
  [ -f "$UPGRADE_STATUS" ] || return 0
  step=$(head -n 1 "$UPGRADE_STATUS" | cut -d '|' -f 1)
  case "$step" in
    [1-5]) die "Coolify 업그레이드가 진행 중입니다($UPGRADE_STATUS 단계 $step). 끝난 뒤 다시 실행하세요. 멈춘 업그레이드라면 그 파일을 지운 뒤 다시 실행하세요" ;;
  esac
}

# .env에서 마지막으로 정한 값을 읽는다(앞뒤 따옴표는 뗀다)
env_value() {
  local value
  value=$(awk -v key="$1" '
    { line = $0; sub(/\r$/, "", line); sub(/^[ \t]*(export[ \t]+)?/, "", line) }
    index(line, key "=") == 1 { value = substr(line, length(key) + 2); found = 1 }
    END { if (found) print value }
  ' "$2")
  value="${value#[\"\']}"
  value="${value%[\"\']}"
  printf '%s' "$value"
}

latest_image_tag() {
  local tag
  tag=$(env_value LATEST_IMAGE "$ENV_FILE")
  [[ $tag =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]] || die ".env의 LATEST_IMAGE가 비었거나 형식이 틀렸습니다: '$tag'"
  printf '%s' "$tag"
}

has_block() {
  grep -Eq '^[[:space:]]*# >>> coolify-ko([[:space:]]|$)' "$1"
}

# 표시 구간을 뺀 내용을 쓴다. 구간이 짝이 맞지 않으면 3으로 끝난다.
# 표시 줄은 끝의 CR을 떼고 비교한다(윈도 편집기로 저장한 CRLF 파일). 남는 줄은 원래 줄끝 그대로 쓴다
strip_block() {
  awk '
    { line = $0; sub(/\r$/, "", line) }
    line ~ /^[ \t]*# >>> coolify-ko([ \t]|$)/ { if (inside) bad = 1; inside = 1; next }
    line ~ /^[ \t]*# <<< coolify-ko([ \t]|$)/ { if (!inside) bad = 1; inside = 0; next }
    !inside { print }
    END { if (inside || bad) exit 3 }
  ' "$1"
}

strip_to() {
  strip_block "$1" >"$2" || die "표시 구간(# >>> coolify-ko … # <<< coolify-ko)이 깨졌습니다. 직접 고친 뒤 다시 실행하세요: $1"
  # 구간을 다 지웠는지 한 번 더 본다(지우지 못하고 "되돌렸습니다"라고 하지 않게)
  ! has_block "$2" || die "표시 구간을 지우지 못했습니다. 직접 고친 뒤 다시 실행하세요: $1"
}

# custom.yml(구간을 뺀 것)을 읽어 "services줄 서비스들여쓰기 coolify있음"을 출력한다.
# 자동으로 고칠 수 없는 모양이면 문제 이름을 출력하고 3으로 끝난다.
analyze_custom() {
  awk -v q="'" '
    { sub(/\r$/, "") }
    /^services:[ \t]*(#.*)?$/ { services++; at = NR; inside = 1; next }
    /^services:/ { problem = "services 값이 한 줄 형식"; next }
    $0 ~ ("^[\"" q "]services[\"" q "][ \t]*:") { problem = "따옴표로 감싼 services"; next }
    inside {
      if ($0 ~ /^[ \t]*(#.*)?$/) next
      if ($0 !~ /^[ \t]/) { inside = 0; next }
      if ($0 ~ /^ *\t/) { problem = "탭 들여쓰기"; next }
      match($0, /^ +/)
      n = RLENGTH
      if (indent == "") indent = n
      if (n < indent) { problem = "들여쓰기가 맞지 않음"; next }
      if (n != indent) next
      key = substr($0, n + 1)
      if (key ~ ("^[\"" q "]?coolify[\"" q "]?[ \t]*:([ \t]|$)")) coolify = 1
      if (key ~ /^<<[ \t]*:/) problem = "병합 키(<<)"
    }
    END {
      if (services > 1) problem = "services가 둘 이상"
      if (problem != "") { print problem; exit 3 }
      print (services ? at : 0), (indent == "" ? -1 : indent), (coolify ? 1 : 0)
    }
  ' "$1"
}

image_value() {
  printf '"%s:${LATEST_IMAGE:?LATEST_IMAGE is required}"' "$IMAGE"
}

created_custom() {
  printf '%s\nservices:\n  coolify:\n    image: %s\n%s\n' "$BEGIN_YAML" "$(image_value)" "$END_MARK"
}

# 새 custom.yml 내용을 $1에 쓴다
build_custom() {
  local out=$1 stripped="$WORK/custom.stripped" result at indent coolify pad
  if [ ! -f "$CUSTOM_FILE" ]; then
    created_custom >"$out"
    return
  fi
  strip_to "$CUSTOM_FILE" "$stripped"
  if ! grep -q '[^[:space:]]' "$stripped"; then
    created_custom >"$out"
    return
  fi
  result=$(analyze_custom "$stripped") || die "custom.yml을 자동으로 고칠 수 없습니다($result). 직접 coolify 이미지를 넣거나 파일을 정리하세요: $CUSTOM_FILE"
  read -r at indent coolify <<<"$result"
  if [ "$coolify" = "1" ]; then
    die "custom.yml에 이미 coolify 서비스가 있습니다. 아무것도 바꾸지 않았습니다. coolify의 image를 직접 바꾸거나 그 항목을 정리한 뒤 다시 실행하세요: $CUSTOM_FILE"
  fi
  if [ "$at" = "0" ]; then
    cat "$stripped" >"$out"
    created_custom >>"$out"
    return
  fi
  [ "$indent" -ge 1 ] || indent=2
  pad=$(printf '%*s' "$indent" '')
  awk -v at="$at" -v pad="$pad" -v begin="$BEGIN_YAML" -v end="$END_MARK" -v image="$(image_value)" '
    { print }
    NR == at { print pad begin; print pad "coolify:"; print pad pad "image: " image; print pad end }
  ' "$stripped" >"$out"
}

# 새 .env 내용을 $1에 쓴다
build_env() {
  local out=$1 stripped="$WORK/env.stripped" key
  if [ -f "$ENV_FILE" ]; then
    strip_to "$ENV_FILE" "$stripped"
    for key in VERSIONS_URL COOLIFY_LOCALE; do
      if grep -Eq "^[[:space:]]*(export[[:space:]]+)?$key=" "$stripped"; then
        die ".env의 표시 구간 밖에 $key가 이미 있습니다. 아무것도 바꾸지 않았습니다. 그 줄을 지운 뒤 다시 실행하세요: $ENV_FILE"
      fi
    done
    cat "$stripped" >"$out"
  else
    : >"$out"
  fi
  printf '%s\nVERSIONS_URL=%s\nCOOLIFY_LOCALE=%s\n%s\n' "$BEGIN_ENV" "$VERSIONS_URL" "$LOCALE" "$END_MARK" >>"$out"
}

# ---------- 파일 쓰기·백업 ----------

new_work_dir() {
  WORK=$(mktemp -d "$SRC/.coolify-ko-work.XXXXXX")
}

# $1의 내용으로 $2를 바꾼다. 원래 파일의 권한·소유자를 지키고, 같은 폴더 안에서 mv한다
put_content() {
  local stage="$WORK/stage"
  if [ -e "$2" ]; then
    cp -p "$2" "$stage"
    cat "$1" >"$stage"
  else
    (umask 077 && cat "$1" >"$stage")
  fi
  mv -f "$stage" "$2"
}

make_backup() {
  local dir
  (umask 077 && mkdir -p "$BACKUP_ROOT")
  dir=$(mktemp -d "$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ).XXXX")
  if [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$dir/env"; else : >"$dir/env.absent"; fi
  if [ -f "$CUSTOM_FILE" ]; then cp -p "$CUSTOM_FILE" "$dir/custom.yml"; else : >"$dir/custom.absent"; fi
  printf '%s' "$dir"
}

restore_one() {
  local saved=$1 absent=$2 target=$3
  if [ -f "$saved" ]; then
    cp -p "$saved" "$WORK/restore" && mv -f "$WORK/restore" "$target"
  elif [ -f "$absent" ]; then
    rm -f "$target"
  else
    return 1
  fi
}

restore_backup() {
  local dir=$1 failed=0
  restore_one "$dir/env" "$dir/env.absent" "$ENV_FILE" || failed=1
  restore_one "$dir/custom.yml" "$dir/custom.absent" "$CUSTOM_FILE" || failed=1
  return "$failed"
}

# ---------- docker ----------

# 공식 upgrade.sh와 같은 파일 목록으로 coolify만 다시 띄운다
compose_up() {
  local files=(-f "$SRC/docker-compose.yml" -f "$SRC/docker-compose.prod.yml")
  if [ -f "$CUSTOM_FILE" ]; then files+=(-f "$CUSTOM_FILE"); fi
  if [ -f "$SRC/docker-compose.postgres-upgrade.yml" ]; then files+=(-f "$SRC/docker-compose.postgres-upgrade.yml"); fi
  docker compose --env-file "$ENV_FILE" "${files[@]}" up -d --wait --wait-timeout "$WAIT_TIMEOUT" coolify
}

check_deployments() {
  local user db out message
  user=$(env_value DB_USERNAME "$ENV_FILE")
  db=$(env_value DB_DATABASE "$ENV_FILE")
  if out=$(docker exec coolify-db psql -U "${user:-coolify}" -d "${db:-coolify}" -tAc "$DEPLOYMENT_SQL" 2>/dev/null); then
    out=$(printf '%s' "$out" | tr -d '[:space:]')
  else
    out=""
  fi
  if [[ $out =~ ^[0-9]+$ ]]; then
    [ "$out" -ne 0 ] || return 0
    message="진행 중이거나 대기 중인 배포가 ${out}개 있습니다"
  else
    message="진행 중인 배포 수를 확인하지 못했습니다"
  fi
  if [ "$FORCE" = "1" ]; then
    warn "$message. --force라 계속합니다"
    return 0
  fi
  die "$message. 배포가 끝난 뒤 다시 실행하거나, 확인 없이 하려면 --force를 붙이세요"
}

copy_self() {
  local self="${BASH_SOURCE[0]:-}"
  if [ -z "$self" ] || [ ! -f "$self" ]; then
    warn "스크립트 파일을 찾지 못해 $INSTALLED_SCRIPT 에 두지 못했습니다. 되돌릴 때는 이 스크립트를 다시 받아 uninstall을 실행하세요"
    return 0
  fi
  if [ "$self" -ef "$INSTALLED_SCRIPT" ]; then return 0; fi
  if ! { cp "$self" "$WORK/self" && chmod 700 "$WORK/self" && mv -f "$WORK/self" "$INSTALLED_SCRIPT"; }; then
    warn "$INSTALLED_SCRIPT 에 스크립트를 두지 못했습니다"
  fi
}

mirror_error() {
  printf '미러가 응답하지 않거나 한국어판 미러가 아닙니다(coolify-ko 키 없음): %s. 아무것도 바꾸지 않았습니다' "$VERSIONS_URL"
}

# 미러가 응답하고 coolify-ko 키와 coolify 버전이 있는지 본다. 그 버전을 출력한다
check_mirror() {
  local body version
  body=$(curl -fsS --max-time 10 "$1") || return 1
  printf '%s' "$body" | grep -q '"coolify-ko"[[:space:]]*:' || return 1
  version=$(printf '%s' "$body" | tr -d ' \t\r\n' |
    sed -n 's/.*"coolify":{"v4":{"version":"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p')
  [ -n "$version" ] || return 1
  printf '%s' "$version"
}

# ---------- 명령 ----------

cmd_install() {
  local tag backup
  validate_target
  require_root
  require_installation
  require_no_upgrade
  tag=$(latest_image_tag)
  new_work_dir
  build_custom "$WORK/custom.new"
  build_env "$WORK/env.new"
  check_mirror "$VERSIONS_URL" >/dev/null || die "$(mirror_error)"

  # docker 데몬은 127.0.0.0/8 레지스트리를 HTTP로도 받지만 manifest 명령은 HTTPS만 쓴다. 같은 범위만 맞춘다
  local inspect=(docker manifest inspect)
  if [[ $IMAGE =~ ^(localhost|127\.[0-9]+\.[0-9]+\.[0-9]+)(:[0-9]+)?/ ]]; then inspect+=(--insecure); fi
  "${inspect[@]}" "$IMAGE:$tag" >/dev/null ||
    die "이미지 태그를 찾지 못했습니다: $IMAGE:$tag. 아무것도 바꾸지 않았습니다"
  check_deployments

  backup=$(make_backup)
  ROLLBACK_DIR=$backup
  put_content "$WORK/custom.new" "$CUSTOM_FILE"
  put_content "$WORK/env.new" "$ENV_FILE"

  if ! compose_up; then
    restore_backup "$backup" || die "compose up에 실패했고 파일도 되돌리지 못했습니다. 백업에서 직접 복원하세요: $backup"
    ROLLBACK_DIR=""
    compose_up || warn "원래 설정으로도 다시 띄우지 못했습니다. docker ps로 확인하세요"
    die "compose up에 실패해 원래 설정으로 되돌렸습니다(백업: $backup)"
  fi
  ROLLBACK_DIR=""
  copy_self
  say "한국어판을 적용했습니다: $IMAGE:$tag"
  say "백업: $backup"
  say "되돌리기: sudo bash $INSTALLED_SCRIPT uninstall"
}

cmd_uninstall() {
  local tag registry official backup remove_custom=0
  require_root
  require_installation
  require_no_upgrade
  tag=$(latest_image_tag)
  registry=$(env_value REGISTRY_URL "$ENV_FILE")
  official="${registry:-docker.io}/coollabsio/coolify:$tag"
  new_work_dir
  strip_to "$ENV_FILE" "$WORK/env.new"
  if [ -f "$CUSTOM_FILE" ]; then
    strip_to "$CUSTOM_FILE" "$WORK/custom.new"
    if ! grep -q '[^[:space:]]' "$WORK/custom.new"; then remove_custom=1; fi
  fi
  if ! has_block "$ENV_FILE" && { [ ! -f "$CUSTOM_FILE" ] || ! has_block "$CUSTOM_FILE"; }; then
    say "표시 구간이 없습니다. 공식 설정 그대로 coolify를 다시 띄웁니다"
  fi

  say "공식 이미지를 받습니다: $official"
  docker pull "$official" || die "공식 이미지를 받지 못했습니다: $official. 아무것도 바꾸지 않았습니다"

  backup=$(make_backup)
  ROLLBACK_DIR=$backup
  put_content "$WORK/env.new" "$ENV_FILE"
  if [ "$remove_custom" = "1" ]; then
    rm -f "$CUSTOM_FILE"
  elif [ -f "$CUSTOM_FILE" ]; then
    put_content "$WORK/custom.new" "$CUSTOM_FILE"
  fi
  # 여기부터는 공식 설정이다. compose가 실패해도 한국어판으로 되돌리지 않는다
  ROLLBACK_DIR=""
  compose_up || die "공식판으로 다시 띄우지 못했습니다(파일은 공식 설정으로 바꿨습니다, 백업: $backup). 다시 실행하세요: sudo bash $INSTALLED_SCRIPT uninstall"
  rm -f "$INSTALLED_SCRIPT"
  say "공식판으로 되돌렸습니다: $official"
  say "백업: $backup"
}

cmd_status() {
  local image="" url="" locale="" running mirror body
  if [ ! -f "$CUSTOM_FILE" ]; then
    say "custom.yml: 없음"
  elif [ ! -r "$CUSTOM_FILE" ]; then
    say "custom.yml: 읽을 수 없음(sudo로 실행하세요)"
  elif has_block "$CUSTOM_FILE"; then
    image=$(awk '
      { sub(/\r$/, "") }
      /^[ \t]*# >>> coolify-ko([ \t]|$)/ { inside = 1; next }
      /^[ \t]*# <<< coolify-ko([ \t]|$)/ { inside = 0; next }
      inside && /^[ \t]*image:/ { sub(/^[ \t]*image:[ \t]*/, ""); print; exit }
    ' "$CUSTOM_FILE")
    say "custom.yml: 표시 구간 있음, 이미지 $image"
  else
    say "custom.yml: 표시 구간 없음"
  fi

  if [ ! -f "$ENV_FILE" ]; then
    say ".env: 없음"
  elif [ ! -r "$ENV_FILE" ]; then
    say ".env: 읽을 수 없음(sudo로 실행하세요)"
  elif has_block "$ENV_FILE"; then
    url=$(env_value VERSIONS_URL "$ENV_FILE")
    locale=$(env_value COOLIFY_LOCALE "$ENV_FILE")
    say ".env: 표시 구간 있음, VERSIONS_URL $url, COOLIFY_LOCALE $locale"
  else
    say ".env: 표시 구간 없음"
  fi

  running=$(docker inspect -f '{{.Config.Image}}' coolify 2>/dev/null) || running="확인 못 함"
  say "실행 중인 coolify 이미지: $running"

  if [ -z "$url" ]; then
    mirror="VERSIONS_URL 없음(공식 versions.json을 씀)"
  elif body=$(curl -fsS --max-time 10 "$url" 2>/dev/null); then
    if printf '%s' "$body" | grep -q '"coolify-ko"'; then
      mirror="응답함, coolify-ko 키 있음"
    else
      mirror="응답함, coolify-ko 키 없음(한국어판 미러가 아닐 수 있음)"
    fi
  else
    mirror="응답 없음"
  fi
  say "미러: $mirror"
}

cmd_preinstall() {
  local version
  validate_target
  require_root
  if [ -f "$SRC/docker-compose.yml" ]; then
    die "이미 Coolify가 설치된 서버입니다. preinstall 대신 install을 쓰세요"
  fi
  version=$(check_mirror "$VERSIONS_URL") || die "$(mirror_error)"
  (umask 077 && mkdir -p "$SRC")
  new_work_dir
  build_custom "$WORK/custom.new"
  build_env "$WORK/env.new"
  put_content "$WORK/custom.new" "$CUSTOM_FILE"
  put_content "$WORK/env.new" "$ENV_FILE"
  copy_self
  say "준비했습니다: $CUSTOM_FILE, $ENV_FILE"
  say "이제 공식 설치 명령을 실행하세요(첫 부팅부터 한국어판):"
  say "  curl -fsSL $OFFICIAL_INSTALL_URL | sudo bash -s $version"
  say "되돌리기: sudo bash $INSTALLED_SCRIPT uninstall"
}

case "$COMMAND" in
  install) cmd_install ;;
  preinstall)
    [ "$FORCE" = "0" ] || usage_error "--force는 install에만 씁니다"
    cmd_preinstall
    ;;
  uninstall | status)
    [ "$OPTIONS_GIVEN" = "0" ] || usage_error "$COMMAND 에는 옵션이 없습니다"
    "cmd_$COMMAND"
    ;;
  -h | --help | help) say "$USAGE" ;;
  "") usage_error "명령이 없습니다" ;;
  *) usage_error "알 수 없는 명령: $COMMAND" ;;
esac
