import { callWithRetry, EngineError, type Engine, type EngineUsage } from './engines/engine.ts';
import { termsIn, type Glossary, type GlossaryTerm } from './glossary.ts';
import { placeholderNames, withoutPlaceholders } from './masking.ts';
import type { Prompt } from './prompt.ts';
import { hardIssues, type HardIssue } from './validate.ts';

/** Flash 검토자(2b 사용자 결정): 초안을 ok·minor·major로 판정하고 고친 번역을 낸다. major만 "검수 필요"가 된다 */
export type Verdict = 'ok' | 'minor' | 'major';

export interface ReviewItem {
  readonly id: string;
  readonly source: string;
  readonly draft: string;
  readonly kind: string;
  readonly kinds?: readonly string[];
  readonly file: string;
  readonly placeholders: readonly string[];
}

export interface ReviewResult {
  readonly id: string;
  readonly verdict: Verdict;
  readonly reason: string;
  /** 하드 검사를 통과한 고친 번역(ok면 없음) */
  readonly fix?: string;
  /** 고친 번역이 하드 검사에 걸려 버렸을 때 그 문제 */
  readonly fixRejected?: readonly HardIssue[];
}

const VERDICTS = new Set<string>(['ok', 'minor', 'major']);

const REVIEW_SYSTEM = `You review Korean translations of UI strings of the Coolify dashboard (a self-hosted platform for deploying servers, applications and databases). Judge each draft against its English source and these rules:
1. Sentences (toasts, validation messages, descriptions, help texts) use the formal style ending in "합니다/습니다". Questions end in "…하시겠습니까?". Requests to the user end in "…하세요", never "…하십시오".
2. Text that describes what a setting, option or feature does stays a statement ("…합니다"). Instructions to the user are requests ("…하세요"). Use kind and file to tell which.
3. Buttons, menu items, labels and headings (short, no final period) use noun forms ("저장", "새 서버 추가").
4. Use the glossary translations. Keep product and brand names in English. Translate names of other UI elements (menus, buttons, fields), because the Korean UI shows them in Korean.
5. Keep :placeholders and numbered tags (<0>…</0>, <1/>) exactly. Right after a :placeholder write particles in both forms like "을(를)", "이(가)", "은(는)", "(으)로", "와(과)".
6. Do not translate URLs, paths, commands, code or environment variable names.
The drafts were already post-processed: request endings "…하십시오" were turned into "…하세요" and one-sided particles right after placeholders were written in both forms.
Verdicts:
- major: wrong, missing or added meaning; a description of what a setting or feature does turned into a request, or an instruction to the user turned into a statement; a short label, button, menu item or heading written as a full sentence; glossary violation; English left where Korean UI text is needed (including names of other UI elements); broken placeholders or tags; words added next to a placeholder that make the text wrong once the value is filled in (for example a counter or noun after a placeholder that holds an English word); casual style ("…했어요") in messages; or so unnatural that users may misunderstand.
- minor: understandable but awkward or literal wording; spacing or punctuation; a one-sided particle; "…하십시오" left in a request; small inconsistencies.
- ok: nothing to fix.
For minor and major, "fix" is the full corrected Korean text, keeping placeholders and tags exactly. For ok, "fix" is "". "reason" is one short sentence in Korean.
Reply with JSON only: {"reviews":[{"id":"…","verdict":"ok|minor|major","fix":"…","reason":"…"}]}, one entry for every input id.`;

export function buildReviewPrompt(items: readonly ReviewItem[], glossary: Glossary): Prompt {
  const plain = items.map((item) => withoutPlaceholders(item.source, placeholderNames(item.source, item.placeholders)));
  const seen = new Set<string>();
  const terms: GlossaryTerm[] = [];
  for (const term of plain.flatMap((text) => termsIn(text, glossary))) {
    if (!seen.has(term.en)) {
      seen.add(term.en);
      terms.push(term);
    }
  }
  const lower = plain.join('\n').toLowerCase();
  const brands = glossary.brands.filter((brand) => lower.includes(brand.toLowerCase()));
  const glossaryBlock = terms.length === 0 ? '' : `Glossary (use exactly):\n${terms.map((t) => `- ${t.en} → ${t.ko}`).join('\n')}\n\n`;
  const brandBlock = brands.length === 0 ? '' : `Keep in English: ${brands.join(', ')}\n\n`;
  const payload = JSON.stringify(items.map((item) => ({ id: item.id, kind: item.kind, file: item.file, source: item.source, draft: item.draft })), null, 2);

  return { system: REVIEW_SYSTEM, user: `${glossaryBlock}${brandBlock}Review these drafts:\n${payload}` };
}

export function reviewSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      reviews: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['ok', 'minor', 'major'] }, fix: { type: 'string' }, reason: { type: 'string' } },
          required: ['id', 'verdict', 'fix', 'reason'],
        },
      },
    },
    required: ['reviews'],
  };
}

