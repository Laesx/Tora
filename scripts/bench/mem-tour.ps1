<#
.SYNOPSIS
  Starts one Tora build on the benchmark data, drives it through every tab and records memory per phase.

.DESCRIPTION
  The build must use the `ToraBench` identifier (mem-compare.ps1 builds them so), so it reads
  %APPDATA%\ToraBench, which is reset from %APPDATA%\ToraBenchPristine (bench-data.py) before every run,
  with a cold WebView2 profile. The page is driven through the WebView2 DevTools protocol
  (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, the same for every build): Ctrl+1–8 to each tab, scrolled to
  the bottom in steps and back.

  Phases: start (idle after startup), tour1 (after one tour), tourN (after all tours), settled (a minute
  later), minimized, restored. One summary row per phase is appended to -Csv (MB, private working set
  unless noted) and printed.
#>
param(
  [Parameter(Mandatory)] [string]$Exe,
  # Build name in the CSV (e.g. "current", "a1b2c3d4")
  [Parameter(Mandatory)] [string]$Build,
  [string]$Csv,
  [int]$Tours = 3,
  [int]$IdleSeconds = 60,
  [int]$Port = 9333
)
$ErrorActionPreference = "Stop"
$snapshot = Join-Path $PSScriptRoot "..\mem-snapshot.ps1"
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)
$pristine = "$env:APPDATA\ToraBenchPristine\tora_library.db"
if (-not (Test-Path $pristine)) { throw "No benchmark data: run  py -I scripts/bench/bench-data.py" }
if (Get-Process -Name $name -ErrorAction SilentlyContinue) { throw "$name.exe is already running" }

Add-Type -Namespace Bench -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd);'

$data = "$env:APPDATA\ToraBench"
Remove-Item -Recurse -Force $data, "$env:LOCALAPPDATA\ToraBench" -ErrorAction SilentlyContinue
New-Item -ItemType Directory $data | Out-Null
Copy-Item $pristine $data

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --enable-precise-memory-info"
$p = Start-Process $Exe -PassThru
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS

$script:id = 0
function Invoke-Js($ws, [string]$expr) {
  $script:id++
  $msg = @{ id = $script:id; method = "Runtime.evaluate"; params = @{ expression = $expr; awaitPromise = $true; returnByValue = $true } } |
    ConvertTo-Json -Depth 5 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]$bytes, "Text", $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
  $buf = [byte[]]::new(1MB)
  while ($true) {
    $sb = [Text.StringBuilder]::new()
    do {
      $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
    } while (-not $r.EndOfMessage)
    $o = $sb.ToString() | ConvertFrom-Json
    if ($o.id -eq $script:id) {
      if ($o.result.exceptionDetails) { throw "JS: $($o.result.exceptionDetails | ConvertTo-Json -Depth 5 -Compress)" }
      return $o.result.result.value
    }
  }
}

# Every tab (Ctrl+digit), each scrolled to the bottom in steps and back, `tours` times
$tour = @'
(async (tours) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tab = (d) => window.dispatchEvent(new KeyboardEvent("keydown", { key: String(d), code: "Digit" + d, ctrlKey: true, bubbles: true }));
  const scroller = () =>
    [...document.querySelectorAll("*")]
      .filter((e) => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement;
  for (let t = 0; t < tours; t++) {
    for (const d of [2, 1, 3, 4, 5, 6, 7, 8, 2]) {
      tab(d);
      await sleep(3000);
      const el = scroller();
      for (let i = 0; i < 30 && el.scrollTop + el.clientHeight < el.scrollHeight - 2; i++) {
        el.scrollTop += el.clientHeight * 0.8;
        await sleep(250);
      }
      el.scrollTop = 0;
      await sleep(500);
    }
  }
})
'@
$pageStats = 'JSON.stringify({ heap: performance.memory.usedJSHeapSize, dom: document.getElementsByTagName("*").length, imgs: document.images.length })'

