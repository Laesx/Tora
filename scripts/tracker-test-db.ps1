# Snapshots of Tora's data folder (%APPDATA%\Tora: library database, settings backups, relations, .torrent
# files, window state) for testing account and tracker switching repeatedly.
#
#   scripts/tracker-test-db.ps1 save <name>      copy the data folder to %APPDATA%\Tora-testdb\<name>
#   scripts/tracker-test-db.ps1 restore <name>   put a snapshot back (the current state is saved first as auto-<time>)
#   scripts/tracker-test-db.ps1 list             snapshots, newest first
#
# -Dev works on the debug build's folder instead (%APPDATA%\ToraDev, `pnpm tauri dev`). Snapshots are shared,
# so `save real` then `restore real -Dev` gives the dev build a copy of the release build's data.
#
# Tora must be closed (tray included): a running Tora keeps the database open with its -wal / -shm files.
# Snapshots are only added (remove old ones by hand from %APPDATA%\Tora-testdb); a restore replaces the data folder
# after saving it as auto-<time>. Run it from your own terminal (see Assert-RealAppData).
param(
    [Parameter(Position = 0, Mandatory = $true)][ValidateSet("save", "restore", "list")][string]$Command,
    [Parameter(Position = 1)][string]$Name,
    # The debug build's data folder (%APPDATA%\ToraDev) instead of the release build's
    [switch]$Dev,
    [string]$DataDir = (Join-Path $env:APPDATA $(if ($Dev) { "ToraDev" } else { "Tora" })),
    [string]$SnapshotDir = (Join-Path $env:APPDATA "Tora-testdb")
)
$ErrorActionPreference = "Stop"

# Run it from your own terminal, never from a packaged app's shell (the Claude desktop app's terminal and tools):
# Windows redirects a packaged app's writes under %APPDATA% into its private copy
# (%LOCALAPPDATA%\Packages\<app>\LocalCache\Roaming) while deletes still reach the real folder. A restore there
# deleted the real %APPDATA%\Tora and put the snapshot where only that app could see it.
function Assert-RealAppData {
    $probe = "tora-testdb-probe-$PID-$([guid]::NewGuid().ToString('N')).tmp"
    $path = Join-Path $env:APPDATA $probe
    Set-Content -LiteralPath $path -Value "probe"
    try {
        $redirected = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Packages\*\LocalCache\Roaming\$probe") -ErrorAction SilentlyContinue)
    } finally {
        Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue
    }
    if ($redirected.Count -gt 0) {
        $redirected | Remove-Item -ErrorAction SilentlyContinue
        throw "This shell's %APPDATA% writes are redirected into $($redirected[0].DirectoryName) (a packaged app's private copy): " +
            "copies would land there while deletes reach the real folder. Run this script from your own terminal."
    }
}
Assert-RealAppData

function Assert-ToraClosed {
    $running = Get-Process -Name tora -ErrorAction SilentlyContinue
    if ($running) {
        throw "Tora is running (pid $($running.Id -join ', ')). Quit it from the tray first."
    }
}

function Assert-SnapshotName([string]$value) {
    if (-not $value) { throw "A snapshot name is required." }
    if ($value -notmatch '^[A-Za-z0-9._-]+$') { throw "Use only letters, digits, '.', '_' and '-' in snapshot names." }
}

function Measure-Folder([string]$path) {
    $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force)
    [pscustomobject]@{ Files = $files.Count; Bytes = [int64](($files | Measure-Object Length -Sum).Sum) }
}

# Copies every file of $from into $to (created), then checks the file count and total size.
function Copy-Folder([string]$from, [string]$to) {
    New-Item -ItemType Directory -Path $to | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $from -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $to -Recurse -Force
    }
    $a = Measure-Folder $from
    $b = Measure-Folder $to
    if ($a.Files -ne $b.Files -or $a.Bytes -ne $b.Bytes) {
        throw "Copy check failed: $($a.Files) files / $($a.Bytes) bytes in $from, $($b.Files) / $($b.Bytes) in $to"
    }
    $b
}

function Save-Snapshot([string]$name) {
    $target = Join-Path $SnapshotDir $name
    if (Test-Path -LiteralPath $target) { throw "Snapshot '$name' already exists." }
    if (-not (Test-Path -LiteralPath $DataDir)) { throw "No data folder at $DataDir" }
    New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null
    $size = Copy-Folder $DataDir $target
    "Saved '$name': $($size.Files) files, $([math]::Round($size.Bytes / 1MB, 1)) MB"
}

switch ($Command) {
    "list" {
        if (-not (Test-Path -LiteralPath $SnapshotDir)) { "No snapshots yet ($SnapshotDir)."; break }
        Get-ChildItem -LiteralPath $SnapshotDir -Directory | Sort-Object CreationTime -Descending | ForEach-Object {
            $size = Measure-Folder $_.FullName
            "{0,-32} {1:yyyy-MM-dd HH:mm}  {2,6:N1} MB" -f $_.Name, $_.CreationTime, ($size.Bytes / 1MB)
        }
    }
    "save" {
        Assert-SnapshotName $Name
        Assert-ToraClosed
        Save-Snapshot $Name
    }
    "restore" {
        Assert-SnapshotName $Name
        Assert-ToraClosed
        $source = Join-Path $SnapshotDir $Name
        if (-not (Test-Path -LiteralPath $source)) { throw "No snapshot '$Name' (run 'list')." }
        if (Test-Path -LiteralPath $DataDir) {
            Save-Snapshot ("auto-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
            # The current state is safe in the auto snapshot: clear the data folder for an exact restore
            Get-ChildItem -LiteralPath $DataDir -Force | Remove-Item -Recurse -Force
            Remove-Item -LiteralPath $DataDir -Force
        }
        $size = Copy-Folder $source $DataDir
        "Restored '$Name': $($size.Files) files, $([math]::Round($size.Bytes / 1MB, 1)) MB"
    }
}
