// ChatGPT page adapter. ALL chatgpt.com DOM knowledge lives in this file.
// Selectors were derived from live probe dumps (docs/FINDINGS.md), not from memory. They are English-UI
// dependent only where noted. If ChatGPT changes its DOM, this is the only file that should need edits.

import type { InsertResult, LatestResponse, PageState, SubmitResult } from '../shared/types.ts';

export class PageError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const norm = (s: string): string => s.replace(/[\s ]+/g, ' ').trim();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Rendered (not display:none). Elements scrolled off-screen still have a box, so this is scroll-independent. */
function rendered(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

interface Composer { form: HTMLFormElement; editor: HTMLElement }

/**
 * The real prompt box is the contenteditable textbox INSIDE the visible <form>.
 * (Canvas/document editors on the same page are also ProseMirror textboxes but are not in a form.)
 */
function findComposer(): Composer | null {
  for (const form of document.querySelectorAll<HTMLFormElement>('form')) {
    if (!rendered(form)) continue;
    const editor =
      form.querySelector<HTMLElement>('[contenteditable="true"][data-composer-markdown]') ??
      form.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]');
    if (editor && rendered(editor)) return { form, editor };
  }
  return null;
}

function composerText(editor: HTMLElement): string {
  return editor.innerText ?? editor.textContent ?? '';
}

function findSend(form: HTMLElement): HTMLButtonElement | null {
  return form.querySelector<HTMLButtonElement>('button[type="submit"], button[data-testid="send-button"]');
}

// English labels; data-testid first. Language-independent fallback: the "Working" status indicator below.
const STOP_SELECTOR = 'button[data-testid="stop-button"], button[aria-label="Stop"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"]';

function stopPresent(form: HTMLElement | null): boolean {
  const root: ParentNode = form ?? document;
  return [...root.querySelectorAll(STOP_SELECTOR)].some(rendered);
}

function workingIndicator(): boolean {
  return [...document.querySelectorAll('[role="status"][aria-label="Working"]')].some(rendered);
}

interface Turn { el: HTMLElement; role: 'user' | 'assistant' | null }

/** Visible conversation turns in document order. The page also keeps hidden (display:none) copies; skip them. */
function turns(): Turn[] {
  const all = [...document.querySelectorAll<HTMLElement>('[data-turn-key]')].filter(rendered);
  const leaf = all.filter((t) => !t.querySelector('[data-turn-key]'));
  return leaf.flatMap((el): Turn[] => {
    const assistant = el.matches('[data-local-conversation-final-assistant="true"]')
      ? el : el.querySelector<HTMLElement>('[data-local-conversation-final-assistant="true"]');
    if (assistant) {
      const result: Turn[] = [];
      const user = el.querySelector<HTMLElement>('[data-user-message-bubble]');
      if (user && rendered(user)) result.push({ el: user, role: 'user' });
      if (rendered(assistant)) result.push({ el: assistant, role: 'assistant' });
      return result;
    }
    // Older layouts use one turn container per message.
    const r = el.getAttribute('data-conversation-role') ??
      el.querySelector('[data-conversation-role]')?.getAttribute('data-conversation-role');
    const role = r === 'assistant' || r === 'user' ? r : el.querySelector('[data-user-message-bubble]') ? 'user' : null;
    return [{ el, role }];
  });
}

/** 'complete' | other streaming value | null when the attribute is absent. */
function turnState(t: Turn): string | null {
  const holder = t.el.matches('[data-talvt-turn-state]') ? t.el : t.el.querySelector('[data-talvt-turn-state]') ?? t.el.parentElement?.closest('[data-talvt-turn-state]');
  return holder?.getAttribute('data-talvt-turn-state') ?? null;
}

