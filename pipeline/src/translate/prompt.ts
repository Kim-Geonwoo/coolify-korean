import { termsIn, type Glossary, type GlossaryTerm } from './glossary.ts';
import { isMessage } from './validate.ts';

/** generic: 공통 시스템 프롬프트(Gemini·Gemma), hy-mt2·index: 각 모델 카드의 공식 형식 */
export type PromptStyle = 'generic' | 'hy-mt2' | 'index';

export interface PromptItem {
  readonly id: string;
  /** 자리표시자를 {{name}}으로 가린 영어 */
  readonly text: string;
  readonly kind: string;
  /** 이 키가 쓰이는 모든 kind(없으면 kind 하나) */
  readonly kinds?: readonly string[];
  readonly file: string;
}

export interface Prompt {
  readonly system?: string;
  readonly user: string;
}

const GENERIC_SYSTEM = `You are a professional software localizer. Translate UI strings of the Coolify dashboard (a self-hosted platform for deploying servers, applications and databases) from English into Korean.
Rules:
1. Sentences (toasts, validation messages, descriptions, help texts) use the formal polite style ending in "합니다/습니다" (e.g. "서버를 저장했습니다."). Questions end in "니까?" (e.g. "정말 삭제하시겠습니까?").
2. Buttons, menu items, labels and headings use short noun forms (e.g. "저장", "배포", "새 서버 추가"), not sentences. Use "kind" and "file" to tell them apart.
3. Always use the glossary translations given by the user. Keep product and brand names in English (Coolify, Docker, GitHub, Traefik, ...).
4. Tokens like {{name}} are placeholders. Keep every token exactly as written, once each. After a token, write Korean particles in both forms, like "{{name}}을(를)", "{{name}}이(가)", "{{name}}은(는)", "{{name}}(으)로", "{{name}}와(과)", or rephrase so no particle is needed.
5. Numbered tags like <0>…</0> and <1/> mark links and line breaks. Keep each tag exactly, keep pairs around the matching words, and never add other tags or HTML.
6. Keep line breaks and leading or trailing spaces of each text. Do not translate URLs, file paths, commands, code or environment variable names.
7. Reply with JSON only: {"translations":[{"id":"…","ko":"…"}]}, one entry for every input id.`;

/** v2(2b): 요청은 하세요, 설정·기능 설명은 서술문. 2a에서 "…하십시오"가 섞이고 설정 설명이 지시문으로 바뀐 것을 막는다 */
const V2_RULES = {
  generic: `
8. Requests to the user end in "…하세요" (e.g. "다시 시도하세요"), never "…하십시오".
9. Text that describes what a setting, option or feature does stays a statement ending in "…합니다" (e.g. "팀에 알림을 보냅니다"). Do not turn it into a request.`,
  hyMt2: ' Requests end in "…하세요", never "…하십시오". Descriptions of what a setting or feature does stay statements ending in "…합니다", not requests.',
  index: ['【注意】请求用户做某事的句子以“…하세요”结尾，不要用“…하십시오”。', '【注意】说明设置或功能作用的句子保持陈述句（…합니다），不要改成请求句。'],
} as const;

export interface PromptOptions {
  /** 1: 2a 동결 프롬프트, 2: 2b 규칙 추가(기본) */
  readonly version?: 1 | 2;
}

const TOKEN = /\{\{[^{}]*\}\}/g;

/** 가린 자리표시자 토큰을 뺀 글. 토큰 이름(registry 등)을 용어·브랜드로 잡지 않으려고 */
function plain(text: string): string {
  return text.replace(TOKEN, ' ');
}

function batchTerms(items: readonly PromptItem[], glossary: Glossary): GlossaryTerm[] {
  const seen = new Set<string>();
  const out: GlossaryTerm[] = [];
  for (const item of items) {
    for (const term of termsIn(plain(item.text), glossary)) {
      if (!seen.has(term.en)) {
        seen.add(term.en);
        out.push(term);
      }
    }
  }

  return out;
}

function batchBrands(items: readonly PromptItem[], glossary: Glossary): string[] {
  const text = items.map((item) => plain(item.text)).join('\n').toLowerCase();

  return glossary.brands.filter((brand) => text.includes(brand.toLowerCase()));
}

export type TextType = 'sentence' | 'label' | 'either';

const LABEL_MAX_WORDS = 4;
const SENTENCE_MIN_WORDS = 8;

/**
 * 알림·검증 문구, 마침표·물음표로 끝나는 글, 8단어 이상인 글은 문장, 4단어 이하는 버튼·라벨로 본다.
 * 그 사이(마침표 없는 5~7단어)는 제목과 설명이 섞여 있어 엔진이 문구를 보고 고르게 한다(2b: 긴 설명을 라벨로 넘겨 "…함"으로 쓴 일이 있었다).
 */
export function textType(item: PromptItem): TextType {
  if (/[.!?]\s*$/.test(item.text) || isMessage(item)) {
    return 'sentence';
  }
  const words = item.text.replace(/\{\{[^{}]*\}\}|<\/?\d+\/?>/g, ' ').split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length;

  return words >= SENTENCE_MIN_WORDS ? 'sentence' : words <= LABEL_MAX_WORDS ? 'label' : 'either';
}

const HINTS: Readonly<Record<TextType, string>> = { sentence: 'sentence', label: 'short label or button', either: 'label or sentence (decide from the wording)' };

function hint(item: PromptItem): string {
  return `${item.id}: ${HINTS[textType(item)]}`;
}

