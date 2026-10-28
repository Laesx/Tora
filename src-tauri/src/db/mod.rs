use crate::detection::anisthesia::{default_players, PlayerDefinition};
use crate::detection::anitomy::{extract_effective_season, normalize_anime_title, AnitomyElements};
use crate::detection::relations::relations_db;
use crate::plugins::{AiringScheduleItem, SeasonalAnime};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

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
    /// Airing start / end as AniList fuzzy dates: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (sorts lexicographically).
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    // User list fields
    pub user_status: String,
    pub user_progress: u32,
    pub user_score: f64,
    pub user_repeats: u32,
    pub user_notes: String,
    #[serde(default)]
    pub user_started_at: Option<String>,
    #[serde(default)]
    pub user_completed_at: Option<String>,
    pub custom_folder: Option<String>,
    pub updated_at: i64,
    // Computed local library fields
    pub local_episode_count: u32,
    pub available_episodes: Vec<u32>,
    // Tracker sync bookkeeping
    /// `true` while a local change has not been confirmed by the tracker yet.
    #[serde(default)]
    pub sync_pending: bool,
    /// AniList `MediaList.id` of this entry (needed for deletes).
    #[serde(default)]
    pub anilist_list_entry_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchAnimeUpdatePatch {
    pub anime_ids: Vec<i64>,
    pub user_status: Option<String>,
    pub user_progress: Option<u32>,
    pub progress_delta: Option<i32>,
    pub mark_completed_progress: Option<bool>,
    pub user_score: Option<f64>,
    pub user_repeats: Option<u32>,
    pub user_notes: Option<String>,
    pub notes_mode: Option<String>, // "replace" | "append"
    pub user_started_at: Option<String>, // Some("") clears, Some("YYYY-MM-DD") sets, None leaves unchanged
    pub user_completed_at: Option<String>, // Some("") clears, Some("YYYY-MM-DD") sets, None leaves unchanged
}

/// Fully resolved user-list state for one entry (output of `sync::normalize_change`), ready to be written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedState {
    pub user_status: String,
    pub user_progress: u32,
    pub user_score: f64,
    pub user_repeats: u32,
    pub user_notes: String,
    /// Final value (`None` = no date).
    pub user_started_at: Option<String>,
    /// Final value (`None` = no date).
    pub user_completed_at: Option<String>,
    /// Final value (full replace).
    pub custom_folder: Option<String>,
    /// `Some` replaces the synonym list; `None` leaves it unchanged.
    pub synonyms: Option<Vec<String>>,
}

/// Outcome of [`Database::merge_remote_list`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MergeStats {
    pub added: usize,
    /// Existing entries whose user fields were replaced by (different) remote ones.
    pub updated_from_remote: usize,
    /// Existing entries whose (different) local user fields were kept (pending or newer locally).
    pub kept_local: usize,
    pub deleted: usize,
    pub deletion_skipped_reason: Option<String>,
    /// Local ids of every row inserted or written by this merge (new + changed).
    pub changed_ids: Vec<i64>,
    /// Local ids deleted because they are missing on the tracker.
    pub removed_ids: Vec<i64>,
    /// Local ids of newly inserted entries (need full metadata + matching).
    pub new_ids: Vec<i64>,
    /// Local ids whose matchable titles changed (new entries + title / synonym changes).
    pub rematch_ids: Vec<i64>,
}

/// A queued tracker-side deletion (tombstone) for an entry already deleted locally.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingDeletion {
    pub media_id: i64,
    pub list_entry_id: Option<i64>,
    pub title: String,
}

/// A season stored in `seasonal_cache` (without its payload).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedSeason {
    pub season: String,
    pub year: u32,
    pub fetched_at: i64,
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

/// One fuzzy-matchable normalized title in [`AnimeMatcherIndex::norm_list`].
#[derive(Debug, Clone)]
pub struct NormTitle {
    /// Full normalized title (e.g. `"kusuriya no hitorigoto 2"`).
    pub norm: String,
    /// Season-stripped core title, precomputed at build time (e.g. `"kusuriya no hitorigoto"`).
    pub core: String,
    /// Effective season of this title / entry.
    pub season: u32,
    pub anime_id: i64,
}

/// Title-step result of [`AnimeMatcherIndex::match_title`]: `(anime_id, title_romaji, cover, user_progress, episodes)`.
pub type TitleMatch = (i64, String, String, u32, Option<u32>);

/// Fast in-memory matcher index built from a single SQL pass so batch episode/torrent matching is O(1) with zero DB queries per item.
pub struct AnimeMatcherIndex {
    pub by_id: HashMap<i64, (String, String, u32, Option<u32>)>,
    pub external_ids: HashMap<i64, (Option<i64>, Option<i64>, u32)>,
    pub by_anilist_id: HashMap<i64, i64>,
    pub by_mal_id: HashMap<i64, i64>,
    pub user_aliases: HashMap<String, i64>,
    pub exact_norm: HashMap<String, i64>,
    pub custom_folders: Vec<(String, i64)>,
    pub norm_list: Vec<NormTitle>,
}

impl AnimeMatcherIndex {
    pub fn title_match_for(&self, aid: i64) -> Option<TitleMatch> {
        self.by_id
            .get(&aid)
            .map(|(t, cov, prog, eps)| (aid, t.clone(), cov.clone(), *prog, *eps))
    }

    /// Step 1 of [`Self::match_title`]: the first custom folder whose (lowercased) path prefixes `file_path`.
    pub fn match_custom_folder(&self, file_path: &str) -> Option<i64> {
        if self.custom_folders.is_empty() {
            return None;
        }
        let fp_lower = file_path.to_ascii_lowercase();
        self.custom_folders
            .iter()
            .find(|(folder_prefix, aid)| {
                fp_lower.starts_with(folder_prefix.as_str()) && self.by_id.contains_key(aid)
            })
            .map(|(_, aid)| *aid)
    }

    /// Steps 2-4 of [`Self::match_title`] (no custom folder check): user aliases, exact normalized titles,
    /// then season-isolated fuzzy matching. Depends only on `normalized_title`, so callers can memoize it.
    pub fn match_title_only(&self, normalized_title: &str) -> Option<i64> {
        if normalized_title.is_empty() {
            return None;
        }

        // 2. O(1) explicit user-linked alias lookup
        if let Some(aid) = self.user_aliases.get(normalized_title) {
            if self.by_id.contains_key(aid) {
                return Some(*aid);
            }
        }

        // 3. O(1) exact normalized title lookup
        if let Some(aid) = self.exact_norm.get(normalized_title) {
            if self.by_id.contains_key(aid) {
                return Some(*aid);
            }
        }

        // 4. Season-isolated fuzzy matching across anime names and alternative titles
        // Never allow a Season 2/3 query (e.g. "kusuriya 3" or "bocchi rock 2") to match a Season 1 entry.
        let query_season = extract_effective_season(normalized_title);
        let query_core = strip_trailing_season(normalized_title, query_season);

        if query_core.len() >= 4 {
            let mut best_match: Option<(f64, i64)> = None;
            for cand in &self.norm_list {
                if cand.season != query_season {
                    continue;
                }
                let score = compute_core_title_similarity(query_core, &cand.core);
                if score >= 0.74 && best_match.map_or(true, |(best_score, _)| score > best_score) {
                    best_match = Some((score, cand.anime_id));
                }
            }

            if let Some((_, aid)) = best_match {
                if self.by_id.contains_key(&aid) {
                    return Some(aid);
                }
            }
        }

        None
    }

    pub fn match_title(&self, normalized_title: &str, file_path: Option<&str>) -> Option<TitleMatch> {
        // 1. Check custom folder prefix match
        if let Some(aid) = file_path.and_then(|fp| self.match_custom_folder(fp)) {
            return self.title_match_for(aid);
        }
        let aid = self.match_title_only(normalized_title)?;
        self.title_match_for(aid)
    }

    /// Match a parsed `AnitomyElements` against the index, validating episode bounds and applying
    /// `erengy/anime-relations` ID redirections or multi-season sequential episode offsets (ported from Taiga's `identify`).
    /// Equivalent to [`Self::match_title`] followed by [`Self::resolve_episode`].
    pub fn match_episode(
        &self,
        parsed: &mut AnitomyElements,
        file_path: Option<&str>,
    ) -> Option<TitleMatch> {
        let matched = self.match_title(&parsed.normalized_title, file_path)?;
        self.resolve_episode(matched, parsed, file_path)
    }

