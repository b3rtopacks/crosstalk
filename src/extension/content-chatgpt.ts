import { clearComposer, getState, insert, readLatest, submit, PageError } from './chatgpt-dom.ts';

type Msg = { op: 'state' } | { op: 'read' } | { op: 'clear' } | { op: 'insert'; text: string; overwrite: boolean } | { op: 'submit'; expectText: string };

const w = window as unknown as { __crossTalkInstalled?: boolean };
if (!w.__crossTalkInstalled) {
  w.__crossTalkInstalled = true;
  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.op === 'state') return sendResponse({ ok: true, result: getState() });
        if (msg.op === 'read') return sendResponse({ ok: true, result: readLatest() });
        if (msg.op === 'insert') return sendResponse({ ok: true, result: await insert(msg.text, msg.overwrite) });
        if (msg.op === 'submit') return sendResponse({ ok: true, result: await submit(msg.expectText) });
        if (msg.op === 'clear') return sendResponse({ ok: true, result: await clearComposer() });
        sendResponse({ ok: false, error: 'bad-op', detail: String((msg as { op: string }).op) });
      } catch (e) {
        const code = e instanceof PageError ? e.code : 'page-error';
        sendResponse({ ok: false, error: code, detail: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true; // async response
  });
}
