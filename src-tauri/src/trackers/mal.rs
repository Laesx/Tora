//! MyAnimeList (API v2). Facts behind every choice here are in `docs/trackers.md`; response fixtures in
//! `src-tauri/fixtures/trackers/mal`.
//!
//! Ids are MAL's own: a MAL list entry's local id is its MAL anime id (`mal_id` too, so anime-relations rules
//! apply by id). Values are translated to AniList's vocabulary (statuses, formats, relation types, 0–100
//! scores). MAL has no list-entry id: the anime id stands in for it.
//!
//! MAL's API has no characters, staff or source manga (`related_manga` is always empty), so those come from
//! Jikan (`api.jikan.moe`, an unofficial API reading MAL's site, same ids): only on the anime page, paced on
//! their own (`JIKAN_SPACING`), with short timeouts and a pause after a failure (`JIKAN_PAUSE`), so a Jikan
//! outage only leaves those sections empty.

use crate::db::AnimeEntry;
use crate::trackers::{
    AccessTokens, AnimePageFetch, AnimePageParts, AuthMethod, BoxFuture, Catalog, CharacterRole, FeatureSupport,
    ListSync, MediaDetails, StaffRole, VoiceActor,
    AccountExtras, MediaMetadata, MediaPrequel, MediaRanking, MediaRecommendation, MediaRelation, RemoteEntryState,
    RemoteListSnapshot, SeasonPage, SeasonalAnime, StudioRef, Tracker, TrackerAuth, TrackerDescriptor,
    TrackerEntryUpdate, TrackerError, TrackerFeature, TrackerLinks, TrackerUserProfile,
};
use reqwest::{Client, Method, RequestBuilder};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TRACKER_ID: &str = "mal";
/// Tora's MyAnimeList app ("other" type: no client secret).
const CLIENT_ID: &str = "bc3c32c4c1a4c2a7653ae2198ec200e0";
const API_URL: &str = "https://api.myanimelist.net/v2";
const TOKEN_URL: &str = "https://myanimelist.net/v1/oauth2/token";
/// Must equal the redirect URL registered for the app.
pub const REDIRECT_URI: &str = "http://localhost:8096/mal/callback";
const REDIRECT_PATH: &str = "/mal/callback";
/// MAL sends no rate-limit headers and documents no limits. One request a second through the limiter, and
/// requests made one by one inside a single call (batches) are spaced by this.
const BATCH_SPACING: Duration = Duration::from_millis(500);
/// Max items per list / season page.
const PAGE_LIMIT: u32 = 1000;
const SEASON_PAGE_LIMIT: u32 = 500;
const SEARCH_LIMIT: u32 = 50;

/// What every anime request asks for (the list carries all of it, so new entries need no detail fetch).
const ANIME_FIELDS: &str = "id,title,main_picture,alternative_titles,media_type,status,num_episodes,start_season,\
start_date,end_date,mean,rank,popularity,num_list_users,average_episode_duration,genres,studios,synopsis,source";
const LIST_STATUS_FIELDS: &str =
    "list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched,start_date,finish_date,comments,updated_at}";
const JIKAN_URL: &str = "https://api.jikan.moe/v4";
/// Jikan allows 3 requests a second and 60 a minute; an anime page needs up to 3.
const JIKAN_SPACING: Duration = Duration::from_millis(700);
/// Jikan can be slow or down: a page never waits long for it.
const JIKAN_TIMEOUT: Duration = Duration::from_secs(8);
/// After a failed Jikan request (network, overload), it is left alone this long.
const JIKAN_PAUSE: Duration = Duration::from_secs(5 * 60);
/// Staff kept per anime (like AniList's first page); the tracker's page has the rest.
const STAFF_KEPT: usize = 25;
/// Why the features from Jikan are only partly supported.
const JIKAN_NOTE: &str = "Via Jikan (unofficial MAL API); unavailable when Jikan is offline";
/// A related / recommended anime's card fields (nested fields work one level deep).
const CARD_FIELDS: &str = "id,title,main_picture,alternative_titles,media_type,status,num_episodes,start_season,start_date";

pub struct MalPlugin {
    client: Client,
    /// `(token, user id)` of the last resolved `@me`.
    viewer_cache: Mutex<Option<(String, i64)>>,
    /// When the last Jikan request was sent (held while waiting, so Jikan requests go one at a time).
    jikan_last: tokio::sync::Mutex<Option<Instant>>,
    /// Jikan failed: not asked again before this.
    jikan_paused_until: Mutex<Option<Instant>>,
}

