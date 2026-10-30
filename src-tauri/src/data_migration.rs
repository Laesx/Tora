//! Moves data left by builds that used the old app identifier (`app.tora.anime`, before v0.3.0) into
//! the current identifier's folders. Tauri derives both data folders from the identifier:
//! `%APPDATA%\<id>` (SQLite library, settings backups, cached relations, .torrent files, logs) and
//! `%LOCALAPPDATA%\<id>` (the WebView2 profile: localStorage view prefs). Runs in `run()` before the
//! builder, because Tauri creates the main window (and its WebView2 profile) before `setup`.
//!
//! TODO: Remove this in a few versions, no one should have it by then, since people only ever got 0.1.0.

use std::fs;
use std::path::Path;

const LEGACY_IDENTIFIER: &str = "app.tora.anime";
const DB_FILE: &str = "tora_library.db";

/// Move the legacy folders' contents under `identifier`. Never overwrites: an entry that already
/// exists in the new folder stays and the old copy is left behind (logged).
pub fn migrate_legacy_data_dirs(identifier: &str) {
    if identifier == LEGACY_IDENTIFIER {
        return;
    }
    for base in [dirs::data_dir(), dirs::data_local_dir()]
        .into_iter()
        .flatten()
    {
        let old = base.join(LEGACY_IDENTIFIER);
        if old.is_dir() {
            move_dir_contents(&old, &base.join(identifier));
        }
    }
}

/// Move every entry of `old` into `new` (created if needed), then remove `old` once empty.
/// The SQLite database and its `-wal` / `-shm` files only move together, and only when `new` has
/// no database yet: mixing a WAL file with another database would corrupt it.
fn move_dir_contents(old: &Path, new: &Path) {
    if let Err(e) = fs::create_dir_all(new) {
        eprintln!("[migrate] can't create {}: {}", new.display(), e);
        return;
    }
    let keep_db = new.join(DB_FILE).exists();
    let Ok(entries) = fs::read_dir(old) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let is_db_file = name.to_string_lossy().starts_with(DB_FILE);
        let target = new.join(&name);
        if (is_db_file && keep_db) || target.exists() {
            eprintln!(
                "[migrate] {} already exists, leaving {} in place",
                target.display(),
                entry.path().display()
            );
            continue;
        }
        if let Err(e) = fs::rename(entry.path(), &target) {
            eprintln!("[migrate] failed to move {}: {}", entry.path().display(), e);
        }
    }
    // Fails (and keeps the folder) while anything was left behind
    if fs::remove_dir(old).is_ok() {
        println!("[migrate] moved {} to {}", old.display(), new.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tora-migrate-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn moves_everything_into_a_new_folder() {
        let root = temp_dir("fresh");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(old.join("backups")).unwrap();
        fs::write(old.join(DB_FILE), "db").unwrap();
        fs::write(old.join(format!("{}-wal", DB_FILE)), "wal").unwrap();

        move_dir_contents(&old, &new);

        assert!(!old.exists());
        assert_eq!(fs::read_to_string(new.join(DB_FILE)).unwrap(), "db");
        assert!(new.join(format!("{}-wal", DB_FILE)).exists());
        assert!(new.join("backups").is_dir());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn merges_into_an_existing_folder_without_overwriting() {
        // %LOCALAPPDATA%\Tora is also the install folder: it already holds tora.exe
        let root = temp_dir("existing");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(old.join("EBWebView")).unwrap();
        fs::write(old.join("shared.txt"), "old").unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("tora.exe"), "exe").unwrap();
        fs::write(new.join("shared.txt"), "new").unwrap();

        move_dir_contents(&old, &new);

        assert!(new.join("EBWebView").is_dir());
        assert!(new.join("tora.exe").exists());
        assert_eq!(fs::read_to_string(new.join("shared.txt")).unwrap(), "new");
        // The clashing file stays behind, so the old folder is kept
        assert!(old.join("shared.txt").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn never_mixes_database_files() {
        let root = temp_dir("db");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(DB_FILE), "old db").unwrap();
        fs::write(old.join(format!("{}-wal", DB_FILE)), "old wal").unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join(DB_FILE), "new db").unwrap();

        move_dir_contents(&old, &new);

        assert_eq!(fs::read_to_string(new.join(DB_FILE)).unwrap(), "new db");
        assert!(!new.join(format!("{}-wal", DB_FILE)).exists());
        assert!(old.join(format!("{}-wal", DB_FILE)).exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
