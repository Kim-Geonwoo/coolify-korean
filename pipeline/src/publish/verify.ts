import { PLATFORMS, type Platform } from './platforms.ts';
import type { TarEntry } from './tar.ts';

/**
 * 공개판 이미지 검증(5단계, PC에서 발행 전). PaaS 호스트가 한국어판을 받을 때 보는 규칙과 같은 꼴에 기본 언어 폴더만 더했다:
 * 공식 이미지 층 위에 허용 경로의 일반 파일·폴더만 얹었는지, 두 플랫폼이 모두 있는지 본다
 */
export const ALLOWED_PUBLIC_PATHS = ['var/www/html/app/', 'var/www/html/resources/views/', 'var/www/html/config/', 'var/www/html/bootstrap/helpers/', 'var/www/html/lang-default/', 'usr/share/doc/coolify-ko/'] as const;

const LAYER_TYPES = new Set(['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.docker.image.rootfs.diff.tar', 'application/vnd.docker.image.rootfs.diff.tar.gzip']);

// 공식 4.4.6의 소유자(2026-10-18 실측): /var/www 이하는 www-data(9999:9999), /var·/usr 이하는 root.
// 층의 상위 폴더 항목은 공식 폴더의 소유자를 덮어쓰므로 모든 항목을 이 값으로 맞춘다. 상류가 바꾸면 검증이 멈추고 사람이 본다
const WWW_DATA = 9999;

function ownedAsOfficial(path: string, entry: TarEntry): boolean {
  const owner = path === 'var/www' || path.startsWith('var/www/') ? WWW_DATA : 0;

  return entry.uid === owner && entry.gid === owner;
}

export interface Descriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
}

