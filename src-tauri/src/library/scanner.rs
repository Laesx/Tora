use crate::db::{AnimeMatcherIndex, Database, EpisodeMatch, LibraryFolder, LocalEpisodeFile, TitleCandidates};
use crate::detection::anitomy::{directory_title, extra_kind, normalize_anime_title, parse_filename, AnitomyElements};
use rayon::prelude::*;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanSummary {
    pub folders_scanned: usize,
    pub total_files_indexed: usize,
    pub newly_parsed: usize,
    #[serde(default)]
    pub removed_files: usize,
    pub matched_files: usize,
    pub elapsed_ms: u128,
    /// Entries whose local files or folder changed; the frontend refetches only these rows
    #[serde(default)]
    pub changed_anime_ids: Vec<i64>,
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

/// Bump when a parser or matcher change should be applied to files that are already indexed: the next
/// startup scan then matches the whole library again ([`Database::repair_library_matches`]).
const LIBRARY_MATCH_VERSION: i64 = 4;
/// `app_settings` key of the version the stored matches were made with (kept out of `AppSettings`).
const LIBRARY_MATCH_VERSION_KEY: &str = "library_match_version";
/// Separator of [`crate::db::normalize_dir_key`] keys.
const DIR_SEP: char = '\\';

struct ParsedEpisodeRow {
    folder_id: i64,
    drive_root: String,
    file_path: String,
    file_name: String,
    file_size: u64,
    modified_unix: i64,
    parsed_title: String,
    normalized_title: String,
    /// Episode number as written in the file name.
    parsed_episode: Option<u32>,
    /// Episode of the matched entry (differs from `parsed_episode` after a relation redirect).
    episode_number: Option<u32>,
    anime_season: Option<u32>,
    release_group: Option<String>,
    resolution: Option<String>,
    video_terms_json: String,
    audio_terms_json: String,
    checksum: Option<String>,
    matched_anime_id: Option<i64>,
    match_kind: Option<&'static str>,
    /// Kind of extra the name says it is (`anitomy::extra_kind`).
    extra_kind: Option<&'static str>,
    watched: i32,
    /// `(anime, folder)` when the file's own name proves that its folder holds this anime.
    folder_evidence: Option<(i64, String)>,
}

/// What a file resolves to: `(anime, kind, episode of that anime, watched)`. An unmatched file keeps the
/// number in its name.
fn match_columns(
    matched: Option<&EpisodeMatch>,
    parsed: &AnitomyElements,
) -> (Option<i64>, Option<&'static str>, Option<u32>, i32) {
    match matched {
        Some(m) => {
            let watched = m.episode.map_or(false, |n| n <= m.progress) as i32;
            (Some(m.anime_id), Some(m.kind.as_str()), m.episode, watched)
        }
        None => (None, None, parsed.episode_number, 0),
    }
}

/// The file's folder, when its name proves the folder holds the matched anime (never a library root).
fn folder_evidence(matched: Option<&EpisodeMatch>, root_path: &Path, file_path: &Path) -> Option<(i64, String)> {
    let m = matched.filter(|m| m.kind.is_title_evidence())?;
    let parent = file_path.parent().filter(|p| *p != root_path)?;
    Some((m.anime_id, parent.to_string_lossy().to_string()))
}

/// Parse a library file from its path below the library root, so parent folders can give the season or
/// the title ("Sousou no Frieren\01.mkv") but folders above the library never do.
pub fn parse_library_file(root_path: &Path, file_path: &Path) -> AnitomyElements {
    let rel = file_path.strip_prefix(root_path).unwrap_or(file_path).to_string_lossy();
    if rel.is_empty() {
        parse_filename(&file_path.to_string_lossy())
    } else {
        parse_filename(&rel)
    }
}

/// Parses a single video file path and matches it against `AnimeMatcherIndex`.
fn parse_and_match_video_file(
    folder_id: i64,
    drive_root: &str,
    root_path: &Path,
    file_path: &Path,
    file_size: u64,
    modified_unix: i64,
    matcher: &AnimeMatcherIndex,
) -> ParsedEpisodeRow {
    let full_str = file_path.to_string_lossy().to_string();
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let elements = parse_library_file(root_path, file_path);
    let matched = matcher.match_episode(&elements, Some(&full_str));
    let (matched_anime_id, match_kind, episode_number, watched) = match_columns(matched.as_ref(), &elements);
    let folder_evidence = folder_evidence(matched.as_ref(), root_path, file_path);
    let extra_kind = extra_kind(&elements);

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
        parsed_episode: elements.episode_number,
        episode_number,
        anime_season: elements.anime_season,
        release_group: elements.release_group,
        resolution: elements.video_resolution,
        video_terms_json,
        audio_terms_json,
        checksum: elements.file_checksum,
        matched_anime_id,
        match_kind,
        extra_kind,
        watched,
        folder_evidence,
    }
}

/// One `local_episodes` row loaded for rematching.
#[derive(Debug, Clone)]
struct RematchRow {
    id: i64,
    file_path: String,
    /// Path of the library folder the file was indexed under.
    root_path: String,
    parsed_title: String,
    normalized_title: String,
    parsed_episode: Option<u32>,
    episode_number: Option<u32>,
    anime_season: Option<u32>,
    matched_anime_id: Option<i64>,
    match_kind: Option<String>,
    extra_kind: Option<String>,
    watched: i32,
}

/// New state of a `local_episodes` row whose match changed.
#[derive(Debug, Clone, PartialEq)]
struct RematchUpdate {
    id: i64,
    matched_anime_id: Option<i64>,
    match_kind: Option<&'static str>,
    watched: i32,
    episode_number: Option<u32>,
    parsed_episode: Option<u32>,
    anime_season: Option<u32>,
    parsed_title: String,
    normalized_title: String,
    extra_kind: Option<&'static str>,
}

/// Result of a rematch pass.
#[derive(Debug, Clone, Default)]
struct RematchSummary {
    /// Files looked at in the last pass.
    files: usize,
    /// Files that resolve to an entry (in targeted mode: to one of the targets).
    matched: usize,
    /// Rows whose match or parsed columns changed.
    updated: usize,
    /// Entries that lost or gained a file, or got their folder linked.
    changed_anime_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq)]
struct RematchOutcome {
    /// The file resolved to an entry (and, in targeted mode, to one of the targets).
    matched: bool,
    update: Option<RematchUpdate>,
    folder_evidence: Option<(i64, String)>,
}

/// Turn a file's fresh parse and match into the row's outcome. In targeted mode, a file whose match is
/// not one of `targets` is left as it is.
fn finish_rematch(
    row: &RematchRow,
    elements: AnitomyElements,
    matched: Option<EpisodeMatch>,
    targets: Option<&HashSet<i64>>,
) -> RematchOutcome {
    if let Some(targets) = targets {
        if !matched.as_ref().map_or(false, |m| targets.contains(&m.anime_id)) {
            return RematchOutcome {
                matched: false,
                update: None,
                folder_evidence: None,
            };
        }
    }

    let (new_aid, new_kind, new_episode, new_watched) = match_columns(matched.as_ref(), &elements);
    let folder_evidence = folder_evidence(matched.as_ref(), Path::new(&row.root_path), Path::new(&row.file_path));
    let new_extra = extra_kind(&elements);

    let changed = row.matched_anime_id != new_aid
        || row.match_kind.as_deref() != new_kind
        || row.watched != new_watched
        || row.episode_number != new_episode
        || row.parsed_episode != elements.episode_number
        || row.anime_season != elements.anime_season
        || row.parsed_title != elements.anime_title
        || row.normalized_title != elements.normalized_title
        || row.extra_kind.as_deref() != new_extra;

    RematchOutcome {
        matched: new_aid.is_some(),
        update: changed.then(|| RematchUpdate {
            id: row.id,
            matched_anime_id: new_aid,
            match_kind: new_kind,
            watched: new_watched,
            episode_number: new_episode,
            parsed_episode: elements.episode_number,
            anime_season: elements.anime_season,
            parsed_title: elements.anime_title,
            normalized_title: elements.normalized_title,
            extra_kind: new_extra,
        }),
        folder_evidence,
    }
}

