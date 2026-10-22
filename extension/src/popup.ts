import { originPattern, parseOrigin } from './origins.ts';

/**
 * popup: 지금 탭의 주소를 보여 주고, 그 주소에서 켜기·끄기, 누락 목록 받기·비우기.
 * 권한 요청은 사용자 클릭 안에서 바로 한다(브라우저가 사용자 동작을 요구한다).
 */
const api = typeof browser === 'undefined' ? chrome : browser;
const firefox = api.runtime.getURL('').startsWith('moz-extension:');

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`popup: #${id}`);
  }

  return element;
}

function buttonById(id: string): HTMLButtonElement {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`popup: #${id}`);
  }

  return element;
}

const say = (text: string): void => {
  byId('message').textContent = text;
};

async function enable(origin: string): Promise<void> {
  const granted = await api.permissions.request({ origins: [originPattern(origin, firefox)] });
  if (!granted) {
    say('권한을 허락하지 않아 켜지 않았습니다.');
    return;
  }
  const answer = await api.runtime.sendMessage({ type: 'enable', origin });
  say(typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true ? '켰습니다. 탭을 새로고침하면 적용됩니다.' : '켜지 못했습니다.');
}

async function disable(origin: string): Promise<void> {
  await api.runtime.sendMessage({ type: 'disable', origin });
  say('껐습니다. 탭을 새로고침하면 영어로 돌아갑니다.');
}

async function saveMissed(): Promise<void> {
  const stored = await api.storage.local.get(['missed']);
  const missed = Array.isArray(stored['missed']) ? (stored['missed'] as unknown[]) : [];
  const url = URL.createObjectURL(new Blob([`${JSON.stringify({ missed }, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'coolify-ko-missed.json';
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

async function render(): Promise<void> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const origin = parseOrigin(tab?.url);
  const stored = await api.storage.local.get(['origins', 'missed']);
  const origins = Array.isArray(stored['origins']) ? (stored['origins'] as unknown[]) : [];
  const missed = Array.isArray(stored['missed']) ? stored['missed'].length : 0;
  const on = origin !== null && origins.includes(origin);
  const toggle = buttonById('toggle');
  byId('origin').textContent = origin ?? '이 탭은 http(s) 주소가 아닙니다.';
  byId('state').textContent = origin === null ? '' : on ? '이 주소에서 켜져 있습니다.' : '이 주소에서는 꺼져 있습니다.';
  toggle.hidden = origin === null;
  toggle.textContent = on ? '이 주소에서 끄기' : '이 주소에서 켜기';
  toggle.onclick = (): void => {
    if (origin !== null) {
      (on ? disable(origin) : enable(origin)).then(render).catch(() => {
        say('처리하지 못했습니다.');
      });
    }
  };
  byId('missed-count').textContent = String(missed);
  buttonById('save-missed').disabled = missed === 0;
  buttonById('clear-missed').disabled = missed === 0;
}

byId('save-missed').addEventListener('click', () => {
  saveMissed().catch(() => {
    say('목록을 받지 못했습니다.');
  });
});
byId('clear-missed').addEventListener('click', () => {
  api.storage.local
    .remove(['missed'])
    .then(render)
    .catch(() => undefined);
});
render().catch(() => {
  say('주소를 읽지 못했습니다.');
});
