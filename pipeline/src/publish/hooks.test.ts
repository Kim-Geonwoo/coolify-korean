import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchHookFiles, hookFingerprint, hookIssues, type HookFiles } from './hooks.ts';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const files: HookFiles = { constants: fixture('constants.php'), upgrade: fixture('upgrade.sh'), composeProd: fixture('docker-compose.prod.yml') };

describe('hookIssues', () => {
  it('finds every hook in the 4.4.6 files', () => {
    expect(hookIssues(files)).toEqual([]);
  });

  it.each([
    ['VERSIONS_URL removed from constants.php', { ...files, constants: files.constants.replace("env('VERSIONS_URL',", "env('UPDATES_URL',") }],
    ['custom.yml dropped from the upgrade', { ...files, upgrade: files.upgrade.replaceAll('docker-compose.custom.yml', 'docker-compose.extra.yml') }],
    ['the version argument no longer reaching LATEST_IMAGE', { ...files, upgrade: files.upgrade.replace('LATEST_IMAGE=${1:-latest}', 'LATEST_IMAGE=latest') }],
    ['the official image moved to another registry path', { ...files, composeProd: files.composeProd.replace('${REGISTRY_URL:-docker.io}/coollabsio/coolify:${LATEST_IMAGE:-latest}', 'ghcr.io/coollabsio/coolify:latest') }],
    ['the .env no longer passed to the container', { ...files, composeProd: files.composeProd.replace(/env_file:\s*\n\s*- \/data\/coolify\/source\/\.env/, 'env_file: []') }],
  ])('reports %s', (_label, changed) => {
    expect(hookIssues(changed)).toHaveLength(1);
  });

  it('reports when LATEST_IMAGE is no longer handed to docker compose', () => {
    const changed = { ...files, upgrade: files.upgrade.replaceAll('LATEST_IMAGE=${LATEST_IMAGE} docker compose', 'docker compose').replaceAll('LATEST_IMAGE=\\${LATEST_IMAGE} docker compose', 'docker compose') };

    expect(hookIssues(changed)).toHaveLength(1);
  });
});

describe('hookFingerprint', () => {
  it('ignores comment-only edits', () => {
    const commented = { ...files, upgrade: files.upgrade.replace('# LATEST_IMAGE env var is needed for image substitution in compose files', '# reworded comment about LATEST_IMAGE and docker compose') };

    expect(hookFingerprint(commented)).toBe(hookFingerprint(files));
  });

  it('changes when a hook line changes', () => {
    const moved = { ...files, upgrade: files.upgrade.replace('COMPOSE_FILES="$COMPOSE_FILES -f /data/coolify/source/docker-compose.custom.yml"', 'COMPOSE_FILES="-f /data/coolify/source/docker-compose.custom.yml $COMPOSE_FILES"') };

    expect(hookFingerprint(moved)).not.toBe(hookFingerprint(files));
  });
});

describe('fetchHookFiles', () => {
  const ok = (body: string): Response => new Response(body, { status: 200 });

  it('reads the tagged constants and the current CDN scripts', async () => {
    const seen: string[] = [];
    const got = await fetchHookFiles('4.4.6', (url) => {
      seen.push(url);

      return Promise.resolve(ok(url));
    });

    expect(seen).toEqual(['https://raw.githubusercontent.com/coollabsio/coolify/v4.4.6/config/constants.php', 'https://cdn.coollabs.io/coolify/upgrade.sh', 'https://cdn.coollabs.io/coolify/docker-compose.prod.yml']);
    expect(got.upgrade).toBe('https://cdn.coollabs.io/coolify/upgrade.sh');
  });

  it('fails on an error status instead of judging an error page', async () => {
    await expect(fetchHookFiles('4.4.6', () => Promise.resolve(new Response('nope', { status: 503 })))).rejects.toThrow();
  });

  it('refuses an oversized response', async () => {
    await expect(fetchHookFiles('4.4.6', () => Promise.resolve(ok('x'.repeat(1024 * 1024 + 1))))).rejects.toThrow();
  });

  it('refuses a version that is not x.y.z', async () => {
    await expect(fetchHookFiles('4.4.6/../main', () => Promise.resolve(ok('')))).rejects.toThrow();
  });
});
