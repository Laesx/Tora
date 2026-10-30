//! Settings persistence safety: lenient loading (one bad field never resets the others) and rolling
//! snapshots of every user-config key in `app_data\backups\`, restorable from Settings → About.

use super::{AppSettings, Database};
use rusqlite::{params, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// `app_settings` key holding the serialized [`AppSettings`].
pub const MAIN_SETTINGS_KEY: &str = "main";
/// User-config keys stored next to `main` (torrent feeds, filters, priority tiers, fansub overrides).
pub const TORRENT_FEEDS_KEY: &str = "torrent_feeds";
pub const TORRENT_FILTERS_KEY: &str = "torrent_filters";
pub const TORRENT_PRIORITY_KEY: &str = "torrent_priority";
pub const TORRENT_FANSUBS_KEY: &str = "torrent_fansubs";
pub const TORRENT_BOARD_OPTIONS_KEY: &str = "torrent_board_options";
pub const TORRENT_SEARCH_FEEDS_KEY: &str = "torrent_search_feeds";

/// Every key a backup snapshots (and a restore writes back).
const BACKED_UP_KEYS: [&str; 7] = [
    MAIN_SETTINGS_KEY,
    TORRENT_FEEDS_KEY,
    TORRENT_FILTERS_KEY,
    TORRENT_PRIORITY_KEY,
    TORRENT_FANSUBS_KEY,
    TORRENT_BOARD_OPTIONS_KEY,
    TORRENT_SEARCH_FEEDS_KEY,
];
/// Account fields a restore never takes from the backup: an old token may be expired or belong to an
/// account other than the list owner.
const ACCOUNT_FIELDS: [&str; 4] = [
    "anilist_token",
    "anilist_user_id",
    "anilist_username",
    "anilist_avatar",
];
/// Settings fields that were renamed: old key → new key (the old value is used when the new one is absent).
const RENAMED_FIELDS: [(&str, &str); 1] = [("qbittorrent_category", "torrent_category")];

const MAX_BACKUPS: usize = 20;
/// Minimum age of the newest backup before a settings change writes another one.
pub const BACKUP_MIN_INTERVAL_SECS: i64 = 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SettingsSnapshot {
    version: u32,
    created_at: i64,
    /// Parsed JSON per `app_settings` key; keys that were never written are absent.
    values: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsBackupInfo {
    pub file_name: String,
    pub created_at: i64,
    pub size_bytes: u64,
    pub summary: String,
}

/// Lays the stored settings over the defaults field by field. A field that is missing, unknown or fails to
/// deserialize keeps its default; every other field keeps its stored value. `None` if the text isn't a
/// JSON object at all.
pub(crate) fn settings_from_json(json: &str) -> Option<AppSettings> {
    let Value::Object(mut stored) = serde_json::from_str::<Value>(json).ok()? else {
        return None;
    };
    for (old, new) in RENAMED_FIELDS {
        if !stored.contains_key(new) {
            if let Some(v) = stored.get(old).cloned() {
                stored.insert(new.to_string(), v);
            }
        }
    }
    let Ok(Value::Object(mut merged)) = serde_json::to_value(AppSettings::default()) else {
        return None;
    };
    // Fast path: the stored object is complete and valid.
    if let Ok(settings) = serde_json::from_value::<AppSettings>(Value::Object(stored.clone())) {
        return Some(settings);
    }
    for (key, value) in stored {
        let Some(slot) = merged.get_mut(&key) else { continue };
        let previous = std::mem::replace(slot, value);
        if serde_json::from_value::<AppSettings>(Value::Object(merged.clone())).is_err() {
            log::warn!(target: "settings", "stored field `{}` is invalid; using its default", key);
            merged.insert(key, previous);
        }
    }
    serde_json::from_value(Value::Object(merged)).ok()
}

fn read_key(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value_json FROM app_settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn backup_file_name(created_at_ms: i64) -> String {
    let stamp = chrono::DateTime::from_timestamp_millis(created_at_ms)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y%m%d-%H%M%S-%3f").to_string())
        .unwrap_or_else(|| created_at_ms.to_string());
    format!("settings-{}.json", stamp)
}

/// Backup files in `dir`, newest first (the timestamped names sort chronologically).
fn backup_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("settings-") && n.ends_with(".json"))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files.reverse();
    files
}

fn read_snapshot(path: &Path) -> Option<SettingsSnapshot> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn snapshot_summary(snapshot: &SettingsSnapshot) -> String {
    let mut parts = Vec::new();
    if let Some(main) = snapshot.values.get(MAIN_SETTINGS_KEY) {
        if let Some(theme) = main.get("theme").and_then(|v| v.as_str()) {
            parts.push(format!("theme {}", theme));
        }
        if let Some(user) = main
            .get("anilist_username")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            parts.push(format!("AniList {}", user));
        }
    } else {
        parts.push("no main settings".into());
    }
    let count = |key: &str| {
        snapshot
            .values
            .get(key)
            .and_then(|v| v.as_array().map(|a| a.len()).or_else(|| v.as_object().map(|o| o.len())))
            .unwrap_or(0)
    };
    parts.push(format!("{} feeds", count(TORRENT_FEEDS_KEY)));
    parts.push(format!("{} search feeds", count(TORRENT_SEARCH_FEEDS_KEY)));
    parts.push(format!("{} filters", count(TORRENT_FILTERS_KEY)));
    parts.push(format!("{} fansub overrides", count(TORRENT_FANSUBS_KEY)));
    parts.join(" · ")
}

