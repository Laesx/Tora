pub mod db;
pub mod detection;
pub mod library;
pub mod plugins;
pub mod sync;
pub mod torrents;

use crate::db::{
    AnimeEntry, AppSettings, BatchAnimeUpdatePatch, CachedSeason, CustomListChange,
    CustomListsState, Database, LibraryFolder, ListStats,
    LocalEpisodeFile, SettingsBackupInfo, WatchHistoryEntry,
};
use crate::detection::anisthesia::{detect_active_media_player, DetectedMediaSession};
use crate::detection::anitomy::{parse_filename, AnitomyElements};
use crate::library::scanner::{DriveStorageSummary, LibraryMonitorHandle, ScanSummary};
use crate::plugins::{PluginManager, SeasonalAnime, TrackerPluginDescriptor, TrackerUserProfile};
use crate::sync::{
    AiringScheduleResult, ChangeSource, SeasonResult, SignOutOutcome, SyncEmitter, SyncStatus, SyncSummary,
    TrackerSyncService, UserStateChange,
};
use crate::torrents::board::TorrentBoard;
use crate::torrents::client::DetectedApp;
use crate::torrents::config::{
    BoardOptions, FansubOverride, PriorityConfig, SearchFeed, TorrentFeed, TorrentFilter,
};
use crate::torrents::query::{ParsedQuery, Query};
use crate::torrents::{BoardSource, DownloadRequest, DownloadSummary, TorrentCache};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct AppState {
    pub db: Arc<Database>,
    pub plugins: Arc<PluginManager>,
    pub monitor: LibraryMonitorHandle,
    pub active_session: Arc<Mutex<Option<DetectedMediaSession>>>,
    pub oauth_listener_active: Arc<AtomicBool>,
    /// Single owner of user-list mutations and AniList push/pull.
    pub sync: Arc<TrackerSyncService>,
    /// `Database::matcher_generation` at the last match attempt for the active (unmatched) session.
    /// A continuing unmatched session is only re-matched once the matcher data changed since then.
    pub unmatched_check_generation: AtomicU64,
    /// RAM cache of fetched torrent feeds + releases sent this session.
    pub torrents: Arc<TorrentCache>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilenameTestResult {
    pub parsed: AnitomyElements,
    pub matched_anime_id: Option<i64>,
    pub matched_anime_title: Option<String>,
    pub matched_cover_image: Option<String>,
}

#[tauri::command]
async fn get_anime_list(state: State<'_, AppState>) -> Result<Vec<AnimeEntry>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.list_anime_entries())
        .await
        .map_err(|e| e.to_string())?
}

/// Only these entries (ids that no longer exist are skipped); used to apply scan / scrobble deltas.
#[tauri::command]
async fn get_anime_entries(state: State<'_, AppState>, ids: Vec<i64>) -> Result<Vec<AnimeEntry>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.get_anime_entries_by_ids(&ids))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn update_anime_entry(
    state: State<'_, AppState>,
    anime_id: i64,
    user_status: String,
    user_progress: u32,
    user_score: f64,
    user_repeats: u32,
    user_notes: String,
    custom_folder: Option<String>,
    synonyms: Option<Vec<String>>,
    user_started_at: Option<String>,
    user_completed_at: Option<String>,
) -> Result<AnimeEntry, String> {
    // The sync service validates, derives status/dates, writes SQLite, refreshes the active playback
    // session and pushes to AniList in the background.
    state
        .sync
        .apply_local_update(UserStateChange {
            status: Some(user_status),
            progress: Some(user_progress),
            score: Some(user_score),
            repeats: Some(user_repeats),
            notes: Some(user_notes),
            started_at: user_started_at,
            completed_at: user_completed_at,
            custom_folder: Some(custom_folder),
            synonyms,
            ..UserStateChange::new(anime_id, ChangeSource::Manual)
        })
        .await
}

#[tauri::command]
async fn batch_update_anime_entries(
    state: State<'_, AppState>,
    patch: BatchAnimeUpdatePatch,
) -> Result<Vec<AnimeEntry>, String> {
    state.sync.apply_batch(patch).await
}

#[tauri::command]
async fn get_custom_lists(state: State<'_, AppState>) -> Result<CustomListsState, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.get_custom_lists())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_anime_custom_lists(
    state: State<'_, AppState>,
    change: CustomListChange,
) -> Result<CustomListsState, String> {
    state.sync.set_custom_lists(change).await
}

#[tauri::command]
async fn create_custom_list(
    state: State<'_, AppState>,
    name: String,
) -> Result<CustomListsState, String> {
    state.sync.create_custom_list(name).await
}

#[tauri::command]
async fn delete_custom_list(
    state: State<'_, AppState>,
    name: String,
) -> Result<CustomListsState, String> {
    state.sync.delete_custom_list(name).await
}

#[tauri::command]
async fn batch_delete_anime_entries(
    state: State<'_, AppState>,
    anime_ids: Vec<i64>,
) -> Result<(), String> {
    state.sync.delete_entries(anime_ids).await
}

#[tauri::command]
async fn add_or_upsert_anime(
    state: State<'_, AppState>,
    entry: AnimeEntry,
) -> Result<AnimeEntry, String> {
    state.sync.add_entry(entry).await
}

#[tauri::command]
async fn delete_anime_entry(
    state: State<'_, AppState>,
    anime_id: i64,
) -> Result<(), String> {
    state.sync.delete_entries(vec![anime_id]).await
}

#[tauri::command]
async fn get_tracker_plugins(state: State<'_, AppState>) -> Result<Vec<TrackerPluginDescriptor>, String> {
    Ok(state.plugins.list_descriptors())
}

#[tauri::command]
async fn verify_tracker_account(
    state: State<'_, AppState>,
    plugin_id: String,
    username: String,
    token: Option<String>,
) -> Result<TrackerUserProfile, String> {
    let plugin = state
        .plugins
        .get(&plugin_id)
        .ok_or_else(|| "Tracker plugin not found".to_string())?;
    let token = token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "AniList sign-in requires an OAuth access token".to_string())?;
    let profile = plugin.verify_account(&username, Some(&token)).await?;

    // Same owner: just refreshes the stored profile. A different account wipes the previous one's list.
    let outcome = state.sync.sign_in(&token, &profile).await?;
    if outcome.account_switched {
        let sync = state.sync.clone();
        tauri::async_runtime::spawn(async move {
            let _ = sync.pull("post_auth").await;
        });
    }

    Ok(profile)
}

