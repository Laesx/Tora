use crate::db::{AnimeMatcherIndex, Database, LibraryFolder, LocalEpisodeFile};
use crate::detection::anitomy::{normalize_anime_title, parse_filename, AnitomyElements};
use rayon::prelude::*;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub folders_scanned: usize,
    pub total_files_indexed: usize,
    pub newly_parsed: usize,
    #[serde(default)]
    pub removed_files: usize,
    pub matched_files: usize,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveStorageSummary {
    pub drive_root: String,
    pub drive_total_bytes: u64,
    pub drive_free_bytes: u64,
    pub anime_bytes: u64,
    pub anime_file_count: u32,
    pub folder_count: u32,
}

/// Represents a single Win32 `ReadDirectoryChangesW` notification.
#[derive(Debug, Clone)]
pub enum DirectoryChangeAction {
    Added(PathBuf),
    Removed(PathBuf),
    Renamed {
        old_path: PathBuf,
        new_path: PathBuf,
    },
}

#[derive(Debug, Clone)]
pub struct DirectoryChangeEvent {
    pub folder_id: i64,
    pub root_path: PathBuf,
    pub drive_root: String,
    pub action: DirectoryChangeAction,
}

pub fn extract_drive_root(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
        format!("{}:\\", (trimmed.as_bytes()[0] as char).to_uppercase())
    } else if trimmed.starts_with("\\\\") {
        let parts: Vec<&str> = trimmed.trim_start_matches("\\\\").split('\\').collect();
        if parts.len() >= 2 {
            format!("\\\\{}\\{}\\", parts[0], parts[1])
        } else {
            "UNC\\".to_string()
        }
    } else {
        "Local\\".to_string()
    }
}

#[cfg(windows)]
pub fn query_drive_space(path: &str) -> (u64, u64) {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let root = extract_drive_root(path);
    let mut wide: Vec<u16> = root.encode_utf16().collect();
    wide.push(0);
    let mut free_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free_total: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_caller as *mut u64,
            &mut total as *mut u64,
            &mut free_total as *mut u64,
        )
    };
    if ok != 0 {
        (total, free_total)
    } else {
        (0, 0)
    }
}

#[cfg(not(windows))]
pub fn query_drive_space(_path: &str) -> (u64, u64) {
    (0, 0)
}

pub fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "mkv" | "mp4" | "avi" | "webm" | "m4v" | "mov" | "ts" | "m2ts"
            )
        })
        .unwrap_or(false)
}