impl Database {
    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let raw = {
            let reader = self.reader()?;
            read_key(&reader, MAIN_SETTINGS_KEY)?
        };
        if let Some(json) = raw {
            return Ok(self.settings_or_recovered(&json));
        }

        // First run: persist the defaults on the write connection (re-check under the writer lock).
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if let Some(json) = read_key(&conn, MAIN_SETTINGS_KEY)? {
            return Ok(self.settings_or_recovered(&json));
        }
        let def = AppSettings::default();
        let json = serde_json::to_string(&def).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES (?1, ?2)",
            params![MAIN_SETTINGS_KEY, json],
        )
        .map_err(|e| e.to_string())?;
        Ok(def)
    }

    /// Unreadable settings leave the stored row untouched and return defaults flagged `settings_recovered`,
    /// so the frontend can offer a backup restore.
    fn settings_or_recovered(&self, json: &str) -> AppSettings {
        settings_from_json(json).unwrap_or_else(|| {
            log::warn!(target: "settings", "stored settings are not valid JSON; using defaults until restored");
            AppSettings {
                settings_recovered: true,
                ..AppSettings::default()
            }
        })
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            // Never silently overwrite a row we couldn't read: keep the raw text next to the backups.
            if let Some(existing) = read_key(&conn, MAIN_SETTINGS_KEY)? {
                if settings_from_json(&existing).is_none() {
                    self.write_raw_backup("settings-unreadable", &existing);
                }
            }
            let json = serde_json::to_string(settings).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES (?1, ?2)",
                params![MAIN_SETTINGS_KEY, json],
            )
            .map_err(|e| e.to_string())?;
        }
        let _ = self.backup_settings_if_changed(Some(BACKUP_MIN_INTERVAL_SECS));
        Ok(())
    }

    /// Typed JSON value stored under an `app_settings` key (`None` if absent or unreadable).
    pub fn get_config_json<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, String> {
        let raw = {
            let reader = self.reader()?;
            read_key(&reader, key)?
        };
        Ok(raw.and_then(|json| match serde_json::from_str(&json) {
            Ok(v) => Some(v),
            Err(e) => {
                log::warn!(target: "settings", "stored `{}` is unreadable: {}", key, e);
                None
            }
        }))
    }

    pub fn set_config_json<T: Serialize>(&self, key: &str, value: &T) -> Result<(), String> {
        let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES (?1, ?2)",
                params![key, json],
            )
            .map_err(|e| e.to_string())?;
        }
        let _ = self.backup_settings_if_changed(Some(BACKUP_MIN_INTERVAL_SECS));
        Ok(())
    }

    fn current_snapshot(&self) -> Result<SettingsSnapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut values = Map::new();
        for key in BACKED_UP_KEYS {
            if let Some(raw) = read_key(&conn, key)? {
                // Unparseable text is kept verbatim as a JSON string so nothing is lost.
                let v = serde_json::from_str::<Value>(&raw).unwrap_or(Value::String(raw));
                values.insert(key.to_string(), v);
            }
        }
        Ok(SettingsSnapshot {
            version: 1,
            created_at: chrono::Utc::now().timestamp(),
            values,
        })
    }

    fn write_raw_backup(&self, prefix: &str, text: &str) {
        let Some(dir) = self.backup_dir.as_ref() else { return };
        let _ = std::fs::create_dir_all(dir);
        let name = format!(
            "{}-{}.txt",
            prefix,
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        );
        let _ = std::fs::write(dir.join(name), text);
    }

    fn write_snapshot(&self, dir: &Path, snapshot: &SettingsSnapshot) -> Result<String, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        // Names are fixed-width local timestamps, so they sort chronologically; on a clash (two snapshots in
        // the same millisecond, e.g. "snapshot before restore") step forward instead of suffixing.
        let mut ms = chrono::Utc::now().timestamp_millis();
        let mut name = backup_file_name(ms);
        while dir.join(&name).exists() {
            ms += 1;
            name = backup_file_name(ms);
        }
        let json = serde_json::to_string_pretty(snapshot).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(&name), json).map_err(|e| e.to_string())?;
        for old in backup_files(dir).into_iter().skip(MAX_BACKUPS) {
            let _ = std::fs::remove_file(old);
        }
        Ok(name)
    }

    /// Writes a snapshot when the config differs from the newest backup and (with `min_interval`) that
    /// backup is at least that old. Returns the new file name, if one was written.
    pub fn backup_settings_if_changed(&self, min_interval: Option<i64>) -> Result<Option<String>, String> {
        let Some(dir) = self.backup_dir.clone() else { return Ok(None) };
        let snapshot = self.current_snapshot()?;
        if snapshot.values.is_empty() {
            return Ok(None);
        }
        if let Some(newest) = backup_files(&dir).first().and_then(|p| read_snapshot(p)) {
            if newest.values == snapshot.values {
                return Ok(None);
            }
            if let Some(min) = min_interval {
                if snapshot.created_at - newest.created_at < min {
                    return Ok(None);
                }
            }
        }
        self.write_snapshot(&dir, &snapshot).map(Some)
    }

    /// Writes a snapshot now, even if nothing changed since the newest one.
    pub fn backup_settings_now(&self) -> Result<String, String> {
        let dir = self.backup_dir.clone().ok_or("Backups are unavailable")?;
        let snapshot = self.current_snapshot()?;
        self.write_snapshot(&dir, &snapshot)
    }

    pub fn list_settings_backups(&self) -> Result<Vec<SettingsBackupInfo>, String> {
        let Some(dir) = self.backup_dir.as_ref() else { return Ok(vec![]) };
        Ok(backup_files(dir)
            .into_iter()
            .filter_map(|path| {
                let snapshot = read_snapshot(&path)?;
                Some(SettingsBackupInfo {
                    file_name: path.file_name()?.to_str()?.to_string(),
                    created_at: snapshot.created_at,
                    size_bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                    summary: snapshot_summary(&snapshot),
                })
            })
            .collect())
    }

    /// Restores every backed-up key from `file_name` (current state is snapshotted first), keeping the
    /// current AniList account fields. Keys absent from the backup are left as they are.
    pub fn restore_settings_backup(&self, file_name: &str) -> Result<AppSettings, String> {
        let dir = self.backup_dir.clone().ok_or("Backups are unavailable")?;
        if file_name.contains(['/', '\\']) || file_name.contains("..") {
            return Err("Invalid backup name".into());
        }
        let snapshot = read_snapshot(&dir.join(file_name)).ok_or("Backup is missing or unreadable")?;
        let current = self.get_settings()?;
        self.backup_settings_now()?;

        let mut values = snapshot.values;
        if let Some(Value::Object(main)) = values.get_mut(MAIN_SETTINGS_KEY) {
            let current_json = serde_json::to_value(&current).map_err(|e| e.to_string())?;
            for field in ACCOUNT_FIELDS {
                if let Some(v) = current_json.get(field) {
                    main.insert(field.to_string(), v.clone());
                }
            }
            let restored = settings_from_json(&Value::Object(main.clone()).to_string())
                .ok_or("Backup settings are unreadable")?;
            *main = match serde_json::to_value(&restored).map_err(|e| e.to_string())? {
                Value::Object(m) => m,
                _ => return Err("Backup settings are unreadable".into()),
            };
        }

        {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (key, value) in &values {
                if !BACKED_UP_KEYS.contains(&key.as_str()) {
                    continue;
                }
                let text = match value {
                    // Verbatim text kept from an unparseable row.
                    Value::String(s) if key != MAIN_SETTINGS_KEY => s.clone(),
                    other => other.to_string(),
                };
                tx.execute(
                    "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES (?1, ?2)",
                    params![key, text],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        self.get_settings()
    }

    #[cfg(test)]
    pub(crate) fn set_backup_dir(&mut self, dir: PathBuf) {
        self.backup_dir = Some(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tora-settings-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_fields_keep_stored_values() {
        let json = r##"{"theme":"sakura","accent_color":"#123456","anilist_token":"tok"}"##;
        let s = settings_from_json(json).unwrap();
        assert_eq!(s.theme, "sakura");
        assert_eq!(s.accent_color, "#123456");
        assert_eq!(s.anilist_token, "tok");
        assert_eq!(s.view_mode, AppSettings::default().view_mode);
    }

    #[test]
    fn one_bad_field_defaults_alone() {
        let json = r#"{"theme":"sakura","recognition_delay_seconds":"soon","anilist_token":"tok"}"#;
        let s = settings_from_json(json).unwrap();
        assert_eq!(s.theme, "sakura");
        assert_eq!(s.anilist_token, "tok");
        assert_eq!(
            s.recognition_delay_seconds,
            AppSettings::default().recognition_delay_seconds
        );
    }

    #[test]
    fn renamed_field_carries_over() {
        let s = settings_from_json(r#"{"qbittorrent_category":"tv"}"#).unwrap();
        assert_eq!(s.torrent_category, "tv");
        let s = settings_from_json(r#"{"qbittorrent_category":"tv","torrent_category":"anime2"}"#).unwrap();
        assert_eq!(s.torrent_category, "anime2");
    }

    #[test]
    fn corrupt_json_is_left_untouched() {
        let db = Database::open_in_memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES ('main', '{not json')",
                [],
            )
            .unwrap();
        }
        let s = db.get_settings().unwrap();
        assert!(s.settings_recovered);
        let conn = db.conn.lock().unwrap();
        let raw = read_key(&conn, MAIN_SETTINGS_KEY).unwrap().unwrap();
        assert_eq!(raw, "{not json");
    }

    #[test]
    fn backups_write_prune_and_restore_keeping_account() {
        let dir = temp_dir("restore");
        let mut db = Database::open_in_memory().unwrap();
        db.set_backup_dir(dir.clone());

        let mut s = db.get_settings().unwrap();
        s.theme = "first".into();
        s.anilist_token = "old-token".into();
        db.save_settings(&s).unwrap();
        db.set_config_json(TORRENT_FEEDS_KEY, &vec!["a"]).unwrap();
        let first = db.backup_settings_now().unwrap();

        // Unchanged config writes nothing.
        assert!(db.backup_settings_if_changed(None).unwrap().is_none());

        s.theme = "second".into();
        s.anilist_token = "new-token".into();
        db.save_settings(&s).unwrap();
        db.set_config_json(TORRENT_FEEDS_KEY, &vec!["a", "b"]).unwrap();

        let restored = db.restore_settings_backup(&first).unwrap();
        assert_eq!(restored.theme, "first");
        assert_eq!(restored.anilist_token, "new-token");
        let feeds: Vec<String> = db.get_config_json(TORRENT_FEEDS_KEY).unwrap().unwrap();
        assert_eq!(feeds, vec!["a"]);
        // The pre-restore state was snapshotted too.
        assert!(db.list_settings_backups().unwrap().len() >= 2);

        for _ in 0..(MAX_BACKUPS + 5) {
            db.backup_settings_now().unwrap();
        }
        assert_eq!(backup_files(&dir).len(), MAX_BACKUPS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_paths() {
        let mut db = Database::open_in_memory().unwrap();
        db.set_backup_dir(temp_dir("paths"));
        assert!(db.restore_settings_backup("..\\tora_library.db").is_err());
    }
}
