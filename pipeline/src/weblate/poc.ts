import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planUploads, weblateSource } from './bridge.ts';
import { createClient, type WeblateClient, type WeblateUnit } from './client.ts';
import { WEBLATE } from './config.ts';

/**
 * 3단계 PoC(게이트). 우분투 2에서 ops/weblate/poc.sh가 coolify-ko 권한·LoadCredential로 돌린다.
 * 버리는 컴포넌트에 4.4.6 원문 전체를 올리고, 설계의 PoC 1~7을 실제 Weblate API로 판정한다. 결과는 OUT에 남긴다(토큰은 쓰지 않는다).
 */
const PROJECT = 'coolify-ko-poc';
const PLACEHOLDER_FLAG = WEBLATE.flags;
const BASE_URL = process.env['WEBLATE_URL'] ?? 'http://127.0.0.1:8792';
const OUT = process.env['COOLIFY_KO_POC_OUT'] ?? '/srv/coolify-ko/cache/weblate-poc';
const credentials = process.env['CREDENTIALS_DIRECTORY'];
if (credentials === undefined) {
  throw new Error('CREDENTIALS_DIRECTORY가 없습니다.');
}
const token = (name: string): string => readFileSync(join(credentials, name), 'utf8').trim();
const bridge = createClient({ baseUrl: BASE_URL, token: token('bridge') });
const flash = createClient({ baseUrl: BASE_URL, token: token('flash') });
const reviewer = createClient({ baseUrl: BASE_URL, token: token('reviewer') });
const contributor = createClient({ baseUrl: BASE_URL, token: token('contributor') });

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;
const en = readJson('i18n/en.json') as Record<string, string>;
const drafts = readJson('i18n/drafts/ko.json') as Record<string, string>;
const { source, skipped } = weblateSource(en);
const exclusions = new Map(Object.entries((readJson('i18n/exclude.json') as { keys: Record<string, string> }).keys));

interface Check {
  readonly id: string;
  readonly pass: boolean | null;
  readonly detail: string;
}
const results: Check[] = [];
const record = async (id: string, run: () => Promise<{ pass: boolean | null; detail: string }>): Promise<void> => {
  try {
    results.push({ id, ...(await run()) });
  } catch (error: unknown) {
    results.push({ id, pass: false, detail: `예외: ${error instanceof Error ? error.message : String(error)}` });
  }
};
const byKey = (units: readonly WeblateUnit[]): Map<string, WeblateUnit> => new Map(units.map((u) => [u.key, u]));
const unitState = async (client: WeblateClient, id: number): Promise<{ state: number; failing: boolean; target: string }> => {
  const { data } = await client.raw('GET', `/api/units/${String(id)}/`);
  const unit = data as { state?: number; has_failing_check?: boolean; target?: string[] };

  return { state: unit.state ?? -1, failing: unit.has_failing_check === true, target: unit.target?.[0] ?? '' };
};

