import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appJwt, gitAuthEnv, installationToken } from './githubApp.ts';

/**
 * 리허설용: GitHub App 신원으로 빈 커밋을 dev와 rehearsal/app-probe에 밀어 본다(서버 훅은 건너뛴다).
 * dev는 규칙셋이 거부해야 하고(종료 코드 ≠ 0), 규칙셋 밖 브랜치(rehearsal/app-probe)는 받아들여야 한다(0). 그 브랜치는 바로 지운다.
 * rehearse.sh가 coolify-ko-sync.service와 같은 조건(LoadCredential)으로 돌린다.
 */
const WORK = '/srv/coolify-ko/work/coolify-ko';
const REPO_URL = 'https://github.com/Kim-Geonwoo/coolify-ko.git';
const credentials = process.env['CREDENTIALS_DIRECTORY'];
if (credentials === undefined) {
  throw new Error('CREDENTIALS_DIRECTORY가 없습니다.');
}
const appId = readFileSync(join(credentials, 'github-app-id'), 'utf8').trim();
const pem = readFileSync(join(credentials, 'github-app.pem'), 'utf8');
const token = await installationToken(fetch, appJwt(appId, pem, new Date()), 'Kim-Geonwoo', 'coolify-ko');
const env = { ...process.env, ...gitAuthEnv(token) };
const git = (args: readonly string[]): number => spawnSync('git', args, { cwd: WORK, stdio: 'inherit', env, timeout: 120_000 }).status ?? -1;

git(['fetch', '-q', 'origin']);
git(['checkout', '-q', '-f', '--detach', 'origin/dev']);
git(['-c', 'user.name=coolify-ko-bot', '-c', 'user.email=coolify-ko-bot@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'rehearsal: 거부되어야 하는 커밋']);
console.log(`app-dev-push-exit=${String(git(['push', '--no-verify', REPO_URL, 'HEAD:refs/heads/dev']))}`);
console.log(`app-branch-push-exit=${String(git(['push', '--no-verify', '--force', REPO_URL, 'HEAD:refs/heads/rehearsal/app-probe']))}`);
git(['push', '--no-verify', REPO_URL, ':refs/heads/rehearsal/app-probe']);
git(['checkout', '-q', '-f', '--detach', 'origin/dev']);
