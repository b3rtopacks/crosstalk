# CrossTalk UIA sidecar: Claude Desktop (Windows), Chat AND Code modes, over JSON lines on stdin/stdout.
# Windows PowerShell 5.1 (powershell.exe). One request per line: {"id":1,"cmd":"state"|"read"|"insert", ...}
# One response per line: {"id":1,"ok":true,"result":{...}} or {"id":1,"ok":false,"error":"code","detail":"..."}
# Presses Send ONLY for the explicit "submit" command (human-approved from the hub), never on its own.
# Never touches the clipboard. Never changes window state.
#
# Mode-aware rules (derived from live captures; see docs/FINDINGS.md):
#   mode        : title suffix " - Claude Code" => code; else composer name "Prompt" => code,
#                 "Write your prompt to Claude" => chat.
#   generating  : the composer's own action button is "Stop" (found by walking up from the composer, nearest first).
#                 A stray "Stop" elsewhere (background tasks etc.) is ignored. "Send"/"Send message" => not generating.
#   reply       : the last assistant unit = the assistant "Message N" group plus the loose siblings that follow it
#                 (Code mode keeps its prose outside the group). Code mode keeps only the text after the last tool-call group.
param([string]$ProcessName = 'claude')
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class RelayWin { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }
'@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]
$CT = [System.Windows.Automation.ControlType]
$ANY = [System.Windows.Automation.Condition]::TrueCondition
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$TOOL_RE = '^(Ran|Used|Edited|Read|Wrote|Created|Searched|Fetched|Explored|Updated|Deleted|Listed|Thought)\b'
$DOWNLOAD_RE = '^Download .+\.\w{2,5}$'
$CONT_RE = '^[\s,.;:!?)\]]'
$NL = [string][char]10

class RelayError : System.Exception {
  [string]$Code
  RelayError([string]$code, [string]$msg) : base($msg) { $this.Code = $code }
}

function Get-Win {
  $pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if (-not $pids) { throw [RelayError]::new('not-running', 'Claude Desktop is not running') }
  foreach ($w in $AE::RootElement.FindAll($TS::Children, $ANY)) {
    if ($pids -contains $w.Current.ProcessId -and $w.Current.ClassName -eq 'Chrome_WidgetWin_1') { return $w }
  }
  throw [RelayError]::new('no-window', 'Claude Desktop window not found')
}

