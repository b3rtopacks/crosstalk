// Builds the portable Windows release: release/CrossTalk Portable/ and release/CrossTalk-<version>-win-x64.zip
//   npm run package                (downloads the official Node build matching this Node, verifies its SHA-256)
//   npm run package -- --local-node (use the Node that is running this script instead of downloading)
// The package needs NO Node, npm or node_modules on the target PC: the hub and its only dependency (ws) are bundled,
// and the official node.exe ships in runtime/. Nothing is written to the registry; no admin rights are needed.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const NAME = 'CrossTalk Portable';
const OUT = join('release', NAME);
const ZIP = join('release', `CrossTalk-${pkg.version}-win-x64.zip`);
const useLocalNode = process.argv.includes('--local-node');
// Windows' own bsdtar (reads/writes ZIP); a Git-for-Windows GNU tar earlier on PATH cannot.
const TAR = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
const log = (m) => console.log(`[package] ${m}`);
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('This packaging script targets Windows x64 and must run on Windows x64.');
  process.exit(1);
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed (${r.status})`); process.exit(1); }
}

// 1. Fresh build of the extension, GUI and sidecar (the same build the dev launcher uses).
log('building');
sh(process.execPath, ['build.mjs']);

// 2. Clean staging area.
rmSync(OUT, { recursive: true, force: true });
rmSync(ZIP, { force: true });
for (const d of ['app/hub', 'app/extension', 'runtime']) mkdirSync(join(OUT, d), { recursive: true });

// 3. Hub: one self-contained ESM file (our code + ws). Only the optional native accelerators stay external; ws
//    loads them inside try/catch and falls back to plain JS when absent.
log('bundling the hub (ws included)');
await build({
  entryPoints: ['src/hub/main.ts'], outfile: join(OUT, 'app/hub/main.mjs'), bundle: true, platform: 'node', format: 'esm',
  target: 'node22', external: ['bufferutil', 'utf-8-validate'], legalComments: 'inline',
  banner: { js: "import { createRequire as __crossTalkCreateRequire } from 'node:module'; const require = __crossTalkCreateRequire(import.meta.url);" },
});
cpSync('dist/hub/gui', join(OUT, 'app/hub/gui'), { recursive: true });
cpSync('dist/hub/sidecar', join(OUT, 'app/hub/sidecar'), { recursive: true });
cpSync('dist/extension', join(OUT, 'app/extension'), { recursive: true });
cpSync('scripts/launch.mjs', join(OUT, 'app/launch.mjs'));
cpSync('scripts/launch-lib.mjs', join(OUT, 'app/launch-lib.mjs'));

// 4. Node runtime: the official Windows x64 build (MIT; its LICENSE file lists the bundled third-party notices).
const v = process.version;
let nodeLicense;
if (useLocalNode) {
  log(`using the local Node ${v} (${process.execPath})`);
  cpSync(process.execPath, join(OUT, 'runtime/node.exe'));
  const lic = join(dirname(process.execPath), 'LICENSE');
  if (!existsSync(lic)) { console.error('No LICENSE next to the local node.exe; run without --local-node to use the official zip.'); process.exit(1); }
  nodeLicense = readFileSync(lic);
} else {
  const zipName = `node-${v}-win-x64.zip`;
  const cache = join('release', '.cache');
  const zipPath = join(cache, zipName);
  mkdirSync(cache, { recursive: true });
  const base = `https://nodejs.org/dist/${v}`;
  log(`fetching checksums from ${base}/SHASUMS256.txt`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = (sums.split('\n').find((l) => l.endsWith(`  ${zipName}`)) ?? '').split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expected)) { console.error(`No checksum for ${zipName} on nodejs.org`); process.exit(1); }
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  if (!existsSync(zipPath) || sha(zipPath) !== expected) {
    log(`downloading ${zipName}`);
    const res = await fetch(`${base}/${zipName}`);
    if (!res.ok) { console.error(`Download failed: HTTP ${res.status}`); process.exit(1); }
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  if (sha(zipPath) !== expected) { console.error('SHA-256 mismatch for the Node download; refusing to package it.'); process.exit(1); }
  log(`SHA-256 verified (${expected.slice(0, 16)}...)`);
  const tmp = join(cache, 'extract');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const inner = `node-${v}-win-x64`;
  sh(TAR, ['-xf', zipPath, '-C', tmp, `${inner}/node.exe`, `${inner}/LICENSE`]);
  cpSync(join(tmp, inner, 'node.exe'), join(OUT, 'runtime/node.exe'));
  nodeLicense = readFileSync(join(tmp, inner, 'LICENSE'));
}
writeFileSync(join(OUT, 'runtime/LICENSE-node.txt'), nodeLicense);

// 5. Licences and notices.
cpSync('LICENSE', join(OUT, 'LICENSE'));
const wsPkg = JSON.parse(readFileSync('node_modules/ws/package.json', 'utf8'));
writeFileSync(join(OUT, 'THIRD-PARTY-NOTICES.txt'), [
  'CrossTalk Portable bundles the following third-party software.',
  '',
  `1. Node.js ${v} (runtime/node.exe) - MIT licence, with its own bundled third-party notices.`,
  '   Full text: runtime/LICENSE-node.txt (unmodified from the official Node.js distribution).',
  '   Source and official builds: https://nodejs.org/',
  '',
  `2. ws ${wsPkg.version} (bundled into app/hub/main.mjs) - MIT licence.`,
  '   https://github.com/websockets/ws',
  '',
  '--- ws LICENSE ---',
  readFileSync('node_modules/ws/LICENSE', 'utf8').trim(),
  '',
  'CrossTalk itself is MIT licensed: see LICENSE.',
  '',
].join('\r\n'));

// 6. Launcher + readme for end users.
cpSync('scripts/portable/Start CrossTalk.cmd', join(OUT, 'Start CrossTalk.cmd'));
cpSync('scripts/portable/README.txt', join(OUT, 'README.txt'));
writeFileSync(join(OUT, 'app/BUILD-INFO.txt'), `CrossTalk ${pkg.version}\r\nNode ${v}\r\nbuilt ${new Date().toISOString()}\r\n`);

// 7. ZIP (bsdtar ships with Windows 10/11; produces standard forward-slash entries).
log('creating the ZIP');
sh(TAR, ['-a', '-c', '-f', ZIP, '-C', 'release', NAME]);
log(`done: ${OUT}  (${mb(statSync(join(OUT, 'runtime/node.exe')).size)} node.exe)`);
log(`ZIP:  ${ZIP}  (${mb(statSync(ZIP).size)})`);