#[tauri::command]
async fn sync_tracker_list(state: State<'_, AppState>) -> Result<SyncSummary, String> {
    state.sync.pull("manual").await
}

#[tauri::command]
async fn get_sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let sync = state.sync.clone();
    tokio::task::spawn_blocking(move || sync.status())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_remote_anime(
    state: State<'_, AppState>,
    query: String,
    season: Option<String>,
    year: Option<u32>,
) -> Result<Vec<AnimeEntry>, String> {
    let db = state.db.clone();
    let settings = tokio::task::spawn_blocking(move || db.get_settings())
        .await
        .map_err(|e| e.to_string())??;
    let plugin = state
        .plugins
        .get(&settings.active_tracker_plugin)
        .ok_or_else(|| "Tracker plugin not found".to_string())?;
    plugin
        .search_anime(&query, season.as_deref(), year)
        .await
}

#[tauri::command]
async fn get_season(
    state: State<'_, AppState>,
    season: String,
    year: u32,
    force_refresh: bool,
) -> Result<SeasonResult, String> {
    state.sync.fetch_season(&season, year, force_refresh).await
}

#[tauri::command]
async fn get_airing_schedule(
    state: State<'_, AppState>,
    from: i64,
    to: i64,
    force_refresh: bool,
) -> Result<AiringScheduleResult, String> {
    state.sync.fetch_airing_schedule(from, to, force_refresh).await
}