impl MalPlugin {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            client,
            viewer_cache: Mutex::new(None),
            jikan_last: tokio::sync::Mutex::new(None),
            jikan_paused_until: Mutex::new(None),
        }
    }

    /// A request to the API: with the user's token, else the app's client id (public data).
    fn request(&self, method: Method, url: &str, token: Option<&str>) -> RequestBuilder {
        let req = self.client.request(method, url);
        match token.map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => req.bearer_auth(t),
            None => req.header("X-MAL-CLIENT-ID", CLIENT_ID),
        }
    }

    /// Send, log one line (`what` only: never the token, form values or notes) and classify the answer.
    async fn send(&self, req: RequestBuilder, what: &str) -> Result<Value, TrackerError> {
        let started = std::time::Instant::now();
        let resp = req.send().await.map_err(|e| {
            log::warn!(target: "mal", "{}: network error: {}", what, e);
            TrackerError::Network(format!("MyAnimeList network error: {}", e))
        })?;
        let status = resp.status().as_u16();
        let ms = started.elapsed().as_millis();
        if resp.status().is_success() {
            log::debug!(target: "mal", "{}: {} in {}ms", what, status, ms);
        } else {
            log::warn!(target: "mal", "{}: HTTP {} in {}ms", what, status, ms);
        }
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());
        let text = resp
            .text()
            .await
            .map_err(|e| TrackerError::Network(format!("MyAnimeList network error: {}", e)))?;
        classify(status, retry_after, &text)
    }

    /// One Jikan request: paced, short timeout, and skipped while Jikan is paused after a failure.
    async fn jikan(&self, path: &str) -> Result<Value, TrackerError> {
        let paused = self.jikan_paused_until.lock().ok().and_then(|p| *p).is_some_and(|until| Instant::now() < until);
        if paused {
            return Err(TrackerError::Network("Jikan is paused after a failure".into()));
        }
        {
            let mut last = self.jikan_last.lock().await;
            if let Some(at) = *last {
                let wait = JIKAN_SPACING.saturating_sub(at.elapsed());
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
            }
            *last = Some(Instant::now());
        }
        let started = Instant::now();
        let result = async {
            let resp = self
                .client
                .get(format!("{JIKAN_URL}{path}"))
                .timeout(JIKAN_TIMEOUT)
                .send()
                .await
                .map_err(|e| TrackerError::Network(format!("Jikan network error: {}", e)))?;
            let status = resp.status().as_u16();
            let text = resp
                .text()
                .await
                .map_err(|e| TrackerError::Network(format!("Jikan network error: {}", e)))?;
            classify_site("Jikan", status, None, &text)
        }
        .await;
        match &result {
            Ok(_) => log::debug!(target: "mal", "jikan {}: ok in {}ms", path, started.elapsed().as_millis()),
            Err(e) => {
                log::warn!(target: "mal", "jikan {}: {} in {}ms", path, e, started.elapsed().as_millis());
                if matches!(e, TrackerError::Network(_) | TrackerError::RateLimited { .. }) {
                    if let Ok(mut p) = self.jikan_paused_until.lock() {
                        *p = Some(Instant::now() + JIKAN_PAUSE);
                    }
                }
            }
        }
        result
    }

    /// Characters (all, main first) and the first staff from Jikan.
    async fn jikan_details(&self, id: i64) -> Result<MediaDetails, TrackerError> {
        let characters = self.jikan(&format!("/anime/{id}/characters")).await?;
        let staff = self.jikan(&format!("/anime/{id}/staff")).await?;
        Ok(parse_jikan_details(&characters, &staff))
    }

    /// The anime's manga / novel adaptations from Jikan, added to `media`'s relations (left as MAL sent them
    /// when Jikan fails).
    async fn add_jikan_sources(&self, id: i64, media: &mut SeasonalAnime) {
        if let Ok(body) = self.jikan(&format!("/anime/{id}/relations")).await {
            let sources = parse_jikan_sources(&body);
            media.metadata.relations.get_or_insert_with(Vec::new).extend(sources);
        }
    }

    async fn get(&self, url: &str, token: Option<&str>, what: &str) -> Result<Value, TrackerError> {
        self.send(self.request(Method::GET, url, token), what).await
    }

    async fn cached_viewer_id(&self, token: &str) -> Result<i64, TrackerError> {
        if let Ok(guard) = self.viewer_cache.lock() {
            if let Some((cached, id)) = guard.as_ref() {
                if cached == token {
                    return Ok(*id);
                }
            }
        }
        let me = self.get(&format!("{API_URL}/users/@me"), Some(token), "users/@me").await?;
        let id = me
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| TrackerError::Unauthorized("MyAnimeList did not return a user for this token".into()))?;
        if let Ok(mut guard) = self.viewer_cache.lock() {
            *guard = Some((token.to_string(), id));
        }
        Ok(id)
    }

    /// POST to the token endpoint (code exchange or refresh).
    async fn token_request(&self, form: &[(&str, &str)], what: &str) -> Result<AccessTokens, TrackerError> {
        let req = self.client.post(TOKEN_URL).form(form);
        let body = self.send(req, what).await.map_err(|e| match e {
            // A refused code / refresh token is a sign-in problem, whatever the status says
            TrackerError::Api(m) => TrackerError::Unauthorized(m),
            other => other,
        })?;
        parse_tokens(&body, chrono::Utc::now().timestamp())
    }

    /// One anime with `fields` (`Ok(None)` when MAL has no such anime).
    async fn anime(&self, id: i64, fields: &str) -> Result<Option<Value>, TrackerError> {
        let url = format!("{API_URL}/anime/{id}?fields={fields}");
        match self.get(&url, None, "anime").await {
            Ok(v) => Ok(Some(v)),
            Err(TrackerError::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Several anime, one request each, spaced by [`BATCH_SPACING`]; unknown ids are left out.
    async fn anime_batch(&self, ids: &[i64], fields: &str) -> Result<Vec<Value>, TrackerError> {
        let mut out = Vec::with_capacity(ids.len());
        for (i, &id) in ids.iter().enumerate() {
            if i > 0 {
                tokio::time::sleep(BATCH_SPACING).await;
            }
            if let Some(node) = self.anime(id, fields).await? {
                out.push(node);
            }
        }
        Ok(out)
    }

    /// Follow `paging.next` from `first`, collecting each page's `data` items.
    async fn all_pages(&self, first: String, token: Option<&str>, what: &str) -> Result<Vec<Value>, TrackerError> {
        let mut items = Vec::new();
        let mut next = Some(first);
        let mut pages = 0;
        while let Some(url) = next.take() {
            if pages > 0 {
                tokio::time::sleep(BATCH_SPACING).await;
            }
            let page = self.get(&url, token, what).await?;
            pages += 1;
            if let Some(data) = page.get("data").and_then(Value::as_array) {
                items.extend(data.iter().cloned());
            }
            next = page
                .get("paging")
                .and_then(|p| p.get("next"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if pages >= 50 {
                return Err(TrackerError::Api(format!("MyAnimeList {} kept sending pages; stopped at 50", what)));
            }
        }
        Ok(items)
    }
}

impl Default for MalPlugin {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------------------------------------
// Responses

/// HTTP status + body → JSON or a typed error.
fn classify(status: u16, retry_after: Option<u64>, text: &str) -> Result<Value, TrackerError> {
    classify_site("MyAnimeList", status, retry_after, text)
}

/// [`classify`] for `site` (MyAnimeList or Jikan), which names it in the messages.
fn classify_site(site: &str, status: u16, retry_after: Option<u64>, text: &str) -> Result<Value, TrackerError> {
    let body: Option<Value> = serde_json::from_str(text).ok();
    if (200..300).contains(&status) {
        return Ok(body.unwrap_or(Value::Null));
    }
    // `{"error": "invalid_token", "message": "token is invalid"}` / `{"message": "invalid q", "error": "bad_request"}`
    let message = body
        .as_ref()
        .and_then(|b| {
            let field = |k: &str| b.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
            field("message").or_else(|| field("hint")).or_else(|| field("error")).map(str::to_string)
        })
        .unwrap_or_else(|| format!("HTTP {}", status));
    Err(match status {
        401 => TrackerError::Unauthorized(format!("{site} refused the sign-in: {}", message)),
        404 => TrackerError::NotFound(format!("{site}: {}", message)),
        429 => TrackerError::RateLimited {
            retry_after_secs: retry_after.unwrap_or(60),
        },
        // MAL answers floods with 403 too
        403 => TrackerError::RateLimited {
            retry_after_secs: retry_after.unwrap_or(60),
        },
        500..=599 => TrackerError::Network(format!("{site} is unavailable (HTTP {})", status)),
        _ => TrackerError::Api(format!("{site}: {}", message)),
    })
}

fn parse_tokens(body: &Value, now: i64) -> Result<AccessTokens, TrackerError> {
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| TrackerError::Unauthorized("MyAnimeList sent no access token".into()))?
        .to_string();
    Ok(AccessTokens {
        access_token,
        refresh_token: body.get("refresh_token").and_then(Value::as_str).map(str::to_string),
        expires_at: body.get("expires_in").and_then(Value::as_i64).map(|s| now + s),
    })
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn u32_of(v: &Value, key: &str) -> Option<u32> {
    v.get(key).and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32)
}

/// MAL `media_type` → AniList `MediaFormat`.
fn format_of(media_type: Option<&str>) -> &'static str {
    match media_type.unwrap_or("") {
        "tv" => "TV",
        "movie" => "MOVIE",
        "ova" => "OVA",
        "ona" => "ONA",
        "special" | "tv_special" | "cm" | "pv" => "SPECIAL",
        "music" => "MUSIC",
        _ => "TV",
    }
}

/// MAL `status` → AniList `MediaStatus`.
fn airing_status_of(status: Option<&str>) -> &'static str {
    match status.unwrap_or("") {
        "currently_airing" => "RELEASING",
        "not_yet_aired" => "NOT_YET_RELEASED",
        _ => "FINISHED",
    }
}

/// MAL `source` → AniList `MediaSource`.
fn source_of(source: &str) -> &'static str {
    match source {
        "original" => "ORIGINAL",
        "manga" | "4_koma_manga" | "web_manga" => "MANGA",
        "light_novel" => "LIGHT_NOVEL",
        "novel" | "book" => "NOVEL",
        "web_novel" => "WEB_NOVEL",
        "visual_novel" => "VISUAL_NOVEL",
        "game" => "VIDEO_GAME",
        "card_game" => "GAME",
        "picture_book" => "PICTURE_BOOK",
        "mixed_media" => "MULTIMEDIA_PROJECT",
        _ => "OTHER",
    }
}

/// MAL `relation_type` → AniList `MediaRelation`.
fn relation_type_of(relation: &str) -> &'static str {
    match relation {
        "sequel" => "SEQUEL",
        "prequel" => "PREQUEL",
        "side_story" => "SIDE_STORY",
        "alternative_setting" | "alternative_version" => "ALTERNATIVE",
        "parent_story" | "full_story" => "PARENT",
        "summary" => "SUMMARY",
        "character" => "CHARACTER",
        "spin_off" => "SPIN_OFF",
        _ => "OTHER",
    }
}

