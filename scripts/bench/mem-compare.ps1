<#
.SYNOPSIS
  Memory benchmark of the working tree, optionally against a git commit / tag / branch.

.DESCRIPTION
  Builds release exes (`--no-bundle`, identifier `ToraBench`, so they never touch %APPDATA%\Tora):
    current      the working tree, uncommitted changes included (rebuilt every run unless -SkipBuild)
    <ref hash>   with -Ref: that commit, built in a temporary git worktree; cached by commit hash
  Then runs mem-tour.ps1 on each (alternating the order every round) and prints the averages per phase
  and, with -Ref, current minus ref. Results go to src-tauri\target\bench\results-<time>.csv.

  The benchmark data is a signed-out copy of your library (bench-data.py, made on first use or with
  -RefreshData). Windows open, switch tabs and close by themselves; don't use the mouse meanwhile.

.EXAMPLE
  ./scripts/bench/mem-compare.ps1                       # the working tree alone
  ./scripts/bench/mem-compare.ps1 -Ref v0.3.0           # working tree vs the v0.3.0 tag
  ./scripts/bench/mem-compare.ps1 -Ref HEAD~3 -Rounds 2 # two runs of each, averaged
#>
param(
  # Commit, tag or branch to compare against
  [string]$Ref,
  # Runs of each build (averaged)
  [int]$Rounds = 1,
  # Tours of every tab per run
  [int]$Tours = 3,
  # Reuse the last `current` exe instead of rebuilding the working tree
  [switch]$SkipBuild,
  # Recopy the benchmark data from %APPDATA%\Tora
  [switch]$RefreshData
)
$ErrorActionPreference = "Stop"
$root = (git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
$target = Join-Path $root "src-tauri\target"
$out = Join-Path $target "bench"
New-Item -ItemType Directory -Force $out | Out-Null
$conf = Join-Path $out "bench.conf.json"
Set-Content -Path $conf -Value '{"identifier":"ToraBench"}' -Encoding utf8NoBOM

if ($RefreshData -or -not (Test-Path "$env:APPDATA\ToraBenchPristine\tora_library.db")) {
  py -I (Join-Path $PSScriptRoot "bench-data.py")
  if ($LASTEXITCODE) { throw "bench-data.py failed" }
}

# Builds the tree at $dir into $exe (release, bench identifier). Output in the shared target folder.
function Build-Tora([string]$dir, [string]$exe) {
  Write-Host "`nBuilding $exe" -ForegroundColor Cyan
  $prevTarget = $env:CARGO_TARGET_DIR
  $env:CARGO_TARGET_DIR = $target
  Push-Location $dir
  try {
    pnpm tauri build --no-bundle --config $conf 2>&1 | Select-Object -Last 3 | Out-Host
    if ($LASTEXITCODE) { throw "build failed in $dir" }
  }
  finally {
    Pop-Location
    $env:CARGO_TARGET_DIR = $prevTarget
  }
  Copy-Item (Join-Path $target "release\tora.exe") $exe -Force
}

$builds = [ordered]@{}

if ($Ref) {
  $hash = git -C $root rev-parse --verify --quiet "$Ref^{commit}"
  if ($LASTEXITCODE -or -not $hash) { throw "unknown ref: $Ref" }
  $short = $hash.Trim().Substring(0, 8)
  $refExe = Join-Path $out "tora-$short.exe"
  if (-not (Test-Path $refExe)) {
    $wt = Join-Path $out "wt-$short"
    git -C $root worktree add --detach $wt $hash | Out-Host
    try {
      Push-Location $wt
      pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 2 | Out-Host
      Pop-Location
      Build-Tora $wt $refExe
    }
    finally {
      git -C $root worktree remove --force $wt 2>$null
      # node_modules paths can exceed MAX_PATH for Remove-Item
      if (Test-Path $wt) { cmd /c rd /s /q "\\?\$wt" }
      git -C $root worktree prune
    }
  }
  else { Write-Host "Using cached $refExe" }
  $builds[$short] = $refExe
}

$currentExe = Join-Path $out "tora-current.exe"
if (-not $SkipBuild -or -not (Test-Path $currentExe)) { Build-Tora $root $currentExe }
$builds["current"] = $currentExe

$csv = Join-Path $out ("results-{0:yyyyMMdd-HHmmss}.csv" -f (Get-Date))
$names = @($builds.Keys)
foreach ($round in 1..$Rounds) {
  $order = if ($round % 2) { $names } else { $names[($names.Count - 1)..0] }
  foreach ($b in $order) {
    Write-Host "`nRound $round · $b" -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "mem-tour.ps1") -Exe $builds[$b] -Build $b -Csv $csv -Tours $Tours
  }
}

# Averages per build and phase; with a ref, current − ref
$inv = [cultureinfo]::InvariantCulture
$cols = "Total", "Core", "Renderer", "Gpu", "Browser", "Other", "Commit", "JsHeap", "Dom", "Imgs"
$rows = Import-Csv $csv
$phases = @($rows | ForEach-Object Phase | Select-Object -Unique)
$avg = foreach ($b in $builds.Keys) {
  foreach ($ph in $phases) {
    $g = @($rows | Where-Object { $_.Build -eq $b -and $_.Phase -eq $ph })
    if (-not $g) { continue }
    $o = [ordered]@{ Build = $b; Phase = $ph }
    foreach ($c in $cols) {
      $vals = @($g | Where-Object { $_.$c -ne "" } | ForEach-Object { [double]::Parse($_.$c, $inv) })
      $o[$c] = if ($vals) { [math]::Round(($vals | Measure-Object -Average).Average, 1) } else { $null }
    }
    [pscustomobject]$o
  }
}
Write-Host "`nAverages (MB, private working set; Commit = committed total; Dom / Imgs = elements on the page)" -ForegroundColor Cyan
$avg | Format-Table -AutoSize | Out-Host

if ($Ref) {
  Write-Host "current - $($names[0]) (MB; positive = current uses more)" -ForegroundColor Cyan
  $diff = foreach ($ph in $phases) {
    $a = $avg | Where-Object { $_.Build -eq $names[0] -and $_.Phase -eq $ph }
    $c = $avg | Where-Object { $_.Build -eq "current" -and $_.Phase -eq $ph }
    if (-not $a -or -not $c) { continue }
    $o = [ordered]@{ Phase = $ph }
    foreach ($col in $cols) {
      $o[$col] = if ($null -ne $a.$col -and $null -ne $c.$col) { "{0:+0.0;-0.0;0}" -f ($c.$col - $a.$col) } else { "" }
    }
    [pscustomobject]$o
  }
  $diff | Format-Table -AutoSize | Out-Host
}
Write-Host "Results: $csv"
