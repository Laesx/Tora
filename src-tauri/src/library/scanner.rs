use crate::db::{Database, LibraryFolder, LocalEpisodeFile};
use crate::detection::anitomy::{normalize_anime_title, parse_filename, AnitomyElements};
use rayon::prelude::*;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

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

fn is_video_file(path: &Path) -> bool {
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

    pub fn add_library_folder(&self, path: &str, label: Option<String>) -> Result<LibraryFolder, String> {
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
        let folder_label = label
            .filter(|l| !l.trim().is_empty())
            .unwrap_or_else(|| {
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

    /// High-speed parallel multi-drive video library scanner with incremental mtime/size check.
    pub fn scan_all_library_folders(&self) -> Result<ScanSummary, String> {
        let start = std::time::Instant::now();
        let folders: Vec<LibraryFolder> = self
            .list_library_folders()?
            .into_iter()
            .filter(|f| f.enabled)
            .collect();

        let matcher = self.build_matcher_index()?;

        // Load existing file cache (file_path -> (modified_unix, file_size, matched_anime_id))
        let existing_cache: HashMap<String, (i64, u64, Option<i64>)> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT file_path, modified_unix, file_size, matched_anime_id FROM local_episodes")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        (
                            r.get::<_, i64>(1)?,
                            r.get::<_, u64>(2)?,
                            r.get::<_, Option<i64>>(3)?,
                        ),
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        let mut total_files_indexed = 0usize;
        let mut newly_parsed = 0usize;
        let mut removed_files = 0usize;
        let now = chrono::Utc::now().timestamp();

        for folder in &folders {
            let root_path = PathBuf::from(&folder.path);
            if !root_path.exists() {
                continue;
            }

            // Collect all video files in folder tree
            let discovered: Vec<(PathBuf, u64, i64)> = WalkDir::new(&root_path)
                .follow_links(true)
                .max_depth(8)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
                .filter_map(|entry| {
                    let meta = entry.metadata().ok()?;
                    let size = meta.len();
                    let mtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    Some((entry.into_path(), size, mtime))
                })
                .collect();

            // Parse and match files in parallel using Rayon
            let root_clone = root_path.clone();
            let parsed_batch: Vec<(
                String,
                String,
                u64,
                i64,
                String,
                String,
                Option<u32>,
                Option<u32>,
                Option<String>,
                Option<String>,
                String,
                String,
                Option<String>,
                Option<i64>,
                i32,
                bool,
            )> = discovered
                .par_iter()
                .map(|(path, size, mtime)| {
                    let full_str = path.to_string_lossy().to_string();
                    let file_name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();

                    let cached_entry = existing_cache.get(&full_str);
                    let is_cached = cached_entry
                        .map(|(old_m, old_s, _)| *old_m == *mtime && *old_s == *size)
                        .unwrap_or(false);
                    let prev_matched_id = cached_entry
                        .and_then(|(_, _, prev_id)| *prev_id)
                        .filter(|id| matcher.by_id.contains_key(id));

                    // Pass path relative to the library folder root so parent folder names above the root never pollute season/title
                    let rel_str = path
                        .strip_prefix(&root_clone)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string();
                    let parse_input = if rel_str.is_empty() {
                        &file_name
                    } else {
                        &rel_str
                    };

                    let mut elements = parse_filename(parse_input);

                    // Fallback to parent directory name if filename only has episode number (e.g., "D:\Anime\Sousou no Frieren\01.mkv")
                    let norm_is_weak = elements.normalized_title.is_empty()
                        || elements.normalized_title.chars().all(|c| c.is_ascii_digit())
                        || matches!(
                            elements.normalized_title.as_str(),
                            "episode" | "ep" | "ova" | "special"
                        );
                    if norm_is_weak {
                        if let Some(parent) = path.parent() {
                            if parent != root_clone {
                                if let Some(parent_name) = parent.file_name().and_then(|n| n.to_str()) {
                                    let parent_parsed = parse_filename(parent_name);
                                    if !parent_parsed.anime_title.is_empty() {
                                        elements.anime_title = parent_parsed.anime_title;
                                        elements.normalized_title =
                                            normalize_anime_title(&elements.anime_title);
                                        if elements.anime_season.is_none() {
                                            elements.anime_season = parent_parsed.anime_season;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Match immediately in memory so rows are inserted already bound
                    let resolved = matcher
                        .match_episode(&mut elements, Some(&full_str))
                        .map(|(aid, _t, _c, prog, _eps)| (aid, prog))
                        .or_else(|| {
                            prev_matched_id.and_then(|aid| {
                                matcher.by_id.get(&aid).map(|(_t, _c, prog, _eps)| (aid, *prog))
                            })
                        });

                    let (matched_id, watched) = match resolved {
                        Some((anime_id, user_progress)) => {
                            let w = elements
                                .episode_number
                                .map(|n| n <= user_progress)
                                .unwrap_or(false) as i32;
                            (Some(anime_id), w)
                        }
                        None => (None, 0),
                    };

                    let v_json =
                        serde_json::to_string(&elements.video_term).unwrap_or_else(|_| "[]".into());
                    let a_json =
                        serde_json::to_string(&elements.audio_term).unwrap_or_else(|_| "[]".into());

                    (
                        full_str,
                        file_name,
                        *size,
                        *mtime,
                        elements.anime_title,
                        elements.normalized_title,
                        elements.episode_number,
                        elements.anime_season,
                        elements.release_group,
                        elements.video_resolution,
                        v_json,
                        a_json,
                        elements.file_checksum,
                        matched_id,
                        watched,
                        !is_cached,
                    )
                })
                .collect();

            let folder_bytes: u64 = parsed_batch.iter().map(|i| i.2).sum();
            let folder_count = parsed_batch.len() as u32;
            total_files_indexed += parsed_batch.len();
            newly_parsed += parsed_batch.iter().filter(|i| i.15).count();

            let discovered_paths: std::collections::HashSet<&str> =
                parsed_batch.iter().map(|i| i.0.as_str()).collect();

            // Persist in single fast transaction per folder
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            // Remove only stale entries for this folder that no longer exist on disk
            {
                let mut existing_in_folder: Vec<(i64, String)> = Vec::new();
                {
                    let mut q_stmt = tx
                        .prepare("SELECT id, file_path FROM local_episodes WHERE folder_id = ?1")
                        .map_err(|e| e.to_string())?;
                    let rows = q_stmt
                        .query_map(params![folder.id], |r| Ok((r.get(0)?, r.get(1)?)))
                        .map_err(|e| e.to_string())?;
                    for r in rows.flatten() {
                        existing_in_folder.push(r);
                    }
                }
                let mut del_stmt = tx
                    .prepare("DELETE FROM local_episodes WHERE id = ?1")
                    .map_err(|e| e.to_string())?;
                for (row_id, row_path) in existing_in_folder {
                    if !discovered_paths.contains(row_path.as_str()) {
                        del_stmt.execute(params![row_id]).map_err(|e| e.to_string())?;
                        removed_files += 1;
                    }
                }
            }

            {
                let mut insert_stmt = tx
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

                for item in &parsed_batch {
                    insert_stmt
                        .execute(params![
                            folder.id,
                            item.0,
                            item.1,
                            folder.drive_root,
                            item.2,
                            item.3,
                            item.4,
                            item.5,
                            item.6,
                            item.7,
                            item.8,
                            item.9,
                            item.10,
                            item.11,
                            item.12,
                            item.13,
                            item.14,
                        ])
                        .map_err(|e| e.to_string())?;
                }
            }

            tx.execute(
                "UPDATE library_folders SET file_count = ?1, total_bytes = ?2, last_scanned_at = ?3 WHERE id = ?4",
                params![folder_count, folder_bytes, now, folder.id],
            )
            .map_err(|e| e.to_string())?;

            tx.commit().map_err(|e| e.to_string())?;
        }

        // Now run fast title-to-anime matching across all local_episodes
        let matched_files = self.rematch_all_local_episodes()?;

        Ok(ScanSummary {
            folders_scanned: folders.len(),
            total_files_indexed,
            newly_parsed,
            removed_files,
            matched_files,
            elapsed_ms: start.elapsed().as_millis(),
        })
    }

    /// Ultra-fast incremental startup & delta scanner:
    /// Checks `(file_path, modified_unix, file_size)` against the SQLite index and completely skips
    /// C++ Anitomy parsing and SQLite writes for unchanged files. Only newly added, modified, or
    /// deleted files are parsed and written.
    pub fn quick_scan_library_folders(&self) -> Result<ScanSummary, String> {
        let start = std::time::Instant::now();

        let folders: Vec<(i64, String, String, u32, u64)> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT id, path, drive_root, file_count, total_bytes
                     FROM library_folders WHERE enabled = 1 ORDER BY id ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, u32>(3)?,
                        r.get::<_, u64>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        if folders.is_empty() {
            return Ok(ScanSummary {
                folders_scanned: 0,
                total_files_indexed: 0,
                newly_parsed: 0,
                removed_files: 0,
                matched_files: 0,
                elapsed_ms: start.elapsed().as_millis(),
            });
        }

        // Load existing file cache: file_path -> (id, folder_id, modified_unix, file_size, matched_anime_id)
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

        let mut total_files_indexed = 0usize;
        let mut unchanged_matched = 0usize;
        let mut seen_paths: std::collections::HashSet<String> =
            std::collections::HashSet::with_capacity(existing_cache.len());
        let mut active_folder_ids: std::collections::HashSet<i64> =
            std::collections::HashSet::with_capacity(folders.len());
        let mut folder_stats_updates: Vec<(i64, u32, u64)> = Vec::new();

        // Collect only new or modified files: (folder_id, drive_root, root_path, file_path, size, mtime, prev_matched_id)
        let mut delta_files: Vec<(i64, String, PathBuf, PathBuf, u64, i64, Option<i64>)> =
            Vec::new();

        for (folder_id, folder_path, drive_root, old_count, old_bytes) in &folders {
            let root_path = PathBuf::from(folder_path);
            if !root_path.exists() {
                continue;
            }
            active_folder_ids.insert(*folder_id);

            let mut folder_count = 0u32;
            let mut folder_bytes = 0u64;

            for entry in WalkDir::new(&root_path)
                .follow_links(true)
                .max_depth(8)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
            {
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

                let path = entry.into_path();
                let full_str = path.to_string_lossy().to_string();

                folder_count += 1;
                folder_bytes += size;
                total_files_indexed += 1;

                if let Some(&(_row_id, _fid, old_mtime, old_size, prev_matched)) =
                    existing_cache.get(&full_str)
                {
                    seen_paths.insert(full_str);
                    if old_mtime == mtime && old_size == size {
                        if prev_matched.is_some() {
                            unchanged_matched += 1;
                        }
                        continue;
                    }
                    delta_files.push((
                        *folder_id,
                        drive_root.clone(),
                        root_path.clone(),
                        path,
                        size,
                        mtime,
                        prev_matched,
                    ));
                } else {
                    seen_paths.insert(full_str);
                    delta_files.push((
                        *folder_id,
                        drive_root.clone(),
                        root_path.clone(),
                        path,
                        size,
                        mtime,
                        None,
                    ));
                }
            }

            if folder_count != *old_count || folder_bytes != *old_bytes {
                folder_stats_updates.push((*folder_id, folder_count, folder_bytes));
            }
        }

        // Identify deleted files in active folders
        let mut stale_ids: Vec<i64> = Vec::new();
        for (path_str, &(row_id, fid, _, _, _)) in &existing_cache {
            if active_folder_ids.contains(&fid) && !seen_paths.contains(path_str) {
                stale_ids.push(row_id);
            }
        }

        // Fast path: zero changes on disk -> return in <1ms with zero Anitomy calls and zero SQLite writes
        if delta_files.is_empty() && stale_ids.is_empty() && folder_stats_updates.is_empty() {
            return Ok(ScanSummary {
                folders_scanned: folders.len(),
                total_files_indexed,
                newly_parsed: 0,
                removed_files: 0,
                matched_files: unchanged_matched,
                elapsed_ms: start.elapsed().as_millis(),
            });
        }

        let matcher = self.build_matcher_index()?;
        let now = chrono::Utc::now().timestamp();

        // Parse and match only the delta files in parallel using Rayon
        let parsed_deltas: Vec<(
            i64,
            String,
            String,
            String,
            u64,
            i64,
            String,
            String,
            Option<u32>,
            Option<u32>,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<String>,
            Option<i64>,
            i32,
        )> = delta_files
            .par_iter()
            .map(
                |(folder_id, drive_root, root_path, path, size, mtime, prev_matched)| {
                    let full_str = path.to_string_lossy().to_string();
                    let file_name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();

                    let rel_str = path
                        .strip_prefix(root_path)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string();
                    let parse_input = if rel_str.is_empty() {
                        &file_name
                    } else {
                        &rel_str
                    };

                    let mut elements = parse_filename(parse_input);

                    let norm_is_weak = elements.normalized_title.is_empty()
                        || elements.normalized_title.chars().all(|c| c.is_ascii_digit())
                        || matches!(
                            elements.normalized_title.as_str(),
                            "episode" | "ep" | "ova" | "special"
                        );
                    if norm_is_weak {
                        if let Some(parent) = path.parent() {
                            if parent != root_path {
                                if let Some(parent_name) =
                                    parent.file_name().and_then(|n| n.to_str())
                                {
                                    let parent_parsed = parse_filename(parent_name);
                                    if !parent_parsed.anime_title.is_empty() {
                                        elements.anime_title = parent_parsed.anime_title;
                                        elements.normalized_title =
                                            normalize_anime_title(&elements.anime_title);
                                        if elements.anime_season.is_none() {
                                            elements.anime_season = parent_parsed.anime_season;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let valid_prev = prev_matched.filter(|id| matcher.by_id.contains_key(id));
                    let resolved = matcher
                        .match_episode(&mut elements, Some(&full_str))
                        .map(|(aid, _t, _c, prog, _eps)| (aid, prog))
                        .or_else(|| {
                            valid_prev.and_then(|aid| {
                                matcher
                                    .by_id
                                    .get(&aid)
                                    .map(|(_t, _c, prog, _eps)| (aid, *prog))
                            })
                        });

                    let (matched_id, watched) = match resolved {
                        Some((anime_id, user_progress)) => {
                            let w = elements
                                .episode_number
                                .map(|n| n <= user_progress)
                                .unwrap_or(false) as i32;
                            (Some(anime_id), w)
                        }
                        None => (None, 0),
                    };

                    let v_json = serde_json::to_string(&elements.video_term)
                        .unwrap_or_else(|_| "[]".into());
                    let a_json = serde_json::to_string(&elements.audio_term)
                        .unwrap_or_else(|_| "[]".into());

                    (
                        *folder_id,
                        full_str,
                        file_name,
                        drive_root.clone(),
                        *size,
                        *mtime,
                        elements.anime_title,
                        elements.normalized_title,
                        elements.episode_number,
                        elements.anime_season,
                        elements.release_group,
                        elements.video_resolution,
                        v_json,
                        a_json,
                        elements.file_checksum,
                        matched_id,
                        watched,
                    )
                },
            )
            .collect();

        let newly_matched = parsed_deltas.iter().filter(|i| i.15.is_some()).count();

        {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            if !stale_ids.is_empty() {
                let mut del_stmt = tx
                    .prepare("DELETE FROM local_episodes WHERE id = ?1")
                    .map_err(|e| e.to_string())?;
                for row_id in &stale_ids {
                    del_stmt.execute(params![row_id]).map_err(|e| e.to_string())?;
                }
            }

            if !parsed_deltas.is_empty() {
                let mut upsert_stmt = tx
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

                for item in &parsed_deltas {
                    upsert_stmt
                        .execute(params![
                            item.0, item.1, item.2, item.3, item.4, item.5, item.6, item.7,
                            item.8, item.9, item.10, item.11, item.12, item.13, item.14, item.15,
                            item.16,
                        ])
                        .map_err(|e| e.to_string())?;
                }
            }

            if !folder_stats_updates.is_empty() {
                let mut f_stmt = tx
                    .prepare(
                        "UPDATE library_folders
                         SET file_count = ?1, total_bytes = ?2, last_scanned_at = ?3
                         WHERE id = ?4",
                    )
                    .map_err(|e| e.to_string())?;
                for (fid, fcount, fbytes) in &folder_stats_updates {
                    f_stmt
                        .execute(params![fcount, fbytes, now, fid])
                        .map_err(|e| e.to_string())?;
                }
            }

            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(ScanSummary {
            folders_scanned: folders.len(),
            total_files_indexed,
            newly_parsed: parsed_deltas.len(),
            removed_files: stale_ids.len(),
            matched_files: unchanged_matched + newly_matched,
            elapsed_ms: start.elapsed().as_millis(),
        })
    }

    /// Ultra-lean zero-allocation streaming fingerprint `(file_count, total_bytes, state_hash)`
    /// across all enabled library folders. Used by the background folder watcher to detect new
    /// downloads, renames, or deletions in sub-millisecond time without heap allocations or SQLite writes.
    pub fn compute_library_fingerprint(&self) -> Result<(usize, u64, u64), String> {
        let folder_paths: Vec<String> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT path FROM library_folders WHERE enabled = 1 ORDER BY id ASC")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        const FNV_OFFSET: u64 = 0xcbf29ce484222325;
        const FNV_PRIME: u64 = 0x100000001b3;

        let mut hash: u64 = FNV_OFFSET;
        let mut file_count: usize = 0;
        let mut total_bytes: u64 = 0;

        for folder_path in &folder_paths {
            let root = Path::new(folder_path);
            if !root.exists() {
                continue;
            }
            for entry in WalkDir::new(root)
                .follow_links(true)
                .max_depth(8)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file() && is_video_file(e.path()))
            {
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let size = meta.len();
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                file_count += 1;
                total_bytes = total_bytes.wrapping_add(size);

                for &b in entry.path().as_os_str().as_encoded_bytes() {
                    hash ^= b as u64;
                    hash = hash.wrapping_mul(FNV_PRIME);
                }
                for b in size.to_le_bytes() {
                    hash ^= b as u64;
                    hash = hash.wrapping_mul(FNV_PRIME);
                }
                for b in mtime.to_le_bytes() {
                    hash ^= b as u64;
                    hash = hash.wrapping_mul(FNV_PRIME);
                }
            }
        }

        Ok((file_count, total_bytes, hash))
    }

    /// Re-run title matching across all indexed local episodes against the anime_entries table using the fast O(1) in-memory matcher index.
    pub fn rematch_all_local_episodes(&self) -> Result<usize, String> {
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
            let mut stmt = conn
                .prepare(
                    "SELECT id, parsed_title, normalized_title, file_path, episode_number, anime_season, matched_anime_id, watched
                     FROM local_episodes",
                )
                .map_err(|e| e.to_string())?;
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

        let mut updates: Vec<(
            i64,
            Option<i64>,
            i32,
            Option<u32>,
            Option<u32>,
            String,
            String,
        )> = Vec::new();
        let mut matched_count = 0usize;

        for (
            ep_id,
            parsed_title,
            norm_title,
            file_path,
            ep_num,
            season_num,
            old_matched_id,
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
                    old_matched_id.and_then(|aid| {
                        matcher.by_id.get(&aid).map(|(_t, _c, prog, _eps)| (aid, *prog))
                    })
                });

            let (new_matched_id, new_watched) = match resolved {
                Some((anime_id, user_progress)) => {
                    matched_count += 1;
                    let w = ep_elements
                        .episode_number
                        .map(|n| n <= user_progress)
                        .unwrap_or(false) as i32;
                    (Some(anime_id), w)
                }
                None => (None, 0),
            };

            if *old_matched_id != new_matched_id
                || *old_watched != new_watched
                || ep_elements.episode_number != *ep_num
                || ep_elements.anime_season != *season_num
                || &ep_elements.normalized_title != norm_title
            {
                updates.push((
                    *ep_id,
                    new_matched_id,
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
                         SET matched_anime_id = ?1,
                             watched = ?2,
                             episode_number = ?3,
                             anime_season = ?4,
                             parsed_title = ?5,
                             normalized_title = ?6
                         WHERE id = ?7",
                    )
                    .map_err(|e| e.to_string())?;
                for (ep_id, matched_id, watched, new_ep, new_season, new_title, new_norm) in updates
                {
                    stmt.execute(params![
                        matched_id,
                        watched,
                        new_ep,
                        new_season,
                        new_title,
                        new_norm,
                        ep_id
                    ])
                    .map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        Ok(matched_count)
    }

    /// Fast targeted matching for a single newly added anime entry against only unmatched local episodes.
    pub fn match_unmatched_episodes_for_anime(&self, anime_id: i64) -> Result<usize, String> {
        let matcher = self.build_matcher_index()?;

        // Only query local episodes where matched_anime_id IS NULL
        let unmatched_episodes: Vec<(i64, String, String, String, Option<u32>, Option<u32>)> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT id, parsed_title, normalized_title, file_path, episode_number, anime_season
                     FROM local_episodes
                     WHERE matched_anime_id IS NULL",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        if unmatched_episodes.is_empty() {
            return Ok(0);
        }

        let mut updates = Vec::new();
        for (ep_id, parsed_title, norm_title, file_path, ep_num, season_num) in &unmatched_episodes {
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

            if let Some((matched_id, _, _, user_prog, _)) =
                matcher.match_episode(&mut ep_elements, Some(file_path))
            {
                if matched_id == anime_id {
                    let watched = ep_elements
                        .episode_number
                        .map(|n| n <= user_prog)
                        .unwrap_or(false) as i32;
                    updates.push((
                        *ep_id,
                        matched_id,
                        watched,
                        ep_elements.episode_number,
                        ep_elements.anime_season,
                        ep_elements.anime_title,
                        ep_elements.normalized_title,
                    ));
                }
            }
        }

        if !updates.is_empty() {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            {
                let mut stmt = tx
                    .prepare(
                        "UPDATE local_episodes
                         SET matched_anime_id = ?1,
                             watched = ?2,
                             episode_number = ?3,
                             anime_season = ?4,
                             parsed_title = ?5,
                             normalized_title = ?6
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

        Ok(updates.len())
    }

    pub fn list_local_episodes(&self, anime_id_filter: Option<i64>) -> Result<Vec<LocalEpisodeFile>, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quick_scan_and_library_fingerprint() {
        let tmp_dir = std::env::temp_dir().join("tora_test_quick_scan");
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let media_dir = tmp_dir.join("media");
        std::fs::create_dir_all(&media_dir).expect("create media dir");

        let db_path = tmp_dir.join("test.db");
        let db = Database::open(&db_path).expect("open test db");
        let folder_str = media_dir.to_string_lossy().to_string();
        db.add_library_folder(&folder_str, Some("Test Media".to_string()))
            .expect("add library folder");

        // Create two initial video files
        let ep1 = media_dir.join("[SubsPlease] Sousou no Frieren - 01 (1080p).mkv");
        let ep2 = media_dir.join("[Judas] Kusuriya - S03E03.mkv");
        std::fs::write(&ep1, b"dummy video content 1").expect("write ep1");
        std::fs::write(&ep2, b"dummy video content 22").expect("write ep2");

        // 1. Initial quick scan parses and matches both new files
        let s1 = db.quick_scan_library_folders().expect("quick scan 1");
        assert_eq!(s1.total_files_indexed, 2);
        assert_eq!(s1.newly_parsed, 2);
        assert_eq!(s1.removed_files, 0);
        assert_eq!(s1.matched_files, 2);

        let fp1 = db.compute_library_fingerprint().expect("fingerprint 1");
        assert_eq!(fp1.0, 2);

        // 2. Second quick scan with no changes hits the 0-parse fast path
        let s2 = db.quick_scan_library_folders().expect("quick scan 2");
        assert_eq!(s2.total_files_indexed, 2);
        assert_eq!(s2.newly_parsed, 0);
        assert_eq!(s2.removed_files, 0);
        assert_eq!(s2.matched_files, 2);

        let fp2 = db.compute_library_fingerprint().expect("fingerprint 2");
        assert_eq!(fp1, fp2);

        // 3. Simulating a newly downloaded episode changes fingerprint and parses only the 1 delta file
        let ep3 = media_dir.join("[SubsPlease] Dandadan - 05 (1080p).mkv");
        std::fs::write(&ep3, b"dummy video content 333").expect("write ep3");

        let fp3 = db.compute_library_fingerprint().expect("fingerprint 3");
        assert_ne!(fp2, fp3);
        assert_eq!(fp3.0, 3);

        let s3 = db.quick_scan_library_folders().expect("quick scan 3");
        assert_eq!(s3.total_files_indexed, 3);
        assert_eq!(s3.newly_parsed, 1);
        assert_eq!(s3.removed_files, 0);
        assert_eq!(s3.matched_files, 3);

        // 4. Deleting a file changes fingerprint and prunes only the 1 removed file
        std::fs::remove_file(&ep1).expect("remove ep1");
        let fp4 = db.compute_library_fingerprint().expect("fingerprint 4");
        assert_ne!(fp3, fp4);
        assert_eq!(fp4.0, 2);

        let s4 = db.quick_scan_library_folders().expect("quick scan 4");
        assert_eq!(s4.total_files_indexed, 2);
        assert_eq!(s4.newly_parsed, 0);
        assert_eq!(s4.removed_files, 1);
        assert_eq!(s4.matched_files, 2);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}

