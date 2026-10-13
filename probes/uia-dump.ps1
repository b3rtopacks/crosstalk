# Read-only UI Automation tree dump for a running desktop app.
# Run with Windows PowerShell 5.1 (powershell.exe), not pwsh 7 (no UIAutomationClient there).
# Usage: powershell -NoProfile -File uia-dump.ps1 -ProcessName claude -Out reports\claude-uia.txt
param(
  [string]$ProcessName = 'claude',
  [string]$Out = "$PSScriptRoot\reports\uia-$ProcessName.txt",
  [int]$MaxDepth = 60,
  [int]$MaxNodes = 6000,
  [int]$NameLimit = 160,
  [switch]$Raw   # use RawView instead of ControlView
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$ErrorActionPreference = 'Stop'

$pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if (-not $pids) { throw "No process named $ProcessName" }

$walker = if ($Raw) { [System.Windows.Automation.TreeWalker]::RawViewWalker } else { [System.Windows.Automation.TreeWalker]::ControlViewWalker }
$lines = New-Object System.Collections.Generic.List[string]
$script:count = 0

function Describe($el) {
  $c = $el.Current
  $name = [string]$c.Name
  if ($name.Length -gt $NameLimit) { $name = $name.Substring(0, $NameLimit) + '...(' + $name.Length + ')' }
  $name = $name -replace "[\r\n]+", ' / '
  $pats = @()
  try { foreach ($p in $el.GetSupportedPatterns()) { $pats += $p.ProgrammaticName -replace 'Identifiers\.Pattern', '' } } catch {}
  $r = $c.BoundingRectangle
  $bounds = if ($c.IsOffscreen) { 'offscreen' } else { '{0:N0},{1:N0} {2:N0}x{3:N0}' -f $r.X, $r.Y, $r.Width, $r.Height }
  $ct = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
  "{0} name='{1}' id='{2}' class='{3}' aria='{4}' patterns=[{5}] {6}" -f $ct, $name, $c.AutomationId, $c.ClassName, $c.ItemStatus, ($pats -join ','), $bounds
}

function Walk($el, $depth) {
  if ($script:count -ge $MaxNodes -or $depth -gt $MaxDepth) { return }
  $script:count++
  $lines.Add(('  ' * $depth) + (Describe $el))
  $child = $walker.GetFirstChild($el)
  while ($child -ne $null) {
    Walk $child ($depth + 1)
    $child = $walker.GetNextSibling($child)
  }
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$top = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $top) {
  if ($pids -contains $w.Current.ProcessId) {
    $lines.Add("=== TOP-LEVEL pid=$($w.Current.ProcessId) hwnd=$($w.Current.NativeWindowHandle) ===")
    Walk $w 0
  }
}
$lines.Add("=== nodes: $script:count (cap $MaxNodes) ===")
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
$lines | Set-Content -Path $Out -Encoding UTF8
"Wrote $Out ($script:count nodes)"