const slug = `poc-${Date.now().toString(36)}`;
mkdirSync(OUT, { recursive: true });
const finish = (): void => {
  writeFileSync(join(OUT, 'result.json'), `${JSON.stringify({ component: slug, results }, null, 2)}\n`);
  writeFileSync(join(OUT, 'summary.txt'), `${results.map((r) => `${r.pass === true ? '통과' : r.pass === false ? '실패' : '참고'} ${r.id}: ${r.detail}`).join('\n')}\n`);
};
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
// 컴포넌트 만들기: 검사 플래그와 함께 → 거절되면 플래그 없이 만든 뒤 플래그를 따로 넣어 어느 쪽이 문제인지 남긴다
const setup: string[] = [];
let created = false;
try {
  await bridge.createComponent(PROJECT, { name: slug, slug, sourceJson: source, checkFlags: PLACEHOLDER_FLAG, enforcedChecks: ['placeholders'] });
  setup.push('플래그와 함께 생성 성공');
  created = true;
} catch (error: unknown) {
  setup.push(`플래그와 함께 생성 실패: ${message(error)}`);
  try {
    await bridge.createComponent(PROJECT, { name: slug, slug, sourceJson: source });
    setup.push('플래그 없이 생성 성공');
    created = true;
    const flags = await bridge.raw('PATCH', `/api/components/${PROJECT}/${slug}/`, { check_flags: PLACEHOLDER_FLAG });
    setup.push(`check_flags PATCH ${String(flags.status)} ${JSON.stringify(flags.data).slice(0, 300)}`);
    const enforced = await bridge.raw('PATCH', `/api/components/${PROJECT}/${slug}/`, { enforced_checks: ['placeholders'] });
    setup.push(`enforced_checks PATCH ${String(enforced.status)} ${JSON.stringify(enforced.data).slice(0, 300)}`);
  } catch (second: unknown) {
    setup.push(`플래그 없이 생성도 실패: ${message(second)}`);
  }
}
setup.push(`올리지 않은 키 ${String(skipped.length)}개 ${JSON.stringify(skipped)}`);
results.push({ id: '0-setup', pass: created, detail: setup.join(' | ') });
if (!created) {
  finish();
  console.log('PoC 중단: 컴포넌트를 만들지 못했다');
  process.exit(1);
}
await bridge.addTranslation(PROJECT, slug, 'ko');
const simple = Object.keys(en).filter((k) => /^[A-Z][a-z]+( [a-z]+){1,3}$/.test(k) && drafts[k] !== undefined && !exclusions.has(k)).slice(0, 3);
const [k1 = '', k2 = '', k3 = ''] = simple;

await record('1-roundtrip', async () => {
  const back = await bridge.downloadFile(PROJECT, slug, 'en');
  const missing = Object.keys(source).filter((k) => !(k in back));
  const changed = Object.keys(source).filter((k) => k in back && back[k] !== source[k]);
  const extra = Object.keys(back).filter((k) => !(k in source));
  const ko = await bridge.units(PROJECT, slug, 'ko');
  const sample = [...missing, ...changed, ...extra].slice(0, 5).map((k) => JSON.stringify(k)).join(', ');

  return { pass: missing.length === 0 && changed.length === 0 && extra.length === 0 && ko.length === Object.keys(source).length, detail: `키 ${String(Object.keys(source).length)} · ko 단위 ${String(ko.length)} · 빠짐 ${String(missing.length)} · 값 다름 ${String(changed.length)} · 더해짐 ${String(extra.length)}${sample === '' ? '' : ` · 예: ${sample}`}` };
});

await record('2-enforced-checks', async () => {
  const units = byKey(await reviewer.units(PROJECT, slug, 'ko'));
  const withPlaceholder = Object.keys(en).find((k) => /(?<![\w/]):[A-Za-z_]/.test(en[k] ?? '') && !/<\d/.test(en[k] ?? ''));
  const withTag = Object.keys(en).find((k) => /<0>/.test(en[k] ?? '') && !/:[A-Za-z]/.test(en[k] ?? ''));
  const out: string[] = [];
  let pass = true;
  for (const [key, broken] of [[withPlaceholder, '자리표시자 없는 번역'], [withTag, '태그 없는 번역']] as const) {
    const unit = key === undefined ? undefined : units.get(key);
    if (unit === undefined) {
      pass = false;
      out.push('대상 키 없음');
      continue;
    }
    const patched = await reviewer.raw('PATCH', `/api/units/${String(unit.id)}/`, { target: [broken], state: 20 });
    const after = await unitState(reviewer, unit.id);
    const blocked = patched.status >= 400 || after.state < 20;
    pass &&= blocked;
    out.push(`${String(key)}: PATCH ${String(patched.status)} → 상태 ${String(after.state)}, 실패 검사 ${String(after.failing)}`);
  }

  return { pass, detail: out.join(' | ') };
});