/// Skip hidden and system files/directories.
#[cfg(windows)]
fn is_hidden_or_system(entry: &DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    if entry.depth() == 0 {
        return false;
    }
    entry
        .metadata()
        .map(|m| (m.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_hidden_or_system(entry: &DirEntry) -> bool {
    entry.depth() > 0
        && entry
            .file_name()
            .to_str()
            .map(|s| s.starts_with('.'))
            .unwrap_or(false)
}

struct ParsedEpisodeRow {
    folder_id: i64,
    drive_root: String,
    file_path: String,
    file_name: String,
    file_size: u64,
    modified_unix: i64,
    parsed_title: String,
    normalized_title: String,
    episode_number: Option<u32>,
    anime_season: Option<u32>,
    release_group: Option<String>,
    resolution: Option<String>,
    video_terms_json: String,
    audio_terms_json: String,
    checksum: Option<String>,
    matched_anime_id: Option<i64>,
    watched: i32,
    inferred_folder: Option<(i64, String)>,
}

/// Parses a single video file path and matches it against `AnimeMatcherIndex`.
fn parse_and_match_video_file(
    folder_id: i64,
    drive_root: &str,
    root_path: &Path,
    file_path: &Path,
    file_size: u64,
    modified_unix: i64,
    prev_matched_id: Option<i64>,
    matcher: &AnimeMatcherIndex,
) -> ParsedEpisodeRow {
    let full_str = file_path.to_string_lossy().to_string();
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let rel_str = file_path
        .strip_prefix(root_path)
        .unwrap_or(file_path)
        .to_string_lossy()
        .to_string();
    let parse_input = if rel_str.is_empty() {
        &file_name
    } else {
        &rel_str
    };

    let mut elements = parse_filename(parse_input);

    // Fallback to parent directory name if filename only has episode number (e.g., "Sousou no Frieren\01.mkv")
    let norm_is_weak = elements.normalized_title.is_empty()
        || elements
            .normalized_title
            .chars()
            .all(|c| c.is_ascii_digit())
        || matches!(
            elements.normalized_title.as_str(),
            "episode" | "ep" | "ova" | "special"
        );
    if norm_is_weak {
        if let Some(parent) = file_path.parent() {
            if parent != root_path {
                if let Some(parent_name) = parent.file_name().and_then(|n| n.to_str()) {
                    let parent_parsed = parse_filename(parent_name);
                    if !parent_parsed.anime_title.is_empty() {
                        elements.anime_title = parent_parsed.anime_title;
                        elements.normalized_title = normalize_anime_title(&elements.anime_title);
                        if elements.anime_season.is_none() {
                            elements.anime_season = parent_parsed.anime_season;
                        }
                    }
                }
            }
        }
    }

    let resolved = matcher
        .match_episode(&mut elements, Some(&full_str))
        .map(|(aid, _t, _c, prog, _eps)| (aid, prog))
        .or_else(|| {
            prev_matched_id.and_then(|aid| {
                matcher
                    .by_id
                    .get(&aid)
                    .map(|(_t, _c, prog, _eps)| (aid, *prog))
            })
        });

    let (matched_anime_id, watched, inferred_folder) = match resolved {
        Some((anime_id, user_progress)) => {
            let w = elements
                .episode_number
                .map(|n| n <= user_progress)
                .unwrap_or(false) as i32;
            // If the episode is in a dedicated subfolder, remember it for this anime
            let folder_bind = file_path
                .parent()
                .filter(|p| *p != root_path)
                .map(|p| (anime_id, p.to_string_lossy().to_string()));
            (Some(anime_id), w, folder_bind)
        }
        None => (None, 0, None),
    };

    let video_terms_json =
        serde_json::to_string(&elements.video_term).unwrap_or_else(|_| "[]".into());
    let audio_terms_json =
        serde_json::to_string(&elements.audio_term).unwrap_or_else(|_| "[]".into());

    ParsedEpisodeRow {
        folder_id,
        drive_root: drive_root.to_string(),
        file_path: full_str,
        file_name,
        file_size,
        modified_unix,
        parsed_title: elements.anime_title,
        normalized_title: elements.normalized_title,
        episode_number: elements.episode_number,
        anime_season: elements.anime_season,
        release_group: elements.release_group,
        resolution: elements.video_resolution,
        video_terms_json,
        audio_terms_json,
        checksum: elements.file_checksum,
        matched_anime_id,
        watched,
        inferred_folder,
    }
}

/// Parses a directory name (`parse_path = false`) to bind `custom_folder` on matching anime.
fn match_directory_to_anime(dir_path: &Path, matcher: &AnimeMatcherIndex) -> Option<(i64, String)> {
    let dir_name = dir_path.file_name()?.to_str()?;
    let parsed = parse_filename(dir_name);
    if parsed.normalized_title.is_empty() {
        return None;
    }
    let full_dir = dir_path.to_string_lossy().to_string();
    let (anime_id, _, _, _, _) = matcher.match_title(&parsed.normalized_title, Some(&full_dir))?;
    Some((anime_id, full_dir))
}

fn upsert_episode_rows(
    tx: &rusqlite::Transaction<'_>,
    rows: &[ParsedEpisodeRow],
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut stmt = tx
        .prepare(
            "INSERT INTO local_episodes (
                folder_id, file_path, file_name, drive_root, file_size, modified_unix,
                parsed_title, normalized_title, episode_number, anime_season,
                release_group, resolution, video_terms_json, audio_terms_json, checksum,
                matched_anime_id, watched
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            ON CONFLICT(file_path) DO UPDATE SET
                folder_id = excluded.folder_id,
                file_name = excluded.file_name,
                drive_root = excluded.drive_root,
                file_size = excluded.file_size,
                modified_unix = excluded.modified_unix,
                parsed_title = excluded.parsed_title,
                normalized_title = excluded.normalized_title,
                episode_number = excluded.episode_number,
                anime_season = excluded.anime_season,
                release_group = excluded.release_group,
                resolution = excluded.resolution,
                video_terms_json = excluded.video_terms_json,
                audio_terms_json = excluded.audio_terms_json,
                checksum = excluded.checksum,
                matched_anime_id = COALESCE(excluded.matched_anime_id, local_episodes.matched_anime_id),
                watched = excluded.watched",
        )
        .map_err(|e| e.to_string())?;

    for r in rows {
        stmt.execute(params![
            r.folder_id,
            r.file_path,
            r.file_name,
            r.drive_root,
            r.file_size,
            r.modified_unix,
            r.parsed_title,
            r.normalized_title,
            r.episode_number,
            r.anime_season,
            r.release_group,
            r.resolution,
            r.video_terms_json,
            r.audio_terms_json,
            r.checksum,
            r.matched_anime_id,
            r.watched,
        ])
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl Database {
    pub fn list_library_folders(&self) -> Result<Vec<LibraryFolder>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, path, label, drive_root, enabled, file_count, total_bytes, last_scanned_at
                 FROM library_folders ORDER BY drive_root ASC, path ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let path: String = r.get(1)?;
                let (drive_total, drive_free) = query_drive_space(&path);
                Ok(LibraryFolder {
                    id: r.get(0)?,
                    path,
                    label: r.get(2)?,
                    drive_root: r.get(3)?,
                    enabled: r.get::<_, i32>(4)? != 0,
                    file_count: r.get(5)?,
                    total_bytes: r.get(6)?,
                    last_scanned_at: r.get(7)?,
                    drive_total_bytes: drive_total,
                    drive_free_bytes: drive_free,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    }

    pub fn add_library_folder(
        &self,
        path: &str,
        label: Option<String>,
    ) -> Result<LibraryFolder, String> {
        let clean_path = path.trim().trim_end_matches(['\\', '/']).to_string();
        if clean_path.is_empty() {
            return Err("Folder path cannot be empty".into());
        }
        let p = Path::new(&clean_path);
        if !p.exists() {
            std::fs::create_dir_all(p)
                .map_err(|e| format!("Directory does not exist and could not be created: {}", e))?;
        }
        let drive_root = extract_drive_root(&clean_path);
        let folder_label = label.filter(|l| !l.trim().is_empty()).unwrap_or_else(|| {
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&clean_path)
                .to_string()
        });

        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO library_folders (path, label, drive_root, enabled)
                 VALUES (?1, ?2, ?3, 1)
                 ON CONFLICT(path) DO UPDATE SET label = excluded.label, enabled = 1",
                params![clean_path, folder_label, drive_root],
            )
            .map_err(|e| e.to_string())?;
        }

        let folders = self.list_library_folders()?;
        folders
            .into_iter()
            .find(|f| f.path.eq_ignore_ascii_case(&clean_path))
            .ok_or_else(|| "Failed to retrieve added library folder".into())
    }

    pub fn remove_library_folder(&self, folder_id: i64) -> Result<Vec<LibraryFolder>, String> {
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM local_episodes WHERE folder_id = ?1",
                params![folder_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM library_folders WHERE id = ?1",
                params![folder_id],
            )
            .map_err(|e| e.to_string())?;
        }
        self.list_library_folders()
    }

    pub fn list_drive_summaries(&self) -> Result<Vec<DriveStorageSummary>, String> {
        let folders = self.list_library_folders()?;
        let mut map: HashMap<String, DriveStorageSummary> = HashMap::new();
        for f in folders {
            let entry = map
                .entry(f.drive_root.clone())
                .or_insert_with(|| DriveStorageSummary {
                    drive_root: f.drive_root.clone(),
                    drive_total_bytes: f.drive_total_bytes,
                    drive_free_bytes: f.drive_free_bytes,
                    anime_bytes: 0,
                    anime_file_count: 0,
                    folder_count: 0,
                });
            entry.anime_bytes += f.total_bytes;
            entry.anime_file_count += f.file_count;
            entry.folder_count += 1;
        }
        let mut out: Vec<DriveStorageSummary> = map.into_values().collect();
        out.sort_by(|a, b| a.drive_root.cmp(&b.drive_root));
        Ok(out)
    }

    /// Clears any saved `custom_folder` that no longer exists on disk.
    fn validate_anime_folders(&self) -> Result<(), String> {
        let folders: Vec<(i64, String)> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT id, custom_folder FROM anime_entries
                     WHERE custom_folder IS NOT NULL AND custom_folder != ''",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        let stale: Vec<i64> = folders
            .into_iter()
            .filter(|(_, path)| !Path::new(path).is_dir())
            .map(|(id, _)| id)
            .collect();

        if !stale.is_empty() {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            for id in stale {
                let _ = conn.execute(
                    "UPDATE anime_entries SET custom_folder = NULL WHERE id = ?1",
                    params![id],
                );
            }
        }
        Ok(())
    }

    /// Full library scan across all enabled library root folders.
    pub fn scan_all_library_folders(&self) -> Result<ScanSummary, String> {
        self.scan_library_internal(false)
    }

    /// Startup quick scan:
    /// Validates known anime folders and performs a fast metadata diff without re-parsing unchanged files.
    pub fn quick_scan_library_folders(&self) -> Result<ScanSummary, String> {
        self.scan_library_internal(true)
    }

    /// Unified scanner implementation.
    fn scan_library_internal(&self, quick_mode: bool) -> Result<ScanSummary, String> {
        let start = std::time::Instant::now();
        let _ = self.validate_anime_folders();

        let folders: Vec<LibraryFolder> = self
            .list_library_folders()?
            .into_iter()
            .filter(|f| f.enabled)
            .collect();

        if folders.is_empty() {
            return Ok(ScanSummary {
                folders_scanned: 0,
                total_files_indexed: 0,
                newly_parsed: 0,
                removed_files: 0,
                matched_files: 0,
                elapsed_ms: 0,
            });
        }

        // Load existing indexed episodes cache: file_path -> (id, folder_id, mtime, size, matched_anime_id)
        let existing_cache: HashMap<String, (i64, i64, i64, u64, Option<i64>)> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT id, folder_id, file_path, modified_unix, file_size, matched_anime_id
                     FROM local_episodes",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(2)?,
                        (
                            r.get::<_, i64>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, u64>(4)?,
                            r.get::<_, Option<i64>>(5)?,
                        ),
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        let matcher = self.build_matcher_index()?;
        let mut seen_ids: HashSet<i64> = HashSet::with_capacity(existing_cache.len());
        let mut to_parse: Vec<(i64, String, PathBuf, PathBuf, u64, i64, Option<i64>)> = Vec::new();
        let mut discovered_dirs: HashMap<i64, String> = HashMap::new();
        let mut folder_stats: Vec<(i64, u32, u64)> = Vec::with_capacity(folders.len());
        let mut total_files_indexed = 0usize;
        let mut unchanged_matched = 0usize;

        for folder in &folders {
            let root_path = PathBuf::from(&folder.path);
            if !root_path.exists() {
                continue;
            }

            let mut f_count = 0u32;
            let mut f_bytes = 0u64;

            for entry in WalkDir::new(&root_path)
                .follow_links(true)
                .max_depth(6)
                .into_iter()
                .filter_entry(|e| !is_hidden_or_system(e))
                .filter_map(|e| e.ok())
            {
                let path = entry.path();
                if entry.file_type().is_dir() {
                    if path != root_path {
                        if let Some((aid, dir_str)) = match_directory_to_anime(path, &matcher) {
                            discovered_dirs.entry(aid).or_insert(dir_str);
                        }
                    }
                    continue;
                }

                if !entry.file_type().is_file() || !is_video_file(path) {
                    continue;
                }

                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let size = meta.len();
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                f_count += 1;
                f_bytes += size;
                total_files_indexed += 1;

                let full_str = path.to_string_lossy();
                if let Some(&(row_id, old_fid, old_mtime, old_size, prev_aid)) =
                    existing_cache.get(full_str.as_ref())
                {
                    seen_ids.insert(row_id);
                    let valid_prev = prev_aid.filter(|id| matcher.by_id.contains_key(id));
                    if old_fid == folder.id && old_mtime == mtime && old_size == size {
                        if quick_mode || valid_prev.is_some() {
                            if valid_prev.is_some() {
                                unchanged_matched += 1;
                            }
                            continue;
                        }
                    }
                    to_parse.push((
                        folder.id,
                        folder.drive_root.clone(),
                        root_path.clone(),
                        path.to_path_buf(),
                        size,
                        mtime,
                        valid_prev,
                    ));
                } else {
                    to_parse.push((
                        folder.id,
                        folder.drive_root.clone(),
                        root_path.clone(),
                        path.to_path_buf(),
                        size,
                        mtime,
                        None,
                    ));
                }
            }

            folder_stats.push((folder.id, f_count, f_bytes));
        }

        let enabled_folder_ids: HashSet<i64> = folders.iter().map(|f| f.id).collect();
        let stale_ids: Vec<i64> = existing_cache
            .values()
            .filter(|&&(row_id, fid, _, _, _)| {
                enabled_folder_ids.contains(&fid) && !seen_ids.contains(&row_id)
            })
            .map(|&(row_id, _, _, _, _)| row_id)
            .collect();

        // Fast path: 0 changes on disk
        if to_parse.is_empty() && stale_ids.is_empty() && discovered_dirs.is_empty() {
            return Ok(ScanSummary {
                folders_scanned: folders.len(),
                total_files_indexed,
                newly_parsed: 0,
                removed_files: 0,
                matched_files: unchanged_matched,
                elapsed_ms: start.elapsed().as_millis(),
            });
        }

        let parsed_rows: Vec<ParsedEpisodeRow> = to_parse
            .par_iter()
            .map(|(fid, droot, rpath, fpath, size, mtime, prev_aid)| {
                parse_and_match_video_file(
                    *fid, droot, rpath, fpath, *size, *mtime, *prev_aid, &matcher,
                )
            })
            .collect();

        for row in &parsed_rows {
            if let Some((aid, ref folder_str)) = row.inferred_folder {
                discovered_dirs
                    .entry(aid)
                    .or_insert_with(|| folder_str.clone());
            }
        }

        let newly_matched = parsed_rows
            .iter()
            .filter(|r| r.matched_anime_id.is_some())
            .count();
        let now = chrono::Utc::now().timestamp();

        {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            if !stale_ids.is_empty() {
                let mut del_stmt = tx
                    .prepare("DELETE FROM local_episodes WHERE id = ?1")
                    .map_err(|e| e.to_string())?;
                for id in &stale_ids {
                    del_stmt.execute(params![id]).map_err(|e| e.to_string())?;
                }
            }

            upsert_episode_rows(&tx, &parsed_rows)?;

            // Auto-bind per-anime folders when empty
            if !discovered_dirs.is_empty() {
                let mut folder_stmt = tx
                    .prepare(
                        "UPDATE anime_entries SET custom_folder = ?1
                         WHERE id = ?2 AND (custom_folder IS NULL OR custom_folder = '')",
                    )
                    .map_err(|e| e.to_string())?;
                for (aid, dir_path) in &discovered_dirs {
                    let _ = folder_stmt.execute(params![dir_path, aid]);
                }
            }

            {
                let mut stat_stmt = tx
                    .prepare(
                        "UPDATE library_folders
                         SET file_count = ?1, total_bytes = ?2, last_scanned_at = ?3
                         WHERE id = ?4",
                    )
                    .map_err(|e| e.to_string())?;
                for (fid, fcount, fbytes) in &folder_stats {
                    stat_stmt
                        .execute(params![fcount, fbytes, now, fid])
                        .map_err(|e| e.to_string())?;
                }
            }

            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(ScanSummary {
            folders_scanned: folders.len(),
            total_files_indexed,
            newly_parsed: parsed_rows.len(),
            removed_files: stale_ids.len(),
            matched_files: unchanged_matched + newly_matched,
            elapsed_ms: start.elapsed().as_millis(),
        })
    }

    /// Processes individual kernel file/directory change events without rescanning library folders.
    pub fn handle_directory_change_events(
        &self,
        events: &[DirectoryChangeEvent],
    ) -> Result<Option<ScanSummary>, String> {
        if events.is_empty() {
            return Ok(None);
        }
        let start = std::time::Instant::now();
        let matcher = self.build_matcher_index()?;

        let mut removed_paths: Vec<String> = Vec::new();
        let mut added_rows: Vec<ParsedEpisodeRow> = Vec::new();
        let mut folder_renames: Vec<(String, Option<String>)> = Vec::new();
        let mut auto_folders: HashMap<i64, String> = HashMap::new();
        let mut touched_folder_ids: HashSet<i64> = HashSet::new();

        for ev in events {
            touched_folder_ids.insert(ev.folder_id);
            match &ev.action {
                DirectoryChangeAction::Removed(path) => {
                    let p_str = path.to_string_lossy().to_string();
                    removed_paths.push(p_str.clone());
                    folder_renames.push((p_str, None));
                }
                DirectoryChangeAction::Renamed { old_path, new_path } => {
                    let old_str = old_path.to_string_lossy().to_string();
                    removed_paths.push(old_str.clone());
                    if new_path.is_dir() {
                        let new_str = new_path.to_string_lossy().to_string();
                        folder_renames.push((old_str, Some(new_str)));
                        if let Some((aid, dir_str)) = match_directory_to_anime(new_path, &matcher) {
                            auto_folders.entry(aid).or_insert(dir_str);
                        }
                        self.collect_files_in_path(
                            ev.folder_id,
                            &ev.drive_root,
                            &ev.root_path,
                            new_path,
                            &matcher,
                            &mut added_rows,
                            &mut auto_folders,
                        );
                    } else if new_path.is_file() && is_video_file(new_path) {
                        self.collect_single_file(
                            ev.folder_id,
                            &ev.drive_root,
                            &ev.root_path,
                            new_path,
                            &matcher,
                            &mut added_rows,
                            &mut auto_folders,
                        );
                    }
                }
                DirectoryChangeAction::Added(path) => {
                    if path.is_dir() {
                        if let Some((aid, dir_str)) = match_directory_to_anime(path, &matcher) {
                            auto_folders.entry(aid).or_insert(dir_str);
                        }
                        self.collect_files_in_path(
                            ev.folder_id,
                            &ev.drive_root,
                            &ev.root_path,
                            path,
                            &matcher,
                            &mut added_rows,
                            &mut auto_folders,
                        );
                    } else if path.is_file() && is_video_file(path) {
                        self.collect_single_file(
                            ev.folder_id,
                            &ev.drive_root,
                            &ev.root_path,
                            path,
                            &matcher,
                            &mut added_rows,
                            &mut auto_folders,
                        );
                    }
                }
            }
        }

        if removed_paths.is_empty() && added_rows.is_empty() && auto_folders.is_empty() {
            return Ok(None);
        }

        let mut removed_count = 0usize;
        let now = chrono::Utc::now().timestamp();

        {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            for old_path in &removed_paths {
                let prefix = format!("{}\\%", old_path.trim_end_matches(['\\', '/']));
                let n = tx
                    .execute(
                        "DELETE FROM local_episodes WHERE file_path = ?1 OR file_path LIKE ?2",
                        params![old_path, prefix],
                    )
                    .map_err(|e| e.to_string())?;
                removed_count += n;
            }

            for (old_folder, new_folder) in &folder_renames {
                let _ = tx.execute(
                    "UPDATE anime_entries SET custom_folder = ?1 WHERE custom_folder = ?2",
                    params![new_folder, old_folder],
                );
            }

            upsert_episode_rows(&tx, &added_rows)?;

            for (aid, dir_path) in &auto_folders {
                let _ = tx.execute(
                    "UPDATE anime_entries SET custom_folder = ?1
                     WHERE id = ?2 AND (custom_folder IS NULL OR custom_folder = '')",
                    params![dir_path, aid],
                );
            }

            for fid in &touched_folder_ids {
                let _ = tx.execute(
                    "UPDATE library_folders
                     SET file_count = (SELECT COUNT(*) FROM local_episodes WHERE folder_id = ?1),
                         total_bytes = (SELECT COALESCE(SUM(file_size), 0) FROM local_episodes WHERE folder_id = ?1),
                         last_scanned_at = ?2
                     WHERE id = ?1",
                    params![fid, now],
                );
            }

            tx.commit().map_err(|e| e.to_string())?;
        }

        if removed_count == 0 && added_rows.is_empty() && auto_folders.is_empty() {
            return Ok(None);
        }

        let matched_files = added_rows
            .iter()
            .filter(|r| r.matched_anime_id.is_some())
            .count();

        Ok(Some(ScanSummary {
            folders_scanned: touched_folder_ids.len(),
            total_files_indexed: added_rows.len(),
            newly_parsed: added_rows.len(),
            removed_files: removed_count,
            matched_files,
            elapsed_ms: start.elapsed().as_millis(),
        }))
    }

    fn collect_single_file(
        &self,
        folder_id: i64,
        drive_root: &str,
        root_path: &Path,
        file_path: &Path,
        matcher: &AnimeMatcherIndex,
        out_rows: &mut Vec<ParsedEpisodeRow>,
        auto_folders: &mut HashMap<i64, String>,
    ) {
        let Ok(meta) = std::fs::metadata(file_path) else {
            return;
        };
        let size = meta.len();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let row = parse_and_match_video_file(
            folder_id, drive_root, root_path, file_path, size, mtime, None, matcher,
        );
        if let Some((aid, ref fpath)) = row.inferred_folder {
            auto_folders.entry(aid).or_insert_with(|| fpath.clone());
        }
        out_rows.push(row);
    }

    fn collect_files_in_path(
        &self,
        folder_id: i64,
        drive_root: &str,
        root_path: &Path,
        dir_path: &Path,
        matcher: &AnimeMatcherIndex,
        out_rows: &mut Vec<ParsedEpisodeRow>,
        auto_folders: &mut HashMap<i64, String>,
    ) {
        for entry in WalkDir::new(dir_path)
            .follow_links(true)
            .max_depth(4)
            .into_iter()
            .filter_entry(|e| !is_hidden_or_system(e))
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
        {
            self.collect_single_file(
                folder_id,
                drive_root,
                root_path,
                entry.path(),
                matcher,
                out_rows,
                auto_folders,
            );
        }
    }

    /// Re-run title matching across indexed local episodes using the O(1) in-memory `AnimeMatcherIndex`.
    pub fn rematch_all_local_episodes(&self) -> Result<usize, String> {
        self.rematch_episodes_internal(None)
    }

    /// Targeted matching for a single newly added anime entry against only unmatched local episodes.
    pub fn match_unmatched_episodes_for_anime(&self, anime_id: i64) -> Result<usize, String> {
        self.rematch_episodes_internal(Some(anime_id))
    }

    fn rematch_episodes_internal(
        &self,
        target_unmatched_anime_id: Option<i64>,
    ) -> Result<usize, String> {
        let matcher = self.build_matcher_index()?;
        let episodes: Vec<(
            i64,
            String,
            String,
            String,
            Option<u32>,
            Option<u32>,
            Option<i64>,
            i32,
        )> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let sql = if target_unmatched_anime_id.is_some() {
                "SELECT id, parsed_title, normalized_title, file_path, episode_number, anime_season, matched_anime_id, watched
                 FROM local_episodes WHERE matched_anime_id IS NULL"
            } else {
                "SELECT id, parsed_title, normalized_title, file_path, episode_number, anime_season, matched_anime_id, watched
                 FROM local_episodes"
            };
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        let mut updates = Vec::new();
        let mut matched_count = 0usize;

        for (
            ep_id,
            parsed_title,
            norm_title,
            file_path,
            ep_num,
            season_num,
            old_aid,
            old_watched,
        ) in &episodes
        {
            let mut ep_elements = AnitomyElements {
                anime_title: parsed_title.clone(),
                normalized_title: normalize_anime_title(parsed_title),
                episode_number: *ep_num,
                anime_season: *season_num,
                ..Default::default()
            };
            if ep_elements.normalized_title.is_empty() {
                ep_elements.normalized_title = norm_title.clone();
            }

            let resolved = matcher
                .match_episode(&mut ep_elements, Some(file_path))
                .map(|(aid, _t, _c, prog, _eps)| (aid, prog))
                .or_else(|| {
                    old_aid.and_then(|aid| {
                        matcher
                            .by_id
                            .get(&aid)
                            .map(|(_t, _c, prog, _eps)| (aid, *prog))
                    })
                });

            if let Some(target_aid) = target_unmatched_anime_id {
                if resolved.map(|(aid, _)| aid) != Some(target_aid) {
                    continue;
                }
            }

            let (new_aid, new_watched) = match resolved {
                Some((aid, prog)) => {
                    matched_count += 1;
                    let w = ep_elements
                        .episode_number
                        .map(|n| n <= prog)
                        .unwrap_or(false) as i32;
                    (Some(aid), w)
                }
                None => (None, 0),
            };

            if *old_aid != new_aid
                || *old_watched != new_watched
                || ep_elements.episode_number != *ep_num
                || ep_elements.anime_season != *season_num
                || &ep_elements.normalized_title != norm_title
            {
                updates.push((
                    *ep_id,
                    new_aid,
                    new_watched,
                    ep_elements.episode_number,
                    ep_elements.anime_season,
                    ep_elements.anime_title,
                    ep_elements.normalized_title,
                ));
            }
        }

        if !updates.is_empty() {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            {
                let mut stmt = tx
                    .prepare(
                        "UPDATE local_episodes
                         SET matched_anime_id = ?1, watched = ?2, episode_number = ?3,
                             anime_season = ?4, parsed_title = ?5, normalized_title = ?6
                         WHERE id = ?7",
                    )
                    .map_err(|e| e.to_string())?;
                for u in &updates {
                    stmt.execute(params![u.1, u.2, u.3, u.4, u.5, u.6, u.0])
                        .map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(if target_unmatched_anime_id.is_some() {
            updates.len()
        } else {
            matched_count
        })
    }

    pub fn list_local_episodes(
        &self,
        anime_id_filter: Option<i64>,
    ) -> Result<Vec<LocalEpisodeFile>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let sql = if anime_id_filter.is_some() {
            "SELECT
                le.id, le.folder_id, le.file_path, le.file_name, le.drive_root, le.file_size,
                le.modified_unix, le.parsed_title, le.normalized_title, le.episode_number,
                le.anime_season, le.release_group, le.resolution, le.video_terms_json,
                le.audio_terms_json, le.checksum, le.matched_anime_id, ae.title_romaji, le.watched
             FROM local_episodes le
             LEFT JOIN anime_entries ae ON le.matched_anime_id = ae.id
             WHERE le.matched_anime_id = ?1
             ORDER BY le.episode_number ASC, le.file_name ASC"
        } else {
            "SELECT
                le.id, le.folder_id, le.file_path, le.file_name, le.drive_root, le.file_size,
                le.modified_unix, le.parsed_title, le.normalized_title, le.episode_number,
                le.anime_season, le.release_group, le.resolution, le.video_terms_json,
                le.audio_terms_json, le.checksum, le.matched_anime_id, ae.title_romaji, le.watched
             FROM local_episodes le
             LEFT JOIN anime_entries ae ON le.matched_anime_id = ae.id
             ORDER BY le.parsed_title ASC, le.episode_number ASC"
        };

        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let map_row = |r: &rusqlite::Row| -> rusqlite::Result<LocalEpisodeFile> {
            let v_str: String = r.get(13)?;
            let a_str: String = r.get(14)?;
            Ok(LocalEpisodeFile {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                file_path: r.get(2)?,
                file_name: r.get(3)?,
                drive_root: r.get(4)?,
                file_size: r.get(5)?,
                modified_unix: r.get(6)?,
                parsed_title: r.get(7)?,
                normalized_title: r.get(8)?,
                episode_number: r.get(9)?,
                anime_season: r.get(10)?,
                release_group: r.get(11)?,
                resolution: r.get(12)?,
                video_terms: serde_json::from_str(&v_str).unwrap_or_default(),
                audio_terms: serde_json::from_str(&a_str).unwrap_or_default(),
                checksum: r.get(15)?,
                matched_anime_id: r.get(16)?,
                matched_anime_title: r.get(17)?,
                watched: r.get::<_, i32>(18)? != 0,
            })
        };

        let items: Vec<LocalEpisodeFile> = if let Some(aid) = anime_id_filter {
            stmt.query_map(params![aid], map_row)
                .map_err(|e| e.to_string())?
                .flatten()
                .collect()
        } else {
            stmt.query_map([], map_row)
                .map_err(|e| e.to_string())?
                .flatten()
                .collect()
        };

        Ok(items)
    }

    pub fn bind_title_alias(&self, normalized_alias: &str, anime_id: i64) -> Result<usize, String> {
        let trimmed = normalized_alias.trim();
        let norm = normalize_anime_title(trimmed);
        if norm.is_empty() {
            return Err("Normalized alias cannot be empty".into());
        }
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR REPLACE INTO title_aliases (normalized_alias, anime_id) VALUES (?1, ?2)",
                params![norm, anime_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE local_episodes SET matched_anime_id = ?1 WHERE normalized_title = ?2 OR parsed_title = ?3",
                params![anime_id, norm, trimmed],
            )
            .map_err(|e| e.to_string())?;
        }
        let _ = self.link_alias_to_anime(anime_id, trimmed);
        self.rematch_all_local_episodes()
    }
}

////////////////////////////////////////////////////////////////////////////////
// Native Win32 IOCP + ReadDirectoryChangesW Directory Monitor
////////////////////////////////////////////////////////////////////////////////

#[cfg(windows)]
mod win32_monitor {
    use super::*;
    use std::ffi::c_void;

    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_SHARE_ALL: u32 = 0x0001 | 0x0002 | 0x0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const FILE_NOTIFY_CHANGE_FILE_NAME: u32 = 0x0000_0001;
    const FILE_NOTIFY_CHANGE_DIR_NAME: u32 = 0x0000_0002;
    const FILE_ACTION_ADDED: u32 = 0x0000_0001;
    const FILE_ACTION_REMOVED: u32 = 0x0000_0002;
    const FILE_ACTION_RENAMED_OLD_NAME: u32 = 0x0000_0004;
    const FILE_ACTION_RENAMED_NEW_NAME: u32 = 0x0000_0005;
    const INVALID_HANDLE_VALUE: isize = -1;
    const INFINITE: u32 = 0xFFFF_FFFF;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        h_event: isize,
    }

    #[repr(C)]
    struct FileNotifyInformation {
        next_entry_offset: u32,
        action: u32,
        file_name_length: u32,
        file_name: [u16; 1],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            lpFileName: *const u16,
            dwDesiredAccess: u32,
            dwShareMode: u32,
            lpSecurityAttributes: *const c_void,
            dwCreationDisposition: u32,
            dwFlagsAndAttributes: u32,
            hTemplateFile: isize,
        ) -> isize;

        fn CloseHandle(hObject: isize) -> i32;

        fn CreateIoCompletionPort(
            FileHandle: isize,
            ExistingCompletionPort: isize,
            CompletionKey: usize,
            NumberOfConcurrentThreads: u32,
        ) -> isize;

        fn GetQueuedCompletionStatus(
            CompletionPort: isize,
            lpNumberOfBytesTransferred: *mut u32,
            lpCompletionKey: *mut usize,
            lpOverlapped: *mut *mut Overlapped,
            dwMilliseconds: u32,
        ) -> i32;

        fn PostQueuedCompletionStatus(
            CompletionPort: isize,
            dwNumberOfBytesTransferred: u32,
            dwCompletionKey: usize,
            lpOverlapped: *mut Overlapped,
        ) -> i32;

        fn ReadDirectoryChangesW(
            hDirectory: isize,
            lpBuffer: *mut c_void,
            nBufferLength: u32,
            bWatchSubtree: i32,
            dwNotifyFilter: u32,
            lpBytesReturned: *mut u32,
            lpOverlapped: *mut Overlapped,
            lpCompletionRoutine: *const c_void,
        ) -> i32;
    }

    struct WatchedFolderEntry {
        folder_id: i64,
        root_path: PathBuf,
        drive_root: String,
        handle: isize,
        buffer: Vec<u32>, // 65536 bytes (16384 * 4), 4-byte aligned for FILE_NOTIFY_INFORMATION
        bytes_returned: u32,
        overlapped: Box<Overlapped>,
    }

    impl WatchedFolderEntry {
        fn open(folder: &LibraryFolder, completion_port: isize, key: usize) -> Option<Self> {
            let root_path = PathBuf::from(&folder.path);
            if !root_path.is_dir() {
                return None;
            }
            let mut wide: Vec<u16> = folder.path.encode_utf16().collect();
            wide.push(0);

            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    FILE_LIST_DIRECTORY,
                    FILE_SHARE_ALL,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                    0,
                )
            };
            if handle == INVALID_HANDLE_VALUE || handle == 0 {
                return None;
            }

            let port = unsafe { CreateIoCompletionPort(handle, completion_port, key, 0) };
            if port == 0 {
                unsafe {
                    CloseHandle(handle);
                }
                return None;
            }

            let mut entry = Self {
                folder_id: folder.id,
                root_path,
                drive_root: folder.drive_root.clone(),
                handle,
                buffer: vec![0u32; 16384],
                bytes_returned: 0,
                overlapped: Box::new(Overlapped {
                    internal: 0,
                    internal_high: 0,
                    offset: 0,
                    offset_high: 0,
                    h_event: 0,
                }),
            };
            if !entry.arm_read() {
                return None;
            }
            Some(entry)
        }

        fn arm_read(&mut self) -> bool {
            unsafe {
                ReadDirectoryChangesW(
                    self.handle,
                    self.buffer.as_mut_ptr() as *mut c_void,
                    (self.buffer.len() * 4) as u32,
                    1, // watch subtree
                    FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME,
                    &mut self.bytes_returned,
                    &mut *self.overlapped,
                    std::ptr::null(),
                ) != 0
            }
        }

        fn parse_notifications(&self) -> Vec<DirectoryChangeEvent> {
            let mut out = Vec::new();
            let mut offset = 0usize;
            let buf_bytes = self.buffer.as_ptr() as *const u8;
            let max_bytes = self.buffer.len() * 4;
            let mut pending_old_name: Option<PathBuf> = None;

            loop {
                if offset + std::mem::size_of::<FileNotifyInformation>() > max_bytes {
                    break;
                }
                let info = unsafe { &*(buf_bytes.add(offset) as *const FileNotifyInformation) };
                let char_len = (info.file_name_length as usize) / 2;
                let name_ptr = info.file_name.as_ptr();
                let slice = unsafe { std::slice::from_raw_parts(name_ptr, char_len) };
                let rel_name = String::from_utf16_lossy(slice);
                let full_path = self.root_path.join(&rel_name);

                match info.action {
                    FILE_ACTION_RENAMED_OLD_NAME => {
                        pending_old_name = Some(full_path);
                    }
                    FILE_ACTION_RENAMED_NEW_NAME => {
                        let action = if let Some(old_path) = pending_old_name.take() {
                            DirectoryChangeAction::Renamed {
                                old_path,
                                new_path: full_path,
                            }
                        } else {
                            DirectoryChangeAction::Added(full_path)
                        };
                        out.push(DirectoryChangeEvent {
                            folder_id: self.folder_id,
                            root_path: self.root_path.clone(),
                            drive_root: self.drive_root.clone(),
                            action,
                        });
                    }
                    FILE_ACTION_ADDED => {
                        out.push(DirectoryChangeEvent {
                            folder_id: self.folder_id,
                            root_path: self.root_path.clone(),
                            drive_root: self.drive_root.clone(),
                            action: DirectoryChangeAction::Added(full_path),
                        });
                    }
                    FILE_ACTION_REMOVED => {
                        out.push(DirectoryChangeEvent {
                            folder_id: self.folder_id,
                            root_path: self.root_path.clone(),
                            drive_root: self.drive_root.clone(),
                            action: DirectoryChangeAction::Removed(full_path),
                        });
                    }
                    _ => {}
                }

                if info.next_entry_offset == 0 {
                    break;
                }
                offset += info.next_entry_offset as usize;
            }

            if let Some(old_path) = pending_old_name {
                out.push(DirectoryChangeEvent {
                    folder_id: self.folder_id,
                    root_path: self.root_path.clone(),
                    drive_root: self.drive_root.clone(),
                    action: DirectoryChangeAction::Removed(old_path),
                });
            }

            out
        }
    }

    impl Drop for WatchedFolderEntry {
        fn drop(&mut self) {
            if self.handle != INVALID_HANDLE_VALUE && self.handle != 0 {
                unsafe {
                    CloseHandle(self.handle);
                }
                self.handle = INVALID_HANDLE_VALUE;
            }
        }
    }

    pub fn run_iocp_monitor_loop(
        db: Arc<Database>,
        event_tx: Sender<Vec<DirectoryChangeEvent>>,
        port_slot: Arc<Mutex<isize>>,
    ) {
        let completion_port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, 0, 0, 1) };
        if completion_port == 0 {
            return;
        }
        if let Ok(mut guard) = port_slot.lock() {
            *guard = completion_port;
        }

        let load_entries = |db: &Database, port: isize| -> Vec<Option<WatchedFolderEntry>> {
            let folders = db.list_library_folders().unwrap_or_default();
            let mut entries = Vec::with_capacity(folders.len());
            for (idx, f) in folders.into_iter().filter(|f| f.enabled).enumerate() {
                entries.push(WatchedFolderEntry::open(&f, port, idx + 1));
            }
            entries
        };

        let mut entries = load_entries(&db, completion_port);

        loop {
            let mut bytes_transferred: u32 = 0;
            let mut completion_key: usize = 0;
            let mut overlapped_ptr: *mut Overlapped = std::ptr::null_mut();

            // Blocks inside the Windows kernel with 0.00% CPU until a file/folder is added, removed, or renamed
            let ok = unsafe {
                GetQueuedCompletionStatus(
                    completion_port,
                    &mut bytes_transferred,
                    &mut completion_key,
                    &mut overlapped_ptr,
                    INFINITE,
                )
            };

            // Key 0 is our explicit reload signal when folders are added/removed
            if completion_key == 0 {
                entries.clear();
                entries = load_entries(&db, completion_port);
                continue;
            }

            if ok == 0 || bytes_transferred == 0 {
                continue;
            }

            if let Some(Some(entry)) = entries.get_mut(completion_key - 1) {
                let notifications = entry.parse_notifications();
                let _ = entry.arm_read();
                if !notifications.is_empty() {
                    let _ = event_tx.send(notifications);
                }
            }
        }
    }

    pub fn signal_reload(port_slot: &Arc<Mutex<isize>>) {
        if let Ok(guard) = port_slot.lock() {
            if *guard != 0 {
                unsafe {
                    PostQueuedCompletionStatus(*guard, 0, 0, std::ptr::null_mut());
                }
            }
        }
    }
}

