import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { xpiInfo } from '../extension/xpi.ts';
import { parseStableVersion } from '../sync/upstream.ts';
import { latestPublished, type PublishedLedger } from './ledger.ts';
import { buildMirror, mirrorIssues } from './mirror.ts';

/**
 * 공개 미러 사이트(5단계 공개 계획 P1). Cloudflare Workers(정적 자산, Git 연동)가 미러 전용 레포 main의 public 폴더를 빌드 없이 낸다.
 * versions.json만 서버가 6시간마다 갱신하고(refreshVersions), 나머지(언어 파일·스크립트·서명 키·확장 파일)는 사람이 PC에서 발행할 때 바꾼다
 */
export const SITE_URL = 'https://coolify-ko.geonwoo.dev';
export const SOURCE_REPO = 'https://github.com/Kim-Geonwoo/coolify-korean';
/** 스크립트 해시·서명 공개 키를 받는 곳: 서버가 쓸 수 없는 공개 레포(사이트가 뚫려도 바뀌지 않는다, 보안 점검 4) */
export const PINNED_RAW = 'https://raw.githubusercontent.com/Kim-Geonwoo/coolify-korean/main';
export const IMAGE_REPO = 'ghcr.io/kim-geonwoo/coolify-ko';
/** 미러 레포에서 사이트로 내는 폴더. .git과 wrangler 설정은 이 밖에 둔다(2026-10-20: 레포 루트를 내자 .git이 공개됐다) */
export const ASSETS_DIR = 'public';
export const versionsPath = (dir: string): string => join(dir, ASSETS_DIR, 'versions.json');

/** 대시보드의 Worker 이름과 같아야 Git 연동 배포가 된다. observability는 대시보드 값(2026-10-20 사용자) 그대로 */
const WRANGLER = `${JSON.stringify(
  {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: 'coolify-ko-mirror',
    compatibility_date: '2026-10-19',
    assets: { directory: `./${ASSETS_DIR}` },
    observability: {
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true },
      traces: { enabled: false, head_sampling_rate: 1, persist: true },
    },
  },
  null,
  2,
)}\n`;

export interface SiteInput {
  readonly cdn: unknown;
  readonly published: PublishedLedger;
  readonly now: Date;
  /** 이전 versions.json. 같은 상류 버전이면 처음 본 시각을 이어 받는다 */
  readonly previousVersions?: unknown;
  readonly lang: { readonly code: string; readonly text: string; readonly catalogVersion: string; readonly commit: string };
  readonly script: string;
  readonly cosignPub?: string;
  /** 서명한 원격 사전과, AMO가 서명한 Firefox 확장(.xpi, 없으면 빈 갱신 목록) */
  readonly extension?: { readonly dictionary: string; readonly signature: string; readonly xpi?: Uint8Array };
}

/** 미러 레포 경로 → 내용(글은 string, .xpi는 바이트) */
export type SiteFiles = Map<string, string | Uint8Array>;

const HEADERS = `/*
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
  Cache-Control: public, max-age=300

/extension/*.xpi
  Content-Type: application/x-xpinstall
`;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function seenAt(previous: unknown, cdn: unknown, now: Date): string {
  let upstream: string;
  try {
    upstream = parseStableVersion(cdn);
  } catch {
    return now.toISOString();
  }
  const info = (previous as { 'coolify-ko'?: { upstream?: unknown; upstreamSeenAt?: unknown } } | null | undefined)?.['coolify-ko'];
  const kept = info?.upstreamSeenAt;

  return info?.upstream === upstream && typeof kept === 'string' && !Number.isNaN(Date.parse(kept)) ? kept : now.toISOString();
}

function versionsText(input: Pick<SiteInput, 'cdn' | 'published' | 'now' | 'previousVersions'>): string {
  const mirror = buildMirror({ cdn: input.cdn, published: input.published, upstreamSeenAt: seenAt(input.previousVersions, input.cdn, input.now), now: input.now });
  const issues = mirrorIssues(mirror, input.cdn, input.published);
  if (issues.length > 0) {
    throw new Error(`미러 검사 문제: ${issues.join(' / ')}`);
  }

  return `${JSON.stringify(mirror, null, 2)}\n`;
}

