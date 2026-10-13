# Read-only: polls Claude Desktop; when a running state ends (Stop button disappears) it takes full UIA dumps
# (2s and 12s later) into reports\finish-<time>-<n>.txt. Also dumps once at start for the running baseline.
param([int]$Seconds = 1500, [int]$Interval = 2, [string]$ProcessName = 'claude')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]; $ANY = [System.Windows.Automation.Condition]::TrueCondition
$dump = Join-Path $PSScriptRoot 'uia-dump.ps1'
$end = (Get-Date).AddSeconds($Seconds); $prev = $null; $n = 0
function Get-Stop {
  $pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  foreach ($w in $AE::RootElement.FindAll($TS::Children, $ANY)) {
    if ($pids -contains $w.Current.ProcessId -and $w.Current.ClassName -eq 'Chrome_WidgetWin_1') {
      $s = $w.FindFirst($TS::Descendants, (New-Object $PC ($AE::NameProperty, 'Stop')))
      return [bool]$s
    }
  }
  return $null
}
while ((Get-Date) -lt $end) {
  try {
    $cur = Get-Stop
    if ($null -ne $cur) {
      if ($null -eq $prev -and $cur) { & powershell -NoProfile -ExecutionPolicy Bypass -File $dump -ProcessName $ProcessName -Out (Join-Path $PSScriptRoot "reports\finish-$((Get-Date).ToString('HHmmss'))-running.txt") | Out-Null }
      if ($prev -eq $true -and $cur -eq $false) {
        Start-Sleep -Seconds 2
        $n++
        & powershell -NoProfile -ExecutionPolicy Bypass -File $dump -ProcessName $ProcessName -Out (Join-Path $PSScriptRoot "reports\finish-$((Get-Date).ToString('HHmmss'))-a$n.txt") | Out-Null
        Start-Sleep -Seconds 10
        & powershell -NoProfile -ExecutionPolicy Bypass -File $dump -ProcessName $ProcessName -Out (Join-Path $PSScriptRoot "reports\finish-$((Get-Date).ToString('HHmmss'))-b$n.txt") | Out-Null
      }
      $prev = $cur
    }
  } catch {}
  Start-Sleep -Seconds $Interval
}
