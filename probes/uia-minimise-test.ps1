Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$pids = @(Get-Process claude | % { $_.Id })
$win = $null
foreach ($w in [System.Windows.Automation.AutomationElement]::RootElement.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) { if ($pids -contains $w.Current.ProcessId -and $w.Current.ClassName -eq 'Chrome_WidgetWin_1') { $win = $w; break } }
$wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
try {
  $wp.SetWindowVisualState('Minimized'); Start-Sleep 3
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\uia-state.ps1" -Tag minimised | Out-File "$PSScriptRoot\reports\state-minimised.json" -Encoding utf8
} finally { $wp.SetWindowVisualState('Normal') }
'restored: ' + $wp.Current.WindowVisualState