    /// Episode step of [`Self::match_episode`]: given the title match for `parsed.normalized_title` / `file_path`,
    /// validate the episode number and apply relations / multi-season redirections (may rewrite `parsed`).
    pub fn resolve_episode(
        &self,
        title_match: TitleMatch,
        parsed: &mut AnitomyElements,
        file_path: Option<&str>,
    ) -> Option<TitleMatch> {
        let (aid, title, cover, prog, eps) = title_match;

        let Some(ep) = parsed.episode_number else {
            return Some((aid, title, cover, prog, eps));
        };

        // Check if this match came from an explicit user binding (custom folder or title_aliases)
        let is_explicit_binding = self.user_aliases.contains_key(&parsed.normalized_title)
            || file_path.map_or(false, |fp| {
                let fp_lower = fp.to_ascii_lowercase();
                self.custom_folders
                    .iter()
                    .any(|(prefix, id)| *id == aid && fp_lower.starts_with(prefix))
            });

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
            let dst_aid = red
                .dst_anilist_id
                .and_then(|id| self.by_anilist_id.get(&id).copied())
                .or_else(|| {
                    red.dst_mal_id
                        .and_then(|id| self.by_mal_id.get(&id).copied())
                })
                .or_else(|| self.user_aliases.get(&red.dst_norm_title).copied())
                .or_else(|| self.exact_norm.get(&red.dst_norm_title).copied())
                .or_else(|| self.match_title(&red.dst_norm_title, None).map(|m| m.0));

            if let Some(target_id) = dst_aid {
                if let Some((t, cov, p, e)) = self.by_id.get(&target_id) {
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
                    return Some((target_id, t.clone(), cov.clone(), *p, *e));
                }
            }

            if is_explicit_binding || ep == 0 {
                return Some((aid, title, cover, prog, eps));
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

        if is_explicit_binding || ep == 0 {
            return Some((aid, title, cover, prog, eps));
        }

        None
    }
}

pub struct Database {
    /// Write connection (also used for reads that must see the caller's own open transaction).
    pub conn: Mutex<Connection>,
    /// Read-only (`PRAGMA query_only`) connection on the same WAL file for hot UI reads, so they don't queue
    /// behind sync / scan writes. `None` for in-memory databases (tests): reads then use `conn`.
    read_conn: Option<Mutex<Connection>>,
    /// Cached matcher index tagged with the `matcher_generation` it was built at.
    matcher_cache: RwLock<Option<(u64, Arc<AnimeMatcherIndex>)>>,
    /// Bumped by the SQLite update hook on every row change in `anime_entries` / `title_aliases`.
    matcher_generation: Arc<AtomicU64>,
}

/// AniList ids of the demo entries the removed seed used to insert.
const SEEDED_ANIME_IDS: [i64; 8] = [
    195516, 154587, 171018, 153518, 161645, 130003, 4224, 176301,
];
/// Exact names of the demo torrent rules the removed seed used to insert.
const SEEDED_TORRENT_RULE_NAMES: [&str; 2] = [
    "SubsPlease 1080p (Watching)",
    "Dandadan - Erai-raws 1080p Auto",
];
const SEED_MARKER_KEY: &str = "seeded_kusuriya_s3";

/// `watch_history.player_name` of rows logged from manual progress changes (not a media player).
pub const MANUAL_HISTORY_PLAYER: &str = "Manual";

/// Column list used by every `anime_entries` insert (39 columns, bound as ?1..?39).
const ENTRY_INSERT_COLUMNS: &str = "id, anilist_id, mal_id, title_romaji, title_english, title_native,
    synonyms_json, normalized_titles_json, format, airing_status, episodes,
    duration, season, season_year, average_score, cover_image, banner_image,
    cover_color, synopsis, genres_json, studios_json, next_airing_episode,
    next_airing_at, trailer_url, site_url, source_material, user_status,
    user_progress, user_score, user_repeats, user_notes, user_started_at,
    user_completed_at, custom_folder, updated_at, sync_pending, anilist_list_entry_id,
    start_date, end_date";

/// Metadata refreshed on conflict regardless of who wins the user fields.
/// `custom_folder` is always preserved unless the incoming row sets one; `sync_pending` is never touched here.
const ENTRY_METADATA_UPDATE: &str = "anilist_id = COALESCE(excluded.anilist_id, anime_entries.anilist_id),
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
    start_date = COALESCE(excluded.start_date, anime_entries.start_date),
    end_date = COALESCE(excluded.end_date, anime_entries.end_date),
    custom_folder = COALESCE(excluded.custom_folder, anime_entries.custom_folder),
    anilist_list_entry_id = COALESCE(excluded.anilist_list_entry_id, anime_entries.anilist_list_entry_id)";

/// User-list fields overwritten on conflict when the incoming row wins.
const ENTRY_USER_FIELDS_UPDATE: &str = "user_status = excluded.user_status,
    user_progress = excluded.user_progress,
    user_score = excluded.user_score,
    user_repeats = excluded.user_repeats,
    user_notes = excluded.user_notes,
    user_started_at = excluded.user_started_at,
    user_completed_at = excluded.user_completed_at,
    updated_at = excluded.updated_at";

static UPSERT_OVERWRITE_SQL: Lazy<String> = Lazy::new(|| {
    format!(
        "INSERT INTO anime_entries ({ENTRY_INSERT_COLUMNS}) VALUES ({}) ON CONFLICT(id) DO UPDATE SET {ENTRY_METADATA_UPDATE}, {ENTRY_USER_FIELDS_UPDATE}",
        placeholders(39)
    )
});

static UPSERT_KEEP_USER_SQL: Lazy<String> = Lazy::new(|| {
    format!(
        "INSERT INTO anime_entries ({ENTRY_INSERT_COLUMNS}) VALUES ({}) ON CONFLICT(id) DO UPDATE SET {ENTRY_METADATA_UPDATE}",
        placeholders(39)
    )
});

fn placeholders(n: usize) -> String {
    (1..=n).map(|i| format!("?{}", i)).collect::<Vec<_>>().join(", ")
}

/// Column list shared by every `AnimeEntry` read; see [`row_to_entry`].
const ENTRY_SELECT_COLUMNS: &str = "id, anilist_id, mal_id, title_romaji, title_english, title_native,
    synonyms_json, format, airing_status, episodes, duration, season,
    season_year, average_score, cover_image, banner_image, cover_color,
    synopsis, genres_json, studios_json, next_airing_episode, next_airing_at,
    trailer_url, site_url, source_material, user_status, user_progress,
    user_score, user_repeats, user_notes, custom_folder, updated_at,
    user_started_at, user_completed_at, sync_pending, anilist_list_entry_id,
    start_date, end_date";

fn row_to_entry(row: &rusqlite::Row<'_>, avail: Vec<u32>) -> rusqlite::Result<AnimeEntry> {
    let synonyms_str: String = row.get(6)?;
    let genres_str: String = row.get(18)?;
    let studios_str: String = row.get(19)?;
    Ok(AnimeEntry {
        id: row.get(0)?,
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
        user_started_at: row.get(32)?,
        user_completed_at: row.get(33)?,
        sync_pending: row.get::<_, i64>(34)? != 0,
        anilist_list_entry_id: row.get(35)?,
        start_date: row.get(36)?,
        end_date: row.get(37)?,
        local_episode_count: avail.len() as u32,
        available_episodes: avail,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UserFieldsMode {
    /// Incoming user fields (status/progress/score/repeats/notes/dates/updated_at) replace local ones.
    Overwrite,
    /// Local user fields are kept; only metadata is refreshed.
    KeepExisting,
}

/// Insert or update one entry. Synonyms are merged with the stored ones; `custom_folder` is preserved.
/// On insert, `entry.sync_pending` is stored; on conflict `sync_pending` is left untouched.
fn write_entry_tx(conn: &Connection, entry: &AnimeEntry, mode: UserFieldsMode) -> Result<(), String> {
    let mut merged_synonyms = entry.synonyms.clone();
    if let Some(existing_syns_str) = conn
        .query_row(
            "SELECT synonyms_json FROM anime_entries WHERE id = ?1",
            params![entry.id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        if let Ok(existing_syns) = serde_json::from_str::<Vec<String>>(&existing_syns_str) {
            for s in existing_syns {
                if !merged_synonyms.iter().any(|x| x.eq_ignore_ascii_case(&s)) {
                    merged_synonyms.push(s);
                }
            }
        }
    }

    let norm_titles = Database::build_normalized_titles(
        &entry.title_romaji,
        entry.title_english.as_deref(),
        entry.title_native.as_deref(),
        &merged_synonyms,
    );
    let synonyms_json = serde_json::to_string(&merged_synonyms).unwrap_or_else(|_| "[]".into());
    let norm_json = serde_json::to_string(&norm_titles).unwrap_or_else(|_| "[]".into());
    let genres_json = serde_json::to_string(&entry.genres).unwrap_or_else(|_| "[]".into());
    let studios_json = serde_json::to_string(&entry.studios).unwrap_or_else(|_| "[]".into());

    let sql: &str = match mode {
        UserFieldsMode::Overwrite => UPSERT_OVERWRITE_SQL.as_str(),
        UserFieldsMode::KeepExisting => UPSERT_KEEP_USER_SQL.as_str(),
    };
    let mut stmt = conn.prepare_cached(sql).map_err(|e| e.to_string())?;
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
        entry.user_started_at,
        entry.user_completed_at,
        entry.custom_folder,
        entry.updated_at,
        entry.sync_pending as i64,
        entry.anilist_list_entry_id,
        entry.start_date,
        entry.end_date,
    ])
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Build an [`AnimeMatcherIndex`] from `conn` (two SELECTs, no writes).
/// Uses the stored `normalized_titles_json` and only re-normalizes rows where it is empty.
fn build_matcher_index_from(conn: &Connection) -> Result<AnimeMatcherIndex, String> {
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
                        synonyms_json, cover_image, user_progress, episodes, custom_folder,
                        normalized_titles_json
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
                    r.get::<_, String>(11)?,
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
                norms_json,
            ) = row;
            let mut norms: Vec<String> = serde_json::from_str(&norms_json).unwrap_or_default();
            if norms.is_empty() {
                let syns: Vec<String> = serde_json::from_str(&syns_json).unwrap_or_default();
                norms = Database::build_normalized_titles(
                    &romaji,
                    english.as_deref(),
                    native.as_deref(),
                    &syns,
                );
            }
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
                        norm_list.push(NormTitle {
                            core: strip_trailing_season(&n, s).to_string(),
                            norm: n,
                            season: s,
                            anime_id: id,
                        });
                    }
                }
            }
        }
    }

    // Load explicit user title aliases (override exact_norm and include in norm_list)
    {
        let mut alias_stmt = conn
            .prepare("SELECT normalized_alias, anime_id FROM title_aliases")
            .map_err(|e| e.to_string())?;
        let rows = alias_stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for (alias, aid) in rows.flatten() {
            if by_id.contains_key(&aid) {
                let entry_season = external_ids.get(&aid).map(|x| x.2).unwrap_or(1);
                let s = extract_effective_season(&alias).max(entry_season);
                user_aliases.insert(alias.clone(), aid);
                exact_norm.insert(alias.clone(), aid);
                if alias.len() >= 4 {
                    norm_list.push(NormTitle {
                        core: strip_trailing_season(&alias, s).to_string(),
                        norm: alias,
                        season: s,
                        anime_id: aid,
                    });
                }
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

/// Unmatch local episodes, drop aliases and delete the entry row (inside the caller's transaction).
fn delete_entry_rows_tx(conn: &Connection, anime_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE local_episodes SET matched_anime_id = NULL WHERE matched_anime_id = ?1",
        params![anime_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM title_aliases WHERE anime_id = ?1",
        params![anime_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM anime_entries WHERE id = ?1", params![anime_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn normalize_opt_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// Write an already-resolved user state (inside the caller's transaction).
/// `updated_at` is bumped and `sync_pending` set (when requested) only if a user field actually changed.
/// Returns `true` when `custom_folder` or `synonyms` changed (caller should rematch local episodes).
fn write_resolved_state_tx(
    conn: &Connection,
    anime_id: i64,
    state: &ResolvedState,
    sync_pending: bool,
    now: i64,
) -> Result<bool, String> {
    let (old_folder, old_syns_json, romaji, english, native, old_user): (
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
        LocalSyncRow,
    ) = conn
        .query_row(
            "SELECT custom_folder, synonyms_json, title_romaji, title_english, title_native,
                    updated_at, sync_pending, user_status, user_progress, user_score, user_repeats,
                    user_notes, user_started_at, user_completed_at
             FROM anime_entries WHERE id = ?1",
            params![anime_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    LocalSyncRow {
                        id: anime_id,
                        updated_at: r.get(5)?,
                        sync_pending: r.get::<_, i64>(6)? != 0,
                        status: r.get(7)?,
                        progress: r.get(8)?,
                        score: r.get(9)?,
                        repeats: r.get(10)?,
                        notes: r.get(11)?,
                        started_at: r.get(12)?,
                        completed_at: r.get(13)?,
                    },
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Anime entry {} not found", anime_id))?;

    // Only a real user-state change bumps `updated_at` (used for newest-wins conflict resolution)
    // and queues a tracker push. Folder / synonym edits are local-only.
    let user_changed = old_user.differs_from_state(state);
    let new_updated_at = if user_changed { now } else { old_user.updated_at };
    let mark_pending = sync_pending && user_changed;

    let new_folder = normalize_opt_text(state.custom_folder.as_deref()).map(|s| s.to_string());
    let mut needs_rematch = normalize_opt_text(old_folder.as_deref()) != new_folder.as_deref();

    if let Some(syns) = &state.synonyms {
        let syns_json = serde_json::to_string(syns).unwrap_or_else(|_| "[]".into());
        if syns_json != old_syns_json {
            needs_rematch = true;
            let norm = Database::build_normalized_titles(
                &romaji,
                english.as_deref(),
                native.as_deref(),
                syns,
            );
            let norm_json = serde_json::to_string(&norm).unwrap_or_else(|_| "[]".into());
            conn.execute(
                "UPDATE anime_entries SET synonyms_json = ?1, normalized_titles_json = ?2 WHERE id = ?3",
                params![syns_json, norm_json, anime_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    let started = normalize_opt_text(state.user_started_at.as_deref());
    let completed = normalize_opt_text(state.user_completed_at.as_deref());

    conn.execute(
        "UPDATE anime_entries SET
            user_status = ?1,
            user_progress = ?2,
            user_score = ?3,
            user_repeats = ?4,
            user_notes = ?5,
            custom_folder = ?6,
            user_started_at = ?7,
            user_completed_at = ?8,
            updated_at = ?9,
            sync_pending = CASE WHEN ?10 THEN 1 ELSE sync_pending END
         WHERE id = ?11",
        params![
            state.user_status,
            state.user_progress,
            state.user_score,
            state.user_repeats,
            state.user_notes,
            new_folder,
            started,
            completed,
            new_updated_at,
            mark_pending,
            anime_id
        ],
    )
    .map_err(|e| e.to_string())?;

    // Fast O(1) indexed update of watched status for local episodes of this specific anime
    conn.execute(
        "UPDATE local_episodes
         SET watched = CASE WHEN episode_number IS NOT NULL AND episode_number <= ?1 THEN 1 ELSE 0 END
         WHERE matched_anime_id = ?2",
        params![state.user_progress, anime_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(needs_rematch)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for name in names {
        if name.map_err(|e| e.to_string())?.eq_ignore_ascii_case(column) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), String> {
    if !column_exists(conn, table, column)? {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, decl),
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One-time / idempotent data migrations:
/// - purge entries without an AniList id (they can never be synced),
/// - drop season snapshots in the old inline format (media now live in `media_metadata`),
/// - purge the old demo seed if its marker is present.
fn run_data_migrations(conn: &mut Connection) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute_batch(
        "UPDATE local_episodes SET matched_anime_id = NULL
           WHERE matched_anime_id IN (SELECT id FROM anime_entries WHERE anilist_id IS NULL);
         DELETE FROM title_aliases
           WHERE anime_id IN (SELECT id FROM anime_entries WHERE anilist_id IS NULL);
         DELETE FROM anime_entries WHERE anilist_id IS NULL;
         DELETE FROM seasonal_cache WHERE payload_json LIKE '[{%';
         DELETE FROM airing_schedule_cache
           WHERE payload_json LIKE '[{%' AND payload_json NOT LIKE '%\"country\":%';",
    )
    .map_err(|e| e.to_string())?;

    let seeded: bool = tx
        .query_row(
            "SELECT 1 FROM app_settings WHERE key = ?1",
            params![SEED_MARKER_KEY],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if seeded {
        for id in SEEDED_ANIME_IDS {
            delete_entry_rows_tx(&tx, id)?;
        }
        for name in SEEDED_TORRENT_RULE_NAMES {
            tx.execute("DELETE FROM torrent_rules WHERE name = ?1", params![name])
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            params![SEED_MARKER_KEY],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

fn put_media_metadata_tx(conn: &Connection, fetched_at: i64, item: &SeasonalAnime) -> Result<(), String> {
    let json = serde_json::to_string(item).map_err(|e| e.to_string())?;
    conn.prepare_cached(
        "INSERT INTO media_metadata (anilist_id, fetched_at, payload_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(anilist_id) DO UPDATE SET fetched_at = excluded.fetched_at, payload_json = excluded.payload_json",
    )
    .and_then(|mut s| s.execute(params![item.entry.id, fetched_at, json]))
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Per-entry local state used by [`Database::merge_remote_list`] for conflict resolution.
struct LocalSyncRow {
    id: i64,
    updated_at: i64,
    sync_pending: bool,
    status: String,
    progress: u32,
    score: f64,
    repeats: u32,
    notes: String,
    started_at: Option<String>,
    completed_at: Option<String>,
}

/// Local row as loaded once by [`Database::merge_remote_list`]: user state plus the "light" metadata the
/// list fetch carries (everything a sync can compare without the heavy per-media fields).
struct LocalMergeRow {
    user: LocalSyncRow,
    title_romaji: String,
    title_english: Option<String>,
    title_native: Option<String>,
    synonyms_json: String,
    normalized_titles_json: String,
    format: String,
    airing_status: String,
    episodes: Option<u32>,
    season: Option<String>,
    season_year: Option<u32>,
    average_score: Option<u32>,
    cover_image: String,
    cover_color: Option<String>,
    next_airing_episode: Option<u32>,
    next_airing_at: Option<i64>,
    anilist_list_entry_id: Option<i64>,
    start_date: Option<String>,
    end_date: Option<String>,
}

const MERGE_LOCAL_SELECT_SQL: &str = "SELECT id, anilist_id, updated_at, sync_pending, user_status, user_progress,
        user_score, user_repeats, user_notes, user_started_at, user_completed_at,
        title_romaji, title_english, title_native, synonyms_json, normalized_titles_json,
        format, airing_status, episodes, season, season_year, average_score,
        cover_image, cover_color, next_airing_episode, next_airing_at, anilist_list_entry_id,
        start_date, end_date
     FROM anime_entries WHERE anilist_id IS NOT NULL";

/// Light-metadata update used by the diff-only merge. Heavy metadata columns (synopsis, genres, studios,
/// banner, trailer, source, duration, site_url, mal_id) and `custom_folder` are never touched here.
/// `normalized_titles_json` is only replaced when ?16 is non-NULL (titles / synonyms changed).
const MERGE_UPDATE_META_SQL: &str = "UPDATE anime_entries SET
        title_romaji = ?1, title_english = ?2, title_native = ?3, format = ?4, airing_status = ?5,
        episodes = ?6, season = ?7, season_year = ?8, average_score = ?9, cover_image = ?10,
        cover_color = ?11, next_airing_episode = ?12, next_airing_at = ?13, anilist_list_entry_id = ?14,
        synonyms_json = ?15, normalized_titles_json = COALESCE(?16, normalized_titles_json),
        start_date = ?18, end_date = ?19
     WHERE id = ?17";

/// Remote-wins user-field update used by the diff-only merge (`sync_pending` untouched).
const MERGE_UPDATE_USER_SQL: &str = "UPDATE anime_entries SET
        user_status = ?1, user_progress = ?2, user_score = ?3, user_repeats = ?4, user_notes = ?5,
        user_started_at = ?6, user_completed_at = ?7, updated_at = ?8
     WHERE id = ?9";

const MERGE_UPDATE_WATCHED_SQL: &str = "UPDATE local_episodes
     SET watched = CASE WHEN episode_number IS NOT NULL AND episode_number <= ?1 THEN 1 ELSE 0 END
     WHERE matched_anime_id = ?2";

/// Union of `stored` and `remote` synonyms (case-insensitive), keeping the stored order and appending
/// remote-only ones. Returns the merged list and whether anything was appended.
fn merge_synonyms_keep_stored(stored: &[String], remote: &[String]) -> (Vec<String>, bool) {
    let mut merged = stored.to_vec();
    let mut appended = false;
    for s in remote {
        if !merged.iter().any(|x| x.eq_ignore_ascii_case(s)) {
            merged.push(s.clone());
            appended = true;
        }
    }
    (merged, appended)
}

/// Max bound parameters per `IN (...)` chunk (well under SQLite's default variable limit).
const IN_CHUNK: usize = 500;

impl LocalSyncRow {
    fn differs_from_state(&self, state: &ResolvedState) -> bool {
        self.status != state.user_status
            || self.progress != state.user_progress
            || (self.score - state.user_score).abs() > 0.001
            || self.repeats != state.user_repeats
            || self.notes != state.user_notes
            || normalize_opt_text(self.started_at.as_deref())
                != normalize_opt_text(state.user_started_at.as_deref())
            || normalize_opt_text(self.completed_at.as_deref())
                != normalize_opt_text(state.user_completed_at.as_deref())
    }

    fn user_fields_differ(&self, remote: &AnimeEntry) -> bool {
        self.status != remote.user_status
            || self.progress != remote.user_progress
            || (self.score - remote.user_score).abs() > 0.001
            || self.repeats != remote.user_repeats
            || self.notes != remote.user_notes
            || normalize_opt_text(self.started_at.as_deref())
                != normalize_opt_text(remote.user_started_at.as_deref())
            || normalize_opt_text(self.completed_at.as_deref())
                != normalize_opt_text(remote.user_completed_at.as_deref())
    }
}

impl Database {
    pub fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        let mut db = Self::from_connection(conn)?;
        // Opened after the schema exists and WAL mode is persisted in the file.
        db.read_conn = Some(Mutex::new(Self::open_read_connection(db_path)?));
        Ok(db)
    }

    /// Fresh in-memory database with the full schema (tests only). Reads share the write connection.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::from_connection(conn)
    }

    fn open_read_connection(db_path: &Path) -> Result<Connection, String> {
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -4000;
             PRAGMA mmap_size = 0;
             PRAGMA query_only = ON;",
        )
        .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    fn from_connection(conn: Connection) -> Result<Self, String> {
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = -4000;
             PRAGMA mmap_size = 0;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| e.to_string())?;

        // Central matcher-cache invalidation: any INSERT / UPDATE / DELETE (incl. upserts and
        // `INSERT OR REPLACE`) on the tables the matcher index is built from bumps the generation.
        // Both are rowid tables, so the hook fires for every row change (no `DELETE FROM` without
        // WHERE exists for them, which would hit SQLite's truncate optimization and skip the hook).
        let matcher_generation = Arc::new(AtomicU64::new(0));
        let hook_generation = matcher_generation.clone();
        conn.update_hook(Some(
            move |_action: rusqlite::hooks::Action, _db: &str, table: &str, _rowid: i64| {
                if table == "anime_entries" || table == "title_aliases" {
                    hook_generation.fetch_add(1, Ordering::SeqCst);
                }
            },
        ));

        let db = Self {
            conn: Mutex::new(conn),
            read_conn: None,
            matcher_cache: RwLock::new(None),
            matcher_generation,
        };
        db.init_schema()?;
        Ok(db)
    }

    /// Connection for read-only queries: the dedicated read connection when available, else the writer.
    /// Never call a write method while holding this guard (it may be the writer itself).
    pub(crate) fn reader(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.read_conn
            .as_ref()
            .unwrap_or(&self.conn)
            .lock()
            .map_err(|e| e.to_string())
    }

    /// Current matcher-index generation (changes whenever `anime_entries` / `title_aliases` rows change).
    pub fn matcher_generation(&self) -> u64 {
        self.matcher_generation.load(Ordering::SeqCst)
    }

    fn bump_matcher_generation(&self) {
        self.matcher_generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Shared, cached matcher index. Rebuilt lazily only when `matcher_generation` changed since the last build.
    pub fn matcher_index(&self) -> Result<Arc<AnimeMatcherIndex>, String> {
        let current = self.matcher_generation();
        {
            let cache = self.matcher_cache.read().map_err(|e| e.to_string())?;
            if let Some((generation, index)) = cache.as_ref() {
                if *generation == current {
                    return Ok(index.clone());
                }
            }
        }

        let mut cache = self.matcher_cache.write().map_err(|e| e.to_string())?;
        let current = self.matcher_generation();
        if let Some((generation, index)) = cache.as_ref() {
            if *generation == current {
                return Ok(index.clone());
            }
        }
        let (generation, index) = self.build_matcher_index_snapshot()?;
        let index = Arc::new(index);
        *cache = Some((generation, index.clone()));
        Ok(index)
    }

    fn init_schema(&self) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
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
                user_started_at TEXT,
                user_completed_at TEXT,
                custom_folder TEXT,
                updated_at INTEGER NOT NULL DEFAULT 0,
                sync_pending INTEGER NOT NULL DEFAULT 0,
                anilist_list_entry_id INTEGER
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
            );

            CREATE TABLE IF NOT EXISTS tracker_pending_deletions (
                media_id INTEGER PRIMARY KEY,
                list_entry_id INTEGER,
                title TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS seasonal_cache (
                season TEXT NOT NULL,
                year INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY (season, year)
            );

            CREATE TABLE IF NOT EXISTS media_metadata (
                anilist_id INTEGER PRIMARY KEY,
                fetched_at INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS airing_schedule_cache (
                week_from INTEGER PRIMARY KEY,
                week_to INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            );",
        )
        .map_err(|e| e.to_string())?;

        // Idempotent column migrations for existing databases
        add_column_if_missing(&conn, "anime_entries", "user_started_at", "TEXT")?;
        add_column_if_missing(&conn, "anime_entries", "user_completed_at", "TEXT")?;
        add_column_if_missing(
            &conn,
            "anime_entries",
            "sync_pending",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&conn, "anime_entries", "anilist_list_entry_id", "INTEGER")?;
        add_column_if_missing(&conn, "anime_entries", "start_date", "TEXT")?;
        add_column_if_missing(&conn, "anime_entries", "end_date", "TEXT")?;

        run_data_migrations(&mut conn)?;
        drop(conn);

        // Schema changes / migrations: never trust a previously cached index.
        self.bump_matcher_generation();
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

    pub fn upsert_anime_entry(&self, entry: &AnimeEntry) -> Result<(), String> {
        self.upsert_anime_entries_batch(std::slice::from_ref(entry))
    }

    /// Batch upsert anime entries inside a single fast transaction.
    /// Incoming user fields overwrite local ones; `custom_folder` and synonyms are preserved/merged.
    pub fn upsert_anime_entries_batch(&self, entries: &[AnimeEntry]) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for entry in entries {
            write_entry_tx(&tx, entry, UserFieldsMode::Overwrite)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Refresh only the metadata of an existing entry (user state, `updated_at` and `sync_pending` untouched).
    pub fn refresh_entry_metadata(&self, entry: &AnimeEntry) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        write_entry_tx(&conn, entry, UserFieldsMode::KeepExisting)
    }

    /// Local row id of the entry with this AniList media id, if any.
    pub fn find_entry_id_by_anilist_id(&self, anilist_id: i64) -> Result<Option<i64>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id FROM anime_entries WHERE anilist_id = ?1 OR id = ?1 ORDER BY (anilist_id = ?1) DESC LIMIT 1",
            params![anilist_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// Merge the tracker's list into the local DB in one transaction (newest-wins per entry), writing
    /// only what actually changed.
    ///
    /// - Media ids in `skip_media_ids` (pending remote deletions) are ignored.
    /// - New remote entries are inserted (full row).
    /// - Existing entries: if the local entry is `sync_pending` or newer (`updated_at`) than the remote, local
    ///   user fields are kept (`kept_local` counts only entries whose user fields differ). Otherwise differing
    ///   remote user fields replace local ones (`updated_from_remote`); `local_episodes.watched` follows a
    ///   progress change in the same transaction.
    /// - Light metadata (titles, synonyms, format, status, episodes, season, score, cover, next airing,
    ///   list-entry id) is compared and written with a targeted UPDATE only when it differs. Heavy metadata
    ///   (synopsis, genres, studios, banner, trailer, …) is never touched for existing entries, so a light
    ///   list fetch cannot blank it. `normalized_titles_json` is rebuilt only when titles / synonyms change.
    /// - An entry with nothing to change gets no write at all.
    /// - `custom_folder` is always preserved; synonyms are a case-insensitive union with the stored ones.
    /// - With `delete_missing`, local entries absent from the remote list (and not `sync_pending`) are deleted,
    ///   unless the remote list is empty while local entries exist (guard against partial/broken fetches).
    pub fn merge_remote_list(
        &self,
        snapshot_entries: &[AnimeEntry],
        skip_media_ids: &HashSet<i64>,
        delete_missing: bool,
    ) -> Result<MergeStats, String> {
        let mut stats = MergeStats::default();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let mut local_by_media: HashMap<i64, LocalMergeRow> = HashMap::new();
        {
            let mut stmt = tx
                .prepare_cached(MERGE_LOCAL_SELECT_SQL)
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(1)?,
                        LocalMergeRow {
                            user: LocalSyncRow {
                                id: r.get(0)?,
                                updated_at: r.get(2)?,
                                sync_pending: r.get::<_, i64>(3)? != 0,
                                status: r.get(4)?,
                                progress: r.get(5)?,
                                score: r.get(6)?,
                                repeats: r.get(7)?,
                                notes: r.get(8)?,
                                started_at: r.get(9)?,
                                completed_at: r.get(10)?,
                            },
                            title_romaji: r.get(11)?,
                            title_english: r.get(12)?,
                            title_native: r.get(13)?,
                            synonyms_json: r.get(14)?,
                            normalized_titles_json: r.get(15)?,
                            format: r.get(16)?,
                            airing_status: r.get(17)?,
                            episodes: r.get(18)?,
                            season: r.get(19)?,
                            season_year: r.get(20)?,
                            average_score: r.get(21)?,
                            cover_image: r.get(22)?,
                            cover_color: r.get(23)?,
                            next_airing_episode: r.get(24)?,
                            next_airing_at: r.get(25)?,
                            anilist_list_entry_id: r.get(26)?,
                            start_date: r.get(27)?,
                            end_date: r.get(28)?,
                        },
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (media_id, local) = row.map_err(|e| e.to_string())?;
                local_by_media.insert(media_id, local);
            }
        }

        let mut remote_media_ids: HashSet<i64> = HashSet::new();
        for remote in snapshot_entries {
            let Some(media_id) = remote.anilist_id else {
                continue;
            };
            // Duplicates in the snapshot: the first occurrence wins.
            if !remote_media_ids.insert(media_id) || skip_media_ids.contains(&media_id) {
                continue;
            }

            let Some(local) = local_by_media.get(&media_id) else {
                let mut fresh = remote.clone();
                fresh.sync_pending = false;
                write_entry_tx(&tx, &fresh, UserFieldsMode::Overwrite)?;
                stats.added += 1;
                stats.new_ids.push(fresh.id);
                stats.changed_ids.push(fresh.id);
                stats.rematch_ids.push(fresh.id);
                continue;
            };
            let id = local.user.id;
            let mut wrote = false;

            // ---- user fields
            let user_differs = local.user.user_fields_differ(remote);
            let keep_local =
                local.user.sync_pending || local.user.updated_at > remote.updated_at;
            if user_differs {
                if keep_local {
                    stats.kept_local += 1;
                } else {
                    stats.updated_from_remote += 1;
                    tx.prepare_cached(MERGE_UPDATE_USER_SQL)
                        .and_then(|mut s| {
                            s.execute(params![
                                remote.user_status,
                                remote.user_progress,
                                remote.user_score,
                                remote.user_repeats,
                                remote.user_notes,
                                normalize_opt_text(remote.user_started_at.as_deref()),
                                normalize_opt_text(remote.user_completed_at.as_deref()),
                                remote.updated_at,
                                id
                            ])
                        })
                        .map_err(|e| e.to_string())?;
                    if local.user.progress != remote.user_progress {
                        tx.prepare_cached(MERGE_UPDATE_WATCHED_SQL)
                            .and_then(|mut s| s.execute(params![remote.user_progress, id]))
                            .map_err(|e| e.to_string())?;
                    }
                    wrote = true;
                }
            }

            // ---- light metadata
            let stored_synonyms: Vec<String> =
                serde_json::from_str(&local.synonyms_json).unwrap_or_default();
            let (merged_synonyms, synonyms_changed) =
                merge_synonyms_keep_stored(&stored_synonyms, &remote.synonyms);
            let titles_changed = synonyms_changed
                || local.title_romaji != remote.title_romaji
                || local.title_english != remote.title_english
                || local.title_native != remote.title_native;
            let cover_image = if remote.cover_image.is_empty() {
                local.cover_image.as_str()
            } else {
                remote.cover_image.as_str()
            };
            let cover_color = remote.cover_color.as_ref().or(local.cover_color.as_ref());
            let list_entry_id = remote.anilist_list_entry_id.or(local.anilist_list_entry_id);
            let meta_changed = titles_changed
                || local.format != remote.format
                || local.airing_status != remote.airing_status
                || local.episodes != remote.episodes
                || local.season != remote.season
                || local.season_year != remote.season_year
                || local.average_score != remote.average_score
                || local.cover_image != cover_image
                || local.cover_color.as_ref() != cover_color
                || local.next_airing_episode != remote.next_airing_episode
                || local.next_airing_at != remote.next_airing_at
                || local.anilist_list_entry_id != list_entry_id
                || local.start_date != remote.start_date
                || local.end_date != remote.end_date;

            if meta_changed {
                let (synonyms_json, norm_json) = if titles_changed {
                    let norm = Database::build_normalized_titles(
                        &remote.title_romaji,
                        remote.title_english.as_deref(),
                        remote.title_native.as_deref(),
                        &merged_synonyms,
                    );
                    let norm_json = serde_json::to_string(&norm).unwrap_or_else(|_| "[]".into());
                    if norm_json != local.normalized_titles_json {
                        stats.rematch_ids.push(id);
                    }
                    (
                        serde_json::to_string(&merged_synonyms).unwrap_or_else(|_| "[]".into()),
                        Some(norm_json),
                    )
                } else {
                    (local.synonyms_json.clone(), None)
                };
                tx.prepare_cached(MERGE_UPDATE_META_SQL)
                    .and_then(|mut s| {
                        s.execute(params![
                            remote.title_romaji,
                            remote.title_english,
                            remote.title_native,
                            remote.format,
                            remote.airing_status,
                            remote.episodes,
                            remote.season,
                            remote.season_year,
                            remote.average_score,
                            cover_image,
                            cover_color,
                            remote.next_airing_episode,
                            remote.next_airing_at,
                            list_entry_id,
                            synonyms_json,
                            norm_json,
                            id,
                            remote.start_date,
                            remote.end_date
                        ])
                    })
                    .map_err(|e| e.to_string())?;
                wrote = true;
            }

            if wrote {
                stats.changed_ids.push(id);
            }
        }

        if delete_missing {
            if remote_media_ids.is_empty() && !local_by_media.is_empty() {
                stats.deletion_skipped_reason = Some(format!(
                    "AniList returned an empty list; skipped deleting {} local entries",
                    local_by_media.len()
                ));
            } else {
                for (media_id, local) in &local_by_media {
                    if remote_media_ids.contains(media_id) || local.user.sync_pending {
                        continue;
                    }
                    delete_entry_rows_tx(&tx, local.user.id)?;
                    stats.deleted += 1;
                    stats.removed_ids.push(local.user.id);
                }
                stats.removed_ids.sort_unstable();
            }
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(stats)
    }

    /// Write full (heavy) metadata for entries that already exist locally, in one transaction.
    /// User state, `updated_at`, `sync_pending` and `custom_folder` are untouched (same rules as
    /// [`refresh_entry_metadata`](Self::refresh_entry_metadata)); ids without a local row are skipped
    /// (never inserted). Returns the number of rows written.
    pub fn refresh_existing_entries_metadata(&self, entries: &[AnimeEntry]) -> Result<usize, String> {
        if entries.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut written = 0;
        for entry in entries {
            let exists = tx
                .prepare_cached("SELECT 1 FROM anime_entries WHERE id = ?1")
                .and_then(|mut s| s.exists(params![entry.id]))
                .map_err(|e| e.to_string())?;
            if exists {
                write_entry_tx(&tx, entry, UserFieldsMode::KeepExisting)?;
                written += 1;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(written)
    }

    /// Batched fetch of full entries (incl. `available_episodes` / `local_episode_count`) for `ids`, in the
    /// order given (duplicates and unknown ids dropped). One read snapshot; `IN (...)` queries are chunked.
    pub fn get_anime_entries_by_ids(&self, ids: &[i64]) -> Result<Vec<AnimeEntry>, String> {
        let mut unique: Vec<i64> = Vec::with_capacity(ids.len());
        let mut seen: HashSet<i64> = HashSet::with_capacity(ids.len());
        for &id in ids {
            if seen.insert(id) {
                unique.push(id);
            }
        }
        if unique.is_empty() {
            return Ok(vec![]);
        }

        let reader = self.reader()?;
        // One read transaction so all queries see the same committed snapshot.
        let conn = reader.unchecked_transaction().map_err(|e| e.to_string())?;

        let mut ep_map: HashMap<i64, Vec<u32>> = HashMap::new();
        let mut by_id: HashMap<i64, AnimeEntry> = HashMap::with_capacity(unique.len());
        for chunk in unique.chunks(IN_CHUNK) {
            let marks = placeholders(chunk.len());
            {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT matched_anime_id, episode_number FROM local_episodes
                         WHERE matched_anime_id IN ({marks}) AND episode_number IS NOT NULL"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                        Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?))
                    })
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let (aid, ep) = row.map_err(|e| e.to_string())?;
                    ep_map.entry(aid).or_default().push(ep);
                }
            }
            for eps in ep_map.values_mut() {
                eps.sort_unstable();
                eps.dedup();
            }

            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {ENTRY_SELECT_COLUMNS} FROM anime_entries WHERE id IN ({marks})"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
                    let id: i64 = row.get(0)?;
                    let avail = ep_map.get(&id).cloned().unwrap_or_default();
                    row_to_entry(row, avail)
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let entry = row.map_err(|e| e.to_string())?;
                by_id.insert(entry.id, entry);
            }
        }

        Ok(unique.iter().filter_map(|id| by_id.remove(id)).collect())
    }

    /// Fetch a single AnimeEntry by ID in O(1) without loading the entire anime_entries table.
    pub fn get_anime_entry_by_id(&self, anime_id: i64) -> Result<AnimeEntry, String> {
        let reader = self.reader()?;
        // One read transaction so both queries see the same committed snapshot.
        let conn = reader.unchecked_transaction().map_err(|e| e.to_string())?;

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
            &format!("SELECT {ENTRY_SELECT_COLUMNS} FROM anime_entries WHERE id = ?1"),
            params![anime_id],
            |row| row_to_entry(row, avail),
        )
        .map_err(|e| format!("Anime entry not found: {}", e))
    }

    pub fn list_anime_entries(&self) -> Result<Vec<AnimeEntry>, String> {
        let reader = self.reader()?;
        // One read transaction so both queries see the same committed snapshot.
        let conn = reader.unchecked_transaction().map_err(|e| e.to_string())?;

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
            .prepare(&format!(
                "SELECT {ENTRY_SELECT_COLUMNS} FROM anime_entries ORDER BY updated_at DESC, title_romaji ASC"
            ))
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let avail = ep_map.get(&id).cloned().unwrap_or_default();
                row_to_entry(row, avail)
            })
            .map_err(|e| e.to_string())?;

        let mut list = Vec::new();
        for item in rows {
            list.push(item.map_err(|e| e.to_string())?);
        }
        Ok(list)
    }

    /// Write a single entry's user state. Dates: `Some("")` clears, `None` keeps the stored value.
    /// `custom_folder` is a full replace. `sync_pending = true` marks the entry for a tracker push
    /// (`false` never clears an existing pending flag; use `set_sync_result` / `finish_push` for that).
    /// Returns the updated entry and whether a full local-episode rematch is needed.
    #[allow(clippy::too_many_arguments)]
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
        user_started_at: Option<String>,
        user_completed_at: Option<String>,
        sync_pending: bool,
    ) -> Result<(AnimeEntry, bool), String> {
        let now = chrono::Utc::now().timestamp();
        let needs_full_rematch = {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            let (old_started, old_completed): (Option<String>, Option<String>) = tx
                .query_row(
                    "SELECT user_started_at, user_completed_at FROM anime_entries WHERE id = ?1",
                    params![anime_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("Anime entry {} not found", anime_id))?;

            let state = ResolvedState {
                user_status: user_status.to_string(),
                user_progress,
                user_score,
                user_repeats,
                user_notes: user_notes.to_string(),
                user_started_at: user_started_at.or(old_started),
                user_completed_at: user_completed_at.or(old_completed),
                custom_folder,
                synonyms,
            };
            let needs = write_resolved_state_tx(&tx, anime_id, &state, sync_pending, now)?;
            tx.commit().map_err(|e| e.to_string())?;
            needs
        };

        let entry = self.get_anime_entry_by_id(anime_id)?;
        Ok((entry, needs_full_rematch))
    }

    /// Write several already-resolved user states in one transaction (see `sync::normalize_change`).
    /// Also refreshes `local_episodes.watched`. Returns `true` if any `custom_folder` / `synonyms` changed.
    pub fn write_resolved_states(
        &self,
        states: &[(i64, ResolvedState)],
        sync_pending: bool,
    ) -> Result<bool, String> {
        if states.is_empty() {
            return Ok(false);
        }
        let now = chrono::Utc::now().timestamp();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut needs_rematch = false;
        for (anime_id, state) in states {
            needs_rematch |= write_resolved_state_tx(&tx, *anime_id, state, sync_pending, now)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(needs_rematch)
    }

    pub fn delete_anime_entry(&self, anime_id: i64) -> Result<(), String> {
        self.batch_delete_anime_entries(&[anime_id])
    }

    /// Delete entries locally only (no tracker tombstones). Unmatches episodes and drops aliases.
    pub fn batch_delete_anime_entries(&self, anime_ids: &[i64]) -> Result<(), String> {
        if anime_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for &aid in anime_ids {
            delete_entry_rows_tx(&tx, aid)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete entries locally and queue a tracker deletion (tombstone) for each one that has an AniList id,
    /// all in one transaction. Returns the queued tombstones.
    pub fn delete_entries_with_tombstones(
        &self,
        anime_ids: &[i64],
    ) -> Result<Vec<PendingDeletion>, String> {
        let now = chrono::Utc::now().timestamp();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut tombstones = Vec::new();
        for &aid in anime_ids {
            let row: Option<(Option<i64>, Option<i64>, String)> = tx
                .query_row(
                    "SELECT anilist_id, anilist_list_entry_id, title_romaji FROM anime_entries WHERE id = ?1",
                    params![aid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((anilist_id, list_entry_id, title)) = row else {
                continue;
            };
            delete_entry_rows_tx(&tx, aid)?;
            if let Some(media_id) = anilist_id {
                tx.execute(
                    "INSERT OR REPLACE INTO tracker_pending_deletions (media_id, list_entry_id, title, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![media_id, list_entry_id, title, now],
                )
                .map_err(|e| e.to_string())?;
                tombstones.push(PendingDeletion {
                    media_id,
                    list_entry_id,
                    title,
                });
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(tombstones)
    }

    pub fn list_pending_deletions(&self) -> Result<Vec<PendingDeletion>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT media_id, list_entry_id, title FROM tracker_pending_deletions ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PendingDeletion {
                    media_id: r.get(0)?,
                    list_entry_id: r.get(1)?,
                    title: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn remove_pending_deletion(&self, media_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM tracker_pending_deletions WHERE media_id = ?1",
            params![media_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn count_pending_deletions(&self) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT COUNT(*) FROM tracker_pending_deletions", [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|n| n as usize)
        .map_err(|e| e.to_string())
    }

    /// Cached snapshot of one season: `(fetched_at, items)`. The season row stores only media ids; the
    /// items come from `media_metadata` in listing order. A corrupt payload or a missing media row counts as a miss.
    pub fn get_season_cache(
        &self,
        season: &str,
        year: u32,
    ) -> Result<Option<(i64, Vec<SeasonalAnime>)>, String> {
        let conn = self.reader()?;
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT fetched_at, payload_json FROM seasonal_cache WHERE season = ?1 AND year = ?2",
                params![season, year],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((fetched_at, ids_json)) = row else {
            return Ok(None);
        };
        let Ok(ids) = serde_json::from_str::<Vec<i64>>(&ids_json) else {
            return Ok(None);
        };
        let mut stmt = conn
            .prepare_cached(
                "SELECT m.payload_json FROM json_each(?1) j
                 JOIN media_metadata m ON m.anilist_id = j.value
                 ORDER BY j.key",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![ids_json], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut items = Vec::with_capacity(ids.len());
        for r in rows {
            let json = r.map_err(|e| e.to_string())?;
            match serde_json::from_str::<SeasonalAnime>(&json) {
                Ok(item) => items.push(item),
                Err(_) => return Ok(None),
            }
        }
        if items.len() != ids.len() {
            return Ok(None);
        }
        Ok(Some((fetched_at, items)))
    }

    /// Store a season: every media goes to `media_metadata` (upsert), the season row keeps their ids.
    pub fn put_season_cache(
        &self,
        season: &str,
        year: u32,
        fetched_at: i64,
        items: &[SeasonalAnime],
    ) -> Result<(), String> {
        let ids: Vec<i64> = items.iter().map(|it| it.entry.id).collect();
        let ids_json = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for item in items {
            put_media_metadata_tx(&tx, fetched_at, item)?;
        }
        tx.execute(
            "INSERT INTO seasonal_cache (season, year, fetched_at, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(season, year) DO UPDATE SET fetched_at = excluded.fetched_at, payload_json = excluded.payload_json",
            params![season, year, fetched_at, ids_json],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Stored metadata of one media (`fetched_at`, item), written by season fetches or a one-off fetch.
    pub fn get_media_metadata(&self, anilist_id: i64) -> Result<Option<(i64, SeasonalAnime)>, String> {
        let conn = self.reader()?;
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT fetched_at, payload_json FROM media_metadata WHERE anilist_id = ?1",
                params![anilist_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.and_then(|(fetched_at, json)| {
            serde_json::from_str::<SeasonalAnime>(&json)
                .ok()
                .map(|item| (fetched_at, item))
        }))
    }

    pub fn put_media_metadata(&self, fetched_at: i64, item: &SeasonalAnime) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        put_media_metadata_tx(&conn, fetched_at, item)
    }

    /// Cached airing schedule of the range starting at `from`: `(fetched_at, items)`. A range with a
    /// different end or a corrupt payload counts as a miss.
    pub fn get_airing_schedule_cache(
        &self,
        from: i64,
        to: i64,
    ) -> Result<Option<(i64, Vec<AiringScheduleItem>)>, String> {
        let conn = self.reader()?;
        let row: Option<(i64, i64, String)> = conn
            .query_row(
                "SELECT week_to, fetched_at, payload_json FROM airing_schedule_cache WHERE week_from = ?1",
                params![from],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.and_then(|(week_to, fetched_at, json)| {
            if week_to != to {
                return None;
            }
            serde_json::from_str::<Vec<AiringScheduleItem>>(&json)
                .ok()
                .map(|items| (fetched_at, items))
        }))
    }

    pub fn put_airing_schedule_cache(
        &self,
        from: i64,
        to: i64,
        fetched_at: i64,
        items: &[AiringScheduleItem],
    ) -> Result<(), String> {
        let json = serde_json::to_string(items).map_err(|e| e.to_string())?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO airing_schedule_cache (week_from, week_to, fetched_at, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(week_from) DO UPDATE SET week_to = excluded.week_to, fetched_at = excluded.fetched_at,
                 payload_json = excluded.payload_json",
            params![from, to, fetched_at, json],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_cached_seasons(&self) -> Result<Vec<CachedSeason>, String> {
        let conn = self.reader()?;
        let mut stmt = conn
            .prepare("SELECT season, year, fetched_at FROM seasonal_cache ORDER BY year DESC, season")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CachedSeason {
                    season: r.get(0)?,
                    year: r.get(1)?,
                    fetched_at: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Set the sync bookkeeping of an entry. `updated_at` / `list_entry_id` are only written when `Some`.
    pub fn set_sync_result(
        &self,
        anime_id: i64,
        pending: bool,
        updated_at: Option<i64>,
        list_entry_id: Option<i64>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE anime_entries SET
                sync_pending = ?1,
                updated_at = COALESCE(?2, updated_at),
                anilist_list_entry_id = COALESCE(?3, anilist_list_entry_id)
             WHERE id = ?4",
            params![pending, updated_at, list_entry_id, anime_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Record a successful push of `pushed` (the entry snapshot that was sent). Clears `sync_pending` and
    /// adopts the tracker's `updated_at` only if the user fields are still exactly what was pushed; if the
    /// entry was edited meanwhile it stays pending (only the list entry id is stored). Returns whether it cleared.
    pub fn finish_push(
        &self,
        pushed: &AnimeEntry,
        remote_updated_at: i64,
        list_entry_id: i64,
    ) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE anime_entries SET sync_pending = 0, updated_at = ?1, anilist_list_entry_id = ?2
                 WHERE id = ?3 AND user_status = ?4 AND user_progress = ?5 AND user_score = ?6
                   AND user_repeats = ?7 AND user_notes = ?8
                   AND user_started_at IS ?9 AND user_completed_at IS ?10",
                params![
                    remote_updated_at,
                    list_entry_id,
                    pushed.id,
                    pushed.user_status,
                    pushed.user_progress,
                    pushed.user_score,
                    pushed.user_repeats,
                    pushed.user_notes,
                    pushed.user_started_at,
                    pushed.user_completed_at
                ],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            conn.execute(
                "UPDATE anime_entries SET anilist_list_entry_id = ?1 WHERE id = ?2",
                params![list_entry_id, pushed.id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(changed > 0)
    }

    pub fn list_pending_sync_ids(&self) -> Result<Vec<i64>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM anime_entries WHERE sync_pending = 1 ORDER BY updated_at ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Number of entries with an unpushed local change.
    pub fn count_pending(&self) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT COUNT(*) FROM anime_entries WHERE sync_pending = 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n as usize)
        .map_err(|e| e.to_string())
    }

    /// Build a fresh (uncached) in-memory AnimeMatcherIndex in a single SQL pass.
    /// Prefer [`Database::matcher_index`], which reuses the cached index while nothing changed.
    pub fn build_matcher_index(&self) -> Result<AnimeMatcherIndex, String> {
        self.build_matcher_index_snapshot().map(|(_, index)| index)
    }

    /// Build the index from a consistent snapshot and return it with the generation that snapshot reflects.
    fn build_matcher_index_snapshot(&self) -> Result<(u64, AnimeMatcherIndex), String> {
        let start = std::time::Instant::now();
        let (generation, index) = match &self.read_conn {
            None => {
                let conn = self.conn.lock().map_err(|e| e.to_string())?;
                let generation = self.matcher_generation();
                (generation, build_matcher_index_from(&conn)?)
            }
            Some(read_conn) => {
                let reader = read_conn.lock().map_err(|e| e.to_string())?;
                let tx = reader.unchecked_transaction().map_err(|e| e.to_string())?;
                let generation = {
                    // Pin the read snapshot while no write transaction is in flight. The update hook bumps the
                    // generation *before* commit, so a snapshot taken mid-transaction could otherwise be cached
                    // under the post-write generation while still missing the write.
                    let _writer = self.conn.lock().map_err(|e| e.to_string())?;
                    let generation = self.matcher_generation();
                    tx.query_row("SELECT COUNT(*) FROM title_aliases", [], |r| r.get::<_, i64>(0))
                        .map_err(|e| e.to_string())?;
                    generation
                };
                let index = build_matcher_index_from(&tx)?;
                drop(tx); // read-only transaction: rollback is a no-op
                (generation, index)
            }
        };
        eprintln!(
            "[matcher] built index: {} titles, {} norms in {}ms",
            index.by_id.len(),
            index.norm_list.len(),
            start.elapsed().as_millis()
        );
        Ok((generation, index))
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
        let index = self.matcher_index().ok()?;
        index.match_title(normalized_title, file_path)
    }

    /// Match a parsed `AnitomyElements` to an AnimeEntry in the database, applying episode bounds validation
    /// and `erengy/anime-relations` redirections when needed.
    pub fn match_episode_to_anime(
        &self,
        parsed: &mut AnitomyElements,
        file_path: Option<&str>,
    ) -> Option<(i64, String, String, u32, Option<u32>)> {
        let index = self.matcher_index().ok()?;
        index.match_episode(parsed, file_path)
    }

    pub fn get_settings(&self) -> Result<AppSettings, String> {
        const SELECT_SETTINGS: &str = "SELECT value_json FROM app_settings WHERE key = 'main'";
        let raw: Option<String> = {
            let reader = self.reader()?;
            reader
                .query_row(SELECT_SETTINGS, [], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?
        };
        if let Some(json) = raw {
            return Ok(serde_json::from_str(&json).unwrap_or_default());
        }

        // First run: persist the defaults on the write connection (re-check under the writer lock).
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let raw: Option<String> = conn
            .query_row(SELECT_SETTINGS, [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(json) = raw {
            return Ok(serde_json::from_str(&json).unwrap_or_default());
        }
        let def = AppSettings::default();
        let json = serde_json::to_string(&def).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES ('main', ?1)",
            params![json],
        )
        .map_err(|e| e.to_string())?;
        Ok(def)
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
    ) -> Result<i64, String> {
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
        Ok(conn.last_insert_rowid())
    }

    pub fn mark_watch_history_scrobbled(&self, history_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE watch_history SET scrobbled_to_tracker = 1 WHERE id = ?1",
            params![history_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Log manual progress increases: one row per newly watched episode (`from + 1 ..= to`) for each
    /// `(anime_id, title, from, to)`, in one transaction. Rows use [`MANUAL_HISTORY_PLAYER`] and no file.
    pub fn record_manual_progress(&self, changes: &[(i64, String, u32, u32)]) -> Result<(), String> {
        if changes.iter().all(|(_, _, from, to)| to <= from) {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().timestamp();
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO watch_history (anime_id, anime_title, episode_number, player_name, file_name, scrobbled_to_tracker, timestamp_unix)
                     VALUES (?1, ?2, ?3, ?4, '', 0, ?5)",
                )
                .map_err(|e| e.to_string())?;
            for (anime_id, title, from, to) in changes {
                for ep in (*from + 1)..=*to {
                    stmt.execute(params![anime_id, title, ep, MANUAL_HISTORY_PLAYER, now])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Episodes logged in `[since, until)` and the minutes they add up to (episode `duration`, 24 if unknown).
    pub fn watch_history_totals(&self, since: i64, until: i64) -> Result<(u32, u32), String> {
        let conn = self.reader()?;
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(COALESCE(a.duration, 24)), 0)
             FROM watch_history h LEFT JOIN anime_entries a ON a.id = h.anime_id
             WHERE h.timestamp_unix >= ?1 AND h.timestamp_unix < ?2",
            params![since, until],
            |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, i64>(1)? as u32)),
        )
        .map_err(|e| e.to_string())
    }

    pub fn list_watch_history(&self, limit: u32, offset: u32) -> Result<Vec<WatchHistoryEntry>, String> {
        let conn = self.reader()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, anime_id, anime_title, episode_number, player_name, file_name, scrobbled_to_tracker, timestamp_unix
                 FROM watch_history ORDER BY timestamp_unix DESC, id DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit, offset], |r| {
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

/// Minimal entry for tests (status PLANNING, no progress, 12 episodes).
#[cfg(test)]
pub(crate) fn test_entry(id: i64, title: &str) -> AnimeEntry {
    AnimeEntry {
        id,
        anilist_id: Some(id),
        mal_id: None,
        title_romaji: title.to_string(),
        title_english: None,
        title_native: None,
        synonyms: vec![],
        format: "TV".into(),
        airing_status: "FINISHED".into(),
        episodes: Some(12),
        duration: Some(24),
        season: None,
        season_year: None,
        average_score: None,
        cover_image: String::new(),
        banner_image: None,
        cover_color: None,
        synopsis: String::new(),
        genres: vec![],
        studios: vec![],
        next_airing_episode: None,
        next_airing_at: None,
        trailer_url: None,
        site_url: None,
        source_material: None,
        user_status: "PLANNING".into(),
        user_progress: 0,
        user_score: 0.0,
        user_repeats: 0,
        user_notes: String::new(),
        user_started_at: None,
        user_completed_at: None,
        custom_folder: None,
        updated_at: 0,
        local_episode_count: 0,
        available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
    }
}

/// Realistic library used by matcher / scanner / relations tests (formerly the demo seed).
#[cfg(test)]
pub(crate) fn test_fixture_entries() -> Vec<AnimeEntry> {
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
        user_started_at: Some("2026-10-04".into()),
        user_completed_at: None,
        custom_folder: None,
        updated_at: now - 100000,
        local_episode_count: 0,
        available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
    };
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
            user_started_at: Some("2023-09-29".into()),
            user_completed_at: None,
            custom_folder: None,
            updated_at: now - 3600,
            local_episode_count: 0,
            available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
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
            user_started_at: Some("2024-10-03".into()),
            user_completed_at: None,
            custom_folder: None,
            updated_at: now - 7200,
            local_episode_count: 0,
            available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
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
            user_started_at: Some("2024-01-04".into()),
            user_completed_at: None,
            custom_folder: None,
            updated_at: now - 18000,
            local_episode_count: 0,
            available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
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
            user_started_at: Some("2023-10-22".into()),
            user_completed_at: Some("2024-03-24".into()),
            custom_folder: None,
            updated_at: now - 86400,
            local_episode_count: 0,
            available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
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
            user_started_at: Some("2022-10-09".into()),
            user_completed_at: Some("2022-12-25".into()),
            custom_folder: None,
            updated_at: now - 172800,
            local_episode_count: 0,
            available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
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
            user_started_at: Some("2008-10-02".into()),
            user_completed_at: Some("2009-03-26".into()),
            custom_folder: None,
            updated_at: now - 250000,
            local_episode_count: 0,
            available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
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
            user_started_at: None,
            user_completed_at: None,
            custom_folder: None,
            updated_at: now - 300000,
            local_episode_count: 0,
            available_episodes: vec![],
        sync_pending: false,
        anilist_list_entry_id: None,
        start_date: None,
        end_date: None,
        },
        kusuriya_s3,
    ];
    starter_entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detection::anitomy::{normalize_anime_title, parse_filename};

    fn fixture_db(name: &str) -> (Database, std::path::PathBuf) {
        let tmp_dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let db = Database::open(&tmp_dir.join("test.db")).expect("open test db");
        db.upsert_anime_entries_batch(&test_fixture_entries())
            .expect("load fixtures");
        (db, tmp_dir)
    }

    #[test]
    fn test_fuzzy_matching_and_alias_linking() {
        let (db, tmp_dir) = fixture_db("tora_test_db_fuzzy");

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

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_write_resolved_states_and_delete() {
        let db = Database::open_in_memory().expect("db");
        db.upsert_anime_entries_batch(&[test_entry(1, "Alpha"), test_entry(2, "Beta")])
            .unwrap();

        let state = ResolvedState {
            user_status: "CURRENT".into(),
            user_progress: 2,
            user_score: 88.0,
            user_repeats: 0,
            user_notes: "notes".into(),
            user_started_at: Some("2026-01-15".into()),
            user_completed_at: None,
            custom_folder: None,
            synonyms: None,
        };
        let needs = db
            .write_resolved_states(&[(1, state.clone()), (2, state.clone())], true)
            .unwrap();
        assert!(!needs);
        let a = db.get_anime_entry_by_id(1).unwrap();
        assert_eq!(a.user_status, "CURRENT");
        assert_eq!(a.user_progress, 2);
        assert_eq!(a.user_started_at.as_deref(), Some("2026-01-15"));
        assert!(a.sync_pending);

        // A non-pending write never clears an existing pending flag
        let mut cleared = state.clone();
        cleared.user_started_at = Some(String::new());
        cleared.custom_folder = Some("D:/Anime/Alpha".into());
        assert!(db.write_resolved_states(&[(1, cleared)], false).unwrap());
        let a = db.get_anime_entry_by_id(1).unwrap();
        assert!(a.sync_pending);
        assert_eq!(a.user_started_at, None);
        assert_eq!(a.custom_folder.as_deref(), Some("D:/Anime/Alpha"));

        assert_eq!(db.count_pending().unwrap(), 2);
        assert_eq!(db.list_pending_sync_ids().unwrap().len(), 2);

        db.batch_delete_anime_entries(&[1, 2]).expect("batch delete");
        assert!(db.get_anime_entry_by_id(1).is_err());
        assert!(db.get_anime_entry_by_id(2).is_err());
        assert_eq!(db.count_pending_deletions().unwrap(), 0);
    }

    fn insert_matched_episode(db: &Database, anime_id: i64, file: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO library_folders (id, path, label, drive_root) VALUES (1, 'C:/lib', 'lib', 'C:')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO local_episodes (folder_id, file_path, file_name, drive_root, parsed_title, normalized_title, episode_number, matched_anime_id)
             VALUES (1, ?1, ?1, 'C:', 'x', 'x', 1, ?2)",
            params![file, anime_id],
        )
        .unwrap();
    }

    fn matched_id_of(db: &Database, file: &str) -> Option<i64> {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT matched_anime_id FROM local_episodes WHERE file_path = ?1",
            params![file],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn alias_count(db: &Database, anime_id: i64) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM title_aliases WHERE anime_id = ?1",
            params![anime_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn test_migrations_purge_null_anilist_and_seed() {
        let db = Database::open_in_memory().expect("db");
        db.upsert_anime_entries_batch(&[
            test_entry(154587, "Sousou no Frieren"),
            test_entry(5114, "Fullmetal Alchemist: Brotherhood"),
        ])
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO anime_entries (id, anilist_id, title_romaji) VALUES (900001, NULL, 'Local Only')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO title_aliases (normalized_alias, anime_id) VALUES ('local only', 900001)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO title_aliases (normalized_alias, anime_id) VALUES ('frieren alias', 154587)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO torrent_rules (name) VALUES ('SubsPlease 1080p (Watching)'), ('Dandadan - Erai-raws 1080p Auto'), ('My Own Rule')",
                [],
            )
            .unwrap();
        }
        insert_matched_episode(&db, 900001, "C:/lib/local.mkv");
        insert_matched_episode(&db, 154587, "C:/lib/frieren.mkv");

        // No seed marker: only the NULL-anilist row is purged
        db.init_schema().unwrap();
        assert!(db.get_anime_entry_by_id(900001).is_err());
        assert_eq!(alias_count(&db, 900001), 0);
        assert_eq!(matched_id_of(&db, "C:/lib/local.mkv"), None);
        assert!(db.get_anime_entry_by_id(154587).is_ok());
        assert_eq!(matched_id_of(&db, "C:/lib/frieren.mkv"), Some(154587));
        assert_eq!(db.list_torrent_rules().unwrap().len(), 3);

        // With the marker: seeded anime + rules are purged, the marker is removed
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO app_settings (key, value_json) VALUES ('seeded_kusuriya_s3', 'true')",
                [],
            )
            .unwrap();
        }
        db.init_schema().unwrap();
        assert!(db.get_anime_entry_by_id(154587).is_err());
        assert_eq!(alias_count(&db, 154587), 0);
        assert_eq!(matched_id_of(&db, "C:/lib/frieren.mkv"), None);
        assert!(db.get_anime_entry_by_id(5114).is_ok());
        let rules = db.list_torrent_rules().unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].name, "My Own Rule");
        {
            let conn = db.conn.lock().unwrap();
            let marker: Option<String> = conn
                .query_row(
                    "SELECT value_json FROM app_settings WHERE key = 'seeded_kusuriya_s3'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .unwrap();
            assert!(marker.is_none());
        }

        // Re-running is a no-op; a re-added entry with the same id survives
        db.upsert_anime_entry(&test_entry(154587, "Sousou no Frieren"))
            .unwrap();
        db.init_schema().unwrap();
        assert!(db.get_anime_entry_by_id(154587).is_ok());
        assert!(db.get_anime_entry_by_id(5114).is_ok());
    }

    #[test]
    fn test_merge_remote_list_rules() {
        let db = Database::open_in_memory().expect("db");

        let mut a = test_entry(1, "Alpha");
        a.user_status = "CURRENT".into();
        a.user_progress = 3;
        a.updated_at = 100;
        a.custom_folder = Some("D:/Anime/Alpha".into());
        a.synonyms = vec!["Local Alpha".into()];
        let mut b = test_entry(2, "Beta");
        b.user_status = "CURRENT".into();
        b.user_progress = 5;
        b.updated_at = 500;
        let mut c = test_entry(3, "Gamma");
        c.user_progress = 2;
        c.user_status = "CURRENT".into();
        c.updated_at = 100;
        c.sync_pending = true;
        let mut d = test_entry(4, "Delta");
        d.updated_at = 100;
        let mut e = test_entry(5, "Epsilon");
        e.updated_at = 100;
        e.sync_pending = true;
        let mut same = test_entry(9, "Same");
        same.updated_at = 100;
        db.upsert_anime_entries_batch(&[a, b, c, d, e, same.clone()])
            .unwrap();
        insert_matched_episode(&db, 4, "C:/lib/delta.mkv");

        let mut ra = test_entry(1, "Alpha");
        ra.user_status = "CURRENT".into();
        ra.user_progress = 7;
        ra.updated_at = 200;
        ra.anilist_list_entry_id = Some(9001);
        ra.synonyms = vec!["Remote Alpha".into()];
        let mut rb = test_entry(2, "Beta");
        rb.user_status = "CURRENT".into();
        rb.user_progress = 4;
        rb.updated_at = 400;
        let mut rc = test_entry(3, "Gamma (renamed)");
        rc.user_status = "CURRENT".into();
        rc.user_progress = 9;
        rc.updated_at = 900;
        let rg = test_entry(7, "Tombstoned");
        let mut rh = test_entry(8, "New One");
        rh.user_status = "CURRENT".into();
        rh.user_progress = 1;
        rh.updated_at = 300;
        let mut rsame = same.clone();
        rsame.updated_at = 150;

        let skip: HashSet<i64> = [7].into_iter().collect();
        let stats = db
            .merge_remote_list(&[ra, rb, rc, rg, rh, rsame], &skip, true)
            .unwrap();
        assert_eq!(stats.added, 1);
        assert_eq!(stats.updated_from_remote, 1);
        assert_eq!(stats.kept_local, 2);
        assert_eq!(stats.deleted, 1);
        assert_eq!(stats.deletion_skipped_reason, None);
        // Delta ids: 1 (remote won + synonyms), 3 (renamed, pending), 8 (new). 2 / 9 had nothing to write.
        let mut changed = stats.changed_ids.clone();
        changed.sort_unstable();
        assert_eq!(changed, vec![1, 3, 8]);
        assert_eq!(stats.new_ids, vec![8]);
        assert_eq!(stats.removed_ids, vec![4]);
        let mut rematch = stats.rematch_ids.clone();
        rematch.sort_unstable();
        assert_eq!(rematch, vec![1, 3, 8]);

        // Remote newer -> remote wins; custom_folder preserved; synonyms merged; list entry id stored
        let a = db.get_anime_entry_by_id(1).unwrap();
        assert_eq!(a.user_progress, 7);
        assert_eq!(a.updated_at, 200);
        assert_eq!(a.custom_folder.as_deref(), Some("D:/Anime/Alpha"));
        assert!(a.synonyms.iter().any(|s| s == "Local Alpha"));
        assert!(a.synonyms.iter().any(|s| s == "Remote Alpha"));
        assert_eq!(a.anilist_list_entry_id, Some(9001));
        // Local newer -> local kept
        let b = db.get_anime_entry_by_id(2).unwrap();
        assert_eq!(b.user_progress, 5);
        assert_eq!(b.updated_at, 500);
        // Pending -> local user fields kept, metadata refreshed, still pending
        let c = db.get_anime_entry_by_id(3).unwrap();
        assert_eq!(c.user_progress, 2);
        assert_eq!(c.title_romaji, "Gamma (renamed)");
        assert!(c.sync_pending);
        // Missing remotely -> deleted (episode unmatched); pending one survives
        assert!(db.get_anime_entry_by_id(4).is_err());
        assert_eq!(matched_id_of(&db, "C:/lib/delta.mkv"), None);
        assert!(db.get_anime_entry_by_id(5).is_ok());
        // Tombstoned -> not inserted; new -> inserted
        assert!(db.get_anime_entry_by_id(7).is_err());
        let h = db.get_anime_entry_by_id(8).unwrap();
        assert_eq!(h.user_progress, 1);
        assert!(!h.sync_pending);

        // Empty remote list never wipes the local library
        let stats = db.merge_remote_list(&[], &HashSet::new(), true).unwrap();
        assert_eq!(stats.deleted, 0);
        assert!(stats.deletion_skipped_reason.is_some());
        assert!(db.get_anime_entry_by_id(1).is_ok());

        // delete_missing = false never deletes
        let stats = db
            .merge_remote_list(&[test_entry(1, "Alpha")], &HashSet::new(), false)
            .unwrap();
        assert_eq!(stats.deleted, 0);
        assert!(db.get_anime_entry_by_id(2).is_ok());
    }

    fn insert_episode(db: &Database, anime_id: Option<i64>, file: &str, ep: u32, watched: bool) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO library_folders (id, path, label, drive_root) VALUES (1, 'C:/lib', 'lib', 'C:')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO local_episodes (folder_id, file_path, file_name, drive_root, parsed_title, normalized_title, episode_number, matched_anime_id, watched)
             VALUES (1, ?1, ?1, 'C:', 'x', 'x', ?2, ?3, ?4)",
            params![file, ep, anime_id, watched as i64],
        )
        .unwrap();
    }

    fn watched_of(db: &Database, file: &str) -> bool {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT watched FROM local_episodes WHERE file_path = ?1",
            params![file],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            != 0
    }

    fn total_changes(db: &Database) -> u64 {
        db.conn.lock().unwrap().total_changes()
    }

    fn remote_of(local: &AnimeEntry) -> AnimeEntry {
        let mut r = local.clone();
        r.custom_folder = None;
        r.sync_pending = false;
        r
    }

    #[test]
    fn test_merge_unchanged_remote_writes_nothing() {
        let db = Database::open_in_memory().expect("db");
        let mut a = test_entry(1, "Alpha");
        a.user_status = "CURRENT".into();
        a.user_progress = 4;
        a.updated_at = 100;
        a.synonyms = vec!["Alpha Syn".into()];
        a.cover_image = "https://img/a.jpg".into();
        a.cover_color = Some("#fff".into());
        a.anilist_list_entry_id = Some(11);
        a.custom_folder = Some("D:/Anime/Alpha".into());
        let mut b = test_entry(2, "Beta");
        b.next_airing_episode = Some(5);
        b.next_airing_at = Some(1_900_000_000);
        b.updated_at = 100;
        db.upsert_anime_entries_batch(&[a.clone(), b.clone()]).unwrap();

        // Remote: same user state (a bit newer updatedAt), no synonyms, empty cover / color -> nothing to write
        let mut ra = remote_of(&a);
        ra.updated_at = 150;
        ra.synonyms = vec![];
        ra.cover_image = String::new();
        ra.cover_color = None;
        let rb = remote_of(&b);
        let remote = vec![ra, rb];

        let changes_before = total_changes(&db);
        let gen_before = db.matcher_generation();
        let stats = db.merge_remote_list(&remote, &HashSet::new(), true).unwrap();
        assert_eq!(total_changes(&db), changes_before, "no row may be written");
        assert_eq!(db.matcher_generation(), gen_before, "matcher index stays valid");
        assert_eq!(
            stats,
            MergeStats::default(),
            "nothing added / changed / removed"
        );
        let a_now = db.get_anime_entry_by_id(1).unwrap();
        assert_eq!(a_now.updated_at, 100);
        assert_eq!(a_now.cover_image, "https://img/a.jpg");
        assert_eq!(a_now.custom_folder.as_deref(), Some("D:/Anime/Alpha"));

        // Changing one field writes exactly that entry; a repeat merge is a no-op again
        let mut remote2 = remote.clone();
        remote2[1].next_airing_episode = Some(6);
        let stats = db.merge_remote_list(&remote2, &HashSet::new(), true).unwrap();
        assert_eq!(stats.changed_ids, vec![2]);
        assert!(stats.rematch_ids.is_empty(), "airing change needs no rematch");
        assert_eq!(stats.updated_from_remote, 0);
        assert_eq!(db.get_anime_entry_by_id(2).unwrap().next_airing_episode, Some(6));
        let changes_before = total_changes(&db);
        let stats = db.merge_remote_list(&remote2, &HashSet::new(), true).unwrap();
        assert!(stats.changed_ids.is_empty());
        assert_eq!(total_changes(&db), changes_before);
    }

    #[test]
    fn test_merge_progress_change_updates_watched_flags_and_delta_rows() {
        let db = Database::open_in_memory().expect("db");
        let mut a = test_entry(1, "Alpha");
        a.user_status = "CURRENT".into();
        a.user_progress = 1;
        a.updated_at = 100;
        let mut b = test_entry(2, "Beta");
        b.user_status = "CURRENT".into();
        b.user_progress = 0;
        b.updated_at = 100;
        db.upsert_anime_entries_batch(&[a.clone(), b.clone()]).unwrap();
        insert_episode(&db, Some(1), "C:/lib/a1.mkv", 1, true);
        insert_episode(&db, Some(1), "C:/lib/a2.mkv", 2, false);
        insert_episode(&db, Some(1), "C:/lib/a3.mkv", 3, false);
        // Deliberately inconsistent flag on another anime: must not be touched
        insert_episode(&db, Some(2), "C:/lib/b1.mkv", 1, true);

        let mut ra = remote_of(&a);
        ra.user_progress = 2;
        ra.updated_at = 200;
        let rb = remote_of(&b);
        let stats = db.merge_remote_list(&[ra, rb], &HashSet::new(), true).unwrap();
        assert_eq!(stats.updated_from_remote, 1);
        assert_eq!(stats.changed_ids, vec![1]);
        assert!(stats.rematch_ids.is_empty());

        assert!(watched_of(&db, "C:/lib/a1.mkv"));
        assert!(watched_of(&db, "C:/lib/a2.mkv"));
        assert!(!watched_of(&db, "C:/lib/a3.mkv"));
        assert!(watched_of(&db, "C:/lib/b1.mkv"));

        let rows = db.get_anime_entries_by_ids(&[2, 1, 999, 2]).unwrap();
        assert_eq!(rows.iter().map(|e| e.id).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(rows[1].user_progress, 2);
        assert_eq!(rows[1].updated_at, 200);
        assert_eq!(rows[1].available_episodes, vec![1, 2, 3]);
        assert_eq!(rows[1].local_episode_count, 3);
        assert_eq!(rows[0].available_episodes, vec![1]);
        assert!(db.get_anime_entries_by_ids(&[]).unwrap().is_empty());
    }

    #[test]
    fn test_merge_title_change_rebuilds_normalized_titles_and_rematches() {
        let db = Database::open_in_memory().expect("db");
        let mut a = test_entry(1, "Old Show Name");
        a.updated_at = 100;
        let mut b = test_entry(2, "Second Show");
        b.updated_at = 100;
        db.upsert_anime_entries_batch(&[a.clone(), b.clone()]).unwrap();
        assert_eq!(
            db.match_title_to_anime(&normalize_anime_title("Old Show Name"), None)
                .map(|m| m.0),
            Some(1)
        );

        let mut ra = remote_of(&a);
        ra.title_romaji = "Brand New Show Name".into();
        let mut rb = remote_of(&b);
        rb.synonyms = vec!["Another Alias Title".into()];
        let stats = db.merge_remote_list(&[ra, rb], &HashSet::new(), true).unwrap();
        let mut rematch = stats.rematch_ids.clone();
        rematch.sort_unstable();
        assert_eq!(rematch, vec![1, 2]);
        assert_eq!(stats.updated_from_remote, 0);

        let norm_json = |id: i64| -> String {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT normalized_titles_json FROM anime_entries WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let n1: Vec<String> = serde_json::from_str(&norm_json(1)).unwrap();
        assert!(n1.contains(&normalize_anime_title("Brand New Show Name")));
        assert!(!n1.contains(&normalize_anime_title("Old Show Name")));
        let n2: Vec<String> = serde_json::from_str(&norm_json(2)).unwrap();
        assert!(n2.contains(&normalize_anime_title("Another Alias Title")));

        assert_eq!(
            db.match_title_to_anime(&normalize_anime_title("Brand New Show Name"), None)
                .map(|m| m.0),
            Some(1)
        );
        assert_eq!(
            db.match_title_to_anime(&normalize_anime_title("Another Alias Title"), None)
                .map(|m| m.0),
            Some(2)
        );
        let syns = db.get_anime_entry_by_id(2).unwrap().synonyms;
        assert_eq!(syns, vec!["Another Alias Title".to_string()]);
    }

    #[test]
    fn test_light_merge_keeps_heavy_metadata() {
        let db = Database::open_in_memory().expect("db");
        let mut full = test_entry(1, "Heavy");
        full.updated_at = 100;
        full.mal_id = Some(77);
        full.synopsis = "A long synopsis.".into();
        full.genres = vec!["Action".into(), "Drama".into()];
        full.studios = vec!["Madhouse".into()];
        full.banner_image = Some("https://img/banner.jpg".into());
        full.trailer_url = Some("https://www.youtube.com/watch?v=x".into());
        full.source_material = Some("MANGA".into());
        full.duration = Some(24);
        full.site_url = Some("https://anilist.co/anime/1".into());
        db.upsert_anime_entry(&full).unwrap();

        // What a light list fetch yields: heavy fields at their parse defaults
        let mut light = remote_of(&full);
        light.mal_id = None;
        light.synopsis = String::new();
        light.genres = vec![];
        light.studios = vec![];
        light.banner_image = None;
        light.trailer_url = None;
        light.source_material = None;
        light.duration = None;
        light.site_url = Some("https://anilist.co/anime/1".into());
        light.episodes = Some(13);
        light.user_progress = 3;
        light.user_status = "CURRENT".into();
        light.updated_at = 200;
        let stats = db.merge_remote_list(&[light], &HashSet::new(), true).unwrap();
        assert_eq!(stats.changed_ids, vec![1]);

        let e = db.get_anime_entry_by_id(1).unwrap();
        assert_eq!(e.episodes, Some(13));
        assert_eq!(e.user_progress, 3);
        assert_eq!(e.mal_id, Some(77));
        assert_eq!(e.synopsis, "A long synopsis.");
        assert_eq!(e.genres, vec!["Action".to_string(), "Drama".to_string()]);
        assert_eq!(e.studios, vec!["Madhouse".to_string()]);
        assert_eq!(e.banner_image.as_deref(), Some("https://img/banner.jpg"));
        assert_eq!(e.trailer_url.as_deref(), Some("https://www.youtube.com/watch?v=x"));
        assert_eq!(e.source_material.as_deref(), Some("MANGA"));
        assert_eq!(e.duration, Some(24));

        // Details for existing rows are written without touching user state; unknown ids are never inserted
        let mut details = full.clone();
        details.synopsis = "Updated synopsis.".into();
        details.user_progress = 0;
        details.user_status = "PLANNING".into();
        let ghost = test_entry(55, "Ghost");
        assert_eq!(db.refresh_existing_entries_metadata(&[details, ghost]).unwrap(), 1);
        let e = db.get_anime_entry_by_id(1).unwrap();
        assert_eq!(e.synopsis, "Updated synopsis.");
        assert_eq!(e.user_progress, 3);
        assert_eq!(e.updated_at, 200);
        assert!(db.get_anime_entry_by_id(55).is_err());
    }

    #[test]
    fn test_tombstones_and_finish_push_guard() {
        let db = Database::open_in_memory().expect("db");
        let mut a = test_entry(1, "Alpha");
        a.anilist_list_entry_id = Some(77);
        db.upsert_anime_entries_batch(&[a, test_entry(2, "Beta")])
            .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO title_aliases (normalized_alias, anime_id) VALUES ('alpha alias', 1)",
                [],
            )
            .unwrap();
        }

        // finish_push only clears pending if the entry is unchanged since the push snapshot
        let (pushed, _) = db
            .update_anime_user_state(2, "CURRENT", 1, 0.0, 0, "", None, None, None, None, true)
            .unwrap();
        assert!(pushed.sync_pending);
        db.update_anime_user_state(2, "CURRENT", 2, 0.0, 0, "", None, None, None, None, true)
            .unwrap();
        assert!(!db.finish_push(&pushed, 12345, 555).unwrap());
        let b = db.get_anime_entry_by_id(2).unwrap();
        assert!(b.sync_pending);
        assert_eq!(b.anilist_list_entry_id, Some(555));
        assert!(db.finish_push(&b, 12345, 555).unwrap());
        let b = db.get_anime_entry_by_id(2).unwrap();
        assert!(!b.sync_pending);
        assert_eq!(b.updated_at, 12345);

        db.set_sync_result(2, true, None, None).unwrap();
        assert_eq!(db.list_pending_sync_ids().unwrap(), vec![2]);

        let tombs = db.delete_entries_with_tombstones(&[1, 999]).unwrap();
        assert_eq!(
            tombs,
            vec![PendingDeletion {
                media_id: 1,
                list_entry_id: Some(77),
                title: "Alpha".into()
            }]
        );
        assert!(db.get_anime_entry_by_id(1).is_err());
        assert_eq!(alias_count(&db, 1), 0);
        assert_eq!(db.list_pending_deletions().unwrap(), tombs);
        assert_eq!(db.count_pending_deletions().unwrap(), 1);
        db.remove_pending_deletion(1).unwrap();
        assert!(db.list_pending_deletions().unwrap().is_empty());

        let hid = db
            .record_watch_history(Some(2), "Beta", 1, "mpv", "beta.mkv", false)
            .unwrap();
        db.mark_watch_history_scrobbled(hid).unwrap();
        let hist = db.list_watch_history(10, 0).unwrap();
        assert_eq!(hist[0].id, hid);
        assert!(hist[0].scrobbled_to_tracker);
    }

    #[test]
    fn test_matcher_cache_reuse_and_invalidation() {
        let (db, tmp_dir) = fixture_db("tora_test_db_matcher_cache");
        assert!(db.read_conn.is_some(), "file databases use a dedicated read connection");

        // Repeated lookups reuse the same cached index while nothing changes
        let first = db.matcher_index().unwrap();
        let mut ep = parse_filename("[SubsPlease] Sousou no Frieren - 25 (1080p).mkv");
        let m = db.match_episode_to_anime(&mut ep, None).expect("frieren match");
        assert_eq!(m.0, 154587);
        assert_eq!(m.3, 24);
        let mut ep = parse_filename("[SubsPlease] Sousou no Frieren - 26 (1080p).mkv");
        assert!(db.match_episode_to_anime(&mut ep, None).is_some());
        assert!(db.match_title_to_anime("dandadan", None).is_some());
        assert!(Arc::ptr_eq(&first, &db.matcher_index().unwrap()));

        // A user-state write bumps the generation; the next lookup sees the new progress
        let g0 = db.matcher_generation();
        db.update_anime_user_state(
            154587, "CURRENT", 26, 0.0, 0, "", None, None, None, None, false,
        )
        .unwrap();
        assert_ne!(db.matcher_generation(), g0);
        let m = db
            .match_title_to_anime("sousou no frieren", None)
            .expect("frieren match");
        assert_eq!(m.3, 26, "cached match reflects the just-changed progress");
        let second = db.matcher_index().unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(Arc::ptr_eq(&second, &db.matcher_index().unwrap()));

        // Linking an alias invalidates it
        let g1 = db.matcher_generation();
        db.link_alias_to_anime(171018, "Dan Da Dan Custom Alias").unwrap();
        assert_ne!(db.matcher_generation(), g1);
        let third = db.matcher_index().unwrap();
        assert!(!Arc::ptr_eq(&second, &third));
        assert_eq!(
            third.user_aliases.get("dan da dan custom alias").copied(),
            Some(171018)
        );

        // Binding a title alias (scanner path) invalidates it
        let g2 = db.matcher_generation();
        db.bind_title_alias("Some Other Dungeon Alias", 153518).unwrap();
        assert_ne!(db.matcher_generation(), g2);
        let fourth = db.matcher_index().unwrap();
        assert!(!Arc::ptr_eq(&third, &fourth));
        assert_eq!(
            fourth.user_aliases.get("some other dungeon alias").copied(),
            Some(153518)
        );

        // Deleting entries invalidates it and drops them from the index
        let g3 = db.matcher_generation();
        db.batch_delete_anime_entries(&[171018]).unwrap();
        assert_ne!(db.matcher_generation(), g3);
        let fifth = db.matcher_index().unwrap();
        assert!(!Arc::ptr_eq(&fourth, &fifth));
        assert!(!fifth.by_id.contains_key(&171018));
        assert!(db.match_title_to_anime("dandadan", None).is_none());

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_update_hook_covers_every_write_kind() {
        let db = Database::open_in_memory().expect("db");
        let bumped = |f: &dyn Fn()| {
            let before = db.matcher_generation();
            f();
            db.matcher_generation() != before
        };
        // INSERT ... ON CONFLICT DO UPDATE (insert and update paths)
        assert!(bumped(&|| db.upsert_anime_entry(&test_entry(1, "Alpha")).unwrap()));
        assert!(bumped(&|| db.upsert_anime_entry(&test_entry(1, "Alpha 2")).unwrap()));
        // INSERT OR REPLACE / DELETE ... WHERE on title_aliases, inside an explicit transaction
        assert!(bumped(&|| {
            let mut conn = db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            tx.execute(
                "INSERT OR REPLACE INTO title_aliases (normalized_alias, anime_id) VALUES ('a', 1)",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }));
        assert!(bumped(&|| {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO title_aliases (normalized_alias, anime_id) VALUES ('a', 1)",
                [],
            )
            .unwrap();
        }));
        assert!(bumped(&|| {
            let conn = db.conn.lock().unwrap();
            conn.execute("DELETE FROM title_aliases WHERE anime_id = 1", [])
                .unwrap();
        }));
        // Unrelated tables never invalidate the matcher
        assert!(!bumped(&|| {
            db.record_watch_history(Some(1), "Alpha", 1, "mpv", "a.mkv", false)
                .unwrap();
        }));
        // Plain UPDATE and DELETE on anime_entries
        assert!(bumped(&|| db.set_sync_result(1, true, None, None).unwrap()));
        assert!(bumped(&|| db.delete_anime_entry(1).unwrap()));
    }

    #[test]
    fn test_matcher_snapshot_waits_for_open_write_transaction() {
        let (db, tmp_dir) = fixture_db("tora_test_db_matcher_snapshot");
        let before = db.matcher_index().unwrap();
        assert_eq!(before.by_id.get(&171018).map(|e| e.2), Some(8));

        std::thread::scope(|scope| {
            let mut conn = db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            tx.execute(
                "UPDATE anime_entries SET user_progress = 11 WHERE id = 171018",
                [],
            )
            .unwrap();
            // The hook already bumped the generation, but the write is not committed yet.
            let builder = scope.spawn(|| db.matcher_index().unwrap());
            std::thread::sleep(std::time::Duration::from_millis(150));
            tx.commit().unwrap();
            drop(conn);
            let built = builder.join().unwrap();
            assert_eq!(
                built.by_id.get(&171018).map(|e| e.2),
                Some(11),
                "an index built during a write transaction must not miss that write"
            );
        });
        let after = db.matcher_index().unwrap();
        assert_eq!(after.by_id.get(&171018).map(|e| e.2), Some(11));

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_read_connection_is_query_only_and_sees_commits() {
        let tmp_dir = std::env::temp_dir().join("tora_test_db_read_conn");
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let db = Database::open(&tmp_dir.join("test.db")).expect("open test db");

        // First call inserts defaults through the writer; later calls read them through the reader
        let defaults = db.get_settings().unwrap();
        assert_eq!(defaults.theme, AppSettings::default().theme);
        let mut changed = defaults.clone();
        changed.theme = "custom-theme".into();
        db.save_settings(&changed).unwrap();
        assert_eq!(db.get_settings().unwrap().theme, "custom-theme");

        db.upsert_anime_entry(&test_entry(42, "Visible")).unwrap();
        assert_eq!(db.get_anime_entry_by_id(42).unwrap().title_romaji, "Visible");
        assert_eq!(db.list_anime_entries().unwrap().len(), 1);

        {
            let reader = db.reader().unwrap();
            assert!(reader
                .execute("DELETE FROM anime_entries WHERE id = 42", [])
                .is_err());
        }

        drop(db);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
