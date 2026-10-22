#!/usr/bin/env bash
# 시험 인스턴스 스모크 한 판: 새 DB로 띄우고 → 온보딩 끄기 → 크롤 → Laravel 오류 로그 수집 → 내리기.
# 사용: tools/test-instance/run-smoke.sh <이미지> <로케일> <이름>
set -euo pipefail
image="$1"; locale="$2"; name="$3"
cd "$(dirname "$0")/../.."
out=.work/smoke
mkdir -p "$out"
node pipeline/src/cli.ts test-instance down >/dev/null 2>&1 || true
node pipeline/src/cli.ts test-instance up --image "$image" --locale "$locale" > "$out/up-$name.log" 2>&1
node pipeline/src/cli.ts test-instance skip-onboarding > "$out/skip-$name.log" 2>&1
node pipeline/src/cli.ts smoke --out "$out/$name.json" | tail -1
node pipeline/src/cli.ts test-instance errors --out "$out/$name-errors.json" | tail -1
node pipeline/src/cli.ts test-instance down >/dev/null 2>&1
echo "$name 완료"
