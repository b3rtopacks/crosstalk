// MV3 service worker: keeps a loopback WebSocket to the local hub and relays requests to ChatGPT tabs.
// No data leaves the machine; the only network endpoint is ws://127.0.0.1.

import type { ExtRequest } from '../shared/types.ts';

const HUB_URL = 'ws://127.0.0.1:17321/ext';
let ws: WebSocket | null = null;

function connect(): void {
  if (ws && ws.readyState <= 1) return;
  try { ws = new WebSocket(HUB_URL); } catch { return; }
  ws.onmessage = (ev) => { void onHubMessage(String(ev.data)); };
  ws.onclose = () => { ws = null; };
  ws.onerror = () => { /* onclose follows; the alarm retries */ };
}

function reply(id: number, body: { ok: true; result: unknown } | { ok: false; error: string; detail?: string }): void {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ id, ...body }));
}

async function onHubMessage(raw: string): Promise<void> {
  let req: ExtRequest;
  try { req = JSON.parse(raw); } catch { return; }
  if (typeof req.id !== 'number') return; // hub keepalive ping
  try {
    if (req.op === 'tabs') {
      const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      return reply(req.id, { ok: true, result: tabs.map((t) => ({ tabId: t.id, title: t.title ?? '', path: safePath(t.url), active: !!t.active, windowId: t.windowId })) });
    }
    if (req.tabId == null) return reply(req.id, { ok: false, error: 'no-tab', detail: 'tabId required' });
    const res = await toTab(req.tabId, { op: req.op, text: req.text, overwrite: req.overwrite, expectText: req.expectText });
    if (res.ok) reply(req.id, { ok: true, result: res.result });
    else reply(req.id, { ok: false, error: res.error, detail: res.detail });
  } catch (e) {
    reply(req.id, { ok: false, error: 'extension-error', detail: e instanceof Error ? e.message : String(e) });
  }
}

function safePath(url?: string): string {
  try { return new URL(url ?? '').pathname; } catch { return ''; }
}

type TabReply = { ok: true; result: unknown } | { ok: false; error: string; detail?: string };

async function toTab(tabId: number, msg: unknown): Promise<TabReply> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Content script missing (tab opened before the extension loaded/reloaded): inject once and retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-chatgpt.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'reconnect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
