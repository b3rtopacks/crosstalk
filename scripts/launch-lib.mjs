// Pure-ish helpers for the Windows launcher (kept separate so they can be unit-tested). No dependencies.
import http from 'node:http';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MIN_NODE_MAJOR = 22;
export const DEFAULT_PORT = 17321;

/** "v24.15.0" / "22.1.0" -> true if the major version is at least `min`. */
export function meetsNode(version, min = MIN_NODE_MAJOR) {
  const m = /^v?(\d+)\./.exec(String(version));
  return !!m && Number(m[1]) >= min;
}

/** Newest modification time (ms) of any file under `dir`, ignoring junk folders. 0 if none. */
export function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

/** Written by build.mjs when a build completes. Copied files keep their old timestamps, so only this stamp is reliable. */
export const BUILD_STAMP = 'dist/.built';
export const DIST_FILES = [
  'dist/hub/main.mjs',
  'dist/hub/gui/index.html',
  'dist/hub/sidecar/uia-sidecar.ps1',
  'dist/extension/manifest.json',
  'dist/extension/background.js',
  'dist/extension/content-chatgpt.js',
  BUILD_STAMP,
];
const SOURCES = ['src', 'sidecar', 'build.mjs'];

/** Decide whether `npm run build` is needed. Returns { need, reason }. Never "stale" just because it is old. */
export function buildStatus(root) {
  const missing = DIST_FILES.filter((f) => !existsSync(join(root, f)));
  if (missing.length) return { need: true, reason: `missing build output (${missing[0]}${missing.length > 1 ? ` +${missing.length - 1} more` : ''})` };
  const builtAt = statSync(join(root, BUILD_STAMP)).mtimeMs;
  let newestSrc = 0;
  for (const s of SOURCES) {
    const p = join(root, s);
    if (!existsSync(p)) continue;
    newestSrc = Math.max(newestSrc, statSync(p).isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newestSrc > builtAt ? { need: true, reason: 'sources are newer than the build' } : { need: false, reason: 'up to date' };
}

/** Which dependency folders are needed: runtime always needs `ws`; building needs `esbuild`. */
export function depsStatus(root, needBuild) {
  const has = (n) => existsSync(join(root, 'node_modules', n, 'package.json'));
  const missing = [];
  if (!has('ws')) missing.push('ws');
  if (needBuild && !has('esbuild')) missing.push('esbuild');
  return { missing, ok: missing.length === 0 };
}

export function isRelayHealth(j) {
  return !!j && typeof j === 'object' && j.app === 'crosstalk';
}

/**
 * Probe http://127.0.0.1:port/api/health.
 *  - { kind: 'relay', health }  a CrossTalk hub is answering
 *  - { kind: 'free' }           nothing is listening
 *  - { kind: 'other' }          something else owns the port (or answers with something that is not CrossTalk)
 */
export function probeHub(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(isRelayHealth(j) ? { kind: 'relay', health: j } : { kind: 'other' });
        } catch { resolve({ kind: 'other' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ kind: 'other' }); });
    req.on('error', (e) => resolve(e && e.code === 'ECONNREFUSED' ? { kind: 'free' } : { kind: 'other' }));
  });
}
