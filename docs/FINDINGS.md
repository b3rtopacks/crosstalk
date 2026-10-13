# Feasibility findings

Status: Milestone 1 probes, 2026-10-13. Raw dumps live in `probes/reports/` (git-ignored: they contain
conversation text). Nothing here was verified by sending, inserting or clicking anything.

## Claude Desktop (Windows, MSIX "Claude" 2.31226.1.0) — UI Automation

Probes: `probes/uia-dump.ps1` (full tree), `probes/uia-state.ps1` (adapter-style state read),
`probes/uia-minimise-test.ps1` (minimise, read, restore). Windows PowerShell 5.1 + .NET
`System.Windows.Automation`; no installs.

### Headline
**The web content is exposed, but only after a UIA client has queried the window once.** The first dump saw
15 nodes (native Chromium frame only). A second dump seconds later saw ~516 (ControlView) / ~885 (RawView).
Chromium switches accessibility on when it detects a UIA client. No launch flags, no app modification.
An adapter must therefore "wake" the tree (query, wait, retry) and treat an empty tree as "not ready", not as an error.

### What is exposed (observed)
| Need | Finding |
|---|---|
| Window identity | Top-level `Window` name `Claude`, class `Chrome_WidgetWin_1`. All Claude windows/processes share that name. |
| Conversation title | `Document` with AutomationId `RootWebArea`; its Name is the title (e.g. `<session> - Claude Code`). **Empty when the window is minimised.** The sidebar session buttons also carry titles. |
| Conversation id | **Not exposed.** Title only, which is not unique. Needs a user-assigned link plus title/fingerprint verification. |
| Message list | `Group` name `Chat messages` containing `Group` children named `Message 1..N`. |
| Speaker | Each message group contains an `sr-only` Text named `You said: …` or `Claude responded: …`. |
| Message text | `Text` nodes (TextPattern), including those currently offscreen, so scrolling is not required. Long user messages are truncated at 160 chars by my dump only; the real `Name` was full length. |
| Newest assistant reply | Readable, but **not cleanly delimited** in the Code-mode view: assistant prose sits as sibling `Text` nodes in `Chat messages` after the `Message N` group, interleaved with tool-call groups (`Ran 3 commands`, etc.). Reconstruct by concatenating `Text` siblings until the next `Message`/`Currently streaming message` group, skipping tool groups. Heuristic, not a contract. |
| Per-message actions | Completed messages carry `Copy`, `Fork from here`, `Read aloud`, and a relative timestamp button. `Copy` + clipboard is a fallback for exact text, at the cost of touching the clipboard. |
| Composer | `Edit` named `Prompt`, class `tiptap ProseMirror`, patterns `ValuePattern` + `TextPattern`, `IsReadOnly=false`, keyboard-focusable, not offscreen. |
| Generating state | `Button` named `Stop` present (and a `Group` named `Currently streaming message`, and a sr-only status `Claude is responding`) while generating. Observed live: the session this probe ran in was generating; `Stop` present, `Send` absent. |
| Send button | **Not observed** — the app was generating and the composer empty. Idle state not yet captured. |
| Sidebar per-session status | Session buttons are named `Running <title>` / `Idle <title>` with a `StatusBar`/`Image` child. Useful for monitoring non-focused sessions. |
| Automation IDs | Mostly empty or React-generated (`_r_f73_`), so unstable. Names/roles/classes are the usable anchors. |

### Window-state behaviour (measured)
| State | Tree available | Notes |
|---|---|---|
| Normal, not foreground | Yes, full | `isForeground=false`, all fields read. |
| Minimised | **Yes, full** | Same message/composer/Stop results; **only the `Document` title went empty.** Composer still reported not-offscreen. |
| Locked screen / other virtual desktop | Untested | |

Probe time was ~0.36 s per state read.

### Caveat: Code mode vs Chat mode
The visible window was a **Claude Code session** (the app has a `Claude | Code` mode toggle). Relay targets are
ordinary **Chat** conversations, whose DOM may differ (message grouping, Send/Stop names, composer). I did not
switch modes because that would change the app's state. **Re-run the probes with a Chat conversation open** before
building the Claude Desktop adapter.