/// MAL list `status` (+ rewatching) → AniList `MediaListStatus`.
fn list_status_of(status: &str, rewatching: bool) -> &'static str {
    if rewatching {
        return "REPEATING";
    }
    match status {
        "watching" => "CURRENT",
        "completed" => "COMPLETED",
        "on_hold" => "PAUSED",
        "dropped" => "DROPPED",
        _ => "PLANNING",
    }
}

/// AniList `MediaListStatus` → MAL `(status, is_rewatching)`. Rewatching is a completed anime watched again.
fn mal_status_of(status: &str) -> (&'static str, bool) {
    match status {
        "CURRENT" => ("watching", false),
        "REPEATING" => ("completed", true),
        "COMPLETED" => ("completed", false),
        "PAUSED" => ("on_hold", false),
        "DROPPED" => ("dropped", false),
        _ => ("plan_to_watch", false),
    }
}

/// 0–100 → MAL's whole points (0 = no score).
fn mal_score(score: f64) -> u32 {
    (score / 10.0).round().clamp(0.0, 10.0) as u32
}

fn picture(node: &Value) -> String {
    node.get("main_picture")
        .and_then(|p| str_of(p, "large").or_else(|| str_of(p, "medium")))
        .unwrap_or("")
        .to_string()
}

/// `{year, season: "fall"}` → (`FALL`, year).
fn start_season(node: &Value) -> (Option<String>, Option<u32>) {
    let Some(s) = node.get("start_season") else {
        return (None, None);
    };
    (str_of(s, "season").map(|x| x.to_ascii_uppercase()), u32_of(s, "year"))
}

/// `2025-02-11T12:00:00+00:00` → unix seconds (0 when missing: "oldest" in newest-wins merges).
fn timestamp(v: Option<&str>) -> i64 {
    v.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp())
        .unwrap_or(0)
}

/// An anime node (list item, search result, details) as an entry without list fields.
fn parse_anime(node: &Value) -> Option<AnimeEntry> {
    let id = node.get("id")?.as_i64()?;
    let titles = node.get("alternative_titles");
    let title_romaji = str_of(node, "title").unwrap_or("Unknown Anime").to_string();
    let title_english = titles.and_then(|t| str_of(t, "en")).map(str::to_string);
    let title_native = titles.and_then(|t| str_of(t, "ja")).map(str::to_string);
    let synonyms = titles
        .and_then(|t| t.get("synonyms"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let names = |key: &str| -> Vec<String> {
        node.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|g| str_of(g, "name")).map(str::to_string).collect())
            .unwrap_or_default()
    };
    let (season, season_year) = start_season(node);
    Some(AnimeEntry {
        id,
        anilist_id: None,
        mal_id: Some(id),
        title_romaji,
        title_english,
        title_native,
        synonyms,
        custom_synonyms: vec![],
        format: format_of(str_of(node, "media_type")).to_string(),
        airing_status: airing_status_of(str_of(node, "status")).to_string(),
        // 0 = not known yet
        episodes: u32_of(node, "num_episodes").filter(|&n| n > 0),
        duration: u32_of(node, "average_episode_duration")
            .filter(|&s| s > 0)
            .map(|s| ((s + 30) / 60).max(1)),
        season,
        season_year,
        average_score: node.get("mean").and_then(Value::as_f64).map(|m| (m * 10.0).round() as u32),
        cover_image: picture(node),
        banner_image: None,
        cover_color: None,
        synopsis: str_of(node, "synopsis").unwrap_or("").to_string(),
        genres: names("genres"),
        studios: names("studios"),
        next_airing_episode: None,
        next_airing_at: None,
        trailer_url: None,
        site_url: Some(format!("https://myanimelist.net/anime/{}", id)),
        source_material: str_of(node, "source").map(|s| source_of(s).to_string()),
        start_date: str_of(node, "start_date").map(str::to_string),
        end_date: str_of(node, "end_date").map(str::to_string),
        user_status: "PLANNING".into(),
        user_progress: 0,
        user_score: 0.0,
        user_repeats: 0,
        user_notes: String::new(),
        user_started_at: None,
        user_completed_at: None,
        custom_folder: None,
        updated_at: chrono::Utc::now().timestamp(),
        local_episode_count: 0,
        available_episodes: vec![],
        sync_pending: false,
        remote_entry_id: None,
    })
}

