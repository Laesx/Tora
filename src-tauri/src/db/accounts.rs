//! The signed-in tracker account and the owner of the local list.
//!
//! Both live under their own `app_settings` keys, never inside [`AppSettings`](super::AppSettings): a
//! frontend settings save can't overwrite them, settings backups never contain a token, and the frontend
//! only ever sees [`AccountInfo`] (no tokens).

use super::Database;
use crate::trackers::DEFAULT_TRACKER;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `app_settings` key holding the signed-in [`TrackerAccount`] (absent when signed out).
pub(crate) const TRACKER_ACCOUNT_KEY: &str = "tracker_account";
/// `app_settings` key holding the user id the local list belongs to (a bare integer).
pub(crate) const LIST_OWNER_KEY: &str = "list_owner_user_id";
/// `app_settings` key holding the tracker of [`LIST_OWNER_KEY`]; absent on lists from before other
/// trackers existed, which are AniList lists.
pub(crate) const LIST_OWNER_TRACKER_KEY: &str = "list_owner_tracker";
/// `AppSettings` fields that held the AniList account before [`TRACKER_ACCOUNT_KEY`]; dropped from the
/// stored settings by [`migrate_account_out_of_settings`].
const LEGACY_ACCOUNT_FIELDS: [&str; 5] = [
    "anilist_token",
    "anilist_user_id",
    "anilist_username",
    "anilist_avatar",
    "active_tracker_plugin",
];

/// The signed-in account of one tracker, tokens included. Never sent to the frontend or logged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackerAccount {
    /// Tracker id (`TrackerDescriptor::id`).
    pub tracker: String,
    /// The tracker's user id; 0 only for an account migrated without one (the next profile refresh sets it).
    pub user_id: i64,
    pub username: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Unix second the access token expires; `None` when the tracker doesn't say.
    #[serde(default)]
    pub expires_at: Option<i64>,
}

impl TrackerAccount {
    pub fn info(&self) -> AccountInfo {
        AccountInfo {
            tracker: self.tracker.clone(),
            user_id: self.user_id,
            username: self.username.clone(),
            avatar_url: self.avatar_url.clone(),
        }
    }

    /// The user id, unless it's unknown (a migrated account before its first profile refresh).
    pub fn known_user_id(&self) -> Option<i64> {
        (self.user_id != 0).then_some(self.user_id)
    }
}

/// What the frontend knows about the signed-in account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountInfo {
    pub tracker: String,
    pub user_id: i64,
    pub username: String,
    pub avatar_url: Option<String>,
}

/// The account the local list belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListOwner {
    pub tracker: String,
    pub user_id: i64,
}

impl ListOwner {
    pub fn new(tracker: &str, user_id: i64) -> Self {
        Self {
            tracker: tracker.to_string(),
            user_id,
        }
    }
}

fn read_key(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value_json FROM app_settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn write_key(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES (?1, ?2)",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn read_owner(conn: &Connection) -> Result<Option<ListOwner>, String> {
    let Some(user_id) = read_key(conn, LIST_OWNER_KEY)?.and_then(|v| v.trim().parse::<i64>().ok()) else {
        return Ok(None);
    };
    let tracker = read_key(conn, LIST_OWNER_TRACKER_KEY)?
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_TRACKER.to_string());
    Ok(Some(ListOwner { tracker, user_id }))
}

/// Writes both owner keys (inside the caller's transaction or connection).
pub(crate) fn write_owner(conn: &Connection, owner: &ListOwner) -> Result<(), String> {
    write_key(conn, LIST_OWNER_KEY, &owner.user_id.to_string())?;
    write_key(conn, LIST_OWNER_TRACKER_KEY, &owner.tracker)
}

/// One-time move of the AniList account out of the stored `AppSettings` (before multi-tracker support the
/// token, user id, name and avatar were settings fields). The account goes to [`TRACKER_ACCOUNT_KEY`] and
/// the old fields are removed from the stored settings, so no token stays in `main` (or in later backups).
/// Runs after the list-owner migration, which reads `anilist_user_id`.
pub(crate) fn migrate_account_out_of_settings(tx: &Transaction) -> Result<(), String> {
    let Some(raw) = read_key(tx, super::settings::MAIN_SETTINGS_KEY)? else {
        return Ok(());
    };
    let Ok(Value::Object(mut main)) = serde_json::from_str::<Value>(&raw) else {
        return Ok(()); // unreadable settings are left to the recovery path
    };
    if !LEGACY_ACCOUNT_FIELDS.iter().any(|f| main.contains_key(*f)) {
        return Ok(());
    }
    let text = |key: &str| main.get(key).and_then(|v| v.as_str()).map(str::trim).unwrap_or_default().to_string();
    let token = text("anilist_token");
    if !token.is_empty() && read_key(tx, TRACKER_ACCOUNT_KEY)?.is_none() {
        // A token without a stored user id: the list owner's, else unknown until the profile is refreshed
        let user_id = main
            .get("anilist_user_id")
            .and_then(|v| v.as_i64())
            .or(read_owner(tx)?.filter(|o| o.tracker == DEFAULT_TRACKER).map(|o| o.user_id))
            .unwrap_or(0);
        let account = TrackerAccount {
            tracker: DEFAULT_TRACKER.to_string(),
            user_id,
            username: text("anilist_username"),
            avatar_url: Some(text("anilist_avatar")).filter(|a| !a.is_empty()),
            access_token: token,
            refresh_token: None,
            expires_at: None,
        };
        write_key(tx, TRACKER_ACCOUNT_KEY, &serde_json::to_string(&account).map_err(|e| e.to_string())?)?;
    }
    for field in LEGACY_ACCOUNT_FIELDS {
        main.remove(field);
    }
    write_key(tx, super::settings::MAIN_SETTINGS_KEY, &Value::Object(main).to_string())?;
    log::info!(target: "settings", "moved the tracker account out of the settings");
    Ok(())
}

