import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DIST_FILES, buildStatus, depsStatus, meetsNode, probeHub } from './launch-lib.mjs';

function tmpRoot() { return mkdtempSync(join(tmpdir(), 'crosstalk-launch-')); }
function touch(root, rel, secondsAgo) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'x');
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(p, t, t);
}
const makeDist = (root, secondsAgo) => DIST_FILES.forEach((f) => touch(root, f, secondsAgo));

test('meetsNode requires 22+', () => {
  assert.equal(meetsNode('v24.15.0'), true);
  assert.equal(meetsNode('22.0.0'), true);
  assert.equal(meetsNode('v20.20.0'), false);
  assert.equal(meetsNode('garbage'), false);
});

test('build needed when output is missing', () => {
  const root = tmpRoot();
  touch(root, 'src/a.ts', 10);
  const s = buildStatus(root);
  assert.equal(s.need, true);
  assert.match(s.reason, /missing build output/);
  rmSync(root, { recursive: true, force: true });
});

test('no rebuild when the build is newer than the sources, even if old', () => {
  const root = tmpRoot();
  touch(root, 'src/a.ts', 9999);
  touch(root, 'sidecar/x.ps1', 9999);
  touch(root, 'build.mjs', 9999);
  makeDist(root, 100);
  assert.equal(buildStatus(root).need, false);
  rmSync(root, { recursive: true, force: true });
});

test('rebuild when a source is newer than the build', () => {
  const root = tmpRoot();
  makeDist(root, 500);
  touch(root, 'src/deep/new.ts', 5);
  const s = buildStatus(root);
  assert.equal(s.need, true);
  assert.match(s.reason, /newer/);
  rmSync(root, { recursive: true, force: true });
});

test('node_modules and dist are ignored when looking for newer sources', () => {
  const root = tmpRoot();
  makeDist(root, 500);
  touch(root, 'src/node_modules/pkg/index.js', 1);
  assert.equal(buildStatus(root).need, false);
  rmSync(root, { recursive: true, force: true });
});

test('depsStatus: ws is always required, esbuild only when a build is needed', () => {
  const root = tmpRoot();
  assert.deepEqual(depsStatus(root, false).missing, ['ws']);
  assert.deepEqual(depsStatus(root, true).missing, ['ws', 'esbuild']);
  touch(root, 'node_modules/ws/package.json', 1);
  assert.equal(depsStatus(root, false).ok, true);
  assert.deepEqual(depsStatus(root, true).missing, ['esbuild']);
  touch(root, 'node_modules/esbuild/package.json', 1);
  assert.equal(depsStatus(root, true).ok, true);
  rmSync(root, { recursive: true, force: true });
});

function serve(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => res(s));
  });
}

test('probeHub recognises a CrossTalk hub', async () => {
  const s = await serve((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ app: 'crosstalk', extensionConnected: true, extensionPath: 'X' })); });
  const p = await probeHub(s.address().port);
  s.close();
  assert.equal(p.kind, 'relay');
  assert.equal(p.health.extensionConnected, true);
});

test('probeHub reports another application on the port', async () => {
  const s = await serve((_q, r) => r.end('hello, I am a different web app'));
  const p = await probeHub(s.address().port);
  s.close();
  assert.equal(p.kind, 'other');
  const s2 = await serve((_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"app":"something-else"}'); });
  assert.equal((await probeHub(s2.address().port)).kind, 'other');
  s2.close();
});

test('probeHub reports a free port', async () => {
  const s = await serve((_q, r) => r.end('x'));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  assert.equal((await probeHub(port)).kind, 'free');
});
