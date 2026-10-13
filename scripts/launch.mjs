// CrossTalk launcher (Windows). Started by "Start CrossTalk.cmd". Plain Node, no dependencies.
//   1. checks Node 22+   2. asks before installing dependencies   3. builds only when needed
//   4. starts the hub (or attaches to one that is already running)   5. opens the dashboard
//   6. reports whether the browser extension is connected
// It never touches relay behaviour; it only starts/stops the hub process it started itself.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, MIN_NODE_MAJOR, buildStatus, depsStatus, meetsNode, probeHub } from './launch-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
// Portable release layout: this file sits in app/ next to hub/main.mjs (already bundled; no npm, no build).
const PORTABLE = existsSync(join(HERE, 'hub', 'main.mjs'));
const HUB_MAIN = PORTABLE ? join(HERE, 'hub', 'main.mjs') : join(ROOT, 'dist', 'hub', 'main.mjs');
const PORT = Number(process.env.CROSSTALK_PORT ?? DEFAULT_PORT);
const URL_ = `http://127.0.0.1:${PORT}/`;
const args = new Set(process.argv.slice(2));
const OPEN = !args.has('--no-open');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m = '') => console.log(m);
const fail = (m) => { console.error(`\n  ERROR: ${m}\n`); process.exit(1); };

/** Ask a question on the console. End of input (no answer) counts as "no". */
function ask(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('close', () => { if (!answered) res(''); });
    rl.question(question, (a) => { answered = true; rl.close(); res(a.trim()); });
  });
}

/** Run a command with live output; resolves with the exit code. */
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
    p.on('error', () => res(-1));
    p.on('exit', (code) => res(code ?? -1));
  });
}

function openBrowser(url) {
  // `start` hands the URL to the user's default browser.
  execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => undefined);
}

function extensionHelp(extPath) {
  say('  The CrossTalk browser extension is NOT connected. In Chrome or Edge:');
  say('    1. open chrome://extensions  (or edge://extensions)');
  say('    2. turn on Developer mode');
  say(`    3. Load unpacked  ->  ${extPath}`);
  say('       (if it is already installed, press its Reload button)');
  say('    4. keep Chrome / Edge running');
}

