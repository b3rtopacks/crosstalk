# Contributing

Collaboration is welcome — thank you for helping. CrossTalk drives other apps' screens, so most changes need real evidence, not guesses.

## Ways to help
- **Bugs and ideas:** open a GitHub Issue (use the templates).
- **Bigger changes** (a new provider such as Claude Web, ChatGPT Desktop or Gemini; a new feature; anything touching the safety checks): please **open an Issue first** so the approach can be agreed before you invest time.
- **Small fixes** (typos, wording, clear bug fixes, tests): go straight to a **Pull Request**.
- **How to send a PR:** fork the repository, create a branch, make your change, and open a Pull Request against `master`.
- **Questions, ideas, collaboration offers, requests for providers or platforms** (for example Gemini or macOS): use GitHub Discussions if the repository has it enabled, otherwise an Issue.

## Never post private data
In Issues, Pull Requests, logs and screenshots **never include private conversation text, credentials, tokens, cookies, browser data, personal information, usernames, emails or local paths.** Replace anything private with `[redacted]`. See [SECURITY.md](SECURITY.md).

## Setup
Node.js 22+.
```
npm install
npm run build
npm test            # unit tests
npx tsc --noEmit    # typecheck
npm start           # hub + dashboard on http://127.0.0.1:17321/
npm run package     # portable ZIP into release/
```

## Rules for code changes
- **Adapter changes need evidence from the current UI structure.** Use the tools in `probes/` (UI Automation dump scripts and the browser probe extension) on the app version you are targeting, and describe what you saw in `docs/FINDINGS.md`. Do not hard-code selectors from memory.
- Keep site-specific logic isolated: ChatGPT DOM knowledge lives in `src/extension/chatgpt-dom.ts`, Claude Desktop knowledge in `sidecar/uia-sidecar.ps1`.
- Safety first: anything unexpected should pause, error or ask the user — never guess. Do not weaken the pre-send checks just to reduce pauses.
- Add or update unit tests for state-machine changes (`src/core/*.test.ts`).
- **Do not commit** conversation captures, probe reports, credentials, cookies, browser data or personal paths. `probes/reports/`, `release/`, `dist/` and `node_modules/` are git-ignored; keep it that way.
- Keep changes small, and keep the README honest about what is actually verified.

## Pull request checklist
- What changed, and how you tested it (include the app and browser versions).
- `npm test` and `npx tsc --noEmit` pass.
- No private text in logs, screenshots or code.
