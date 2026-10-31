"""Benchmark data for scripts/bench: a copy of %APPDATA%\\Tora's database in %APPDATA%\\ToraBenchPristine.

The copy is signed out and has nothing that acts outside the app (torrent auto-download / refresh,
Discord, update checks), so benchmark builds never touch AniList, torrents or the real library data.
Each benchmark run starts from a fresh copy of it in %APPDATA%\\ToraBench (the bench builds' identifier).

    py -I scripts/bench/bench-data.py
"""
import json
import os
import sqlite3

src = os.path.join(os.environ["APPDATA"], "Tora", "tora_library.db")
dst_dir = os.path.join(os.environ["APPDATA"], "ToraBenchPristine")
os.makedirs(dst_dir, exist_ok=True)
dst = os.path.join(dst_dir, "tora_library.db")
for suffix in ("", "-wal", "-shm"):
    if os.path.exists(dst + suffix):
        os.remove(dst + suffix)

# The backup API gives a consistent snapshot even while Tora is running (WAL included)
with sqlite3.connect(f"file:{src}?mode=ro", uri=True) as s, sqlite3.connect(dst) as d:
    s.backup(d)

with sqlite3.connect(dst) as d:
    (raw,) = d.execute("SELECT value_json FROM app_settings WHERE key = 'main'").fetchone()
    settings = json.loads(raw)
    settings.update(
        anilist_token="",
        discord_presence_enabled=False,
        torrent_auto_download=False,
        torrent_refresh_minutes=0,
        check_updates_on_startup=False,
    )
    d.execute("UPDATE app_settings SET value_json = ? WHERE key = 'main'", (json.dumps(settings),))
    d.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    entries = d.execute("SELECT COUNT(*) FROM anime_entries").fetchone()[0]
    files = d.execute("SELECT COUNT(*) FROM local_episodes").fetchone()[0]
print(f"{dst}: {entries} entries, {files} files, signed out")