#[tauri::command]
async fn list_cached_seasons(state: State<'_, AppState>) -> Result<Vec<CachedSeason>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.list_cached_seasons())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_library_folders(state: State<'_, AppState>) -> Result<Vec<LibraryFolder>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.list_library_folders())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_library_folder(
    state: State<'_, AppState>,
    path: String,
    label: Option<String>,
) -> Result<Vec<LibraryFolder>, String> {
    let db = state.db.clone();
    let monitor = state.monitor.clone();
    tokio::task::spawn_blocking(move || {
        db.add_library_folder(&path, label)?;
        let _ = db.scan_all_library_folders();
        monitor.reload();
        db.list_library_folders()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_library_folder(
    state: State<'_, AppState>,
    folder_id: i64,
) -> Result<Vec<LibraryFolder>, String> {
    let db = state.db.clone();
    let monitor = state.monitor.clone();
    tokio::task::spawn_blocking(move || {
        let folders = db.remove_library_folder(folder_id)?;
        monitor.reload();
        Ok(folders)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_drive_summaries(state: State<'_, AppState>) -> Result<Vec<DriveStorageSummary>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.list_drive_summaries())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_library(state: State<'_, AppState>) -> Result<ScanSummary, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.scan_all_library_folders())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn quick_scan_library(state: State<'_, AppState>) -> Result<ScanSummary, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.quick_scan_library_folders())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_local_episodes(
    state: State<'_, AppState>,
    anime_id: Option<i64>,
) -> Result<Vec<LocalEpisodeFile>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.list_local_episodes(anime_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn bind_title_alias(
    state: State<'_, AppState>,
    normalized_alias: String,
    anime_id: i64,
) -> Result<usize, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.bind_title_alias(&normalized_alias, anime_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn play_episode_file(state: State<'_, AppState>, file_path: String) -> Result<String, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let settings = db.get_settings()?;
        let custom_player = settings.custom_media_player_path.trim();

        if !custom_player.is_empty() {
            Command::new(custom_player)
                .arg(&file_path)
                .spawn()
                .map_err(|e| format!("Failed to launch custom media player: {}", e))?;
        } else if let Err(e) = tauri_plugin_opener::open_path(&file_path, None::<&str>) {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                Command::new("cmd")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(["/C", "start", "", &file_path])
                    .spawn()
                    .map_err(|err| format!("Failed to open file with system player: {} (opener error: {})", err, e))?;
            }
            #[cfg(not(windows))]
            {
                return Err(format!("Failed to open file with system player: {}", e));
            }
        }

        Ok(format!("Playing {}", file_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn reveal_in_explorer(file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&file_path);

        // If it's a directory, open the directory itself
        if p.is_dir() {
            #[cfg(windows)]
            {
                if tauri_plugin_opener::open_path(p, None::<&str>).is_ok() {
                    return Ok(());
                }
                let clean = file_path.replace('/', "\\");
                Command::new("explorer.exe")
                    .arg(&clean)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            #[cfg(not(windows))]
            {
                return tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| e.to_string());
            }
        }

        // If it's a file, reveal and select it in its parent directory
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;

            if p.exists() {
                // First try native Shell API via tauri_plugin_opener (SHOpenFolderAndSelectItems)
                if tauri_plugin_opener::reveal_item_in_dir(p).is_ok() {
                    return Ok(());
                }

                // Fallback to explorer.exe /select,"<path>" using raw_arg so Rust doesn't quote /select
                let clean = file_path.replace('/', "\\");
                Command::new("explorer.exe")
                    .raw_arg(format!("/select,\"{}\"", clean))
                    .spawn()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            } else if let Some(parent) = p.parent().filter(|par| par.exists()) {
                // If the file was moved or deleted, fall back to opening its containing directory
                if tauri_plugin_opener::open_path(parent, None::<&str>).is_ok() {
                    return Ok(());
                }
                let clean = parent.to_string_lossy().replace('/', "\\");
                Command::new("explorer.exe")
                    .arg(&clean)
                    .spawn()
                    .map_err(|e| e.to_string())?;
                return Ok(());
            } else {
                return Err(format!("Path does not exist: {}", file_path));
            }
        }

        #[cfg(not(windows))]
        {
            if p.exists() {
                tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
            } else if let Some(parent) = p.parent().filter(|par| par.exists()) {
                tauri_plugin_opener::open_path(parent, None::<&str>).map_err(|e| e.to_string())
            } else {
                Err(format!("Path does not exist: {}", file_path))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_demo_library_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanSummary, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db = state.db.clone();
    let monitor = state.monitor.clone();

    tokio::task::spawn_blocking(move || {
        let demo_drive_a = app_dir.join("DemoLibrary_DriveA_Seasonal");
        let demo_drive_b = app_dir.join("DemoLibrary_DriveB_Archive");

        std::fs::create_dir_all(&demo_drive_a).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&demo_drive_b).map_err(|e| e.to_string())?;

        let sample_files_a = [
            "[SubsPlease] Sousou no Frieren - 24 (1080p) [F02B9C1A].mkv",
            "[SubsPlease] Sousou no Frieren - 25 (1080p) [A12B3C4D].mkv",
            "[SubsPlease] Sousou no Frieren - 26 (1080p) [B23C4D5E].mkv",
            "[SubsPlease] Sousou no Frieren - 27 (1080p) [C34D5E6F].mkv",
            "[SubsPlease] Sousou no Frieren - 28 (1080p) [D45E6F70].mkv",
            "[Erai-raws] Dandadan - 07 [1080p][HEVC 10bit][Multiple Subtitle][11223344].mkv",
            "[Erai-raws] Dandadan - 08 [1080p][HEVC 10bit][Multiple Subtitle][55667788].mkv",
            "[Erai-raws] Dandadan - 09 [1080p][HEVC 10bit][Multiple Subtitle][99AABBCC].mkv",
            "[SubsPlease] Dungeon Meshi - 18 (1080p) [AABBCCDD].mkv",
            "[SubsPlease] Dungeon Meshi - 19 (1080p) [BBCCDDEE].mkv",
            "[SubsPlease] Dungeon Meshi - 20 (1080p) [CCDDEEFF].mkv",
        ];

        let sample_files_b = [
            "[EMBER] Bocchi the Rock! - S01E11 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
            "[EMBER] Bocchi the Rock! - S01E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
            "[Judas] Kusuriya no Hitorigoto - 23 [1080p][HEVC x265 10bit].mkv",
            "[Judas] Kusuriya no Hitorigoto - 24 [1080p][HEVC x265 10bit].mkv",
            "[Coalgirls] Toradora! - 01 (1920x1080 Blu-ray FLAC) [1234ABCD].mkv",
            "[Coalgirls] Toradora! - 25 (1920x1080 Blu-ray FLAC) [ABCD1234].mkv",
        ];

        for name in &sample_files_a {
            let p = demo_drive_a.join(name);
            if !p.exists() {
                std::fs::write(&p, b"TORA_DEMO_MEDIA_STREAM").map_err(|e| e.to_string())?;
            }
        }
        for name in &sample_files_b {
            let p = demo_drive_b.join(name);
            if !p.exists() {
                std::fs::write(&p, b"TORA_DEMO_MEDIA_STREAM").map_err(|e| e.to_string())?;
            }
        }

        db.add_library_folder(
            &demo_drive_a.to_string_lossy(),
            Some("Seasonal Anime (Demo Folder A)".into()),
        )?;
        db.add_library_folder(
            &demo_drive_b.to_string_lossy(),
            Some("BD Archive (Demo Folder B)".into()),
        )?;

        let summary = db.scan_all_library_folders()?;
        monitor.reload();
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn test_parse_filename(
    state: State<'_, AppState>,
    input: String,
) -> Result<FilenameTestResult, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let mut parsed = parse_filename(&input);
        let matched = db.match_episode_to_anime(&mut parsed, None);
        let (matched_anime_id, matched_anime_title, matched_cover_image) = match matched {
            Some((id, title, cover, _, _)) => (Some(id), Some(title), Some(cover)),
            None => (None, None, None),
        };
        Ok(FilenameTestResult {
            parsed,
            matched_anime_id,
            matched_anime_title,
            matched_cover_image,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn dismiss_playback_session(state: State<'_, AppState>) -> Result<(), String> {
    *state.active_session.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// A scrobble decided under the `active_session` lock and executed after it is released:
/// `(anime_id, episode, title, player_name, cleaned_media_title)`.
type PendingScrobble = (i64, u32, String, String, String);

#[tauri::command]
async fn poll_media_recognition(
    state: State<'_, AppState>,
) -> Result<Option<DetectedMediaSession>, String> {
    let db = state.db.clone();
    let settings = tokio::task::spawn_blocking(move || db.get_settings())
        .await
        .map_err(|e| e.to_string())??;
    if !settings.recognition_enabled {
        let mut active = state.active_session.lock().map_err(|e| e.to_string())?;
        *active = None;
        return Ok(None);
    }

    let now = chrono::Utc::now().timestamp();
    let players = settings.players.clone();

    // Run Win32 window enumeration on blocking pool so main thread is never touched
    let detected_candidate = tokio::task::spawn_blocking(move || {
        detect_active_media_player(&players).map(|(player, win, cleaned, parsed)| {
            (
                player.id,
                player.name,
                win.process_id,
                win.exe_path,
                win.window_title,
                cleaned,
                parsed,
            )
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some((player_id, player_name, pid, exe_path, raw_title, cleaned_title, parsed)) =
        detected_candidate
    else {
        *state.active_session.lock().map_err(|e| e.to_string())? = None;
        return Ok(None);
    };

    let is_same_session = |s: &DetectedMediaSession| {
        s.cleaned_media_title == cleaned_title && s.player_name == player_name
    };

    // Snapshot the continuing session (if any). DB work happens without holding the lock.
    let continuing: Option<(Option<i64>, AnitomyElements)> = {
        let guard = state.active_session.lock().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .filter(|s| is_same_session(s))
            .map(|s| (s.matched_anime_id, s.parsed.clone()))
    };

    let Some((snapshot_matched_id, mut session_parsed)) = continuing else {
        // New playback session detected
        let db = state.db.clone();
        let (parsed, matched, generation) = tokio::task::spawn_blocking(move || {
            let mut parsed = parsed;
            // Read before matching: a change that lands meanwhile triggers one more attempt later.
            let generation = db.matcher_generation();
            let matched = db.match_episode_to_anime(&mut parsed, None);
            (parsed, matched, generation)
        })
        .await
        .map_err(|e| e.to_string())?;
        state
            .unmatched_check_generation
            .store(generation, Ordering::SeqCst);
        let (
            matched_anime_id,
            matched_anime_title,
            matched_cover_image,
            matched_current_progress,
            matched_total_episodes,
        ) = match matched {
            Some((id, title, cover, prog, total)) => {
                (Some(id), Some(title), Some(cover), Some(prog), total)
            }
            None => (None, None, None, None, None),
        };

        let new_session = DetectedMediaSession {
            player_id,
            player_name,
            process_id: pid,
            executable_path: exe_path,
            raw_window_title: raw_title,
            cleaned_media_title: cleaned_title,
            parsed,
            matched_anime_id,
            matched_anime_title,
            matched_cover_image,
            matched_current_progress,
            matched_total_episodes,
            detected_at_unix: now,
            elapsed_seconds: 0,
            auto_synced: false,
        };

        *state.active_session.lock().map_err(|e| e.to_string())? = Some(new_session.clone());
        return Ok(Some(new_session));
    };

    // Same session continuing: re-check an unmatched session (the user may have just added the anime or
    // bound an alias) and load the matched entry's current progress, off the async worker.
    // Only re-run matching when the matcher data (entries / aliases) changed since the last attempt.
    let db = state.db.clone();
    let last_checked_generation = state.unmatched_check_generation.load(Ordering::SeqCst);
    let (rematch, entry, checked_generation) = tokio::task::spawn_blocking(move || {
        let generation = db.matcher_generation();
        let mut checked_generation = None;
        let rematch = if snapshot_matched_id.is_none() && generation != last_checked_generation {
            checked_generation = Some(generation);
            db.match_episode_to_anime(&mut session_parsed, None)
                .map(|m| (m, session_parsed))
        } else {
            None
        };
        let aid = snapshot_matched_id.or_else(|| rematch.as_ref().map(|(m, _)| m.0));
        let entry = aid.and_then(|id| db.get_anime_entry_by_id(id).ok());
        (rematch, entry, checked_generation)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Under the lock: update countdown state and only DECIDE whether to scrobble.
    let mut scrobble: Option<PendingScrobble> = None;
    let session_now = {
        let mut guard = state.active_session.lock().map_err(|e| e.to_string())?;
        let Some(existing) = guard.as_mut().filter(|s| is_same_session(s)) else {
            // The session changed while we were querying; report whatever is current.
            return Ok(guard.clone());
        };
        if let Some(generation) = checked_generation {
            state
                .unmatched_check_generation
                .store(generation, Ordering::SeqCst);
        }

        if existing.matched_anime_id.is_none() {
            if let Some(((id, title, cover, prog, total), new_parsed)) = rematch {
                existing.parsed = new_parsed;
                existing.matched_anime_id = Some(id);
                existing.matched_anime_title = Some(title);
                existing.matched_cover_image = Some(cover);
                existing.matched_current_progress = Some(prog);
                existing.matched_total_episodes = total;
                existing.detected_at_unix = now;
                existing.elapsed_seconds = 0;
                existing.auto_synced = false;
            }
        }

        if let Some(aid) = existing.matched_anime_id {
            // Ignore the loaded entry if the match changed concurrently (e.g. linked meanwhile).
            let entry = entry.filter(|e| e.id == aid);
            if let Some(entry) = entry.as_ref() {
                existing.matched_current_progress = Some(entry.user_progress);
                existing.matched_total_episodes = entry.episodes;
            }

            let is_already_seen = match (
                existing.parsed.episode_number,
                existing.matched_current_progress,
            ) {
                (Some(ep), Some(cur_prog)) => ep <= cur_prog,
                _ => false,
            };

            if !existing.auto_synced && is_already_seen {
                // If the currently detected episode is the last one seen (or earlier),
                // do not count down or auto-update progress.
                existing.elapsed_seconds = 0;
            } else {
                existing.elapsed_seconds = (now - existing.detected_at_unix).max(0) as u64;

                // Only auto-update when matched to an anime entry and delay threshold is met
                if !existing.auto_synced
                    && existing.elapsed_seconds >= settings.recognition_delay_seconds
                {
                    if let Some(entry) = entry.as_ref() {
                        existing.auto_synced = true;
                        if let Some(ep) = existing.parsed.episode_number {
                            if ep > entry.user_progress {
                                scrobble = Some((
                                    aid,
                                    ep,
                                    existing
                                        .matched_anime_title
                                        .clone()
                                        .unwrap_or_else(|| existing.parsed.anime_title.clone()),
                                    existing.player_name.clone(),
                                    existing.cleaned_media_title.clone(),
                                ));
                            }
                        }
                    }
                }
            }
        } else {
            existing.elapsed_seconds = 0;
            existing.auto_synced = false;
        }

        existing.clone()
    }; // active_session lock released here: never held across an `.await`.

    let Some((aid, ep, title, player, file)) = scrobble else {
        return Ok(Some(session_now));
    };

    // Record the watch as not-yet-scrobbled; the sync service marks it scrobbled once AniList accepts it.
    let db = state.db.clone();
    let history_id = tokio::task::spawn_blocking(move || {
        db.record_watch_history(Some(aid), &title, ep, &player, &file, false)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| eprintln!("[scrobble] failed to record watch history: {}", e))
    .ok();

    // The service derives status (PLANNING -> CURRENT, COMPLETED at total) and dates, writes SQLite,
    // refreshes `active_session.matched_current_progress` and pushes to AniList in the background.
    let change = UserStateChange {
        progress: Some(ep),
        ..UserStateChange::new(aid, ChangeSource::Scrobble)
    };
    if let Err(e) = state
        .sync
        .apply_local_update_with_history(change, history_id)
        .await
    {
        eprintln!("[scrobble] failed to update anime {}: {}", aid, e);
    }

    let current = state.active_session.lock().map_err(|e| e.to_string())?.clone();
    Ok(current)
}

#[tauri::command]
async fn link_detected_episode_to_anime(
    state: State<'_, AppState>,
    anime_id: i64,
    alias_title: String,
) -> Result<Option<DetectedMediaSession>, String> {
    let db = state.db.clone();
    let entry = tokio::task::spawn_blocking(move || db.link_alias_to_anime(anime_id, &alias_title))
        .await
        .map_err(|e| e.to_string())??;

    let now = chrono::Utc::now().timestamp();
    let mut active_guard = state.active_session.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = active_guard.as_mut() {
        existing.matched_anime_id = Some(entry.id);
        existing.matched_anime_title = Some(entry.title_romaji.clone());
        existing.matched_cover_image = Some(entry.cover_image.clone());
        existing.matched_current_progress = Some(entry.user_progress);
        existing.matched_total_episodes = entry.episodes;
        existing.detected_at_unix = now;
        existing.elapsed_seconds = 0;
        existing.auto_synced = false;
        return Ok(Some(existing.clone()));
    }
    Ok(None)
}

#[tauri::command]
async fn get_watch_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<WatchHistoryEntry>, String> {
    let db = state.db.clone();
    let (limit, offset) = (limit.unwrap_or(100).min(500), offset.unwrap_or(0));
    tokio::task::spawn_blocking(move || db.list_watch_history(limit, offset))
        .await
        .map_err(|e| e.to_string())?
}

/// Episodes watched (scrobbled or logged manually) in the last 7 days and the 7 days before.
#[derive(Debug, Clone, Serialize)]
struct WatchStats {
    episodes_last_week: u32,
    minutes_last_week: u32,
    episodes_prev_week: u32,
}

#[tauri::command]
async fn get_watch_stats(state: State<'_, AppState>) -> Result<WatchStats, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let now = chrono::Utc::now().timestamp();
        let week = 7 * 24 * 60 * 60;
        let (episodes_last_week, minutes_last_week) = db.watch_history_totals(now - week, now + 1)?;
        let (episodes_prev_week, _) = db.watch_history_totals(now - 2 * week, now - week)?;
        Ok(WatchStats {
            episodes_last_week,
            minutes_last_week,
            episodes_prev_week,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List, activity and backlog numbers for the Stats tab (activity covers the last 366 days).
#[tauri::command]
async fn get_stats(state: State<'_, AppState>) -> Result<ListStats, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let since = chrono::Utc::now().timestamp() - 366 * 24 * 60 * 60;
        db.list_stats(since)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
struct AppInfo {
    data_dir: String,
    db_path: String,
    /// Database file plus its WAL.
    db_size_bytes: u64,
}

/// Where Tora keeps its data (Settings → About).
#[tauri::command]
async fn get_app_info(app: tauri::AppHandle) -> Result<AppInfo, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let db_path = data_dir.join("tora_library.db");
        let size = |p: std::path::PathBuf| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        Ok(AppInfo {
            data_dir: data_dir.to_string_lossy().into_owned(),
            db_path: db_path.to_string_lossy().into_owned(),
            db_size_bytes: size(db_path.clone()) + size(data_dir.join("tora_library.db-wal")),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tags, studios, rankings etc. of one media. Served from `media_metadata`; fetched once if missing.
#[tauri::command]
async fn get_media_metadata(
    state: State<'_, AppState>,
    anilist_id: i64,
) -> Result<Option<SeasonalAnime>, String> {
    state.sync.media_metadata(anilist_id).await
}

#[tauri::command]
async fn get_torrent_board(
    state: State<'_, AppState>,
    source: BoardSource,
    force: Option<bool>,
) -> Result<TorrentBoard, String> {
    torrents::get_board(state.db.clone(), state.torrents.clone(), source, force.unwrap_or(false)).await
}

#[tauri::command]
async fn download_releases(
    state: State<'_, AppState>,
    releases: Vec<DownloadRequest>,
) -> Result<DownloadSummary, String> {
    torrents::download_releases(state.db.clone(), state.torrents.clone(), releases).await
}

#[tauri::command]
async fn get_torrent_feeds(state: State<'_, AppState>) -> Result<Vec<TorrentFeed>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::load_feeds(&db))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_torrent_feeds(
    state: State<'_, AppState>,
    feeds: Vec<TorrentFeed>,
) -> Result<Vec<TorrentFeed>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::save_feeds(&db, feeds))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_torrent_search_feeds(state: State<'_, AppState>) -> Result<Vec<SearchFeed>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::load_search_feeds(&db))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_torrent_search_feeds(
    state: State<'_, AppState>,
    feeds: Vec<SearchFeed>,
) -> Result<Vec<SearchFeed>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::save_search_feeds(&db, feeds))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_torrent_filters(state: State<'_, AppState>) -> Result<Vec<TorrentFilter>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::load_filters(&db))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_torrent_filters(
    state: State<'_, AppState>,
    filters: Vec<TorrentFilter>,
) -> Result<Vec<TorrentFilter>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::save_filters(&db, filters))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_torrent_priority(state: State<'_, AppState>) -> Result<PriorityConfig, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::load_priority(&db))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_torrent_priority(
    state: State<'_, AppState>,
    priority: PriorityConfig,
) -> Result<PriorityConfig, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::save_priority(&db, priority))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_torrent_fansubs(state: State<'_, AppState>) -> Result<Vec<FansubOverride>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::load_fansubs(&db))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_anime_fansubs(
    state: State<'_, AppState>,
    anime_id: i64,
    groups: Vec<String>,
) -> Result<Vec<FansubOverride>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::set_anime_fansubs(&db, anime_id, groups))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_torrent_board_options(state: State<'_, AppState>) -> Result<BoardOptions, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::load_board_options(&db))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_torrent_board_options(
    state: State<'_, AppState>,
    options: BoardOptions,
) -> Result<BoardOptions, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || torrents::config::save_board_options(&db, options))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn parse_torrent_query(query: String) -> Result<ParsedQuery, String> {
    Query::parse(&query).map(|q| ParsedQuery::from(&q))
}

#[tauri::command]
async fn detect_torrent_app(custom_path: Option<String>) -> Result<DetectedApp, String> {
    tokio::task::spawn_blocking(move || torrents::client::detect_app(custom_path.as_deref().unwrap_or("")))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_settings_backups(state: State<'_, AppState>) -> Result<Vec<SettingsBackupInfo>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.list_settings_backups())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn backup_settings_now(state: State<'_, AppState>) -> Result<Vec<SettingsBackupInfo>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db.backup_settings_now()?;
        db.list_settings_backups()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn restore_settings_backup(
    state: State<'_, AppState>,
    file_name: String,
) -> Result<AppSettings, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.restore_settings_backup(&file_name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.get_settings())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_app_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let db = state.db.clone();
    let monitor = state.monitor.clone();
    tokio::task::spawn_blocking(move || {
        let previous_folder = db.get_settings().map(|s| s.torrent_download_folder).unwrap_or_default();
        db.save_settings(&settings)?;
        let folder = settings.torrent_download_folder.trim();
        if !folder.is_empty() && !folder.eq_ignore_ascii_case(previous_folder.trim()) {
            ensure_library_folder(&db, &monitor, folder);
        }
        db.get_settings()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adds `folder` as a library folder (and starts watching it) unless an enabled library folder already
/// contains it, so files downloaded there are indexed and matched.
fn ensure_library_folder(db: &Database, monitor: &LibraryMonitorHandle, folder: &str) {
    let norm = |p: &str| p.trim().trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
    let target = norm(folder);
    let covered = db.list_library_folders().unwrap_or_default().iter().any(|f| {
        let root = norm(&f.path);
        f.enabled && (target == root || target.starts_with(&format!("{}\\", root)))
    });
    if covered {
        return;
    }
    match db.add_library_folder(folder, None) {
        Ok(_) => {
            let _ = db.quick_scan_library_folders();
            monitor.reload();
        }
        Err(e) => eprintln!("[torrents] couldn't add the download folder to the library: {}", e),
    }
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    if tauri_plugin_opener::open_url(&url, None::<&str>).is_ok() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn sign_out_tracker(state: State<'_, AppState>) -> Result<SignOutOutcome, String> {
    state.sync.sign_out().await
}

const OAUTH_CALLBACK_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tora — AniList Authorization</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0c0e14;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      background: #141824;
      border: 1px solid #262d40;
      border-radius: 18px;
      padding: 32px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    }
    .logo {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      background: linear-gradient(135deg, #f59e0b, #ea580c);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 24px;
      color: #fff;
      margin-bottom: 16px;
      box-shadow: 0 6px 20px rgba(245, 158, 11, 0.35);
    }
    h1 { font-size: 18px; font-weight: 800; margin-bottom: 8px; }
    p { font-size: 13px; color: #94a3b8; line-height: 1.5; }
    .avatar {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      object-fit: cover;
      border: 2px solid #f59e0b;
      margin: 14px auto 8px;
      display: none;
    }
    .badge {
      display: inline-block;
      margin-top: 16px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .error {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.3);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">虎</div>
    <img id="avatar" class="avatar" alt="Avatar" />
    <h1 id="title">Connecting to Tora...</h1>
    <p id="desc">Completing AniList authorization, please wait a moment.</p>
    <div id="status" class="badge">Verifying OAuth Token...</div>
  </div>
  <script>
    (async function() {
      const titleEl = document.getElementById("title");
      const descEl = document.getElementById("desc");
      const statusEl = document.getElementById("status");
      const avatarEl = document.getElementById("avatar");

      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const queryParams = new URLSearchParams(window.location.search);
      const token = hashParams.get("access_token") || queryParams.get("access_token");

      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", "/AniSync/authCallback");
      }

      if (!token) {
        titleEl.textContent = "Authorization Incomplete";
        descEl.textContent = "No AniList access token was found in the callback URL. Please click the Sign In banner inside Tora and try again.";
        statusEl.textContent = "Missing Token";
        statusEl.className = "badge error";
        return;
      }

      try {
        const res = await fetch("/AniSync/token?access_token=" + encodeURIComponent(token));
        const data = await res.json();
        if (res.ok && data.ok) {
          if (data.avatar_url) {
            avatarEl.src = data.avatar_url;
            avatarEl.style.display = "block";
          }
          titleEl.textContent = "Signed in as @" + (data.username || "AniList User") + "!";
          descEl.textContent = "Your AniList account is now linked and syncing with Tora. You can close this tab and return to the app.";
          statusEl.textContent = "Authenticated Successfully";
          setTimeout(() => { try { window.close(); } catch (_) {} }, 1500);
        } else {
          throw new Error(data.error || "Failed to verify AniList account");
        }
      } catch (err) {
        titleEl.textContent = "Authentication Failed";
        descEl.textContent = String(err.message || err);
        statusEl.textContent = "Verification Error";
        statusEl.className = "badge error";
      }
    })();
  </script>
</body>
</html>"#;

fn extract_query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let k = parts.next()?.trim();
        let v = parts.next().unwrap_or("").trim();
        if k == key && !v.is_empty() {
            return Some(
                urlencoding::decode(v)
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| v.to_string()),
            );
        }
    }
    None
}

async fn handle_oauth_http_stream(
    mut stream: tokio::net::TcpStream,
    app_handle: tauri::AppHandle,
    db: Arc<Database>,
    plugins: Arc<PluginManager>,
    sync: Arc<TrackerSyncService>,
) {
    let mut buf = vec![0u8; 8192];
    let n = match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read(&mut buf),
    )
    .await
    {
        Ok(Ok(n)) if n > 0 => n,
        _ => return,
    };

    let req_str = String::from_utf8_lossy(&buf[..n]);
    let first_line = req_str.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let _method = parts.next().unwrap_or("GET");
    let full_path = parts.next().unwrap_or("/");

    if full_path.starts_with("/favicon.ico") {
        let resp = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes()).await;
        let _ = stream.shutdown().await;
        return;
    }

    let (path, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };

    if path.starts_with("/AniSync/token") || query.contains("access_token=") {
        if let Some(token) = extract_query_param(query, "access_token") {
            let result: Result<(AppSettings, TrackerUserProfile), String> = async {
                let plugin = plugins
                    .get("anilist")
                    .ok_or_else(|| "AniList plugin not found".to_string())?;
                let profile = plugin.verify_account("", Some(&token)).await?;

                // Keeps the list for the same account; a different account wipes the previous one's list.
                sync.sign_in(&token, &profile).await?;
                let db = db.clone();
                let settings = tokio::task::spawn_blocking(move || db.get_settings())
                    .await
                    .map_err(|e| e.to_string())??;
                Ok((settings, profile))
            }
            .await;

            match result {
                Ok((saved_settings, profile)) => {
                    let body = serde_json::json!({
                        "ok": true,
                        "username": profile.username,
                        "avatar_url": profile.avatar_url,
                    })
                    .to_string();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.shutdown().await;

                    let _ = app_handle.emit("tracker-auth-updated", &saved_settings);
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }

                    // Two-way sync with the newly linked account in the background. The service emits
                    // `tracker-sync-started` and `tracker-list-synced` (SyncSummary) / `tracker-sync-failed`.
                    tokio::spawn(async move {
                        let _ = sync.pull("post_auth").await;
                    });
                    return;
                }
                Err(err) => {
                    let body = serde_json::json!({
                        "ok": false,
                        "error": err,
                    })
                    .to_string();
                    let resp = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.shutdown().await;
                    return;
                }
            }
        }
    }

    // Serve the HTML callback page that reads `#access_token=...` from `window.location.hash`
    let body = OAUTH_CALLBACK_HTML.as_bytes();
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(headers.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

fn ensure_oauth_callback_listener(
    app_handle: tauri::AppHandle,
    db: Arc<Database>,
    plugins: Arc<PluginManager>,
    sync: Arc<TrackerSyncService>,
    active_flag: Arc<AtomicBool>,
) {
    if active_flag
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::bind("127.0.0.1:8096").await {
            Ok(listener) => {
                while let Ok((stream, _addr)) = listener.accept().await {
                    let app_c = app_handle.clone();
                    let db_c = db.clone();
                    let plugins_c = plugins.clone();
                    let sync_c = sync.clone();
                    tokio::spawn(async move {
                        handle_oauth_http_stream(stream, app_c, db_c, plugins_c, sync_c).await;
                    });
                }
                active_flag.store(false, Ordering::SeqCst);
            }
            Err(_) => {
                active_flag.store(false, Ordering::SeqCst);
            }
        }
    });
}

#[tauri::command]
async fn start_anilist_oauth(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    ensure_oauth_callback_listener(
        app.clone(),
        state.db.clone(),
        state.plugins.clone(),
        state.sync.clone(),
        state.oauth_listener_active.clone(),
    );

    let authorize_url =
        "https://anilist.co/api/v2/oauth/authorize?client_id=14954&response_type=token";
    open_external_url(authorize_url.to_string()).await?;
    Ok(authorize_url.to_string())
}

fn start_library_monitor(
    app_handle: tauri::AppHandle,
    db: Arc<Database>,
) -> LibraryMonitorHandle {
    // Start zero-polling Win32 IOCP ReadDirectoryChangesW monitor (0.00% idle CPU)
    LibraryMonitorHandle::start(db, move |summary| {
        let _ = app_handle.emit("library-changed", &summary);
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let db_path = app_data.join("tora_library.db");
            let db = Arc::new(Database::open(&db_path).expect("Failed to initialize Tora SQLite DB"));
            // Snapshot the settings as they were at startup (a known-good restore point).
            if let Err(e) = db.backup_settings_if_changed(None) {
                eprintln!("[settings] startup backup failed: {}", e);
            }
            let torrent_cache = Arc::new(TorrentCache::new(app_data.join("torrents")));
            let plugins = Arc::new(PluginManager::new());

            let monitor = start_library_monitor(app.handle().clone(), db.clone());
            let oauth_listener_active = Arc::new(AtomicBool::new(false));
            let active_session: Arc<Mutex<Option<DetectedMediaSession>>> =
                Arc::new(Mutex::new(None));

            // The sync service shares the same active-session handle as AppState so it can mirror
            // progress changes into the live playback session.
            let emit_handle = app.handle().clone();
            let emit: SyncEmitter = Arc::new(move |name: &str, payload: Value| {
                let _ = emit_handle.emit(name, payload);
            });
            let sync = Arc::new(TrackerSyncService::new(
                db.clone(),
                plugins.clone(),
                emit,
                active_session.clone(),
            ));

            ensure_oauth_callback_listener(
                app.handle().clone(),
                db.clone(),
                plugins.clone(),
                sync.clone(),
                oauth_listener_active.clone(),
            );

            app.manage(AppState {
                db,
                plugins,
                monitor,
                active_session,
                oauth_listener_active,
                sync: sync.clone(),
                unmatched_check_generation: AtomicU64::new(u64::MAX),
                torrents: torrent_cache.clone(),
            });

            let torrent_emit_handle = app.handle().clone();
            torrents::spawn_refresh_loop(
                app.state::<AppState>().db.clone(),
                torrent_cache,
                Arc::new(move |name: &str, payload: Value| {
                    let _ = torrent_emit_handle.emit(name, payload);
                }),
            );

            // Startup two-way sync. Without a token `pull` returns early (before emitting any event),
            // so a signed-out user sees no failure toast.
            tauri::async_runtime::spawn(async move {
                let _ = sync.pull("startup").await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_anime_list,
            get_anime_entries,
            update_anime_entry,
            batch_update_anime_entries,
            get_custom_lists,
            set_anime_custom_lists,
            create_custom_list,
            delete_custom_list,
            batch_delete_anime_entries,
            add_or_upsert_anime,
            delete_anime_entry,
            get_tracker_plugins,
            verify_tracker_account,
            sync_tracker_list,
            get_sync_status,
            search_remote_anime,
            get_season,
            get_airing_schedule,
            list_cached_seasons,
            get_library_folders,
            add_library_folder,
            remove_library_folder,
            get_drive_summaries,
            scan_library,
            quick_scan_library,
            get_local_episodes,
            bind_title_alias,
            play_episode_file,
            reveal_in_explorer,
            create_demo_library_files,
            test_parse_filename,
            dismiss_playback_session,
            poll_media_recognition,
            link_detected_episode_to_anime,
            get_watch_history,
            get_watch_stats,
            get_stats,
            get_app_info,
            get_media_metadata,
            get_torrent_board,
            download_releases,
            get_torrent_feeds,
            save_torrent_feeds,
            get_torrent_search_feeds,
            save_torrent_search_feeds,
            get_torrent_filters,
            save_torrent_filters,
            get_torrent_priority,
            save_torrent_priority,
            get_torrent_fansubs,
            set_anime_fansubs,
            get_torrent_board_options,
            save_torrent_board_options,
            parse_torrent_query,
            detect_torrent_app,
            list_settings_backups,
            backup_settings_now,
            restore_settings_backup,
            get_app_settings,
            save_app_settings,
            open_external_url,
            sign_out_tracker,
            start_anilist_oauth,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tora application");
}