/// Handle to the `DirectoryMonitor` allowing instant reload when library folders change.
#[derive(Clone, Default)]
pub struct LibraryMonitorHandle {
    #[cfg(windows)]
    port_slot: Arc<Mutex<isize>>,
}

impl LibraryMonitorHandle {
    pub fn start<F>(db: Arc<Database>, on_change: F) -> Self
    where
        F: Fn(ScanSummary) + Send + Sync + 'static,
    {
        #[cfg(windows)]
        {
            let port_slot = Arc::new(Mutex::new(0isize));
            let port_clone = port_slot.clone();
            let (tx, rx) = mpsc::channel::<Vec<DirectoryChangeEvent>>();

            let db_iocp = db.clone();
            let _ = std::thread::Builder::new()
                .name("tora-iocp-dir-monitor".into())
                .spawn(move || {
                    win32_monitor::run_iocp_monitor_loop(db_iocp, tx, port_clone);
                });

            let _ = std::thread::Builder::new()
                .name("tora-dir-event-worker".into())
                .spawn(move || {
                    while let Ok(first_batch) = rx.recv() {
                        let mut batch = first_batch;
                        // Coalesce burst notifications (e.g. torrent client moving/renaming files)
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        while let Ok(more) = rx.try_recv() {
                            batch.extend(more);
                        }
                        if let Ok(Some(summary)) = db.handle_directory_change_events(&batch) {
                            on_change(summary);
                        }
                    }
                });

            Self { port_slot }
        }
        #[cfg(not(windows))]
        {
            let _ = (db, on_change);
            Self {}
        }
    }

