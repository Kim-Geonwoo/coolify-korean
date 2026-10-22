import { compareVersions, isDictionary, isRecord, type ExtensionDictionary } from './engine.ts';
import { originPattern, parseOrigin } from './origins.ts';
import { UPDATE_PUBLIC_KEY } from './updateKey.ts';
import { fetchSignedDictionary } from './verify.ts';

/**
 * background(Chrome 서비스 워커·Firefox event page): 켠 주소 목록 관리, content script 동적 등록, 사전 보관.
 * 화면 글·켠 주소 목록은 밖으로 보내지 않는다. 시작할 때 사이트에서 서명한 사전만 받는다(UPDATE_URL).
 */
const api = typeof browser === 'undefined' ? chrome : browser;
const SCRIPT_ID = 'coolify-ko';
// 원격 사전 갱신 주소(서명 파일은 같은 주소 + .sig). 비어 있으면 끈다
const UPDATE_URL = 'https://coolify-ko.geonwoo.dev/extension/dictionary.json';
const firefox = api.runtime.getURL('').startsWith('moz-extension:');

async function storedOrigins(): Promise<string[]> {
  const stored = await api.storage.local.get(['origins']);
  const list = Array.isArray(stored['origins']) ? (stored['origins'] as unknown[]) : [];

  return list.filter((item): item is string => typeof item === 'string' && parseOrigin(item) === item);
}

/** 켠 주소 전부를 matches로 갖는 content script 하나를 다시 등록한다(없으면 등록 해제만) */
async function syncRegistration(origins: readonly string[]): Promise<void> {
  const existing = await api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length > 0) {
    await api.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  }
  const matches = [...new Set(origins.map((origin) => originPattern(origin, firefox)))];
  if (matches.length > 0) {
    await api.scripting.registerContentScripts([{ id: SCRIPT_ID, matches, js: ['content.js'], runAt: 'document_start', allFrames: false, persistAcrossSessions: true }]);
  }
}

/** 확장에 묶인 사전을 저장소에 둔다. 묶음이 더 새로우면 예전에 받은 원격 사전을 버린다 */
async function loadBundled(): Promise<ExtensionDictionary | null> {
  const response = await fetch(api.runtime.getURL('dictionary.json'));
  const value: unknown = await response.json();
  if (!isDictionary(value)) {
    return null;
  }
  await api.storage.local.set({ bundled: value });
  const stored = await api.storage.local.get(['remote']);
  const remote = stored['remote'];
  if (remote !== undefined && (!isDictionary(remote) || remote.code !== value.code || compareVersions(remote.version, value.version) <= 0)) {
    await api.storage.local.remove(['remote']);
  }

  return value;
}

async function currentDictionary(): Promise<ExtensionDictionary | null> {
  const stored = await api.storage.local.get(['bundled', 'remote']);
  const bundled = isDictionary(stored['bundled']) ? stored['bundled'] : await loadBundled();
  const remote = stored['remote'];
  if (bundled !== null && isDictionary(remote) && remote.code === bundled.code && compareVersions(remote.version, bundled.version) > 0) {
    return remote;
  }

  return bundled;
}

async function updateDictionary(): Promise<void> {
  const current = await currentDictionary();
  if (current === null) {
    return;
  }
  const remote = await fetchSignedDictionary({
    url: UPDATE_URL,
    publicKey: UPDATE_PUBLIC_KEY,
    current: { code: current.code, version: current.version },
    subtle: crypto.subtle,
    fetcher: (url, init) => fetch(url, init),
  });
  if (remote !== null) {
    await api.storage.local.set({ remote });
  }
}

async function enable(origin: string): Promise<{ ok: boolean; error?: string }> {
  // 권한은 popup이 사용자 클릭 안에서 이미 요청했다. 여기서는 확인만 한다
  if (!(await api.permissions.contains({ origins: [originPattern(origin, firefox)] }))) {
    return { ok: false, error: 'permission' };
  }
  const origins = [...new Set([...(await storedOrigins()), origin])].sort();
  await api.storage.local.set({ origins });
  await syncRegistration(origins);

  return { ok: true };
}

async function disable(origin: string): Promise<{ ok: boolean }> {
  const origins = (await storedOrigins()).filter((item) => item !== origin);
  await api.storage.local.set({ origins });
  await syncRegistration(origins);
  const pattern = originPattern(origin, firefox);
  if (!origins.some((item) => originPattern(item, firefox) === pattern)) {
    // manifest에 고정된 권한(e2e 판)은 지울 수 없다. 실패해도 끈 것은 그대로다
    await api.permissions.remove({ origins: [pattern] }).catch(() => false);
  }

  return { ok: true };
}

async function handle(message: unknown): Promise<unknown> {
  if (!isRecord(message)) {
    return { ok: false };
  }
  const origin = typeof message['origin'] === 'string' ? message['origin'] : '';
  switch (message['type']) {
    case 'dictionary':
      return currentDictionary();
    case 'enable':
      return parseOrigin(origin) === origin ? enable(origin) : { ok: false, error: 'origin' };
    case 'disable':
      return parseOrigin(origin) === origin ? disable(origin) : { ok: false, error: 'origin' };
    default:
      return { ok: false };
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id) {
    return undefined;
  }
  handle(message).then(sendResponse, () => {
    sendResponse({ ok: false });
  });

  return true;
});

api.permissions.onRemoved.addListener((removed) => {
  const gone = new Set(removed.origins ?? []);
  storedOrigins()
    .then(async (origins) => {
      const kept = origins.filter((origin) => !gone.has(originPattern(origin, firefox)));
      await api.storage.local.set({ origins: kept });
      await syncRegistration(kept);
    })
    .catch(() => undefined);
});

const refresh = (): void => {
  loadBundled()
    .then(async () => {
      await syncRegistration(await storedOrigins());
      await updateDictionary();
    })
    .catch(() => undefined);
};

api.runtime.onInstalled.addListener(refresh);
api.runtime.onStartup.addListener(refresh);
