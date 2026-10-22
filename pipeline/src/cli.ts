import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './i18n/integrity.ts';
import { scanVerbatim } from './i18n/verbatim.ts';
import { draftsCommand } from './sync/draftsCli.ts';
import { assertCatalogVersion, buildArgs, loadState } from './sync/state.ts';
import { bakeoffCommand } from './translate/bakeoffCli.ts';
import { buildTestEnv, pseudoTranslations } from './testInstance.ts';
import { weblateCommand } from './weblate/command.ts';

const root = join(import.meta.dirname, '..', '..');
const work = join(root, '.work');
const instanceDir = join(work, 'test-instance');

function run(command: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv }): void {
  const result = spawnSync(command, args, { cwd: options.cwd ?? root, stdio: 'inherit', timeout: options.timeoutMs, env: options.env ?? process.env, windowsHide: true });
  if (result.error !== undefined) {
    throw new Error(`${command} 실행 실패: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 실패(exit ${String(result.status)})`);
  }
}

function capture(command: string, args: readonly string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: env ?? process.env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw new Error(`${command} 실행 실패: ${result.error.message}`);
  }

  return result.stdout;
}

function option(args: readonly string[], name: string, fallback?: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : fallback;
  if (value === undefined || value === '') {
    throw new Error(`--${name} 값이 필요합니다.`);
  }

  return value;
}

function readEnv(file: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) {
      map.set(line.slice(0, at), line.slice(at + 1).trim());
    }
  }

  return map;
}

function composeEnv(image: string, locale: string): NodeJS.ProcessEnv {
  return { ...process.env, COOLIFY_TEST_IMAGE: image, COOLIFY_LOCALE: locale };
}

const compose = (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): void => {
  run('docker', ['compose', '--project-directory', instanceDir, '-f', join(instanceDir, 'docker-compose.yml'), ...args], { cwd: instanceDir, timeoutMs, env });
};

