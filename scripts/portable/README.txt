CrossTalk (portable)
====================

Local two-way relay between one Claude Desktop conversation and one ChatGPT browser conversation.
Nothing to install: Node.js is included. Windows 10/11 (x64), Claude Desktop, and Chrome or Edge are needed.

WINDOWS WARNING (expected)
  This download is not code-signed. Windows may show "Windows protected your PC" (SmartScreen) or
  "Open File - Security Warning" when you run Start CrossTalk.cmd. If you downloaded the ZIP from this
  project's official Releases page, choose "More info" > "Run anyway" (or "Run"). The bundled node.exe is the
  unmodified, signed official Node.js build.

START
  1. Extract the whole ZIP somewhere (not inside the ZIP viewer).
  2. Double-click "Start CrossTalk.cmd".
  3. The dashboard opens at http://127.0.0.1:17321/ . Keep the console window open;
     closing it (or Ctrl+C) stops CrossTalk. If CrossTalk is already running, the launcher
     just opens its dashboard and closing the launcher does not stop that one.

BROWSER EXTENSION (one time)
  The dashboard top banner shows "Browser extension: CONNECTED / NOT CONNECTED".
  If NOT CONNECTED:
    1. Open chrome://extensions (or edge://extensions)
    2. Turn on Developer mode
    3. Load unpacked -> choose the "app\extension" folder inside this package
       (keep this folder where it is; if you move it, load the extension again)
    4. Keep Chrome / Edge running. Reconnecting can take up to 30 seconds.

USE
  Open a ChatGPT conversation in a tab and a Claude Desktop conversation (Chat or Code),
  pick the ChatGPT tab in the dashboard and click Link, then use the manual buttons or the
  "Controlled automatic relay" panel. By default YOU press Send. AUTO SEND is off by default;
  Max hops defaults to 2.

WARNING
  Anthropic's and OpenAI's consumer terms restrict automated access and programmatic
  extraction of output. This tool automates their user interfaces on your own computer under
  your own login and may put your accounts at risk. Use at your own risk.

PRIVACY
  Everything runs on your PC (127.0.0.1 only). No API keys, no passwords stored, no telemetry.
  CrossTalk stores its link/settings in %APPDATA%\crosstalk\ . It makes no registry changes and
  needs no administrator rights.

LICENSES
  CrossTalk: MIT (LICENSE). Bundled third-party software: THIRD-PARTY-NOTICES.txt and
  runtime\LICENSE-node.txt.