/// A list item (`{node, list_status}`) as a list entry.
fn parse_list_item(item: &Value) -> Option<AnimeEntry> {
    let mut entry = parse_anime(item.get("node")?)?;
    let ls = item.get("list_status")?;
    let rewatching = ls.get("is_rewatching").and_then(Value::as_bool).unwrap_or(false);
    entry.user_status = list_status_of(str_of(ls, "status").unwrap_or(""), rewatching).to_string();
    entry.user_progress = u32_of(ls, "num_episodes_watched").unwrap_or(0);
    entry.user_score = u32_of(ls, "score").unwrap_or(0).min(10) as f64 * 10.0;
    entry.user_repeats = u32_of(ls, "num_times_rewatched").unwrap_or(0);
    entry.user_notes = ls.get("comments").and_then(Value::as_str).unwrap_or("").to_string();
    entry.user_started_at = str_of(ls, "start_date").map(str::to_string);
    entry.user_completed_at = str_of(ls, "finish_date").map(str::to_string);
    entry.updated_at = timestamp(str_of(ls, "updated_at"));
    entry.remote_entry_id = Some(entry.id);
    Some(entry)
}

/// A related / recommended anime's card.
fn parse_card(node: &Value, relation_type: &str) -> Option<MediaRelation> {
    let (_, year) = start_season(node);
    let titles = node.get("alternative_titles");
    Some(MediaRelation {
        id: node.get("id")?.as_i64()?,
        relation_type: relation_type.to_string(),
        media_type: "ANIME".into(),
        title_romaji: str_of(node, "title").unwrap_or("Unknown Anime").to_string(),
        title_english: titles.and_then(|t| str_of(t, "en")).map(str::to_string),
        title_native: titles.and_then(|t| str_of(t, "ja")).map(str::to_string),
        format: str_of(node, "media_type").map(|m| format_of(Some(m)).to_string()),
        status: str_of(node, "status").map(|s| airing_status_of(Some(s)).to_string()),
        episodes: u32_of(node, "num_episodes").filter(|&n| n > 0),
        year: year.or_else(|| str_of(node, "start_date").and_then(|d| d.get(..4)?.parse().ok())),
        cover_image: Some(picture(node)).filter(|p| !p.is_empty()),
    })
}

fn parse_relations(node: &Value) -> Option<Vec<MediaRelation>> {
    let related = node.get("related_anime")?.as_array()?;
    Some(
        related
            .iter()
            .filter_map(|r| {
                let kind = relation_type_of(str_of(r, "relation_type").unwrap_or(""));
                parse_card(r.get("node")?, kind)
            })
            .collect(),
    )
}

