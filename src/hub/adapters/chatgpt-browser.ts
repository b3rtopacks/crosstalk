import { AdapterError, type AdapterState, type ConversationAdapter, type InsertResult, type LatestResponse, type PageState, type SubmitResult, type Target } from '../../shared/types.ts';
import type { ExtensionLink } from '../extension-link.ts';

interface TabInfo { tabId: number; title: string; path: string; active: boolean; windowId: number }

const BLANK = { generating: false, idle: false, composerBlank: null, sendEnabled: null } as const;

/** ChatGPT in the user's own Chrome/Edge tab, driven by the CrossTalk extension's content script. */
export class ChatGPTBrowserAdapter implements ConversationAdapter {
  readonly id = 'chatgpt-browser';
  readonly provider = 'chatgpt' as const;
  readonly surface = 'browser' as const;
  private tabId: number | null = null;

  constructor(private ext: ExtensionLink) {}

  get selectedTabId(): number | null { return this.tabId; }

  async listTargets(): Promise<Target[]> {
    if (!this.ext.connected) return [];
    const tabs = await this.ext.request<TabInfo[]>({ op: 'tabs' });
    return tabs.map((t) => ({ id: String(t.tabId), label: t.title || t.path, identity: t.path }));
  }

  select(targetId: string | null): void { this.tabId = targetId == null ? null : Number(targetId); }

  async getState(): Promise<AdapterState> {
    if (!this.ext.connected) {
      return { connected: false, ready: false, title: '', ...BLANK, warning: 'Browser extension not connected. Is the CrossTalk extension loaded and Chrome/Edge running?' };
    }
    if (this.tabId == null) return { connected: true, ready: false, title: '', ...BLANK, warning: 'No ChatGPT tab selected.' };
    try {
      const s = await this.ext.request<PageState>({ op: 'state', tabId: this.tabId });
      let warning: string | undefined;
      if (!s.composerFound) warning = 'ChatGPT composer not found on this tab.';
      else if (s.hidden) warning = 'Tab is in the background; reads and writes should still work, but the page may throttle.';
      return {
        connected: true, ready: s.composerFound, title: s.title, conversationKey: s.path, generating: s.generating, idle: s.idle,
        composerBlank: s.composerBlank, sendEnabled: s.sendEnabled, warning, detail: { ...s },
        lastRole: s.lastTurnRole, turnCount: s.turnCount,
      };
    } catch (e) {
      return { connected: true, ready: false, title: '', ...BLANK, warning: (e as Error).message };
    }
  }

  async readLatest(): Promise<LatestResponse> {
    this.requireTab();
    return this.ext.request<LatestResponse>({ op: 'read', tabId: this.tabId! });
  }

  async insert(text: string, opts: { overwrite: boolean }): Promise<InsertResult> {
    this.requireTab();
    if (!text.trim()) throw new AdapterError('empty-text', 'Nothing to insert');
    return this.ext.request<InsertResult>({ op: 'insert', tabId: this.tabId!, text, overwrite: opts.overwrite }, 30000);
  }

  async submit(expectText: string): Promise<SubmitResult> {
    this.requireTab();
    return this.ext.request<SubmitResult>({ op: 'submit', tabId: this.tabId!, expectText }, 30000);
  }

  async clearComposer(): Promise<void> {
    this.requireTab();
    await this.ext.request({ op: 'clear', tabId: this.tabId! });
  }

  private requireTab(): void {
    if (!this.ext.connected) throw new AdapterError('extension-disconnected', 'Browser extension not connected');
    if (this.tabId == null) throw new AdapterError('no-tab', 'No ChatGPT tab selected');
  }
}
