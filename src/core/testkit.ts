// Shared fakes for the relay machine tests (not part of the shipped build).
import { RelayMachine } from './machine.ts';
import { AdapterError, type AdapterState, type ConversationAdapter, type InsertResult, type LatestResponse, type SubmitResult, type Target } from '../shared/types.ts';

export class Fake implements ConversationAdapter {
  readonly surface = 'browser' as const;
  st: Partial<AdapterState> = {};
  latest = 'old reply';
  inserted: string[] = [];
  submitted: string[] = [];
  reads = 0;
  verified = true;
  insertThrows: Error | null = null;
  submitThrows: Error | null = null;
  /** Scripted successive readLatest() results (consumed first); then `latest`. */
  queue: string[] = [];
  constructor(readonly id: string, readonly provider: 'claude' | 'chatgpt', private title: string, private key: string) {}
  async listTargets(): Promise<Target[]> { return []; }
  select(): void {}
  async getState(): Promise<AdapterState> {
    return {
      connected: true, ready: true, title: this.title, conversationKey: this.key, generating: false, idle: true,
      composerBlank: true, sendEnabled: false, lastRole: 'assistant', turnCount: 2, ...this.st,
    };
  }
  async readLatest(): Promise<LatestResponse> {
    if (this.st.generating) throw new AdapterError('source-generating', 'generating');
    this.reads++;
    return { text: this.queue.length ? this.queue.shift()! : this.latest, title: this.title };
  }
  async insert(text: string): Promise<InsertResult> {
    if (this.insertThrows) throw this.insertThrows;
    this.inserted.push(text);
    this.st.composerBlank = false;
    return { verified: this.verified, exact: this.verified, wantedChars: text.length, readBackChars: text.length, sendEnabled: true };
  }
  async submit(expect: string): Promise<SubmitResult> {
    if (this.submitThrows) throw this.submitThrows;
    this.submitted.push(expect);
    this.st.composerBlank = true;
    this.st.turnCount = (this.st.turnCount ?? 2) + 1;
    this.st.lastRole = 'user';
    return { submitted: true };
  }
  async clearComposer(): Promise<void> { this.st.composerBlank = true; }
}

export function rig(maxHops?: number) {
  const claude = new Fake('claude-desktop', 'claude', 'Chat A', '');
  const chatgpt = new Fake('chatgpt-browser', 'chatgpt', 'GPT A', '/c/1');
  chatgpt.latest = 'old gpt reply';
  const logs: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timer = {
    set: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clear: (h: unknown) => { (h as { live: boolean }).live = false; },
    now: () => 1000,
  };
  const m = new RelayMachine({
    claude, chatgpt, link: { claudeTitle: 'Chat A', chatgptPath: '/c/1' }, log: (l, msg) => logs.push(`${l}: ${msg}`),
    maxHops, unknownTolerance: 1, timer, settleMs: 3, sleep: async () => undefined,
  });
  const liveTimers = () => timers.filter((t) => t.live);
  /** Fire the pending countdown and let the resulting async checks finish. */
  const fire = async () => {
    for (const t of liveTimers()) { t.live = false; t.fn(); }
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
  return { claude, chatgpt, m, logs, liveTimers, fire };
}

/** A NEW completed Claude reply appears. */
export function newClaudeReply(r: ReturnType<typeof rig>, text: string): void {
  r.claude.latest = text;
  r.claude.st = { ...r.claude.st, turnCount: (r.claude.st.turnCount ?? 2) + 2, lastRole: 'assistant', generating: false };
}