### Not yet proven
- **Text insertion.** `ValuePattern` is present and writable, but whether `SetValue` updates ProseMirror's state
  (rather than just the DOM) is untested. Fallbacks: focus + `SendKeys`/clipboard paste (needs foreground focus),
  or `SendInput`. Must be tested with a throwaway composer draft; not done (no modifications permitted).
- Send button name/state when idle with text in the composer.
- Whether the composer is writable while minimised (reading works; writing likely needs a restored window).

### Verdict
Reading, identity-by-title and generating-state detection are **realistic**, including while minimised. Insertion
is **plausible but unproven**. Needs foreground focus only if `SetValue` fails. Risk: the `Message N`/sr-only
structure and `Stop` naming are app-internal and can change with any release.

## ChatGPT Desktop
**UNTESTED** — not installed on this machine. Not blocking.

## Browser probes (claude.ai, chatgpt.com)
Probe extension: `probes/browser-probe/` (MV3, `activeTab` + `scripting` only; manual "Dump structure" button;
structure only — roles, aria-labels, data-* names/short values, rects, text **lengths**; no cookies, storage,
hrefs, input values; message text preview is opt-in and capped at 60 chars). Smoke-tested against a jsdom
fixture; **not yet run on the live sites** (needs you to load it and press the button — see below).

### claude.ai (live dump, idle chat, `/chat/<uuid>`)
Report: `probes/reports/relay-probe-1791890821827.json` (git-ignored). Probe mechanism works.

| Need | Finding |
|---|---|
| Conversation identity | URL path `/chat/<uuid>`; `document.title` = conversation title + ` - Claude`. Reliable. |
| Message list | `div[role="feed"][aria-label="Chat messages"]` > `data-testid="transcript-row"` rows. |
| Messages | `[data-testid="user-message"]`, `[data-testid="assistant-message"]` (`data-cds="AssistantMessage"`, `data-turn-key`). |
| Completion | `data-is-streaming="true"/"false"` on the assistant message. Idle observed: `"false"`. Streaming value **not yet captured**. |
| Actions bar | `[data-testid="message-actions"]` (role toolbar) with `Copy` and `Retry` (`action-bar-retry`) appears after completion. |
| Composer | `div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][data-testid="chat-input"]`, `aria-label="Write your prompt to Claude"`. |
| Send | `[data-testid="chat-input-send"]` (`aria-label="Send message"`); **`disabled` while the composer is empty**. Stop control not yet captured (needs a mid-generation dump). |
| Other | `last-message-sentinel`, `chat-message-skeleton`, status live regions (`hub-turn-failure-announcer`) exist. |

Good semantic anchors (`data-testid`, roles, aria-labels); no class-name dependence needed. Still to capture:
mid-generation state (streaming flag + Stop control).

### chatgpt.com (probe v1 dumps: one idle, one generating; `/c/<uuid>`)
**Partially characterised. Not enough yet to write the adapter.** Reports `relay-probe-1791891392319.json` (idle)
and `relay-probe-1791891408782.json` (generating).

Confirmed:
- **Identity:** path `/c/<uuid>` (also `/g/<project>/c/<uuid>`); `document.title` = conversation title (no suffix).
- **Real composer:** `div.ProseMirror[contenteditable=true][role=textbox][aria-label="Ask ChatGPT"]` with
  `data-composer-markdown`, `data-virtualkeyboard="true"`, inside a `<form>`. **Beware:** canvas/document editors on the
  same page are also `ProseMirror` textboxes (`aria-label="Start writing"`), so the composer must be selected by being
  inside the composer `<form>`, not by class alone. The label is localised, so prefer `data-composer-markdown`/form scope.
- **Generating:** a visible `button[aria-label="Stop"]` at the composer position, plus a `role="status"
  aria-label="Working"` indicator. Neither is present when idle.
- **Completed turn:** action buttons `Copy message` (user turns), `Copy` and `Regenerate response` (assistant turns).
  In the idle dump `Regenerate response` exists for every assistant turn; in the generating dump the latest turn has
  `Copy` but no `Regenerate response`.

