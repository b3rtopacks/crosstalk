# Read-only timeline recorder for Claude Desktop state signals. One JSON line per tick.
# Purpose: capture the real UIA signals before/after a response finishes (Chat and Code modes).
# Usage: powershell -NoProfile -File uia-watch.ps1 -Out reports\watch.jsonl -Seconds 1500 -Interval 3
param([string]$Out = "$PSScriptRoot\reports\watch.jsonl", [int]$Seconds = 1200, [int]$Interval = 3, [string]$ProcessName = 'claude')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]; $ANY = [System.Windows.Automation.Condition]::TrueCondition
$cr = New-Object System.Windows.Automation.CacheRequest
$cr.Add($AE::NameProperty); $cr.Add($AE::ControlTypeProperty); $cr.Add($AE::ClassNameProperty)
$cr.Add($AE::IsOffscreenProperty); $cr.Add($AE::IsEnabledProperty); $cr.Add($AE::AutomationIdProperty)
$interesting = 'respond|stream|running|idle|cache|clawd|stop|thinking|working|interrupt|queue|send|actions|generat|turn |cost|done|complete|ago|retry|copy|esc|cancel|wait|approv|permission|allow|deny'
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  try {
    $pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $win = $null
    foreach ($w in $AE::RootElement.FindAll($TS::Children, $ANY)) { if ($pids -contains $w.Current.ProcessId -and $w.Current.ClassName -eq 'Chrome_WidgetWin_1') { $win = $w; break } }
    if ($win) {
      $act = $cr.Activate()
      $all = $win.FindAll($TS::Descendants, $ANY)
      $title = ""; $sig = @(); $chatKids = @(); $mode = ""; $chatCount = 0
      foreach ($e in $all) {
        $c = $e.Cached; $n = [string]$c.Name; $ct = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
        if ($c.AutomationId -eq 'RootWebArea' -and $n) { $title = $n }
        if ($ct -eq 'RadioButton' -and ($n -eq 'Claude' -or $n -eq 'Code')) { $mode += "$n;" }
        if ($n -match $interesting -and $n.Length -lt 400 -and $ct -ne 'Pane') {
          $short = if ($n.Length -gt 90) { $n.Substring(0, 90) + '..' } else { $n }
          $sig += "$ct|$($c.IsOffscreen)|$($c.IsEnabled)|$short"
        }
      }
      $chat = $win.FindFirst($TS::Descendants, (New-Object $PC ($AE::NameProperty, 'Chat messages')))
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      if ($chat) {
        $k = $walker.GetFirstChild($chat); $list = @()
        while ($k -ne $null) { $nm = [string]$k.Current.Name; $list += ("{0}|{1}|{2}" -f ($k.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''), $k.Current.IsOffscreen, ($(if ($nm.Length -gt 70) { $nm.Substring(0, 70) + '..' } else { $nm }))); $k = $walker.GetNextSibling($k) }
        $chatKids = $list | Select-Object -Last 10
        $chatCount = $list.Count
      }
      $rec = [ordered]@{ t = (Get-Date).ToString('HH:mm:ss'); title = $title; modeRadios = $mode; nodes = $all.Count; chatChildCount = $chatCount; chatLast = $chatKids; signals = $sig }
      ($rec | ConvertTo-Json -Compress -Depth 5) | Add-Content -Path $Out -Encoding UTF8
      $act.Dispose()
    }
  } catch { try { $act.Dispose() } catch {}; ("{""t"":""$((Get-Date).ToString('HH:mm:ss'))"",""error"":""$($_.Exception.Message -replace '"','''')""}") | Add-Content -Path $Out -Encoding UTF8 }
  Start-Sleep -Seconds $Interval
}
