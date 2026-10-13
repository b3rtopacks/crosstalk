# Architecture

CrossTalk is a local, two-way, **manual** relay between one Claude conversation and one ChatGPT conversation.
It uses no OpenAI or Anthropic API and stores no credentials. By default Send is always a human click; an optional,
explicitly enabled AUTO SEND mode can submit verified drafts itself.

```
   Claude Desktop (Windows UIA)            ChatGPT tab in your own Chrome/Edge
          ▲                                          ▲
   uia-sidecar.ps1 (PowerShell 5.1)       extension: content script + service worker
          │ JSON lines (stdio)                       │ WebSocket, 127.0.0.1 only
          └────────────────►  Hub (Node)  ◄──────────┘
                     adapters · relay core · link store · HTTP GUI
                                    ▲
                           http://127.0.0.1:17321 (browser GUI)
```

* **Relay core** (`src/hub/relay.ts`): reads the newest *completed* reply from the source adapter, inserts it into the
  destination composer, verifies by read-back. It knows nothing about browsers or desktop apps.
* **Adapters** implement `ConversationAdapter` (`src/shared/types.ts`): `listTargets`, `select`, `getState`,
  `readLatest`, `insert`. There is intentionally no `submit` yet.
  * `ClaudeDesktopAdapter` → UIA sidecar. `ChatGPTBrowserAdapter` → extension.
  * Planned: `ClaudeBrowserAdapter`, `ChatGPTDesktopAdapter` (untested: not installed during probing).
* **Why an extension, not CDP/Playwright or an embedded browser:** Chrome 136+ ignores `--remote-debugging-port` on the
  default profile, and embedded webviews are blocked by Google OAuth. The extension reuses the logged-in browser as is.
* **Why UIA for Claude Desktop:** Chromium builds its accessibility tree once a UIA client asks; no flags, no patching.
  Findings and caveats: `docs/FINDINGS.md`.
* **Site-specific logic is isolated**: `src/extension/chatgpt-dom.ts` (all chatgpt.com DOM knowledge) and
  `sidecar/uia-sidecar.ps1` (all Claude Desktop UIA knowledge).

## Safety properties
* Loopback only. The HTTP API rejects non-loopback `Host` headers (DNS rebinding) and requires `X-Relay: 1` on POST
  (forces a CORS preflight the server never grants). The extension WebSocket accepts only `chrome-extension://` origins.
* Inserting never overwrites a draft unless the user ticks "overwrite".
* Relay refuses while either side is generating, or when the linked conversations are no longer the ones displayed.
* A write is only reported successful after read-back matches (whitespace-normalised).

## Controlled automatic relay (`src/core/machine.ts`)
One pair. A polling state machine over `ConversationAdapter` (pure, unit-tested with fakes):

```
NOT_STARTED -> WAITING_FOR_CLAUDE -> CLAUDE_GENERATING -> CLAUDE_COMPLETE -> INSERTING_INTO_CHATGPT
            -> READY_TO_SEND_CHATGPT --(human click, or AUTO SEND after countdown)--> WAITING_FOR_CHATGPT
            -> CHATGPT_GENERATING -> CHATGPT_COMPLETE -> INSERTING_INTO_CLAUDE -> READY_TO_SEND_CLAUDE -> WAITING_FOR_CLAUDE ...
anywhere: PAUSED (identity change, unknown state, hop limit, blocked auto-send)
          ERROR (stop-on-error: write verification failed, adapter error)
          USER_INTERVENTION_REQUIRED (destination composer has text, ambiguous start, alternation violated)
```
* **Start** decides who speaks next from live state (never from what merely exists) and baselines every reply already on
  screen as seen. If it cannot tell, it asks.
* **Safeguards:** strict alternation (only the expected side is read); SHA-256 of the normalised reply, never relayed twice;
  never relays while the source generates; identity (Claude title / ChatGPT URL path) checked before every read, write and
  send; never overwrites destination text; read-back verification; hop limit (default 20); pause / resume / reset; event log.
* **Send** is a separate step. Manual: the human clicks SEND TO <side> (`approveSend`). Optional **AUTO SEND** (default OFF)
  arms a countdown (default 2 s, cancellable) after each verified insertion, then re-runs every check and calls
  `adapter.submit(text)`, which itself refuses unless the composer holds exactly `text`. Any failed check pauses the link.
  The source re-check compares layout-independent SHA-256 fingerprints (`canonical()`: whitespace removed); on a mismatch it
  logs full diagnostics, settles, and needs two stable matching reads before sending. Max hops defaults to 2; AUTO SEND with
  more than 2 hops needs a one-time confirmation (`src/core/policy.ts`).
* Adapters gained `submit(expectText)` and `clearComposer()`; Claude Desktop's `submit` is UIA `Invoke` on the composer's
  own Send button; ChatGPT's is a click on the form's submit button.

## Not in this milestone
Multiple pairs, tray/desktop shell, installers, Claude Browser and ChatGPT Desktop adapters.
