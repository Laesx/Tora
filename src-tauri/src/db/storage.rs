//! Where Tora's data lives: one device database plus one database per tracker account.
//!
//! - `tora_library.db` (SQLite `main`): what belongs to the computer: library folders and indexed files,
//!   settings, torrent feeds / priority / board options, which account is active (`ListOwner`).
//! - `accounts/<tracker>-<user id>.db` (attached as [`ACCOUNT_SCHEMA`]): everything tied to the tracker's
//!   anime ids: the list, custom lists, watch history, title aliases, queued pushes and deletions, cached
//!   anime data (seasons, anime pages, schedule), imported activity, and the account's own settings keys
//!   ([`ACCOUNT_SETTING_KEYS`]: the sign-in, score format, pinned releases, "Not interested", fansub
//!   overrides, torrent filters). `accounts/local.db` holds what exists before the first sign-in; that
//!   account adopts it.
//!
//! Each table exists in exactly one of the two files, so SQL names tables without a schema and SQLite finds
//! them. `app_settings` is the one table in both: unqualified it is `main`'s, and account keys go through
//! [`settings_table`]. Signing in to another account attaches its file in place of the current one
//! ([`Database::switch_account`]), so nothing is ever deleted and switching back finds everything as it was.

use super::{accounts, add_column_if_missing, table_exists_in, Database, ListOwner};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// An account with a database on this computer (the account list in Settings → Tracker). Never a token.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredAccount {
    pub tracker: String,
    pub user_id: i64,
    /// `None` for an account signed out before names were kept with signed-out accounts
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    /// Its sign-in is stored, so switching to it needs no new sign-in
    pub signed_in: bool,
    /// The account database in use
    pub active: bool,
    /// Anime on its list
    pub entries: u32,
    /// Edits and deletions not sent to the tracker yet (lost if the account is removed)
    pub unsent: u32,
}

/// What an account database says about its account: the stored sign-in, its name, its list size and its
/// unsent changes. `schema`: `acct.` for the attached one, empty for a file opened on its own.
fn read_account_db(
    conn: &Connection,
    schema: &str,
) -> (Option<accounts::TrackerAccount>, Option<accounts::AccountProfile>, u32, u32) {
    let value = |key: &str| -> Option<String> {
        conn.query_row(
            &format!("SELECT value_json FROM {schema}app_settings WHERE key = ?1"),
            params![key],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    };
    let account = value(accounts::TRACKER_ACCOUNT_KEY).and_then(|j| serde_json::from_str(&j).ok());
    let profile = value(accounts::ACCOUNT_PROFILE_KEY).and_then(|j| serde_json::from_str(&j).ok());
    let count = |sql: String| conn.query_row(&sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0).max(0) as u32;
    let entries = count(format!("SELECT COUNT(*) FROM {schema}anime_entries"));
    let unsent = count(format!("SELECT COUNT(*) FROM {schema}anime_entries WHERE sync_pending = 1"))
        + count(format!("SELECT COUNT(*) FROM {schema}tracker_pending_deletions"));
    (account, profile, entries, unsent)
}

/// `mal-123456` → (`mal`, 123456); `local` and anything else → `None`.
fn owner_of_stem(stem: &str) -> Option<ListOwner> {
    let (tracker, id) = stem.rsplit_once('-')?;
    let id = id.parse::<i64>().ok()?;
    (!tracker.is_empty()).then(|| ListOwner::new(tracker, id))
}

/// [`Database::for_account`]'s error: another account database was attached since the work started.
pub const ACCOUNT_CHANGED: &str = "Another account was switched to meanwhile";

/// SQLite schema name of the attached account database.
pub const ACCOUNT_SCHEMA: &str = "acct";
/// Folder of the account databases, next to the device database.
pub const ACCOUNTS_DIR: &str = "accounts";

/// `app_settings` keys that belong to the account (its anime ids, its sign-in), kept in its own file.
pub const ACCOUNT_SETTING_KEYS: [&str; 8] = [
    accounts::TRACKER_ACCOUNT_KEY,
    accounts::ACCOUNT_PROFILE_KEY,
    super::SCORE_FORMAT_KEY,
    super::activity::ANILIST_HISTORY_STATE_KEY,
    super::settings::RELEASE_PREFERENCES_KEY,
    super::settings::SEASONS_NOT_INTERESTED_KEY,
    super::settings::TORRENT_FANSUBS_KEY,
    super::settings::TORRENT_FILTERS_KEY,
];

/// Account tables, parents before children (copy order; drop in reverse).
const ACCOUNT_TABLES: [&str; 12] = [
    "anime_entries",
    "anime_custom_lists",
    "tracker_custom_lists",
    "title_aliases",
    "watch_history",
    "tracker_pending_deletions",
    "seasonal_cache",
    "media_metadata",
    "airing_schedule_cache",
    "anilist_activities",
    "anilist_activity_episodes",
    "anilist_activity_media",
];

/// The `app_settings` table holding `key`: the account's for [`ACCOUNT_SETTING_KEYS`], else the device's.
pub(crate) fn settings_table(key: &str) -> &'static str {
    if ACCOUNT_SETTING_KEYS.contains(&key) {
        "acct.app_settings"
    } else {
        "main.app_settings"
    }
}

