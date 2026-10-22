import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pack, type Target } from './pack.ts';
import { generateSigningKey, signBytes } from './signing.ts';

/**
 * 확장(방법 C) 진입점. 루트 cli.ts와 따로 둔다(판결 R5: A·C 동시 작업 충돌 방지).
 *   node pipeline/src/extension/cli.ts pack [--target chrome|firefox|all] [--version 4.4.6.N] [--e2e-origin http://127.0.0.1:18090]
 *   node pipeline/src/extension/cli.ts e2e [--keep] [--report 파일]   (시험 인스턴스 coolify-ko-ext·포트 18090, Docker 필요)
 *   node pipeline/src/extension/cli.ts store-shots [--keep] [--out .work/extension/store]   (웹 스토어 스크린샷 1280x800 JPEG, 같은 시험 인스턴스)
 */
const root = join(import.meta.dirname, '..', '..', '..');
const USAGE = '사용법: node pipeline/src/extension/cli.ts pack [--target chrome|firefox|all] [--version V] [--e2e-origin ORIGIN] | e2e [--keep] [--report 파일] | store-shots [--keep] [--out 폴더] | keygen --out <개인 키 파일> | sign --key <개인 키 파일> --in <사전> --out <서명 파일>';

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} 값이 필요합니다.`);
  }

  return value;
}

function targets(value: string | undefined): Target[] {
  if (value === undefined || value === 'all') {
    return ['chrome', 'firefox'];
  }
  if (value === 'chrome' || value === 'firefox') {
    return [value];
  }
  throw new Error(`--target은 chrome|firefox|all입니다: ${value}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command] = argv;
  switch (command) {
    case 'pack': {
      const version = option(argv, 'version');
      const e2eOrigin = option(argv, 'e2e-origin');
      for (const target of targets(option(argv, 'target'))) {
        const out = join(root, '.work', 'extension', e2eOrigin === undefined ? target : `e2e-${target}`);
        pack(target, out, { ...(version === undefined ? {} : { version }), ...(e2eOrigin === undefined ? {} : { e2eOrigin }) });
        console.log(`${target}: ${out} (+ .zip)`);
      }
      return;
    }
    case 'keygen': {
      // 원격 사전 서명 키. 개인 키는 사용자 폴더에만 둔다(레포·서버에 두지 않음). 있는 파일은 덮어쓰지 않는다
      const out = option(argv, 'out');
      if (out === undefined) {
        throw new Error(USAGE);
      }
      const key = await generateSigningKey();
      writeFileSync(out, `${JSON.stringify(key.privateJwk)}\n`, { flag: 'wx', mode: 0o600 });
      writeFileSync(`${out}.pub.json`, `${JSON.stringify(key.publicJwk)}\n`, { flag: 'wx' });
      console.log(`개인 키: ${out}\n공개 키(확장에 넣는다): ${out}.pub.json\n${JSON.stringify(key.publicJwk)}`);
      return;
    }
    case 'sign': {
      const keyPath = option(argv, 'key');
      const input = option(argv, 'in');
      const out = option(argv, 'out');
      if (keyPath === undefined || input === undefined || out === undefined) {
        throw new Error(USAGE);
      }
      const signature = await signBytes(JSON.parse(readFileSync(keyPath, 'utf8')) as JsonWebKey, readFileSync(input));
      writeFileSync(out, `${signature}\n`);
      console.log(`서명: ${out}`);
      return;
    }
    case 'e2e': {
      // playwright는 e2e에서만 쓴다
      const { runE2e } = await import('./e2e.ts');
      await runE2e(argv);
      return;
    }
    case 'store-shots': {
      // playwright는 찍을 때만 쓴다
      const { runStoreShots } = await import('./storeShotsRun.ts');
      await runStoreShots({ keep: argv.includes('--keep'), out: resolve(option(argv, 'out') ?? join(root, '.work', 'extension', 'store')) });
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
