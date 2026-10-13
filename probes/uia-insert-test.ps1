# Draft-insertion feasibility test for Claude Desktop. NEVER sends: it does not touch the Send button.
# Saves the composer's existing draft, sets a test draft via UIA ValuePattern, reads it back, restores the
# original draft and verifies the restore. Scenarios: foreground | background | minimised.
# Usage: powershell -NoProfile -File uia-insert-test.ps1 -Scenario foreground
param([ValidateSet('foreground', 'background', 'minimised')][string]$Scenario = 'foreground',
      [string]$TestText = 'CrossTalk insertion test')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
'@
$AE = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]
$pids = @(Get-Process claude | ForEach-Object { $_.Id })
$win = $null
foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($pids -contains $w.Current.ProcessId -and $w.Current.ClassName -eq 'Chrome_WidgetWin_1') { $win = $w; break } }
if (-not $win) { throw 'Claude window not found' }
$hwnd = [IntPtr]$win.Current.NativeWindowHandle
$wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)

function Get-Composer {
  $edits = $win.FindAll($TS::Descendants, (New-Object $PC ($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
  foreach ($e in $edits) { if ($e.Current.ClassName -like '*ProseMirror*') { return $e } }
}
function Read-Composer($c) {
  $v = $c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
  $t = ''
  try { $t = $c.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1) } catch {}
  [pscustomobject]@{ Value = $v; Text = $t }
}
function Send-State { $b = $win.FindFirst($TS::Descendants, (New-Object $PC ($AE::NameProperty, 'Send message')))
  if ($b) { "present enabled=$($b.Current.IsEnabled)" } else { 'absent' } }

$c = Get-Composer
if (-not $c) { throw 'composer not found' }
$orig = (Read-Composer $c).Value
$report = [ordered]@{ scenario = $Scenario; originalLen = $orig.Length; sendBefore = Send-State }
$np = $null
try {
  if ($Scenario -eq 'background') { $np = Start-Process cmd.exe -ArgumentList '/k title relay-occluder' -PassThru -WindowStyle Maximized; Start-Sleep 2 }
  if ($Scenario -eq 'minimised') { $wp.SetWindowVisualState('Minimized'); Start-Sleep 2 }
  $report.foregroundIsClaude = ([W]::GetForegroundWindow() -eq $hwnd)
  $report.claudeMinimised = ($wp.Current.WindowVisualState -eq 'Minimized')
  $fgBefore = [W]::GetForegroundWindow()
  $c = Get-Composer
  $vp = $c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  try { $vp.SetValue($TestText); $report.setValue = 'ok' } catch { $report.setValue = "ERR: $($_.Exception.Message)" }
  Start-Sleep -Milliseconds 800
  $r = Read-Composer (Get-Composer)
  $report.readBackValueMatches = ($r.Value -eq $TestText)
  $report.readBackTextMatches = ($r.Text.TrimEnd() -eq $TestText)
  $report.readBackValueLen = $r.Value.Length
  $report.sendWithTest = Send-State
  $textNode = (Get-Composer).FindFirst($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $report.domTextNodeName = if ($textNode) { $textNode.Current.Name } else { $null }
  Start-Sleep -Milliseconds 1500
  $report.stillMatchesAfter1500ms = ((Read-Composer (Get-Composer)).Value -eq $TestText)
  $report.foregroundStolen = ([W]::GetForegroundWindow() -ne $fgBefore)
} finally {
  try {
    $c = Get-Composer
    $c.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($orig)
    Start-Sleep -Milliseconds 800
    $after = Read-Composer (Get-Composer)
    $report.restoredExactly = ($after.Value -eq $orig)
    $report.restoredLen = $after.Value.Length
    $report.sendAfterRestore = Send-State
  } catch { $report.restoreError = $_.Exception.Message }
  if ($np) { Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue }
  if ($Scenario -eq 'minimised') { $wp.SetWindowVisualState('Normal') }
}
$report | ConvertTo-Json