/** 층 하나의 문제(항목마다 첫 문제 하나) */
export function layerIssues(entries: readonly TarEntry[], allowed: readonly string[]): string[] {
  const issues: string[] = [];
  for (const entry of entries) {
    const path = entry.path.replace(/^\.\//, '');
    const segments = path.split('/').filter((segment) => segment !== '');
    const base = segments.at(-1) ?? '';
    if (segments.includes('..')) {
      issues.push(`${path}: 상위 폴더 경로`);
    } else if (base.startsWith('.wh.')) {
      issues.push(`${path}: 공식 파일을 지우는 항목(whiteout)`);
    } else if (entry.type === 'symlink' || entry.type === 'hardlink') {
      issues.push(`${path}: 링크`);
    } else if (entry.type === 'other') {
      issues.push(`${path}: 일반 파일·폴더가 아님`);
    } else if ((entry.mode & 0o6000) !== 0) {
      issues.push(`${path}: setuid·setgid 권한`);
    } else if ((entry.mode & 0o022) !== 0) {
      // 상위 폴더 항목도 공식 폴더의 권한을 덮어쓴다
      issues.push(`${path}: 그룹·모두 쓰기 권한`);
    } else if (!ownedAsOfficial(path, entry)) {
      issues.push(`${path}: 소유자 ${String(entry.uid)}:${String(entry.gid)}가 공식과 다름`);
    } else {
      const asDir = path.endsWith('/') ? path : `${path}/`;
      const inside = allowed.some((prefix) => (entry.type === 'dir' ? asDir : path).startsWith(prefix));
      const parent = entry.type === 'dir' && allowed.some((prefix) => prefix.startsWith(asDir));
      if (!inside && !parent) {
        issues.push(`${path}: 허용 경로 밖`);
      }
    }
  }

  return issues;
}

const descriptors = (value: unknown): Descriptor[] | undefined => {
  const layers = (value as { layers?: unknown } | null)?.layers;
  if (!Array.isArray(layers)) {
    return undefined;
  }

  return layers.flatMap((layer: unknown) => {
    const { mediaType, digest, size } = (layer ?? {}) as Record<string, unknown>;

    return typeof mediaType === 'string' && typeof digest === 'string' ? [{ mediaType, digest, size: typeof size === 'number' ? size : 0 }] : [];
  });
};

/** 공식 이미지 층 위에 더한 층 */
export function overlayLayers(ours: unknown, official: unknown): Descriptor[] {
  return (descriptors(ours) ?? []).slice((descriptors(official) ?? []).length);
}

interface IndexEntry {
  readonly digest: string;
  readonly platform: string;
  /** 출처 증명이면 그것이 가리키는 manifest 다이제스트 */
  readonly attests?: string;
}

/**
 * OCI index 항목. 출처 증명은 플랫폼이 정확히 unknown/unknown이고 그 표시가 있을 때만 출처 증명으로 본다:
 * 표시만 보고 건너뛰면 실제 플랫폼 manifest를 검사에서 숨길 수 있다(보안 검토 2026-10-18)
 */
function indexEntries(index: unknown): IndexEntry[] {
  const list = (index as { manifests?: unknown } | null)?.manifests;
  if (!Array.isArray(list)) {
    throw new Error('index.json에 manifests가 없습니다.');
  }

  return list.flatMap((item: unknown): IndexEntry[] => {
    const { digest, platform, annotations } = (item ?? {}) as { digest?: unknown; platform?: { os?: unknown; architecture?: unknown; variant?: unknown }; annotations?: Record<string, unknown> };
    if (typeof digest !== 'string') {
      return [];
    }
    const name = `${String(platform?.os)}/${String(platform?.architecture)}`;
    const target = annotations?.['vnd.docker.reference.digest'];
    if (name === 'unknown/unknown' && annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') {
      return [{ digest, platform: name, attests: typeof target === 'string' ? target : '' }];
    }

    return [{ digest, platform: name }];
  });
}

/** OCI index의 플랫폼별 manifest(출처 증명은 뺀다) */
export function platformManifests(index: unknown): { readonly platform: string; readonly digest: string }[] {
  return indexEntries(index).flatMap((entry) => (entry.attests === undefined ? [{ platform: entry.platform, digest: entry.digest }] : []));
}

// 공식과 같아야 하는 실행 설정(PaaS 호스트 계약과 같음). Labels는 우리 표기를 더해 다르다
const RUNTIME_KEYS = ['Entrypoint', 'Cmd', 'User', 'Env', 'WorkingDir', 'ExposedPorts', 'Volumes', 'StopSignal', 'Healthcheck', 'Shell', 'OnBuild', 'ArgsEscaped'] as const;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }

  return value;
}

/** 이미지 설정 비교: 실행 설정·플랫폼은 공식과 같고, 층(diff_ids)은 공식 층으로 시작해 더한 층이 있어야 한다 */
export function configIssues(ours: unknown, official: unknown): string[] {
  const read = (value: unknown): { config: Record<string, unknown>; platform: unknown[]; diffIds: unknown[] } => {
    const { config, architecture, os, variant, rootfs } = (value ?? {}) as Record<string, unknown>;
    const ids = (rootfs as { diff_ids?: unknown } | undefined)?.diff_ids;

    return { config: typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {}, platform: [architecture, os, variant], diffIds: Array.isArray(ids) ? ids : [] };
  };
  const a = read(ours);
  const b = read(official);
  const issues = RUNTIME_KEYS.filter((key) => !same(a.config[key], b.config[key])).map((key) => `실행 설정 ${key}가 공식과 다름`);
  // 라벨은 컨테이너에 붙어 traefik.* 등으로 동작을 바꿀 수 있다: 우리 표기(org.opencontainers.image.*) 밖은 공식과 같아야 한다
  const ourLabels = (a.config['Labels'] ?? {}) as Record<string, unknown>;
  const theirLabels = (b.config['Labels'] ?? {}) as Record<string, unknown>;
  const ownLabel = (key: string): boolean => key.startsWith('org.opencontainers.image.');
  const labelKeys = [...new Set([...Object.keys(ourLabels), ...Object.keys(theirLabels)])].filter((key) => !ownLabel(key));
  if (labelKeys.some((key) => ourLabels[key] !== theirLabels[key])) {
    issues.push('라벨이 공식과 다름(우리 표기 밖)');
  }
  if (!same(a.platform, b.platform)) {
    issues.push('플랫폼(architecture·os)이 공식과 다름');
  }
  if (b.diffIds.length === 0 || a.diffIds.length <= b.diffIds.length || b.diffIds.some((id, index) => a.diffIds[index] !== id)) {
    issues.push('rootfs 층이 공식 층으로 시작하지 않음');
  }

  return issues;
}