impl Database {
    /// The signed-in account, if any (unreadable JSON reads as signed out).
    pub fn tracker_account(&self) -> Result<Option<TrackerAccount>, String> {
        let conn = self.reader()?;
        Ok(read_key(&conn, TRACKER_ACCOUNT_KEY)?.and_then(|json| match serde_json::from_str(&json) {
            Ok(account) => Some(account),
            Err(e) => {
                log::warn!(target: "settings", "stored tracker account is unreadable: {}", e);
                None
            }
        }))
    }

    pub fn set_tracker_account(&self, account: &TrackerAccount) -> Result<(), String> {
        let json = serde_json::to_string(account).map_err(|e| e.to_string())?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        write_key(&conn, TRACKER_ACCOUNT_KEY, &json)
    }

    pub fn clear_tracker_account(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM app_settings WHERE key = ?1", params![TRACKER_ACCOUNT_KEY])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// The account the local list belongs to (`None` before the first sign-in).
    pub fn list_owner(&self) -> Result<Option<ListOwner>, String> {
        let conn = self.reader()?;
        read_owner(&conn)
    }

    pub fn set_list_owner(&self, owner: &ListOwner) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        write_owner(&conn, owner)
    }

    /// The tracker Tora works with: the signed-in account's, else the list owner's, else the default.
    pub fn active_tracker_id(&self) -> Result<String, String> {
        if let Some(account) = self.tracker_account()? {
            return Ok(account.tracker);
        }
        Ok(self
            .list_owner()?
            .map(|o| o.tracker)
            .unwrap_or_else(|| DEFAULT_TRACKER.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::settings::MAIN_SETTINGS_KEY;

    fn store_main(db: &Database, json: &str) {
        let conn = db.conn.lock().unwrap();
        write_key(&conn, MAIN_SETTINGS_KEY, json).unwrap();
    }

    fn migrate(db: &Database) {
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        migrate_account_out_of_settings(&tx).unwrap();
        tx.commit().unwrap();
    }

    fn raw_main(db: &Database) -> Value {
        let conn = db.conn.lock().unwrap();
        serde_json::from_str(&read_key(&conn, MAIN_SETTINGS_KEY).unwrap().unwrap()).unwrap()
    }

    #[test]
    fn signed_in_settings_become_an_account_and_lose_the_token() {
        let db = Database::open_in_memory().unwrap();
        store_main(
            &db,
            r#"{"theme":"sakura","active_tracker_plugin":"anilist","anilist_token":" tok ","anilist_user_id":42,
               "anilist_username":"neko","anilist_avatar":"https://img/a.png"}"#,
        );
        migrate(&db);
        let account = db.tracker_account().unwrap().unwrap();
        assert_eq!(
            account,
            TrackerAccount {
                tracker: "anilist".into(),
                user_id: 42,
                username: "neko".into(),
                avatar_url: Some("https://img/a.png".into()),
                access_token: "tok".into(),
                refresh_token: None,
                expires_at: None,
            }
        );
        let main = raw_main(&db);
        for field in LEGACY_ACCOUNT_FIELDS {
            assert!(main.get(field).is_none(), "{} left in the settings", field);
        }
        assert_eq!(main["theme"], "sakura");
        assert_eq!(db.get_settings().unwrap().theme, "sakura");
        assert_eq!(db.active_tracker_id().unwrap(), "anilist");
    }

    #[test]
    fn signed_out_settings_only_lose_the_old_fields() {
        let db = Database::open_in_memory().unwrap();
        store_main(&db, r#"{"theme":"sakura","anilist_token":"","anilist_username":"","anilist_user_id":null}"#);
        migrate(&db);
        assert!(db.tracker_account().unwrap().is_none());
        assert!(raw_main(&db).get("anilist_token").is_none());
    }

    #[test]
    fn a_token_without_a_user_id_takes_the_list_owner() {
        let db = Database::open_in_memory().unwrap();
        db.set_list_owner(&ListOwner::new("anilist", 7)).unwrap();
        store_main(&db, r#"{"anilist_token":"tok"}"#);
        migrate(&db);
        let account = db.tracker_account().unwrap().unwrap();
        assert_eq!((account.user_id, account.known_user_id()), (7, Some(7)));
    }

    #[test]
    fn an_existing_account_is_never_replaced() {
        let db = Database::open_in_memory().unwrap();
        let account = TrackerAccount {
            tracker: "anilist".into(),
            user_id: 1,
            username: "current".into(),
            avatar_url: None,
            access_token: "new".into(),
            refresh_token: None,
            expires_at: None,
        };
        db.set_tracker_account(&account).unwrap();
        store_main(&db, r#"{"anilist_token":"old","anilist_user_id":2}"#);
        migrate(&db);
        assert_eq!(db.tracker_account().unwrap().unwrap(), account);
    }

    #[test]
    fn legacy_owner_is_an_anilist_owner() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.list_owner().unwrap(), None);
        {
            let conn = db.conn.lock().unwrap();
            write_key(&conn, LIST_OWNER_KEY, "42").unwrap();
        }
        assert_eq!(db.list_owner().unwrap(), Some(ListOwner::new("anilist", 42)));
        db.set_list_owner(&ListOwner::new("other", 5)).unwrap();
        assert_eq!(db.list_owner().unwrap(), Some(ListOwner::new("other", 5)));
        // Signed out: the owner's tracker is the active one
        assert_eq!(db.active_tracker_id().unwrap(), "other");
    }
}