/** 응답에서 아는 id의 판정을 읽는다. 판정 값이 셋 중 하나가 아니면 오류 */
export function parseReview(text: string, ids: readonly string[]): Map<string, { verdict: Verdict; fix: string; reason: string }> {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const data = JSON.parse(body) as { reviews?: unknown };
  if (!Array.isArray(data.reviews)) {
    throw new Error('검토 응답에 reviews 목록이 없습니다.');
  }
  const known = new Set(ids);
  const out = new Map<string, { verdict: Verdict; fix: string; reason: string }>();
  for (const entry of data.reviews as { id?: unknown; verdict?: unknown; fix?: unknown; reason?: unknown }[]) {
    if (typeof entry.id !== 'string' || !known.has(entry.id)) {
      continue;
    }
    if (typeof entry.verdict !== 'string' || !VERDICTS.has(entry.verdict)) {
      throw new Error(`알 수 없는 판정: ${String(entry.verdict)} (${entry.id})`);
    }
    out.set(entry.id, { verdict: entry.verdict as Verdict, fix: typeof entry.fix === 'string' ? entry.fix : '', reason: typeof entry.reason === 'string' ? entry.reason : '' });
  }

  return out;
}

export interface ReviewOutcome {
  readonly reviewed: number;
  readonly missing: number;
  readonly requests: number;
  readonly stopped?: 'quota-daily';
}

export interface ReviewOptions {
  readonly items: readonly ReviewItem[];
  readonly glossary: Glossary;
  readonly engine: Engine;
  readonly batchSize: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onResult: (result: ReviewResult) => void;
  readonly onRequest?: (log: { readonly ids: readonly string[]; readonly ms: number; readonly usage?: EngineUsage; readonly error?: string; readonly unparsed?: string }) => void;
}

/** 묶음으로 검토하고, 답이 빠진 id는 한 번 더 묶어 묻는다. 일일 한도면 멈추고 남은 수를 알린다 */
export async function runReview(options: ReviewOptions): Promise<ReviewOutcome> {
  let requests = 0;
  let reviewed = 0;
  const done = new Set<string>();

  const ask = async (group: readonly ReviewItem[]): Promise<void> => {
    const ids = group.map((item) => item.id);
    const started = Date.now();
    requests++;
    let parsed = new Map<string, { verdict: Verdict; fix: string; reason: string }>();
    try {
      const result = await callWithRetry(options.engine, { prompt: buildReviewPrompt(group, options.glossary), schema: reviewSchema() }, { sleep: options.sleep });
      try {
        parsed = parseReview(result.text, ids);
        options.onRequest?.({ ids, ms: result.ms, ...(result.usage === undefined ? {} : { usage: result.usage }) });
      } catch {
        options.onRequest?.({ ids, ms: result.ms, unparsed: result.text.slice(0, 8000) });
      }
    } catch (error: unknown) {
      if (!(error instanceof EngineError)) {
        throw error;
      }
      options.onRequest?.({ ids, ms: Date.now() - started, error: `${error.kind}: ${error.message}` });
      if (error.kind === 'quota-daily') {
        throw error;
      }
    }
    for (const item of group) {
      const found = parsed.get(item.id);
      if (found === undefined) {
        continue;
      }
      done.add(item.id);
      reviewed++;
      if (found.verdict === 'ok' || found.fix.trim() === '') {
        options.onResult({ id: item.id, verdict: found.verdict, reason: found.reason });
        continue;
      }
      const fix = found.fix.normalize('NFC');
      const issues = hardIssues({ source: item.source, kind: item.kind, ...(item.kinds === undefined ? {} : { kinds: item.kinds }), placeholders: item.placeholders }, fix);
      options.onResult(issues.length === 0 ? { id: item.id, verdict: found.verdict, reason: found.reason, fix } : { id: item.id, verdict: found.verdict, reason: found.reason, fixRejected: issues });
    }
  };

  try {
    for (let start = 0; start < options.items.length; start += options.batchSize) {
      const batch = options.items.slice(start, start + options.batchSize);
      await ask(batch);
      const missing = batch.filter((item) => !done.has(item.id));
      if (missing.length > 0) {
        await ask(missing);
      }
    }
  } catch (error: unknown) {
    if (error instanceof EngineError && error.kind === 'quota-daily') {
      return { reviewed, missing: options.items.length - reviewed, requests, stopped: 'quota-daily' };
    }
    throw error;
  }

  return { reviewed, missing: options.items.length - reviewed, requests };
}

/** 요청을 보냈는데 하나도 판정받지 못했다(키 만료·잘못된 키 등). 일일 한도로 멈춘 것은 실패가 아니다 */
export function reviewFailed(outcome: ReviewOutcome): boolean {
  return outcome.requests > 0 && outcome.reviewed === 0 && outcome.stopped === undefined;
}
