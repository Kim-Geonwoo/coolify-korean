import { readFileSync } from 'node:fs';

const WEBHOOK = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//;

/**
 * Discord 웹훅으로 한 줄 알린다. 웹훅 주소는 파일(LoadCredential)에서 읽고 로그에 남기지 않는다.
 * 실패해도 던지지 않는다(알림 때문에 작업이 실패하지 않게). 멘션은 막는다
 */
export async function postDiscord(webhookFile: string, content: string): Promise<void> {
  try {
    const url = readFileSync(webhookFile, 'utf8').trim();
    if (!WEBHOOK.test(url)) {
      console.log('알림 생략: 웹훅 주소 형식이 아닙니다.');

      return;
    }
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      console.log(`알림 실패: HTTP ${String(response.status)}`);
    }
  } catch (error: unknown) {
    console.log(`알림 실패: ${error instanceof Error ? error.name : '알 수 없음'}`);
  }
}
