pub mod db;
pub mod detection;
pub mod library;
pub mod plugins;
pub mod torrents;

use crate::db::{
    AnimeEntry, AppSettings, BatchAnimeUpdatePatch, Database, LibraryFolder, LocalEpisodeFile, TorrentRule,
    WatchHistoryEntry,
};
use crate::detection::anisthesia::{detect_active_media_player, DetectedMediaSession};
use crate::detection::anitomy::{parse_filename, AnitomyElements};
use crate::library::scanner::{DriveStorageSummary, LibraryMonitorHandle, ScanSummary};
use crate::plugins::{PluginManager, TrackerPluginDescriptor, TrackerUserProfile};
use crate::torrents::{
    search_torrents, send_to_qbittorrent, test_qbittorrent_connection, TorrentItem,
};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct AppState {
    pub db: Arc<Database>,
    pub plugins: Arc<PluginManager>,
    pub monitor: LibraryMonitorHandle,
    pub active_session: Mutex<Option<DetectedMediaSession>>,
    pub simulated_session: Mutex<Option<(String, String)>>, // (player_name, window_title)
    pub oauth_listener_active: Arc<AtomicBool>,
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
    let db = state.db.clone();
    let (updated, settings) = tokio::task::spawn_blocking(move || -> Result<(AnimeEntry, AppSettings), String> {
        let (mut entry, needs_full_rematch) = db.update_anime_user_state(
            anime_id,
            &user_status,
            user_progress,
            user_score,
            user_repeats,
            &user_notes,
            custom_folder,
            synonyms,
            user_started_at,
            user_completed_at,
        )?;

        if needs_full_rematch {
            let _ = db.rematch_all_local_episodes();
            entry = db.get_anime_entry_by_id(anime_id)?;
        }

        let settings = db.get_settings()?;
        Ok((entry, settings))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Keep active media recognition session's current progress in sync if it matches this anime
    if let Ok(mut active_guard) = state.active_session.lock() {
        if let Some(existing) = active_guard.as_mut() {
            if existing.matched_anime_id == Some(updated.id) {
                existing.matched_current_progress = Some(updated.user_progress);
            }
        }
    }

    // Push update to tracker plugin asynchronously in the background so UI returns in <1ms
    if settings.auto_sync_tracker && !settings.anilist_token.trim().is_empty() {
        if let Some(plugin) = state.plugins.get(&settings.active_tracker_plugin) {
            if let Some(media_id) = updated.anilist_id {
                let tok = settings.anilist_token.clone();
                let st = updated.user_status.clone();
                let prog = updated.user_progress;
                let sc = updated.user_score;
                let rep = updated.user_repeats;
                let nts = updated.user_notes.clone();
                tokio::spawn(async move {
                    let _ = plugin
                        .update_list_entry(&tok, media_id, &st, prog, sc, rep, &nts)
                        .await;
                });
            }
        }
    }

    Ok(updated)
}

#[tauri::command]
async fn batch_update_anime_entries(
    state: State<'_, AppState>,
    patch: BatchAnimeUpdatePatch,
) -> Result<Vec<AnimeEntry>, String> {
    let db = state.db.clone();
    let (updated_list, settings) =
        tokio::task::spawn_blocking(move || -> Result<(Vec<AnimeEntry>, AppSettings), String> {
            let updated = db.batch_update_anime_entries(&patch)?;
            let settings = db.get_settings()?;
            Ok((updated, settings))
        })
        .await
        .map_err(|e| e.to_string())??;

    // Keep active media recognition session's current progress in sync if it matches any updated anime
    if let Ok(mut active_guard) = state.active_session.lock() {
        if let Some(existing) = active_guard.as_mut() {
            if let Some(matched_id) = existing.matched_anime_id {
                if let Some(found) = updated_list.iter().find(|e| e.id == matched_id) {
                    existing.matched_current_progress = Some(found.user_progress);
                }
            }
        }
    }

    // Push updates to tracker plugin asynchronously in the background
    if settings.auto_sync_tracker && !settings.anilist_token.trim().is_empty() {
        if let Some(plugin) = state.plugins.get(&settings.active_tracker_plugin) {
            let tok = settings.anilist_token.clone();
            let to_sync: Vec<(i64, String, u32, f64, u32, String)> = updated_list
                .iter()
                .filter_map(|e| {
                    e.anilist_id.map(|mid| {
                        (
                            mid,
                            e.user_status.clone(),
                            e.user_progress,
                            e.user_score,
                            e.user_repeats,
                            e.user_notes.clone(),
                        )
                    })
                })
                .collect();
            if !to_sync.is_empty() {
                tokio::spawn(async move {
                    for (media_id, st, prog, sc, rep, nts) in to_sync {
                        let _ = plugin
                            .update_list_entry(&tok, media_id, &st, prog, sc, rep, &nts)
                            .await;
                    }
                });
            }
        }
    }

    Ok(updated_list)
}

#[tauri::command]
async fn batch_delete_anime_entries(
    state: State<'_, AppState>,
    anime_ids: Vec<i64>,
) -> Result<Vec<AnimeEntry>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db.batch_delete_anime_entries(&anime_ids)?;
        db.list_anime_entries()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_or_upsert_anime(
    state: State<'_, AppState>,
    mut entry: AnimeEntry,
) -> Result<Vec<AnimeEntry>, String> {
    let db = state.db.clone();
    let anime_id = entry.id;
    let anilist_id = entry.anilist_id;
    let user_status = entry.user_status.clone();
    let user_progress = entry.user_progress;
    let user_score = entry.user_score;
    let user_repeats = entry.user_repeats;
    let user_notes = entry.user_notes.clone();

    let (list, settings) = tokio::task::spawn_blocking(move || {
        entry.updated_at = chrono::Utc::now().timestamp();
        db.upsert_anime_entry(&entry)?;
        let _ = db.match_unmatched_episodes_for_anime(anime_id);
        let list = db.list_anime_entries()?;
        let settings = db.get_settings()?;
        Ok::<_, String>((list, settings))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Push update to tracker plugin asynchronously in the background so UI returns in <1ms
    if settings.auto_sync_tracker && !settings.anilist_token.trim().is_empty() {
        if let Some(plugin) = state.plugins.get(&settings.active_tracker_plugin) {
            if let Some(media_id) = anilist_id {
                let tok = settings.anilist_token.clone();
                tokio::spawn(async move {
                    let _ = plugin
                        .update_list_entry(
                            &tok,
                            media_id,
                            &user_status,
                            user_progress,
                            user_score,
                            user_repeats,
                            &user_notes,
                        )
                        .await;
                });
            }
        }
    }

    Ok(list)
}

#[tauri::command]
async fn delete_anime_entry(
    state: State<'_, AppState>,
    anime_id: i64,
) -> Result<Vec<AnimeEntry>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db.delete_anime_entry(anime_id)?;
        db.list_anime_entries()
    })
    .await
    .map_err(|e| e.to_string())?
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
    let profile = plugin
        .verify_account(&username, token.as_deref())
        .await?;

    let mut settings = state.db.get_settings()?;
    settings.active_tracker_plugin = plugin_id;
    settings.anilist_username = profile.username.clone();
    settings.anilist_user_id = Some(profile.user_id);
    settings.anilist_avatar = profile.avatar_url.clone();
    if let Some(t) = token {
        settings.anilist_token = t;
    }
    state.db.save_settings(&settings)?;

    Ok(profile)
}

#[tauri::command]
async fn sync_tracker_list(
    state: State<'_, AppState>,
    plugin_id: Option<String>,
    username: Option<String>,
    token: Option<String>,
) -> Result<Vec<AnimeEntry>, String> {
    let settings = state.db.get_settings()?;
    let pid = plugin_id.unwrap_or_else(|| settings.active_tracker_plugin.clone());
    let uname = username.unwrap_or_else(|| settings.anilist_username.clone());
    let tok = token.or_else(|| {
        if settings.anilist_token.trim().is_empty() {
            None
        } else {
            Some(settings.anilist_token.clone())
        }
    });

    let plugin = state
        .plugins
        .get(&pid)
        .ok_or_else(|| "Tracker plugin not found".to_string())?;
    let remote_entries = plugin.fetch_user_list(&uname, tok.as_deref()).await?;

    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        db.upsert_anime_entries_batch(&remote_entries)?;
        let _ = db.rematch_all_local_episodes();
        db.list_anime_entries()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_remote_anime(
    state: State<'_, AppState>,
    query: String,
    season: Option<String>,
    year: Option<u32>,
) -> Result<Vec<AnimeEntry>, String> {
    let settings = state.db.get_settings()?;
    let plugin = state
        .plugins
        .get(&settings.active_tracker_plugin)
        .ok_or_else(|| "Tracker plugin not found".to_string())?;
    plugin
        .search_anime(&query, season.as_deref(), year)
        .await
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
    let settings = state.db.get_settings()?;
    let custom_player = settings.custom_media_player_path.trim();

    if !custom_player.is_empty() {
        Command::new(custom_player)
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("Failed to launch custom media player: {}", e))?;
    } else {
        #[cfg(windows)]
        {
            Command::new("cmd")
                .args(["/C", "start", "", &file_path])
                .spawn()
                .map_err(|e| format!("Failed to open file with system player: {}", e))?;
        }
    }

    if let Some(fname) = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
    {
        if let Ok(mut sim) = state.simulated_session.lock() {
            *sim = Some(("System Media Player".into(), fname.to_string()));
        }
    }

    Ok(format!("Playing {}", file_path))
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
async fn simulate_playback_session(
    state: State<'_, AppState>,
    player_name: Option<String>,
    window_title: Option<String>,
) -> Result<Option<DetectedMediaSession>, String> {
    {
        let mut sim = state
            .simulated_session
            .lock()
            .map_err(|e| e.to_string())?;
        match (player_name, window_title) {
            (Some(p), Some(t)) if !t.trim().is_empty() => {
                *sim = Some((p, t));
            }
            _ => {
                *sim = None;
                let mut active = state.active_session.lock().map_err(|e| e.to_string())?;
                *active = None;
                return Ok(None);
            }
        }
    }
    poll_media_recognition(state).await
}

#[tauri::command]
async fn poll_media_recognition(
    state: State<'_, AppState>,
) -> Result<Option<DetectedMediaSession>, String> {
    let settings = state.db.get_settings()?;
    if !settings.recognition_enabled {
        let mut active = state.active_session.lock().map_err(|e| e.to_string())?;
        *active = None;
        return Ok(None);
    }

    let now = chrono::Utc::now().timestamp();
    let sim_clone = state
        .simulated_session
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let players = settings.players.clone();

    // Run Win32 window enumeration on blocking pool so main thread is never touched
    let detected_candidate = tokio::task::spawn_blocking(move || {
        if let Some((player, win, cleaned, parsed)) = detect_active_media_player(&players) {
            Some((
                player.id,
                player.name,
                win.process_id,
                win.exe_path,
                win.window_title,
                cleaned,
                parsed,
            ))
        } else {
            sim_clone.map(|(p_name, w_title)| {
                let parsed = parse_filename(&w_title);
                (
                    "simulated".to_string(),
                    p_name,
                    std::process::id(),
                    "simulated://player".to_string(),
                    w_title.clone(),
                    w_title,
                    parsed,
                )
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut active_guard = state.active_session.lock().map_err(|e| e.to_string())?;

    let Some((player_id, player_name, pid, exe_path, raw_title, cleaned_title, mut parsed)) =
        detected_candidate
    else {
        *active_guard = None;
        return Ok(None);
    };

    // Check if it's the same session continuing
    if let Some(existing) = active_guard.as_mut() {
        if existing.cleaned_media_title == cleaned_title && existing.player_name == player_name {
            // If previously unmatched, re-check in case the user just added the anime or bound an alias
            if existing.matched_anime_id.is_none() {
                if let Some((id, title, cover, prog, total)) =
                    state.db.match_episode_to_anime(&mut existing.parsed, None)
                {
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
                if let Ok(entry) = state.db.get_anime_entry_by_id(aid) {
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
                        existing.auto_synced = true;
                        if let Some(ep) = existing.parsed.episode_number {
                            if let Ok(entry) = state.db.get_anime_entry_by_id(aid) {
                                if ep > entry.user_progress {
                                    let new_prog = ep;
                                    let new_status = if let Some(total) = entry.episodes {
                                        if new_prog >= total && total > 0 {
                                            "COMPLETED".to_string()
                                        } else if entry.user_status == "PLANNING" {
                                            "CURRENT".to_string()
                                        } else {
                                            entry.user_status.clone()
                                        }
                                    } else if entry.user_status == "PLANNING" {
                                        "CURRENT".to_string()
                                    } else {
                                        entry.user_status.clone()
                                    };

                                    if let Ok((updated, _)) = state.db.update_anime_user_state(
                                        aid,
                                        &new_status,
                                        new_prog,
                                        entry.user_score,
                                        entry.user_repeats,
                                        &entry.user_notes,
                                        entry.custom_folder,
                                        None,
                                        None,
                                        None,
                                    ) {
                                        existing.matched_current_progress =
                                            Some(updated.user_progress);
                                    }

                                    let _ = state.db.record_watch_history(
                                        Some(aid),
                                        existing
                                            .matched_anime_title
                                            .as_deref()
                                            .unwrap_or(&existing.parsed.anime_title),
                                        ep,
                                        &existing.player_name,
                                        &existing.cleaned_media_title,
                                        true,
                                    );
                                }
                            }
                        }
                    }
                }
            } else {
                existing.elapsed_seconds = 0;
                existing.auto_synced = false;
            }

            return Ok(Some(existing.clone()));
        }
    }

    // New playback session detected
    let matched = state
        .db
        .match_episode_to_anime(&mut parsed, None);
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

    *active_guard = Some(new_session.clone());
    Ok(Some(new_session))
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
async fn get_watch_history(state: State<'_, AppState>) -> Result<Vec<WatchHistoryEntry>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.list_watch_history(100))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_torrents_cmd(
    state: State<'_, AppState>,
    query: String,
    provider: Option<String>,
) -> Result<Vec<TorrentItem>, String> {
    let settings = state.db.get_settings()?;
    let prov = provider.unwrap_or(settings.torrent_provider);
    search_torrents(&query, &prov, &state.db).await
}

#[tauri::command]
async fn get_torrent_rules(state: State<'_, AppState>) -> Result<Vec<TorrentRule>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.list_torrent_rules())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_torrent_rule(
    state: State<'_, AppState>,
    rule: TorrentRule,
) -> Result<Vec<TorrentRule>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.save_torrent_rule(&rule))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_torrent_rule(
    state: State<'_, AppState>,
    rule_id: i64,
) -> Result<Vec<TorrentRule>, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || db.delete_torrent_rule(rule_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn download_torrent_cmd(
    state: State<'_, AppState>,
    magnet_url: String,
    torrent_url: String,
    anime_id: Option<i64>,
) -> Result<String, String> {
    let settings = state.db.get_settings()?;
    let target_uri = if !magnet_url.trim().is_empty() {
        magnet_url.trim()
    } else {
        torrent_url.trim()
    };

    if settings.qbittorrent_enabled {
        let mut save_path = settings.qbittorrent_save_path.clone();
        if let Some(aid) = anime_id {
            if let Ok(entry) = state.db.get_anime_entry_by_id(aid) {
                if let Some(cf) = entry.custom_folder.filter(|s| !s.trim().is_empty()) {
                    save_path = cf;
                }
            }
        }

        return send_to_qbittorrent(
            &settings.qbittorrent_url,
            &settings.qbittorrent_username,
            &settings.qbittorrent_password,
            target_uri,
            &settings.qbittorrent_category,
            &save_path,
        )
        .await;
    }

    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "start", "", target_uri])
            .spawn()
            .map_err(|e| format!("Failed to launch magnet/torrent link: {}", e))?;
    }

    Ok("Launched torrent in default system client".into())
}

#[tauri::command]
async fn test_qbittorrent_cmd(
    qb_url: String,
    username: String,
    password: String,
) -> Result<String, String> {
    test_qbittorrent_connection(&qb_url, &username, &password).await
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
    tokio::task::spawn_blocking(move || {
        db.save_settings(&settings)?;
        db.get_settings()
    })
    .await
    .map_err(|e| e.to_string())?
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
async fn sign_out_tracker(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let mut settings = db.get_settings()?;
        settings.anilist_username.clear();
        settings.anilist_token.clear();
        settings.anilist_user_id = None;
        settings.anilist_avatar = None;
        db.save_settings(&settings)?;
        db.get_settings()
    })
    .await
    .map_err(|e| e.to_string())?
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

                let mut settings = db.get_settings()?;
                settings.active_tracker_plugin = "anilist".into();
                settings.anilist_username = profile.username.clone();
                settings.anilist_token = token.clone();
                settings.anilist_user_id = Some(profile.user_id);
                settings.anilist_avatar = profile.avatar_url.clone();
                db.save_settings(&settings)?;
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

                    // Automatically fetch and sync the user's AniList library in the background
                    let app_clone = app_handle.clone();
                    let db_clone = db.clone();
                    let plugins_clone = plugins.clone();
                    let uname = profile.username.clone();
                    let tok = token.clone();
                    tokio::spawn(async move {
                        if let Some(plugin) = plugins_clone.get("anilist") {
                            if let Ok(remote_entries) =
                                plugin.fetch_user_list(&uname, Some(&tok)).await
                            {
                                if let Ok(Ok(updated_list)) =
                                    tokio::task::spawn_blocking(move || -> Result<Vec<AnimeEntry>, String> {
                                        db_clone.upsert_anime_entries_batch(&remote_entries)?;
                                        let _ = db_clone.rematch_all_local_episodes();
                                        db_clone.list_anime_entries()
                                    })
                                    .await
                                {
                                    let _ = app_clone.emit("tracker-list-synced", &updated_list);
                                }
                            }
                        }
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
                    tokio::spawn(async move {
                        handle_oauth_http_stream(stream, app_c, db_c, plugins_c).await;
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
            let plugins = Arc::new(PluginManager::new());

            let monitor = start_library_monitor(app.handle().clone(), db.clone());
            let oauth_listener_active = Arc::new(AtomicBool::new(false));

            ensure_oauth_callback_listener(
                app.handle().clone(),
                db.clone(),
                plugins.clone(),
                oauth_listener_active.clone(),
            );

            app.manage(AppState {
                db,
                plugins,
                monitor,
                active_session: Mutex::new(None),
                simulated_session: Mutex::new(None),
                oauth_listener_active,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_anime_list,
            update_anime_entry,
            batch_update_anime_entries,
            batch_delete_anime_entries,
            add_or_upsert_anime,
            delete_anime_entry,
            get_tracker_plugins,
            verify_tracker_account,
            sync_tracker_list,
            search_remote_anime,
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
            simulate_playback_session,
            poll_media_recognition,
            link_detected_episode_to_anime,
            get_watch_history,
            search_torrents_cmd,
            get_torrent_rules,
            save_torrent_rule,
            delete_torrent_rule,
            download_torrent_cmd,
            test_qbittorrent_cmd,
            get_app_settings,
            save_app_settings,
            open_external_url,
            sign_out_tracker,
            start_anilist_oauth,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tora application");
}