# Chromium only builds the web accessibility tree after a UIA client asks; wait for it.
function Wait-Tree($win) {
  $cond = New-Object $PC ($AE::AutomationIdProperty, 'RootWebArea')
  for ($i = 0; $i -lt 12; $i++) {
    if ($win.FindFirst($TS::Descendants, $cond)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw [RelayError]::new('tree-not-ready', 'Claude accessibility tree not available yet')
}

function Find-ByName($root, [string]$name, $ctype) {
  $c = New-Object $PC ($AE::NameProperty, $name)
  if ($ctype) { $c = New-Object System.Windows.Automation.AndCondition($c, (New-Object $PC ($AE::ControlTypeProperty, $ctype))) }
  return $root.FindFirst($TS::Descendants, $c)
}

function Get-Title($win) {
  foreach ($d in $win.FindAll($TS::Descendants, (New-Object $PC ($AE::AutomationIdProperty, 'RootWebArea')))) {
    $n = [string]$d.Current.Name
    if ($n) { return $n }
  }
  return ''
}

function Get-Composer($win) {
  foreach ($e in $win.FindAll($TS::Descendants, (New-Object $PC ($AE::ControlTypeProperty, $CT::Edit)))) {
    if ($e.Current.ClassName -like '*ProseMirror*') { return $e }
  }
  return $null
}

function Read-Composer($c) { [string]$c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }

# "Empty" composer reads as a lone newline.
function Test-Blank([string]$s) { return ($s -replace '[\s ]+', '') -eq '' }

function Get-Mode([string]$title, $comp) {
  if ($title -match ' - Claude Code$') { return 'code' }
  if ($title -match ' - Claude$') { return 'chat' }
  if ($comp) {
    $n = [string]$comp.Current.Name
    if ($n -eq 'Prompt') { return 'code' }
    if ($n -like 'Write your prompt*') { return 'chat' }
  }
  return 'unknown'
}

# The composer's own Send/Stop button: nearest ancestor of the composer that contains one (exact names only).
function Get-ComposerAction($comp) {
  if (-not $comp) { return $null }
  $names = New-Object 'System.Collections.Generic.List[System.Windows.Automation.Condition]'
  foreach ($n in 'Stop', 'Stop response', 'Send', 'Send message') { $names.Add((New-Object $PC ($AE::NameProperty, $n))) }
  $cond = New-Object System.Windows.Automation.AndCondition((New-Object $PC ($AE::ControlTypeProperty, $CT::Button)), (New-Object System.Windows.Automation.OrCondition($names.ToArray())))
  $p = $walker.GetParent($comp)
  for ($i = 0; $i -lt 6 -and $p -ne $null; $i++) {
    $btns = $p.FindAll($TS::Descendants, $cond)
    if ($btns.Count -gt 0) {
      foreach ($b in $btns) { if (-not $b.Current.IsOffscreen) { return $b } }
      return $btns[0]
    }
    $p = $walker.GetParent($p)
  }
  return $null
}

# Conversation as units: user/assistant "Message N" group + the loose siblings that follow it.
function Get-Units($win) {
  $chat = Find-ByName $win 'Chat messages' $CT::Group
  if (-not $chat) { return @() }
  $units = New-Object System.Collections.ArrayList
  $cur = $null
  $ch = $walker.GetFirstChild($chat)
  while ($ch -ne $null) {
    if ($ch.Current.Name -match '^Message \d+( of \d+)?$') {
      $role = ''
      $m = $walker.GetFirstChild($ch)
      while ($m -ne $null) {
        if ($m.Current.ClassName -eq 'sr-only select-none') {
          $n = [string]$m.Current.Name
          if ($n -like 'You said*') { $role = 'user' } elseif ($n -like 'Claude responded*') { $role = 'assistant' }
          break
        }
        $m = $walker.GetNextSibling($m)
      }
      $cur = [pscustomobject]@{ Role = $role; Els = (New-Object System.Collections.ArrayList) }
      [void]$cur.Els.Add($ch)
      [void]$units.Add($cur)
    } elseif ($cur -ne $null) { [void]$cur.Els.Add($ch) }
    $ch = $walker.GetNextSibling($ch)
  }
  return $units.ToArray()
}

# A Code-mode tool-call row ("Ran 3 commands", "Used 4 tools", ...): a Group holding a Button with such a name.
function Test-ToolGroup($g) {
  foreach ($b in $g.FindAll($TS::Descendants, (New-Object $PC ($AE::ControlTypeProperty, $CT::Button)))) {
    if ([string]$b.Current.Name -match $TOOL_RE) { return $true }
  }
  return $false
}

# Visible message text, rebuilt from "runs" in document order:
#   - ListItem: its own Name is the complete item text (inline code and file chips included) -> one "- " line.
#   - Text with a Name: that text. Text with an empty Name: inline wrapper (e.g. code span) -> descend.
#   - Hyperlink and file-chip Buttons (class "inline box-decoration...") contribute their Name inline.
#   - Skipped: sr-only speaker marker, actions toolbar, status regions, other buttons, images, "Download x.png" cards.
#   - Code mode: a tool-call group ("Ran 3 commands", "Used 4 tools") resets the buffer, keeping only the final prose.
# Paragraph vs inline joining uses bounding rectangles: a run that starts inside the previous run's vertical extent
# continues it; otherwise it starts a new block. Off-screen runs (no rectangle) fall back to whitespace/punctuation.
function Add-Run($runs, [string]$text, $el, [string]$kind) {
  $top = [double]::NaN; $bottom = [double]::NaN
  if (-not $el.Current.IsOffscreen) {
    $r = $el.Current.BoundingRectangle
    if (-not [double]::IsInfinity($r.Top) -and $r.Height -gt 0) { $top = $r.Top; $bottom = $r.Bottom }
  }
  [void]$runs.Add([pscustomobject]@{ Text = $text; Kind = $kind; Top = $top; Bottom = $bottom })
}

function Get-ElRuns($el, $runs, [bool]$code) {
  $t = $el.Current.ControlType.ProgrammaticName
  $cls = [string]$el.Current.ClassName
  $name = [string]$el.Current.Name
  if (($t -in 'ControlType.ToolBar', 'ControlType.StatusBar', 'ControlType.Image') -or $cls -eq 'sr-only select-none') { return }
  if ($t -eq 'ControlType.Button') {
    if ($cls -like 'inline box-decoration*' -and $name) { Add-Run $runs $name $el 'inline' }
    return
  }
  if ($t -eq 'ControlType.ListItem' -and $name) { Add-Run $runs $name $el 'item'; return }
  if (($t -eq 'ControlType.Text' -or $t -eq 'ControlType.Hyperlink') -and $name -match $DOWNLOAD_RE) { return }
  if ($t -eq 'ControlType.Text' -and $name) { Add-Run $runs $name $el 'text'; return }
  if ($t -eq 'ControlType.Hyperlink' -and $name) { Add-Run $runs $name $el 'inline'; return }
  if ($code -and $t -eq 'ControlType.Group' -and (Test-ToolGroup $el)) { $runs.Clear(); return }
  $c = $walker.GetFirstChild($el)
  while ($c -ne $null) { Get-ElRuns $c $runs $code; $c = $walker.GetNextSibling($c) }
}

function Join-Runs($runs) {
  $sb = New-Object System.Text.StringBuilder
  $prev = $null
  foreach ($r in $runs) {
    if ($prev -ne $null) {
      $sep = ''
      if ($r.Kind -eq 'item') { $sep = $NL }
      elseif ($prev.Kind -eq 'item') { $sep = $NL + $NL }
      else {
        $cont = $false
        if ($r.Kind -eq 'inline') { $cont = $true }
        elseif (-not [double]::IsNaN($r.Top) -and -not [double]::IsNaN($prev.Bottom)) { $cont = ($r.Top -lt ($prev.Bottom - 2)) }
        else {
          $last = $sb.ToString()
          $lc = if ($last.Length) { $last[$last.Length - 1] } else { ' ' }
          $cont = ([char]::IsWhiteSpace($lc) -or ($r.Text -match $CONT_RE))
        }
        if (-not $cont) { $sep = $NL + $NL }
      }
      [void]$sb.Append($sep)
    }
    if ($r.Kind -eq 'item') { [void]$sb.Append('- ') }
    [void]$sb.Append($r.Text)
    $prev = $r
  }
  return $sb.ToString().Trim()
}

function Get-UnitText($unit, [bool]$code) {
  $runs = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $unit.Els.Count; $i++) {
    $el = $unit.Els[$i]
    if ($code -and $i -gt 0 -and $el.Current.ControlType.ProgrammaticName -eq 'ControlType.Group' -and (Test-ToolGroup $el)) { $runs.Clear(); continue }
    Get-ElRuns $el $runs $code
  }
  return (Join-Runs $runs)
}

function Get-State {
  $win = Get-Win
  $hwnd = [IntPtr]$win.Current.NativeWindowHandle
  $vs = [string]$win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState
  Wait-Tree $win
  $title = Get-Title $win
  $comp = Get-Composer $win
  $mode = Get-Mode $title $comp
  $act = Get-ComposerAction $comp
  $actName = if ($act) { [string]$act.Current.Name } else { '' }
  $units = @(Get-Units $win)
  $last = if ($units.Count) { $units[$units.Count - 1] } else { $null }
  # Primary signal: the composer's action button. Fallback (no button found): any Stop / streaming group.
  if ($act) { $generating = ($actName -like 'Stop*') }
  else {
    $anyStop = [bool]$win.FindFirst($TS::Descendants, (New-Object $PC ($AE::NameProperty, 'Stop')))
    $generating = $anyStop -or [bool](Find-ByName $win 'Currently streaming message' $null)
  }
  $sendEnabled = if ($act -and $actName -like 'Send*') { [bool]$act.Current.IsEnabled } else { $null }
  return [ordered]@{
    title = $title
    mode = $mode
    minimised = ($vs -eq 'Minimized')
    foreground = ([RelayWin]::GetForegroundWindow() -eq $hwnd)
    composerFound = [bool]$comp
    composerBlank = if ($comp) { Test-Blank (Read-Composer $comp) } else { $null }
    composerAction = $actName
    sendEnabled = $sendEnabled
    generating = $generating
    unitCount = $units.Count
    lastRole = if ($last) { $last.Role } else { '' }
    idle = ([bool]$comp -and (-not $generating) -and ($vs -ne 'Minimized'))
  }
}

function Do-Read {
  $win = Get-Win
  Wait-Tree $win
  $st = Get-State
  if ($st.generating) { throw [RelayError]::new('source-generating', 'Claude is still generating') }
  $code = ($st.mode -eq 'code')
  $units = @(Get-Units $win)
  if ($units.Count -eq 0 -or $units[$units.Count - 1].Role -ne 'assistant') {
    throw [RelayError]::new('no-completed-response', 'The newest message is not an assistant reply')
  }
  # Stability guard: the text must be identical across two reads a moment apart (stream just ended?).
  $text = Get-UnitText $units[$units.Count - 1] $code
  Start-Sleep -Milliseconds 400
  $st2 = Get-State
  if ($st2.generating) { throw [RelayError]::new('source-generating', 'Claude started generating again') }
  $units2 = @(Get-Units $win)
  $text2 = if ($units2.Count) { Get-UnitText $units2[$units2.Count - 1] $code } else { '' }
  if ($text -ne $text2) { throw [RelayError]::new('unstable-response', 'Reply text is still changing; try again in a moment') }
  if (-not $text) { throw [RelayError]::new('empty-response', 'Latest reply text could not be read') }
  return [ordered]@{ title = $st.title; text = $text; mode = $st.mode }
}

function Norm([string]$s) { return ($s -replace '[\s ]+', ' ').Trim() }

function Do-Insert($req) {
  $win = Get-Win
  $vs = [string]$win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState
  if ($vs -eq 'Minimized') { throw [RelayError]::new('minimised', 'Claude Desktop is minimised; restore the window (writes are applied late while minimised)') }
  Wait-Tree $win
  $comp = Get-Composer $win
  if (-not $comp) { throw [RelayError]::new('no-composer', 'Claude composer not found') }
  $orig = Read-Composer $comp
  if (-not (Test-Blank $orig) -and -not $req.overwrite) {
    throw [RelayError]::new('composer-not-empty', 'The Claude composer already has a draft; clear it or tick overwrite')
  }
  $text = [string]$req.text
  $vp = $comp.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vp.SetValue($text)
  $want = Norm $text
  $got = ''
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 250
    $got = Read-Composer (Get-Composer $win)
    if ((Norm $got) -eq $want) { break }
  }
  $verified = ((Norm $got) -eq $want)
  $act = Get-ComposerAction (Get-Composer $win)
  $res = [ordered]@{
    verified = $verified
    exact = ($got -eq $text)
    wantedChars = $text.Length
    readBackChars = $got.Length
    sendEnabled = if ($act -and ([string]$act.Current.Name) -like 'Send*') { [bool]$act.Current.IsEnabled } else { $false }
  }
  if (-not $verified) {
    try { $vp.SetValue($orig) } catch {}   # put the composer back
    throw [RelayError]::new('verify-failed', "Read-back did not match (wanted $($text.Length) chars, got $($got.Length)); composer restored")
  }
  return $res
}

