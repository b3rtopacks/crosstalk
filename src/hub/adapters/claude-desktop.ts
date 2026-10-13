import { AdapterError, type AdapterState, type ConversationAdapter, type InsertResult, type LatestResponse, type SubmitResult, type Target } from '../../shared/types.ts';
import type { Sidecar } from '../sidecar.ts';

interface SidecarState {
  title: string; mode: 'chat' | 'code' | 'unknown'; minimised: boolean; foreground: boolean; composerFound: boolean;
  composerBlank: boolean | null; composerAction: string; sendEnabled: boolean | null; generating: boolean;
  unitCount: number; lastRole: string; idle: boolean;
}

/** Claude Desktop (Electron/Chromium) driven through Windows UI Automation. Handles Chat and Code modes. */
export class ClaudeDesktopAdapter implements ConversationAdapter {
  readonly id = 'claude-desktop';
  readonly provider = 'claude' as const;
  readonly surface = 'desktop' as const;

  constructor(private sidecar: Sidecar) {}

  async listTargets(): Promise<Target[]> {
    const s = await this.sidecar.call<SidecarState>('state');
    return [{ id: 'window', label: s.title || '(Claude Desktop window)', identity: s.title }];
  }

  select(): void { /* single window; the "conversation" is whatever it currently shows */ }

  async getState(): Promise<AdapterState> {
    try {
      const s = await this.sidecar.call<SidecarState>('state');
      let warning: string | undefined;
      if (s.minimised) warning = 'Claude Desktop is minimised: title unavailable and writes are unreliable. Restore the window.';
      else if (!s.composerFound) warning = 'Claude composer not found (open a Chat or Code conversation).';
      else if (!s.title) warning = 'No conversation title visible.';
      return {
        connected: true, ready: s.composerFound && !s.minimised, title: s.title, generating: s.generating, idle: s.idle,
        composerBlank: s.composerBlank, sendEnabled: s.sendEnabled, warning, detail: { ...s },
        lastRole: s.lastRole === 'assistant' || s.lastRole === 'user' ? s.lastRole : null, turnCount: s.unitCount,
      };
    } catch (e) {
      const err = e as AdapterError;
      return {
        connected: err.code !== 'not-running' && err.code !== 'sidecar-died', ready: false, title: '', generating: false,
        idle: false, composerBlank: null, sendEnabled: null, warning: err.message,
      };
    }
  }

  async readLatest(): Promise<LatestResponse> {
    return this.sidecar.call<LatestResponse>('read');
  }

  async insert(text: string, opts: { overwrite: boolean }): Promise<InsertResult> {
    if (!text.trim()) throw new AdapterError('empty-text', 'Nothing to insert');
    return this.sidecar.call<InsertResult>('insert', { text, overwrite: opts.overwrite }, 30000);
  }

  async submit(expectText: string): Promise<SubmitResult> {
    return this.sidecar.call<SubmitResult>('submit', { expectText }, 30000);
  }

  async clearComposer(): Promise<void> {
    await this.sidecar.call('clear');
  }
}
