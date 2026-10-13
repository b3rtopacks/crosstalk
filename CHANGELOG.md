# Changelog

## v0.1.0 — Windows preview (first public release)

First public preview. Verified on Windows 11 with Claude Desktop (Chat and Code) and ChatGPT in Chrome.

**Added**
- Relay between one Claude Desktop conversation and one ChatGPT browser conversation, local only, no API keys.
- Claude Desktop adapter through Windows UI Automation (Chat and Code modes); ChatGPT adapter through a Chrome/Edge extension.
- Manual relay buttons; controlled automatic relay (detects each new completed reply, inserts it into the other composer and verifies it by read-back; you click Send).
- Optional AUTO SEND (off by default) with countdown, cancel, pre-send checks and a hop limit (default 2).
- Duplicate suppression (SHA-256 of each relayed reply), strict alternation, identity checks, pause/resume/reset, event log.
- Windows launcher (`Start CrossTalk.cmd`) and a portable ZIP that bundles its own Node.js runtime (no install needed).
- Dashboard banner showing whether the browser extension is connected.

**Known issues**
- Windows only; one linked pair; unpacked extension; Claude in the browser and ChatGPT Desktop are not supported.
- Not code-signed; Windows SmartScreen may warn about the downloaded ZIP.
- In one early 10-hop AUTO SEND test, two sends were safely blocked by a source re-read mismatch whose cause was not reproduced.
