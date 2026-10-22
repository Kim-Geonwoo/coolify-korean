import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface Step {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

const root = join(import.meta.dirname, '..');
const bin = (...parts: string[]): string => join(root, 'node_modules', ...parts);
const node = process.execPath;
const codemodImage = 'coolify-ko-codemod:verify';

const steps: readonly Step[] = [
  { name: '경로 검사', command: node, args: [join(root, 'scripts', 'repo-guard.ts')] },
  { name: 'lint', command: node, args: [bin('eslint', 'bin', 'eslint.js'), '.', '--max-warnings=0'] },
  { name: 'typecheck', command: node, args: [bin('typescript', 'bin', 'tsc'), '--noEmit'] },
  { name: 'test(TS)', command: node, args: [bin('vitest', 'vitest.mjs'), 'run'] },
  { name: 'codemod 이미지', command: 'docker', args: ['build', '--quiet', '-f', join(root, 'Dockerfile'), '--target', 'app', '-t', codemodImage, root] },
  // i18n/은 이미지에 넣지 않는다(초안이 바뀔 때마다 추출 단계가 다시 돌지 않게). 초안 렌더 검사용으로 읽기 전용으로 붙인다
  { name: 'test(codemod)', command: 'docker', args: ['run', '--rm', '--mount', `type=bind,src=${join(root, 'i18n')},dst=/work/i18n,readonly`, codemodImage, 'vendor/bin/phpunit', '--fail-on-warning', '--fail-on-risky', '--fail-on-empty-test-suite'] },
];

for (const required of [bin('eslint', 'bin', 'eslint.js'), bin('typescript', 'bin', 'tsc'), bin('vitest', 'vitest.mjs')]) {
  if (!existsSync(required)) {
    console.error(`의존성이 없습니다: ${required}\npnpm install --frozen-lockfile 을 먼저 실행하세요.`);
    process.exit(1);
  }
}

for (const step of steps) {
  console.log(`\n▶ ${step.name}`);
  const started = Date.now();
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit', windowsHide: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error !== undefined) {
    console.error(`✗ ${step.name}: 실행하지 못했습니다(${result.error.message})`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`✗ ${step.name} 실패(exit ${String(result.status)}, ${seconds}s)`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${step.name} (${seconds}s)`);
}
console.log('\nverify 통과');