export function indexIssues(input: { readonly index: unknown; readonly manifests: ReadonlyMap<string, unknown>; readonly official: ReadonlyMap<Platform, unknown> }): string[] {
  const issues: string[] = [];
  const found = new Map<string, string>();
  const entries = indexEntries(input.index);
  for (const { platform, digest } of platformManifests(input.index)) {
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      issues.push(`${platform}는 내지 않는 플랫폼`);
    } else if (found.has(platform)) {
      issues.push(`${platform}가 두 번 있음`);
    } else {
      found.set(platform, digest);
    }
  }
  for (const platform of PLATFORMS) {
    const digest = found.get(platform);
    if (digest === undefined) {
      issues.push(`${platform} 없음`);
      continue;
    }
    const ours = descriptors(input.manifests.get(digest));
    const official = descriptors(input.official.get(platform));
    if (ours === undefined || official === undefined) {
      issues.push(`${platform}: manifest를 읽지 못함`);
      continue;
    }
    if (ours.length <= official.length) {
      issues.push(`${platform}: 공식 위에 더한 층이 없음`);
    } else if (official.some((layer, index) => ours[index]?.digest !== layer.digest)) {
      issues.push(`${platform}: 공식 이미지 층과 다름`);
    }
    for (const layer of ours) {
      if (!LAYER_TYPES.has(layer.mediaType)) {
        issues.push(`${platform}: 층 압축 형식 ${layer.mediaType}`);
      }
    }
  }
  const shipped = new Set(found.values());
  if (entries.some((entry) => entry.attests !== undefined && !shipped.has(entry.attests))) {
    issues.push('출처 증명이 우리 manifest가 아닌 곳을 가리킴');
  }

  return issues;
}

export interface ArchiveFacts {
  readonly index: string;
  readonly platforms: Readonly<Record<string, { readonly manifest: string; readonly config: string }>>;
  readonly ociSha256: string;
}

/**
 * manifest.json이 묶음 자체(index·플랫폼 manifest·설정·묶음 해시)와 그 커밋의 state.json(공식 이미지·버전)과 맞는지 본다.
 * 맞지 않으면 발행 뒤 pull 검증이 검증되지 않은 값과 비교하게 된다(최종 리뷰 2026-10-19)
 */
export function manifestIssues(manifest: unknown, facts: ArchiveFacts, expected: { readonly baseIndex: string; readonly version: string }): string[] {
  if (typeof manifest !== 'object' || manifest === null) {
    return ['manifest.json이 객체가 아님'];
  }
  const m = manifest as Record<string, unknown>;
  const issues: string[] = [];
  if (m['index'] !== facts.index) {
    issues.push('manifest.json의 index가 묶음과 다름');
  }
  if (!same(m['platforms'], facts.platforms)) {
    issues.push('manifest.json의 플랫폼 manifest·설정이 묶음과 다름');
  }
  if (m['ociSha256'] !== facts.ociSha256) {
    issues.push('manifest.json의 묶음 해시가 실제와 다름');
  }
  if (m['baseIndex'] !== expected.baseIndex) {
    issues.push('공식 이미지 다이제스트가 그 커밋의 state.json과 다름');
  }
  if (m['version'] !== expected.version) {
    issues.push('버전이 그 커밋의 state.json과 다름');
  }

  return issues;
}