await record('3-preserve-human', async () => {
  const first = { [k1]: drafts[k1] ?? '', [k2]: drafts[k2] ?? '', [k3]: drafts[k3] ?? '' };
  await bridge.uploadFile(PROJECT, slug, 'ko', first, { method: 'fuzzy' });
  let units = byKey(await bridge.units(PROJECT, slug, 'ko'));
  const ids = [k1, k2, k3].map((k) => units.get(k)?.id ?? -1);
  await reviewer.patchUnit(ids[0] ?? -1, { target: [`${k1} 사람 승인`], state: 30 });
  await reviewer.patchUnit(ids[1] ?? -1, { target: [`${k2} 사람 수정`], state: 10 });
  units = byKey(await bridge.units(PROJECT, slug, 'ko'));
  const second = { [k1]: `${first[k1] ?? ''} v2`, [k2]: `${first[k2] ?? ''} v2`, [k3]: `${first[k3] ?? ''} v2` };
  const plan = planUploads({ units: [...units.values()], drafts: second, uploaded: first, exclusions });
  await bridge.uploadFile(PROJECT, slug, 'ko', plan.drafts, { method: 'fuzzy' });
  const after = byKey(await bridge.units(PROJECT, slug, 'ko'));
  const ok = after.get(k1)?.target === `${k1} 사람 승인` && after.get(k1)?.state === 30 && after.get(k2)?.target === `${k2} 사람 수정` && after.get(k3)?.target === second[k3];
  // 참고: Weblate 자체는 수정 필요(10) 사람 번역을 덮는가(다리가 걸러야 하는 이유)
  await bridge.uploadFile(PROJECT, slug, 'ko', { [k2]: second[k2] ?? '' }, { method: 'fuzzy', conflicts: 'ignore' });
  const raw = byKey(await bridge.units(PROJECT, slug, 'ko')).get(k2);
  await bridge.patchUnit(ids[1] ?? -1, { target: [`${k2} 사람 수정`], state: 10 });

  return { pass: ok, detail: `다리 계획 ${JSON.stringify(Object.keys(plan.drafts))} · 승인 ${String(after.get(k1)?.state)} 유지 · 수정필요 사람 번역 유지 ${String(after.get(k2)?.target === `${k2} 사람 수정`)} · 참고: Weblate에 그냥 다시 올리면 수정필요 사람 번역을 덮음=${String(raw?.target === second[k2])}` };
});

await record('4-source-change', async () => {
  const removed = k3;
  const added = 'Rehearsal key for :name';
  const next: Record<string, string> = Object.fromEntries([...Object.entries(source).filter(([k]) => k !== removed), [added, added]]);
  const upload = await bridge.uploadFile(PROJECT, slug, 'en', next, { method: 'replace' });
  // 원문 교체가 번역에 퍼지는 데 시간이 걸릴 수 있다: 새 키가 ko에 보일 때까지(최대 2분) 다시 읽는다
  let ko = byKey(await bridge.units(PROJECT, slug, 'ko'));
  for (let attempt = 0; attempt < 24 && !ko.has(added); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    ko = byKey(await bridge.units(PROJECT, slug, 'ko'));
  }
  const sourceUnits = byKey(await bridge.units(PROJECT, slug, 'en'));
  const excluded = [...exclusions.keys()].find((k) => sourceUnits.has(k));
  const sourceUnit = excluded === undefined ? undefined : sourceUnits.get(excluded);
  if (sourceUnit !== undefined) {
    await bridge.patchUnit(sourceUnit.id, { extra_flags: 'read-only' });
  }
  const koAfter = byKey(await bridge.units(PROJECT, slug, 'ko'));
  const readOnly = excluded === undefined ? undefined : koAfter.get(excluded)?.state;

  return { pass: !ko.has(removed) && ko.has(added) && readOnly === 100, detail: `replace 응답 ${JSON.stringify(upload)} · 지운 키 남음 ${String(ko.has(removed))} · 새 키 생김 ${String(ko.has(added))} · 읽기 전용(${String(excluded)}) 상태 ${String(readOnly)}` };
});

await record('5-export-approved', async () => {
  const file = await bridge.downloadFile(PROJECT, slug, 'ko', 'state:approved');
  const listed = await bridge.units(PROJECT, slug, 'ko', 'state:approved');
  const keys = Object.keys(file);

  return { pass: keys.length === 1 && file[k1] === `${k1} 사람 승인` && listed.length === 1, detail: `내려받은 키 ${JSON.stringify(keys.slice(0, 5))} · 단위 필터 ${String(listed.length)}개` };
});

