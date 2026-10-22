import type { Glossary } from '../translate/glossary.ts';
import { weblateSource } from './bridge.ts';
import { WeblateError, type WeblateClient } from './client.ts';
import { WEBLATE } from './config.ts';

export interface SetupReport {
  /** 이번에 새로 만든 것: component · translation · glossary-translation */
  readonly created: readonly string[];
  /** 이번에 바꾼 프로젝트 설정 */
  readonly project: readonly string[];
  /** 이번에 바꾼 컴포넌트 설정(이미 있던 컴포넌트) */
  readonly component: readonly string[];
  /** 이번에 읽기 전용으로 만든 번역 제외 키 수 */
  readonly readOnly: number;
  /** 이번에 용어집에 더한 용어·브랜드 수 */
  readonly terms: number;
  /** Weblate에 올리지 않은 키(앞 점, weblateSource) */
  readonly skipped: readonly string[];
}

const READ_ONLY = 'read-only';
const flagsOf = (flags: string | undefined): string[] => (flags ?? '').split(',').map((flag) => flag.trim()).filter((flag) => flag !== '');
const withReadOnly = (flags: string | undefined): string => [...flagsOf(flags), READ_ONLY].join(',');

/** 있으면 true, 없으면(404) false. 그 밖의 상태는 실패다 */
async function exists(client: WeblateClient, path: string): Promise<boolean> {
  const { status } = await client.raw('GET', path);
  if (status === 404) {
    return false;
  }
  if (status < 200 || status >= 300) {
    throw new WeblateError(status, path);
  }

  return true;
}

async function post(client: WeblateClient, path: string, json: unknown): Promise<void> {
  const { status, data } = await client.raw('POST', path, json);
  if (status < 200 || status >= 300) {
    throw new WeblateError(status, path, status === 400 ? JSON.stringify(data) : undefined);
  }
}

/**
 * 운영 Weblate를 맞춘다(멱등): 없는 것만 만들고, 있는 것은 사람이 고쳤을 수 있으니 건드리지 않는다.
 * 프로젝트는 bootstrap.py가 만든다. 여기서는 검수·2단계 인증 강제를 켜고, 원문 컴포넌트·ko 번역·번역 제외 읽기 전용·용어집을 맞춘다.
 */
export async function setupWeblate(client: WeblateClient, input: { readonly en: Readonly<Record<string, string>>; readonly exclusions: ReadonlyMap<string, string>; readonly glossary: Glossary }): Promise<SetupReport> {
  const { project, component, glossary, lang } = WEBLATE;
  const projectPath = `/api/projects/${project}/`;
  const found = await client.raw('GET', projectPath);
  if (found.status === 404) {
    throw new Error(`Weblate 프로젝트 ${project}가 없습니다(ops/weblate/install.sh가 만든다).`);
  }
  if (found.status !== 200) {
    throw new WeblateError(found.status, projectPath);
  }
  const current = (typeof found.data === 'object' && found.data !== null ? found.data : {}) as Record<string, unknown>;
  // 승인은 검수자만(Review 팀), 사람은 2단계 인증이 있어야 쓴다. 봇은 2FA 강제에서 빠진다(PoC 6)
  const changes = Object.fromEntries(Object.entries({ translation_review: true, enforced_2fa: true }).filter(([name, value]) => current[name] !== value));
  if (Object.keys(changes).length > 0) {
    await client.patchProject(project, changes);
  }

  const created: string[] = [];
  const { source, skipped } = weblateSource(input.en);
  const componentChanges: string[] = [];
  const componentPath = `/api/components/${project}/${component}/`;
  const foundComponent = await client.raw('GET', componentPath);
  if (foundComponent.status === 404) {
    await client.createComponent(project, { name: component, slug: component, sourceJson: source, checkFlags: WEBLATE.flags, enforcedChecks: WEBLATE.enforcedChecks });
    created.push('component');
  } else if (foundComponent.status < 200 || foundComponent.status >= 300) {
    throw new WeblateError(foundComponent.status, componentPath);
  } else if ((foundComponent.data as { check_flags?: unknown } | null)?.check_flags !== WEBLATE.flags) {
    // 검사 규칙이 바뀌면(예: \w → ASCII, 2026-10-18) 이미 만든 컴포넌트도 맞춘다
    await client.patchComponent(project, component, { check_flags: WEBLATE.flags });
    componentChanges.push('check_flags');
  }
  if (!(await exists(client, `/api/translations/${project}/${component}/${lang}/`))) {
    await client.addTranslation(project, component, lang);
    created.push('translation');
  }

  // 번역 제외 키: 원문 단위에 읽기 전용을 걸면 번역 단위가 100(읽기 전용)이 된다(PoC 4)
  const translatedState = new Map((await client.units(project, component, lang)).map((unit) => [unit.key, unit.state]));
  let readOnly = 0;
  for (const unit of await client.units(project, component, 'en')) {
    if (input.exclusions.has(unit.key) && !flagsOf(unit.extraFlags).includes(READ_ONLY) && translatedState.get(unit.key) !== 100) {
      await client.patchUnit(unit.id, { extra_flags: withReadOnly(unit.extraFlags) });
      readOnly++;
    }
  }

  // 용어집(Weblate가 프로젝트마다 만드는 컴포넌트). 이후 편집은 Weblate에서 하므로 없는 용어만 더한다
  const glossaryPath = `/api/translations/${project}/${glossary}/${lang}/`;
  if (!(await exists(client, glossaryPath))) {
    await post(client, `/api/components/${project}/${glossary}/translations/`, { language_code: lang });
    created.push('glossary-translation');
  }
  const have = new Set((await client.units(project, glossary, lang)).map((unit) => unit.source));
  let terms = 0;
  for (const [en, ko] of [...input.glossary.terms.map((term) => [term.en, term.ko] as const), ...input.glossary.brands.map((brand) => [brand, brand] as const)]) {
    if (!have.has(en)) {
      await post(client, `${glossaryPath}units/`, { source: [en], target: [ko] });
      have.add(en);
      terms++;
    }
  }
  // 브랜드는 번역하지 않는 용어다(Weblate 용어집의 읽기 전용 = 번역 안 함)
  const brands = new Set(input.glossary.brands);
  for (const unit of await client.units(project, glossary, lang)) {
    if (brands.has(unit.source) && !flagsOf(unit.extraFlags).includes(READ_ONLY) && unit.state !== 100) {
      await client.patchUnit(unit.id, { extra_flags: withReadOnly(unit.extraFlags) });
    }
  }

  return { created, project: Object.keys(changes), component: componentChanges, readOnly, terms, skipped };
}
