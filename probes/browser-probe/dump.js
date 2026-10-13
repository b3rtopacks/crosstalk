// Structure-only DOM dump. Self-contained: it is serialised and run inside the page by
// chrome.scripting.executeScript, so it must not reference anything outside itself.
// Collects tag/role/aria-label/data-* NAMES+short values, rects and text LENGTHS.
// Never reads input values, cookies, storage, hrefs or src attributes.
function dumpStructure(opts) {
  const SHORT = 80;
  const cut = (s, n = SHORT) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
  const SKIP_ATTR = /^(href|src|srcset|value|style|content|d|points|viewbox)$/i;

  const attrs = (el) => {
    const out = {};
    for (const a of el.attributes) {
      if (SKIP_ATTR.test(a.name)) continue;
      if (a.name === 'class') continue;
      out[a.name] = cut(a.value);
    }
    return out;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };
  const classHint = (el) => cut(typeof el.className === 'string' ? el.className : '', 100);
  const brief = (el) => ({
    tag: el.tagName.toLowerCase(),
    ...attrs(el),
    class: classHint(el),
    rect: rect(el),
  });
  const chain = (el, depth = 4) => {
    const c = [];
    for (let e = el.parentElement, i = 0; e && i < depth; e = e.parentElement, i++) {
      const o = { tag: e.tagName.toLowerCase() };
      for (const k of ['id', 'role', 'data-testid', 'aria-label', 'data-state']) if (e.getAttribute(k)) o[k] = cut(e.getAttribute(k), 50);
      c.push(o);
    }
    return c;
  };
  const textLen = (el) => (el.innerText || el.textContent || '').length;
  const withText = (el, base) => {
    base.textLength = textLen(el);
    if (opts && opts.textPreview) base.textPreview = cut((el.innerText || '').replace(/\s+/g, ' ').trim(), 60);
    return base;
  };
  // small structural outline (tags/roles/data-testid only, no text)
  const outline = (el, depth, budget) => {
    const node = { tag: el.tagName.toLowerCase() };
    for (const k of ['role', 'data-testid', 'aria-label', 'data-message-author-role', 'data-is-streaming']) if (el.getAttribute(k)) node[k] = cut(el.getAttribute(k), 50);
    if (depth > 0 && budget.n > 0) {
      const kids = [];
      for (const ch of el.children) {
        if (budget.n-- <= 0) break;
        kids.push(outline(ch, depth - 1, budget));
      }
      if (kids.length) node.children = kids;
    }
    return node;
  };

  const loc = new URL(location.href);
  const result = {
    probeVersion: 2,
    capturedAt: new Date().toISOString(),
    page: { origin: loc.origin, path: loc.pathname, title: document.title, visibility: document.visibilityState, readyState: document.readyState },
    userAgent: navigator.userAgent,
  };

  // 1. Composer candidates
  const composerSel = 'textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], .ProseMirror, #prompt-textarea';
  const composers = [...new Set(document.querySelectorAll(composerSel))].filter((e) => e.getClientRects().length);
  result.composerCandidates = composers.slice(0, 8).map((el) => ({
    ...brief(el),
    contenteditable: el.getAttribute('contenteditable'),
    isContentEditable: el.isContentEditable,
    hasText: (el.innerText || el.value || '').trim().length > 0,
    ancestors: chain(el),
  }));

  // 2. Controls near the composer + any send/stop-like controls
  const ctrlRe = /send|submit|stop|cancel|interrupt|regenerate|retry|copy|abort|generating|streaming/i;
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
    const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + (b.id || '');
    return ctrlRe.test(label);
  });
  const seen = new Set(buttons);
  // buttons inside the composer's form / nearest container (up to 5 levels)
  for (const c of composers.slice(0, 2)) {
    let scope = c;
    for (let i = 0; i < 5 && scope.parentElement; i++) scope = scope.parentElement;
    for (const b of scope.querySelectorAll('button, [role="button"]')) seen.add(b);
  }
  result.controls = [...seen].slice(0, 60).map((b) => ({
    ...brief(b),
    disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
    labelText: cut((b.innerText || '').trim(), 30),
    visible: b.getClientRects().length > 0,
  }));

  // 3. Message containers
  const msgSel = '[data-message-author-role], [data-testid*="message" i], [data-testid*="turn" i], [data-testid*="conversation-turn" i], [data-is-streaming], [class*="font-claude" i], [class*="font-user" i], article, [role="article"]';
  const msgs = [...new Set(document.querySelectorAll(msgSel))];
  result.messageCandidateCount = msgs.length;
  const pick = (el) => withText(el, { ...brief(el), ancestors: chain(el, 3) });
  result.messageCandidates = {
    first: msgs.slice(0, 4).map(pick),
    last: msgs.slice(-6).map(pick),
  };
  // distinct (tag, author-role/testid) signatures with counts
  const sig = {};
  for (const m of msgs) {
    const k = [m.tagName.toLowerCase(), m.getAttribute('data-message-author-role') || '', m.getAttribute('data-testid') || '', m.getAttribute('role') || ''].join('|');
    sig[k] = (sig[k] || 0) + 1;
  }
  result.messageSignatures = sig;
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg) result.lastMessageOutline = outline(lastMsg, 4, { n: 80 });

  // 4. Streaming / busy signals
  result.busySignals = {
    ariaBusy: [...document.querySelectorAll('[aria-busy="true"]')].slice(0, 5).map(brief),
    dataStreaming: [...document.querySelectorAll('[data-is-streaming],[data-streaming],[data-state="streaming"]')].slice(0, 5).map((e) => ({ ...brief(e), streamingAttr: e.getAttribute('data-is-streaming') })),
    liveRegions: [...document.querySelectorAll('[aria-live],[role="status"],[role="log"]')].slice(0, 10).map((e) => withText(e, brief(e))),
  };

  // 5. Census of data-* attribute names (discovery aid)
  const census = {};
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) if (a.name.startsWith('data-')) census[a.name] = (census[a.name] || 0) + 1;
  }
  result.dataAttributeCensus = Object.fromEntries(Object.entries(census).sort((a, b) => b[1] - a[1]).slice(0, 60));

  // 6. Landmarks / sidebar conversation links (paths only, no titles unless preview)
  result.landmarks = [...document.querySelectorAll('main, nav, aside, header, form, [role="main"], [role="navigation"], [role="log"]')]
    .slice(0, 12).map((e) => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), 'aria-label': cut(e.getAttribute('aria-label'), 50), id: e.id || undefined, rect: rect(e) }));
  const convLinks = [...document.querySelectorAll('a[href*="/c/"], a[href*="/chat/"]')];
  result.conversationLinks = { count: convLinks.length, samplePathShapes: convLinks.slice(0, 3).map((a) => new URL(a.href, location.href).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<uuid>')) };

  // 7. (v2) Controls inside EVERY composer's form/ancestor scope, not just the first two candidates
  result.composerScopes = composers.slice(0, 6).map((c) => {
    const scope = c.closest('form') || (() => { let e = c; for (let i = 0; i < 6 && e.parentElement; i++) e = e.parentElement; return e; })();
    return {
      composerAria: c.getAttribute('aria-label'),
      scopeTag: scope.tagName.toLowerCase(),
      scopeRect: rect(scope),
      buttons: [...scope.querySelectorAll('button, [role="button"]')].slice(0, 20).map((b) => ({
        ...brief(b), disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true', visible: b.getClientRects().length > 0,
      })),
    };
  });

  // 8. (v2) Sample elements carrying turn/role/state-like data-* attributes (first 2 + last 3 per attribute name)
  const interesting = /(turn|role|message|state|stream|status|bubble|composer|submit|send|stop|agent)/i;
  result.attributeSamples = {};
  for (const name of Object.keys(census)) {
    if (!interesting.test(name) || census[name] > 400) continue;
    const els = [...document.querySelectorAll('[' + CSS.escape(name) + ']')];
    const sample = (e) => withText(e, { ...brief(e), ancestors: chain(e, 2), childTags: [...e.children].slice(0, 6).map((k) => k.tagName.toLowerCase() + (k.getAttribute('data-testid') ? '[' + k.getAttribute('data-testid') + ']' : '')) });
    result.attributeSamples[name] = { count: els.length, first: els.slice(0, 2).map(sample), last: els.slice(-3).map(sample) };
  }

  // 9. (v2) Latest turn outline: nearest ancestor of the last [data-turn-key], structure only
  const turns = document.querySelectorAll('[data-turn-key]');
  if (turns.length) result.lastTurnOutline = outline(turns[turns.length - 1], 6, { n: 150 });
  return result;
}