/// Memoized, parallel equivalent of parsing every row's file again and running `matcher.match_episode`:
/// 1. per file (parallel): parse the path (a match never depends on what was stored before);
/// 2. per distinct normalized title (parallel): the title step, fuzzy matching included;
/// 3. per file (parallel): folders, episode validation and relations on the (memoized) title step.
fn compute_rematch_outcomes(
    matcher: &AnimeMatcherIndex,
    episodes: &[RematchRow],
    targets: Option<&HashSet<i64>>,
) -> Vec<RematchOutcome> {
    let parsed: Vec<AnitomyElements> = episodes
        .par_iter()
        .map(|row| parse_library_file(Path::new(&row.root_path), Path::new(&row.file_path)))
        .collect();

    let distinct_titles: HashSet<&str> = parsed.iter().map(|e| e.normalized_title.as_str()).collect();
    let title_memo: HashMap<&str, TitleCandidates> = distinct_titles
        .into_par_iter()
        .map(|title| (title, matcher.title_candidates(title)))
        .collect();

    let matches: Vec<Option<EpisodeMatch>> = parsed
        .par_iter()
        .zip(episodes.par_iter())
        .map(|(elements, row)| {
            let cands = title_memo.get(elements.normalized_title.as_str())?;
            matcher.resolve(cands, elements, Some(&row.file_path))
        })
        .collect();

    parsed
        .into_par_iter()
        .zip(matches)
        .zip(episodes.par_iter())
        .map(|((elements, matched), row)| finish_rematch(row, elements, matched, targets))
        .collect()
}

/// The folder each anime gets linked to: the one where most of its files were found by name.
fn best_folder_per_anime(evidence: impl Iterator<Item = (i64, String)>) -> HashMap<i64, String> {
    let mut counts: HashMap<(i64, String), usize> = HashMap::new();
    for item in evidence {
        *counts.entry(item).or_default() += 1;
    }
    let mut best: HashMap<i64, (String, usize)> = HashMap::new();
    for ((aid, dir), count) in counts {
        match best.get(&aid) {
            Some((current, n)) if *n > count || (*n == count && *current <= dir) => {}
            _ => {
                best.insert(aid, (dir, count));
            }
        }
    }
    best.into_iter().map(|(aid, (dir, _))| (aid, dir)).collect()
}

/// Link each anime that has no folder yet to its folder in `folders` (inside the caller's transaction).
/// Returns the entries that were linked. Several entries may end up sharing a folder.
fn link_folders_tx(tx: &rusqlite::Transaction<'_>, folders: &HashMap<i64, String>) -> Result<Vec<i64>, String> {
    let mut linked = Vec::new();
    if folders.is_empty() {
        return Ok(linked);
    }
    let mut stmt = tx
        .prepare(
            "UPDATE anime_entries SET custom_folder = ?1
             WHERE id = ?2 AND (custom_folder IS NULL OR custom_folder = '')",
        )
        .map_err(|e| e.to_string())?;
    for (aid, dir) in folders {
        if stmt.execute(params![dir, aid]).unwrap_or(0) > 0 {
            linked.push(*aid);
        }
    }
    Ok(linked)
}

