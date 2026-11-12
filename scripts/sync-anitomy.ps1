# Anitomy is vendored from a fork (src-tauri\vendor\anitomy.source says which commit). Change it in the fork,
# then copy it here with this script; never edit src-tauri\vendor\anitomy directly. See AGENTS.md section 2.
#
#   scripts/sync-anitomy.ps1 -Fork D:\dev\anitomy [-Ref tora]   replace the vendored copy with <Ref> of a local fork clone
#   scripts/sync-anitomy.ps1 -Check                             the vendored copy (working tree) is exactly the recorded commit
param(
  [string]$Fork,
  [string]$Ref = "tora",
  [switch]$Check
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$vendorRel = "src-tauri/vendor/anitomy"
$vendor = Join-Path $repo $vendorRel
$sourceFile = Join-Path $repo "src-tauri\vendor\anitomy.source"

function Invoke-Git([string]$Dir, [string[]]$GitArgs) {
  $out = & git -C $Dir @GitArgs
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed in $Dir" }
  return $out
}

# Tree hash of the vendored folder as it is on disk (through a temporary index: the real one is untouched)
function Get-WorkingTreeHash {
  $index = Join-Path ([System.IO.Path]::GetTempPath()) "tora-anitomy-index-$PID"
  $env:GIT_INDEX_FILE = $index
  try {
    Invoke-Git $repo @("read-tree", "--empty") | Out-Null
    Invoke-Git $repo @("add", "--", $vendorRel) | Out-Null
    return (Invoke-Git $repo @("write-tree", "--prefix=$vendorRel/")).Trim()
  } finally {
    Remove-Item Env:\GIT_INDEX_FILE
    Remove-Item $index -ErrorAction SilentlyContinue
  }
}

function Read-Source {
  $values = @{}
  foreach ($line in Get-Content $sourceFile) {
    if ($line -match '^\s*([a-z]+):\s*(.+?)\s*$') { $values[$Matches[1]] = $Matches[2] }
  }
  return $values
}

if ($Check) {
  if (-not (Test-Path $sourceFile)) { throw "missing $sourceFile" }
  $recorded = (Read-Source)["tree"]
  $actual = Get-WorkingTreeHash
  if ($recorded -ne $actual) {
    [Console]::Error.WriteLine("src-tauri\vendor\anitomy differs from the recorded fork commit (tree $actual, expected $recorded). Make the change in the fork and sync it.")
    exit 1
  }
  Write-Host "src-tauri\vendor\anitomy is the recorded fork commit (tree $actual)"
  exit 0
}

if (-not $Fork) { throw "pass -Fork <path to a local clone of the Anitomy fork> (or -Check)" }
$Fork = (Resolve-Path $Fork).Path
$commit = (Invoke-Git $Fork @("rev-parse", "--verify", "$Ref^{commit}")).Trim()
$tree = (Invoke-Git $Fork @("rev-parse", "$commit^{tree}")).Trim()
$url = (Invoke-Git $Fork @("remote", "get-url", "origin")).Trim()
# Where the fork left upstream: the newest commit it shares with upstream's develop (or its own develop)
$upstreamRef = if (& git -C $Fork rev-parse --verify --quiet "upstream/develop") { "upstream/develop" } else { "develop" }
$base = (Invoke-Git $Fork @("merge-base", $commit, $upstreamRef)).Trim()

$archive = Join-Path ([System.IO.Path]::GetTempPath()) "tora-anitomy-$PID.tar"
try {
  Invoke-Git $Fork @("archive", "--format=tar", "-o", $archive, $commit) | Out-Null
  if (Test-Path $vendor) { Remove-Item $vendor -Recurse -Force }
  New-Item -ItemType Directory $vendor | Out-Null
  tar -xf $archive -C $vendor
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
} finally {
  Remove-Item $archive -ErrorAction SilentlyContinue
}

@"
# Anitomy is vendored from a fork: change it there, then run scripts/sync-anitomy.ps1 (AGENTS.md section 2).
repository: $url
ref: $Ref
commit: $commit
tree: $tree
upstream: https://github.com/erengy/anitomy develop $base
"@ | Set-Content -Path $sourceFile -Encoding utf8NoBOM

$actual = Get-WorkingTreeHash
if ($actual -ne $tree) {
  Write-Warning "the copy hashes to $actual, the fork commit to $tree (line endings?). Check before committing."
}
Write-Host "vendored $Ref ($($commit.Substring(0, 7))) from $url; upstream base $($base.Substring(0, 7))"
git -C $repo status --short -- $vendorRel "src-tauri/vendor/anitomy.source"
