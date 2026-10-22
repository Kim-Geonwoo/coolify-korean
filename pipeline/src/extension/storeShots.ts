/**
 * Chrome 웹 스토어 스크린샷(store-shots)의 순수 부분: 찍을 쪽 목록, 파일 이름, JPEG 크기 읽기, 개인 정보 검사.
 * 찍기는 storeShotsRun.ts(Playwright)가 한다.
 */

/** 스토어가 받는 큰 쪽 크기(1280x800 또는 640x400). JPEG나 알파 없는 24비트 PNG만 받는다 */
export const STORE_SIZE = { width: 1280, height: 800 } as const;

export interface StoreShot {
  /** 파일 이름 조각(소문자 kebab-case) */
  readonly slug: string;
  /** 시험 인스턴스 안 경로 */
  readonly path: string;
  /** 찍기 전에 열 모달의 단추 글(영어 원문. 확장 사전으로 한국어 글도 찾는다) */
  readonly modal?: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT = /^[A-Za-z0-9]+$/;

/**
 * 스토어에 올릴 쪽. 예시 시드(screenshots/seed.ts)만 보이는 쪽을 고른다.
 * 로그인 이메일이 보이는 /profile·/team, 실제 호스트 이름(host.docker.internal)이 보이는 localhost 서버는 넣지 않는다
 */
export function storeShotPlan(environment: string): readonly StoreShot[] {
  if (!ENVIRONMENT.test(environment)) {
    throw new Error(`환경 id가 이상합니다: ${JSON.stringify(environment)}`);
  }
  const project = `/project/demo/environment/${environment}`;

  return [
    { slug: 'dashboard', path: '/' },
    { slug: 'project-resources', path: project },
    { slug: 'application', path: `${project}/application/demo-nixpacks` },
    { slug: 'server', path: '/server/demo-server' },
    { slug: 'new-project', path: '/projects', modal: 'New project' },
  ];
}

/** screenshot-<번호>-<slug>.jpg(번호는 1부터) */
export function shotFileName(index: number, slug: string): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`번호는 1 이상 정수여야 합니다: ${String(index)}`);
  }
  if (!SLUG.test(slug)) {
    throw new Error(`slug는 소문자 kebab-case여야 합니다: ${JSON.stringify(slug)}`);
  }

  return `screenshot-${String(index)}-${slug}.jpg`;
}

export interface JpegInfo {
  readonly width: number;
  readonly height: number;
  /** 색 성분 수(3이면 24비트 YCbCr/RGB, 1이면 회색조) */
  readonly components: number;
}

// 프레임 시작 표지(SOF0~SOF15). C4(DHT)·C8(JPG 예약)·CC(DAC)는 표 조각이라 뺀다
const isFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
// 길이 칸 없이 표지만 있는 것: TEM, RST0~7
const isStandalone = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/** JPEG 머리의 SOF 조각에서 너비·높이·성분 수를 읽는다. JPEG가 아니거나 잘렸거나 프레임 전에 스캔이 나오면 null */
export function jpegSize(buffer: Uint8Array): JpegInfo | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let at = 2;
  while (at < buffer.length) {
    if (buffer[at] !== 0xff) {
      return null;
    }
    // 표지 앞 채움 바이트(FF 여러 개)
    while (at < buffer.length && buffer[at] === 0xff) {
      at++;
    }
    const marker = buffer[at];
    if (marker === undefined) {
      return null;
    }
    at++;
    if (isStandalone(marker)) {
      continue;
    }
    // 프레임 전에 영상 끝(D9)이나 스캔(DA)이 나오면 크기를 알 수 없다
    if (marker === 0xd9 || marker === 0xda || at + 2 > buffer.length) {
      return null;
    }
    const length = ((buffer[at] ?? 0) << 8) | (buffer[at + 1] ?? 0);
    if (length < 2 || at + length > buffer.length) {
      return null;
    }
    if (isFrame(marker)) {
      if (length < 8) {
        return null;
      }
      const height = ((buffer[at + 3] ?? 0) << 8) | (buffer[at + 4] ?? 0);
      const width = ((buffer[at + 5] ?? 0) << 8) | (buffer[at + 6] ?? 0);

      return { width, height, components: buffer[at + 7] ?? 0 };
    }
    at += length;
  }

  return null;
}

/** 스토어 규격에 맞으면 null, 아니면 무엇이 틀렸는지 */
export function storeImageProblem(buffer: Uint8Array): string | null {
  const info = jpegSize(buffer);
  if (info === null) {
    return 'JPEG가 아니거나 머리(SOF)를 읽지 못했습니다.';
  }
  if (info.width !== STORE_SIZE.width || info.height !== STORE_SIZE.height) {
    return `크기가 ${String(info.width)}x${String(info.height)}입니다(${String(STORE_SIZE.width)}x${String(STORE_SIZE.height)}이어야 함).`;
  }
  if (info.components !== 3) {
    return `색 성분 ${String(info.components)}개입니다(24비트 색은 3개).`;
  }

  return null;
}

const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const ALLOWED_IPV4 = new Set(['127.0.0.1', '0.0.0.0']);

/** 화면 글(본문과 입력칸 값)에 로그인 이메일이나 루프백 밖 IPv4가 있으면 그 문제들(값 자체는 되풀이하지 않는다) */
export function privacyProblems(text: string, email: string): string[] {
  const problems: string[] = [];
  if (email !== '' && text.toLowerCase().includes(email.toLowerCase())) {
    problems.push('로그인 이메일이 보입니다.');
  }
  for (const match of text.matchAll(IPV4)) {
    if (!ALLOWED_IPV4.has(match[0])) {
      problems.push('127.0.0.1이 아닌 IPv4 주소가 보입니다.');
    }
  }

  return problems;
}
