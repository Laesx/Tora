"""Benchmark data for scripts/bench: a copy of %APPDATA%\\Tora's database in %APPDATA%\\ToraBenchPristine.

The copy is signed out and has nothing that acts outside the app (torrent auto-download / refresh,
Discord, update checks), so benchmark builds never touch AniList, torrents or the real library data.
Each benchmark run starts from a fresh copy of it in %APPDATA%\\ToraBench (the bench builds' identifier).

    py -I scripts/bench/bench-data.py
"""
import json
import os
import sqlite3

src_dir = os.path.join(os.environ["APPDATA"], "Tora")
src = os.path.join(src_dir, "tora_library.db")
dst_dir = os.path.join(os.environ["APPDATA"], "ToraBenchPristine")
os.makedirs(dst_dir, exist_ok=True)
dst = os.path.join(dst_dir, "tora_library.db")


def fresh(path):
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)


def copy(source, target):
    # The backup API gives a consistent snapshot even while Tora is running (WAL included)
    fresh(target)
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as s, sqlite3.connect(target) as d:
        s.backup(d)


copy(src, dst)

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
    d.commit()
    d.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    owner = dict(d.execute(
        "SELECT key, value_json FROM app_settings WHERE key IN ('list_owner_user_id', 'list_owner_tracker')"
    ).fetchall())
    files = d.execute("SELECT COUNT(*) FROM local_episodes").fetchone()[0]
    single_file = d.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'anime_entries'").fetchone()

# The list lives in the active account's database (db/storage.rs). The benchmark copy stays one file, as
# before account databases, so builds from before them read it too (newer builds move it out on start).
# Signed out: the account's sign-in is not copied.
if not single_file:
    stem = f"{owner.get('list_owner_tracker', 'anilist')}-{owner['list_owner_user_id']}" if "list_owner_user_id" in owner else "local"
    account = os.path.join(dst_dir, "account.tmp.db")
    copy(os.path.join(src_dir, "accounts", stem + ".db"), account)
    with sqlite3.connect(dst) as d:
        d.execute("ATTACH DATABASE ? AS acct", (account,))
        objects = d.execute(
            "SELECT type, name, sql FROM acct.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
            "AND name != 'app_settings' ORDER BY type = 'index'"
        ).fetchall()
        for kind, name, sql in objects:
            d.execute(sql)
            if kind == "table":
                d.execute(f"INSERT INTO main.{name} SELECT * FROM acct.{name}")
        d.execute("INSERT OR REPLACE INTO main.app_settings SELECT * FROM acct.app_settings WHERE key != 'tracker_account'")
        d.commit()
        d.execute("DETACH DATABASE acct")
    fresh(account)
with sqlite3.connect(dst) as d:
    d.execute("DELETE FROM app_settings WHERE key = 'tracker_account'")
    d.commit()
    d.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    entries = d.execute("SELECT COUNT(*) FROM anime_entries").fetchone()[0]
print(f"{dst}: {entries} entries, {files} files, signed out")
