# Read-only state probe for Claude Desktop. Reports what a UIA adapter would see.
# Usage: powershell -NoProfile -File uia-state.ps1 [-Tag label]
param([string]$ProcessName = 'claude', [string]$Tag = '')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }
'@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]
$pids = @(Get-Process -Name $ProcessName | ForEach-Object { $_.Id })
$sw = [Diagnostics.Stopwatch]::StartNew()
$win = $null
foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($pids -contains $w.Current.ProcessId -and $w.Current.ClassName -eq 'Chrome_WidgetWin_1') { $win = $w; break }
}
$o = [ordered]@{ tag = $Tag }
if (-not $win) { $o.window = 'NOT FOUND'; $o | ConvertTo-Json; return }
$hwnd = [IntPtr]$win.Current.NativeWindowHandle
$o.windowName = $win.Current.Name
$o.isForeground = ([W]::GetForegroundWindow() -eq $hwnd)
$o.isIconic = [W]::IsIconic($hwnd)
$o.visualState = [string]$win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState

$doc = $win.FindFirst($TS::Descendants, (New-Object $PC ($AE::AutomationIdProperty, 'RootWebArea')))
$o.documentFound = [bool]$doc
if ($doc) { $o.conversationTitle = $doc.Current.Name }

$edit = $win.FindFirst($TS::Descendants, (New-Object $PC ($AE::NameProperty, 'Prompt')))
$o.composerFound = [bool]$edit
if ($edit) {
  $o.composerControlType = $edit.Current.ControlType.ProgrammaticName
  $o.composerClass = $edit.Current.ClassName
  try { $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $o.composerValueLen = $vp.Current.Value.Length; $o.composerReadOnly = $vp.Current.IsReadOnly } catch { $o.composerValuePattern = "ERR $_" }
  $o.composerOffscreen = $edit.Current.IsOffscreen
  $o.composerKeyboardFocusable = $edit.Current.IsKeyboardFocusable
}
foreach ($n in 'Stop', 'Send', 'Send message') {
  $b = $win.FindFirst($TS::Descendants, (New-Object $PC ($AE::NameProperty, $n)))
  $o["button_$n"] = if ($b) { 'present enabled=' + $b.Current.IsEnabled + ' offscreen=' + $b.Current.IsOffscreen } else { 'absent' }
}
$o.streamingGroup = [bool]$win.FindFirst($TS::Descendants, (New-Object $PC ($AE::NameProperty, 'Currently streaming message')))

$chat = $win.FindFirst($TS::Descendants, (New-Object $PC ($AE::NameProperty, 'Chat messages')))
$o.chatMessagesFound = [bool]$chat
if ($chat) {
  $msgs = $chat.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $o.chatChildren = $msgs.Count
  $groups = @($msgs | Where-Object { $_.Current.Name -match '^Message \d+$' })
  $o.messageGroups = $groups.Count
  # sr-only speaker markers: "You said: ..." / "Claude responded: ..."
  $roles = @()
  foreach ($g in $groups) {
    $t = $g.FindFirst($TS::Children, (New-Object $PC ($AE::ClassNameProperty, 'sr-only select-none')))
    if ($t) { $roles += (($t.Current.Name -split ':')[0]) }
  }
  $o.roleSequence = $roles -join ' | '
  # newest assistant text = Text siblings after the last "Claude responded" group (heuristic)
  $lastIdx = -1; for ($i = 0; $i -lt $msgs.Count; $i++) { if ($msgs[$i].Current.Name -match '^Message \d+$') { $t = $msgs[$i].FindFirst($TS::Children, (New-Object $PC ($AE::ClassNameProperty, 'sr-only select-none'))); if ($t -and $t.Current.Name -like 'Claude responded*') { $lastIdx = $i } } }
  $o.lastAssistantGroupIndex = $lastIdx
  $txt = New-Object System.Text.StringBuilder
  for ($i = $lastIdx + 1; $i -lt $msgs.Count; $i++) {
    $m = $msgs[$i]; if ($m.Current.Name -match '^(Message \d+|Currently streaming message)$') { break }
    if ($m.Current.ControlType.ProgrammaticName -eq 'ControlType.Text') { [void]$txt.Append($m.Current.Name) }
  }
  $o.assistantTextCharsAfterLastGroup = $txt.Length
}
$o.probeMs = $sw.ElapsedMilliseconds
$o | ConvertTo-Json