/** 개인정보 문의 주소(2026-10-20 사용자: kgw@geonwoo.dev, 책임자 이름은 적지 않음. 전용 별칭·이메일 라우팅은 쓸 수 없었다) */
export const CONTACT_EMAIL = 'kgw@geonwoo.dev';
/** Chrome 웹 스토어 등록 주소(2026-10-22 승인) */
export const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/coolify-%ED%95%9C%EA%B5%AD%EC%96%B4-%EB%B9%84%EA%B3%B5%EC%8B%9D/hjfmiecbkiimkbnhoedjicaccmdaihni';
const POLICY_DATE = '2026년 10월 20일';
/** 확장 id(manifest.firefox.json의 gecko id와 같아야 한다) */
const FIREFOX_ID = 'coolify-ko@unofficial';

/** 스토어 심사·사용자가 확장을 시험하는 쪽에 보이는 Coolify 화면 문구(모두 확장 사전에 있어야 한다) */
export const DEMO_PHRASES = [
  'Dashboard',
  'Projects',
  'Servers',
  'Sources',
  'Destinations',
  'Shared Variables',
  'Notifications',
  'Keys & Tokens',
  'Tags',
  'Terminal',
  'Profile',
  'Teams',
  'Settings',
  'New Project',
  'Resources',
  'Environment Variables',
  'Persistent Storage',
  'Deploy',
  'Restart',
  'Stop',
  'Logs',
  'Save',
] as const;

const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** 첫 쪽에 보일 Firefox 파일 정보(다른 배포 사이트처럼 버전·크기·SHA-256) */
interface FirefoxFile {
  readonly name: string;
  readonly version: string;
  readonly bytes: number;
  readonly sha256: string;
}

function indexHtml(version: string, xpi: FirefoxFile | undefined): string {
  const firefox =
    xpi === undefined
      ? '<li>Firefox: 준비 중</li>'
      : `<li>Firefox: <a href="extension/${xpi.name}">${xpi.name}</a> (${xpi.version}, ${(xpi.bytes / 1024).toFixed(1)} KB)<br>SHA-256: <code>${xpi.sha256}</code> (<a href="extension/${xpi.name}.sha256">.sha256</a>)</li>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coolify-ko</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif}pre{background:#f4f4f5;padding:.75rem;overflow-x:auto}</style>
</head>
<body>
<h1>coolify-ko</h1>
<p>자체 호스팅 <a href="https://coolify.io">Coolify</a>에 한국어 화면을 얹는 <strong>비공식</strong> 판입니다. 공식 이미지 위에 번역 파일만 덮고, 언제든 공식판으로 돌아갈 수 있습니다. 지금 판: ${version}</p>
<p>An unofficial Korean build of self-hosted Coolify. It keeps the official image and only adds translation files.</p>
<h2>설치(이미 설치한 Coolify 서버에서)</h2>
<pre>curl -fsSL ${SITE_URL}/coolify-ko.sh -o coolify-ko.sh
curl -fsSL ${PINNED_RAW}/scripts/coolify-ko.sh.sha256 | sha256sum -c -
sudo bash coolify-ko.sh install</pre>
<h2>공식판으로 되돌리기</h2>
<pre>sudo bash /data/coolify/source/coolify-ko.sh uninstall</pre>
<h2>서명 확인</h2>
<pre>cosign verify --key ${PINNED_RAW}/releases/cosign.pub ${IMAGE_REPO}:${version}</pre>
<h2>브라우저 확장</h2>
<p>서버를 바꾸지 않고 브라우저에서 화면만 한국어로 볼 수도 있습니다. 확장은 사용자가 켠 주소에서만 동작합니다. <a href="demo.html">시험 쪽</a>에서 먼저 확인해 볼 수 있습니다.</p>
<ul>
<li>Chrome: <a href="${CHROME_STORE_URL}">Chrome 웹 스토어</a></li>
${firefox}
</ul>
<p><a href="privacy.html">확장 개인정보 처리방침</a></p>
<h2>문의</h2>
<p>소스와 설명: <a href="${SOURCE_REPO}">${SOURCE_REPO}</a> · 개발자 문의: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>

<p>Source: <a href="${SOURCE_REPO}">${SOURCE_REPO}</a> · Developer contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</body>
</html>
`;
}

