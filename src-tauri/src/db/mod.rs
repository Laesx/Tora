use crate::detection::anisthesia::{default_players, PlayerDefinition};
use crate::detection::anitomy::{extract_effective_season, normalize_anime_title, AnitomyElements};
use crate::detection::relations::relations_db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimeEntry {
    pub id: i64,
    pub anilist_id: Option<i64>,
    pub mal_id: Option<i64>,
    pub title_romaji: String,
    pub title_english: Option<String>,
    pub title_native: Option<String>,
    pub synonyms: Vec<String>,
    pub format: String,
    pub airing_status: String,
    pub episodes: Option<u32>,
    pub duration: Option<u32>,
    pub season: Option<String>,
    pub season_year: Option<u32>,
    pub average_score: Option<u32>,
    pub cover_image: String,
    pub banner_image: Option<String>,
    pub cover_color: Option<String>,
    pub synopsis: String,
    pub genres: Vec<String>,
    pub studios: Vec<String>,
    pub next_airing_episode: Option<u32>,
    pub next_airing_at: Option<i64>,
    pub trailer_url: Option<String>,
    pub site_url: Option<String>,
    pub source_material: Option<String>,
    // User list fields
    pub user_status: String,
    pub user_progress: u32,
    pub user_score: f64,
    pub user_repeats: u32,
    pub user_notes: String,
    pub custom_folder: Option<String>,
    pub updated_at: i64,
    // Computed local library fields
    pub local_episode_count: u32,
    pub available_episodes: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryFolder {
    pub id: i64,
    pub path: String,
    pub label: String,
    pub drive_root: String,
    pub enabled: bool,
    pub file_count: u32,
    pub total_bytes: u64,
    pub last_scanned_at: Option<i64>,
    pub drive_total_bytes: u64,
    pub drive_free_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalEpisodeFile {
    pub id: i64,
    pub folder_id: i64,
    pub file_path: String,
    pub file_name: String,
    pub drive_root: String,
    pub file_size: u64,
    pub modified_unix: i64,
    pub parsed_title: String,
    pub normalized_title: String,
    pub episode_number: Option<u32>,
    pub anime_season: Option<u32>,
    pub release_group: Option<String>,
    pub resolution: Option<String>,
    pub video_terms: Vec<String>,
    pub audio_terms: Vec<String>,
    pub checksum: Option<String>,
    pub matched_anime_id: Option<i64>,
    pub matched_anime_title: Option<String>,
    pub watched: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentRule {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub anime_title_filter: String,
    pub anime_id: Option<i64>,
    pub release_group: String,
    pub resolution: String,
    pub exclude_keywords: String,
    pub action: String, // "highlight" | "auto_download" | "discard"
    pub only_unwatched: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchHistoryEntry {
    pub id: i64,
    pub anime_id: Option<i64>,
    pub anime_title: String,
    pub episode_number: u32,
    pub player_name: String,
    pub file_name: String,
    pub scrobbled_to_tracker: bool,
    pub timestamp_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub theme: String,
    pub accent_color: String,
    pub view_mode: String, // "grid" | "compact" | "table"
    pub active_tracker_plugin: String,
    pub anilist_username: String,
    pub anilist_token: String,
    pub anilist_user_id: Option<i64>,
    pub anilist_avatar: Option<String>,
    pub recognition_enabled: bool,
    pub recognition_delay_seconds: u64,
    pub auto_sync_tracker: bool,
    pub custom_media_player_path: String,
    pub torrent_provider: String, // "nyaa" | "animetosho"
    pub qbittorrent_enabled: bool,
    pub qbittorrent_url: String,
    pub qbittorrent_username: String,
    pub qbittorrent_password: String,
    pub qbittorrent_category: String,
    pub qbittorrent_save_path: String,
    pub players: Vec<PlayerDefinition>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "tora-midnight".into(),
            accent_color: "#f59e0b".into(),
            view_mode: "grid".into(),
            active_tracker_plugin: "anilist".into(),
            anilist_username: String::new(),
            anilist_token: String::new(),
            anilist_user_id: None,
            anilist_avatar: None,
            recognition_enabled: true,
            recognition_delay_seconds: 10,
            auto_sync_tracker: true,
            custom_media_player_path: String::new(),
            torrent_provider: "nyaa".into(),
            qbittorrent_enabled: false,
            qbittorrent_url: "http://127.0.0.1:8080".into(),
            qbittorrent_username: "admin".into(),
            qbittorrent_password: String::new(),
            qbittorrent_category: "anime".into(),
            qbittorrent_save_path: String::new(),
            players: default_players(),
        }
    }
}

/// Strip a trailing season number token (e.g. `" 2"`, `" 3"`) from a normalized title to extract the core series title.
fn strip_trailing_season(norm: &str, season: u32) -> &str {
    if season > 1 {
        let suffix = format!(" {}", season);
        if let Some(stripped) = norm.strip_suffix(&suffix) {
            let trimmed = stripped.trim();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    norm.trim()
}

/// Compute character 2-gram Sorensen-Dice similarity in `[0.0, 1.0]`.
fn bigram_dice_similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    if a_bytes.len() < 2 || b_bytes.len() < 2 {
        return 0.0;
    }
    let mut a_grams: Vec<[u8; 2]> = Vec::with_capacity(a_bytes.len() - 1);
    for w in a_bytes.windows(2) {
        a_grams.push([w[0], w[1]]);
    }
    let mut b_grams: Vec<[u8; 2]> = Vec::with_capacity(b_bytes.len() - 1);
    for w in b_bytes.windows(2) {
        b_grams.push([w[0], w[1]]);
    }
    let total = a_grams.len() + b_grams.len();
    let mut matches = 0usize;
    let mut b_used = vec![false; b_grams.len()];
    for ag in &a_grams {
        if let Some(pos) = b_grams
            .iter()
            .enumerate()
            .position(|(i, bg)| !b_used[i] && bg == ag)
        {
            b_used[pos] = true;
            matches += 1;
        }
    }
    (2.0 * matches as f64) / (total as f64)
}

/// Score similarity between a query core title and a candidate entry's core title (after season isolation).
/// Handles exact matches, abbreviated titles (e.g. `"kusuriya"` vs `"kusuriya no hitorigoto"`),
/// word-subset matches (e.g. `"frieren"` vs `"sousou no frieren"`), and fuzzy Romanization variants.
fn compute_core_title_similarity(query_core: &str, cand_core: &str) -> f64 {
    if query_core.is_empty() || cand_core.is_empty() {
        return 0.0;
    }
    if query_core == cand_core {
        return 1.0;
    }

    let (shorter, longer) = if query_core.len() <= cand_core.len() {
        (query_core, cand_core)
    } else {
        (cand_core, query_core)
    };

    if shorter.len() < 4 {
        return 0.0;
    }

    let len_ratio = shorter.len() as f64 / longer.len() as f64;

    // 1. Word-boundary prefix match (e.g. "kusuriya" -> "kusuriya no hitorigoto")
    if longer.starts_with(shorter) && longer.as_bytes().get(shorter.len()) == Some(&b' ') {
        return 0.92 + 0.07 * len_ratio;
    }

    // 2. All words of the shorter title appear as complete words (or strong fuzzy word matches) in the longer title
    let short_words: Vec<&str> = shorter.split_whitespace().collect();
    let long_words: Vec<&str> = longer.split_whitespace().collect();
    if !short_words.is_empty() {
        let all_words_match = short_words.iter().all(|sw| {
            long_words.iter().any(|lw| {
                *lw == *sw
                    || (sw.len() >= 5 && lw.starts_with(*sw))
                    || (sw.len() >= 5 && lw.len() >= 5 && bigram_dice_similarity(sw, lw) >= 0.84)
            })
        });
        if all_words_match {
            return 0.86 + 0.10 * len_ratio;
        }
    }

    // 3. Contiguous substring match for titles >= 5 chars with reasonable length ratio
    if shorter.len() >= 5 && len_ratio >= 0.55 && longer.contains(shorter) {
        return 0.78 + 0.10 * len_ratio;
    }

    // 4. Overall character bigram Sorensen-Dice fuzzy similarity
    let dice = bigram_dice_similarity(query_core, cand_core);
    if dice >= 0.74 {
        return dice;
    }

    0.0
}

/// Fast in-memory matcher index built from a single SQL pass so batch episode/torrent matching is O(1) with zero DB queries per item.
pub struct AnimeMatcherIndex {
    pub by_id: HashMap<i64, (String, String, u32, Option<u32>)>,
    pub external_ids: HashMap<i64, (Option<i64>, Option<i64>, u32)>,
    pub by_anilist_id: HashMap<i64, i64>,
    pub by_mal_id: HashMap<i64, i64>,
    pub user_aliases: HashMap<String, i64>,
    pub exact_norm: HashMap<String, i64>,
    pub custom_folders: Vec<(String, i64)>,
    pub norm_list: Vec<(String, u32, i64)>,
}

impl AnimeMatcherIndex {
    pub fn match_title(
        &self,
        normalized_title: &str,
        file_path: Option<&str>,
    ) -> Option<(i64, String, String, u32, Option<u32>)> {
        // 1. Check custom folder prefix match
        if let Some(fp) = file_path {
            if !self.custom_folders.is_empty() {
                let fp_lower = fp.to_ascii_lowercase();
                for (folder_prefix, aid) in &self.custom_folders {
                    if fp_lower.starts_with(folder_prefix) {
                        if let Some((t, cov, prog, eps)) = self.by_id.get(aid) {
                            return Some((*aid, t.clone(), cov.clone(), *prog, *eps));
                        }
                    }
                }
            }
        }

        if normalized_title.is_empty() {
            return None;
        }

        // 2. O(1) explicit user-linked alias lookup
        if let Some(aid) = self.user_aliases.get(normalized_title) {
            if let Some((t, cov, prog, eps)) = self.by_id.get(aid) {
                return Some((*aid, t.clone(), cov.clone(), *prog, *eps));
            }
        }

        // 3. O(1) exact normalized title lookup
        if let Some(aid) = self.exact_norm.get(normalized_title) {
            if let Some((t, cov, prog, eps)) = self.by_id.get(aid) {
                return Some((*aid, t.clone(), cov.clone(), *prog, *eps));
            }
        }

        // 4. Season-isolated fuzzy matching across anime names and alternative titles
        // Never allow a Season 2/3 query (e.g. "kusuriya 3" or "bocchi rock 2") to match a Season 1 entry.
        let query_season = extract_effective_season(normalized_title);
        let query_core = strip_trailing_season(normalized_title, query_season);

        if query_core.len() >= 4 {
            let mut best_match: Option<(f64, i64)> = None;
            for (norm, entry_season, aid) in &self.norm_list {
                if *entry_season != query_season {
                    continue;
                }
                let cand_core = strip_trailing_season(norm, *entry_season);
                let score = compute_core_title_similarity(query_core, cand_core);
                if score >= 0.74 {
                    if best_match.map_or(true, |(best_score, _)| score > best_score) {
                        best_match = Some((score, *aid));
                    }
                }
            }

            if let Some((_, aid)) = best_match {
                if let Some((t, cov, prog, eps)) = self.by_id.get(&aid) {
                    return Some((aid, t.clone(), cov.clone(), *prog, *eps));
                }
            }
        }

        None
    }

    /// Match a parsed `AnitomyElements` against the index, validating episode bounds and applying
    /// `erengy/anime-relations` ID redirections or multi-season sequential episode offsets (ported from Taiga's `identify`).
    pub fn match_episode(
        &self,
        parsed: &mut AnitomyElements,
        file_path: Option<&str>,
    ) -> Option<(i64, String, String, u32, Option<u32>)> {
        let matched = self.match_title(&parsed.normalized_title, file_path)?;
        let (aid, title, cover, prog, eps) = matched;

        let Some(ep) = parsed.episode_number else {
            return Some((aid, title, cover, prog, eps));
        };

        // Port of Taiga's `isValidEpisodeNumber`:
        // Episode 0 or an episode exceeding the entry's total episode count triggers redirection.
        let is_valid_ep = if ep == 0 {
            false
        } else if let Some(max_ep) = eps {
            max_ep == 0 || ep <= max_ep
        } else {
            true
        };

        if is_valid_ep {
            return Some((aid, title, cover, prog, eps));
        }

        // 1. Check `erengy/anime-relations` by AniList ID / MyAnimeList ID
        let (anilist_id, mal_id, entry_season) = self
            .external_ids
            .get(&aid)
            .copied()
            .unwrap_or((None, None, 1));

        if let Some(red) =
            relations_db().find_by_id(anilist_id, mal_id, ep, parsed.episode_number_alt)
        {
            parsed.episode_number = Some(red.dst_episode);
            if let Some(alt) = red.dst_episode_alt {
                parsed.episode_number_alt = Some(alt);
            }
            if let Some(s) = red.dst_season {
                parsed.anime_season = Some(s);
            }
            if !red.dst_title.is_empty() {
                parsed.anime_title = red.dst_title.clone();
                parsed.normalized_title = red.dst_norm_title.clone();
            }

            let dst_aid = red
                .dst_anilist_id
                .and_then(|id| self.by_anilist_id.get(&id).copied())
                .or_else(|| {
                    red.dst_mal_id
                        .and_then(|id| self.by_mal_id.get(&id).copied())
                })
                .or_else(|| self.exact_norm.get(&red.dst_norm_title).copied());

            if let Some(target_id) = dst_aid {
                if let Some((t, cov, p, e)) = self.by_id.get(&target_id) {
                    return Some((target_id, t.clone(), cov.clone(), *p, *e));
                }
            }
            return None;
        }

        // 2. Dynamic multi-season sequential episode fallback across entries in the user's database
        if let Some(first_max) = eps.filter(|&m| m > 0 && ep > m) {
            let mut rem_ep = ep - first_max;
            let base_norm = parsed.normalized_title.clone();
            for next_s in (entry_season + 1)..=10 {
                let candidate_norm = format!("{} {}", base_norm, next_s);
                let Some(&next_aid) = self.exact_norm.get(&candidate_norm) else {
                    break;
                };
                let Some((t, cov, p, next_eps)) = self.by_id.get(&next_aid) else {
                    break;
                };
                let max_for_season = next_eps.unwrap_or(u32::MAX);
                if max_for_season == 0 || rem_ep <= max_for_season {
                    parsed.episode_number = Some(rem_ep);
                    parsed.anime_season = Some(next_s);
                    parsed.anime_title = t.clone();
                    parsed.normalized_title = candidate_norm;
                    return Some((next_aid, t.clone(), cov.clone(), *p, *next_eps));
                }
                rem_ep -= max_for_season;
            }
        }

        None
    }
}

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -4000;
             PRAGMA mmap_size = 0;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| e.to_string())?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_schema()?;
        db.seed_initial_data_if_empty()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS anime_entries (
                id INTEGER PRIMARY KEY,
                anilist_id INTEGER UNIQUE,
                mal_id INTEGER,
                title_romaji TEXT NOT NULL,
                title_english TEXT,
                title_native TEXT,
                synonyms_json TEXT NOT NULL DEFAULT '[]',
                normalized_titles_json TEXT NOT NULL DEFAULT '[]',
                format TEXT NOT NULL DEFAULT 'TV',
                airing_status TEXT NOT NULL DEFAULT 'FINISHED',
                episodes INTEGER,
                duration INTEGER,
                season TEXT,
                season_year INTEGER,
                average_score INTEGER,
                cover_image TEXT NOT NULL DEFAULT '',
                banner_image TEXT,
                cover_color TEXT,
                synopsis TEXT NOT NULL DEFAULT '',
                genres_json TEXT NOT NULL DEFAULT '[]',
                studios_json TEXT NOT NULL DEFAULT '[]',
                next_airing_episode INTEGER,
                next_airing_at INTEGER,
                trailer_url TEXT,
                site_url TEXT,
                source_material TEXT,
                user_status TEXT NOT NULL DEFAULT 'CURRENT',
                user_progress INTEGER NOT NULL DEFAULT 0,
                user_score REAL NOT NULL DEFAULT 0,
                user_repeats INTEGER NOT NULL DEFAULT 0,
                user_notes TEXT NOT NULL DEFAULT '',
                custom_folder TEXT,
                updated_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_anime_status ON anime_entries(user_status);
            CREATE INDEX IF NOT EXISTS idx_anime_anilist ON anime_entries(anilist_id);

            CREATE TABLE IF NOT EXISTS library_folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL,
                drive_root TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                file_count INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER NOT NULL DEFAULT 0,
                last_scanned_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS local_episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder_id INTEGER NOT NULL,
                file_path TEXT NOT NULL UNIQUE,
                file_name TEXT NOT NULL,
                drive_root TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                modified_unix INTEGER NOT NULL DEFAULT 0,
                parsed_title TEXT NOT NULL,
                normalized_title TEXT NOT NULL,
                episode_number INTEGER,
                anime_season INTEGER,
                release_group TEXT,
                resolution TEXT,
                video_terms_json TEXT NOT NULL DEFAULT '[]',
                audio_terms_json TEXT NOT NULL DEFAULT '[]',
                checksum TEXT,
                matched_anime_id INTEGER,
                watched INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(folder_id) REFERENCES library_folders(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_local_episodes_norm ON local_episodes(normalized_title);
            CREATE INDEX IF NOT EXISTS idx_local_episodes_matched ON local_episodes(matched_anime_id);
            CREATE INDEX IF NOT EXISTS idx_local_episodes_folder ON local_episodes(folder_id);

            CREATE TABLE IF NOT EXISTS title_aliases (
                normalized_alias TEXT PRIMARY KEY,
                anime_id INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS torrent_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                anime_title_filter TEXT NOT NULL DEFAULT '',
                anime_id INTEGER,
                release_group TEXT NOT NULL DEFAULT '',
                resolution TEXT NOT NULL DEFAULT '1080p',
                exclude_keywords TEXT NOT NULL DEFAULT '',
                action TEXT NOT NULL DEFAULT 'highlight',
                only_unwatched INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS watch_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id INTEGER,
                anime_title TEXT NOT NULL,
                episode_number INTEGER NOT NULL,
                player_name TEXT NOT NULL,
                file_name TEXT NOT NULL,
                scrobbled_to_tracker INTEGER NOT NULL DEFAULT 0,
                timestamp_unix INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn build_normalized_titles(
        romaji: &str,
        english: Option<&str>,
        native: Option<&str>,
        synonyms: &[String],
    ) -> Vec<String> {
        let mut set = Vec::new();
        for t in std::iter::once(romaji)
            .chain(english.into_iter())
            .chain(native.into_iter())
            .chain(synonyms.iter().map(|s| s.as_str()))
        {
            let norm = normalize_anime_title(t);
            if !norm.is_empty() && !set.contains(&norm) {
                set.push(norm);
            }
        }
        set
    }

    fn seed_initial_data_if_empty(&self) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp();
        let kusuriya_s3 = AnimeEntry {
            id: 195516,
            anilist_id: Some(195516),
            mal_id: Some(61987),
            title_romaji: "Kusuriya no Hitorigoto 3rd Season".into(),
            title_english: Some("The Apothecary Diaries Season 3".into()),
            title_native: Some("薬屋のひとりごと 第3期".into()),
            synonyms: vec!["Apothecary Diaries S3".into(), "Kusuriya S3".into()],
            format: "TV".into(),
            airing_status: "RELEASING".into(),
            episodes: Some(12),
            duration: Some(24),
            season: Some("FALL".into()),
            season_year: Some(2026),
            average_score: Some(90),
            cover_image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx161645-7I8C2721A1sV.jpg".into(),
            banner_image: Some("https://s4.anilist.co/file/anilistcdn/media/anime/banner/161645-5A2V3gA8G4zZ.jpg".into()),
            cover_color: Some("#059669".into()),
            synopsis: "Third season of Kusuriya no Hitorigoto.".into(),
            genres: vec!["Drama".into(), "Mystery".into()],
            studios: vec!["OLM".into(), "TOHO animation STUDIO".into()],
            next_airing_episode: Some(4),
            next_airing_at: Some(now + 86400 * 3),
            trailer_url: None,
            site_url: Some("https://anilist.co/anime/195516".into()),
            source_material: Some("LIGHT_NOVEL".into()),
            user_status: "CURRENT".into(),
            user_progress: 2,
            user_score: 0.0,
            user_repeats: 0,
            user_notes: "".into(),
            custom_folder: None,
            updated_at: now - 100000,
            local_episode_count: 0,
            available_episodes: vec![],
        };

        let (count, has_s1, has_s3_seeded): (i64, bool, bool) = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let c: i64 = conn
                .query_row("SELECT COUNT(*) FROM anime_entries", [], |r| r.get(0))
                .unwrap_or(0);
            let s1: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM anime_entries WHERE id = 161645",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let s3_flag: Option<String> = conn
                .query_row(
                    "SELECT value_json FROM app_settings WHERE key = 'seeded_kusuriya_s3'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            (c, s1 > 0, s3_flag.is_some())
        };
        if count > 0 {
            if has_s1 && !has_s3_seeded {
                let exists: i64 = {
                    let conn = self.conn.lock().map_err(|e| e.to_string())?;
                    conn.query_row(
                        "SELECT COUNT(*) FROM anime_entries WHERE id = 195516 OR anilist_id = 195516",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0)
                };
                if exists == 0 {
                    let _ = self.upsert_anime_entry(&kusuriya_s3);
                }
                if let Ok(conn) = self.conn.lock() {
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES ('seeded_kusuriya_s3', 'true')",
                        [],
                    );
                }
            }
            return Ok(());
        }

        let starter_entries = vec![
            AnimeEntry {
                id: 154587,
                anilist_id: Some(154587),
                mal_id: Some(52991),
                title_romaji: "Sousou no Frieren".into(),
                title_english: Some("Frieren: Beyond Journey's End".into()),
                title_native: Some("葬送のフリーレン".into()),
                synonyms: vec!["Frieren".into(), "Sousou no Frieren".into()],
                format: "TV".into(),
                airing_status: "FINISHED".into(),
                episodes: Some(28),
                duration: Some(24),
                season: Some("FALL".into()),
                season_year: Some(2023),
                average_score: Some(93),
                cover_image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-gHSraOSa0nBG.jpg".into(),
                banner_image: Some("https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587-ivXNJ23SM1xB.jpg".into()),
                cover_color: Some("#a3e635".into()),
                synopsis: "The adventure is over but life goes on for an elf mage just beginning to learn what living is all about. Elf mage Frieren and her courageous fellow adventurers have defeated the Demon King and brought peace to the land.".into(),
                genres: vec!["Adventure".into(), "Drama".into(), "Fantasy".into()],
                studios: vec!["Madhouse".into()],
                next_airing_episode: None,
                next_airing_at: None,
                trailer_url: Some("https://www.youtube.com/watch?v=ZEkwCGJ3o7M".into()),
                site_url: Some("https://anilist.co/anime/154587".into()),
                source_material: Some("MANGA".into()),
                user_status: "CURRENT".into(),
                user_progress: 24,
                user_score: 95.0,
                user_repeats: 0,
                user_notes: "Masterpiece adaptation by Madhouse. Watching in 1080p FLAC.".into(),
                custom_folder: None,
                updated_at: now - 3600,
                local_episode_count: 0,
                available_episodes: vec![],
            },
            AnimeEntry {
                id: 171018,
                anilist_id: Some(171018),
                mal_id: Some(57334),
                title_romaji: "Dandadan".into(),
                title_english: Some("DAN DA DAN".into()),
                title_native: Some("ダンダダン".into()),
                synonyms: vec!["Dandadan".into()],
                format: "TV".into(),
                airing_status: "RELEASING".into(),
                episodes: Some(12),
                duration: Some(24),
                season: Some("FALL".into()),
                season_year: Some(2024),
                average_score: Some(87),
                cover_image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx171018-2ldCj6QywuOa.jpg".into(),
                banner_image: Some("https://s4.anilist.co/file/anilistcdn/media/anime/banner/171018-s0c272c2aI8v.jpg".into()),
                cover_color: Some("#ef4444".into()),
                synopsis: "Momo Ayase strikes up an unusual friendship with her school's UFO fanatic, whom she nicknames 'Okarun' because he has a name that is not to be said aloud.".into(),
                genres: vec!["Action".into(), "Comedy".into(), "Sci-Fi".into(), "Supernatural".into()],
                studios: vec!["Science SARU".into()],
                next_airing_episode: Some(9),
                next_airing_at: Some(now + 86400 * 2 + 14400),
                trailer_url: Some("https://www.youtube.com/watch?v=0XJxfbN36Uw".into()),
                site_url: Some("https://anilist.co/anime/171018".into()),
                source_material: Some("MANGA".into()),
                user_status: "CURRENT".into(),
                user_progress: 8,
                user_score: 90.0,
                user_repeats: 0,
                user_notes: "Science SARU storyboarding and colors are incredible.".into(),
                custom_folder: None,
                updated_at: now - 7200,
                local_episode_count: 0,
                available_episodes: vec![],
            },
            AnimeEntry {
                id: 153518,
                anilist_id: Some(153518),
                mal_id: Some(52701),
                title_romaji: "Dungeon Meshi".into(),
                title_english: Some("Delicious in Dungeon".into()),
                title_native: Some("ダンジョン飯".into()),
                synonyms: vec!["Dungeon Meshi".into()],
                format: "TV".into(),
                airing_status: "FINISHED".into(),
                episodes: Some(24),
                duration: Some(24),
                season: Some("WINTER".into()),
                season_year: Some(2024),
                average_score: Some(86),
                cover_image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx153518-7FNR7zCx22X5.jpg".into(),
                banner_image: Some("https://s4.anilist.co/file/anilistcdn/media/anime/banner/153518-c362G717B2P7.jpg".into()),
                cover_color: Some("#f59e0b".into()),
                synopsis: "After the Golden Kingdom is sunk underground by an insane magician, its king emerges, promising all of his treasure to any who defeat the magician, before crumbling to dust.".into(),
                genres: vec!["Adventure".into(), "Comedy".into(), "Fantasy".into()],
                studios: vec!["Trigger".into()],
                next_airing_episode: None,
                next_airing_at: None,
                trailer_url: None,
                site_url: Some("https://anilist.co/anime/153518".into()),
                source_material: Some("MANGA".into()),
                user_status: "CURRENT".into(),
                user_progress: 18,
                user_score: 88.0,
                user_repeats: 0,
                user_notes: "Studio Trigger worldbuilding at its finest.".into(),
                custom_folder: None,
                updated_at: now - 18000,
                local_episode_count: 0,
                available_episodes: vec![],
            },
            AnimeEntry {
                id: 161645,
                anilist_id: Some(161645),
                mal_id: Some(54492),
                title_romaji: "Kusuriya no Hitorigoto".into(),
                title_english: Some("The Apothecary Diaries".into()),
                title_native: Some("薬屋のひとりごと".into()),
                synonyms: vec!["Kusuriya".into(), "Apothecary Diaries".into()],
                format: "TV".into(),
                airing_status: "FINISHED".into(),
                episodes: Some(24),
                duration: Some(24),
                season: Some("FALL".into()),
                season_year: Some(2023),
                average_score: Some(88),
                cover_image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx161645-7I8C2721A1sV.jpg".into(),
                banner_image: Some("https://s4.anilist.co/file/anilistcdn/media/anime/banner/161645-5A2V3gA8G4zZ.jpg".into()),
                cover_color: Some("#10b981".into()),
                synopsis: "Maomao lived a peaceful life with her apothecary father. Until one day, she's sold as a lowly servant to the emperor's palace.".into(),
                genres: vec!["Drama".into(), "Mystery".into()],
                studios: vec!["OLM".into(), "TOHO animation STUDIO".into()],
                next_airing_episode: None,
                next_airing_at: None,
                trailer_url: None,
                site_url: Some("https://anilist.co/anime/161645".into()),
                source_material: Some("LIGHT_NOVEL".into()),
                user_status: "COMPLETED".into(),
                user_progress: 24,
                user_score: 92.0,
                user_repeats: 1,
                user_notes: "Maomao is one of the best protagonists in recent memory.".into(),
                custom_folder: None,
                updated_at: now - 86400,
                local_episode_count: 0,
                available_episodes: vec![],
            },
            AnimeEntry {
                id: 130003,
                anilist_id: Some(130003),
                mal_id: Some(47917),
                title_romaji: "Bocchi the Rock!".into(),
                title_english: Some("BOCCHI THE ROCK!".into()),
                title_native: Some("ぼっち・ざ・ろっく！".into()),
                synonyms: vec!["Bocchi the Rock".into(), "BTR".into()],
                format: "TV".into(),
                airing_status: "FINISHED".into(),
                episodes: Some(12),
                duration: Some(24),
                season: Some("FALL".into()),
                season_year: Some(2022),
                average_score: Some(88),
                cover_image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx130003-5Y5a3R8nF9vP.jpg".into(),
                banner_image: Some("https://s4.anilist.co/file/anilistcdn/media/anime/banner/130003-8B8f9k3wL2qR.jpg".into()),
                cover_color: Some("#ec4899".into()),
                synopsis: "Hitori Gotoh, a lonely high school girl whose heart lies in her guitar, makes no progress every day until she meets Nijika Ijichi, who is looking for a guitarist for her group 'Kessoku Band'.".into(),
                genres: vec!["Comedy".into(), "Music".into(), "Slice of Life".into()],
                studios: vec!["CloverWorks".into()],
                next_airing_episode: None,
                next_airing_at: None,
                trailer_url: None,
                site_url: Some("https://anilist.co/anime/130003".into()),
                source_material: Some("MANGA".into()),
                user_status: "COMPLETED".into(),
                user_progress: 12,
                user_score: 94.0,
                user_repeats: 2,
                user_notes: "Kessoku Band forever!".into(),
                custom_folder: None,
                updated_at: now - 172800,
                local_episode_count: 0,
                available_episodes: vec![],
            },
            AnimeEntry {
                id: 4224,
                anilist_id: Some(4224),
                mal_id: Some(4224),
                title_romaji: "Toradora!".into(),
                title_english: Some("Toradora!".into()),
                title_native: Some("とらドラ！".into()),
                synonyms: vec!["Toradora".into(), "Tiger x Dragon".into()],
                format: "TV".into(),
                airing_status: "FINISHED".into(),
                episodes: Some(25),
                duration: Some(24),
                season: Some("FALL".into()),
                season_year: Some(2008),
                average_score: Some(80),
                cover_image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx4224-3k2b8R7x9L1q.jpg".into(),
                banner_image: None,
                cover_color: Some("#f97316".into()),
                synopsis: "Ryuuji Takasu is a gentle high school student with a love for housework; but in contrast to his kind nature, he has an intimidating face that often gets him labeled as a delinquent. He meets Taiga Aisaka, the 'Palmtop Tiger'.".into(),
                genres: vec!["Comedy".into(), "Drama".into(), "Romance".into(), "Slice of Life".into()],
                studios: vec!["J.C.Staff".into()],
                next_airing_episode: None,
                next_airing_at: None,
                trailer_url: None,
                site_url: Some("https://anilist.co/anime/4224".into()),
                source_material: Some("LIGHT_NOVEL".into()),
                user_status: "COMPLETED".into(),
                user_progress: 25,
                user_score: 90.0,
                user_repeats: 3,
                user_notes: "The namesake of Taiga & Tora!".into(),
                custom_folder: None,
                updated_at: now - 250000,
                local_episode_count: 0,
                available_episodes: vec![],
            },
            AnimeEntry {
                id: 176301,
                anilist_id: Some(176301),
                mal_id: Some(58514),
                title_romaji: "Kusuriya no Hitorigoto 2nd Season".into(),
                title_english: Some("The Apothecary Diaries Season 2".into()),
                title_native: Some("薬屋のひとりごと 第2期".into()),
                synonyms: vec!["Apothecary Diaries S2".into()],
                format: "TV".into(),
                airing_status: "RELEASING".into(),
                episodes: Some(24),
                duration: Some(24),
                season: Some("WINTER".into()),
                season_year: Some(2025),
                average_score: Some(89),
                cover_image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx176301-mO8z6P2k1W9q.jpg".into(),
                banner_image: None,
                cover_color: Some("#14b8a6".into()),
                synopsis: "Second season of Kusuriya no Hitorigoto as Maomao and Jinshi uncover deeper conspiracies within the Imperial Court.".into(),
                genres: vec!["Drama".into(), "Mystery".into()],
                studios: vec!["OLM".into(), "TOHO animation STUDIO".into()],
                next_airing_episode: Some(12),
                next_airing_at: Some(now + 86400 * 4 + 7200),
                trailer_url: None,
                site_url: Some("https://anilist.co/anime/176301".into()),
                source_material: Some("LIGHT_NOVEL".into()),
                user_status: "PLANNING".into(),
                user_progress: 0,
                user_score: 0.0,
                user_repeats: 0,
                user_notes: "Queued for seasonal watch.".into(),
                custom_folder: None,
                updated_at: now - 300000,
                local_episode_count: 0,
                available_episodes: vec![],
            },
            kusuriya_s3,
        ];

        self.upsert_anime_entries_batch(&starter_entries)?;

        // Seed default Taiga-style RSS Torrent filter rules
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES ('seeded_kusuriya_s3', 'true')",
            [],
        )
        .ok();
        conn.execute(
            "INSERT INTO torrent_rules (name, enabled, anime_title_filter, release_group, resolution, exclude_keywords, action, only_unwatched)
             VALUES (?1, 1, '', 'SubsPlease', '1080p', 'Batch, 480p, Dub', 'highlight', 1)",
            params!["SubsPlease 1080p (Watching)"],
        )
        .ok();
        conn.execute(
            "INSERT INTO torrent_rules (name, enabled, anime_title_filter, release_group, resolution, exclude_keywords, action, only_unwatched)
             VALUES (?1, 1, 'Dandadan', 'Erai-raws', '1080p', '480p', 'auto_download', 1)",
            params!["Dandadan - Erai-raws 1080p Auto"],
        )
        .ok();

        Ok(())
    }

    pub fn upsert_anime_entry(&self, entry: &AnimeEntry) -> Result<(), String> {
        self.upsert_anime_entries_batch(std::slice::from_ref(entry))
    }

    /// Batch upsert anime entries inside a single fast transaction.
    pub fn upsert_anime_entries_batch(&self, entries: &[AnimeEntry]) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO anime_entries (
                        id, anilist_id, mal_id, title_romaji, title_english, title_native,
                        synonyms_json, normalized_titles_json, format, airing_status, episodes,
                        duration, season, season_year, average_score, cover_image, banner_image,
                        cover_color, synopsis, genres_json, studios_json, next_airing_episode,
                        next_airing_at, trailer_url, site_url, source_material, user_status,
                        user_progress, user_score, user_repeats, user_notes, custom_folder, updated_at
                    ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                        ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
                        ?31, ?32, ?33
                    )
                    ON CONFLICT(id) DO UPDATE SET
                        anilist_id = excluded.anilist_id,
                        mal_id = COALESCE(excluded.mal_id, anime_entries.mal_id),
                        title_romaji = excluded.title_romaji,
                        title_english = excluded.title_english,
                        title_native = excluded.title_native,
                        synonyms_json = excluded.synonyms_json,
                        normalized_titles_json = excluded.normalized_titles_json,
                        format = excluded.format,
                        airing_status = excluded.airing_status,
                        episodes = excluded.episodes,
                        duration = excluded.duration,
                        season = excluded.season,
                        season_year = excluded.season_year,
                        average_score = excluded.average_score,
                        cover_image = CASE WHEN excluded.cover_image != '' THEN excluded.cover_image ELSE anime_entries.cover_image END,
                        banner_image = COALESCE(excluded.banner_image, anime_entries.banner_image),
                        cover_color = COALESCE(excluded.cover_color, anime_entries.cover_color),
                        synopsis = CASE WHEN excluded.synopsis != '' THEN excluded.synopsis ELSE anime_entries.synopsis END,
                        genres_json = excluded.genres_json,
                        studios_json = excluded.studios_json,
                        next_airing_episode = excluded.next_airing_episode,
                        next_airing_at = excluded.next_airing_at,
                        trailer_url = COALESCE(excluded.trailer_url, anime_entries.trailer_url),
                        site_url = COALESCE(excluded.site_url, anime_entries.site_url),
                        source_material = COALESCE(excluded.source_material, anime_entries.source_material),
                        user_status = excluded.user_status,
                        user_progress = excluded.user_progress,
                        user_score = excluded.user_score,
                        user_repeats = excluded.user_repeats,
                        user_notes = excluded.user_notes,
                        custom_folder = COALESCE(excluded.custom_folder, anime_entries.custom_folder),
                        updated_at = excluded.updated_at",
                )
                .map_err(|e| e.to_string())?;

            for entry in entries {
                let norm_titles = Self::build_normalized_titles(
                    &entry.title_romaji,
                    entry.title_english.as_deref(),
                    entry.title_native.as_deref(),
                    &entry.synonyms,
                );
                let synonyms_json =
                    serde_json::to_string(&entry.synonyms).unwrap_or_else(|_| "[]".into());
                let norm_json =
                    serde_json::to_string(&norm_titles).unwrap_or_else(|_| "[]".into());
                let genres_json =
                    serde_json::to_string(&entry.genres).unwrap_or_else(|_| "[]".into());
                let studios_json =
                    serde_json::to_string(&entry.studios).unwrap_or_else(|_| "[]".into());

                stmt.execute(params![
                    entry.id,
                    entry.anilist_id,
                    entry.mal_id,
                    entry.title_romaji,
                    entry.title_english,
                    entry.title_native,
                    synonyms_json,
                    norm_json,
                    entry.format,
                    entry.airing_status,
                    entry.episodes,
                    entry.duration,
                    entry.season,
                    entry.season_year,
                    entry.average_score,
                    entry.cover_image,
                    entry.banner_image,
                    entry.cover_color,
                    entry.synopsis,
                    genres_json,
                    studios_json,
                    entry.next_airing_episode,
                    entry.next_airing_at,
                    entry.trailer_url,
                    entry.site_url,
                    entry.source_material,
                    entry.user_status,
                    entry.user_progress,
                    entry.user_score,
                    entry.user_repeats,
                    entry.user_notes,
                    entry.custom_folder,
                    entry.updated_at,
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Fetch a single AnimeEntry by ID in O(1) without loading the entire anime_entries table.
    pub fn get_anime_entry_by_id(&self, anime_id: i64) -> Result<AnimeEntry, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut avail: Vec<u32> = Vec::new();
        {
            let mut ep_stmt = conn
                .prepare(
                    "SELECT DISTINCT episode_number FROM local_episodes
                     WHERE matched_anime_id = ?1 AND episode_number IS NOT NULL
                     ORDER BY episode_number ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = ep_stmt
                .query_map(params![anime_id], |r| r.get::<_, u32>(0))
                .map_err(|e| e.to_string())?;
            for ep in rows.flatten() {
                avail.push(ep);
            }
        }

        conn.query_row(
            "SELECT
                id, anilist_id, mal_id, title_romaji, title_english, title_native,
                synonyms_json, format, airing_status, episodes, duration, season,
                season_year, average_score, cover_image, banner_image, cover_color,
                synopsis, genres_json, studios_json, next_airing_episode, next_airing_at,
                trailer_url, site_url, source_material, user_status, user_progress,
                user_score, user_repeats, user_notes, custom_folder, updated_at
             FROM anime_entries
             WHERE id = ?1",
            params![anime_id],
            |row| {
                let id: i64 = row.get(0)?;
                let synonyms_str: String = row.get(6)?;
                let genres_str: String = row.get(18)?;
                let studios_str: String = row.get(19)?;
                Ok(AnimeEntry {
                    id,
                    anilist_id: row.get(1)?,
                    mal_id: row.get(2)?,
                    title_romaji: row.get(3)?,
                    title_english: row.get(4)?,
                    title_native: row.get(5)?,
                    synonyms: serde_json::from_str(&synonyms_str).unwrap_or_default(),
                    format: row.get(7)?,
                    airing_status: row.get(8)?,
                    episodes: row.get(9)?,
                    duration: row.get(10)?,
                    season: row.get(11)?,
                    season_year: row.get(12)?,
                    average_score: row.get(13)?,
                    cover_image: row.get(14)?,
                    banner_image: row.get(15)?,
                    cover_color: row.get(16)?,
                    synopsis: row.get(17)?,
                    genres: serde_json::from_str(&genres_str).unwrap_or_default(),
                    studios: serde_json::from_str(&studios_str).unwrap_or_default(),
                    next_airing_episode: row.get(20)?,
                    next_airing_at: row.get(21)?,
                    trailer_url: row.get(22)?,
                    site_url: row.get(23)?,
                    source_material: row.get(24)?,
                    user_status: row.get(25)?,
                    user_progress: row.get(26)?,
                    user_score: row.get(27)?,
                    user_repeats: row.get(28)?,
                    user_notes: row.get(29)?,
                    custom_folder: row.get(30)?,
                    updated_at: row.get(31)?,
                    local_episode_count: avail.len() as u32,
                    available_episodes: avail,
                })
            },
        )
        .map_err(|e| format!("Anime entry not found: {}", e))
    }

    pub fn list_anime_entries(&self) -> Result<Vec<AnimeEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Build map of matched local episodes per anime_id
        let mut ep_map: HashMap<i64, Vec<u32>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT matched_anime_id, episode_number FROM local_episodes WHERE matched_anime_id IS NOT NULL",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Option<u32>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                let entry = ep_map.entry(r.0).or_default();
                if let Some(ep) = r.1 {
                    if !entry.contains(&ep) {
                        entry.push(ep);
                    }
                }
            }
        }
        for eps in ep_map.values_mut() {
            eps.sort_unstable();
        }

        let mut stmt = conn
            .prepare(
                "SELECT
                    id, anilist_id, mal_id, title_romaji, title_english, title_native,
                    synonyms_json, format, airing_status, episodes, duration, season,
                    season_year, average_score, cover_image, banner_image, cover_color,
                    synopsis, genres_json, studios_json, next_airing_episode, next_airing_at,
                    trailer_url, site_url, source_material, user_status, user_progress,
                    user_score, user_repeats, user_notes, custom_folder, updated_at
                 FROM anime_entries
                 ORDER BY updated_at DESC, title_romaji ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let synonyms_str: String = row.get(6)?;
                let genres_str: String = row.get(18)?;
                let studios_str: String = row.get(19)?;
                let avail = ep_map.get(&id).cloned().unwrap_or_default();
                Ok(AnimeEntry {
                    id,
                    anilist_id: row.get(1)?,
                    mal_id: row.get(2)?,
                    title_romaji: row.get(3)?,
                    title_english: row.get(4)?,
                    title_native: row.get(5)?,
                    synonyms: serde_json::from_str(&synonyms_str).unwrap_or_default(),
                    format: row.get(7)?,
                    airing_status: row.get(8)?,
                    episodes: row.get(9)?,
                    duration: row.get(10)?,
                    season: row.get(11)?,
                    season_year: row.get(12)?,
                    average_score: row.get(13)?,
                    cover_image: row.get(14)?,
                    banner_image: row.get(15)?,
                    cover_color: row.get(16)?,
                    synopsis: row.get(17)?,
                    genres: serde_json::from_str(&genres_str).unwrap_or_default(),
                    studios: serde_json::from_str(&studios_str).unwrap_or_default(),
                    next_airing_episode: row.get(20)?,
                    next_airing_at: row.get(21)?,
                    trailer_url: row.get(22)?,
                    site_url: row.get(23)?,
                    source_material: row.get(24)?,
                    user_status: row.get(25)?,
                    user_progress: row.get(26)?,
                    user_score: row.get(27)?,
                    user_repeats: row.get(28)?,
                    user_notes: row.get(29)?,
                    custom_folder: row.get(30)?,
                    updated_at: row.get(31)?,
                    local_episode_count: avail.len() as u32,
                    available_episodes: avail,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut list = Vec::new();
        for item in rows {
            list.push(item.map_err(|e| e.to_string())?);
        }
        Ok(list)
    }

    pub fn update_anime_user_state(
        &self,
        anime_id: i64,
        user_status: &str,
        user_progress: u32,
        user_score: f64,
        user_repeats: u32,
        user_notes: &str,
        custom_folder: Option<String>,
        synonyms: Option<Vec<String>>,
    ) -> Result<(AnimeEntry, bool), String> {
        let now = chrono::Utc::now().timestamp();
        let mut needs_full_rematch = false;

        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;

            let (old_folder, old_syns_json): (Option<String>, String) = conn
                .query_row(
                    "SELECT custom_folder, synonyms_json FROM anime_entries WHERE id = ?1",
                    params![anime_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or((None, "[]".to_string()));

            let norm_old_folder = old_folder
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());
            let norm_new_folder = custom_folder
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());

            if norm_old_folder != norm_new_folder {
                needs_full_rematch = true;
            }

            if let Some(syns) = synonyms {
                let syns_json = serde_json::to_string(&syns).unwrap_or_else(|_| "[]".into());
                if syns_json != old_syns_json {
                    needs_full_rematch = true;
                    let (romaji, english, native): (String, Option<String>, Option<String>) = conn
                        .query_row(
                            "SELECT title_romaji, title_english, title_native FROM anime_entries WHERE id = ?1",
                            params![anime_id],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                        )
                        .map_err(|e| e.to_string())?;
                    let norm = Self::build_normalized_titles(
                        &romaji,
                        english.as_deref(),
                        native.as_deref(),
                        &syns,
                    );
                    let norm_json = serde_json::to_string(&norm).unwrap_or_else(|_| "[]".into());
                    conn.execute(
                        "UPDATE anime_entries SET synonyms_json = ?1, normalized_titles_json = ?2 WHERE id = ?3",
                        params![syns_json, norm_json, anime_id],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }

            conn.execute(
                "UPDATE anime_entries SET
                    user_status = ?1,
                    user_progress = ?2,
                    user_score = ?3,
                    user_repeats = ?4,
                    user_notes = ?5,
                    custom_folder = ?6,
                    updated_at = ?7
                 WHERE id = ?8",
                params![
                    user_status,
                    user_progress,
                    user_score,
                    user_repeats,
                    user_notes,
                    custom_folder,
                    now,
                    anime_id
                ],
            )
            .map_err(|e| e.to_string())?;

            // Fast O(1) indexed update of watched status for local episodes of this specific anime
            conn.execute(
                "UPDATE local_episodes
                 SET watched = CASE WHEN episode_number IS NOT NULL AND episode_number <= ?1 THEN 1 ELSE 0 END
                 WHERE matched_anime_id = ?2",
                params![user_progress, anime_id],
            )
            .map_err(|e| e.to_string())?;
        }

        let entry = self.get_anime_entry_by_id(anime_id)?;
        Ok((entry, needs_full_rematch))
    }

    pub fn delete_anime_entry(&self, anime_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE local_episodes SET matched_anime_id = NULL WHERE matched_anime_id = ?1",
            params![anime_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM anime_entries WHERE id = ?1", params![anime_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Build an in-memory AnimeMatcherIndex in a single SQL pass for ultra-fast batch matching.
    pub fn build_matcher_index(&self) -> Result<AnimeMatcherIndex, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut by_id = HashMap::new();
        let mut external_ids = HashMap::new();
        let mut by_anilist_id = HashMap::new();
        let mut by_mal_id = HashMap::new();
        let mut user_aliases = HashMap::new();
        let mut exact_norm = HashMap::new();
        let mut custom_folders = Vec::new();
        let mut norm_list = Vec::new();

        {
            let mut stmt = conn
                .prepare(
                    "SELECT id, anilist_id, mal_id, title_romaji, title_english, title_native,
                            synonyms_json, cover_image, user_progress, episodes, custom_folder
                     FROM anime_entries",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, u32>(8)?,
                        r.get::<_, Option<u32>>(9)?,
                        r.get::<_, Option<String>>(10)?,
                    ))
                })
                .map_err(|e| e.to_string())?;

            for row in rows.flatten() {
                let (
                    id,
                    anilist_id,
                    mal_id,
                    romaji,
                    english,
                    native,
                    syns_json,
                    cover,
                    prog,
                    eps,
                    cfolder,
                ) = row;
                let syns: Vec<String> = serde_json::from_str(&syns_json).unwrap_or_default();
                let norms = Self::build_normalized_titles(
                    &romaji,
                    english.as_deref(),
                    native.as_deref(),
                    &syns,
                );
                let mut effective_season = extract_effective_season(&romaji);
                if effective_season == 1 {
                    if let Some(eng) = english.as_deref() {
                        effective_season = extract_effective_season(eng);
                    }
                }

                by_id.insert(id, (romaji, cover, prog, eps));
                external_ids.insert(id, (anilist_id, mal_id, effective_season));
                if let Some(aid) = anilist_id {
                    by_anilist_id.insert(aid, id);
                }
                if let Some(mid) = mal_id {
                    by_mal_id.insert(mid, id);
                }
                if let Some(cf) = cfolder.filter(|s| !s.trim().is_empty()) {
                    custom_folders.push((cf.to_ascii_lowercase(), id));
                }
                for n in norms {
                    if !n.is_empty() {
                        let s = extract_effective_season(&n).max(effective_season);
                        exact_norm.entry(n.clone()).or_insert(id);
                        if n.len() >= 4 {
                            norm_list.push((n, s, id));
                        }
                    }
                }
            }
        }

        // Load explicit user title aliases (override exact_norm)
        {
            let mut alias_stmt = conn
                .prepare("SELECT normalized_alias, anime_id FROM title_aliases")
                .map_err(|e| e.to_string())?;
            let rows = alias_stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for (alias, aid) in rows.flatten() {
                if by_id.contains_key(&aid) {
                    user_aliases.insert(alias.clone(), aid);
                    exact_norm.insert(alias, aid);
                }
            }
        }

        Ok(AnimeMatcherIndex {
            by_id,
            external_ids,
            by_anilist_id,
            by_mal_id,
            user_aliases,
            exact_norm,
            custom_folders,
            norm_list,
        })
    }

    /// Save a title relation / alias for an anime entry so that subsequent episodes with this title
    /// automatically match this entry. Updates both `title_aliases` and the anime's `synonyms`.
    pub fn link_alias_to_anime(
        &self,
        anime_id: i64,
        alias_title: &str,
    ) -> Result<AnimeEntry, String> {
        let trimmed = alias_title.trim();
        if trimmed.is_empty() {
            return Err("Alias title cannot be empty".into());
        }
        let norm_alias = normalize_anime_title(trimmed);

        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            if !norm_alias.is_empty() {
                conn.execute(
                    "INSERT OR REPLACE INTO title_aliases (normalized_alias, anime_id) VALUES (?1, ?2)",
                    params![norm_alias, anime_id],
                )
                .map_err(|e| e.to_string())?;
            }

            let (romaji, english, native, syns_json): (
                String,
                Option<String>,
                Option<String>,
                String,
            ) = conn
                .query_row(
                    "SELECT title_romaji, title_english, title_native, synonyms_json
                     FROM anime_entries WHERE id = ?1",
                    params![anime_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .map_err(|e| format!("Anime entry not found: {}", e))?;

            let mut syns: Vec<String> = serde_json::from_str(&syns_json).unwrap_or_default();
            let already_exists = romaji.eq_ignore_ascii_case(trimmed)
                || english
                    .as_deref()
                    .map_or(false, |e| e.eq_ignore_ascii_case(trimmed))
                || syns.iter().any(|s| s.eq_ignore_ascii_case(trimmed));

            if !already_exists {
                syns.push(trimmed.to_string());
                let new_syns_json =
                    serde_json::to_string(&syns).unwrap_or_else(|_| "[]".into());
                let norms = Self::build_normalized_titles(
                    &romaji,
                    english.as_deref(),
                    native.as_deref(),
                    &syns,
                );
                let new_norms_json =
                    serde_json::to_string(&norms).unwrap_or_else(|_| "[]".into());
                conn.execute(
                    "UPDATE anime_entries SET synonyms_json = ?1, normalized_titles_json = ?2 WHERE id = ?3",
                    params![new_syns_json, new_norms_json, anime_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        let _ = self.rematch_all_local_episodes();
        self.get_anime_entry_by_id(anime_id)
    }

    /// Match a single normalized title or file path to an AnimeEntry in the database.
    pub fn match_title_to_anime(
        &self,
        normalized_title: &str,
        file_path: Option<&str>,
    ) -> Option<(i64, String, String, u32, Option<u32>)> {
        let index = self.build_matcher_index().ok()?;
        index.match_title(normalized_title, file_path)
    }

    /// Match a parsed `AnitomyElements` to an AnimeEntry in the database, applying episode bounds validation
    /// and `erengy/anime-relations` redirections when needed.
    pub fn match_episode_to_anime(
        &self,
        parsed: &mut AnitomyElements,
        file_path: Option<&str>,
    ) -> Option<(i64, String, String, u32, Option<u32>)> {
        let index = self.build_matcher_index().ok()?;
        index.match_episode(parsed, file_path)
    }

    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = 'main'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match raw {
            Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
            None => {
                let def = AppSettings::default();
                let json = serde_json::to_string(&def).map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES ('main', ?1)",
                    params![json],
                )
                .map_err(|e| e.to_string())?;
                Ok(def)
            }
        }
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string(settings).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES ('main', ?1)",
            params![json],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_watch_history(
        &self,
        anime_id: Option<i64>,
        anime_title: &str,
        episode_number: u32,
        player_name: &str,
        file_name: &str,
        scrobbled: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO watch_history (anime_id, anime_title, episode_number, player_name, file_name, scrobbled_to_tracker, timestamp_unix)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                anime_id,
                anime_title,
                episode_number,
                player_name,
                file_name,
                scrobbled as i32,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_watch_history(&self, limit: u32) -> Result<Vec<WatchHistoryEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, anime_id, anime_title, episode_number, player_name, file_name, scrobbled_to_tracker, timestamp_unix
                 FROM watch_history ORDER BY timestamp_unix DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(WatchHistoryEntry {
                    id: r.get(0)?,
                    anime_id: r.get(1)?,
                    anime_title: r.get(2)?,
                    episode_number: r.get(3)?,
                    player_name: r.get(4)?,
                    file_name: r.get(5)?,
                    scrobbled_to_tracker: r.get::<_, i32>(6)? != 0,
                    timestamp_unix: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    }

    pub fn list_torrent_rules(&self) -> Result<Vec<TorrentRule>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, enabled, anime_title_filter, anime_id, release_group, resolution, exclude_keywords, action, only_unwatched
                 FROM torrent_rules ORDER BY id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TorrentRule {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    enabled: r.get::<_, i32>(2)? != 0,
                    anime_title_filter: r.get(3)?,
                    anime_id: r.get(4)?,
                    release_group: r.get(5)?,
                    resolution: r.get(6)?,
                    exclude_keywords: r.get(7)?,
                    action: r.get(8)?,
                    only_unwatched: r.get::<_, i32>(9)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    }

    pub fn save_torrent_rule(&self, rule: &TorrentRule) -> Result<Vec<TorrentRule>, String> {
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            if rule.id > 0 {
                conn.execute(
                    "UPDATE torrent_rules SET
                        name = ?1, enabled = ?2, anime_title_filter = ?3, anime_id = ?4,
                        release_group = ?5, resolution = ?6, exclude_keywords = ?7,
                        action = ?8, only_unwatched = ?9
                     WHERE id = ?10",
                    params![
                        rule.name,
                        rule.enabled as i32,
                        rule.anime_title_filter,
                        rule.anime_id,
                        rule.release_group,
                        rule.resolution,
                        rule.exclude_keywords,
                        rule.action,
                        rule.only_unwatched as i32,
                        rule.id
                    ],
                )
                .map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "INSERT INTO torrent_rules (name, enabled, anime_title_filter, anime_id, release_group, resolution, exclude_keywords, action, only_unwatched)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        rule.name,
                        rule.enabled as i32,
                        rule.anime_title_filter,
                        rule.anime_id,
                        rule.release_group,
                        rule.resolution,
                        rule.exclude_keywords,
                        rule.action,
                        rule.only_unwatched as i32,
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        self.list_torrent_rules()
    }

    pub fn delete_torrent_rule(&self, rule_id: i64) -> Result<Vec<TorrentRule>, String> {
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM torrent_rules WHERE id = ?1", params![rule_id])
                .map_err(|e| e.to_string())?;
        }
        self.list_torrent_rules()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detection::anitomy::parse_filename;

    #[test]
    fn test_fuzzy_matching_and_alias_linking() {
        let tmp_dir = std::env::temp_dir().join("tora_test_db_fuzzy");
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let db_path = tmp_dir.join("test.db");
        let db = Database::open(&db_path).expect("open test db");

        // 1. "[Judas] Kusuriya - S03E03.mkv" matches "Kusuriya no Hitorigoto 3rd Season"
        let mut parsed_s3 = parse_filename("[Judas] Kusuriya - S03E03.mkv");
        let m_s3 = db
            .match_episode_to_anime(&mut parsed_s3, None)
            .expect("should match Kusuriya S3");
        assert_eq!(m_s3.0, 195516);
        assert_eq!(m_s3.1, "Kusuriya no Hitorigoto 3rd Season");
        assert_eq!(parsed_s3.episode_number, Some(3));

        // 2. Direct fuzzy match on abbreviated title with season ("kusuriya 2" -> "Kusuriya no Hitorigoto 2nd Season")
        let m_s2 = db
            .match_title_to_anime("kusuriya 2", None)
            .expect("fuzzy match kusuriya 2");
        assert_eq!(m_s2.0, 176301);
        assert_eq!(m_s2.1, "Kusuriya no Hitorigoto 2nd Season");

        // 3. Season 2 of Bocchi the Rock! does not falsely match Season 1
        let mut bocchi_s2 = parse_filename(
            "[EMBER] Bocchi the Rock! - S02E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
        );
        assert!(db.match_episode_to_anime(&mut bocchi_s2, None).is_none());

        // 4. Linking an unmatched alias saves the relation for subsequent episodes
        let mut custom_ep1 = parse_filename("[SomeGroup] MyCustomFrierenAlias - 05 [1080p].mkv");
        assert!(db.match_episode_to_anime(&mut custom_ep1, None).is_none());

        let updated_entry = db
            .link_alias_to_anime(154587, &custom_ep1.anime_title)
            .expect("link alias");
        assert!(updated_entry
            .synonyms
            .iter()
            .any(|s| s == "MyCustomFrierenAlias"));

        let mut custom_ep2 = parse_filename("[SomeGroup] MyCustomFrierenAlias - 06 [1080p].mkv");
        let matched_ep2 = db
            .match_episode_to_anime(&mut custom_ep2, None)
            .expect("subsequent episode should match after linking");
        assert_eq!(matched_ep2.0, 154587);
        assert_eq!(matched_ep2.1, "Sousou no Frieren");

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
