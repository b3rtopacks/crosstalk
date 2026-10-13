# Security

## What CrossTalk does and does not touch
CrossTalk runs only on your PC. It listens on `127.0.0.1`, stores no passwords or API keys, and has no telemetry or hosted backend.
Other programs running as you on the same PC can reach its local dashboard port, so only run it on a PC you trust.

## Reporting a vulnerability
Please **do not open a public issue** for a security problem. Report it privately using GitHub's
"Report a vulnerability" button on this repository's **Security** tab (private vulnerability reporting).
If that is not available yet, open a public issue that says only "I have a security report" with **no details**, and a maintainer will arrange a private channel.

## Reporting bugs safely (important)
Issues are public. Before posting logs, screenshots or probe dumps:
- **Never include private conversation text.** Replace it with `[redacted]`.
- Remove conversation titles, URLs with conversation IDs, usernames, email addresses and local paths.
- Never post cookies, tokens, passwords or API keys.
- Probe reports (`probes/reports/`) contain conversation text. Do not attach them unredacted.