export function getState(): PageState {
  const c = findComposer();
  const send = c ? findSend(c.form) : null;
  const stop = stopPresent(c?.form ?? null);
  const generating = stop || workingIndicator();
  const ts = turns();
  const last = ts[ts.length - 1] ?? null;
  const lastAssistant = [...ts].reverse().find((t) => t.role === 'assistant') ?? null;
  const st = lastAssistant ? turnState(lastAssistant) : null;
  const lastAssistantComplete = lastAssistant ? (st === null ? !generating : st === 'complete') : null;
  const blank = c ? norm(composerText(c.editor)) === '' : null;
  return {
    title: document.title,
    path: location.pathname,
    composerFound: !!c,
    composerBlank: blank,
    sendEnabled: send ? !send.disabled && send.getAttribute('aria-disabled') !== 'true' : false,
    stopPresent: stop,
    generating,
    turnCount: ts.length,
    lastAssistantComplete,
    lastTurnRole: last?.role ?? null,
    idle: !!c && !generating && (last === null || last.role !== 'assistant' || lastAssistantComplete !== false),
    hidden: document.visibilityState !== 'visible',
  };
}

/**
 * innerText of a message, minus code-block header labels ("Plain text", language names) that are UI chrome.
 * Conservative: a header is removed only when a <pre> has a code element and the text before it is a short
 * label-like string. Anything else is left exactly as the page renders it.
 */