**The old `data-message-author-role` attribute is gone** (0 matches). Messages now appear to be keyed by
`data-turn-key` (15 turns), `data-conversation-role`, `data-user-message-bubble`, `data-chatgpt-selection-message-id`
and `data-talvt-turn-state`, with assistant markdown in `data-markdown-copy` blocks. v1 did not capture their *values*
or the Send button (the composer was empty, and v1 only inspected the first two composer candidates, which were canvas
editors). Probe v2 captured those (`relay-probe-1791891609902.json` idle with text, `relay-probe-1791891654558.json` generating).

#### Final selectors (from v2; implemented in `src/extension/chatgpt-dom.ts`)
| Need | Selector / rule |
|---|---|
| Composer | Inside the visible `<form>`: `[contenteditable="true"][data-composer-markdown]` (fallback `[role="textbox"]`). Canvas editors are *not* in a form. |
| Send | `form button[type="submit"][aria-label="Send"]`; present and enabled only when the composer has text. |
| Stop / generating | While generating, the form's submit button is replaced by `button[type="button"][aria-label="Stop"]` (English label; `data-testid="stop-button"` also checked), and a `[role="status"][aria-label="Working"]` indicator appears. |
| Turns | `[data-turn-key]`. **The page contains hidden (`display:none`, zero-rect) duplicate turn lists**; only elements with a non-zero bounding box are the live thread. Turns scrolled off-screen still have a box, so visibility filtering is scroll-independent. |
| Role | `[data-conversation-role]` = `assistant` on the sr-only `h4` ("ChatGPT said:") inside an assistant turn; user turns contain `[data-user-message-bubble]`. |
| Completion | `[data-talvt-turn-state]` on the turn: `complete` when finished. Streaming values were **not** captured (the live turn was not among the sampled elements), so the code treats any non-`complete` value, a Stop button or a Working indicator as "not complete". |
| Message body | `[data-chatgpt-selection-message-id]` inside the turn (one per message; the last is taken). Read with `innerText`, which loses markdown syntax (code fences, `**bold**`); content survives. |
| Identity | URL path `/c/<uuid>`; title from `document.title`. |

Remaining unverified (needs the first live run): the streaming value of `data-talvt-turn-state`, whether
`document.execCommand('insertText')` (primary) or a synthetic paste (fallback) is accepted by ChatGPT's composer
without creating an attachment, and the exact text read from multi-message turns. The adapter verifies by read-back and
refuses to report success otherwise.

### Background tabs
Not directly measured. The content script reads DOM state and writes via `execCommand`, neither of which needs the tab
focused; Chrome may throttle timers in hidden tabs and can discard long-idle tabs. The hub reports `hidden` in state.

### How to run the browser probe
1. `chrome://extensions` (or `edge://extensions`) → enable Developer mode → **Load unpacked** →
   `probes/browser-probe` in this repository.