fn parse_recommendations(node: &Value) -> Vec<MediaRecommendation> {
    node.get("recommendations")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    Some(MediaRecommendation {
                        rating: r.get("num_recommendations").and_then(Value::as_i64).unwrap_or(0),
                        media: parse_card(r.get("node")?, "RECOMMENDATION")?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// An anime node as a season / metadata item. `relations` is `None` when the request didn't ask for them
/// (season pages), so opening the anime fetches them.
fn parse_seasonal(node: &Value) -> Option<SeasonalAnime> {
    let entry = parse_anime(node)?;
    let relations = parse_relations(node);
    let prequels = relations.as_ref().map(|rels| {
        rels.iter()
            .filter(|r| r.relation_type == "PREQUEL")
            .map(|r| MediaPrequel {
                id: r.id,
                title_romaji: r.title_romaji.clone(),
                title_english: r.title_english.clone(),
                title_native: r.title_native.clone(),
            })
            .collect()
    });
    let studios = node
        .get("studios")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    Some(StudioRef {
                        id: s.get("id")?.as_i64()?,
                        name: str_of(s, "name")?.to_string(),
                        is_main: true,
                        is_animation_studio: true,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut rankings = Vec::new();
    for (key, kind, context) in [("rank", "RATED", "highest rated all time"), ("popularity", "POPULAR", "most popular all time")] {
        if let Some(rank) = u32_of(node, key).filter(|&r| r > 0) {
            rankings.push(MediaRanking {
                rank,
                kind: kind.into(),
                all_time: true,
                season: None,
                year: None,
                context: context.into(),
            });
        }
    }
    Some(SeasonalAnime {
        popularity: u32_of(node, "num_list_users"),
        metadata: MediaMetadata {
            mean_score: entry.average_score,
            favourites: None,
            tags: vec![],
            studios,
            rankings,
            // Season pages carry no relations: "no known prequel" rather than "stored before the field"
            prequels: Some(prequels.unwrap_or_default()),
            relations,
        },
        entry,
    })
}

/// MAL writes people as "Last, First": shown as "First Last" (one comma only; anything else as written).
fn display_name(name: &str) -> String {
    match name.split_once(", ") {
        Some((last, first)) if !last.is_empty() && !first.is_empty() && !first.contains(',') => {
            format!("{} {}", first, last)
        }
        _ => name.to_string(),
    }
}

/// A Jikan `images` object's picture; MAL's "no picture" placeholder counts as none.
fn jikan_image(v: &Value) -> Option<String> {
    v.get("images")
        .and_then(|i| i.get("jpg"))
        .and_then(|j| str_of(j, "image_url"))
        .filter(|u| !u.contains("questionmark"))
        .map(str::to_string)
}

fn jikan_data(body: &Value) -> &[Value] {
    body.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Jikan `/anime/{id}/characters` + `/staff` → the anime page's details (characters all at once, main
/// characters first, then the most favourited).
fn parse_jikan_details(characters: &Value, staff: &Value) -> MediaDetails {
    let mut with_favourites: Vec<(CharacterRole, i64)> = jikan_data(characters)
        .iter()
        .filter_map(|c| {
            let character = c.get("character")?;
            let voice_actors = c
                .get("voice_actors")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| {
                            let person = v.get("person")?;
                            Some(VoiceActor {
                                id: person.get("mal_id")?.as_i64()?,
                                name: display_name(str_of(person, "name")?),
                                name_native: None,
                                image: jikan_image(person),
                                language: str_of(v, "language").unwrap_or("Japanese").to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let role = CharacterRole {
                id: character.get("mal_id")?.as_i64()?,
                name: display_name(str_of(character, "name")?),
                name_native: None,
                image: jikan_image(character),
                role: str_of(c, "role").unwrap_or("Supporting").to_ascii_uppercase(),
                voice_actors,
            };
            Some((role, c.get("favorites").and_then(Value::as_i64).unwrap_or(0)))
        })
        .collect();
    with_favourites.sort_by(|(a, fa), (b, fb)| (b.role == "MAIN").cmp(&(a.role == "MAIN")).then(fb.cmp(fa)));
    let all_staff: Vec<StaffRole> = jikan_data(staff)
        .iter()
        .filter_map(|s| {
            let person = s.get("person")?;
            let positions: Vec<&str> = s
                .get("positions")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            Some(StaffRole {
                id: person.get("mal_id")?.as_i64()?,
                name: display_name(str_of(person, "name")?),
                name_native: None,
                image: jikan_image(person),
                role: positions.join(", "),
            })
        })
        .collect();
    MediaDetails {
        characters: with_favourites.into_iter().map(|(c, _)| c).collect(),
        characters_page: 1,
        characters_has_more: false,
        staff_has_more: all_staff.len() > STAFF_KEPT,
        staff: all_staff.into_iter().take(STAFF_KEPT).collect(),
        recommendations: vec![],
        recommendations_fetched: false,
    }
}

/// Jikan `/anime/{id}/relations` → the manga / novels the anime adapts (MAL's own API never sends them).
fn parse_jikan_sources(body: &Value) -> Vec<MediaRelation> {
    jikan_data(body)
        .iter()
        .filter(|r| str_of(r, "relation") == Some("Adaptation"))
        .flat_map(|r| r.get("entry").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]))
        .filter(|e| str_of(e, "type") == Some("manga"))
        .filter_map(|e| {
            Some(MediaRelation {
                id: e.get("mal_id")?.as_i64()?,
                relation_type: "ADAPTATION".into(),
                // Jikan says "manga" for light novels too: the format stays unknown
                media_type: "MANGA".into(),
                title_romaji: str_of(e, "name")?.to_string(),
                ..Default::default()
            })
        })
        .collect()
}

fn related_fields() -> String {
    format!("{ANIME_FIELDS},related_anime{{node{{{CARD_FIELDS}}}}}")
}

// ---------------------------------------------------------------------------------------------------------
// Tracker

impl Tracker for MalPlugin {
    fn descriptor(&self) -> TrackerDescriptor {
        TrackerDescriptor {
            id: TRACKER_ID.into(),
            name: "MyAnimeList".into(),
            website_url: "https://myanimelist.net".into(),
            auth: AuthMethod::BrowserCode {
                authorize_url: format!(
                    "https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id={CLIENT_ID}\
&code_challenge={{challenge}}&code_challenge_method=plain&state={{state}}&redirect_uri={}",
                    urlencoding::encode(REDIRECT_URI)
                ),
                redirect_path: REDIRECT_PATH.into(),
            },
            links: TrackerLinks {
                anime: "https://myanimelist.net/anime/{id}".into(),
                manga: "https://myanimelist.net/manga/{id}".into(),
                character: "https://myanimelist.net/character/{id}".into(),
                staff: "https://myanimelist.net/people/{id}".into(),
                user: "https://myanimelist.net/profile/{name}".into(),
                anime_staff: Some("https://myanimelist.net/anime/{id}/_/characters".into()),
                studio: Some("https://myanimelist.net/anime/producer/{id}".into()),
                // Genre pages are by id, which the app doesn't keep
                genre: None,
                tag: None,
            },
            features: vec![
                FeatureSupport::full(TrackerFeature::Recommendations),
                FeatureSupport::partial(TrackerFeature::Characters, JIKAN_NOTE),
                FeatureSupport::partial(TrackerFeature::Staff, JIKAN_NOTE),
                FeatureSupport::partial(TrackerFeature::SourceMaterial, JIKAN_NOTE),
            ],
        }
    }

    fn auth(&self) -> &dyn TrackerAuth {
        self
    }

    fn list(&self) -> &dyn ListSync {
        self
    }

    fn catalog(&self) -> &dyn Catalog {
        self
    }

    fn extras(&self) -> &dyn AccountExtras {
        self
    }
}

impl TrackerAuth for MalPlugin {
    fn profile<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<TrackerUserProfile, TrackerError>> {
        Box::pin(async move {
            let me = self
                .get(&format!("{API_URL}/users/@me?fields=anime_statistics"), Some(token), "users/@me")
                .await?;
            let user_id = me
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| TrackerError::Unauthorized("MyAnimeList did not return a user for this token".into()))?;
            if let Ok(mut guard) = self.viewer_cache.lock() {
                *guard = Some((token.trim().to_string(), user_id));
            }
            let stats = me.get("anime_statistics");
            Ok(TrackerUserProfile {
                user_id,
                username: str_of(&me, "name").unwrap_or("").to_string(),
                avatar_url: str_of(&me, "picture").map(str::to_string),
                anime_count: stats.and_then(|s| u32_of(s, "num_items")).unwrap_or(0),
                episodes_watched: stats.and_then(|s| u32_of(s, "num_episodes")).unwrap_or(0),
            })
        })
    }

    fn viewer_id<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<i64, TrackerError>> {
        Box::pin(async move { self.cached_viewer_id(token.trim()).await })
    }

    fn exchange_code<'a>(&'a self, code: &'a str, verifier: &'a str) -> BoxFuture<'a, Result<AccessTokens, TrackerError>> {
        Box::pin(async move {
            self.token_request(
                &[
                    ("client_id", CLIENT_ID),
                    ("grant_type", "authorization_code"),
                    ("code", code),
                    ("redirect_uri", REDIRECT_URI),
                    ("code_verifier", verifier),
                ],
                "oauth2/token (code)",
            )
            .await
        })
    }

    fn refresh_tokens<'a>(&'a self, refresh_token: &'a str) -> BoxFuture<'a, Result<AccessTokens, TrackerError>> {
        Box::pin(async move {
            self.token_request(
                &[
                    ("client_id", CLIENT_ID),
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token),
                ],
                "oauth2/token (refresh)",
            )
            .await
        })
    }
}

impl ListSync for MalPlugin {
    fn list_has_details(&self) -> bool {
        true
    }

    fn fetch_user_list<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<RemoteListSnapshot, TrackerError>> {
        Box::pin(async move {
            let viewer_id = self.cached_viewer_id(token.trim()).await?;
            let first = format!(
                "{API_URL}/users/@me/animelist?limit={PAGE_LIMIT}&nsfw=true&fields={LIST_STATUS_FIELDS},{ANIME_FIELDS}"
            );
            let items = self.all_pages(first, Some(token), "animelist").await?;
            let mut seen = HashSet::new();
            let entries = items
                .iter()
                .filter_map(parse_list_item)
                .filter(|e| seen.insert(e.id))
                .collect();
            Ok(RemoteListSnapshot {
                viewer_id,
                entries,
                custom_lists: vec![],
                memberships: HashMap::new(),
                // MAL scores are always whole points out of 10
                score_format: Some("POINT_10".into()),
            })
        })
    }

    fn save_list_entry<'a>(
        &'a self,
        token: &'a str,
        update: &'a TrackerEntryUpdate,
    ) -> BoxFuture<'a, Result<RemoteEntryState, TrackerError>> {
        Box::pin(async move {
            let (status, rewatching) = mal_status_of(&update.status);
            let score = mal_score(update.score).to_string();
            let progress = update.progress.to_string();
            let repeats = update.repeat.to_string();
            let mut form: Vec<(&str, &str)> = vec![
                ("status", status),
                ("is_rewatching", if rewatching { "true" } else { "false" }),
                ("score", &score),
                ("num_watched_episodes", &progress),
                ("num_times_rewatched", &repeats),
                ("comments", &update.notes),
            ];
            // An empty date is not known to clear it on MAL: dates are only ever set
            if let Some(d) = update.started_at.as_deref() {
                form.push(("start_date", d));
            }
            if let Some(d) = update.completed_at.as_deref() {
                form.push(("finish_date", d));
            }
            let url = format!("{API_URL}/anime/{}/my_list_status", update.media_id);
            let req = self.request(Method::PATCH, &url, Some(token)).form(&form);
            let state = self.send(req, "my_list_status (save)").await?;
            let rewatching = state.get("is_rewatching").and_then(Value::as_bool).unwrap_or(rewatching);
            Ok(RemoteEntryState {
                list_entry_id: update.media_id,
                status: list_status_of(str_of(&state, "status").unwrap_or(status), rewatching).to_string(),
                progress: u32_of(&state, "num_episodes_watched").unwrap_or(update.progress),
                updated_at: Some(timestamp(str_of(&state, "updated_at")))
                    .filter(|&t| t > 0)
                    .unwrap_or_else(|| chrono::Utc::now().timestamp()),
            })
        })
    }

    fn delete_list_entry<'a>(
        &'a self,
        token: &'a str,
        media_id: i64,
        _remote_entry_id: Option<i64>,
    ) -> BoxFuture<'a, Result<(), TrackerError>> {
        Box::pin(async move {
            let url = format!("{API_URL}/anime/{}/my_list_status", media_id);
            match self.send(self.request(Method::DELETE, &url, Some(token)), "my_list_status (delete)").await {
                Ok(_) | Err(TrackerError::NotFound(_)) => Ok(()),
                Err(e) => Err(e),
            }
        })
    }
}

