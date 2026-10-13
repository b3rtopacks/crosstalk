// Controlled automatic relay: one linked Claude <-> ChatGPT pair.
// Detection and transfer are automatic; the final Send is ALWAYS a human click (approveSend).
// Pure logic over ConversationAdapter so it is unit-testable with fakes. Never guesses: anything unexpected
// pauses, errors or asks for intervention.

import { AdapterError, type AdapterState, type ConversationAdapter } from '../shared/types.ts';
import { diffInfo, fingerprint } from '../shared/text.ts';
import { SAFE_MAX_HOPS } from './policy.ts';

export type Side = 'claude' | 'chatgpt';

export type StateName =
  | 'NOT_STARTED'
  | 'WAITING_FOR_CLAUDE' | 'CLAUDE_GENERATING' | 'CLAUDE_COMPLETE' | 'INSERTING_INTO_CHATGPT' | 'READY_TO_SEND_CHATGPT'
  | 'WAITING_FOR_CHATGPT' | 'CHATGPT_GENERATING' | 'CHATGPT_COMPLETE' | 'INSERTING_INTO_CLAUDE' | 'READY_TO_SEND_CLAUDE'
  | 'PAUSED' | 'ERROR' | 'USER_INTERVENTION_REQUIRED';

export interface LinkIdentity {
  /** Claude Desktop conversation title (Chat or Code). */
  claudeTitle: string;
  /** ChatGPT conversation URL path. */
  chatgptPath: string;
}

export interface MachineDeps {
  claude: ConversationAdapter;
  chatgpt: ConversationAdapter;
  link: LinkIdentity;
  log: (level: 'info' | 'error', msg: string) => void;
  maxHops?: number;
  /** Consecutive "state unknown" ticks tolerated before pausing (transient UIA hiccups). */
  unknownTolerance?: number;
  /** Pause before re-reading a source reply that changed since insertion (default 900 ms). */
  settleMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock/timers (tests). Defaults to Date.now / setTimeout. */
  timer?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void; now(): number };
}

export interface Pending { from: Side; to: Side; fingerprint: string; text: string; sigAtInsert: string }

export interface Snapshot {
  state: StateName;
  expected: Side | null;
  hops: number;
  maxHops: number;
  reason: string;
  pending: { from: Side; to: Side; chars: number; fingerprint: string; preview: string } | null;
  seenCount: number;
  lastFingerprint: string | null;
  autoSend: boolean;
  autoSendDelayMs: number;
  /** Epoch ms when a pending automatic send will fire, or null. */
  countdownEndsAt: number | null;
}

const other = (s: Side): Side => (s === 'claude' ? 'chatgpt' : 'claude');
const WAITING: Record<Side, StateName> = { claude: 'WAITING_FOR_CLAUDE', chatgpt: 'WAITING_FOR_CHATGPT' };
const GENERATING: Record<Side, StateName> = { claude: 'CLAUDE_GENERATING', chatgpt: 'CHATGPT_GENERATING' };
const COMPLETE: Record<Side, StateName> = { claude: 'CLAUDE_COMPLETE', chatgpt: 'CHATGPT_COMPLETE' };
const INSERTING: Record<Side, StateName> = { claude: 'INSERTING_INTO_CLAUDE', chatgpt: 'INSERTING_INTO_CHATGPT' };
const READY: Record<Side, StateName> = { claude: 'READY_TO_SEND_CLAUDE', chatgpt: 'READY_TO_SEND_CHATGPT' };
const label = (s: Side): string => (s === 'claude' ? 'Claude' : 'ChatGPT');
const sigOf = (st: AdapterState): string => `${st.turnCount ?? '?'}:${st.lastRole ?? '?'}`;

