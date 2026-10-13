// Provider-agnostic contract between the relay core and the adapters (browser or desktop).
// submit() presses Send and is only ever called from RelayMachine.approveSend() (a human click).

export type Provider = 'claude' | 'chatgpt';
export type Surface = 'desktop' | 'browser';

export interface Target {
  id: string;
  label: string;
  /** Stable-ish identity hint (URL path for browser tabs, window title for desktop). */
  identity?: string;
}

export interface AdapterState {
  /** Transport is up (sidecar running / extension connected). */
  connected: boolean;
  /** A conversation is attached and its UI is readable. */
  ready: boolean;
  /** Conversation title as the UI reports it ('' when unavailable, e.g. minimised). */
  title: string;
  /** Stable conversation key when the surface exposes one (ChatGPT: URL path). */
  conversationKey?: string;
  generating: boolean;
  /** Safe to read a completed reply from: not generating, and a finished assistant reply exists or none is pending. */
  idle: boolean;
  composerBlank: boolean | null;
  sendEnabled: boolean | null;
  /** Adapter-specific problem the user should see (minimised, no composer, ...). */
  /** Role of the newest conversation turn, when the surface exposes it. */
  lastRole?: 'user' | 'assistant' | null;
  /** Number of visible turns; with lastRole forms a cheap change signature. */
  turnCount?: number;
  warning?: string;
  detail?: Record<string, unknown>;
}

export interface SubmitResult {
  submitted: boolean;
}

export interface LatestResponse {
  text: string;
  title: string;
}

export interface InsertResult {
  verified: boolean;
  exact: boolean;
  wantedChars: number;
  readBackChars: number;
  sendEnabled: boolean | null;
}

export class AdapterError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface ConversationAdapter {
  readonly id: string;
  readonly provider: Provider;
  readonly surface: Surface;
  listTargets(): Promise<Target[]>;
  /** Choose which conversation this adapter operates on (browser: tab id; desktop: the single window). */
  select(targetId: string | null): void;
  getState(): Promise<AdapterState>;
  /** Newest COMPLETED assistant reply. Throws AdapterError if generating or none exists. */
  readLatest(): Promise<LatestResponse>;
  /** Put text in the composer and verify by read-back. Never submits. */
  insert(text: string, opts: { overwrite: boolean }): Promise<InsertResult>;
  /** Press Send. Refuses unless the composer still holds exactly `expectText` (whitespace-normalised). */
  submit(expectText: string): Promise<SubmitResult>;
  /** Empty the composer (used for operator cleanup only). */
  clearComposer(): Promise<void>;
}

/** Hub <-> extension protocol (JSON over WebSocket). */
export interface ExtRequest {
  id: number;
  op: 'tabs' | 'state' | 'read' | 'insert' | 'submit' | 'clear';
  tabId?: number;
  text?: string;
  overwrite?: boolean;
  expectText?: string;
}
export type ExtResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; detail?: string };

/** Content-script <-> service-worker messages (ChatGPT page adapter). */
export interface PageState {
  title: string;
  path: string;
  composerFound: boolean;
  composerBlank: boolean | null;
  sendEnabled: boolean | null;
  stopPresent: boolean;
  generating: boolean;
  turnCount: number;
  lastAssistantComplete: boolean | null;
  lastTurnRole: 'user' | 'assistant' | null;
  idle: boolean;
  hidden: boolean;
}