    /// Reloads watched directory handles when folders are added or removed.
    pub fn reload(&self) {
        #[cfg(windows)]
        win32_monitor::signal_reload(&self.port_slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scanner_and_directory_events() {
        let tmp_dir = std::env::temp_dir().join("tora_test_scanner");
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let media_dir = tmp_dir.join("media");
        let frieren_dir = media_dir.join("Sousou no Frieren");
        std::fs::create_dir_all(&frieren_dir).expect("create frieren dir");

        let db_path = tmp_dir.join("test.db");
        let db = Database::open(&db_path).expect("open test db");
        db.upsert_anime_entries_batch(&crate::db::test_fixture_entries())
            .expect("load fixtures");
        let folder_str = media_dir.to_string_lossy().to_string();
        let lib_folder = db
            .add_library_folder(&folder_str, Some("Test Media".to_string()))
            .expect("add library folder");

        // Create two initial video files (one inside a dedicated anime subfolder)
        let ep1 = frieren_dir.join("[SubsPlease] Sousou no Frieren - 01 (1080p).mkv");
        let ep2 = media_dir.join("[Judas] Kusuriya - S03E03.mkv");
        std::fs::write(&ep1, b"dummy video content 1").expect("write ep1");
        std::fs::write(&ep2, b"dummy video content 22").expect("write ep2");

        // 1. Initial quick scan parses and matches both new files + auto-binds Sousou no Frieren's custom_folder
        let s1 = db.quick_scan_library_folders().expect("quick scan 1");
        assert_eq!(s1.total_files_indexed, 2);
        assert_eq!(s1.newly_parsed, 2);
        assert_eq!(s1.removed_files, 0);
        assert_eq!(s1.matched_files, 2);

        let frieren_entry = db.get_anime_entry_by_id(154587).expect("frieren entry");
        assert_eq!(
            frieren_entry.custom_folder.as_deref(),
            Some(frieren_dir.to_string_lossy().as_ref())
        );

        // 2. Second quick scan with no changes hits the 0-parse fast path
        let s2 = db.quick_scan_library_folders().expect("quick scan 2");
        assert_eq!(s2.total_files_indexed, 2);
        assert_eq!(s2.newly_parsed, 0);
        assert_eq!(s2.removed_files, 0);
        assert_eq!(s2.matched_files, 2);

        // 3. Single-file notification indexes only the new episode without rescanning
        let ep3 = media_dir.join("[SubsPlease] Dandadan - 05 (1080p).mkv");
        std::fs::write(&ep3, b"dummy video content 333").expect("write ep3");

        let ev_add = DirectoryChangeEvent {
            folder_id: lib_folder.id,
            root_path: media_dir.clone(),
            drive_root: lib_folder.drive_root.clone(),
            action: DirectoryChangeAction::Added(ep3.clone()),
        };
        let s3 = db
            .handle_directory_change_events(&[ev_add])
            .expect("handle add event")
            .expect("should report change");
        assert_eq!(s3.newly_parsed, 1);
        assert_eq!(s3.matched_files, 1);

        // 4. Single-file removal notification removes only that file
        std::fs::remove_file(&ep1).expect("remove ep1");
        let ev_rem = DirectoryChangeEvent {
            folder_id: lib_folder.id,
            root_path: media_dir.clone(),
            drive_root: lib_folder.drive_root.clone(),
            action: DirectoryChangeAction::Removed(ep1.clone()),
        };
        let s4 = db
            .handle_directory_change_events(&[ev_rem])
            .expect("handle remove event")
            .expect("should report removal");
        assert_eq!(s4.removed_files, 1);
        assert_eq!(db.list_local_episodes(None).unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