2. Open a conversation on claude.ai, click the extension icon → **Dump structure** → **Save .json**
   (save into `probes\reports\`). Repeat on chatgpt.com. Ideally capture each once idle and once mid-generation.

## Claude Desktop — Chat mode re-probe and insertion test (2026-10-13)
Scripts: `probes/uia-dump.ps1`, `uia-state.ps1`, `uia-insert-test.ps1` (never touches Send). Reports in `probes/reports/`.

**Chat mode differs from Code mode in names, not in approach.**
| Need | Chat mode finding |
|---|---|
| Conversation title | Inner `Document` (`RootWebArea`) Name = `<title> - Claude`. There is a **nested pair of `RootWebArea` documents**: the outer is unnamed, the inner carries the title. Pick the named one. Empty when minimised. |
| Messages | `Group` `Chat messages` > `Message 1 of 2`, `Message 2 of 2` (Chat uses "N of M"; Code mode used plain `Message N`). Each has an sr-only `You said: …` / `Claude responded: …` marker **and the full message text as a `Text` node inside the same group**. Much cleaner than Code mode. |
| Latest assistant reply | Last group whose marker starts `Claude responded`, plus its `Text` child(ren). Completion = the `Message actions` `ToolBar` (Copy, Read aloud, Good/Bad response, Retry, timestamp) is present in that group. |
| Composer | `Edit`, Name `Write your prompt to Claude` (Code mode: `Prompt`), class `tiptap ProseMirror`. **Find by ControlType=Edit + class containing `ProseMirror`, not by name.** An empty composer reads as 1 char (`\n`). |
| Send (idle) | `Button` named `Send message`; **`IsEnabled=False` when the composer is empty, `True` when it has text.** Detectable. |
| Stop (generating) | Absent when idle. `Stop` button + `Currently streaming message` group when generating (seen in Code mode). Chat-mode generating capture still pending. |

**Insertion via UIA `ValuePattern.SetValue` works** on a visible window that is not focused:
- Set `CrossTalk insertion test`. Read-back via `ValuePattern` and `TextPattern` matched exactly, the DOM `Text` node
  updated, and `Send message` flipped to enabled (so ProseMirror's own state updated, not just the DOM). The value was
  stable after 1.5 s. Foreground was not changed in the first run.
- Restore by `SetValue(<original>)`: composer returned to the exact 1-char original and Send went disabled again.
- Occluded by a maximised cmd window: same success. The foreground-changed flag read `true` in that run, but the
  occluder was a freshly launched process; treat as inconclusive. No evidence that `SetValue` takes focus.
- **Minimised: unreliable.** `SetValue` returned success, but the read-back still showed the old value and the write
  was applied **late**, after the window was restored. A relay must not write while Claude is minimised: restore the
  window first, write, then verify by read-back before reporting success.

**Foreground focus is not required** for read or write while the window is visible. Minimised needs a restore.
Start state of every run: composer empty (a "this is a test" draft seen in an earlier dump had been cleared); every
run ended with the composer back to that state. One minimised run briefly left the test text in the composer until
the late write was overwritten by the restore; I verified it ended empty.

**Verdict:** good enough to build the Claude Desktop adapter (read, identity by title, idle/Send/Stop detection,
insertion with read-back verification). Conversation id remains unavailable (title only).

## Claude Desktop — Chat vs Code, and the state rules now implemented (2026-10-13)
Evidence: `probes/uia-watch.ps1` (3 s timeline, ~100 ticks including four real generating→finished transitions in
Code sessions and an idle Chat), `probes/uia-capture-finish.ps1` (full dumps at each finish), earlier Chat dumps.
Implementation: `sidecar/uia-sidecar.ps1` (mode-aware; no architecture change).

### The bug
`Send` in **Code** mode is named `Send`, not `Send message` (Chat). The old adapter only looked for `Send message`,
so in Code mode it never saw the idle Send button and could never report idle. It also trusted a "Stop" button
**anywhere in the window**, which can be stale/unrelated (background-task chips etc.). I could not reproduce a stale
"Stop" in the captured finished states, so the old "generating" report may have come from a different stray element;
the new rule cannot be fooled that way (below).

### Differences
| | Chat | Code |
|---|---|---|
| Title | `<title> - Claude` | `<title> - Claude Code` |
| Mode toggle | not exposed in the idle Chat dump | `RadioButton` `Claude` / `Code` under `Group` `Mode` |
| Composer | `Edit` named `Write your prompt to Claude` | `Edit` named `Prompt` (both class `tiptap ProseMirror`) |
| Idle button | `Send message` | `Send` (disabled when composer empty) |
| Generating button | (`Stop`, same position) | `Stop` |
| Reply layout | Reply text **inside** its `Message N of M` group | `Message N` group holds only the speaker marker (+ first tool row); **the prose is loose siblings after it**, interleaved with tool-call rows |
| Tool rows | n/a | `Group` with a `Button` named `Ran …` / `Used N tools` / `Edited …`; narration before them is not the final answer |
| Extras | | sidebar rows `Running/Idle/Awaiting input <title>`; `Clawd: …` mascot images; `Cache refreshing while the turn runs` ↔ `Cache warm…`; `Working…`, `awaiting approval` texts |
| Message list | virtualised; messages far above are absent | same, plus `Load earlier messages` |

### Signals: which are reliable (observed through four Code finishes)
| Signal | Behaviour at finish | Verdict |
|---|---|---|
| Composer's own button `Stop` → `Send` | flips exactly with the run | **Primary. Reliable.** |
| Any `Stop` elsewhere in the window | may exist independently | **Ignored** (only the button nearest the composer counts) |
| `Currently streaming message` group | appears seconds *after* start, vanishes at finish | Fallback only |
| `Claude is responding` status | appears with `Stop`, vanishes at finish | Corroborating only (also present offscreen) |
| `Message actions` toolbar | present on **earlier** replies all the time; on the newest reply it appears at finish but later **disappeared** while idle | **Not a completion signal** |
| `Cache refreshing…` / `Clawd: typing` | track the run, but cosmetic | Not used |
| Sidebar `Running`/`Idle`/`Awaiting input` | app-authored per session | Not used (title mapping fragile); useful for a future "needs-user" state |

### Rules implemented
* **mode** = title suffix (`- Claude Code` / `- Claude`), else composer name (`Prompt` / `Write your prompt…`).
* **generating** = the button nearest the composer (walk up from the composer, nearest ancestor containing an exact
  `Stop`/`Stop response`/`Send`/`Send message` button) is `Stop`. If no such button exists, fall back to any `Stop` or the
  streaming group. **idle** = composer found, not generating, window not minimised.
* **latest reply** = last unit (assistant `Message` group + loose siblings that follow), only if that unit is an
  assistant one. Text is rebuilt from runs: `ListItem` uses its full `Name`; `Text` runs use their `Name`; empty-name
  `Text` wrappers (inline code) are descended; file-chip buttons and hyperlinks are inline; paragraph vs inline joining uses
  bounding rectangles; `Download x.png` overlays and toolbars are dropped; in Code mode a tool row resets the buffer so
  only the final prose after the last tool call is kept. Two reads 400 ms apart must agree or the read fails as `unstable-response`.
* **insert** (both modes): `ValuePattern.SetValue`, read-back, normalised-whitespace comparison, composer restored on mismatch.
  Refuses when minimised or when a draft exists (unless overwrite).

### Verification (live)
| Check | Result |
|---|---|
| Code, finished session | `Send`, `generating=false`, `idle=true` (4 sessions) |
| Code, running session | `Stop`, `generating=true`, `read` refused as `source-generating` |
| Code, read latest reply | OK: 2.1–3.0k chars, paragraphs/lists preserved, tool rows and attachment labels dropped |
| Code, insert + read-back + cleanup | verified exact (52 chars, multi-paragraph); composer returned to empty, Send disabled |
| Chat, idle | Re-verified live afterwards — see "Claude Desktop Chat mode — final verification" below |

## Claude Desktop Chat mode — final verification (2026-10-13)
Idle Chat conversation ("Idle chat - Claude"), new mode-aware sidecar:
| Check | Result |
|---|---|
| Mode / title | `chat` / `Idle chat - Claude` |
| State | composer button `Send message` (disabled, empty composer), `generating=false`, `idle=true` |
| Read latest reply | OK; two paragraphs separated by a blank line, curly quotes/apostrophes preserved. (This reply contained no list; list handling was verified on Code replies.) |
| Multi-line insert (paragraphs, `- ` lines, curly quotes, em dash, emoji) | `verified=true, exact=true` (77 chars); Send flipped to enabled |
| Restore | composer back to empty, `Send message` disabled, idle — identical to the starting state |

## First manual relay: Claude Desktop ⇄ ChatGPT Browser (2026-10-13) — PASSED, nothing sent
Live, through the hub API (`/api/link`, `/api/relay`) with the real extension connected to a real ChatGPT tab
(a project conversation) and Claude Desktop on an idle Chat conversation:
* **Claude → ChatGPT:** read Claude's latest completed reply (333 chars), inserted into the ChatGPT composer,
  read-back `verified=true, exact=true`; ChatGPT's Send button became enabled (the editor accepted the text as real
  input, not just DOM text). `execCommand('insertText')` was sufficient; no paste fallback or attachment conversion.
* **ChatGPT → Claude:** read ChatGPT's latest completed reply (1770 chars; the code-block caption "Plain text" is
  included, as `innerText` sees it), inserted into the Claude composer, `verified=true, exact=true`, Send enabled.
* The `data-talvt-turn-state` completion rule and the "turn is the last visible assistant turn" logic returned a
  complete reply on an idle tab. Still unobserved live: the streaming value of that attribute; a mid-generation relay
  attempt was not exercised.
* The ChatGPT tab was in the background during the run (the hub reported it); reads and writes worked.

## Controlled automatic relay (human clicks Send) — PASSED live
`src/core/machine.ts`: detect a new completed reply on the expected side, SHA-256 fingerprint, dedupe, insert into the
other composer, verify by read-back, stop at `READY_TO_SEND_*`; the human clicks SEND TO CHATGPT / SEND TO CLAUDE. Verified
on a real Claude Desktop ⇄ ChatGPT pair in both directions, with `submit` implemented as UIA `InvokePattern` on the
composer's Send button (Claude) and a click on `button[type=submit]` (ChatGPT), each refusing unless the composer still
holds exactly the relay text. Code and Chat modes both work as the Claude side.

## Automatic submission (AUTO SEND, default OFF) — live results
Each draft inserted while AUTO SEND is ON gets a 2 s countdown (Cancel / Pause stop it), then re-checks identity of both
sides, destination idle + draft present, source not generating, source reply still equal to the inserted one, hop limit,
no error/intervention state; any failure pauses with the reason. Observed in one live run (the user's Max hops was left at the
default 20, so the run did not stop after one cycle):
* **8 automatic submits** (4 each direction) succeeded in a row, each ~2 s after insertion, with correct alternation,
  dedupe, hop counting and event-log entries.
* **Two safety blocks, nothing sent, link paused:** `the source reply is not the one that was inserted` (hop 1 and hop 10).
  The re-read of the source reply 2 s after insertion produced a different fingerprint than the first read. Cause not
  yet determined (the evidence was not captured: the log only recorded "differs"). Candidates: the page re-rendering a
  just-finished reply (ChatGPT) or bounding-rectangle-dependent paragraph joining shifting when the destination composer
  grows (Claude Desktop). Reads taken minutes later were stable. Planned follow-up: log both fingerprints, lengths and the
  first differing position on this block, and allow one settle-and-retry before blocking.
* **Guard fired correctly** when the ChatGPT composer already held text (`USER_INTERVENTION_REQUIRED`, no overwrite).
* Lesson: run the first live auto cycle with Max hops = 2 and verify the value before sending the prompt.

## Auto-send hardening + 2-hop live cycle (2026-10-13) — PASSED
**Changes** (`src/core/machine.ts`, `src/shared/text.ts`, `src/core/policy.ts`):
* Pre-send source re-check: on any fingerprint mismatch, log full diagnostics (provider/surface, both SHA-256 hashes,
  both lengths, first differing raw and canonical position, escaped context, whitespace-only flag, source and
  destination state), settle ~900 ms, take two further reads; send only if they agree with each other **and** the original.
  Otherwise pause. The guard is not weakened.
* Fingerprint = SHA-256 of the reply with all whitespace removed (`canonical()`), applied identically to the original and
  every re-read. Rationale: the only layout-dependent step in the adapters is whitespace (Claude Desktop joins runs as
  paragraph or inline from on-screen rectangles, which can differ between a read taken right at completion and one taken
  later; ChatGPT `innerText` whitespace follows rendering). Any changed character still changes the hash (tested: `l`→`I`).
  The cause of the two earlier false blocks was **not** reproduced, so this is a deterministic mitigation of the most likely
  cause, backed by diagnostics that will identify any other.
* First-run hop safety: default Max hops is 2; the Start panel shows `AUTO SEND ON/OFF · MAX HOPS: n`; AUTO SEND with
  more than 2 hops needs one explicit confirmation (enforced server-side, remembered in `%APPDATA%\crosstalk\settings.json`,
  and the last chosen value is kept thereafter).
* 42 unit tests (10 new: settled retry matches, both reads differ, unstable settled reads, whitespace-only, one-character
  change blocks, diagnostics contents, default hops, hop-policy confirmation).

**Live run:** Max hops 2, AUTO SEND ON (3 s countdown), prompt sent in Claude Chat by the user:
Claude reply (1068 chars) → inserted, verified, auto-sent to ChatGPT → ChatGPT reply (360 chars) → inserted, verified,
auto-sent to Claude → Claude replied → **paused on the hop limit, nothing further sent.** No mismatch occurred, so the
diagnostic/settle path was exercised only by unit tests, not live. Both composers were empty afterwards.
