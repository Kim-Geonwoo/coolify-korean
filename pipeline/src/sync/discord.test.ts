import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postDiscord } from './discord.ts';

const HOOK = 'https://discord.com/api/webhooks/123/secret-token';

function webhookFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'discord-')), 'discord-webhook');
  writeFileSync(file, `${HOOK}\n`);

  return file;
}

function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code} discord.com:443 ${HOOK}`), { code }) });
}

function logs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });

  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postDiscord', () => {
  it('sends again once after a network error', async () => {
    const lines = logs();
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockRejectedValueOnce(fetchFailed('ECONNRESET')).mockResolvedValueOnce(new Response(null, { status: 204 }));

    await postDiscord(webhookFile(), '알림', { fetcher, retryDelayMs: 0 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(lines).toEqual(['알림 재시도: TypeError fetch failed (ECONNRESET)']);
  });

  it('says what failed and why, without the webhook address, when the second try fails too', async () => {
    const lines = logs();
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockRejectedValue(fetchFailed('UND_ERR_CONNECT_TIMEOUT'));

    await postDiscord(webhookFile(), '알림', { fetcher, retryDelayMs: 0 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(lines.at(-1)).toBe('알림 실패: TypeError fetch failed (UND_ERR_CONNECT_TIMEOUT)');
    expect(lines.join('\n')).not.toContain('secret-token');
  });

  it('sends again after a rate limit or server error but not after a rejected request', async () => {
    const lines = logs();
    const busy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const rejected = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(null, { status: 400 }));

    await postDiscord(webhookFile(), '알림', { fetcher: busy, retryDelayMs: 0 });
    await postDiscord(webhookFile(), '알림', { fetcher: rejected, retryDelayMs: 0 });

    expect(busy).toHaveBeenCalledTimes(2);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['알림 재시도: HTTP 429', '알림 실패: HTTP 400']);
  });
});
