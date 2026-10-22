import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from './client.ts';
import { WEBLATE } from './config.ts';
import { brokenApproval, stateCounts } from './rehearsalPlan.ts';

/**
 * 3단계 운영 리허설 도우미. ops/weblate/rehearse.sh가 coolify-ko 권한·LoadCredential(weblate-bridge.token)로 부른다.
 *   status  : 운영 컴포넌트(ko·en)의 상태별 단위 수와 용어집 수를 STATUS 줄로 출력한다
 *   break   : 확인 문구 문자열 하나를 그 문구를 뺀 번역으로 승인(30)해 "레포 검사에 걸린 승인"을 만든다. 원래 값은 OUT/broken.json
 *   restore : break가 바꾼 단위를 원래 대상·상태로 되돌린다
 */
const BASE_URL = process.env['WEBLATE_URL'] ?? 'http://127.0.0.1:8792';
const OUT = process.env['COOLIFY_KO_REHEARSAL_OUT'] ?? '/srv/coolify-ko/cache/weblate-rehearsal';
const credentials = process.env['CREDENTIALS_DIRECTORY'];
if (credentials === undefined) {
  throw new Error('CREDENTIALS_DIRECTORY가 없습니다.');
}
const bridge = createClient({ baseUrl: BASE_URL, token: readFileSync(join(credentials, 'weblate-bridge.token'), 'utf8').trim(), timeoutMs: 120_000 });
const { project, component, glossary, lang } = WEBLATE;
const savedPath = join(OUT, 'broken.json');
mkdirSync(OUT, { recursive: true });

interface Saved {
  readonly id: number;
  readonly key: string;
  readonly target: string;
  readonly state: number;
}

switch (process.argv[2]) {
  case 'status': {
    const [ko, en, terms] = await Promise.all([bridge.units(project, component, lang), bridge.units(project, component, 'en'), bridge.units(project, glossary, lang)]);
    const brands = terms.filter((unit) => unit.state === 100 || (unit.extraFlags ?? '').includes('read-only')).length;
    console.log(`STATUS ${JSON.stringify({ en: en.length, ko: ko.length, states: stateCounts(ko), glossary: terms.length, brands })}`);
    break;
  }
  case 'break': {
    if (existsSync(savedPath)) {
      throw new Error(`이전 리허설의 깨진 승인이 아직 되돌려지지 않았습니다: ${savedPath}(restore를 먼저)`);
    }
    const verbatim = (JSON.parse(readFileSync('i18n/verbatim.json', 'utf8')) as { literals: string[] }).literals;
    const picked = brokenApproval(await bridge.units(project, component, lang), verbatim);
    if (picked === undefined) {
      throw new Error('깨진 승인을 만들 확인 문구 문자열이 없습니다.');
    }
    const saved: Saved = { id: picked.unit.id, key: picked.unit.key, target: picked.unit.target, state: picked.unit.state };
    // 되돌릴 값을 먼저 남긴다(PATCH 뒤에 죽어도 restore가 된다)
    writeFileSync(savedPath, `${JSON.stringify(saved, null, 2)}\n`);
    const patched = await bridge.raw('PATCH', `/api/units/${String(saved.id)}/`, { target: [picked.target], state: 30 });
    const after = await bridge.raw('GET', `/api/units/${String(saved.id)}/`);
    const state = (after.data as { state?: unknown } | null)?.state;
    console.log(`BROKEN ${JSON.stringify(saved.key)} PATCH ${String(patched.status)} → 상태 ${String(state)}`);
    if (patched.status >= 300 || state !== 30) {
      process.exitCode = 1;
    }
    break;
  }
  case 'restore': {
    if (!existsSync(savedPath)) {
      console.log('RESTORED 되돌릴 것 없음');
      break;
    }
    const saved = JSON.parse(readFileSync(savedPath, 'utf8')) as Saved;
    // 빈칸(0)은 대상이 비어야 한다. 그 밖에는 원래 대상·상태로
    const restored = await bridge.raw('PATCH', `/api/units/${String(saved.id)}/`, { target: [saved.target], state: saved.target === '' ? 0 : saved.state });
    console.log(`RESTORED ${JSON.stringify(saved.key)} PATCH ${String(restored.status)}`);
    if (restored.status < 300) {
      renameSync(savedPath, join(OUT, `broken.restored-${String(Date.now())}.json`));
    } else {
      process.exitCode = 1;
    }
    break;
  }
  default:
    throw new Error('사용법: rehearsal.ts status|break|restore');
}
