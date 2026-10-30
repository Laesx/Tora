//! Discord Rich Presence: while a matched episode plays, the user's Discord profile shows
//! "Watching <anime>" with the cover, the episode, an AniList link and a link to Tora.
//!
//! Discord IPC is blocking (a named pipe), so one worker thread owns the connection; the media poll
//! only sends the wanted presence over a channel. The worker skips unchanged presences (Discord rate
//! limits activity updates), connects lazily and retries while Discord isn't running.

use crate::db::AnimeEntry;
use discord_rich_presence::activity::{
    Activity, ActivityType, Assets, Button, StatusDisplayType, Timestamps,
};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The "Tora" application on the Discord developer portal.
const DISCORD_APP_ID: &str = "1565515066722488402";
pub const TORA_REPO_URL: &str = "https://github.com/Laesx/Tora";
/// Wait before reconnecting after Discord wasn't reachable or the pipe broke.
const RETRY_AFTER: Duration = Duration::from_secs(15);
/// Discord rejects details / state / text fields longer than this.
const MAX_FIELD_CHARS: usize = 128;

/// What the presence shows for one anime (cached per anime + title language).
#[derive(Debug, Clone, PartialEq)]
pub struct PresenceAnime {
    pub title: String,
    pub cover_url: Option<String>,
    pub anilist_url: Option<String>,
}

impl PresenceAnime {
    /// The title in the user's title language (missing English / Native titles fall back to Romaji).
    pub fn from_entry(entry: &AnimeEntry, title_language: &str) -> Self {
        let localized = match title_language {
            "english" => entry.title_english.as_deref(),
            "native" => entry.title_native.as_deref(),
            _ => None,
        };
        let title = localized
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or(&entry.title_romaji)
            .to_string();
        let anilist_url = entry
            .site_url
            .clone()
            .filter(|u| u.starts_with("https://"))
            .or_else(|| entry.anilist_id.map(|id| format!("https://anilist.co/anime/{}", id)));
        Self {
            title,
            cover_url: Some(entry.cover_image.clone()).filter(|u| u.starts_with("https://")),
            anilist_url,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PresenceInfo {
    pub anime: PresenceAnime,
    pub episode: Option<u32>,
    pub total_episodes: Option<u32>,
    /// When playback was detected (the "elapsed" timer).
    pub started_at_unix: i64,
}

pub struct DiscordPresence {
    tx: mpsc::Sender<Option<PresenceInfo>>,
    /// (anime id, title language) → what to show, so the 2.5 s poll doesn't query the DB each time.
    cache: Mutex<Option<(i64, String, PresenceAnime)>>,
}

impl DiscordPresence {
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel();
        if let Err(e) = std::thread::Builder::new()
            .name("discord-presence".into())
            .spawn(move || run_worker(rx))
        {
            log::warn!(target: "discord", "failed to start the presence thread: {}", e);
        }
        Self {
            tx,
            cache: Mutex::new(None),
        }
    }

    /// Show this presence (None clears it). Cheap: call it on every poll.
    pub fn update(&self, info: Option<PresenceInfo>) {
        let _ = self.tx.send(info);
    }

    pub fn cached_anime(&self, anime_id: i64, title_language: &str) -> Option<PresenceAnime> {
        let cache = self.cache.lock().ok()?;
        cache
            .as_ref()
            .filter(|(id, lang, _)| *id == anime_id && lang == title_language)
            .map(|(_, _, anime)| anime.clone())
    }

    pub fn cache_anime(&self, anime_id: i64, title_language: &str, anime: PresenceAnime) {
        if let Ok(mut cache) = self.cache.lock() {
            *cache = Some((anime_id, title_language.to_string(), anime));
        }
    }
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= MAX_FIELD_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_FIELD_CHARS - 1).collect();
    out.push('…');
    out
}

/// "Episode 5 of 12" / "Episode 5" (None without an episode number).
fn episode_label(info: &PresenceInfo) -> Option<String> {
    let ep = info.episode?;
    Some(match info.total_episodes {
        Some(total) if total > 0 => format!("Episode {} of {}", ep, total),
        _ => format!("Episode {}", ep),
    })
}

fn set_presence(client: &mut DiscordIpcClient, info: &PresenceInfo) -> Result<(), discord_rich_presence::error::Error> {
    // Discord needs at least 2 characters
    let title = truncate(&format!("{:<2}", info.anime.title));
    let state = episode_label(info);
    let mut buttons = Vec::new();
    if let Some(url) = info.anime.anilist_url.as_deref() {
        buttons.push(Button::new("View on AniList", url));
    }
    buttons.push(Button::new("Get Tora", TORA_REPO_URL));

    let mut assets = Assets::new().large_text(title.as_str());
    if let Some(cover) = info.anime.cover_url.as_deref() {
        assets = assets.large_image(cover);
    }
    let mut activity = Activity::new()
        .activity_type(ActivityType::Watching)
        // The member list reads "Watching <anime>" instead of "Watching Tora"
        .status_display_type(StatusDisplayType::Details)
        .details(title.as_str())
        .timestamps(Timestamps::new().start(info.started_at_unix * 1000))
        .assets(assets)
        .buttons(buttons);
    if let Some(url) = info.anime.anilist_url.as_deref() {
        activity = activity.details_url(url);
    }
    if let Some(state) = state.as_deref() {
        activity = activity.state(state);
    }
    client.set_activity(activity)
}

fn run_worker(rx: mpsc::Receiver<Option<PresenceInfo>>) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut wanted: Option<PresenceInfo> = None;
    // What Discord shows now (meaningful only while connected)
    let mut shown: Option<PresenceInfo> = None;
    let mut retry_at: Option<Instant> = None;