export class RelayMachine {
  state: StateName = 'NOT_STARTED';
  expected: Side | null = null;
  hops = 0;
  maxHops: number;
  reason = '';
  pending: Pending | null = null;
  lastFingerprint: string | null = null;
  private seen = new Set<string>();
  private lastSig: Record<Side, string | null> = { claude: null, chatgpt: null };
  private sawGenerating: Record<Side, boolean> = { claude: false, chatgpt: false };
  autoSend = false;
  autoSendDelayMs = 2000;
  private countdown: { endsAt: number; handle: unknown } | null = null;
  private autoCancelled = false;
  private unknown = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private ticking = false;

  constructor(private d: MachineDeps) {
    this.maxHops = d.maxHops ?? SAFE_MAX_HOPS;
  }

  private adapter(s: Side): ConversationAdapter { return s === 'claude' ? this.d.claude : this.d.chatgpt; }
  private log(msg: string, level: 'info' | 'error' = 'info'): void { this.d.log(level, msg); }
  private enter(s: StateName): void { if (this.state !== s) { this.state = s; } }

  snapshot(): Snapshot {
    return {
      state: this.state, expected: this.expected, hops: this.hops, maxHops: this.maxHops, reason: this.reason,
      pending: this.pending ? { from: this.pending.from, to: this.pending.to, chars: this.pending.text.length, fingerprint: this.pending.fingerprint, preview: this.pending.text.slice(0, 400) } : null,
      seenCount: this.seen.size, lastFingerprint: this.lastFingerprint,
      autoSend: this.autoSend, autoSendDelayMs: this.autoSendDelayMs, countdownEndsAt: this.countdown?.endsAt ?? null,
    };
  }

  setMaxHops(n: number): void { if (Number.isInteger(n) && n > 0) this.maxHops = n; }

  // ---- identity / readiness checks -------------------------------------------------------------------------
  private known(st: AdapterState): boolean { return st.connected && st.ready; }

  private sameConversation(side: Side, st: AdapterState): boolean {
    return side === 'claude' ? st.title === this.d.link.claudeTitle : st.conversationKey === this.d.link.chatgptPath;
  }

  /** Returns the state if it is usable; otherwise pauses/counts and returns null. */
  private async checked(side: Side, opts: { tolerant: boolean }): Promise<AdapterState | null> {
    const st = await this.adapter(side).getState();
    if (!this.known(st)) {
      this.unknown++;
      if (!opts.tolerant || this.unknown >= (this.d.unknownTolerance ?? 3)) this.pause(`${label(side)} state unknown: ${st.warning ?? 'not ready'}`);
      return null;
    }
    this.unknown = 0;
    if (!this.sameConversation(side, st)) {
      this.pause(`${label(side)} conversation identity changed (expected ${side === 'claude' ? this.d.link.claudeTitle : this.d.link.chatgptPath}, found ${side === 'claude' ? st.title || '(none)' : st.conversationKey ?? '(none)'})`);
      return null;
    }
    return st;
  }

  // ---- operator controls -----------------------------------------------------------------------------------
  pause(reason: string): void {
    this.clearCountdown();
    this.autoCancelled = true;
    if (this.state === 'NOT_STARTED' || this.state === 'PAUSED') return;
    this.state = 'PAUSED';
    this.reason = reason;
    this.log(`PAUSED: ${reason}`, 'error');
  }

  private intervene(reason: string): void {
    this.clearCountdown();
    this.autoCancelled = true;
    this.state = 'USER_INTERVENTION_REQUIRED';
    this.reason = reason;
    this.log(`USER INTERVENTION REQUIRED: ${reason}`, 'error');
  }

  private fail(e: unknown): void {
    this.clearCountdown();
    this.autoCancelled = true;
    const msg = e instanceof Error ? e.message : String(e);
    this.state = 'ERROR';
    this.reason = msg;
    this.log(`ERROR (stopped): ${msg}`, 'error');
  }

  resume(): void {
    if (this.state !== 'PAUSED' && this.state !== 'ERROR' && this.state !== 'USER_INTERVENTION_REQUIRED') return;
    if (this.hops >= this.maxHops) {
      this.log(`Cannot resume: hop limit ${this.maxHops} reached; raise it or reset`, 'error');
      return;
    }
    this.unknown = 0;
    this.reason = '';
    if (this.pending) this.enter(READY[this.pending.to]);
    else if (this.expected) { this.lastSig[this.expected] = null; this.enter(WAITING[this.expected]); }
    else this.state = 'NOT_STARTED';
    this.log(`Resumed -> ${this.state}`);
  }