# Press the composer's Send button. Only reachable from the hub's human-approved SEND action.
# Refuses unless: window not minimised, the composer button is an enabled Send, and the draft is exactly expectText.
function Do-Submit($req) {
  $win = Get-Win
  $vs = [string]$win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState
  if ($vs -eq 'Minimized') { throw [RelayError]::new('minimised', 'Claude Desktop is minimised; restore the window') }
  Wait-Tree $win
  $comp = Get-Composer $win
  if (-not $comp) { throw [RelayError]::new('no-composer', 'Claude composer not found') }
  $act = Get-ComposerAction $comp
  if (-not $act -or ([string]$act.Current.Name) -notlike 'Send*') { throw [RelayError]::new('not-sendable', 'Claude is not ready to send (no Send button; is it generating?)') }
  if (-not $act.Current.IsEnabled) { throw [RelayError]::new('not-sendable', 'Claude Send button is disabled') }
  if ((Norm (Read-Composer $comp)) -ne (Norm ([string]$req.expectText))) { throw [RelayError]::new('draft-changed', 'The Claude draft no longer matches what the relay inserted; not sending') }
  $act.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    $c2 = Get-Composer $win
    $a2 = Get-ComposerAction $c2
    $blank = if ($c2) { Test-Blank (Read-Composer $c2) } else { $false }
    if ($blank -or ($a2 -and ([string]$a2.Current.Name) -like 'Stop*')) { return [ordered]@{ submitted = $true } }
  }
  throw [RelayError]::new('submit-unconfirmed', 'Pressed Send but the composer did not clear and no generation started')
}

