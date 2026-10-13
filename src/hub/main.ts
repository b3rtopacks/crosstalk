import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sidecar } from './sidecar.ts';
import { ExtensionLink } from './extension-link.ts';
import { ClaudeDesktopAdapter } from './adapters/claude-desktop.ts';
import { ChatGPTBrowserAdapter } from './adapters/chatgpt-browser.ts';
import { relayOnce } from './relay.ts';
import { AdapterError } from '../shared/types.ts';
import { RelayMachine, type Side } from '../core/machine.ts';
import { checkHopPolicy, SAFE_MAX_HOPS } from '../core/policy.ts';

const PORT = Number(process.env.CROSSTALK_PORT ?? 17321);
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(process.env.APPDATA ?? process.cwd(), 'crosstalk');
const LINK_FILE = join(DATA_DIR, 'link.json');

interface Link { claudeTitle: string; chatgptPath: string; chatgptTitle: string }
let link: Link | null = null;
try { if (existsSync(LINK_FILE)) link = JSON.parse(readFileSync(LINK_FILE, 'utf8')); } catch { link = null; }
interface Settings { highHopsConfirmed: boolean; lastMaxHops: number | null }
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
let settings: Settings = { highHopsConfirmed: false, lastMaxHops: null };
try { if (existsSync(SETTINGS_FILE)) settings = { ...settings, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* defaults */ }
function saveSettings(): void { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }

function saveLink(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  if (link) writeFileSync(LINK_FILE, JSON.stringify(link, null, 2)); else writeFileSync(LINK_FILE, 'null');
}

const log: { t: string; level: 'info' | 'error'; msg: string }[] = [];
function note(level: 'info' | 'error', msg: string): void {
  log.unshift({ t: new Date().toLocaleTimeString(), level, msg });
  log.length = Math.min(log.length, 60);
}

const sidecar = new Sidecar(join(HERE, 'sidecar', 'uia-sidecar.ps1'));
const server = createServer((req, res) => { handle(req, res).catch((e) => send(res, 500, { error: 'internal', detail: String(e) })); });
const ext = new ExtensionLink(server);
const claude = new ClaudeDesktopAdapter(sidecar);
const chatgpt = new ChatGPTBrowserAdapter(ext);
if (link) note('info', `Restored saved link: Claude "${link.claudeTitle}" ⇄ ChatGPT "${link.chatgptTitle}". Re-select the ChatGPT tab.`);

// Controlled automatic relay (one pair). Created by /api/auto/start from the current link; dropped when the link changes.
let machine: RelayMachine | null = null;
setInterval(() => { machine?.tick().catch(() => undefined); }, 2500).unref();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function errBody(e: unknown): { error: string; detail: string } {
  if (e instanceof AdapterError) return { error: e.code, detail: e.message };
  return { error: 'error', detail: e instanceof Error ? e.message : String(e) };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // DNS-rebinding guard: only answer for loopback hostnames.
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad-host' });
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(readFileSync(join(HERE, 'gui', 'index.html')));
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not-found' });
  // CSRF guard: a custom header forces a CORS preflight, which this server never grants.
  if (req.method === 'POST' && req.headers['x-relay'] !== '1') return send(res, 403, { error: 'missing-x-relay-header' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const [c, g, tabs] = await Promise.all([claude.getState(), chatgpt.getState(), chatgpt.listTargets().catch(() => [])]);
      const linkOk = link
        ? { claudeMatches: c.title === link.claudeTitle, chatgptMatches: g.conversationKey === link.chatgptPath }
        : null;
      return send(res, 200, { claude: c, chatgpt: g, tabs, selectedTab: chatgpt.selectedTabId, link, linkOk, log, extensionConnected: ext.connected, auto: machine?.snapshot() ?? null, settings: { defaultMaxHops: settings.lastMaxHops ?? SAFE_MAX_HOPS, safeMaxHops: SAFE_MAX_HOPS, highHopsConfirmed: settings.highHopsConfirmed } });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      // Cheap (no adapter calls): used by the launcher and the dashboard banner.
      return send(res, 200, { app: 'crosstalk', extensionConnected: ext.connected, extensionPath: join(HERE, '..', 'extension') });
    }
    if (req.method === 'GET' && url.pathname === '/api/auto/snapshot') {
      // Cheap (no adapter calls): lets the GUI show the auto-send countdown smoothly.
      return send(res, 200, { auto: machine?.snapshot() ?? null });
    }
    if (req.method === 'GET' && url.pathname === '/api/preview') {
      const side = url.searchParams.get('side');
      const a = side === 'claude' ? claude : chatgpt;
      return send(res, 200, await a.readLatest());
    }
    if (req.method === 'POST' && url.pathname === '/api/select-tab') {
      const b = await readBody(req);
      chatgpt.select(b.tabId == null ? null : String(b.tabId));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/link') {
      const [c, g] = await Promise.all([claude.getState(), chatgpt.getState()]);
      if (!c.ready || !c.title) throw new AdapterError('claude-not-ready', c.warning ?? 'Claude conversation not ready (open a Chat conversation, un-minimised)');
      if (!g.ready || !g.conversationKey) throw new AdapterError('chatgpt-not-ready', g.warning ?? 'Select a ChatGPT tab first');
      if (machine && machine.state !== 'NOT_STARTED') throw new AdapterError('auto-active', 'Reset the automatic relay before changing the link');
      machine = null;
      link = { claudeTitle: c.title, chatgptPath: g.conversationKey, chatgptTitle: g.title };
      saveLink();
      note('info', `Linked Claude "${c.title}" ⇄ ChatGPT "${g.title}"`);
      return send(res, 200, { ok: true, link });
    }
    if (req.method === 'POST' && url.pathname === '/api/unlink') {
      if (machine && machine.state !== 'NOT_STARTED') throw new AdapterError('auto-active', 'Reset the automatic relay before unlinking');
      machine = null; link = null; saveLink(); note('info', 'Link removed');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/relay') {
      const b = await readBody(req);
      const dir = b.direction;
      if (dir !== 'claude-to-chatgpt' && dir !== 'chatgpt-to-claude') throw new AdapterError('bad-direction', 'direction must be claude-to-chatgpt or chatgpt-to-claude');
      if (!link) throw new AdapterError('not-linked', 'Link a Claude conversation and a ChatGPT tab first');
      const [c, g] = await Promise.all([claude.getState(), chatgpt.getState()]);
      if (c.title !== link.claudeTitle) throw new AdapterError('link-mismatch', `Claude is showing "${c.title}" but the link is "${link.claudeTitle}". Re-link or switch conversation.`);
      if (g.conversationKey !== link.chatgptPath) throw new AdapterError('link-mismatch', `The ChatGPT tab is on ${g.conversationKey ?? 'no conversation'} but the link is ${link.chatgptPath}. Re-link or select the right tab.`);
      const [src, dst] = dir === 'claude-to-chatgpt' ? [claude, chatgpt] : [chatgpt, claude];
      try {
        const out = await relayOnce(src, dst, { overwrite: b.overwrite === true });
        note('info', `${dir}: inserted ${out.chars} chars (verified${out.exact ? ', exact' : ', whitespace-normalised'}). Not sent.`);
        return send(res, 200, { ok: true, ...out });
      } catch (e) {
        note('error', `${dir}: ${errBody(e).detail}`);
        throw e;
      }
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/auto/')) {
      const op = url.pathname.slice('/api/auto/'.length);
      if (op === 'start') {
        if (!link) throw new AdapterError('not-linked', 'Link a Claude conversation and a ChatGPT tab first');
        const b = await readBody(req);
        const next = b.next === 'claude' || b.next === 'chatgpt' ? (b.next as Side) : 'auto';
        // Safe default for a fresh install is 2 hops; an experienced user's last choice is kept (never silently reset).
        const maxHops = Number(b.maxHops) > 0 ? Math.floor(Number(b.maxHops)) : settings.lastMaxHops ?? SAFE_MAX_HOPS;
        const wantAuto = b.autoSend === true;
        const policy = checkHopPolicy({ autoSend: wantAuto, maxHops, alreadyConfirmed: settings.highHopsConfirmed, confirm: b.confirmHighHops === true });
        if (!policy.ok) throw new AdapterError('confirm-required', policy.message);
        if (policy.remember) { settings.highHopsConfirmed = true; note('info', `Confirmed: AUTO SEND with more than ${SAFE_MAX_HOPS} hops (remembered)`); }
        settings.lastMaxHops = maxHops; saveSettings();
        machine = new RelayMachine({ claude, chatgpt, link: { claudeTitle: link.claudeTitle, chatgptPath: link.chatgptPath }, log: note, maxHops });
        if (wantAuto) machine.setAutoSend(true, typeof b.delayMs === 'number' ? b.delayMs : undefined);
        note('info', `Start requested: AUTO SEND ${wantAuto ? 'ON' : 'OFF'}, MAX HOPS ${maxHops}`);
        return send(res, 200, await machine.start({ next, relayExisting: b.relayExisting === true }));
      }
      if (!machine) throw new AdapterError('not-started', 'Automatic relay is not started');
      if (op === 'pause') machine.pause('paused by you');
      else if (op === 'resume') machine.resume();
      else if (op === 'cancel') machine.cancelAuto();
      else if (op === 'set-auto-send') {
        const b = await readBody(req);
        const policy = checkHopPolicy({ autoSend: b.enabled === true, maxHops: machine.maxHops, alreadyConfirmed: settings.highHopsConfirmed, confirm: b.confirmHighHops === true });
        if (!policy.ok) throw new AdapterError('confirm-required', policy.message);
        if (policy.remember) { settings.highHopsConfirmed = true; saveSettings(); }
        machine.setAutoSend(b.enabled === true, typeof b.delayMs === 'number' ? b.delayMs : undefined);
      }
      else if (op === 'reset') machine.reset();
      else if (op === 'approve-send') return send(res, 200, await machine.approveSend());
      else throw new AdapterError('bad-op', 'unknown auto op');
      return send(res, 200, machine.snapshot());
    }
    if (req.method === 'POST' && url.pathname === '/api/clear') {
      // Operator cleanup of a test draft. Refused while the automatic relay holds a draft for you to send.
      const b = await readBody(req);
      if (machine && (machine.state === 'READY_TO_SEND_CLAUDE' || machine.state === 'READY_TO_SEND_CHATGPT')) throw new AdapterError('draft-pending', 'A draft is waiting to be sent; reset the relay first');
      await (b.side === 'claude' ? claude : chatgpt).clearComposer();
      note('info', `Cleared the ${b.side === 'claude' ? 'Claude' : 'ChatGPT'} composer`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not-found' });
  } catch (e) {
    const b = errBody(e);
    return send(res, b.error === 'internal' ? 500 : 409, b);
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CrossTalk hub: http://127.0.0.1:${PORT}/  (extension endpoint ws://127.0.0.1:${PORT}/ext)`);
});
process.on('SIGINT', () => { sidecar.stop(); process.exit(0); });
process.on('exit', () => sidecar.stop());