  reset(): void {
    this.clearCountdown();
    this.state = 'NOT_STARTED';
    this.expected = null;
    this.hops = 0;
    this.reason = '';
    this.pending = null;
    this.lastFingerprint = null;
    this.seen.clear();
    this.lastSig = { claude: null, chatgpt: null };
    this.sawGenerating = { claude: false, chatgpt: false };
    this.unknown = 0;
    this.log('Reset');
  }

  /**
   * Decide who speaks next, baseline everything currently on screen as "already seen" (never relay what merely
   * exists), then begin watching. next='auto' decides from live state and asks the user if it cannot be determined.
   */
  async start(opts: { next?: Side | 'auto'; relayExisting?: boolean } = {}): Promise<Snapshot> {
    return this.serial(async () => {
      if (this.state !== 'NOT_STARTED') throw new AdapterError('already-started', `Already ${this.state}; reset first`);
      const states: Partial<Record<Side, AdapterState>> = {};
      for (const side of ['claude', 'chatgpt'] as Side[]) {
        const st = await this.adapter(side).getState();
        if (!this.known(st)) throw new AdapterError('not-ready', `${label(side)}: ${st.warning ?? 'not ready'}`);
        if (!this.sameConversation(side, st)) throw new AdapterError('identity-mismatch', `${label(side)} is not showing the linked conversation`);
        states[side] = st;
      }
      const c = states.claude!, g = states.chatgpt!;
      let next: Side | null = opts.next && opts.next !== 'auto' ? opts.next : null;
      if (!next) {
        if (c.generating && g.generating) { this.beginIntervention('Both sides are generating; cannot tell who speaks next'); return this.snapshot(); }
        if (c.generating) next = 'claude';
        else if (g.generating) next = 'chatgpt';
        else if (c.lastRole === 'user' && g.lastRole !== 'user') next = 'claude';
        else if (g.lastRole === 'user' && c.lastRole !== 'user') next = 'chatgpt';
      }
      // Baseline: whatever each idle side already ended on is "seen" (unless the user asked to relay it).
      for (const side of ['claude', 'chatgpt'] as Side[]) {
        const st = states[side]!;
        this.lastSig[side] = sigOf(st);
        if (st.idle && st.lastRole === 'assistant' && !(opts.relayExisting && side === next)) {
          try {
            const latest = await this.adapter(side).readLatest();
            this.seen.add(fingerprint(latest.text));
          } catch { /* nothing readable to baseline */ }
        }
      }
      if (opts.relayExisting && next) this.lastSig[next] = null;
      this.hops = 0;
      this.reason = '';
      if (!next) {
        this.beginIntervention('Both sides are idle and it is not clear who speaks next. Start again choosing Claude or ChatGPT.');
        return this.snapshot();
      }
      this.expected = next;
      this.enter(WAITING[next]);
      this.log(`Started: waiting for ${label(next)} (baseline: ${this.seen.size} existing repl${this.seen.size === 1 ? 'y' : 'ies'} ignored)`);
      return this.snapshot();
    });
  }

  private beginIntervention(reason: string): void {
    this.state = 'USER_INTERVENTION_REQUIRED';
    this.reason = reason;
    this.expected = null;
    this.log(`USER INTERVENTION REQUIRED: ${reason}`, 'error');
  }

