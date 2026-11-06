// Synthetic selector/guard regressions, not a substitute for live browser testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = await build({
  entryPoints: ['src/extension/chatgpt-dom.ts'], bundle: true, write: false,
  format: 'iife', globalName: 'Adapter', logLevel: 'error',
});
const composer='<form><div contenteditable="true" role="textbox"></div><button type="submit">Send</button></form>';
const user='<div><h4 data-conversation-role="user">You said:</h4><div data-user-message-bubble>Question</div></div>';
const answer=(text='Answer',attrs='')=>`<div data-local-conversation-final-assistant="true" ${attrs}><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-message-id="synthetic">${text}</div></div>`;
const pair=(body,attrs='')=>`<section data-turn-key="synthetic-pair" ${attrs}>${body}</section>`;
const cases=[
 ['completed pair',pair(user+answer()),{text:'Answer'}],
 ['pending new user',pair(user+answer())+pair(user),{error:'no-completed-response'}],
 ['stop button',pair(user+answer())+'<button data-testid="stop-button">Stop</button>',{error:'source-generating'}],
 ['working indicator',pair(user+answer())+'<div role="status" aria-label="Working">Working</div>',{error:'source-generating'}],
 ['assistant state incomplete',pair(user+answer('Partial','data-talvt-turn-state="streaming"')),{error:'no-completed-response'}],
 ['pair state incomplete',pair(user+answer('Partial'),'data-talvt-turn-state="streaming"'),{error:'no-completed-response'}],
 ['wrapper state incomplete','<div data-talvt-turn-state="streaming">'+pair(user+answer('Partial'))+'</div>',{error:'no-completed-response'}],
 ['original separate-message layout',pair(user)+pair('<h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-message-id="synthetic">Answer</div>'),{text:'Answer'}],
 ['hidden trailing pair',pair(user+answer())+pair(user+answer('Hidden'),'style="display:none"'),{text:'Answer'}],
 ['empty answer',pair(user+answer('')),{error:'empty-response'}],
 ['nested turn wrappers',pair(pair(user+answer())),{text:'Answer'}],
];
const cid='11111111-1111-1111-1111-111111111111';
const fallbackAnswer = '<div data-local-conversation-final-assistant="true"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-conversation-id="'+cid+'">Fallback answer</div></div>';
cases.push(
 ['fallback without message-id', pair(user+fallbackAnswer), {text:'Fallback answer'}],
 ['fallback refuses older reply', pair(user+answer())+pair(user+'<div data-local-conversation-final-assistant="true"><h4 data-conversation-role="assistant">ChatGPT said:</h4></div>'), {error:'no-replies'}],
 ['fallback cannot bypass incomplete state', pair(user+fallbackAnswer,'data-talvt-turn-state="streaming"'), {error:'no-completed-response'}],
 ['hidden assistant copy', pair(user+answer('Hidden','style="display:none"')), {error:'no-completed-response'}]
);

for (const [name, html, expected] of cases) {
  test(`ChatGPT DOM: ${name}`, () => {
    const hasStop = html.includes('data-testid="stop-button"');
    const content = html.replaceAll('data-chatgpt-selection-message-id=',
      `data-chatgpt-selection-conversation-id="${cid}" data-chatgpt-selection-message-id=`);
    const form = composer.replace('</form>', hasStop
      ? '<button data-testid="stop-button">Stop</button></form>' : '</form>');
    const dom = new JSDOM(content + form, {
      url: `https://chatgpt.com/c/${cid}`, runScripts: 'outside-only',
    });
    try {
      const win = dom.window;
      // jsdom has no layout engine. Model only the visibility rules used by these fixtures.
      win.Element.prototype.getBoundingClientRect = function () {
        for (let el = this; el; el = el.parentElement) {
          if (el.hidden || el.style?.display === 'none') return { width: 0, height: 0 };
        }
        return { width: 100, height: 20 };
      };
      // Fixtures use plain text: this does not test browser innerText whitespace behavior.
      Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
        get() { return this.textContent; }, configurable: true,
      });
      const actual = win.eval(bundle.outputFiles[0].text + `\n(() => {
        try { return { text: Adapter.readLatest().text }; }
        catch (error) { return { error: error.code ?? error.message }; }
      })()`);
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
    } finally {
      dom.window.close();
    }
  });
}
