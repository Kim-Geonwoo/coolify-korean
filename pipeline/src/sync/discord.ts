import { readFileSync } from 'node:fs';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const WEBHOOK = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//;
const TRIES = 2;

/** 오류 이름·내용·원인 코드만 남기고 주소는 지운다. 이름만 남겨서는 원인을 몰랐다(2026-10-25 "알림 실패: TypeError") */
function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) {
    return '알 수 없음';
  }
  const code = (error.cause as { code?: unknown } | undefined)?.code;

  return `${error.name} ${error.message.replace(/https?:\/\/\S+/g, '<주소>').slice(0, 120)}${typeof code === 'string' ? ` (${code})` : ''}`;
}

/**
 * Discord 웹훅으로 한 줄 알린다. 웹훅 주소는 파일(LoadCredential)에서 읽고 로그에 남기지 않는다.
 * 네트워크 오류·한도·서버 오류면 한 번 더 보낸다. 실패해도 던지지 않는다(알림 때문에 작업이 실패하지 않게). 멘션은 막는다
 */
export async function postDiscord(webhookFile: string, content: string, { fetcher = fetch, retryDelayMs = 5_000 }: { readonly fetcher?: Fetcher; readonly retryDelayMs?: number } = {}): Promise<void> {
  let url: string;
  try {
    url = readFileSync(webhookFile, 'utf8').trim();
  } catch (error: unknown) {
    console.log(`알림 실패: ${errorSummary(error)}`);

    return;
  }
  if (!WEBHOOK.test(url)) {
    console.log('알림 생략: 웹훅 주소 형식이 아닙니다.');

    return;
  }
  const body = JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } });
  let problem = '';
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    if (attempt > 1) {
      console.log(`알림 재시도: ${problem}`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    try {
      const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        return;
      }
      problem = `HTTP ${String(response.status)}`;
      if (response.status !== 429 && response.status < 500) {
        break;
      }
    } catch (error: unknown) {
      problem = errorSummary(error);
    }
  }
  console.log(`알림 실패: ${problem}`);
}
