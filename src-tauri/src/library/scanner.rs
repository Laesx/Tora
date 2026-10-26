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

        // Load existing file cache (file_path -> (modified_unix, file_size))
        let existing_cache: HashMap<String, (i64, u64)> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT file_path, modified_unix, file_size FROM local_episodes")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        (r.get::<_, i64>(1)?, r.get::<_, u64>(2)?),
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        let mut total_files_indexed = 0usize;
        let mut newly_parsed = 0usize;
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

            // Parse new/changed files in parallel using Rayon
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

                    let is_cached = existing_cache
                        .get(&full_str)
                        .map(|(old_m, old_s)| *old_m == *mtime && *old_s == *size)
                        .unwrap_or(false);

                    let mut elements = parse_filename(&full_str);

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
                        !is_cached,
                    )
                })
                .collect();

            let folder_bytes: u64 = parsed_batch.iter().map(|i| i.2).sum();
            let folder_count = parsed_batch.len() as u32;
            total_files_indexed += parsed_batch.len();
            newly_parsed += parsed_batch.iter().filter(|i| i.13).count();

            // Persist in single fast transaction per folder
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            // Remove stale entries for this folder that no longer exist on disk
            tx.execute(
                "DELETE FROM local_episodes WHERE folder_id = ?1",
                params![folder.id],
            )
            .map_err(|e| e.to_string())?;

            {
                let mut insert_stmt = tx
                    .prepare(
                        "INSERT INTO local_episodes (
                            folder_id, file_path, file_name, drive_root, file_size, modified_unix,
                            parsed_title, normalized_title, episode_number, anime_season,
                            release_group, resolution, video_terms_json, audio_terms_json, checksum
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
            matched_files,
            elapsed_ms: start.elapsed().as_millis(),
        })
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
                .map(|(aid, _t, _c, prog, _eps)| (aid, prog));

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
        let norm = normalize_anime_title(normalized_alias);
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
        }
        self.rematch_all_local_episodes()
    }
}
