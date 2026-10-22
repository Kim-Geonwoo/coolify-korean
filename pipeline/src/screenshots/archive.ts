const PINNED = /^(?:[^/]+\/)*([a-z0-9._-]+):([A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})$/;

/**
 * 다이제스트로 고정한 이미지를 HDD에 docker save 파일로 둘 때의 이름. docker load는 레지스트리 다이제스트를 되살리지 않으므로
 * 받은 직후 붙이는 로컬 태그로 실행·저장·불러오기를 한다. 태그와 파일 이름에 판과 다이제스트 앞 12자를 넣어 판이 바뀌면 새로 받는다
 */
export function imageArchive(ref: string): { readonly tag: string; readonly file: string } {
  const match = PINNED.exec(ref);
  if (match === null) {
    throw new Error(`다이제스트로 고정한 이미지가 아닙니다: ${ref}`);
  }
  const [, name = '', version = '', digest = ''] = match;
  const label = `${version}-${digest.slice(0, 12)}`;

  return { tag: `coolify-ko/${name}:${label}`, file: `${name}-${label}.tar` };
}
