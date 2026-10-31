<#
.SYNOPSIS
  Per-process memory and CPU of a running Tora: tora.exe plus every WebView2 process it started.

.DESCRIPTION
  Task Manager's "Tora" group adds up several processes. This splits them so a change can be traced
  to the one that grew:
    core      tora.exe (Rust, SQLite, matcher index, torrent cache, C++ FFI)
    browser   WebView2 browser process
    renderer  JS heap, DOM, decoded images
    gpu       compositor textures and layers
    utility:* network / storage / audio services
    crashpad  crash reporter

  Columns (MB):
    PrivWS   private working set: what Task Manager's "Memory" column shows
    Commit   private bytes (committed, includes paged-out memory)
    WS       full working set (includes shared DLL pages)
    CPU s    total CPU seconds since the process started
    CPU %    average over the last interval (one core = 100 / logical processors), with -Watch only

  Measure release builds: a debug build runs Vite, React dev mode and DevTools.

.EXAMPLE
  ./scripts/mem-snapshot.ps1
  ./scripts/mem-snapshot.ps1 -Watch 5 -Count 12 -Csv mem.csv -Tag "HEAD idle"
#>
param(
  # Executable name of the app (without .exe)
  [string]$Name = "tora",
  # Seconds between samples; 0 = one sample
  [double]$Watch = 0,
  # Samples to take with -Watch; 0 = until Ctrl+C
  [int]$Count = 0,
  # Append every sample (one row per process + a total row) to this CSV
  [string]$Csv,
  # Free text stored in the CSV's Tag column (build, scenario…)
  [string]$Tag = "",
  # Also return each sample's rows (Label, PID, PrivWS, Commit, WS, CpuSec, CpuPct; TOTAL last) to the caller
  [switch]$PassThru,
  # Don't print the table
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$cores = [Environment]::ProcessorCount

function Get-Label([string]$exe, [string]$cmd) {
  if ($exe -notlike "msedgewebview2*") { return "core" }
  if ($cmd -notmatch "--type=([\w-]+)") { return "browser" }
  switch ($Matches[1]) {
    "renderer" { "renderer" }
    "gpu-process" { "gpu" }
    "crashpad-handler" { "crashpad" }
    "utility" {
      if ($cmd -match "--utility-sub-type=([\w.]+)") { "utility:" + ($Matches[1] -replace "\.mojom\..*$", "") } else { "utility" }
    }
    default { $Matches[1] }
  }
}

# tora.exe and all its descendants (WebView2 browser → renderer, gpu, utility…)
function Get-Tree {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine)
  $roots = @($all | Where-Object { $_.Name -ieq "$Name.exe" })
  if ($roots.Count -eq 0) { return @() }
  $byParent = $all | Group-Object ParentProcessId -AsHashTable -AsString
  $tree = [System.Collections.Generic.List[object]]::new()
  $queue = [System.Collections.Generic.Queue[object]]::new()
  foreach ($r in $roots) { $queue.Enqueue($r) }
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    $tree.Add($p)
    $kids = $byParent["$($p.ProcessId)"]
    if ($kids) { foreach ($k in $kids) { if ($k.ProcessId -ne $p.ProcessId) { $queue.Enqueue($k) } } }
  }
  $tree
}

function Get-Sample {
  $tree = @(Get-Tree)
  if ($tree.Count -eq 0) { return }
  $ids = $tree.ProcessId
  $perf = @{}
  Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess, WorkingSetPrivate, PrivateBytes, WorkingSet |
    Where-Object { $ids -contains $_.IDProcess } |
    ForEach-Object { $perf[[int]$_.IDProcess] = $_ }
  foreach ($p in $tree) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    $c = $perf[[int]$p.ProcessId]
    if (-not $proc -or -not $c) { continue }
    [pscustomobject]@{
      Label   = Get-Label $p.Name $p.CommandLine
      PID     = [int]$p.ProcessId
      PrivWS  = [double]$c.WorkingSetPrivate / 1MB
      Commit  = [double]$c.PrivateBytes / 1MB
      WS      = [double]$c.WorkingSet / 1MB
      CpuSec  = $proc.TotalProcessorTime.TotalSeconds
    }
  }
}

$prevCpu = @{}
$prevTime = $null
$n = 0
while ($true) {
  $now = Get-Date
  $rows = @(Get-Sample)
  if ($rows.Count -eq 0) {
    Write-Warning "$Name.exe is not running"
    if ($Watch -le 0) { exit 1 }
  }
  else {
    $elapsed = if ($prevTime) { ($now - $prevTime).TotalSeconds } else { 0 }
    foreach ($r in $rows) {
      $cpuPct = $null
      if ($elapsed -gt 0 -and $prevCpu.ContainsKey($r.PID)) {
        $cpuPct = ($r.CpuSec - $prevCpu[$r.PID]) / $elapsed / $cores * 100
      }
      $r | Add-Member CpuPct $cpuPct
      $prevCpu[$r.PID] = $r.CpuSec
    }
    $rows = @($rows | Sort-Object @{ e = { @("core", "browser", "renderer", "gpu").IndexOf($_.Label) -band 0xff } }, Label, PID)
    $total = [pscustomobject]@{
      Label  = "TOTAL"
      PID    = $null
      PrivWS = ($rows | Measure-Object PrivWS -Sum).Sum
      Commit = ($rows | Measure-Object Commit -Sum).Sum
      WS     = ($rows | Measure-Object WS -Sum).Sum
      CpuSec = ($rows | Measure-Object CpuSec -Sum).Sum
      CpuPct = if ($elapsed -gt 0) { ($rows | Where-Object { $null -ne $_.CpuPct } | Measure-Object CpuPct -Sum).Sum } else { $null }
    }

    if (-not $Quiet) {
      Write-Host ("`n{0:HH:mm:ss}  {1}" -f $now, $Tag) -ForegroundColor Cyan
      ($rows + $total) | Format-Table -AutoSize `
        Label, PID,
        @{ n = "PrivWS"; e = { "{0:N1}" -f $_.PrivWS }; a = "right" },
        @{ n = "Commit"; e = { "{0:N1}" -f $_.Commit }; a = "right" },
        @{ n = "WS"; e = { "{0:N1}" -f $_.WS }; a = "right" },
        @{ n = "CPU s"; e = { "{0:N1}" -f $_.CpuSec }; a = "right" },
        @{ n = "CPU %"; e = { if ($null -ne $_.CpuPct) { "{0:N2}" -f $_.CpuPct } else { "" } }; a = "right" } |
        Out-Host
    }
    if ($PassThru) { $rows + $total }

    if ($Csv) {
      # Invariant decimals, whatever the system locale (a comma would split or misread the numbers)
      $inv = [cultureinfo]::InvariantCulture
      $num = { param($v, $digits) ([math]::Round([double]$v, $digits)).ToString($inv) }
      ($rows + $total) | ForEach-Object {
        [pscustomobject]@{
          Time   = $now.ToString("s")
          Tag    = $Tag
          Label  = $_.Label
          PID    = $_.PID
          PrivWS = & $num $_.PrivWS 1
          Commit = & $num $_.Commit 1
          WS     = & $num $_.WS 1
          CpuSec = & $num $_.CpuSec 2
          CpuPct = if ($null -ne $_.CpuPct) { & $num $_.CpuPct 2 } else { "" }
        }
      } | Export-Csv -Path $Csv -Append -NoTypeInformation
    }
    $prevTime = $now
  }

  $n++
  if ($Watch -le 0 -or ($Count -gt 0 -and $n -ge $Count)) { break }
  Start-Sleep -Milliseconds ([int]($Watch * 1000))
}