    loop {
        let message = match retry_at {
            Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match message {
            Ok(info) => wanted = info,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // Only the latest request matters
        while let Ok(info) = rx.try_recv() {
            wanted = info;
        }

        if client.is_none() {
            if wanted.is_none() {
                // Nothing to show and nothing shown (a closed connection cleared it)
                retry_at = None;
                continue;
            }
            if retry_at.is_some_and(|at| Instant::now() < at) {
                continue;
            }
            let mut c = DiscordIpcClient::new(DISCORD_APP_ID);
            if c.connect().is_err() {
                // Discord isn't running (yet)
                retry_at = Some(Instant::now() + RETRY_AFTER);
                continue;
            }
            client = Some(c);
            shown = None;
            retry_at = None;
        }

        if wanted == shown {
            continue;
        }
        let Some(c) = client.as_mut() else { continue };
        let result = match wanted.as_ref() {
            Some(info) => set_presence(c, info),
            None => c.clear_activity(),
        }
        // Discord answers every command; read it so the pipe never backs up and a rejected
        // activity (bad field, bad button) shows up in the log instead of failing silently.
        .and_then(|()| c.recv());
        match result {
            Ok((_, reply)) => {
                if reply["evt"] == "ERROR" {
                    log::warn!(target: "discord", "activity rejected: {}", reply["data"]);
                }
                shown = wanted.clone();
            }
            Err(e) => {
                log::warn!(target: "discord", "presence update failed: {}", e);
                let _ = c.close();
                client = None;
                shown = None;
                retry_at = Some(Instant::now() + RETRY_AFTER);
            }
        }
    }

    if let Some(mut c) = client {
        let _ = c.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(episode: Option<u32>, total: Option<u32>) -> PresenceInfo {
        PresenceInfo {
            anime: PresenceAnime {
                title: "Sousou no Frieren".into(),
                cover_url: None,
                anilist_url: None,
            },
            episode,
            total_episodes: total,
            started_at_unix: 0,
        }
    }

    #[test]
    fn episode_labels() {
        assert_eq!(episode_label(&info(Some(5), Some(28))).as_deref(), Some("Episode 5 of 28"));
        assert_eq!(episode_label(&info(Some(5), None)).as_deref(), Some("Episode 5"));
        assert_eq!(episode_label(&info(None, Some(28))), None);
    }

    #[test]
    fn long_titles_are_truncated() {
        let long = "a".repeat(300);
        let t = truncate(&long);
        assert_eq!(t.chars().count(), MAX_FIELD_CHARS);
        assert!(t.ends_with('…'));
        assert_eq!(truncate("short"), "short");
    }
}