async function main() {
  say('');
  say('  CrossTalk');
  say('  --------');

  // 1. Node version
  if (!meetsNode(process.versions.node)) {
    say(`  Node.js ${MIN_NODE_MAJOR} or newer is required (this is ${process.versions.node}).`);
    say('  Install the current LTS release from https://nodejs.org/ and run this launcher again.');
    process.exit(1);
  }
  say(`  Node ${process.versions.node}  OK`);

  // 2. Is CrossTalk already running (or is the port taken by something else)?
  const existing = await probeHub(PORT);
  if (existing.kind === 'other') {
    fail(`Port ${PORT} is in use by another application (not CrossTalk). Close that application, or set CROSSTALK_PORT to a different port. Nothing was stopped.`);
  }
  if (existing.kind === 'relay') {
    say(`  CrossTalk is already running on port ${PORT}. Attaching to it (closing this window will NOT stop it).`);
    if (OPEN) openBrowser(URL_);
    say(`  Dashboard: ${URL_}`);
    await watchExtension(existing.health.extensionPath);
    return;
  }

  // 3. Build status and dependencies
  let build = PORTABLE ? { need: false, reason: 'prebuilt' } : buildStatus(ROOT);
  const deps = PORTABLE ? { ok: true, missing: [] } : depsStatus(ROOT, build.need);
  if (!deps.ok) {
    say('');
    say('  CrossTalk needs to install its local dependencies before first use.');
    say(`  Missing: ${deps.missing.join(', ')}   (runs "npm install" in ${ROOT})`);
    const answer = await ask('  Install them now? [Y/N] ');
    if (!/^y(es)?$/i.test(answer)) {
      say('');
      say('  Not installed. CrossTalk cannot start without its dependencies.');
      say('  To install manually, open a terminal in this folder and run:  npm install');
      process.exit(1);
    }
    say('');
    say('  Installing dependencies (this can take a minute)...');
    // Run npm's own CLI with this Node (no shell); fall back to cmd.exe if it is not where a standard install puts it.
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const code = existsSync(npmCli)
      ? await run(process.execPath, [npmCli, 'install'])
      : await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install']);
    if (code !== 0) {
      fail(`"npm install" failed (exit code ${code}). Check your internet connection and that npm works ("npm --version"), then try again. CrossTalk was not started.`);
    }
    say('  Dependencies installed.');
    build = buildStatus(ROOT);
  }

  if (build.need) {
    say(`  Building CrossTalk (${build.reason})...`);
    const code = await run(process.execPath, ['build.mjs']);
    if (code !== 0) fail(`The build failed (exit code ${code}). See the messages above. CrossTalk was not started.`);
    say('  Build finished.');
  } else {
    say(PORTABLE ? '  Portable build: nothing to install or build.' : '  Build is up to date.');
  }

  // 4. Start the hub
  say('  Starting the hub...');
  const hub = spawn(process.execPath, [HUB_MAIN], { cwd: ROOT, stdio: ['ignore', 'inherit', 'pipe'] });
  let stderr = '';
  hub.stderr.on('data', (d) => { stderr += d; if (!/EADDRINUSE/.test(stderr)) process.stderr.write(d); });
  let exited = null;
  hub.on('exit', (code) => { exited = code ?? -1; });

  let stopping = false;
  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    say(`\n  ${why} Stopping the hub...`);
    if (exited === null) hub.kill();
    for (let i = 0; i < 40 && exited === null; i++) await sleep(100);
    if (exited === null) hub.kill('SIGKILL');
    say('  CrossTalk stopped.');
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { void shutdown(`Received ${sig}.`); });

  let health = null;
  for (let i = 0; i < 60 && health === null; i++) {
    if (exited !== null) break;
    const p = await probeHub(PORT, 800);
    if (p.kind === 'relay') health = p.health;
    else await sleep(250);
  }
  if (health === null) {
    if (/EADDRINUSE/.test(stderr)) fail(`Port ${PORT} is in use by another application. Nothing was stopped. Close that application, or set CROSSTALK_PORT to a different port.`);
    fail(exited !== null ? `The hub exited immediately (code ${exited}).${stderr ? `\n${stderr}` : ''}` : 'The hub did not become ready within 15 seconds.');
  }
  // Ctrl+C / closing the window reaches the hub and this launcher at the same moment: give our own signal handler a
  // beat to mark the stop as intentional before treating the hub's exit as a crash.
  hub.on('exit', (code) => {
    setTimeout(() => { if (!stopping) { say(`\n  The hub stopped unexpectedly (code ${code}).`); process.exit(1); } }, 700);
  });

  say(`  Hub running. Dashboard: ${URL_}`);
  say('  Press Ctrl+C (or close this window) to stop CrossTalk.');
  if (OPEN) openBrowser(URL_);
  await watchExtension(health.extensionPath);
}

/** Print extension connection changes until the process is stopped. */
async function watchExtension(extPath) {
  let last = null;
  let since = Date.now();
  let lastHelp = 0;
  for (;;) {
    const p = await probeHub(PORT, 1500);
    const connected = p.kind === 'relay' ? p.health.extensionConnected === true : null;
    if (p.kind !== 'relay') {
      if (last !== 'gone') { say('\n  The CrossTalk hub is no longer responding.'); last = 'gone'; }
    } else if (connected !== last) {
      last = connected;
      since = Date.now();
      say(connected ? '\n  Browser extension: CONNECTED' : '\n  Browser extension: NOT CONNECTED (waiting; it can take up to 30 seconds to reconnect)');
      lastHelp = Date.now();
    } else if (!connected && Date.now() - since > 35000 && Date.now() - lastHelp > 60000) {
      say('');
      extensionHelp(p.health.extensionPath ?? extPath);
      lastHelp = Date.now();
    }
    await sleep(2000);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