/** 컨테이너가 정상이 된 뒤에도 시드(시험 계정·팀)는 늦게 끝난다. 둘 다 생길 때까지 기다린다. */
async function waitForSeed(): Promise<void> {
  const env = readEnv(join(instanceDir, '.env'));
  const query = 'select (select count(*) from users where id = 0) + (select count(*) from teams where id = 0);';
  for (let attempt = 0; attempt < 90; attempt++) {
    const out = capture('docker', ['compose', '--project-directory', instanceDir, '-f', join(instanceDir, 'docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-U', env.get('DB_USERNAME') ?? 'coolify', '-d', env.get('DB_DATABASE') ?? 'coolify', '-tAc', query], instanceDir, 30_000, composeEnv('unused', 'en'));
    if (out.trim() === '2') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('시드(시험 계정·팀)가 3분 안에 끝나지 않았습니다.');
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, sub] = argv;
  const state = loadState(join(root, 'i18n', 'state.json'));
  const version = option(argv, 'version', state.upstream.version);
  const out = join(work, 'out', version);
  const pinned = (): void => {
    if (version !== state.upstream.version) {
      throw new Error(`추출·게이트는 state.json의 버전(${state.upstream.version})으로만 돌린다. 다른 버전은 state를 먼저 바꾼다.`);
    }
  };
  switch (command) {
    case 'extract': {
      pinned();
      run('docker', ['build', ...buildArgs(state), '--target', 'artifacts', '--output', `type=local,dest=${out}`, '.'], { timeoutMs: 30 * 60_000 });
      assertCatalogVersion(JSON.parse(readFileSync(join(out, 'i18n', 'catalog.json'), 'utf8')) as unknown, state);
      mkdirSync(join(root, 'i18n'), { recursive: true });
      mkdirSync(join(root, 'reports'), { recursive: true });
      copyFileSync(join(out, 'i18n', 'en.json'), join(root, 'i18n', 'en.json'));
      copyFileSync(join(out, 'i18n', 'catalog.json'), join(root, 'i18n', 'catalog.json'));
      copyFileSync(join(out, 'reports', 'coverage.md'), join(root, 'reports', 'coverage.md'));
      // 사용자가 글자 그대로 쳐야 하는 확인 문구. 번역이 이 문구를 바꾸면 초안 저장·무결성 검사가 거부한다
      const views = join(out, 'transformed', 'resources', 'views');
      const blades = existsSync(views) ? readdirSync(views, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.blade.php')) : [];
      const literals = scanVerbatim(blades.map((name) => ({ path: name, text: readFileSync(join(views, name), 'utf8') })));
      writeFileSync(join(root, 'i18n', 'verbatim.json'), canonicalJson({ literals }));
      console.log(`산출물: ${out}`);
      return;
    }
    case 'gates': {
      pinned();
      run('docker', ['build', ...buildArgs(state), '--target', 'compile-check', '.'], { timeoutMs: 30 * 60_000 });
      run('docker', ['build', ...buildArgs(state), '--target', 'equivalence-report', '--output', `type=local,dest=${join(out, 'equivalence')}`, '.'], { timeoutMs: 30 * 60_000 });
      console.log('게이트 통과: 컴파일 검사, 정적 동등성');
      return;
    }
    case 'test-instance': {
      if (sub === 'prepare') {
        mkdirSync(join(instanceDir, 'lang-runtime'), { recursive: true });
        copyFileSync(join(root, 'tools', 'test-instance', 'docker-compose.yml'), join(instanceDir, 'docker-compose.yml'));
        if (!existsSync(join(instanceDir, '.env'))) {
          writeFileSync(join(instanceDir, '.env'), buildTestEnv({ port: Number(option(argv, 'port', '18080')), email: option(argv, 'email') }), { mode: 0o600 });
        }
        const english = JSON.parse(readFileSync(join(out, 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
        writeFileSync(join(instanceDir, 'lang-runtime', 'xx.json'), JSON.stringify(pseudoTranslations(english), null, 2));
        console.log(`시험 인스턴스 준비: ${instanceDir}`);
        return;
      }
      if (sub === 'up') {
        compose(['up', '-d', '--wait', '--wait-timeout', '600'], composeEnv(option(argv, 'image'), option(argv, 'locale', 'en')), 15 * 60_000);
        await waitForSeed();
        return;
      }
      if (sub === 'down') {
        compose(['down', '-v', '--remove-orphans'], composeEnv('unused', 'en'), 5 * 60_000);
        return;
      }
      if (sub === 'skip-onboarding') {
        const env = readEnv(join(instanceDir, '.env'));
        run('docker', ['compose', '--project-directory', instanceDir, '-f', join(instanceDir, 'docker-compose.yml'), 'exec', '-T', 'postgres', 'psql', '-U', env.get('DB_USERNAME') ?? 'coolify', '-d', env.get('DB_DATABASE') ?? 'coolify', '-c', 'update teams set show_boarding = false;'], { cwd: instanceDir, timeoutMs: 60_000, env: composeEnv('unused', 'en') });
        // currentTeam()이 팀을 Redis 캐시에 두므로 비워야 반영된다(시험 인스턴스 전용).
        run('docker', ['compose', '--project-directory', instanceDir, '-f', join(instanceDir, 'docker-compose.yml'), 'exec', '-T', 'redis', 'redis-cli', '-a', env.get('REDIS_PASSWORD') ?? '', '--no-auth-warning', 'FLUSHALL'], { cwd: instanceDir, timeoutMs: 60_000, env: composeEnv('unused', 'en') });
        return;
      }
      if (sub === 'errors') {
        const env = composeEnv('unused', 'en');
        const log = capture('docker', ['compose', '--project-directory', instanceDir, '-f', join(instanceDir, 'docker-compose.yml'), 'exec', '-T', 'coolify', 'sh', '-c', 'cat storage/logs/laravel*.log 2>/dev/null || true'], instanceDir, 60_000, env);
        const errors = log.split('\n').filter((line) => /\.(ERROR|CRITICAL|ALERT|EMERGENCY):/.test(line)).map((line) => line.replace(/^\[[^\]]+\]\s*/, '').slice(0, 300));
        writeFileSync(option(argv, 'out'), JSON.stringify({ count: errors.length, errors }, null, 2));
        console.log(`Laravel 오류 로그 ${String(errors.length)}줄`);
        return;
      }
      throw new Error('test-instance prepare|up|down|errors');
    }
    case 'smoke': {
      const env = readEnv(join(instanceDir, '.env'));
      // playwright는 스모크에서만 쓴다. 정적으로 불러오면 서버에서 devDependencies 전체가 필요해진다
      const { runSmoke } = await import('./smoke.ts');
      const report = await runSmoke({
        base: `http://127.0.0.1:${env.get('APP_PORT') ?? '18080'}`,
        email: env.get('ROOT_USER_EMAIL') ?? '',
        password: env.get('ROOT_USER_PASSWORD') ?? '',
        maxPages: Number(option(argv, 'max-pages', '80')),
        timeoutMs: 30_000,
      });
      writeFileSync(option(argv, 'out'), JSON.stringify(report, null, 2));
      console.log(`페이지 ${String(report.totals.pages)} · 오류 ${String(report.totals.errors)} · JS 오류 ${String(report.totals.jsErrors)} · 텍스트 ${String(report.totals.textTranslated)}/${String(report.totals.textTotal)}`);
      return;
    }
    case 'bakeoff':
      await bakeoffCommand(argv, root);
      return;
    case 'drafts':
      await draftsCommand(argv, root);
      return;
    case 'weblate':
      await weblateCommand(argv, root);
      return;
    case 'screenshots': {
      const { screenshotsCommand } = await import('./screenshots/runCli.ts');
      await screenshotsCommand(argv, root);
      return;
    }
    case 'release': {
      const { releaseCommand } = await import('./release/buildCli.ts');
      await releaseCommand(argv);
      return;
    }
    case 'publish': {
      // 공개판 발행 준비(5단계, 사용자 PC). push·서명은 공개 계획에서 더한다
      const { publishCommand } = await import('./publish/publishCli.ts');
      const log = (line: string): void => {
        console.log(line);
      };
      process.exitCode = await publishCommand(argv, { root, fetcher: fetch, log, now: () => new Date() });
      return;
    }
    default:
      throw new Error('사용법: cli.ts extract|gates|test-instance|smoke|bakeoff|drafts|weblate|screenshots|release|publish');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