impl Catalog for MalPlugin {
    fn tracker_name(&self) -> &str {
        "MyAnimeList"
    }

    fn fetch_media_details<'a>(&'a self, ids: &'a [i64]) -> BoxFuture<'a, Result<Vec<AnimeEntry>, TrackerError>> {
        Box::pin(async move {
            let nodes = self.anime_batch(ids, ANIME_FIELDS).await?;
            Ok(nodes.iter().filter_map(parse_anime).collect())
        })
    }

    fn search_anime<'a>(
        &'a self,
        query: &'a str,
        season: Option<&'a str>,
        year: Option<u32>,
    ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, TrackerError>> {
        Box::pin(async move {
            // MAL rejects 1-character queries (`invalid q`) and caps their length
            let q: String = query.trim().chars().take(64).collect();
            if q.chars().count() < 2 {
                return Ok(vec![]);
            }
            let url = format!(
                "{API_URL}/anime?q={}&limit={SEARCH_LIMIT}&nsfw=true&fields={ANIME_FIELDS}",
                urlencoding::encode(&q)
            );
            let page = self.get(&url, None, "anime (search)").await?;
            let season = season.map(str::to_ascii_uppercase);
            Ok(page
                .get("data")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|i| parse_anime(i.get("node")?)).collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .filter(|e| season.is_none() || e.season == season)
                .filter(|e| year.is_none() || e.season_year == year)
                .collect())
        })
    }

    fn fetch_season_page<'a>(&'a self, season: &'a str, year: u32, page: u32) -> BoxFuture<'a, Result<SeasonPage, TrackerError>> {
        Box::pin(async move {
            let offset = page.saturating_sub(1) * SEASON_PAGE_LIMIT;
            let url = format!(
                "{API_URL}/anime/season/{year}/{}?limit={SEASON_PAGE_LIMIT}&offset={offset}&sort=anime_num_list_users&nsfw=true&fields={ANIME_FIELDS}",
                season.to_ascii_lowercase()
            );
            let body = self.get(&url, None, "anime/season").await?;
            let wanted = season.to_ascii_uppercase();
            // MAL also lists anime still airing from earlier seasons
            let items = body
                .get("data")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|i| parse_seasonal(i.get("node")?))
                        .filter(|s| s.entry.season.as_deref() == Some(wanted.as_str()) && s.entry.season_year == Some(year))
                        .collect()
                })
                .unwrap_or_default();
            let has_next_page = body
                .get("paging")
                .and_then(|p| p.get("next"))
                .and_then(Value::as_str)
                .is_some();
            Ok(SeasonPage { items, has_next_page })
        })
    }

    fn fetch_media_metadata<'a>(&'a self, id: i64) -> BoxFuture<'a, Result<Option<SeasonalAnime>, TrackerError>> {
        Box::pin(async move {
            let Some(mut media) = self.anime(id, &related_fields()).await?.as_ref().and_then(parse_seasonal) else {
                return Ok(None);
            };
            self.add_jikan_sources(id, &mut media).await;
            Ok(Some(media))
        })
    }

    fn fetch_media_metadata_batch<'a>(&'a self, ids: &'a [i64]) -> BoxFuture<'a, Result<Vec<SeasonalAnime>, TrackerError>> {
        Box::pin(async move {
            let nodes = self.anime_batch(ids, &related_fields()).await?;
            Ok(nodes.iter().filter_map(parse_seasonal).collect())
        })
    }

    /// Metadata and recommendations in one MAL request; characters, staff and source manga from Jikan (a
    /// Jikan failure leaves them out: the page asks again next time). No followed users.
    fn fetch_anime_page<'a>(
        &'a self,
        id: i64,
        parts: &'a AnimePageParts,
        _token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<AnimePageFetch, TrackerError>> {
        Box::pin(async move {
            let mut fetch = AnimePageFetch::default();
            if parts.metadata || parts.recommendations {
                let mut fields = related_fields();
                if parts.recommendations {
                    fields.push_str(&format!(",recommendations{{node{{{CARD_FIELDS}}},num_recommendations}}"));
                }
                let Some(node) = self.anime(id, &fields).await? else {
                    return Ok(fetch);
                };
                if parts.metadata {
                    fetch.media = parse_seasonal(&node);
                    if let Some(media) = fetch.media.as_mut() {
                        self.add_jikan_sources(id, media).await;
                    }
                }
                fetch.recommendations = parts.recommendations.then(|| parse_recommendations(&node));
            }
            if parts.details {
                fetch.details = self.jikan_details(id).await.ok();
            }
            Ok(fetch)
        })
    }
}