export function buildPrompt(style: PromptStyle, items: readonly PromptItem[], glossary: Glossary, options: PromptOptions = {}): Prompt {
  const v2 = (options.version ?? 2) === 2;
  const terms = batchTerms(items, glossary);
  const brands = batchBrands(items, glossary);
  const asObject = JSON.stringify(Object.fromEntries(items.map((item) => [item.id, item.text])), null, 2);
  switch (style) {
    case 'generic': {
      const glossaryBlock = terms.length === 0 ? '' : `Glossary (use exactly):\n${terms.map((t) => `- ${t.en} → ${t.ko}`).join('\n')}\n\n`;
      const brandBlock = brands.length === 0 ? '' : `Keep in English: ${brands.join(', ')}\n\n`;
      const payload = JSON.stringify(items.map((item) => ({ id: item.id, kind: item.kind, file: item.file, text: item.text })), null, 2);

      return { system: v2 ? GENERIC_SYSTEM + V2_RULES.generic : GENERIC_SYSTEM, user: `${glossaryBlock}${brandBlock}Translate these UI strings:\n${payload}` };
    }
    case 'hy-mt2': {
      const reference = terms.length === 0 ? '' : `Reference the following translations:\n${terms.map((t) => `${t.en} translates to ${t.ko}`).join('\n')}\n`;

      return {
        user: `${reference}### Task
Translate the user-facing text within the following JSON data into Korean.
### Strict Rules
1. **Structure Preservation:** You MUST preserve the original JSON data structure, nesting, hierarchy, and indentation exactly as they are.
2. **Selective Translation:** Translate ONLY the visible, user-facing text content/values.
3. **Strict Non-Translation:** NEVER translate or alter code tags, keys, properties, object names, or variable placeholders. Leave them exactly in their original English/code form.
4. **Style:** Sentences end in the formal "합니다/습니다" style. Short labels and buttons use noun forms. After a {{placeholder}} write particles in both forms like "을(를)" and "이(가)".${v2 ? V2_RULES.hyMt2 : ''}${brands.length === 0 ? '' : ` Keep these names in English: ${brands.join(', ')}.`}
${items.map((item) => `- ${hint(item)}`).join('\n')}
### Source Data
${asObject}`,
      };
    }
    case 'index': {
      const labels = items.filter((item) => textType(item) === 'label').map((item) => item.id);
      const sentences = items.filter((item) => textType(item) === 'sentence').map((item) => item.id);
      const constraints: string[] = [];
      if (terms.length > 0) {
        constraints.push(`【硬性要求】专名/术语对照: ${terms.map((t) => `${t.en}→${t.ko}`).join('、')}`);
      }
      constraints.push('【硬性要求】保留JSON结构和键不变，只翻译值；{{name}} 形式的占位符和 <0>…</0>、<1/> 标签原样保留，不要新增任何HTML。');
      if (brands.length > 0) {
        constraints.push(`【硬性要求】以下名称保持英文：${brands.join('、')}`);
      }
      constraints.push('【注意】句子用韩语“합니다/습니다”格式体结尾；按钮、菜单和标签用简短的名词形式。占位符后的助词写成“을(를)”“이(가)”等两种形式并列。');
      if (v2) {
        constraints.push(...V2_RULES.index);
      }
      if (labels.length > 0) {
        constraints.push(`【注意】以下条目是按钮或标签，用简短的名词形式：${labels.join('、')}`);
      }
      if (sentences.length > 0) {
        constraints.push(`【注意】以下条目是句子：${sentences.join('、')}`);
      }

      return {
        user: `请将以下英语JSON数据中的界面文本翻译成韩语，并且严格遵循所有约束要求。
【源文】
${asObject}
【约束要求】
${constraints.map((line, index) => `${String(index + 1)}. ${line}`).join('\n')}
只输出译文，不要有任何额外说明。`,
      };
    }
  }
}

/** 엔진이 돌려줄 JSON의 스키마. generic은 배열, MT 전용 모델은 원문과 같은 키의 객체 */
export function responseSchema(style: PromptStyle, ids: readonly string[]): Record<string, unknown> {
  if (style === 'generic') {
    return {
      type: 'object',
      properties: { translations: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, ko: { type: 'string' } }, required: ['id', 'ko'] } } },
      required: ['translations'],
    };
  }

  return { type: 'object', properties: Object.fromEntries(ids.map((id) => [id, { type: 'string' }])), required: [...ids], additionalProperties: false };
}

/** 응답 글(코드 울타리 허용)에서 id → 번역을 읽는다. 아는 id만 남기고, 형식이 다르면 오류. */
export function parseTranslations(text: string, ids: readonly string[]): Map<string, string> {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const open = body.indexOf('{');
  const close = body.lastIndexOf('}');
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    try {
      // 스키마 없이 답하는 모델이 앞뒤에 설명을 붙인 경우: 가장 바깥 { … }만 읽는다
      data = open >= 0 && close > open ? JSON.parse(body.slice(open, close + 1)) : undefined;
    } catch {
      data = undefined;
    }
    if (data === undefined) {
      throw new Error('응답이 JSON이 아닙니다.');
    }
  }
  const pairs: [unknown, unknown][] = [];
  if (typeof data === 'object' && data !== null && Array.isArray((data as { translations?: unknown }).translations)) {
    for (const entry of (data as { translations: unknown[] }).translations) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error('translations 항목이 객체가 아닙니다.');
      }
      pairs.push([(entry as { id?: unknown }).id, (entry as { ko?: unknown }).ko]);
    }
  } else if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    pairs.push(...Object.entries(data));
  } else {
    throw new Error('응답 JSON의 모양이 다릅니다.');
  }
  const known = new Set(ids);
  const out = new Map<string, string>();
  for (const [id, ko] of pairs) {
    if (typeof id !== 'string' || typeof ko !== 'string') {
      throw new Error('id와 번역은 문자열이어야 합니다.');
    }
    if (known.has(id)) {
      out.set(id, ko);
    }
  }

  return out;
}