const PRIVACY = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coolify-ko 개인정보 처리방침</title>
</head>
<body>
<h1>coolify-ko 개인정보 처리방침</h1>
<p>coolify-ko 운영자(이하 "운영자")는 「개인정보 보호법」 등 관련 법령을 지키며, 이 처리방침으로 이용자의 개인정보가 어떻게 처리되는지 알립니다. 이 방침은 다음에 적용됩니다.</p>
<ul>
<li>coolify-ko 사이트(${SITE_URL})와 그곳에서 받는 파일(설치 스크립트, versions.json, 언어 파일, 서명 공개 키, 확장 사전)</li>
<li>한국어판 Docker 이미지(${IMAGE_REPO})</li>
<li>브라우저 확장 「Coolify 한국어 (비공식)」(Chrome, Firefox)</li>
</ul>
<p>coolify-ko는 Coolify를 만든 coolLabs와 관계없는 비공식 프로젝트입니다.</p>
<p><strong>요약:</strong> 운영자는 이름·이메일·전화번호·계정 같은 개인정보를 받지 않습니다. 회원가입, 로그인, 결제, 광고, 분석 도구, 쿠키가 없습니다. 사이트에서 파일을 받을 때 생기는 접속 기록(IP 주소 등)만 사이트를 운영하는 Cloudflare에서 처리됩니다. 확장은 화면 글을 브라우저 안에서만 처리하고 밖으로 보내지 않습니다.</p>