impl AccountExtras for MalPlugin {
    fn tracker_name(&self) -> &str {
        "MyAnimeList"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/fixtures/trackers/mal/{}", env!("CARGO_MANIFEST_DIR"), name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn list_items_become_entries_in_anilist_terms() {
        let page = fixture("animelist_page.json");
        let items = page["data"].as_array().unwrap();
        let entries: Vec<AnimeEntry> = items.iter().filter_map(parse_list_item).collect();
        assert_eq!(entries.len(), items.len());

        let aharen = entries.iter().find(|e| e.id == 59466).unwrap();
        assert_eq!((aharen.mal_id, aharen.anilist_id), (Some(59466), None));
        assert_eq!(aharen.title_romaji, "Aharen-san wa Hakarenai Season 2");
        assert_eq!(aharen.title_native.as_deref(), Some("阿波連さんははかれない season2"));
        assert_eq!(aharen.synonyms, vec!["Aharen Is Indecipherable 2nd Season".to_string()]);
        assert_eq!((aharen.format.as_str(), aharen.airing_status.as_str()), ("TV", "FINISHED"));
        assert_eq!((aharen.season.as_deref(), aharen.season_year), (Some("SPRING"), Some(2025)));
        assert_eq!((aharen.episodes, aharen.duration), (Some(12), Some(24)));
        assert_eq!(aharen.average_score, Some(75));
        assert_eq!(aharen.source_material.as_deref(), Some("MANGA"));
        assert_eq!(aharen.studios, vec!["Felix Film".to_string()]);
        assert!(aharen.cover_image.ends_with("148355l.jpg"));
        assert_eq!(aharen.site_url.as_deref(), Some("https://myanimelist.net/anime/59466"));
        // List fields: whole points → 0–100, dates as sent, updated_at as unix seconds
        assert_eq!(aharen.user_status, "CURRENT");
        assert_eq!((aharen.user_progress, aharen.user_score), (3, 70.0));
        assert_eq!(aharen.user_started_at.as_deref(), Some("2024-02-02"));
        assert_eq!(aharen.user_completed_at, None);
        assert_eq!(aharen.updated_at, 1_739_275_200);
        assert_eq!(aharen.remote_entry_id, Some(59466));
    }

    #[test]
    fn statuses_and_scores_round_trip() {
        for status in ["CURRENT", "COMPLETED", "PAUSED", "DROPPED", "PLANNING", "REPEATING"] {
            let (mal, rewatching) = mal_status_of(status);
            assert_eq!(list_status_of(mal, rewatching), status);
        }
        assert_eq!(list_status_of("completed", true), "REPEATING");
        assert_eq!((mal_score(0.0), mal_score(74.0), mal_score(75.0), mal_score(100.0)), (0, 7, 8, 10));
    }

    #[test]
    fn details_carry_relations_and_recommendations() {
        let node = fixture("anime_details_52991.json");
        let media = parse_seasonal(&node).unwrap();
        assert_eq!(media.entry.title_english.as_deref(), Some("Frieren: Beyond Journey's End"));
        assert_eq!(media.popularity, Some(1_548_353));
        assert_eq!(media.metadata.mean_score, Some(92));
        assert_eq!(media.metadata.rankings[0].rank, 1);
        assert_eq!(media.metadata.rankings[0].kind, "RATED");
        let relations = media.metadata.relations.unwrap();
        let sequel = relations.iter().find(|r| r.id == 59978).unwrap();
        assert_eq!((sequel.relation_type.as_str(), sequel.media_type.as_str()), ("SEQUEL", "ANIME"));
        assert!(relations.iter().any(|r| r.id == 56885 && r.relation_type == "SIDE_STORY"));
        assert_eq!(media.metadata.prequels, Some(vec![]));
        let recs = parse_recommendations(&node);
        assert_eq!((recs[0].media.id, recs[0].rating), (33352, 31));
        assert_eq!(recs[0].media.title_romaji, "Violet Evergarden");
    }

