pub mod db;
pub mod detection;
pub mod library;
pub mod plugins;
pub mod torrents;

use crate::db::{
    AnimeEntry, AppSettings, Database, LibraryFolder, LocalEpisodeFile, TorrentRule,
    WatchHistoryEntry,
};
use crate::detection::anisthesia::{detect_active_media_player, DetectedMediaSession};
use crate::detection::anitomy::{parse_filename, AnitomyElements};
use crate::library::scanner::{DriveStorageSummary, ScanSummary};
use crate::plugins::{PluginManager, TrackerPluginDescriptor, TrackerUserProfile};
use crate::torrents::{
    search_torrents, send_to_qbittorrent, test_qbittorrent_connection, TorrentItem,
};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

pub struct AppState {
    pub db: Arc<Database>,
    pub plugins: Arc<PluginManager>,
    pub active_session: Mutex<Option<DetectedMediaSession>>,
    pub simulated_session: Mutex<Option<(String, String)>>, // (player_name, window_title)
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

    // Match only unmatched local files in background without blocking response
    let db_bg = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let _ = db_bg.match_unmatched_episodes_for_anime(anime_id);
    });

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
    tokio::task::spawn_blocking(move || {
        db.add_library_folder(&path, label)?;
        let _ = db.scan_all_library_folders();
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
    tokio::task::spawn_blocking(move || db.remove_library_folder(folder_id))
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
    #[cfg(windows)]
    {
        let p = std::path::Path::new(&file_path);
        if p.is_dir() {
            Command::new("explorer.exe")
                .arg(&file_path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            Command::new("explorer.exe")
                .arg(format!("/select,{}", file_path))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn create_demo_library_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanSummary, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db = state.db.clone();

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

        db.scan_all_library_folders()
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
            if existing.matched_anime_id.is_some() {
                existing.elapsed_seconds = (now - existing.detected_at_unix).max(0) as u64;

                // Only auto-update when matched to an anime entry and delay threshold is met
                if !existing.auto_synced
                    && existing.elapsed_seconds >= settings.recognition_delay_seconds
                {
                    existing.auto_synced = true;
                    if let (Some(aid), Some(ep)) =
                        (existing.matched_anime_id, existing.parsed.episode_number)
                    {
                        if let Ok(entry) = state.db.get_anime_entry_by_id(aid) {
                            let new_prog = ep.max(entry.user_progress);
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
                            ) {
                                existing.matched_current_progress = Some(updated.user_progress);
                            }
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

            app.manage(AppState {
                db,
                plugins,
                active_session: Mutex::new(None),
                simulated_session: Mutex::new(None),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_anime_list,
            update_anime_entry,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tora application");
}