function Do-Clear {
  $win = Get-Win
  $vs = [string]$win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState
  if ($vs -eq 'Minimized') { throw [RelayError]::new('minimised', 'Claude Desktop is minimised; restore the window') }
  Wait-Tree $win
  $comp = Get-Composer $win
  if (-not $comp) { throw [RelayError]::new('no-composer', 'Claude composer not found') }
  $comp.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('')
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Blank (Read-Composer (Get-Composer $win))) { return [ordered]@{ cleared = $true } }
  }
  throw [RelayError]::new('clear-failed', 'Composer did not clear')
}

$reader = [Console]::In
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.cmd) {
      'ping'   { $r = [ordered]@{ pong = $true } }
      'state'  { $r = Get-State }
      'read'   { $r = Do-Read }
      'insert' { $r = Do-Insert $req }
      'submit' { $r = Do-Submit $req }
      'clear'  { $r = Do-Clear }
      default  { throw [RelayError]::new('bad-command', "unknown cmd $($req.cmd)") }
    }
    $resp = [ordered]@{ id = $id; ok = $true; result = $r }
  } catch {
    $ex = $_.Exception
    $code = if ($ex -is [RelayError]) { $ex.Code } else { 'sidecar-error' }
    $resp = [ordered]@{ id = $id; ok = $false; error = $code; detail = $ex.Message }
  }
  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