    #[test]
    fn season_items_without_relations_still_count_as_upgraded() {
        let page = fixture("season_2026_fall.json");
        let one_piece = page["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["node"]["id"] == 21)
            .unwrap();
        let media = parse_seasonal(&one_piece["node"]).unwrap();
        // Unknown episode count, relations to be fetched when opened, prequels known to be none
        assert_eq!(media.entry.episodes, None);
        assert_eq!(media.metadata.relations, None);
        assert_eq!(media.metadata.prequels, Some(vec![]));
        assert_eq!(media.entry.airing_status, "RELEASING");
    }

    #[test]
    fn errors_are_typed() {
        assert!(matches!(
            classify(401, None, r#"{"error":"invalid_token","message":"token is invalid"}"#),
            Err(TrackerError::Unauthorized(m)) if m.contains("token is invalid")
        ));
        assert!(matches!(classify(404, None, "{}"), Err(TrackerError::NotFound(_))));
        assert_eq!(
            classify(429, Some(7), ""),
            Err(TrackerError::RateLimited { retry_after_secs: 7 })
        );
        assert!(matches!(classify(503, None, "<html>"), Err(TrackerError::Network(_))));
        assert_eq!(
            classify(400, None, r#"{"message":"invalid q","error":"bad_request"}"#),
            Err(TrackerError::Api("MyAnimeList: invalid q".into()))
        );
        let tokens = parse_tokens(
            &serde_json::json!({"token_type": "Bearer", "expires_in": 2_678_400, "access_token": "a", "refresh_token": "r"}),
            1_000,
        )
        .unwrap();
        assert_eq!(
            (tokens.access_token.as_str(), tokens.refresh_token.as_deref(), tokens.expires_at),
            ("a", Some("r"), Some(2_679_400))
        );
    }

    // Jikan v4 shapes (hand-written from its documentation: api.jikan.moe was unreachable when this was
    // written; replace with real responses once fetched)
    fn jikan_characters() -> Value {
        serde_json::json!({ "data": [
            { "character": { "mal_id": 200, "name": "Heiter",
                "images": { "jpg": { "image_url": "https://cdn.myanimelist.net/images/characters/1/200.jpg" } } },
              "role": "Supporting", "favorites": 900, "voice_actors": [] },
            { "character": { "mal_id": 184947, "name": "Frieren",
                "images": { "jpg": { "image_url": "https://cdn.myanimelist.net/images/characters/7/525105.jpg" } } },
              "role": "Main", "favorites": 50000,
              "voice_actors": [
                { "person": { "mal_id": 34785, "name": "Tanezaki, Atsumi",
                    "images": { "jpg": { "image_url": "https://cdn.myanimelist.net/images/voiceactors/1/1.jpg" } } },
                  "language": "Japanese" },
                { "person": { "mal_id": 9, "name": "Mallory Low",
                    "images": { "jpg": { "image_url": "https://cdn.myanimelist.net/images/questionmark_23.gif" } } },
                  "language": "English" }
              ] },
            { "character": { "mal_id": 201, "name": "Himmel",
                "images": { "jpg": { "image_url": "https://cdn.myanimelist.net/images/characters/1/201.jpg" } } },
              "role": "Supporting", "favorites": 5000, "voice_actors": [] }
        ] })
    }

    #[test]
    fn jikan_characters_staff_and_sources_in_anilist_terms() {
        let staff: Vec<Value> = (0..30)
            .map(|i| serde_json::json!({ "person": { "mal_id": 1000 + i, "name": format!("Person, Number{i}"),
                "images": { "jpg": { "image_url": null } } }, "positions": ["Director", "Storyboard"] }))
            .collect();
        let details = parse_jikan_details(&jikan_characters(), &serde_json::json!({ "data": staff }));
        // Main characters first, then the most favourited; names as "First Last"
        let names: Vec<&str> = details.characters.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["Frieren", "Himmel", "Heiter"]);
        let frieren = &details.characters[0];
        assert_eq!((frieren.id, frieren.role.as_str()), (184947, "MAIN"));
        assert_eq!(frieren.voice_actors[0].name, "Atsumi Tanezaki");
        assert_eq!(frieren.voice_actors[0].language, "Japanese");
        // MAL's "no picture" placeholder is no picture
        assert_eq!(frieren.voice_actors[1].image, None);
        assert_eq!((details.characters_page, details.characters_has_more), (1, false));
        assert_eq!((details.staff.len(), details.staff_has_more), (25, true));
        assert_eq!(details.staff[0].name, "Number0 Person");
        assert_eq!(details.staff[0].role, "Director, Storyboard");

        let relations = serde_json::json!({ "data": [
            { "relation": "Adaptation", "entry": [
                { "mal_id": 126287, "type": "manga", "name": "Sousou no Frieren", "url": "https://myanimelist.net/manga/126287" }
            ] },
            { "relation": "Sequel", "entry": [ { "mal_id": 59978, "type": "anime", "name": "Season 2" } ] }
        ] });
        let sources = parse_jikan_sources(&relations);
        assert_eq!(sources.len(), 1);
        assert_eq!(
            (sources[0].id, sources[0].relation_type.as_str(), sources[0].media_type.as_str()),
            (126287, "ADAPTATION", "MANGA")
        );
        assert_eq!(sources[0].title_romaji, "Sousou no Frieren");
        assert_eq!(display_name("Elric, Edward"), "Edward Elric");
        assert_eq!(display_name("Frieren"), "Frieren");
        assert_eq!(parse_jikan_details(&serde_json::json!({}), &serde_json::json!({})).characters_page, 1);
    }

    #[test]
    fn the_authorize_url_has_the_placeholders_the_listener_fills() {
        let AuthMethod::BrowserCode { authorize_url, redirect_path } = MalPlugin::new().descriptor().auth else {
            panic!("MAL signs in with a code");
        };
        assert!(authorize_url.contains("code_challenge={challenge}"));
        assert!(authorize_url.contains("state={state}"));
        assert!(authorize_url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A8096%2Fmal%2Fcallback"));
        assert_eq!(redirect_path, "/mal/callback");
    }
}