pub(crate) fn read_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        &format!("SELECT value_json FROM {} WHERE key = ?1", settings_table(key)),
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub(crate) fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        &format!("INSERT OR REPLACE INTO {} (key, value_json) VALUES (?1, ?2)", settings_table(key)),
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub(crate) fn delete_setting(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute(&format!("DELETE FROM {} WHERE key = ?1", settings_table(key)), params![key])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Name of an account's database file (without `.db`): `anilist-460805`, or `local` before any sign-in.
pub fn account_file_stem(owner: Option<&ListOwner>) -> String {
    match owner {
        Some(o) => format!("{}-{}", o.tracker, o.user_id),
        None => "local".into(),
    }
}

/// An account database: a file, or a fresh in-memory one (test databases).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AccountTarget {
    File(PathBuf),
    Memory,
}

fn sidecars(path: &Path) -> [PathBuf; 3] {
    let name = path.as_os_str().to_owned();
    let with = |suffix: &str| {
        let mut n = name.clone();
        n.push(suffix);
        PathBuf::from(n)
    };
    [path.to_path_buf(), with("-wal"), with("-shm")]
}

pub(crate) fn account_attached(conn: &Connection) -> Result<bool, String> {
    let mut stmt = conn.prepare("PRAGMA database_list").map_err(|e| e.to_string())?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?;
    for name in names {
        if name.map_err(|e| e.to_string())? == ACCOUNT_SCHEMA {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Attach `target` as [`ACCOUNT_SCHEMA`]. `writer`: the write connection (sets the file's journal mode).
pub(crate) fn attach_account(conn: &Connection, target: &AccountTarget, writer: bool) -> Result<(), String> {
    let location = match target {
        AccountTarget::File(path) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            path.to_string_lossy().into_owned()
        }
        AccountTarget::Memory => ":memory:".into(),
    };
    conn.execute("ATTACH DATABASE ?1 AS acct", params![location]).map_err(|e| e.to_string())?;
    if writer && matches!(target, AccountTarget::File(_)) {
        conn.execute_batch("PRAGMA acct.journal_mode = WAL; PRAGMA acct.synchronous = NORMAL;")
            .map_err(|e| e.to_string())?;
    }
    conn.execute_batch("PRAGMA acct.cache_size = -4000;").map_err(|e| e.to_string())
}

fn detach_account(conn: &Connection) -> Result<(), String> {
    // A cached statement may still reference the old file
    conn.flush_prepared_statement_cache();
    conn.execute_batch("DETACH DATABASE acct").map_err(|e| e.to_string())
}

/// The account tables (idempotent), in the attached account database.
pub(crate) fn create_account_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS acct.anime_entries (
            id INTEGER PRIMARY KEY,
            anilist_id INTEGER UNIQUE,
            mal_id INTEGER,
            title_romaji TEXT NOT NULL,
            title_english TEXT,
            title_native TEXT,
            synonyms_json TEXT NOT NULL DEFAULT '[]',
            normalized_titles_json TEXT NOT NULL DEFAULT '[]',
            format TEXT NOT NULL DEFAULT 'TV',
            airing_status TEXT NOT NULL DEFAULT 'FINISHED',
            episodes INTEGER,
            duration INTEGER,
            season TEXT,
            season_year INTEGER,
            average_score INTEGER,
            cover_image TEXT NOT NULL DEFAULT '',
            banner_image TEXT,
            cover_color TEXT,
            synopsis TEXT NOT NULL DEFAULT '',
            genres_json TEXT NOT NULL DEFAULT '[]',
            studios_json TEXT NOT NULL DEFAULT '[]',
            next_airing_episode INTEGER,
            next_airing_at INTEGER,
            trailer_url TEXT,
            site_url TEXT,
            source_material TEXT,
            user_status TEXT NOT NULL DEFAULT 'CURRENT',
            user_progress INTEGER NOT NULL DEFAULT 0,
            user_score REAL NOT NULL DEFAULT 0,
            user_repeats INTEGER NOT NULL DEFAULT 0,
            user_notes TEXT NOT NULL DEFAULT '',
            user_started_at TEXT,
            user_completed_at TEXT,
            custom_folder TEXT,
            updated_at INTEGER NOT NULL DEFAULT 0,
            sync_pending INTEGER NOT NULL DEFAULT 0,
            anilist_list_entry_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS acct.idx_anime_status ON anime_entries(user_status);
        CREATE INDEX IF NOT EXISTS acct.idx_anime_anilist ON anime_entries(anilist_id);

        CREATE TABLE IF NOT EXISTS acct.title_aliases (
            normalized_alias TEXT PRIMARY KEY,
            anime_id INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acct.watch_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            anime_id INTEGER,
            anime_title TEXT NOT NULL,
            episode_number INTEGER NOT NULL,
            player_name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            scrobbled_to_tracker INTEGER NOT NULL DEFAULT 0,
            timestamp_unix INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acct.app_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acct.tracker_pending_deletions (
            media_id INTEGER PRIMARY KEY,
            list_entry_id INTEGER,
            title TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acct.seasonal_cache (
            season TEXT NOT NULL,
            year INTEGER NOT NULL,
            fetched_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (season, year)
        );

        CREATE TABLE IF NOT EXISTS acct.media_metadata (
            anilist_id INTEGER PRIMARY KEY,
            fetched_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acct.airing_schedule_cache (
            week_from INTEGER PRIMARY KEY,
            week_to INTEGER NOT NULL,
            fetched_at INTEGER NOT NULL,
            payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acct.tracker_custom_lists (
            name TEXT PRIMARY KEY,
            position INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS acct.anime_custom_lists (
            anime_id INTEGER PRIMARY KEY REFERENCES anime_entries(id) ON DELETE CASCADE,
            lists_json TEXT NOT NULL DEFAULT '[]',
            hidden_from_status_lists INTEGER NOT NULL DEFAULT 0,
            dirty INTEGER NOT NULL DEFAULT 0
        );",
    )
    .map_err(|e| e.to_string())?;

    // Idempotent column migrations (account files made by older builds; the legacy split copies only
    // the columns both sides have)
    let acct = ACCOUNT_SCHEMA;
    add_column_if_missing(conn, acct, "anime_entries", "user_started_at", "TEXT")?;
    add_column_if_missing(conn, acct, "anime_entries", "user_completed_at", "TEXT")?;
    add_column_if_missing(conn, acct, "anime_entries", "sync_pending", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, acct, "anime_entries", "anilist_list_entry_id", "INTEGER")?;
    add_column_if_missing(conn, acct, "anime_entries", "start_date", "TEXT")?;
    add_column_if_missing(conn, acct, "anime_entries", "end_date", "TEXT")?;
    add_column_if_missing(conn, acct, "anime_entries", "custom_synonyms_json", "TEXT")?;
    add_column_if_missing(conn, acct, "watch_history", "progress_from", "INTEGER")?;
    // The anime page's details, next to the metadata payload: season upserts never touch them and
    // season reads never select them
    add_column_if_missing(conn, acct, "media_metadata", "details_json", "TEXT")?;
    add_column_if_missing(conn, acct, "media_metadata", "details_fetched_at", "INTEGER")?;
    super::activity::create_tables(conn)
}

fn columns(conn: &Connection, schema: &str, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA {schema}.table_info({table})"))
        .map_err(|e| e.to_string())?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?;
    names.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// A database from before account files (everything in `main`): move the account tables and keys into
/// `target` (attached as the account database afterwards). Copied first, committed, then dropped from
/// `main`: an interrupted move leaves `main` whole, and the next start makes the account file again.
pub(crate) fn split_legacy(conn: &mut Connection, target: &AccountTarget) -> Result<(), String> {
    let start = std::time::Instant::now();
    if let AccountTarget::File(path) = target {
        // A file here is from a move that didn't finish, or this build's own file after an older Tora put
        // the list back into `main`: never deleted, kept aside (`<name>.db.replaced-<time>`, not listed)
        if path.exists() {
            let mut aside = path.as_os_str().to_owned();
            aside.push(format!(".replaced-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
            let aside = PathBuf::from(aside);
            for (from, to) in sidecars(path).iter().zip(sidecars(&aside).iter()) {
                if from.exists() {
                    std::fs::rename(from, to).map_err(|e| format!("{}: {}", from.display(), e))?;
                }
            }
            log::warn!(target: "app", "the list is in the device database again: the account file was kept as {}", aside.display());
        }
    }
    attach_account(conn, target, true)?;
    create_account_schema(conn)?;

    let keys = ACCOUNT_SETTING_KEYS.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", ");
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut rows = 0usize;
    for table in ACCOUNT_TABLES {
        if !table_exists_in(&tx, "main", table)? {
            continue;
        }
        let from = columns(&tx, "main", table)?;
        let shared: Vec<String> = columns(&tx, ACCOUNT_SCHEMA, table)?
            .into_iter()
            .filter(|c| from.contains(c))
            .collect();
        let list = shared.join(", ");
        rows += tx
            .execute(&format!("INSERT INTO acct.{table} ({list}) SELECT {list} FROM main.{table}"), [])
            .map_err(|e| format!("{table}: {e}"))?;
    }
    tx.execute(
        &format!("INSERT OR REPLACE INTO acct.app_settings (key, value_json) SELECT key, value_json FROM main.app_settings WHERE key IN ({keys})"),
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for table in ACCOUNT_TABLES.iter().rev() {
        tx.execute(&format!("DROP TABLE IF EXISTS main.{table}"), []).map_err(|e| e.to_string())?;
    }
    tx.execute(&format!("DELETE FROM main.app_settings WHERE key IN ({keys})"), [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    if matches!(target, AccountTarget::File(_)) {
        conn.execute_batch("VACUUM main").map_err(|e| e.to_string())?;
    }
    log::info!(
        target: "app",
        "moved the list into its account database ({} rows) in {} ms",
        rows,
        start.elapsed().as_millis()
    );
    Ok(())
}

/// The active account's database next to the device database `db_path` opened on `conn` (tools such as
/// the match lab): `None` for a single-file database from before account files, or when there is none.
pub fn account_file_of(conn: &Connection, db_path: &Path) -> Result<Option<PathBuf>, String> {
    if table_exists_in(conn, "main", "anime_entries")? {
        return Ok(None);
    }
    let owner = accounts::read_owner(conn)?;
    let Some(dir) = db_path.parent() else { return Ok(None) };
    let path = dir.join(ACCOUNTS_DIR).join(format!("{}.db", account_file_stem(owner.as_ref())));
    Ok(path.exists().then_some(path))
}

impl Database {
    /// Where `owner`'s account database is (`None`: the one from before any sign-in).
    pub(crate) fn account_target(&self, owner: Option<&ListOwner>) -> AccountTarget {
        match &self.accounts_dir {
            Some(dir) => AccountTarget::File(dir.join(format!("{}.db", account_file_stem(owner)))),
            None => AccountTarget::Memory,
        }
    }

    /// Make `owner`'s database the account database, in place of the current one (kept as it is). The list
    /// made before any sign-in becomes the first account's. Returns whether the account's database is new.
    /// The caller rematches the library: matches point at the previous account's anime ids.
    pub fn switch_account(&self, owner: &ListOwner) -> Result<bool, String> {
        // Held for the whole switch: work started for the previous account waits, then sees the new epoch
        let mut epoch = self.account_epoch.write().map_err(|e| e.to_string())?;
        let current = self.list_owner()?;
        if current.as_ref() == Some(owner) {
            return Ok(false);
        }
        let previous = self.account_target(current.as_ref());
        let target = self.account_target(Some(owner));
        let created = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let reader = match &self.read_conn {
                Some(r) => Some(r.lock().map_err(|e| e.to_string())?),
                None => None,
            };
            detach_account(&conn)?;
            if let Some(r) = reader.as_deref() {
                detach_account(r)?;
            }
            // Files moved by this switch (the list from before any sign-in), moved back if it fails
            let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
            let attempt = (|| -> Result<bool, String> {
                let created = match &target {
                    AccountTarget::File(path) => {
                        if current.is_none() && !path.exists() {
                            if let AccountTarget::File(local) = self.account_target(None) {
                                if local.exists() {
                                    for (from, to) in sidecars(&local).iter().zip(sidecars(path).iter()) {
                                        if from.exists() {
                                            std::fs::rename(from, to).map_err(|e| e.to_string())?;
                                            moved.push((to.clone(), from.clone()));
                                        }
                                    }
                                }
                            }
                        }
                        !path.exists()
                    }
                    AccountTarget::Memory => true,
                };
                attach_account(&conn, &target, true)?;
                create_account_schema(&conn)?;
                if let Some(r) = reader.as_deref() {
                    attach_account(r, &target, false)?;
                }
                // Last: the owner only changes once both connections have the new file
                accounts::write_owner(&conn, owner)?;
                Ok(created)
            })();
            match attempt {
                Ok(created) => created,
                Err(e) => {
                    // Back to the previous account's file, so the app keeps working with it
                    let _ = detach_account(&conn);
                    if let Some(r) = reader.as_deref() {
                        let _ = detach_account(r);
                    }
                    for (from, to) in moved.iter().rev() {
                        let _ = std::fs::rename(from, to);
                    }
                    let restored = attach_account(&conn, &previous, true).and_then(|_| match reader.as_deref() {
                        Some(r) => attach_account(r, &previous, false),
                        None => Ok(()),
                    });
                    log::error!(
                        target: "app",
                        "switching to account database {} failed: {}{}",
                        account_file_stem(Some(owner)),
                        e,
                        match &restored {
                            Ok(()) => String::new(),
                            Err(r) => format!("; the previous one could not be attached again: {}", r),
                        }
                    );
                    return Err(format!("Couldn't open that account's data: {}", e));
                }
            }
        };
        *epoch += 1;
        drop(epoch);
        self.bump_matcher_generation();
        log::info!(
            target: "app",
            "account database: {}{}",
            account_file_stem(Some(owner)),
            if created { " (new)" } else { "" }
        );
        Ok(created)
    }

    /// The attached account database's epoch: pass it to [`Database::for_account`] from work that writes
    /// after waiting on the network.
    pub fn account_epoch(&self) -> u64 {
        self.account_epoch.read().map(|e| *e).unwrap_or_else(|e| *e.into_inner())
    }

    /// Run `write` only if the account database is still the one of `epoch` (no switch since), holding off
    /// switches while it runs. Otherwise [`ACCOUNT_CHANGED`].
    pub fn for_account<T>(&self, epoch: u64, write: impl FnOnce(&Database) -> Result<T, String>) -> Result<T, String> {
        let current = self.account_epoch.read().map_err(|e| e.to_string())?;
        if *current != epoch {
            return Err(ACCOUNT_CHANGED.into());
        }
        write(self)
    }

    /// Every account with a database on this computer, the active one first, then by tracker and name.
    pub fn stored_accounts(&self) -> Result<Vec<StoredAccount>, String> {
        let active = self.list_owner()?;
        let mut owners: Vec<ListOwner> = active.iter().cloned().collect();
        if let Some(dir) = &self.accounts_dir {
            if let Ok(files) = std::fs::read_dir(dir) {
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("db") {
                        continue;
                    }
                    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                    if let Some(owner) = owner_of_stem(stem).filter(|o| Some(o) != active.as_ref()) {
                        owners.push(owner);
                    }
                }
            }
        }
        let mut out = Vec::with_capacity(owners.len());
        for owner in owners {
            let is_active = Some(&owner) == active.as_ref();
            let (account, profile, entries, unsent) = if is_active {
                let conn = self.reader()?;
                read_account_db(&conn, "acct.")
            } else {
                match self.account_target(Some(&owner)) {
                    AccountTarget::File(path) => match Connection::open(&path) {
                        Ok(conn) => read_account_db(&conn, ""),
                        Err(e) => {
                            log::warn!(
                                target: "app",
                                "reading account database {}: {}",
                                account_file_stem(Some(&owner)),
                                e
                            );
                            continue;
                        }
                    },
                    AccountTarget::Memory => continue,
                }
            };
            // The stored sign-in must be this account's own
            let account = account.filter(|a| a.tracker == owner.tracker && a.user_id == owner.user_id);
            let signed_in = account.as_ref().is_some_and(|a| !a.access_token.trim().is_empty());
            let (username, avatar_url) = match (account, profile) {
                (Some(a), _) => (Some(a.username), a.avatar_url),
                (None, Some(p)) => (Some(p.username), p.avatar_url),
                (None, None) => (None, None),
            };
            out.push(StoredAccount {
                tracker: owner.tracker,
                user_id: owner.user_id,
                username: username.filter(|n| !n.trim().is_empty()),
                avatar_url,
                signed_in,
                active: is_active,
                entries,
                unsent,
            });
        }
        let first_other = usize::from(active.is_some()).min(out.len());
        out[first_other..].sort_by(|a, b| {
            (a.tracker.as_str(), a.username.as_deref().unwrap_or(""))
                .cmp(&(b.tracker.as_str(), b.username.as_deref().unwrap_or("")))
        });
        Ok(out)
    }

    /// Delete another account's database from this computer: its list, history, cached pages, saved sign-in
    /// and unsent changes. Never the account in use. Holds the write connection so a switch to it can't
    /// attach the file meanwhile.
    pub fn remove_stored_account(&self, owner: &ListOwner) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if accounts::read_owner(&conn)?.as_ref() == Some(owner) {
            return Err("The account in use can't be removed: switch to another account first".into());
        }
        let AccountTarget::File(path) = self.account_target(Some(owner)) else {
            return Ok(());
        };
        if !path.exists() {
            return Err("That account isn't on this computer".into());
        }
        // The database file last: an interrupted removal leaves a file the account list still shows
        for file in sidecars(&path).iter().rev() {
            if file.exists() {
                std::fs::remove_file(file).map_err(|e| format!("Removing {}: {}", file.display(), e))?;
            }
        }
        drop(conn);
        log::info!(target: "app", "removed account database {}", account_file_stem(Some(owner)));
        Ok(())
    }

    /// The account database's name (`anilist-460805`, `local`), for settings backups.
    pub fn account_name(&self) -> Result<String, String> {
        Ok(account_file_stem(self.list_owner()?.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_entry;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tora-storage-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn switching_accounts_keeps_each_ones_data() {
        let dir = temp_dir("switch");
        let db = Database::open(&dir.join("tora_library.db")).unwrap();
        let anilist = ListOwner::new("anilist", 7);
        let mal = ListOwner::new("mal", 99);

        // Before any sign-in: the local file; the first account adopts it
        db.upsert_anime_entry(&test_entry(1, "Frieren")).unwrap();
        db.set_release_preference(1, Some("folder|group")).unwrap();
        assert!(!db.switch_account(&anilist).unwrap(), "the local list became AniList's");
        assert!(dir.join("accounts").join("anilist-7.db").exists());
        assert!(!dir.join("accounts").join("local.db").exists());
        assert!(db.get_anime_entry_by_id(1).is_ok());

        assert!(db.switch_account(&mal).unwrap(), "MAL's database is new");
        assert!(db.get_anime_entry_by_id(1).is_err());
        assert!(db.release_preferences().unwrap().is_empty());
        db.upsert_anime_entry(&test_entry(5, "MAL anime")).unwrap();

        assert!(!db.switch_account(&anilist).unwrap());
        assert!(db.get_anime_entry_by_id(1).is_ok(), "AniList's list as it was");
        assert!(db.get_anime_entry_by_id(5).is_err());
        assert_eq!(db.release_preferences().unwrap().get(&1).map(String::as_str), Some("folder|group"));
        assert_eq!(db.list_owner().unwrap(), Some(anilist));
        // The reader connection follows the switch
        assert_eq!(db.list_anime_entries().unwrap().len(), 1);

        drop(db);
        // Reopened: the active account's database is attached again
        let db = Database::open(&dir.join("tora_library.db")).unwrap();
        assert!(db.get_anime_entry_by_id(1).is_ok());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn work_for_one_account_never_writes_into_another() {
        let dir = temp_dir("epoch");
        let db = Database::open(&dir.join("tora_library.db")).unwrap();
        db.switch_account(&ListOwner::new("anilist", 7)).unwrap();
        let epoch = db.account_epoch();
        assert_eq!(db.for_account(epoch, |_| Ok(1)).unwrap(), 1);
        db.switch_account(&ListOwner::new("mal", 99)).unwrap();
        assert_eq!(db.for_account(epoch, |_| Ok(1)).unwrap_err(), ACCOUNT_CHANGED);
        assert!(db.for_account(db.account_epoch(), |_| Ok(())).is_ok());
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_switch_keeps_the_previous_account() {
        let dir = temp_dir("failed-switch");
        let db = Database::open(&dir.join("tora_library.db")).unwrap();
        let anilist = ListOwner::new("anilist", 7);
        db.switch_account(&anilist).unwrap();
        db.upsert_anime_entry(&test_entry(1, "Frieren")).unwrap();
        let epoch = db.account_epoch();
        // A folder where the file should be: SQLite can't open it
        std::fs::create_dir_all(dir.join("accounts").join("mal-99.db")).unwrap();
        assert!(db.switch_account(&ListOwner::new("mal", 99)).is_err());
        assert_eq!(db.list_owner().unwrap(), Some(anilist));
        assert_eq!(db.account_epoch(), epoch);
        assert!(db.get_anime_entry_by_id(1).is_ok(), "the previous list is still attached");
        assert_eq!(db.list_anime_entries().unwrap().len(), 1, "on the reader too");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_existing_account_file_is_kept_aside_when_the_list_comes_back() {
        let dir = temp_dir("re-split");
        let accounts_dir = dir.join("accounts");
        std::fs::create_dir_all(&accounts_dir).unwrap();
        {
            // This build's file, then an older Tora that put a list back into `main`
            let conn = Connection::open(accounts_dir.join("anilist-7.db")).unwrap();
            conn.execute_batch("CREATE TABLE marker (x INTEGER); INSERT INTO marker VALUES (42);").unwrap();
            let main = Connection::open(dir.join("tora_library.db")).unwrap();
            main.execute_batch(
                "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
                 CREATE TABLE anime_entries (id INTEGER PRIMARY KEY, anilist_id INTEGER UNIQUE,
                     title_romaji TEXT NOT NULL);
                 INSERT INTO anime_entries (id, anilist_id, title_romaji) VALUES (21, 21, 'One Piece');
                 INSERT INTO app_settings VALUES ('list_owner_user_id', '7');",
            )
            .unwrap();
        }
        let db = Database::open(&dir.join("tora_library.db")).unwrap();
        assert!(db.get_anime_entry_by_id(21).is_ok());
        let kept: Vec<PathBuf> = std::fs::read_dir(&accounts_dir)
            .unwrap()
            .flatten()
            .map(|f| f.path())
            .filter(|p| p.to_string_lossy().contains("anilist-7.db.replaced-"))
            .filter(|p| !p.to_string_lossy().ends_with("-wal") && !p.to_string_lossy().ends_with("-shm"))
            .collect();
        assert_eq!(kept.len(), 1, "the old file is kept aside");
        let old = Connection::open(&kept[0]).unwrap();
        let marker: i64 = old.query_row("SELECT x FROM marker", [], |r| r.get(0)).unwrap();
        assert_eq!(marker, 42);
        assert_eq!(db.stored_accounts().unwrap().len(), 1, "never listed as an account");
        drop(old);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_an_account_deletes_only_its_file() {
        let dir = temp_dir("remove");
        let db = Database::open(&dir.join("tora_library.db")).unwrap();
        let anilist = ListOwner::new("anilist", 7);
        let mal = ListOwner::new("mal", 99);
        db.switch_account(&anilist).unwrap();
        db.switch_account(&mal).unwrap();
        db.upsert_anime_entry(&test_entry(5, "MAL anime")).unwrap();

        assert!(db.remove_stored_account(&mal).is_err(), "never the account in use");
        let accounts = db.stored_accounts().unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].entries, 1);

        db.remove_stored_account(&anilist).unwrap();
        assert!(!dir.join("accounts").join("anilist-7.db").exists());
        assert!(dir.join("accounts").join("mal-99.db").exists());
        let accounts = db.stored_accounts().unwrap();
        assert_eq!(accounts.len(), 1);
        assert!(accounts[0].active);
        assert!(db.get_anime_entry_by_id(5).is_ok(), "the list in use is untouched");
        assert!(db.remove_stored_account(&anilist).is_err(), "already gone");
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_single_file_database_moves_into_its_account_file() {
        let dir = temp_dir("legacy");
        let path = dir.join("tora_library.db");
        {
            // The layout before account files: everything in one database
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
                 CREATE TABLE anime_entries (id INTEGER PRIMARY KEY, anilist_id INTEGER UNIQUE,
                     title_romaji TEXT NOT NULL, user_progress INTEGER NOT NULL DEFAULT 0, custom_folder TEXT);
                 CREATE TABLE watch_history (id INTEGER PRIMARY KEY AUTOINCREMENT, anime_id INTEGER,
                     anime_title TEXT NOT NULL, episode_number INTEGER NOT NULL, player_name TEXT NOT NULL,
                     file_name TEXT NOT NULL, scrobbled_to_tracker INTEGER NOT NULL DEFAULT 0,
                     timestamp_unix INTEGER NOT NULL);
                 INSERT INTO anime_entries (id, anilist_id, title_romaji, user_progress, custom_folder)
                     VALUES (21, 21, 'One Piece', 1100, 'D:\\Anime\\One Piece');
                 INSERT INTO watch_history (anime_id, anime_title, episode_number, player_name, file_name, timestamp_unix)
                     VALUES (21, 'One Piece', 1100, 'mpv', 'op.mkv', 1);
                 INSERT INTO app_settings VALUES ('list_owner_user_id', '7');
                 INSERT INTO app_settings VALUES ('release_preferences', '{\"21\":\"folder|group\"}');
                 INSERT INTO app_settings VALUES ('torrent_feeds', '[]');",
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert!(dir.join("accounts").join("anilist-7.db").exists());
        let entry = db.get_anime_entry_by_id(21).unwrap();
        assert_eq!(entry.user_progress, 1100);
        assert_eq!(entry.custom_folder.as_deref(), Some("D:\\Anime\\One Piece"));
        assert_eq!(db.release_preferences().unwrap().get(&21).map(String::as_str), Some("folder|group"));
        assert_eq!(db.list_owner().unwrap(), Some(ListOwner::new("anilist", 7)));
        {
            let conn = db.conn.lock().unwrap();
            assert!(!table_exists_in(&conn, "main", "anime_entries").unwrap(), "moved out of the device file");
            let history: i64 = conn.query_row("SELECT COUNT(*) FROM acct.watch_history", [], |r| r.get(0)).unwrap();
            assert_eq!(history, 1);
            // Device keys stay in the device file
            assert!(read_setting(&conn, "torrent_feeds").unwrap().is_some());
            let device_prefs: Option<String> = conn
                .query_row("SELECT value_json FROM main.app_settings WHERE key = 'release_preferences'", [], |r| r.get(0))
                .optional()
                .unwrap();
            assert_eq!(device_prefs, None);
        }
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn account_keys_live_in_the_account_file() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        write_setting(&conn, crate::db::settings::RELEASE_PREFERENCES_KEY, "{}").unwrap();
        write_setting(&conn, crate::db::settings::TORRENT_FEEDS_KEY, "[]").unwrap();
        let in_table = |table: &str, key: &str| -> bool {
            conn.query_row(&format!("SELECT 1 FROM {table} WHERE key = ?1"), params![key], |_| Ok(()))
                .optional()
                .unwrap()
                .is_some()
        };
        assert!(in_table("acct.app_settings", "release_preferences"));
        assert!(!in_table("main.app_settings", "release_preferences"));
        assert!(in_table("main.app_settings", "torrent_feeds"));
    }
}
