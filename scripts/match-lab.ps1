# Match lab: ground truth for the episode matcher and one saved report per code iteration.
#   scripts/match-lab.ps1 snapshot [--db <path>]      copy the app's library database (read-only) as the current snapshot
#   scripts/match-lab.ps1 run "<label>" [--no-serve]  match every file of the snapshot with this code, save a report, open the page
#   scripts/match-lab.ps1 serve [--no-open]           only the review page (http://127.0.0.1:4719)
# Data lives in .match-lab\ (gitignored). See AGENTS.md section 3.
#
# The program runs from a copy: a page left open keeps its process running, and Windows locks a running
# .exe, so the next `run` could not rebuild it. A later `run` saves its report and shows it on the open page.
$ErrorActionPreference = "Stop"
$tauri = Join-Path $PSScriptRoot "..\src-tauri"
cargo build --quiet --release --manifest-path (Join-Path $tauri "Cargo.toml") --example match_lab
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$bin = Join-Path ([System.IO.Path]::GetTempPath()) "tora-match-lab"
New-Item -ItemType Directory -Force $bin | Out-Null
# Old copies go: each is named after the script process that runs it, so copies in use stay
Get-ChildItem $bin -Filter "match_lab-*.exe" |
  Where-Object { -not (Get-Process -Id ([int]($_.BaseName -replace '^match_lab-', '')) -ErrorAction SilentlyContinue) } |
  Remove-Item -ErrorAction SilentlyContinue
$exe = Join-Path $bin "match_lab-$PID.exe"
Copy-Item (Join-Path $tauri "target\release\examples\match_lab.exe") $exe
& $exe @args
exit $LASTEXITCODE
