import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError } from '../shared/types.ts';
import { rig, newClaudeReply } from './testkit.ts';

/** Auto send ON, a new Claude reply detected and inserted -> countdown armed. */
async function armed(maxHops?: number) {
  const r = rig(maxHops);
  await r.m.start({ next: 'claude' });
  r.m.setAutoSend(true, 2000);
  newClaudeReply(r, 'auto reply');
  await r.m.tick();
  return r;
}

test('auto send is OFF by default and never sends on its own', async () => {
  const r = rig();
  assert.equal(r.m.autoSend, false);
  await r.m.start({ next: 'claude' });
  newClaudeReply(r, 'manual only');
  await r.m.tick();
  assert.equal(r.m.state, 'READY_TO_SEND_CHATGPT');
  assert.equal(r.liveTimers().length, 0);
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
});

test('auto send ON: countdown, then submits the verified draft and waits for the other side', async () => {
  const r = await armed();
  assert.equal(r.m.state, 'READY_TO_SEND_CHATGPT');
  assert.equal(r.liveTimers().length, 1);
  assert.equal(r.liveTimers()[0].ms, 2000);
  assert.ok(r.m.snapshot().countdownEndsAt !== null);
  assert.equal(r.chatgpt.submitted.length, 0, 'not before the countdown ends');
  await r.fire();
  assert.deepEqual(r.chatgpt.submitted, ['auto reply']);
  assert.equal(r.m.state, 'WAITING_FOR_CHATGPT');
  assert.ok(r.logs.some((l) => l.includes('AUTO SEND: sending to ChatGPT in 2.0s')));
  assert.ok(r.logs.some((l) => l.includes('AUTO SEND: submitted to ChatGPT')));
});

test('cancel during the countdown leaves the draft for a manual send', async () => {
  const r = await armed();
  r.m.cancelAuto();
  assert.equal(r.liveTimers().length, 0);
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'READY_TO_SEND_CHATGPT');
  assert.ok(r.logs.some((l) => l.includes('cancelled')));
  await r.m.tick();
  assert.equal(r.liveTimers().length, 0, 'does not re-arm');
  await r.m.approveSend(); // the manual send still works
  assert.deepEqual(r.chatgpt.submitted, ['auto reply']);
});

test('pause during the countdown always wins', async () => {
  const r = await armed();
  r.m.pause('emergency');
  assert.equal(r.liveTimers().length, 0);
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'PAUSED');
});

test('switching auto send off during the countdown cancels it', async () => {
  const r = await armed();
  r.m.setAutoSend(false);
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'READY_TO_SEND_CHATGPT');
});

test('blocked and paused: destination no longer idle', async () => {
  const r = await armed();
  r.chatgpt.st = { ...r.chatgpt.st, idle: false };
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'PAUSED');
  assert.match(r.m.reason, /not idle/);
  assert.ok(r.logs.some((l) => l.includes('AUTO SEND blocked')));
});

test('blocked and paused: draft changed (adapter refuses the exact-text check)', async () => {
  const r = await armed();
  r.chatgpt.submitThrows = new AdapterError('draft-changed', 'draft no longer matches');
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'PAUSED', 'paused, not ERROR');
  assert.match(r.m.reason, /draft no longer matches/);
});

test('blocked and paused: draft removed from the destination composer', async () => {
  const r = await armed();
  r.chatgpt.st = { ...r.chatgpt.st, composerBlank: true };
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'PAUSED');
});

test('blocked and paused: conversation identity changed', async () => {
  const r = await armed();
  (r.chatgpt as unknown as { key: string }).key = '/c/elsewhere';
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'PAUSED');
  assert.match(r.m.reason, /identity changed/);
});

test('blocked and paused: source reply changed, or source generating again', async () => {
  const a = await armed();
  a.claude.latest = 'something else now';
  await a.fire();
  assert.equal(a.chatgpt.submitted.length, 0);
  assert.equal(a.m.state, 'PAUSED');
  const b = await armed();
  b.claude.st = { ...b.claude.st, generating: true, idle: false };
  await b.fire();
  assert.equal(b.chatgpt.submitted.length, 0);
  assert.equal(b.m.state, 'PAUSED');
});

test('toggling auto send ON does not auto-send a draft that is already waiting', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  newClaudeReply(r, 'waiting draft');
  await r.m.tick();
  r.m.setAutoSend(true);
  assert.equal(r.liveTimers().length, 0);
  await r.m.tick();
  assert.equal(r.liveTimers().length, 0);
  assert.equal(r.chatgpt.submitted.length, 0);
});

test('hop limit still applies in auto mode', async () => {
  const r = await armed(1);
  await r.fire(); // hop 1 of 1 is sent
  assert.equal(r.chatgpt.submitted.length, 1);
  r.chatgpt.latest = 'gpt answer';
  r.chatgpt.st = { ...r.chatgpt.st, lastRole: 'assistant', turnCount: 9, generating: false };
  await r.m.tick();
  assert.equal(r.m.state, 'PAUSED');
  assert.match(r.m.reason, /maximum hop count/);
  assert.equal(r.claude.inserted.length, 0);
});

test('no countdown or send from error states', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  r.m.setAutoSend(true);
  r.chatgpt.verified = false;
  newClaudeReply(r, 'will fail');
  await r.m.tick();
  assert.equal(r.m.state, 'ERROR');
  assert.equal(r.liveTimers().length, 0);
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
});
