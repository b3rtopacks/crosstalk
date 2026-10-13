import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHopPolicy, SAFE_MAX_HOPS } from './policy.ts';
import { diffInfo, fingerprint } from '../shared/text.ts';
import { rig, newClaudeReply } from './testkit.ts';

/** AUTO SEND ON, new Claude reply 'auto reply' inserted into ChatGPT, countdown armed. */
async function armed(maxHops?: number) {
  const r = rig(maxHops ?? 5);
  await r.m.start({ next: 'claude' });
  r.m.setAutoSend(true, 2000);
  newClaudeReply(r, 'auto reply');
  await r.m.tick();
  assert.equal(r.m.state, 'READY_TO_SEND_CHATGPT');
  return r;
}

test('default max hops is 2', () => {
  assert.equal(SAFE_MAX_HOPS, 2);
  assert.equal(rig().m.maxHops, 2);
});

test('first re-read differs, two settled stable reads match -> sends, with diagnostics logged', async () => {
  const r = await armed();
  r.claude.queue = ['auto repl (transient)', 'auto reply', 'auto reply'];
  await r.fire();
  assert.deepEqual(r.chatgpt.submitted, ['auto reply']);
  assert.equal(r.m.state, 'WAITING_FOR_CHATGPT');
  assert.ok(r.logs.some((l) => l.includes('AUTO SEND diagnostics (first re-read differs; settling)')));
  assert.ok(r.logs.some((l) => l.includes('settled reads are stable and match')));
});

test('first and settled reads both differ -> pause, nothing sent, diagnostics kept', async () => {
  const r = await armed();
  r.claude.queue = ['auto reply CHANGED', 'auto reply CHANGED', 'auto reply CHANGED'];
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'PAUSED');
  assert.match(r.m.reason, /genuinely differs/);
  assert.ok(r.logs.some((l) => l.includes('stable but differ from the inserted reply')));
});

test('settled reads that do not agree with each other -> pause', async () => {
  const r = await armed();
  r.claude.queue = ['x', 'auto reply', 'auto reply, edited'];
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'PAUSED');
  assert.match(r.m.reason, /still changing/);
});

test('whitespace-only differences are normalised away and do not block or even trigger diagnostics', async () => {
  const r = rig(5);
  await r.m.start({ next: 'claude' });
  r.m.setAutoSend(true, 2000);
  newClaudeReply(r, 'first paragraph\n\nsecond paragraph');
  await r.m.tick();
  r.claude.queue = ['first paragraph second\nparagraph']; // same characters, different joining/layout
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 1);
  assert.ok(!r.logs.some((l) => l.includes('diagnostics')));
});

test('a meaningful content difference still blocks (one character)', async () => {
  const r = await armed();
  r.claude.queue = ['auto repIy', 'auto repIy', 'auto repIy']; // l -> I
  await r.fire();
  assert.equal(r.chatgpt.submitted.length, 0);
  assert.equal(r.m.state, 'PAUSED');
});

test('diagnostics contain both SHA-256 hashes, both lengths and the first differing position', async () => {
  const r = await armed();
  r.claude.queue = ['auto reXly', 'auto reXly', 'auto reXly'];
  await r.fire();
  const line = r.logs.find((l) => l.includes('diagnostics (first re-read differs'))!;
  assert.ok(line, 'diagnostic line present');
  assert.ok(line.includes(`original=${fingerprint('auto reply')}`));
  assert.ok(line.includes(`reread=${fingerprint('auto reXly')}`));
  assert.match(line, /length 10 -> 10/);
  assert.match(line, /raw@7 canonical@6/);
  assert.match(line, /whitespaceOnly=false/);
  assert.match(line, /claude\/browser -> chatgpt\/browser/);
  assert.match(line, /source generating=false/);
  assert.match(line, /destination generating=false/);
  assert.ok(line.includes('original="') && line.includes('reread="'));
});

test('diffInfo reports whitespace-only differences and escapes context', () => {
  const d = diffInfo('a\n\nb', 'a b');
  assert.equal(d.same, false);
  assert.equal(d.whitespaceOnly, true);
  assert.equal(d.canonicalIndex, -1);
  const e = diffInfo('x\ny', 'x\nz');
  assert.equal(e.whitespaceOnly, false);
  assert.ok(!e.contextA.includes('\n'), 'context is escaped');
});

test('hop policy: fresh run with AUTO SEND and more than 2 hops needs confirmation', () => {
  const ask = checkHopPolicy({ autoSend: true, maxHops: 20, alreadyConfirmed: false, confirm: false });
  assert.equal(ask.ok, false);
  assert.equal(ask.requiresConfirmation, true);
  const yes = checkHopPolicy({ autoSend: true, maxHops: 20, alreadyConfirmed: false, confirm: true });
  assert.equal(yes.ok, true);
  assert.equal(yes.remember, true);
});

test('hop policy: no confirmation for 2 hops, for manual send, or once the user has confirmed before', () => {
  assert.equal(checkHopPolicy({ autoSend: true, maxHops: 2, alreadyConfirmed: false, confirm: false }).ok, true);
  assert.equal(checkHopPolicy({ autoSend: false, maxHops: 50, alreadyConfirmed: false, confirm: false }).ok, true);
  const exp = checkHopPolicy({ autoSend: true, maxHops: 50, alreadyConfirmed: true, confirm: false });
  assert.equal(exp.ok, true);
  assert.equal(exp.requiresConfirmation, false);
});