  // ---- the polling step --------------------------------------------------------------------------------------
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** One monitoring step. Never throws; skips if the previous step is still running. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.serial(() => this.tickInner()); } finally { this.ticking = false; }
  }

  private async tickInner(): Promise<void> {
    const s = this.state;
    if (s === 'NOT_STARTED' || s === 'PAUSED' || s === 'ERROR' || s === 'USER_INTERVENTION_REQUIRED') return;
    try {
      if (s === 'READY_TO_SEND_CLAUDE' || s === 'READY_TO_SEND_CHATGPT') await this.watchReady();
      else await this.watchSource();
    } catch (e) {
      this.fail(e);
    }
  }

  private async watchSource(): Promise<void> {
    const side = this.expected!;
    const st = await this.checked(side, { tolerant: true });
    if (!st) return;
    if (st.generating) {
      this.enter(GENERATING[side]);
      this.sawGenerating[side] = true;
      return;
    }
    this.enter(WAITING[side]);
    const sig = sigOf(st);
    if (!this.sawGenerating[side] && sig === this.lastSig[side]) return; // nothing changed since last look
    if (st.lastRole !== 'assistant') {
      // The newest turn is not an assistant reply (user message pending, or nothing yet): keep waiting.
      this.lastSig[side] = sig;
      return;
    }
    let latest;
    try {
      latest = await this.adapter(side).readLatest();
    } catch (e) {
      const code = e instanceof AdapterError ? e.code : '';
      if (code === 'source-generating' || code === 'unstable-response' || code === 'no-completed-response') return; // retry next tick
      throw e;
    }
    const fp = fingerprint(latest.text);
    this.lastSig[side] = sig;
    this.sawGenerating[side] = false;
    if (this.seen.has(fp)) {
      this.log(`Ignored ${label(side)} reply ${fp.slice(0, 8)}: already relayed or baseline`);
      return;
    }
    this.enter(COMPLETE[side]);
    this.lastFingerprint = fp;
    if (this.hops >= this.maxHops) {
      this.pause(`maximum hop count (${this.maxHops}) reached`);
      return;
    }
    await this.insertInto(other(side), side, latest.text, fp, sig);
  }

  private async insertInto(dest: Side, from: Side, text: string, fp: string, sig: string): Promise<void> {
    this.enter(INSERTING[dest]);
    const ds = await this.checked(dest, { tolerant: false });
    if (!ds) return;
    if (ds.generating) return this.intervene(`${label(dest)} is generating although ${label(from)} just replied (alternation violated)`);
    if (ds.composerBlank !== true) return this.intervene(`${label(dest)} composer already contains text; not overwriting it`);
    let res;
    try {
      res = await this.adapter(dest).insert(text, { overwrite: false });
    } catch (e) {
      if (e instanceof AdapterError && e.code === 'composer-not-empty') return this.intervene(`${label(dest)} composer already contains text; not overwriting it`);
      throw e;
    }
    if (!res.verified) throw new AdapterError('verify-failed', `Inserted text could not be verified in ${label(dest)}`);
    this.seen.add(fp);
    this.hops++;
    this.pending = { from, to: dest, fingerprint: fp, text, sigAtInsert: sigOf(ds) };
    this.autoCancelled = false;
    this.enter(READY[dest]);
    this.log(`${label(from)} reply ${fp.slice(0, 8)} (${text.length} chars) inserted into ${label(dest)} and verified. Hop ${this.hops}/${this.maxHops}. ${this.autoSend ? 'AUTO SEND is ON.' : 'Waiting for you to send.'}`);
    this.armAuto();
  }

  private async watchReady(): Promise<void> {
    const p = this.pending!;
    const ds = await this.checked(p.to, { tolerant: true });
    if (!ds) return;
    if (!(await this.checked(p.from, { tolerant: true }))) return;
    if (ds.generating) {
      this.log(`${label(p.to)} started generating by itself: treating the draft as sent by you`);
      return this.afterSent(p.to);
    }
    if (ds.composerBlank === true) {
      if (sigOf(ds) !== p.sigAtInsert) {
        this.log(`${label(p.to)} draft was sent manually`);
        return this.afterSent(p.to);
      }
      this.intervene(`The inserted draft disappeared from the ${label(p.to)} composer before it was sent`);
    }
  }

  /** The human clicked SEND. Re-verifies identity and the draft, presses Send, then waits for the reply. */
  async approveSend(): Promise<Snapshot> {
    return this.serial(async () => {
      if (this.state !== 'READY_TO_SEND_CLAUDE' && this.state !== 'READY_TO_SEND_CHATGPT') {
        throw new AdapterError('not-ready-to-send', `Nothing to send in state ${this.state}`);
      }
      const p = this.pending!;
      this.clearCountdown();
      try {
        const ds = await this.checked(p.to, { tolerant: false });
        if (!ds) throw new AdapterError('paused', this.reason);
        if (!(await this.checked(p.from, { tolerant: false }))) throw new AdapterError('paused', this.reason);
        if (ds.generating) { this.intervene(`${label(p.to)} is generating; not sending`); throw new AdapterError('intervention', this.reason); }
        if (ds.composerBlank === true) { this.intervene(`The draft is no longer in the ${label(p.to)} composer`); throw new AdapterError('intervention', this.reason); }
        await this.adapter(p.to).submit(p.text);
      } catch (e) {
        if (e instanceof AdapterError && (e.code === 'paused' || e.code === 'intervention')) throw e;
        this.fail(e);
        throw e;
      }
      this.afterSent(p.to);
      return this.snapshot();
    });
  }

  // ---- optional automatic submission (default OFF) -----------------------------------------------------------
  private now(): number { return (this.d.timer?.now ?? Date.now)(); }

  setAutoSend(on: boolean, delayMs?: number): void {
    if (delayMs !== undefined && Number.isFinite(delayMs) && delayMs >= 0) this.autoSendDelayMs = delayMs;
    if (on === this.autoSend) return;
    this.autoSend = on;
    this.log(on ? `AUTO SEND switched ON (countdown ${this.autoSendDelayMs} ms). A draft already waiting is not auto-sent.` : 'AUTO SEND switched OFF');
    if (!on) this.clearCountdown('AUTO SEND switched off');
    else if (this.pending) this.autoCancelled = true; // only drafts inserted after switching on are auto-sent
  }

  /** Cancel a running countdown; the draft stays in place for a manual send. */
  cancelAuto(): void {
    if (!this.countdown) return;
    this.clearCountdown('Auto-send cancelled by you; draft stays for a manual send');
    this.autoCancelled = true;
  }

  private clearCountdown(why?: string): void {
    if (!this.countdown) return;
    (this.d.timer?.clear ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout)))(this.countdown.handle);
    this.countdown = null;
    if (why) this.log(why);
  }

  private armAuto(): void {
    if (!this.autoSend || !this.pending || this.autoCancelled || this.countdown) return;
    const endsAt = this.now() + this.autoSendDelayMs;
    const set = this.d.timer?.set ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const handle = set(() => {
      this.countdown = null;
      void this.serial(() => this.autoSendNow()).catch(() => undefined);
    }, this.autoSendDelayMs);
    this.countdown = { endsAt, handle };
    this.log(`AUTO SEND: sending to ${label(this.pending.to)} in ${(this.autoSendDelayMs / 1000).toFixed(1)}s (Cancel or Pause to stop)`);
  }

  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private describeState(st: AdapterState): string {
    return `generating=${st.generating} idle=${st.idle} lastRole=${st.lastRole ?? '?'} turns=${st.turnCount ?? '?'} composerBlank=${st.composerBlank}`;
  }

  private logDiff(what: string, p: Pending, a: string, b: string, ss: AdapterState, ds: AdapterState): void {
    const src = this.adapter(p.from), dst = this.adapter(p.to);
    const d = diffInfo(a, b);
    this.log(
      `AUTO SEND diagnostics (${what}) [${src.provider}/${src.surface} -> ${dst.provider}/${dst.surface}] ` +
      `sha256 original=${fingerprint(a)} reread=${fingerprint(b)} | length ${d.lengthA} -> ${d.lengthB} | ` +
      `first diff raw@${d.rawIndex} canonical@${d.canonicalIndex} whitespaceOnly=${d.whitespaceOnly} | ` +
      `context original="${d.contextA}" reread="${d.contextB}" | source ${this.describeState(ss)} | destination ${this.describeState(ds)}`,
      'error',
    );
  }

  /**
   * The source reply must still be the one that was inserted. On a mismatch: log full diagnostics, settle, then require
   * two consecutive identical reads that also match the original. Returns a reason to block, or null to proceed.
   * Never weakened: if the settled reads still differ, or are not stable, nothing is sent.
   */
  private async verifySource(p: Pending, ss: AdapterState, ds: AdapterState): Promise<string | null> {
    const src = this.adapter(p.from);
    const read = async (): Promise<string> => (await src.readLatest()).text;
    let first: string;
    try { first = await read(); } catch (e) { return `could not re-verify the source reply (${e instanceof Error ? e.message : String(e)})`; }
    if (this.lastFingerprint === p.fingerprint && fingerprint(first) === p.fingerprint) return null;

    this.logDiff('first re-read differs; settling', p, p.text, first, ss, ds);
    const settle = this.d.settleMs ?? 900;
    await this.sleep(settle);
    let a: string, b: string;
    try {
      a = await read();
      await this.sleep(Math.max(1, Math.floor(settle / 3)));
      b = await read();
    } catch (e) { return `could not re-verify the source reply after settling (${e instanceof Error ? e.message : String(e)})`; }
    if (fingerprint(a) !== fingerprint(b)) {
      this.logDiff('settled reads differ from each other', p, a, b, ss, ds);
      return 'the source reply is still changing (two settled reads differ)';
    }
    if (fingerprint(a) !== p.fingerprint) {
      this.logDiff('settled reads are stable but differ from the inserted reply', p, p.text, a, ss, ds);
      return 'the source reply genuinely differs from the one that was inserted';
    }
    this.log(`AUTO SEND: settled reads are stable and match the inserted reply (${p.fingerprint.slice(0, 8)}); continuing`);
    return null;
  }

  /** Every check must pass or we pause without sending. */
  private async autoSendNow(): Promise<void> {
    if ((this.state !== 'READY_TO_SEND_CLAUDE' && this.state !== 'READY_TO_SEND_CHATGPT') || !this.pending) return;
    const p = this.pending;
    const block = (reason: string): void => {
      this.log(`AUTO SEND blocked: ${reason}`, 'error');
      if (this.state !== 'PAUSED') this.pause(`auto-send blocked: ${reason}`);
    };
    try {
      if (!this.autoSend) return;
      if (this.hops > this.maxHops) return block('hop limit exceeded');
      const ds = await this.checked(p.to, { tolerant: false });   // identity + readiness; pauses with its own reason
      if (!ds) return;
      const ss = await this.checked(p.from, { tolerant: false });
      if (!ss) return;
      if (ds.generating || !ds.idle) return block(`${label(p.to)} is not idle`);
      if (ds.composerBlank === true) return block(`the draft is no longer in the ${label(p.to)} composer`);
      if (ss.generating) return block(`${label(p.from)} is generating again`);
      const sourceProblem = await this.verifySource(p, ss, ds);
      if (sourceProblem) return block(sourceProblem);
      if (this.state !== READY[p.to]) return;   // paused/cancelled while checking: never send
      this.log(`AUTO SEND: submitting to ${label(p.to)}`);
      await this.adapter(p.to).submit(p.text);  // also verifies atomically that the draft is exactly the relay text
      this.log(`AUTO SEND: submitted to ${label(p.to)}`);
      this.afterSent(p.to);
    } catch (e) {
      block(e instanceof Error ? e.message : String(e));
    }
  }

  private afterSent(dest: Side): void {
    this.pending = null;
    this.expected = dest;
    this.sawGenerating[dest] = true; // a reply is now due; do not treat the pre-send state as "unchanged"
    this.lastSig[dest] = null;
    this.enter(WAITING[dest]);
    this.log(`Sent to ${label(dest)}. Waiting for ${label(dest)}'s reply.`);
  }
}