<h2>1. 처리하는 개인정보 항목</h2>
<p><strong>가. 사이트 접속 기록(자동 생성)</strong>: 접속한 기기의 IP 주소, 요청 시각, 요청한 주소, 브라우저·프로그램 정보(User-Agent). 다음 경우에 생깁니다.</p>
<ul>
<li>이용자가 사이트를 열 때</li>
<li>설치 스크립트가 파일을 받을 때</li>
<li>한국어판을 설치한 Coolify 서버가 업데이트를 확인하려고 versions.json을 받을 때</li>
<li>확장이 번역 사전과 확장 갱신을 확인할 때</li>
</ul>
<p>확장은 이 요청에 이용자 데이터를 담지 않습니다. 모든 웹 요청처럼 IP 주소와 브라우저 정보만 사이트에 전달됩니다.</p>
<p><strong>나. 브라우저 확장이 이용자의 기기에만 저장하는 정보</strong>(운영자에게 보내지 않습니다)</p>
<ul>
<li>이용자가 확장을 켠 주소(예: https://coolify.example.com) 목록</li>
<li>번역 사전</li>
<li>사전에 없어 번역하지 못한 화면 문구 목록: 최대 2,000개, 한 문구 200자 이하. 주소·이메일·숫자처럼 보이는 글은 빼지만, 화면에 표시된 서버·프로젝트 이름 같은 글이 섞일 수 있습니다.</li>
</ul>
<p>운영자는 가.의 정보로 이용자를 알아보려 하지 않고, 다른 정보와 결합하지 않습니다.</p>

<h2>2. 처리 목적</h2>
<ul>
<li>가.의 접속 기록: 파일 전달, 서비스의 안정적 운영과 보안(장애 원인 확인, 남용·공격 대응)</li>
<li>나.의 확장 정보: 번역 기능 제공. 누락 문구 목록은 이용자가 확장 창에서 파일로 저장해 운영자에게 직접 보낼 때(예: 이메일)만 운영자가 받습니다. 파일에 화면의 서버·프로젝트 이름 같은 글이 들어 있을 수 있으니 보내기 전에 확인해 주십시오.</li>
</ul>

<h2>3. 처리 및 보유 기간</h2>
<ul>
<li>운영자가 볼 수 있는 요청 기록(Cloudflare Workers 로그)은 최대 7일 보관한 뒤 자동으로 지워집니다. 대시보드 통계는 개인을 알아볼 수 없는 집계 수치만 보입니다.</li>
<li>Cloudflare가 보안과 네트워크 운영을 위해 따로 처리하는 정보는 <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare 개인정보처리방침</a>에 따릅니다.</li>
<li>확장 정보는 이용자가 지우거나 확장을 삭제할 때까지 이용자의 기기에 남습니다.</li>
<li>법령에 따라 따로 보존하는 개인정보는 없습니다.</li>
</ul>

<h2>4. 제3자 제공</h2>
<p>운영자는 개인정보를 제3자에게 제공하거나 판매하지 않습니다. 다만 법률에 특별한 규정이 있는 경우는 예외입니다.</p>
<p>확장이 다루는 데이터의 사용은 Chrome 웹 스토어 사용자 데이터 정책(제한적 사용 요건 포함)을 따릅니다. 번역 기능 외의 목적으로 쓰지 않고, 광고 목적으로 전송하거나 판매하지 않으며, 신용도 판단이나 대출에 쓰지 않습니다.</p>

<h2>5. 처리 위탁과 국외 이전</h2>
<p>운영자는 사이트 운영을 다음과 같이 맡기며, 이 과정에서 접속 기록이 국외로 이전됩니다.</p>
<ul>
<li>이전받는 자: Cloudflare, Inc.(개인정보 문의: <a href="mailto:PrivacyQuestions@cloudflare.com">PrivacyQuestions@cloudflare.com</a>)</li>
<li>맡기는 업무: 사이트 호스팅과 파일 전송(콘텐츠 전송망)</li>
<li>이전 항목: 1항 가.의 접속 기록(IP 주소, 요청 시각, 요청한 주소, User-Agent)</li>
<li>이전 국가: 미국 및 Cloudflare 데이터센터가 있는 국가(목록: <a href="https://www.cloudflare.com/network/">https://www.cloudflare.com/network/</a>). 요청은 접속한 곳에서 가장 가까운 데이터센터에서 처리됩니다.</li>
<li>이전 시기와 방법: 사이트에 접속할 때마다 네트워크를 통해 전송</li>
<li>이용 목적과 보유 기간: 파일 전송과 보안, 3항의 기간</li>
<li>이전 근거: 「개인정보 보호법」 제28조의8 제1항 제3호 가목(정보주체와의 계약 체결·이행을 위한 처리위탁·보관으로서, 같은 조 제2항 각 호의 사항을 이 처리방침에 공개)</li>
<li>거부 방법: 사이트에 접속하지 않고, 한국어판을 공식판으로 되돌리고(첫 쪽의 되돌리기 명령), 확장을 삭제합니다. 확장은 브라우저가 시작할 때 사전과 갱신을 확인하므로 끄기만으로는 멈추지 않습니다.</li>
<li>거부의 효과: 설치 스크립트, 한국어판 업데이트 확인, 확장과 사전 갱신을 쓸 수 없습니다.</li>
</ul>
<p>이용자가 직접 이용하는 다음 서비스는 운영자가 맡긴 것이 아니며, 각 서비스의 처리방침에 따라 정보를 처리합니다. 운영자는 이들로부터 개인을 알아볼 수 있는 정보를 받지 않습니다(내려받기·설치 횟수 같은 집계만 볼 수 있습니다).</p>
<ul>
<li>한국어판 이미지와 소스: GitHub(GitHub Container Registry, GitHub 저장소)</li>
<li>공식 Coolify 이미지와 설치 파일: Docker Hub, coolLabs</li>
<li>확장 배포: Chrome 웹 스토어(Google), Firefox 부가 기능(Mozilla)</li>
</ul>

<h2>6. 파기 절차와 방법</h2>
<ul>
<li>운영자는 개인정보를 따로 저장하지 않습니다.</li>
<li>Cloudflare의 요청 기록은 3항의 기간이 지나면 자동으로 지워집니다.</li>
<li>확장 정보 중 누락 문구 목록은 확장 창의 "목록 비우기" 버튼으로, 켠 주소는 "이 주소에서 비활성화"로 지웁니다. 확장을 삭제하면 브라우저가 모두 지웁니다.</li>
</ul>

<h2>7. 이용자의 권리와 행사 방법</h2>
<p>이용자는 언제든지 자신의 개인정보 열람, 정정, 삭제, 처리정지를 요구할 수 있습니다. 아래 연락처로 이메일을 보내 주시면 지체 없이(10일 이내) 처리하고 결과를 알려 드립니다. 운영자는 이용자를 알아볼 수 있는 정보를 갖고 있지 않아, 요청하신 분의 기록을 특정하기 어려우면 그 사유를 알려 드립니다. 법정대리인도 같은 방법으로 권리를 행사할 수 있습니다. 이 서비스는 만 14세 미만 아동을 대상으로 하지 않습니다.</p>

<h2>8. 안전성 확보 조치</h2>
<ul>
<li>필요한 최소한의 정보만 처리하고, 운영자의 서버에 개인정보를 저장하지 않습니다.</li>
<li>사이트는 HTTPS로만 제공합니다.</li>
<li>확장은 운영자의 전자서명을 확인한 사전만 적용하고, 이용자가 허락한 주소에서만 동작합니다.</li>
<li>사이트와 저장소를 관리하는 계정은 운영자만 쓰며, 접근 권한을 최소로 둡니다.</li>
</ul>

<h2>9. 자동으로 수집하는 장치의 설치·운영과 거부</h2>
<p>운영자는 쿠키나 추적 도구를 쓰지 않습니다. Cloudflare가 보안을 위해 필요할 때 보안 쿠키를 둘 수 있으며, 브라우저 설정에서 쿠키를 거부할 수 있습니다(거부하면 일부 접속이 막힐 수 있습니다).</p>

<h2>10. 민감정보와 가명정보</h2>
<p>민감정보와 가명정보를 처리하지 않습니다.</p>

<h2>11. 개인정보 보호책임자</h2>
<p>개인정보 처리에 관한 문의, 불만, 피해 구제 요청은 아래로 보내 주십시오.</p>
<ul>
<li>개인정보 보호책임자: coolify-ko 운영자</li>
<li>이메일: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></li>
</ul>

<h2>12. 권익침해 구제 방법</h2>
<p>개인정보 침해에 대한 신고나 상담이 필요하면 다음 기관에 문의할 수 있습니다.</p>
<ul>
<li>개인정보 분쟁조정위원회: 1833-6972, <a href="https://www.kopico.go.kr">www.kopico.go.kr</a></li>
<li>개인정보침해 신고센터(한국인터넷진흥원): 118, <a href="https://privacy.kisa.or.kr">privacy.kisa.or.kr</a></li>
<li>대검찰청: 1301, <a href="https://www.spo.go.kr">www.spo.go.kr</a></li>
<li>경찰청: 182, <a href="https://ecrm.police.go.kr">ecrm.police.go.kr</a></li>
</ul>

<h2>13. 처리방침의 변경</h2>
<p>이 처리방침이 바뀌면 시행 7일 전에 이 쪽에 알립니다. 이용자의 권리에 중요한 변경은 30일 전에 알립니다.</p>
<p>시행일: ${POLICY_DATE}</p>

<h2>English summary</h2>
<ul>
<li>The operator does not collect personal data directly. There are no accounts, payments, ads, analytics or cookies.</li>
<li>Requests to ${SITE_URL} (opening the site, the installer, update checks from Coolify servers and from the extension) are served by Cloudflare, Inc., which processes the IP address, request time, requested URL and user agent. Request logs visible to the operator are kept for at most 7 days and then deleted automatically. The extension puts no user data in these requests.</li>
<li>The browser extension reads page text only on the addresses the user enabled, and replaces it with Korean inside the browser. It stores the enabled addresses, the dictionary and a list of untranslated phrases (at most 2,000 phrases, 200 characters each) in local extension storage. This data never leaves the device unless the user exports it, and the user can clear it at any time.</li>
<li>The operator does not sell or transfer user data to third parties, does not use it for purposes unrelated to translating the Coolify interface, and does not use it to determine creditworthiness or for lending. Use of user data by the extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.</li>
<li>Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. Effective date: 20 October 2026.</li>
</ul>
</body>
</html>
`;

const DEMO = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coolify-ko 확장 시험</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif}ul.demo{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;padding:0}ul.demo li{border:1px solid #d4d4d8;border-radius:6px;padding:.25rem .6rem}</style>
</head>
<body>
<h1>확장 시험 쪽</h1>
<p>Coolify 대시보드 없이 「Coolify 한국어 (비공식)」 확장을 시험하는 쪽입니다. 아래 상자의 영어 문구는 Coolify 화면에 실제로 나오는 글입니다.</p>
<ol>
<li>브라우저 도구 막대의 확장 아이콘을 누릅니다.</li>
<li>"이 주소에서 활성화"를 누르고, 브라우저가 묻는 이 사이트 접근 권한을 허락합니다.</li>
<li>이 쪽을 새로고침하면 아래 문구가 한국어로 바뀝니다. 끄려면 같은 창에서 "이 주소에서 비활성화"를 누릅니다.</li>
</ol>
<ul class="demo">
${DEMO_PHRASES.map((phrase) => `<li>${escapeHtml(phrase)}</li>`).join('\n')}
</ul>
<p>Test page for the "Coolify 한국어 (비공식)" extension: click the extension icon, choose "이 주소에서 활성화" (enable on this address), allow access, then reload. The English Coolify phrases above turn into Korean.</p>
</body>
</html>
`;

/** Firefox 자체 배포 갱신 목록(manifest의 update_url이 가리킴) */
function firefoxFiles(xpi: Uint8Array | undefined): { readonly file?: FirefoxFile; readonly updates: string } {
  const list = (updates: readonly unknown[]): string => `${JSON.stringify({ addons: { [FIREFOX_ID]: { updates } } }, null, 2)}\n`;
  if (xpi === undefined) {
    return { updates: list([]) };
  }
  const info = xpiInfo(xpi);
  if (!info.signed || info.id !== FIREFOX_ID) {
    throw new Error(`addons.mozilla.org가 서명한 ${FIREFOX_ID} 확장이 아닙니다(id ${info.id}, 서명 ${String(info.signed)}).`);
  }
  const name = `coolify-ko-${info.version}.xpi`;
  const hash = createHash('sha256').update(xpi).digest('hex');

  return { file: { name, version: info.version, bytes: xpi.byteLength, sha256: hash }, updates: list([{ version: info.version, update_link: `${SITE_URL}/extension/${name}`, update_hash: `sha256:${hash}` }]) };
}

export function buildSite(input: SiteInput): SiteFiles {
  const version = latestPublished(input.published);
  if (version === undefined) {
    throw new Error('발행한 버전이 없어 사이트를 만들지 않습니다.');
  }
  const firefox = input.extension === undefined ? undefined : firefoxFiles(input.extension.xpi);
  const files: SiteFiles = new Map<string, string | Uint8Array>([
    ['versions.json', versionsText(input)],
    ['_headers', HEADERS],
    ['index.html', indexHtml(version, firefox?.file)],
    ['privacy.html', PRIVACY],
    ['demo.html', DEMO],
    ['coolify-ko.sh', input.script],
    ['coolify-ko.sh.sha256', `${sha256(input.script)}  coolify-ko.sh\n`],
    [`lang/${input.lang.code}.json`, input.lang.text],
    ['lang/manifest.json', `${JSON.stringify({ schema: 1, code: input.lang.code, catalogVersion: input.lang.catalogVersion, commit: input.lang.commit, sha256: sha256(input.lang.text) }, null, 2)}\n`],
  ]);
  if (input.cosignPub !== undefined) {
    files.set('cosign.pub', input.cosignPub);
  }
  if (input.extension !== undefined) {
    files.set('extension/dictionary.json', input.extension.dictionary);
    files.set('extension/dictionary.json.sig', input.extension.signature);
    files.set('extension/updates.json', firefox?.updates ?? '');
    if (firefox?.file !== undefined && input.extension.xpi !== undefined) {
      files.set(`extension/${firefox.file.name}`, input.extension.xpi);
      files.set(`extension/${firefox.file.name}.sha256`, `${firefox.file.sha256}  ${firefox.file.name}\n`);
    }
  }
  const repo: [string, string | Uint8Array][] = [['wrangler.jsonc', WRANGLER], ...[...files].map(([path, data]): [string, string | Uint8Array] => [`${ASSETS_DIR}/${path}`, data])];

  return new Map(repo.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const writeAtomic = (path: string, text: string | Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${randomBytes(6).toString('hex')}.partial`;
  writeFileSync(partial, text);
  renameSync(partial, path);
};

/** 미러 레포 작업 사본을 통째로 바꾼다. .git은 남긴다 */
export function writeSite(dir: string, files: ReadonlyMap<string, string | Uint8Array>): void {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (entry !== '.git') {
      rmSync(join(dir, entry), { recursive: true, force: true });
    }
  }
  for (const [path, text] of files) {
    writeAtomic(join(dir, ...path.split('/')), text);
  }
}

/** 서버의 6시간 갱신: versions.json만 다시 만든다. 검사에 걸리면 쓰지 않고 문제를 돌려준다 */
export function refreshVersions(dir: string, input: Pick<SiteInput, 'cdn' | 'published' | 'now'>): { readonly changed: boolean; readonly issues: readonly string[] } {
  const path = versionsPath(dir);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  let previous: unknown;
  try {
    previous = before === undefined ? undefined : (JSON.parse(before) as unknown);
  } catch {
    previous = undefined;
  }
  let text: string;
  try {
    text = versionsText({ ...input, previousVersions: previous });
  } catch (error: unknown) {
    return { changed: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
  if (text === before) {
    return { changed: false, issues: [] };
  }
  writeAtomic(path, text);

  return { changed: true, issues: [] };
}