await record('6-roles-2fa', async () => {
  const unit = byKey(await contributor.units(PROJECT, slug, 'ko')).get(k2);
  const id = unit?.id ?? -1;
  const approve = await contributor.raw('PATCH', `/api/units/${String(id)}/`, { target: [`${k2} 기여`], state: 30 });
  const translate = await contributor.raw('PATCH', `/api/units/${String(id)}/`, { target: [`${k2} 기여`], state: 20 });
  const suggest = await flash.uploadFile(PROJECT, slug, 'ko', { [k2]: `${k2} Flash 제안` }, { method: 'suggest' });
  const enforce = await bridge.raw('PATCH', `/api/projects/${PROJECT}/`, { enforced_2fa: true });
  const humanBlocked = await reviewer.raw('PATCH', `/api/units/${String(id)}/`, { target: [`${k2} 검수`], state: 30 });
  const botAllowed = await bridge.raw('PATCH', `/api/units/${String(id)}/`, { target: [`${k2} 봇`], state: 10 });
  await bridge.raw('PATCH', `/api/projects/${PROJECT}/`, { enforced_2fa: false });
  const pass = approve.status >= 400 && translate.status < 300 && suggest.accepted + suggest.skipped >= 1 && enforce.status < 300 && humanBlocked.status >= 400 && botAllowed.status < 300;

  return { pass, detail: `기여자 승인 ${String(approve.status)} · 기여자 번역 ${String(translate.status)} · Flash 제안 ${JSON.stringify(suggest)} · 2FA 강제 설정 ${String(enforce.status)} → 2FA 없는 검수자 ${String(humanBlocked.status)} · 봇 ${String(botAllowed.status)}` };
});

// 승인된 키의 영어만 바뀌면 Weblate가 승인(30)을 내리는가. 안 내려도 다리(previous 비교)가 빼지만, 실제 동작을 남긴다(검토 2026-10-18 Important 3)
await record('8-approved-source-change', async () => {
  const changed: Record<string, string> = Object.fromEntries(Object.entries(source).filter(([k]) => k !== k3).map(([k, v]) => [k, k === k1 ? `${v} (changed)` : v]));
  changed['Rehearsal key for :name'] = 'Rehearsal key for :name';
  await bridge.uploadFile(PROJECT, slug, 'en', changed, { method: 'replace' });
  let unit = byKey(await bridge.units(PROJECT, slug, 'ko')).get(k1);
  for (let attempt = 0; attempt < 24 && unit?.source !== `${source[k1] ?? ''} (changed)`; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    unit = byKey(await bridge.units(PROJECT, slug, 'ko')).get(k1);
  }

  return { pass: unit !== undefined && unit.state < 30, detail: `승인 키 영어 변경 뒤 상태 ${String(unit?.state)}(30 미만이면 Weblate가 내림) · 원문 반영 ${String(unit?.source === `${source[k1] ?? ''} (changed)`)}` };
});

await record('7-glossary', async () => {
  const { data } = await bridge.raw('GET', `/api/projects/${PROJECT}/components/`);
  const glossary = ((data as { results?: { slug: string; is_glossary?: boolean; file_format?: string }[] }).results ?? []).find((c) => c.is_glossary === true);
  if (glossary === undefined) {
    return { pass: false, detail: '용어집 컴포넌트를 찾지 못했다' };
  }
  await bridge.raw('POST', `/api/components/${PROJECT}/${glossary.slug}/translations/`, { language_code: 'ko' });
  const added = await bridge.raw('POST', `/api/translations/${PROJECT}/${glossary.slug}/ko/units/`, { source: ['Server'], target: ['서버'] });
  const units = await bridge.units(PROJECT, glossary.slug, 'ko');
  const term = units.find((u) => u.source === 'Server');
  const flagged = term === undefined ? { status: 0 } : await bridge.raw('PATCH', `/api/units/${String(term.id)}/`, { extra_flags: 'terminology' });

  return { pass: term?.target === '서버' && flagged.status < 300, detail: `용어집 ${glossary.slug}(${String(glossary.file_format)}) · 용어 추가 ${String(added.status)} · 읽기 ${JSON.stringify(term ?? null)} · 플래그 ${String(flagged.status)}` };
});

await bridge.raw('DELETE', `/api/components/${PROJECT}/${slug}/`);
finish();
console.log(`PoC 끝: 통과 ${String(results.filter((r) => r.pass === true).length)}/${String(results.length)}`);