$inv = [cultureinfo]::InvariantCulture
$script:printed = $false
function Write-Phase($ws, [string]$phase) {
  $rows = @(& $snapshot -Name $name -Tag "$Build $phase" -PassThru -Quiet)
  $page = if ($ws -and $ws.State -eq "Open") { Invoke-Js $ws $pageStats | ConvertFrom-Json } else { $null }
  $mb = { param([string[]]$labels) [math]::Round([double](($rows | Where-Object { $_.Label -in $labels } | Measure-Object PrivWS -Sum).Sum), 1) }
  $other = $rows | Where-Object { $_.Label -notin "core", "renderer", "gpu", "browser", "TOTAL" } | ForEach-Object Label
  $total = $rows | Where-Object Label -eq "TOTAL"
  $row = [pscustomobject]@{
    Time     = (Get-Date).ToString("s")
    Build    = $Build
    Phase    = $phase
    Total    = [math]::Round($total.PrivWS, 1)
    Core     = & $mb @("core")
    Renderer = & $mb @("renderer")
    Gpu      = & $mb @("gpu")
    Browser  = & $mb @("browser")
    Other    = & $mb @($other)
    Commit   = [math]::Round($total.Commit, 1)
    JsHeap   = if ($page) { [math]::Round($page.heap / 1MB, 1) } else { $null }
    Dom      = if ($page) { $page.dom } else { $null }
    Imgs     = if ($page) { $page.imgs } else { $null }
    CpuSec   = [math]::Round($total.CpuSec, 1)
  }
  if (-not $script:printed) {
    Write-Host ("{0,-10} {1,-10} {2,7} {3,6} {4,8} {5,6} {6,7} {7,6} {8,7} {9,6} {10,6} {11,5} {12,6}" -f
      "Build", "Phase", "Total", "Core", "Renderer", "GPU", "Browser", "Other", "Commit", "JS", "DOM", "Imgs", "CPU s")
    $script:printed = $true
  }
  Write-Host ("{0,-10} {1,-10} {2,7:N1} {3,6:N1} {4,8:N1} {5,6:N1} {6,7:N1} {7,6:N1} {8,7:N1} {9,6:N1} {10,6} {11,5} {12,6:N1}" -f
    $row.Build, $row.Phase, $row.Total, $row.Core, $row.Renderer, $row.Gpu, $row.Browser, $row.Other, $row.Commit,
    $row.JsHeap, $row.Dom, $row.Imgs, $row.CpuSec)
  if ($Csv) {
    $row.PSObject.Properties | Where-Object { $_.Value -is [double] } | ForEach-Object { $_.Value = $_.Value.ToString($inv) }
    $row | Export-Csv -Path $Csv -Append -NoTypeInformation
  }
}

$ws = $null
try {
  $deadline = (Get-Date).AddSeconds(60)
  while ($true) {
    try {
      $target = (Invoke-RestMethod "http://127.0.0.1:$Port/json" -TimeoutSec 2) | Where-Object type -eq "page" | Select-Object -First 1
      if ($target) { break }
    }
    catch {}
    if ((Get-Date) -gt $deadline) { throw "DevTools port $Port never answered (is another app using it?)" }
    Start-Sleep -Milliseconds 500
  }
  $ws = [Net.WebSockets.ClientWebSocket]::new()
  $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()

  Start-Sleep -Seconds $IdleSeconds
  Write-Phase $ws "start"

  Invoke-Js $ws "$tour(1)" | Out-Null
  Start-Sleep -Seconds 10
  Write-Phase $ws "tour1"

  if ($Tours -gt 1) {
    Invoke-Js $ws "$tour($($Tours - 1))" | Out-Null
    Start-Sleep -Seconds 10
    Write-Phase $ws "tour$Tours"
  }

  Start-Sleep -Seconds 60
  Write-Phase $ws "settled"

  $p.Refresh()
  [Bench.Win]::ShowWindow($p.MainWindowHandle, 6) | Out-Null   # SW_MINIMIZE
  Start-Sleep -Seconds 20
  Write-Phase $ws "minimized"

  [Bench.Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Seconds 15
  Write-Phase $ws "restored"
}
finally {
  if ($ws) { $ws.Dispose() }
  $p.CloseMainWindow() | Out-Null
  if (-not $p.WaitForExit(10000)) { Stop-Process -Id $p.Id -Force }
  Start-Sleep -Seconds 3
}