/// Every file under a directory path: `(prefix, prefix length)` for `substr(file_path, 1, ?2) = ?1`
/// (`LIKE` would treat `_` and `%` in folder names as wildcards).
fn dir_prefix(path: &str) -> (String, i64) {
    let prefix = format!("{}\\", path.trim_end_matches(['\\', '/']));
    let len = prefix.chars().count() as i64;
    (prefix, len)
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
                matched_anime_id, watched, parsed_episode, match_kind, extra_kind
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
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
                matched_anime_id = excluded.matched_anime_id,
                watched = excluded.watched,
                parsed_episode = excluded.parsed_episode,
                match_kind = excluded.match_kind,
                extra_kind = excluded.extra_kind",
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
            r.parsed_episode,
            r.match_kind,
            r.extra_kind,
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
        if self.library_match_version() < LIBRARY_MATCH_VERSION {
            return self.repair_library_matches();
        }
        self.scan_library_internal(true)
    }

    /// Version of the matching rules the stored matches were made with (0 before versions existed).
    fn library_match_version(&self) -> i64 {
        let Ok(conn) = self.reader() else { return 0 };
        conn.query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            params![LIBRARY_MATCH_VERSION_KEY],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(0)
    }

    /// One-time repair after the matching rules changed: match every indexed file again, drop the folder
    /// links the files contradict, match once more, then remember the version.
    pub fn repair_library_matches(&self) -> Result<ScanSummary, String> {
        log::info!(
            target: "library",
            "matching rules changed (version {} -> {}): rematching the library",
            self.library_match_version(),
            LIBRARY_MATCH_VERSION
        );
        self.renormalize_titles()?;
        // A full scan ends with a rematch of every indexed file
        let mut summary = self.scan_library_internal(false)?;
        self.clear_links_and_rematch(&mut summary)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES (?1, ?2)",
            params![LIBRARY_MATCH_VERSION_KEY, LIBRARY_MATCH_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(summary)
    }

    /// The repair without the disk: the indexed files (as stored) are parsed again from their paths and
    /// matched, folder links are made and cleared as in [`Self::repair_library_matches`]. Deterministic for
    /// a given database and code, so the match lab (`examples/match_lab`) runs it on a library snapshot.
    pub fn rematch_from_index(&self) -> Result<ScanSummary, String> {
        let start = std::time::Instant::now();
        self.renormalize_titles()?;
        let rematch = self.rematch_episodes_internal(None)?;
        let mut summary = ScanSummary {
            total_files_indexed: rematch.files,
            matched_files: rematch.matched,
            changed_anime_ids: rematch.changed_anime_ids,
            ..Default::default()
        };
        self.clear_links_and_rematch(&mut summary)?;
        summary.elapsed_ms = start.elapsed().as_millis();
        Ok(summary)
    }

    fn renormalize_titles(&self) -> Result<(), String> {
        let renormalized = self.rebuild_normalized_titles()?;
        if renormalized > 0 {
            log::info!(target: "library", "normalized the titles of {} entries again", renormalized);
        }
        Ok(())
    }

    /// Last step of a repair, after every file was matched: clear the folder links the files contradict,
    /// then match again without them.
    fn clear_links_and_rematch(&self, summary: &mut ScanSummary) -> Result<(), String> {
        let cleared = self.clear_contradicted_folder_links()?;
        if cleared.is_empty() {
            return Ok(());
        }
        let rematch = self.rematch_episodes_internal(None)?;
        summary.matched_files = rematch.matched;
        let mut changed: HashSet<i64> = summary.changed_anime_ids.iter().copied().collect();
        changed.extend(cleared);
        changed.extend(rematch.changed_anime_ids);
        summary.changed_anime_ids = changed.into_iter().collect();
        Ok(())
    }

    /// Clears folder links that the indexed files show to be wrong. Looking at the files whose nearest
    /// linked folder is that folder, a link goes when the name of the folder is not a title of the anime and
    /// - no file there belongs to the anime (a tool folder, a franchise folder linked to one movie), or
    /// - the anime only holds files that name nothing, while other files there name other anime.
    /// A folder of files that name nothing at all (fansub titles in another language) keeps its link: it is
    /// what matches them. Returns the entries whose link was cleared.
    fn clear_contradicted_folder_links(&self) -> Result<Vec<i64>, String> {
        let matcher = self.matcher_index()?;
        if matcher.custom_folders.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<(String, Option<i64>, Option<String>)> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT file_path, matched_anime_id, match_kind FROM local_episodes")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };

        // Per linked folder and anime linked to it:
        // (files of the anime, of which matched by name, files of other anime matched by name)
        let mut tally: HashMap<(String, i64), (usize, usize, usize)> = HashMap::new();
        for (file_path, matched, kind) in &rows {
            let Some((key, linked)) = matcher.linked_folder(file_path) else { continue };
            let by_name = matches!(kind.as_deref(), Some("alias" | "title" | "relation" | "directory" | "fuzzy"));
            for aid in linked {
                let entry = tally.entry((key.clone(), *aid)).or_default();
                match matched {
                    Some(m) if m == aid => {
                        entry.0 += 1;
                        entry.1 += by_name as usize;
                    }
                    Some(m) if by_name && !linked.contains(m) => entry.2 += 1,
                    _ => {}
                }
            }
        }

        let mut cleared: Vec<(i64, String)> = Vec::new();
        for (key, linked) in &matcher.custom_folders {
            let dir_name = key.rsplit(DIR_SEP).next().unwrap_or(key);
            let named = matcher.title_candidates(&directory_title(dir_name));
            for aid in linked {
                let (own, own_by_name, others_by_name) =
                    tally.get(&(key.clone(), *aid)).copied().unwrap_or_default();
                let folder_names_it =
                    named.alias == Some(*aid) || named.exact.contains(aid) || named.fuzzy == Some(*aid);
                let contradicted = own == 0 || (own_by_name == 0 && others_by_name > 0);
                if contradicted && !folder_names_it {
                    cleared.push((*aid, key.clone()));
                }
            }
        }

        if !cleared.is_empty() {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            for (aid, key) in &cleared {
                let title = matcher.by_id.get(aid).map(|e| e.0.as_str()).unwrap_or("?");
                log::info!(
                    target: "library",
                    "cleared the folder link of {:?}: nothing in {:?} is this anime",
                    title,
                    key
                );
                conn.execute("UPDATE anime_entries SET custom_folder = NULL WHERE id = ?1", params![aid])
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(cleared.into_iter().map(|(aid, _)| aid).collect())
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
            return Ok(ScanSummary::default());
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

        let matcher = self.matcher_index()?;
        let mut seen_ids: HashSet<i64> = HashSet::with_capacity(existing_cache.len());
        let mut to_parse: Vec<(i64, String, PathBuf, PathBuf, u64, i64, Option<i64>)> = Vec::new();
        let mut folder_stats: Vec<(i64, u32, u64)> = Vec::with_capacity(folders.len());
        let mut total_files_indexed = 0usize;
        let mut unchanged_matched = 0usize;

        // Folders that could be read: an unplugged drive must not drop its files from the index
        let mut scanned_folder_ids: HashSet<i64> = HashSet::new();
        for folder in &folders {
            let root_path = PathBuf::from(&folder.path);
            if !root_path.exists() {
                continue;
            }
            scanned_folder_ids.insert(folder.id);

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
                    // An unchanged file is not parsed again here: a full scan rematches every row below
                    if old_fid == folder.id && old_mtime == mtime && old_size == size {
                        if valid_prev.is_some() {
                            unchanged_matched += 1;
                        }
                        continue;
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

        let stale_ids: Vec<i64> = existing_cache
            .values()
            .filter(|&&(row_id, fid, _, _, _)| {
                scanned_folder_ids.contains(&fid) && !seen_ids.contains(&row_id)
            })
            .map(|&(row_id, _, _, _, _)| row_id)
            .collect();

        // Fast path: 0 changes on disk (a full scan still rematches every file)
        if quick_mode && to_parse.is_empty() && stale_ids.is_empty() {
            return Ok(ScanSummary {
                folders_scanned: folders.len(),
                total_files_indexed,
                matched_files: unchanged_matched,
                elapsed_ms: start.elapsed().as_millis(),
                ..Default::default()
            });
        }

        let parsed_rows: Vec<ParsedEpisodeRow> = to_parse
            .par_iter()
            .map(|(fid, droot, rpath, fpath, size, mtime, _prev_aid)| {
                parse_and_match_video_file(*fid, droot, rpath, fpath, *size, *mtime, &matcher)
            })
            .collect();

        let folders_found =
            best_folder_per_anime(parsed_rows.iter().filter_map(|r| r.folder_evidence.clone()));
        let linked: Vec<i64>;

        let newly_matched = parsed_rows
            .iter()
            .filter(|r| r.matched_anime_id.is_some())
            .count();
        let now = chrono::Utc::now().timestamp();

        // Entries whose files change: owners of removed rows, previous and new owners of re-parsed rows
        let stale_set: HashSet<i64> = stale_ids.iter().copied().collect();
        let mut changed_ids: HashSet<i64> = existing_cache
            .values()
            .filter(|(row_id, ..)| stale_set.contains(row_id))
            .filter_map(|&(.., aid)| aid)
            .collect();
        changed_ids.extend(to_parse.iter().filter_map(|t| t.6));
        changed_ids.extend(parsed_rows.iter().filter_map(|r| r.matched_anime_id));

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

            // Link the folder of an anime that has none, from files that name it
            linked = link_folders_tx(&tx, &folders_found)?;
            changed_ids.extend(linked.iter().copied());

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

        let mut matched_files = unchanged_matched + newly_matched;
        if !quick_mode {
            // A full scan matches every indexed file again, so "Rescan" repairs wrong matches
            let rematch = self.rematch_episodes_internal(None)?;
            matched_files = rematch.matched;
            changed_ids.extend(rematch.changed_anime_ids);
        } else if !linked.is_empty() {
            // Other files in a folder that was just linked may now belong to its anime
            let targets: HashSet<i64> = linked.iter().copied().collect();
            let rematch = self.rematch_episodes_internal(Some(&targets))?;
            changed_ids.extend(rematch.changed_anime_ids);
        }

        Ok(ScanSummary {
            folders_scanned: folders.len(),
            total_files_indexed,
            newly_parsed: parsed_rows.len(),
            removed_files: stale_ids.len(),
            matched_files,
            elapsed_ms: start.elapsed().as_millis(),
            changed_anime_ids: changed_ids.into_iter().collect(),
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
        let matcher = self.matcher_index()?;

        let mut removed_paths: Vec<String> = Vec::new();
        let mut added_rows: Vec<ParsedEpisodeRow> = Vec::new();
        let mut folder_renames: Vec<(String, Option<String>)> = Vec::new();
        // (anime, folder) of files whose own name proves the folder holds that anime
        let mut folder_evidence: Vec<(i64, String)> = Vec::new();
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
                        self.collect_files_in_path(
                            ev.folder_id,
                            &ev.drive_root,
                            &ev.root_path,
                            new_path,
                            &matcher,
                            &mut added_rows,
                            &mut folder_evidence,
                        );
                    } else if new_path.is_file() && is_video_file(new_path) {
                        self.collect_single_file(
                            ev.folder_id,
                            &ev.drive_root,
                            &ev.root_path,
                            new_path,
                            &matcher,
                            &mut added_rows,
                            &mut folder_evidence,
                        );
                    }
                }
                DirectoryChangeAction::Added(path) => {
                    if path.is_dir() {
                        self.collect_files_in_path(
                            ev.folder_id,
                            &ev.drive_root,
                            &ev.root_path,
                            path,
                            &matcher,
                            &mut added_rows,
                            &mut folder_evidence,
                        );
                    } else if path.is_file() && is_video_file(path) {
                        self.collect_single_file(
                            ev.folder_id,
                            &ev.drive_root,
                            &ev.root_path,
                            path,
                            &matcher,
                            &mut added_rows,
                            &mut folder_evidence,
                        );
                    }
                }
            }
        }

        if removed_paths.is_empty() && added_rows.is_empty() {
            return Ok(None);
        }

        let mut removed_count = 0usize;
        let linked: Vec<i64>;
        let now = chrono::Utc::now().timestamp();
        // Entries whose files or folder change: owners before (removed / replaced rows) and after
        let mut changed_ids: HashSet<i64> =
            added_rows.iter().filter_map(|r| r.matched_anime_id).collect();

        {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            {
                let mut owners = tx
                    .prepare(
                        "SELECT DISTINCT matched_anime_id FROM local_episodes
                         WHERE (file_path = ?1 OR (?3 > 0 AND substr(file_path, 1, ?3) = ?2))
                           AND matched_anime_id IS NOT NULL",
                    )
                    .map_err(|e| e.to_string())?;
                let removed = removed_paths.iter().map(|p| (p.as_str(), dir_prefix(p)));
                let replaced = added_rows.iter().map(|r| (r.file_path.as_str(), (String::new(), 0)));
                for (path, (prefix, prefix_len)) in removed.chain(replaced) {
                    let ids = owners
                        .query_map(params![path, prefix, prefix_len], |r| r.get::<_, i64>(0))
                        .map_err(|e| e.to_string())?;
                    changed_ids.extend(ids.flatten());
                }
            }

            for old_path in &removed_paths {
                let (prefix, prefix_len) = dir_prefix(old_path);
                let n = tx
                    .execute(
                        "DELETE FROM local_episodes WHERE file_path = ?1 OR substr(file_path, 1, ?3) = ?2",
                        params![old_path, prefix, prefix_len],
                    )
                    .map_err(|e| e.to_string())?;
                removed_count += n;
            }

            for (old_folder, new_folder) in &folder_renames {
                if let Ok(mut stmt) = tx.prepare("SELECT id FROM anime_entries WHERE custom_folder = ?1") {
                    if let Ok(ids) = stmt.query_map(params![old_folder], |r| r.get::<_, i64>(0)) {
                        changed_ids.extend(ids.flatten());
                    }
                }
                let _ = tx.execute(
                    "UPDATE anime_entries SET custom_folder = ?1 WHERE custom_folder = ?2",
                    params![new_folder, old_folder],
                );
            }

            upsert_episode_rows(&tx, &added_rows)?;

            linked = link_folders_tx(&tx, &best_folder_per_anime(folder_evidence.into_iter()))?;
            changed_ids.extend(linked.iter().copied());

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

        if removed_count == 0 && added_rows.is_empty() {
            return Ok(None);
        }

        // Other files in a folder that was just linked may now belong to its anime
        if !linked.is_empty() {
            let targets: HashSet<i64> = linked.iter().copied().collect();
            let rematch = self.rematch_episodes_internal(Some(&targets))?;
            changed_ids.extend(rematch.changed_anime_ids);
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
            changed_anime_ids: changed_ids.into_iter().collect(),
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
        folder_evidence: &mut Vec<(i64, String)>,
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
            folder_id, drive_root, root_path, file_path, size, mtime, matcher,
        );
        folder_evidence.extend(row.folder_evidence.clone());
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
        folder_evidence: &mut Vec<(i64, String)>,
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
                folder_evidence,
            );
        }
    }

    /// Parse and match every indexed file again with the cached `AnimeMatcherIndex`. A file's match depends
    /// only on its path and the index, so this also repairs matches that an earlier version got wrong.
    pub fn rematch_all_local_episodes(&self) -> Result<usize, String> {
        self.rematch_episodes_internal(None).map(|r| r.matched)
    }

    /// Targeted matching for a single newly added anime entry.
    pub fn match_unmatched_episodes_for_anime(&self, anime_id: i64) -> Result<usize, String> {
        self.match_unmatched_episodes_for_ids(&[anime_id])
    }

    /// Targeted matching for several entries in one pass: only files that are unmatched, or matched by a
    /// weak rule (folder, fuzzy), are looked at, and a file changes only if it now resolves to one of
    /// `ids`. Files matched by their own title are never touched. Returns the number of files that moved.
    pub fn match_unmatched_episodes_for_ids(&self, ids: &[i64]) -> Result<usize, String> {
        if ids.is_empty() {
            return Ok(0);
        }
        let targets: HashSet<i64> = ids.iter().copied().collect();
        self.rematch_episodes_internal(Some(&targets)).map(|r| r.updated)
    }

    fn rematch_episodes_internal(&self, targets: Option<&HashSet<i64>>) -> Result<RematchSummary, String> {
        let start = std::time::Instant::now();
        let mut summary = RematchSummary::default();
        let mut changed_ids: HashSet<i64> = HashSet::new();
        let mut files = 0usize;

        // Linking a folder can match more files in it, so a full rematch runs once more after linking.
        for _pass in 0..2 {
            let matcher = self.matcher_index()?;
            let episodes: Vec<RematchRow> = {
                let conn = self.conn.lock().map_err(|e| e.to_string())?;
                let filter = if targets.is_some() {
                    "WHERE le.matched_anime_id IS NULL OR le.match_kind IS NULL OR le.match_kind IN ('folder', 'fuzzy')"
                } else {
                    ""
                };
                let sql = format!(
                    "SELECT le.id, le.file_path, lf.path, le.parsed_title, le.normalized_title, le.parsed_episode,
                            le.episode_number, le.anime_season, le.matched_anime_id, le.match_kind, le.watched, le.extra_kind
                     FROM local_episodes le JOIN library_folders lf ON lf.id = le.folder_id {filter}"
                );
                let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok(RematchRow {
                            id: r.get(0)?,
                            file_path: r.get(1)?,
                            root_path: r.get(2)?,
                            parsed_title: r.get(3)?,
                            normalized_title: r.get(4)?,
                            parsed_episode: r.get(5)?,
                            episode_number: r.get(6)?,
                            anime_season: r.get(7)?,
                            matched_anime_id: r.get(8)?,
                            match_kind: r.get(9)?,
                            watched: r.get(10)?,
                            extra_kind: r.get(11)?,
                        })
                    })
                    .map_err(|e| e.to_string())?;
                rows.flatten().collect()
            };
            files = episodes.len();

            let outcomes = compute_rematch_outcomes(&matcher, &episodes, targets);
            summary.matched = outcomes.iter().filter(|o| o.matched).count();
            let updates: Vec<(&RematchRow, &RematchUpdate)> = episodes
                .iter()
                .zip(&outcomes)
                .filter_map(|(row, o)| o.update.as_ref().map(|u| (row, u)))
                .collect();
            for (row, update) in &updates {
                changed_ids.extend(row.matched_anime_id);
                changed_ids.extend(update.matched_anime_id);
            }
            summary.updated += updates.len();
            // Folder links only come from a full pass: it sees every file of a folder
            let folders_found = if targets.is_none() {
                best_folder_per_anime(outcomes.iter().filter_map(|o| o.folder_evidence.clone()))
            } else {
                HashMap::new()
            };

            let mut linked: Vec<i64> = Vec::new();
            if !updates.is_empty() || !folders_found.is_empty() {
                let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                {
                    let mut stmt = tx
                        .prepare(
                            "UPDATE local_episodes
                             SET matched_anime_id = ?1, watched = ?2, episode_number = ?3, anime_season = ?4,
                                 parsed_title = ?5, normalized_title = ?6, parsed_episode = ?7, match_kind = ?8,
                                 extra_kind = ?10
                             WHERE id = ?9",
                        )
                        .map_err(|e| e.to_string())?;
                    for (_, u) in &updates {
                        stmt.execute(params![
                            u.matched_anime_id,
                            u.watched,
                            u.episode_number,
                            u.anime_season,
                            u.parsed_title,
                            u.normalized_title,
                            u.parsed_episode,
                            u.match_kind,
                            u.id,
                            u.extra_kind
                        ])
                        .map_err(|e| e.to_string())?;
                    }
                }
                linked = link_folders_tx(&tx, &folders_found)?;
                tx.commit().map_err(|e| e.to_string())?;
            }
            changed_ids.extend(linked.iter().copied());
            if linked.is_empty() {
                break;
            }
            log::info!(target: "library", "linked the folders of {} anime from their files", linked.len());
        }

        log::info!(
            target: "matcher",
            "rematch: {} files, {} updated in {}ms",
            files,
            summary.updated,
            start.elapsed().as_millis()
        );

        summary.files = files;
        summary.changed_anime_ids = changed_ids.into_iter().collect();
        Ok(summary)
    }

    pub fn list_local_episodes(
        &self,
        anime_id_filter: Option<i64>,
    ) -> Result<Vec<LocalEpisodeFile>, String> {
        let conn = self.reader()?;
        let sql = if anime_id_filter.is_some() {
            "SELECT
                le.id, le.folder_id, le.file_path, le.file_name, le.drive_root, le.file_size,
                le.modified_unix, le.parsed_title, le.normalized_title, le.episode_number,
                le.anime_season, le.release_group, le.resolution, le.video_terms_json,
                le.audio_terms_json, le.checksum, le.matched_anime_id, ae.title_romaji, le.watched,
                le.parsed_episode, le.match_kind, le.extra_kind
             FROM local_episodes le
             LEFT JOIN anime_entries ae ON le.matched_anime_id = ae.id
             WHERE le.matched_anime_id = ?1
             ORDER BY le.episode_number ASC, le.file_name ASC"
        } else {
            "SELECT
                le.id, le.folder_id, le.file_path, le.file_name, le.drive_root, le.file_size,
                le.modified_unix, le.parsed_title, le.normalized_title, le.episode_number,
                le.anime_season, le.release_group, le.resolution, le.video_terms_json,
                le.audio_terms_json, le.checksum, le.matched_anime_id, ae.title_romaji, le.watched,
                le.parsed_episode, le.match_kind, le.extra_kind
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
                parsed_episode: r.get(19)?,
                match_kind: r.get(20)?,
                extra_kind: r.get(21)?,
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
                        match db.handle_directory_change_events(&batch) {
                            Ok(Some(summary)) => {
                                log::debug!(
                                    target: "library",
                                    "watcher: {} events, {} parsed, {} removed, {} entries changed in {}ms",
                                    batch.len(),
                                    summary.newly_parsed,
                                    summary.removed_files,
                                    summary.changed_anime_ids.len(),
                                    summary.elapsed_ms
                                );
                                on_change(summary);
                            }
                            Ok(None) => {}
                            Err(e) => log::warn!(target: "library", "watcher batch of {} events failed: {}", batch.len(), e),
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
        let owner_of = |path: &Path| {
            db.list_local_episodes(None)
                .unwrap()
                .into_iter()
                .find(|e| e.file_path == path.to_string_lossy())
                .and_then(|e| e.matched_anime_id)
                .expect("matched file")
        };
        let mut changed = s1.changed_anime_ids.clone();
        changed.sort_unstable();
        let mut owners = vec![owner_of(&ep1), owner_of(&ep2)];
        owners.sort_unstable();
        assert_eq!(changed, owners);

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
        assert!(s2.changed_anime_ids.is_empty());

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
        assert_eq!(s3.changed_anime_ids, vec![owner_of(&ep3)]);

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
        assert_eq!(s4.changed_anime_ids, vec![154587]);
        assert_eq!(db.list_local_episodes(None).unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    /// One full parse + `match_episode` per file: the reference the memoized / parallel implementation
    /// must reproduce exactly.
    fn reference_rematch_outcomes(
        matcher: &AnimeMatcherIndex,
        episodes: &[RematchRow],
        targets: Option<&HashSet<i64>>,
    ) -> Vec<RematchOutcome> {
        episodes
            .iter()
            .map(|row| {
                let elements = parse_library_file(Path::new(&row.root_path), Path::new(&row.file_path));
                let matched = matcher.match_episode(&elements, Some(&row.file_path));
                finish_rematch(row, elements, matched, targets)
            })
            .collect()
    }

    fn rematch_fixture_db(name: &str) -> (Database, PathBuf) {
        let tmp_dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let db = Database::open(&tmp_dir.join("test.db")).expect("open test db");
        db.upsert_anime_entries_batch(&crate::db::test_fixture_entries())
            .expect("load fixtures");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO library_folders (id, path, label, drive_root) VALUES (1, 'C:\\lib', 'lib', 'C:\\')",
                [],
            )
            .unwrap();
        }
        (db, tmp_dir)
    }

    /// Insert a `local_episodes` row as an older version would have left it: parsed from the file name
    /// alone, with whatever match it had (`matched` set means "matched by its title").
    fn seed_episode(db: &Database, file_path: &str, matched: Option<i64>, watched: i32) {
        let file_name = file_path.rsplit('\\').next().unwrap();
        let p = parse_filename(file_name);
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO local_episodes (folder_id, file_path, file_name, drive_root, parsed_title,
                normalized_title, episode_number, anime_season, matched_anime_id, watched, match_kind)
             VALUES (1, ?1, ?2, 'C:\\', ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                file_path,
                file_name,
                p.anime_title,
                p.normalized_title,
                p.episode_number,
                p.anime_season,
                matched,
                watched,
                matched.map(|_| "title")
            ],
        )
        .unwrap();
    }

    fn load_rematch_rows(db: &Database) -> Vec<RematchRow> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT le.id, le.file_path, lf.path, le.parsed_title, le.normalized_title, le.parsed_episode,
                        le.episode_number, le.anime_season, le.matched_anime_id, le.match_kind, le.watched, le.extra_kind
                 FROM local_episodes le JOIN library_folders lf ON lf.id = le.folder_id ORDER BY le.id",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok(RematchRow {
                    id: r.get(0)?,
                    file_path: r.get(1)?,
                    root_path: r.get(2)?,
                    parsed_title: r.get(3)?,
                    normalized_title: r.get(4)?,
                    parsed_episode: r.get(5)?,
                    episode_number: r.get(6)?,
                    anime_season: r.get(7)?,
                    matched_anime_id: r.get(8)?,
                    match_kind: r.get(9)?,
                    watched: r.get(10)?,
                    extra_kind: r.get(11)?,
                })
            })
            .unwrap();
        rows.flatten().collect()
    }

    /// `(anime, watched, episode of that anime, match kind)` of an indexed file.
    fn episode_state(db: &Database, file_path: &str) -> (Option<i64>, i32, Option<u32>, Option<String>) {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT matched_anime_id, watched, episode_number, match_kind FROM local_episodes WHERE file_path = ?1",
            params![file_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    /// Anime and episode of an indexed file.
    fn owner(db: &Database, file_path: &str) -> (Option<i64>, Option<u32>) {
        let (aid, _, episode, _) = episode_state(db, file_path);
        (aid, episode)
    }

    fn link_folder(db: &Database, anime_id: i64, folder: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE anime_entries SET custom_folder = ?1 WHERE id = ?2",
            params![folder, anime_id],
        )
        .unwrap();
    }

    fn folder_of(db: &Database, anime_id: i64) -> Option<String> {
        db.get_anime_entry_by_id(anime_id).unwrap().custom_folder
    }

    fn entry(id: i64, mal_id: i64, title: &str, episodes: u32, progress: u32) -> crate::db::AnimeEntry {
        let mut e = crate::db::test_entry(id, title);
        e.mal_id = Some(mal_id);
        e.episodes = Some(episodes);
        e.user_progress = progress;
        e
    }

    const FRIEREN_BD_DIR: &str = "C:\\lib\\Frieren BD";
    const REMATCH_FILES: &[(&str, Option<i64>, i32)] = &[
        // A linked folder gives the anime of files whose title names nothing, unless the number is no episode of it
        ("C:\\lib\\Frieren BD\\[BD] Totally Different Name - 03.mkv", None, 0),
        ("C:\\lib\\Frieren BD\\[BD] Totally Different Name - 30.mkv", None, 0),
        // Same title outside the linked folder: memoized title path
        ("C:\\lib\\[SubsPlease] Sousou no Frieren - 01 (1080p).mkv", None, 0),
        ("C:\\lib\\[SubsPlease] Sousou no Frieren - 27 (1080p).mkv", None, 1),
        // Relations redirects (continuous numbering, English title, a season in the name)
        ("C:\\lib\\[SubsPlease] Kusuriya no Hitorigoto - 26 (1080p).mkv", None, 0),
        ("C:\\lib\\[SubsPlease] Kusuriya no Hitorigoto - 05 (1080p).mkv", None, 0),
        ("C:\\lib\\[SubsPlease] The Apothecary Diaries - 26 (1080p).mkv", None, 0),
        ("C:\\lib\\[Judas] Kusuriya - S03E03.mkv", None, 0),
        // Season isolation
        ("C:\\lib\\[EMBER] Bocchi the Rock! - S01E12 [1080p].mkv", None, 0),
        ("C:\\lib\\[EMBER] Bocchi the Rock! - S02E12 [1080p].mkv", None, 1),
        // Many files sharing one title
        ("C:\\lib\\[SubsPlease] Dandadan - 01 (1080p).mkv", None, 0),
        ("C:\\lib\\[SubsPlease] Dandadan - 08 (1080p).mkv", None, 0),
        ("C:\\lib\\[SubsPlease] Dandadan - 09 (1080p).mkv", Some(171018), 1),
        ("C:\\lib\\[SubsPlease] Dandadan - 10 (1080p).mkv", None, 0),
        // A match from an older version that nothing supports any more is dropped
        ("C:\\lib\\[X] Totally Unknown Show - 01.mkv", Some(4224), 0),
        ("C:\\lib\\[X] Another Unknown Show - 02.mkv", Some(999999), 1),
    ];

    #[test]
    fn test_memoized_rematch_equals_sequential_reference() {
        let (db, tmp_dir) = rematch_fixture_db("tora_test_scanner_rematch_equiv");
        link_folder(&db, 154587, FRIEREN_BD_DIR);
        for (path, matched, watched) in REMATCH_FILES {
            seed_episode(&db, path, *matched, *watched);
        }

        let rows = load_rematch_rows(&db);
        let matcher = db.matcher_index().unwrap();
        let expected = reference_rematch_outcomes(&matcher, &rows, None);
        assert_eq!(compute_rematch_outcomes(&matcher, &rows, None), expected);
        let targets: HashSet<i64> = [176301, 171018, 4224].into_iter().collect();
        assert_eq!(
            compute_rematch_outcomes(&matcher, &rows, Some(&targets)),
            reference_rematch_outcomes(&matcher, &rows, Some(&targets))
        );

        let matched = db.rematch_all_local_episodes().unwrap();
        assert_eq!(matched, expected.iter().filter(|o| o.matched).count());

        // The fixture really exercises the interesting paths
        let state = |i: usize| episode_state(&db, REMATCH_FILES[i].0);
        assert_eq!(owner(&db, REMATCH_FILES[0].0), (Some(154587), Some(3)));
        assert_eq!(state(0).3.as_deref(), Some("folder"));
        assert_eq!(owner(&db, REMATCH_FILES[1].0).0, None, "30 is no episode of the folder's anime");
        assert_eq!(state(2).3.as_deref(), Some("title"));
        assert_eq!(owner(&db, REMATCH_FILES[4].0), (Some(176301), Some(2)));
        assert_eq!(state(4).3.as_deref(), Some("relation"));
        assert_eq!(owner(&db, REMATCH_FILES[6].0), (Some(176301), Some(2)));
        assert_eq!(owner(&db, REMATCH_FILES[7].0), (Some(195516), Some(3)));
        assert_eq!(state(9).0, None);
        assert_eq!(owner(&db, REMATCH_FILES[12].0), (Some(171018), Some(9)));
        assert_eq!(state(14).0, None);
        assert_eq!(state(15).0, None);
        // The number in the name is kept next to the redirected one
        {
            let conn = db.conn.lock().unwrap();
            let parsed: Option<u32> = conn
                .query_row(
                    "SELECT parsed_episode FROM local_episodes WHERE file_path = ?1",
                    params![REMATCH_FILES[4].0],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(parsed, Some(26));
        }

        // A second run is a no-op: a match depends only on the path and the index
        let rows = load_rematch_rows(&db);
        let matcher = db.matcher_index().unwrap();
        assert!(compute_rematch_outcomes(&matcher, &rows, None)
            .iter()
            .all(|o| o.update.is_none()));

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_match_unmatched_episodes_for_ids_only_binds_targets() {
        let (db, tmp_dir) = rematch_fixture_db("tora_test_scanner_match_for_ids");
        let frieren = "C:\\lib\\[SubsPlease] Sousou no Frieren - 01 (1080p).mkv";
        let dandadan = "C:\\lib\\[SubsPlease] Dandadan - 02 (1080p).mkv";
        let kusuriya = "C:\\lib\\[Judas] Kusuriya - S03E03.mkv";
        let pre_matched = "C:\\lib\\[SubsPlease] Dandadan - 03 (1080p).mkv";
        seed_episode(&db, frieren, None, 0);
        seed_episode(&db, dandadan, None, 0);
        seed_episode(&db, kusuriya, None, 0);
        seed_episode(&db, pre_matched, Some(4224), 0);

        assert_eq!(db.match_unmatched_episodes_for_ids(&[]).unwrap(), 0);
        assert_eq!(
            db.match_unmatched_episodes_for_ids(&[154587, 171018]).unwrap(),
            2
        );
        assert_eq!(episode_state(&db, frieren).0, Some(154587));
        assert_eq!(episode_state(&db, frieren).1, 1);
        assert_eq!(episode_state(&db, dandadan).0, Some(171018));
        assert_eq!(episode_state(&db, kusuriya).0, None);
        // Files matched by their title are never looked at by targeted matching
        assert_eq!(episode_state(&db, pre_matched).0, Some(4224));

        assert_eq!(db.match_unmatched_episodes_for_anime(195516).unwrap(), 1);
        assert_eq!(episode_state(&db, kusuriya).0, Some(195516));
        assert_eq!(db.match_unmatched_episodes_for_anime(195516).unwrap(), 0);

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    const FSN: &str = "C:\\lib\\Fate\\Fate Stay Night";
    const UBW: &str = "C:\\lib\\Fate\\Fate Stay Night Unlimited Blade Works";
    const ZERO: &str = "C:\\lib\\Fate\\Fate Zero";

    fn fate_entries() -> Vec<crate::db::AnimeEntry> {
        let mut heavens_feel = entry(20791, 25537, "Fate/stay night [Heaven's Feel] I. presage flower", 1, 1);
        heavens_feel.synonyms = vec!["Fate/HF".into()];
        vec![
            entry(356, 356, "Fate/stay night", 24, 2),
            entry(19603, 22297, "Fate/stay night: Unlimited Blade Works", 13, 13),
            entry(20792, 28701, "Fate/stay night: Unlimited Blade Works 2nd Season", 13, 9),
            heavens_feel,
            entry(10087, 10087, "Fate/Zero", 13, 13),
            entry(11741, 11741, "Fate/Zero 2nd Season", 12, 12),
            entry(889, 889, "BLACK LAGOON", 12, 0),
            entry(1519, 1519, "BLACK LAGOON: The Second Barrage", 12, 0),
            entry(8440, 8440, "Black Lagoon Omake", 7, 0),
        ]
    }

    /// The library that showed the bugs: a folder whose path starts another folder's path, two seasons in
    /// one folder, a franchise folder linked to one movie, continuous numbering in a season subfolder.
    #[test]
    fn fate_and_black_lagoon_folders_resolve_to_their_own_anime() {
        let (db, tmp_dir) = rematch_fixture_db("tora_test_scanner_fate");
        db.upsert_anime_entries_batch(&fate_entries()).unwrap();
        link_folder(&db, 356, FSN);
        link_folder(&db, 19603, UBW);
        link_folder(&db, 20792, UBW);
        link_folder(&db, 20791, "C:\\lib\\Fate");
        link_folder(&db, 10087, ZERO);
        link_folder(&db, 889, "C:\\lib\\Black Lagoon");
        link_folder(&db, 1519, "C:\\lib\\Black Lagoon\\[02] Black Lagoon The Second Barrage");
        link_folder(&db, 8440, "C:\\lib\\Black Lagoon\\[03] Black Lagoon Omake");

        let file = |dir: &str, name: &str| format!("{}\\{}", dir, name);
        let fsn_01 = file(FSN, "[NSA-Team] Fate Stay Night - 01v2 [2897ED28].mkv");
        let fsn_13 = file(FSN, "[NSA-Team] Fate Stay Night - 13 [D1E79BBC].mkv");
        let fsn_24 = file(FSN, "[NSA-Team] Fate Stay Night - 24 Final [2F681C6F].mkv");
        let ubw_00 = file(UBW, "[AU-YnK] Fate stay night Unlimited Blade Works - 00 [BD 1080p] [D439D583] [v2].mkv");
        let ubw_12 = file(UBW, "[AU-YnK] Fate stay night Unlimited Blade Works - 12 [BD 1080p] [7224EC1A] [v2].mkv");
        let ubw2_01 = file(UBW, "[XMX] Fate Stay Night - Unlimited Blade Works - S02E01 Time of Departure [16cfaea2].mkv");
        let ubw2_13 = file(UBW, "[XMX] Fate Stay Night - Unlimited Blade Works - S02E13 Epilogue [7c1243ad].mkv");
        let zero_13 = file(ZERO, "[XMX] Fate Zero - S01E13 Forbidden Banquet [3df8f34b].mkv");
        let zero2_01 = file(ZERO, "[XMX] Fate Zero - S02E01 The Bloody Battle of Mion River [5e503bae].mkv");
        let lagoon_05 = "C:\\lib\\Black Lagoon\\[01] Black Lagoon\\(NSA)(80sTvSeries)Black Lagoon 05 - Aguilas cazadoras [BDrip by Josconcillo].mkv";
        let lagoon_13 = "C:\\lib\\Black Lagoon\\[02] Black Lagoon The Second Barrage\\(NSA)(80sTvSeries)Black Lagoon 13 - Llegan los vampiros mellizos [BDrip by Josconcillo].mkv";
        let omake_03 = "C:\\lib\\Black Lagoon\\[03] Black Lagoon Omake\\[poxitron] Black Lagoon - Omake 03 [BD 720p] [9930B392].mkv";
        let all = [
            fsn_01.as_str(), &fsn_13, &fsn_24, &ubw_00, &ubw_12, &ubw2_01, &ubw2_13, &zero_13, &zero2_01,
            lagoon_05, lagoon_13, omake_03,
        ];
        // As the old engine left them: everything on "Fate/stay night" / "BLACK LAGOON"
        for path in all {
            let old_owner = if path.contains("Black Lagoon") { 889 } else { 356 };
            seed_episode(&db, path, Some(old_owner), 0);
        }

        db.rematch_all_local_episodes().unwrap();

        assert_eq!(owner(&db, &fsn_01), (Some(356), Some(1)));
        assert_eq!(owner(&db, &fsn_13), (Some(356), Some(13)), "never a rule of another anime's title");
        assert_eq!(owner(&db, &fsn_24), (Some(356), Some(24)));
        assert_eq!(owner(&db, &ubw_00), (Some(19603), Some(0)));
        assert_eq!(owner(&db, &ubw_12), (Some(19603), Some(12)));
        assert_eq!(owner(&db, &ubw2_01), (Some(20792), Some(1)));
        assert_eq!(owner(&db, &ubw2_13), (Some(20792), Some(13)), "a valid episode is never redirected");
        assert_eq!(owner(&db, &zero_13), (Some(10087), Some(13)));
        assert_eq!(owner(&db, &zero2_01), (Some(11741), Some(1)), "the name says season 2");
        assert_eq!(owner(&db, lagoon_05), (Some(889), Some(5)));
        assert_eq!(owner(&db, lagoon_13), (Some(1519), Some(1)), "folder, then the relation by ID");
        assert_eq!(owner(&db, omake_03), (Some(8440), Some(3)));

        // Clearing the folder of the second season changes nothing: its files name it
        link_folder(&db, 20792, "");
        db.rematch_all_local_episodes().unwrap();
        assert_eq!(owner(&db, &ubw2_01), (Some(20792), Some(1)));
        assert_eq!(owner(&db, &ubw_12), (Some(19603), Some(12)));
        // ...and the scan links it again, to the folder it shares with the first season
        assert_eq!(folder_of(&db, 20792).as_deref(), Some(UBW));

        // The one-time repair drops the franchise folder linked to one movie
        let cleared = db.clear_contradicted_folder_links().unwrap();
        assert_eq!(cleared, vec![20791]);
        assert_eq!(folder_of(&db, 20791), None);
        assert_eq!(folder_of(&db, 356).as_deref(), Some(FSN));

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn fate_stay_night_without_its_entry_stays_unmatched() {
        let (db, tmp_dir) = rematch_fixture_db("tora_test_scanner_fate_ambiguous");
        let entries: Vec<_> = fate_entries().into_iter().filter(|e| e.id != 356).collect();
        db.upsert_anime_entries_batch(&entries).unwrap();
        let fsn_13 = format!("{}\\{}", FSN, "[NSA-Team] Fate Stay Night - 13 [D1E79BBC].mkv");
        seed_episode(&db, &fsn_13, None, 0);
        db.rematch_all_local_episodes().unwrap();
        // "fate stay night" starts both the Unlimited Blade Works and the Heaven's Feel titles
        assert_eq!(owner(&db, &fsn_13).0, None);

        let matcher = db.matcher_index().unwrap();
        assert_eq!(matcher.title_candidates("fate").first(), None);
        // An abbreviation with one reading still works
        assert_eq!(matcher.title_candidates("kusuriya").first(), Some(161645));
        assert_eq!(matcher.title_candidates("frieren").first(), Some(154587));

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn title_and_folder_disagreeing() {
        let (db, tmp_dir) = rematch_fixture_db("tora_test_scanner_title_vs_folder");
        db.upsert_anime_entries_batch(&[
            entry(9000001, 9000001, "Chihayafuru", 25, 0),
            entry(9000002, 9000002, "Chihayafuru 2", 25, 0),
            entry(9000003, 9000003, "CLANNAD", 23, 0),
            entry(9000004, 9000004, "CLANNAD: After Story", 24, 0),
            entry(9000005, 9000005, "Mawaru Penguindrum", 24, 0),
        ])
        .unwrap();
        link_folder(&db, 9000001, "C:\\lib\\Chihayafuru");
        link_folder(&db, 9000004, "C:\\lib\\Clannad\\Clannad ~After Story~");
        // Stored in another case: Windows paths ignore it, accents and `Ñ` included
        link_folder(&db, 9000005, "C:\\LIB\\ANIME ESPAÑOL\\PINGÜINO");

        let sequel = "C:\\lib\\Chihayafuru\\[Group] Chihayafuru 2 - 01 [720p].mkv";
        let short_name = "C:\\lib\\Clannad\\Clannad ~After Story~\\[Group] Clannad - 01 [720p].mkv";
        let spanish = "C:\\lib\\Anime Español\\Pingüino\\[AnimeID] Tambor Pinguino - 03 [720p].mkv";
        let numbered = "C:\\lib\\Anime Español\\Pingüino\\25 El destino.mkv";
        let sibling = "C:\\lib\\Anime Español\\Pingüino 2\\[AnimeID] Tambor Pinguino - 04 [720p].mkv";
        let next_season = "C:\\lib\\Chihayafuru\\[Group] Chihayafuru S3 - 02 [720p].mkv";
        for path in [sequel, short_name, spanish, numbered, sibling, next_season] {
            seed_episode(&db, path, None, 0);
        }
        db.rematch_all_local_episodes().unwrap();

        // The name is exactly another entry's title: the title wins over the folder
        assert_eq!(owner(&db, sequel), (Some(9000002), Some(1)));
        // The name is only a shorter form of the folder entry's title: the folder says more
        assert_eq!(owner(&db, short_name), (Some(9000004), Some(1)));
        assert_eq!(episode_state(&db, short_name).3.as_deref(), Some("folder"));
        // A title that names nothing belongs to the linked folder's anime
        assert_eq!(owner(&db, spanish), (Some(9000005), Some(3)));
        assert_eq!(episode_state(&db, spanish).3.as_deref(), Some("folder"));
        assert_eq!(owner(&db, numbered), (Some(9000005), None), "25 is past the last episode");
        // Whole path segments only
        assert_eq!(owner(&db, sibling).0, None);
        // Never a later season on another season's entry (the folder now holds seasons 1 and 2)
        assert_eq!(folder_of(&db, 9000002).as_deref(), Some("C:\\lib\\Chihayafuru"));
        assert_eq!(owner(&db, next_season).0, None);

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn folders_are_linked_from_files_never_from_loose_names() {
        let (db, tmp_dir) = rematch_fixture_db("tora_test_scanner_links");
        let mut chuunibyou = entry(9000101, 9000101, "Chuunibyou demo Koi ga Shitai!", 12, 0);
        chuunibyou.synonyms = vec!["Chu2".into()];
        db.upsert_anime_entries_batch(&[chuunibyou]).unwrap();

        let named = "C:\\lib\\Frieren\\[SubsPlease] Sousou no Frieren - 01 (1080p).mkv";
        let other_title = "C:\\lib\\Frieren\\[Fansub] El viaje de Frieren - 02.mkv";
        let numbered = "C:\\lib\\Frieren\\05 El heroe.mkv";
        let tool = "C:\\lib\\tools\\demo\\sample clip.mkv";
        let by_folder_name = "C:\\lib\\Dandadan\\[Fansub] Dan y Momo - 03.mkv";
        for path in [named, other_title, numbered, tool, by_folder_name] {
            seed_episode(&db, path, None, 0);
        }
        db.rematch_all_local_episodes().unwrap();

        // One file names the anime: its folder is linked, and the other files in it follow
        assert_eq!(folder_of(&db, 154587).as_deref(), Some("C:\\lib\\Frieren"));
        assert_eq!(owner(&db, named), (Some(154587), Some(1)));
        assert_eq!(owner(&db, other_title), (Some(154587), Some(2)));
        assert_eq!(owner(&db, numbered), (Some(154587), Some(5)), "a leading number is the episode");
        // A folder whose own name is exactly the title
        assert_eq!(owner(&db, by_folder_name), (Some(171018), Some(3)));
        assert_eq!(folder_of(&db, 171018).as_deref(), Some("C:\\lib\\Dandadan"));
        // "demo" is one word of a long title: no match, no link
        assert_eq!(owner(&db, tool).0, None);
        assert_eq!(folder_of(&db, 9000101), None);
        assert_eq!(db.matcher_index().unwrap().title_candidates("demo").first(), None);

        // Removing the link unmatches what only the link matched (nothing is remembered)
        link_folder(&db, 171018, "");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE anime_entries SET title_romaji = 'Renamed', normalized_titles_json = '[\"renamed\"]' WHERE id = 171018", [])
                .unwrap();
        }
        db.rematch_all_local_episodes().unwrap();
        assert_eq!(owner(&db, by_folder_name).0, None);

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn specials_guesses_and_season_folders() {
        let (db, tmp_dir) = rematch_fixture_db("tora_test_scanner_specials");
        let mut maidragon = entry(9000202, 9000202, "Kobayashi-san Chi no Maidragon", 13, 0);
        maidragon.synonyms = vec!["Kobayashi-san Chi no Maid Dragon".into()];
        let mut bisque = entry(9000205, 9000205, "Sono Bisque Doll wa Koi wo Suru Season 2", 12, 0);
        bisque.synonyms = vec!["Kisekoi 2".into()];
        let mut rozen = entry(9000213, 9000213, "Rozen Maiden", 12, 0);
        rozen.start_date = Some("2004-10-08".into());
        let mut rozen_2013 = entry(9000214, 9000214, "Rozen Maiden (2013)", 13, 0);
        rozen_2013.start_date = Some("2013-07-05".into());
        let mut kiss_x_sis = entry(9000215, 9000215, "kiss×sis", 12, 0);
        kiss_x_sis.format = "OVA".into();
        kiss_x_sis.synonyms = vec!["Kiss x Sis".into()];
        let mut oreimo = entry(9000216, 9000216, "Ore no Imouto ga Konna ni Kawaii Wake ga Nai", 12, 0);
        oreimo.synonyms = vec!["My Little Sister Can't Be This Cute".into()];
        db.upsert_anime_entries_batch(&[
            entry(9000201, 9000201, "Overlord II", 13, 0),
            maidragon,
            entry(9000203, 9000203, "Kobayashi-san Chi no Maidragon S", 12, 0),
            entry(9000204, 9000204, "Nisekoi", 20, 0),
            bisque,
            entry(9000206, 9000206, "Non Non Biyori", 12, 0),
            entry(9000207, 9000207, "Non Non Biyori Repeat", 12, 0),
            entry(9000208, 9000208, "Rozen Maiden: Träumend", 12, 0),
            entry(9000209, 9000209, "Sword Art Online", 25, 0),
            entry(9000210, 9000210, "Sword Art Online: Alicization - War of Underworld", 12, 0),
            entry(9000211, 9000211, "The World God Only Knows", 12, 0),
            entry(9000212, 9000212, "The World God Only Knows: Goddesses", 12, 0),
            rozen,
            rozen_2013,
            kiss_x_sis,
            oreimo,
        ])
        .unwrap();
        link_folder(&db, 9000211, "C:\\lib\\The World God Only Knows");
        // The third season, named after its arc, in a season folder inside the first season's folder
        let arc_episode = "C:\\lib\\The World God Only Knows\\Season 3\\[Vivid] The World God Only Knows - Goddesses Arc - 04 [BD 1080p FLAC] [3F411474].mkv";
        let arc_extra = "C:\\lib\\The World God Only Knows\\Season 3\\[Vivid] The World God Only Knows - Goddesses Arc - NCED 01 [BD 1080p FLAC] [E458B92A].mkv";
        seed_episode(&db, arc_episode, None, 0);
        seed_episode(&db, arc_extra, None, 0);

        let special = "C:\\lib\\Overlord II\\[RLSP] Overlord II - Especial 04 [BD 720p] [9D15C424].mkv";
        let episode = "C:\\lib\\Overlord II\\[RLSP] Overlord II - 04 [BD 720p] [11111111].mkv";
        let respelled = "C:\\lib\\[PuyaSubs!] Kobayashi-san Chi no Maid Dragon S - 03 [1080p][5262862C].mkv";
        let one_letter = "C:\\lib\\[Commie] Nisekoi 2 - 06 [BD 1080p AAC] [BC198265].mkv";
        let season_folder = "C:\\lib\\Non Non Biyori\\Season 2\\[AO] Non Non Biyori Repeat 01 [BD 1080p][9E769B37].mkv";
        let no_accent = "C:\\lib\\[Ayu]_Rozen_Maiden_-_Traumend_02_[24A3AD38].avi";
        let in_between = "C:\\lib\\[Group] Sword Art Online - Alicization - 05 [BD 720p] [0574F62D].mkv";
        let remake = "C:\\lib\\Rozen Maiden\\Season 3\\[Zaphod] Rozen Maiden (2013) - 01 [BDRip 1920x1080 x264 Hi10P FLAC].[7D15878E].mkv";
        let season_zero = "C:\\lib\\Sword Art Online\\Specials\\Sword Art Online - S00E10 - Sword Art Online Extra Edition.mkv";
        let between = "C:\\lib\\Overlord II\\[Commie] Overlord II - 5.5 [56CF43E1].mkv";
        let joined_words = "C:\\lib\\Oreimo\\[Commie] Ore no Imouto ga Konnani Kawaii Wake ga Nai. - My Little Sister Can't Be This Cute. - 01v2 [EAEEE2B8].mkv";
        let ova_entry = "C:\\lib\\Kiss x Sis\\[Tsundere] Kiss X Sis OVA - 01 [BDRip h264 1280x720 10bit FLAC][E712B9F5].mkv";
        for path in [
            special, episode, respelled, one_letter, season_folder, no_accent, in_between, remake, season_zero,
            ova_entry, between, joined_words,
        ] {
            seed_episode(&db, path, None, 0);
        }
        db.rematch_all_local_episodes().unwrap();

        // A special belongs to its anime but is not one of its episodes
        assert_eq!(owner(&db, special), (Some(9000201), None));
        assert_eq!(owner(&db, episode), (Some(9000201), Some(4)));
        // Another spelling of the sequel's title beats the first season's synonym it extends
        assert_eq!(owner(&db, respelled), (Some(9000203), Some(3)));
        // One changed letter in a short title is another anime ("Nisekoi 2" is not "Kisekoi 2")
        assert_eq!(owner(&db, one_letter).0, None);
        // The folder's season is not added to a name that already is the sequel's title
        assert_eq!(owner(&db, season_folder), (Some(9000207), Some(1)));
        assert_eq!(owner(&db, no_accent), (Some(9000208), Some(2)));
        // A name between two list titles (longer than one, shorter than the other) is neither
        assert_eq!(owner(&db, in_between).0, None);
        // The folder says season 3: never the first season's entry, the arc's own entry instead
        assert_eq!(owner(&db, arc_episode), (Some(9000212), Some(4)));
        assert_eq!(owner(&db, arc_extra), (Some(9000212), None));
        // The year picks the remake also when the season came from a folder
        assert_eq!(owner(&db, remake), (Some(9000214), Some(1)));
        // Season 0 holds specials: the anime, no episode of the series
        assert_eq!(owner(&db, season_zero), (Some(9000209), None));
        // "Konnani" is "Konna ni" written together, and the rest is the English title: an episode, no special
        assert_eq!(owner(&db, joined_words), (Some(9000216), Some(1)));
        // "5.5" is found as episode 5 would be, then is an extra
        assert_eq!(owner(&db, between), (Some(9000201), None));
        // An entry that is itself the OVA keeps the episode numbers of "OVA - 01"
        assert_eq!(owner(&db, ova_entry), (Some(9000215), Some(1)));

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