export function messageText(source: HTMLElement): string {
  let text = source.innerText ?? '';
  for (const pre of source.querySelectorAll<HTMLElement>('pre')) {
    const codeEl = pre.querySelector<HTMLElement>('code, .cm-content');
    if (!codeEl) continue;
    const preText = pre.innerText ?? '';
    const codeText = codeEl.innerText ?? '';
    const idx = codeText.trim() ? preText.indexOf(codeText) : -1;
    if (idx <= 0) continue;
    const header = preText.slice(0, idx);
    if (header.length > 40 || !/^\s*[\w+#.\- ]{1,30}\s*$/.test(header)) continue;
    text = text.replace(header + codeText, () => codeText);
  }
  return text;
}

function getText(assistant: HTMLElement): string {
  // A turn can hold several messages; the final rendered message is the answer.
  const msgs = [...assistant.querySelectorAll<HTMLElement>('[data-chatgpt-selection-message-id]')].filter(rendered);
  const source = assistant.matches('[data-chatgpt-selection-message-id]') ? assistant : msgs[msgs.length - 1];
  if (!source) throw new PageError('no-message-text', 'ChatGPT message text container not found');
  const text = messageText(source).replace(/^\s*ChatGPT said:\s*/i, '').trim();
  if (!text) throw new PageError('empty-response', 'Latest ChatGPT reply text could not be read');
  return text;
}

/**
 * Uses fewer DOM attributes and makes fewer assumptions about message nesting
 * than the primary extractor, so it may survive changes to the surrounding UI.
 * Completion and assistant-role checks must pass before this fallback is used.
 * Conversation-ID lookup contributed by Toney Biegalski.
 */
function getTextFallback(assistant: HTMLElement): string {
  const cid = window.location.href.match(/[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}/)?.[0];
  if (!cid) throw new PageError('no-replies', 'No conversation ID found in the current URL');
  const allReplies = [...document.querySelectorAll<HTMLElement>(
    '[data-chatgpt-selection-conversation-id="' + cid + '"]'
  )].filter(rendered);
  const message = allReplies[allReplies.length - 1];
  // Never substitute an older reply or text outside the validated assistant turn.
  if (!message || !assistant.contains(message)) {
    throw new PageError('no-replies', 'No reply text found within the latest assistant response');
  }
  const text = messageText(message).trim();
  if (!text) throw new PageError('empty-response', 'Latest ChatGPT reply text could not be read');
  return text;
}

export function readLatest(): LatestResponse {
  const s = getState();
  if (s.generating) throw new PageError('source-generating', 'ChatGPT is still generating');
  const ts = turns();
  const last = ts[ts.length - 1];
  if (!last || last.role !== 'assistant') throw new PageError('no-completed-response', 'The newest turn is not an assistant reply');
  if (s.lastAssistantComplete === false) throw new PageError('no-completed-response', `Latest reply is not complete (state: ${turnState(last)})`);
  let text: string;
  try {
    text = getText(last.el);
  } catch (error) {
    if (!(error instanceof PageError) || !['no-message-text', 'empty-response'].includes(error.code)) throw error;
    text = getTextFallback(last.el);
  }
  return { text, title: document.title };
}

function selectAll(editor: HTMLElement): void {
  editor.focus({ preventScroll: true });
  document.execCommand('selectAll');
}

function caretToEnd(editor: HTMLElement): void {
  editor.focus({ preventScroll: true });
  const sel = getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function tryInsertText(editor: HTMLElement, text: string): void {
  document.execCommand('insertText', false, text);
}

function tryPaste(editor: HTMLElement, text: string): void {
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}

/** Insert `text` into the composer and verify by read-back. Never submits. */
export async function insert(text: string, overwrite: boolean): Promise<InsertResult> {
  const c = findComposer();
  if (!c) throw new PageError('no-composer', 'ChatGPT composer not found');
  if (stopPresent(c.form) || workingIndicator()) throw new PageError('destination-generating', 'ChatGPT is generating; wait for it to finish');
  const { editor, form } = c;
  const original = composerText(editor);
  const hadDraft = norm(original) !== '';
  if (hadDraft && !overwrite) throw new PageError('composer-not-empty', 'The ChatGPT composer already has a draft; clear it or tick overwrite');

  const want = norm(text);
  let got = '';
  // insertText avoids ChatGPT's paste handler (which can turn large pastes into attachments); paste is the fallback.
  const strategies: Array<[string, (e: HTMLElement, t: string) => void]> = [['insertText', tryInsertText], ['paste', tryPaste]];
  for (const [, run] of strategies) {
    if (hadDraft || norm(composerText(editor)) !== '') selectAll(editor); else caretToEnd(editor);
    run(editor, text);
    for (let i = 0; i < 8; i++) {
      await sleep(150);
      got = composerText(editor);
      if (norm(got) === want) break;
    }
    if (norm(got) === want) break;
    selectAll(editor);                       // wipe the failed attempt before the next strategy
    document.execCommand('delete');
    await sleep(100);
  }
  const verified = norm(got) === want;
  if (!verified) {
    throw new PageError('verify-failed', `Read-back did not match (wanted ${text.length} chars, got ${got.length}); composer cleared. ${hadDraft ? 'The previous draft was overwritten.' : ''}`.trim());
  }
  // Editor state must reach the app: the Send button should enable once there is text.
  let send = findSend(form);
  for (let i = 0; i < 6 && !(send && !send.disabled); i++) { await sleep(150); send = findSend(form); }
  return {
    verified, exact: got === text || got.replace(/\n{2,}/g, '\n') === text.replace(/\n{2,}/g, '\n'),
    wantedChars: text.length, readBackChars: got.length,
    sendEnabled: send ? !send.disabled && send.getAttribute('aria-disabled') !== 'true' : false,
  };
}

/** Press Send. Reachable only from the hub's human-approved SEND action. */
export async function submit(expectText: string): Promise<SubmitResult> {
  const c = findComposer();
  if (!c) throw new PageError('no-composer', 'ChatGPT composer not found');
  if (stopPresent(c.form) || workingIndicator()) throw new PageError('not-sendable', 'ChatGPT is generating');
  const send = findSend(c.form);
  if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true') throw new PageError('not-sendable', 'ChatGPT Send button is not available');
  if (norm(composerText(c.editor)) !== norm(expectText)) throw new PageError('draft-changed', 'The ChatGPT draft no longer matches what the relay inserted; not sending');
  send.click();
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const c2 = findComposer();
    const blank = !!c2 && norm(composerText(c2.editor)) === '';
    if (blank || stopPresent(c2?.form ?? null) || workingIndicator()) return { submitted: true };
  }
  throw new PageError('submit-unconfirmed', 'Pressed Send but the composer did not clear and no generation started');
}

export async function clearComposer(): Promise<{ cleared: boolean }> {
  const c = findComposer();
  if (!c) throw new PageError('no-composer', 'ChatGPT composer not found');
  selectAll(c.editor);
  document.execCommand('delete');
  for (let i = 0; i < 8; i++) {
    await sleep(150);
    if (norm(composerText(c.editor)) === '') return { cleared: true };
  }
  throw new PageError('clear-failed', 'Composer did not clear');
}
