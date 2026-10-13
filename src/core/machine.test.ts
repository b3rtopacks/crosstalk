import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError } from '../shared/types.ts';
import { rig, newClaudeReply } from './testkit.ts';

test('start baselines existing replies and relays nothing', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  await r.m.tick();
  assert.equal(r.m.state, 'WAITING_FOR_CLAUDE');
  assert.equal(r.chatgpt.inserted.length, 0);
});

test('successful Claude -> ChatGPT: detect, insert, wait for human send, then wait for ChatGPT', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  newClaudeReply(r, 'hello from claude');
  await r.m.tick();
  assert.equal(r.m.state, 'READY_TO_SEND_CHATGPT');
  assert.deepEqual(r.chatgpt.inserted, ['hello from claude']);
  assert.equal(r.chatgpt.submitted.length, 0, 'must not send by itself');
  assert.equal(r.m.hops, 1);
  await r.m.tick(); // still waiting for the human
  assert.equal(r.m.state, 'READY_TO_SEND_CHATGPT');
  assert.equal(r.chatgpt.submitted.length, 0);
  await r.m.approveSend();
  assert.deepEqual(r.chatgpt.submitted, ['hello from claude']);
  assert.equal(r.m.state, 'WAITING_FOR_CHATGPT');
  assert.equal(r.m.expected, 'chatgpt');
});

test('successful ChatGPT -> Claude after a full Claude -> ChatGPT hop (strict alternation)', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  newClaudeReply(r, 'q1');
  await r.m.tick();
  await r.m.approveSend();
  r.chatgpt.st = { ...r.chatgpt.st, generating: true, idle: false, lastRole: 'user' };
  await r.m.tick();
  assert.equal(r.m.state, 'CHATGPT_GENERATING');
  assert.equal(r.claude.inserted.length, 0, 'never relay while the source generates');
  r.chatgpt.latest = 'a1 from chatgpt';
  r.chatgpt.st = { ...r.chatgpt.st, generating: false, idle: true, lastRole: 'assistant', turnCount: 6 };
  await r.m.tick();
  assert.equal(r.m.state, 'READY_TO_SEND_CLAUDE');
  assert.deepEqual(r.claude.inserted, ['a1 from chatgpt']);
  assert.equal(r.claude.submitted.length, 0);
  await r.m.approveSend();
  assert.deepEqual(r.claude.submitted, ['a1 from chatgpt']);
  assert.equal(r.m.state, 'WAITING_FOR_CLAUDE');
  assert.equal(r.m.hops, 2);
});

test('duplicate response is rejected', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  newClaudeReply(r, 'dup');
  await r.m.tick();
  await r.m.approveSend();
  // ChatGPT answers; the answer is relayed to Claude and sent by the human.
  r.chatgpt.latest = 'gpt answer';
  r.chatgpt.st = { ...r.chatgpt.st, lastRole: 'assistant', turnCount: 9, generating: false };
  await r.m.tick();
  await r.m.approveSend();
  const before = r.chatgpt.inserted.length;
  newClaudeReply(r, 'dup'); // identical content to the reply that was already relayed
  await r.m.tick();
  assert.equal(r.chatgpt.inserted.length, before, 'duplicate must not be inserted again');
  assert.equal(r.m.state, 'WAITING_FOR_CLAUDE');
  assert.ok(r.logs.some((l) => l.includes('already relayed')));
});

test('wrong-side response is ignored', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  const readsBefore = r.chatgpt.reads;
  r.chatgpt.latest = 'unexpected chatgpt reply';
  r.chatgpt.st = { ...r.chatgpt.st, turnCount: 99, lastRole: 'assistant' };
  await r.m.tick();
  assert.equal(r.chatgpt.reads, readsBefore, 'the non-expected side is not even read');
  assert.equal(r.claude.inserted.length, 0);
  assert.equal(r.m.state, 'WAITING_FOR_CLAUDE');
  assert.equal(r.m.hops, 0);
});

test('source that is generating is never relayed', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  const readsBefore = r.claude.reads;
  r.claude.st = { ...r.claude.st, generating: true, idle: false, turnCount: 5, lastRole: 'assistant' };
  r.claude.latest = 'partial text';
  await r.m.tick();
  assert.equal(r.m.state, 'CLAUDE_GENERATING');
  assert.equal(r.chatgpt.inserted.length, 0);
  assert.equal(r.claude.reads, readsBefore, 'no read while generating');
});

test('hop limit pauses instead of relaying', async () => {
  const r = rig(1);
  await r.m.start({ next: 'claude' });
  newClaudeReply(r, 'one');
  await r.m.tick();
  await r.m.approveSend(); // hop 1 of 1
  r.chatgpt.latest = 'two';
  r.chatgpt.st = { ...r.chatgpt.st, lastRole: 'assistant', turnCount: 9, generating: false };
  await r.m.tick();
  assert.equal(r.m.state, 'PAUSED');
  assert.match(r.m.reason, /maximum hop count/);
  assert.equal(r.claude.inserted.length, 0);
  r.m.resume();
  assert.equal(r.m.state, 'PAUSED', 'cannot resume at the limit');
  r.m.setMaxHops(5);
  r.m.resume();
  assert.equal(r.m.state, 'WAITING_FOR_CHATGPT');
});

test('paused machine does nothing; resume continues', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  r.m.pause('operator');
  newClaudeReply(r, 'while paused');
  await r.m.tick();
  assert.equal(r.m.state, 'PAUSED');
  assert.equal(r.chatgpt.inserted.length, 0);
  r.m.resume();
  await r.m.tick();
  assert.equal(r.m.state, 'READY_TO_SEND_CHATGPT');
  assert.deepEqual(r.chatgpt.inserted, ['while paused']);
});

test('destination composer with user text: stop and require intervention, never overwrite', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  r.chatgpt.st = { ...r.chatgpt.st, composerBlank: false };
  newClaudeReply(r, 'will not be inserted');
  await r.m.tick();
  assert.equal(r.m.state, 'USER_INTERVENTION_REQUIRED');
  assert.equal(r.chatgpt.inserted.length, 0);
  assert.equal(r.m.hops, 0);
});

test('conversation identity change pauses', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  (r.claude as unknown as { title: string }).title = 'Some Other Chat';
  newClaudeReply(r, 'from the wrong conversation');
  await r.m.tick();
  assert.equal(r.m.state, 'PAUSED');
  assert.match(r.m.reason, /identity changed/);
  assert.equal(r.chatgpt.inserted.length, 0);
});

test('destination identity change pauses before any write', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  (r.chatgpt as unknown as { key: string }).key = '/c/other';
  newClaudeReply(r, 'x');
  await r.m.tick();
  assert.equal(r.m.state, 'PAUSED');
  assert.equal(r.chatgpt.inserted.length, 0);
});

test('write verification failure stops with ERROR and does not mark the reply as relayed', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  r.chatgpt.verified = false;
  newClaudeReply(r, 'unverifiable');
  await r.m.tick();
  assert.equal(r.m.state, 'ERROR');
  assert.equal(r.m.hops, 0);
  assert.equal(r.m.pending, null);
  await r.m.tick(); // stays stopped
  assert.equal(r.m.state, 'ERROR');
});

test('unknown adapter state pauses', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  r.claude.st = { ...r.claude.st, ready: false, warning: 'minimised' };
  await r.m.tick();
  assert.equal(r.m.state, 'PAUSED');
  assert.match(r.m.reason, /state unknown/);
});

test('approveSend is refused unless a draft is ready, and never auto-sends', async () => {
  const r = rig();
  await r.m.start({ next: 'claude' });
  await assert.rejects(() => r.m.approveSend(), /Nothing to send/);
  assert.equal(r.claude.submitted.length + r.chatgpt.submitted.length, 0);
});

test('auto start: both idle and ambiguous asks the user instead of guessing', async () => {
  const r = rig();
  await r.m.start({ next: 'auto' });
  assert.equal(r.m.state, 'USER_INTERVENTION_REQUIRED');
});

test('auto start picks the side that is generating', async () => {
  const r = rig();
  r.claude.st = { generating: true, idle: false, lastRole: 'user' };
  await r.m.start({ next: 'auto' });
  assert.equal(r.m.expected, 'claude');
  assert.equal(r.m.state, 'WAITING_FOR_CLAUDE');
});
