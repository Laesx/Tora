use crate::db::AnimeEntry;
use crate::plugins::{
    AiringScheduleItem, AiringSchedulePage, BoxFuture, MediaMetadata, MediaRanking, MediaTag,
    RemoteEntryState, RemoteListSnapshot, SeasonPage, SeasonalAnime, StudioRef,
    TrackerEntryUpdate, TrackerError, TrackerPlugin, TrackerPluginDescriptor, TrackerUserProfile,
    MEDIA_DETAILS_CHUNK,
};
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;

const ANILIST_GRAPHQL_URL: &str = "https://graphql.anilist.co";

pub struct AniListPlugin {
    client: Client,
    /// `(token, viewer_id)` of the last resolved `Viewer`, so deletes don't need an extra round trip.
    viewer_cache: Mutex<Option<(String, i64)>>,
}

impl AniListPlugin {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("Tora/0.1.0 (Anime Library Manager)")
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Self {
            client,
            viewer_cache: Mutex::new(None),
        }
    }

    fn strip_html(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut in_tag = false;
        let replaced = input
            .replace("<br>", "\n")
            .replace("<br/>", "\n")
            .replace("<br />", "\n");
        for ch in replaced.chars() {
            match ch {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(ch),
                _ => {}
            }
        }
        out.trim().to_string()
    }

    fn parse_media_node(media: &Value, entry_node: Option<&Value>) -> Option<AnimeEntry> {
        let id = media.get("id")?.as_i64()?;
        let mal_id = media.get("idMal").and_then(|v| v.as_i64());
        let title_obj = media.get("title")?;
        let title_romaji = title_obj
            .get("romaji")
            .and_then(|v| v.as_str())
            .or_else(|| title_obj.get("english").and_then(|v| v.as_str()))
            .unwrap_or("Unknown Anime")
            .to_string();
        let title_english = title_obj
            .get("english")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let title_native = title_obj
            .get("native")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let synonyms: Vec<String> = media
            .get("synonyms")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|s| s.as_str().map(|x| x.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let format = media
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("TV")
            .to_string();
        let airing_status = media
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("FINISHED")
            .to_string();
        let episodes = media
            .get("episodes")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let duration = media
            .get("duration")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let season = media
            .get("season")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let season_year = media
            .get("seasonYear")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let average_score = media
            .get("averageScore")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);

        let cover_obj = media.get("coverImage");
        let cover_image = cover_obj
            .and_then(|c| {
                c.get("large")
                    .and_then(|v| v.as_str())
                    .or_else(|| c.get("extraLarge").and_then(|v| v.as_str()))
            })
            .unwrap_or("")
            .to_string();
        let cover_color = cover_obj
            .and_then(|c| c.get("color"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let banner_image = media
            .get("bannerImage")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let raw_desc = media
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let synopsis = Self::strip_html(raw_desc);

        let genres: Vec<String> = media
            .get("genres")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|g| g.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let studios: Vec<String> = media
            .get("studios")
            .and_then(|s| s.get("nodes"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|n| n.get("name").and_then(|x| x.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let next_airing_episode = media
            .get("nextAiringEpisode")
            .and_then(|n| n.get("episode"))
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let next_airing_at = media
            .get("nextAiringEpisode")
            .and_then(|n| n.get("airingAt"))
            .and_then(|v| v.as_i64());

        let trailer_url = media.get("trailer").and_then(|t| {
            let site = t.get("site")?.as_str()?;
            let tid = t.get("id")?.as_str()?;
            if site.eq_ignore_ascii_case("youtube") {
                Some(format!("https://www.youtube.com/watch?v={}", tid))
            } else {
                None
            }
        });

        let site_url = media
            .get("siteUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| Some(format!("https://anilist.co/anime/{}", id)));

        let source_material = media
            .get("source")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let now = chrono::Utc::now().timestamp();
        let parse_fuzzy_date = |obj: Option<&Value>| -> Option<String> {
            let d = obj?;
            let y = d.get("year")?.as_i64()?;
            if y <= 0 {
                return None;
            }
            let m = d.get("month").and_then(|v| v.as_i64()).unwrap_or(1).clamp(1, 12);
            let day = d.get("day").and_then(|v| v.as_i64()).unwrap_or(1).clamp(1, 31);
            Some(format!("{:04}-{:02}-{:02}", y, m, day))
        };

        let (
            user_status,
            user_progress,
            user_score,
            user_repeats,
            user_notes,
            user_started_at,
            user_completed_at,
            updated_at,
            list_entry_id,
        ) = if let Some(en) = entry_node {
            (
                en.get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("CURRENT")
                    .to_string(),
                en.get("progress")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                en.get("score")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                en.get("repeat")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                en.get("notes")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                parse_fuzzy_date(en.get("startedAt")),
                parse_fuzzy_date(en.get("completedAt")),
                en.get("updatedAt")
                    .and_then(|v| v.as_i64())
                    .filter(|&t| t > 0)
                    .unwrap_or(now),
                en.get("id").and_then(|v| v.as_i64()),
            )
        } else {
            ("PLANNING".to_string(), 0, 0.0, 0, String::new(), None, None, now, None)
        };

        Some(AnimeEntry {
            id,
            anilist_id: Some(id),
            mal_id,
            title_romaji,
            title_english,
            title_native,
            synonyms,
            format,
            airing_status,
            episodes,
            duration,
            season,
            season_year,
            average_score,
            cover_image,
            banner_image,
            cover_color,
            synopsis,
            genres,
            studios,
            next_airing_episode,
            next_airing_at,
            trailer_url,
            site_url,
            source_material,
            start_date: parse_partial_date(media.get("startDate")),
            end_date: parse_partial_date(media.get("endDate")),
            user_status,
            user_progress,
            user_score,
            user_repeats,
            user_notes,
            user_started_at,
            user_completed_at,
            custom_folder: None,
            updated_at,
            local_episode_count: 0,
            available_episodes: vec![],
            sync_pending: false,
            anilist_list_entry_id: list_entry_id,
        })
    }

    async fn graphql_request(
        &self,
        query: &str,
        variables: Value,
        token: Option<&str>,
    ) -> Result<Value, TrackerError> {
        let mut req = self
            .client
            .post(ANILIST_GRAPHQL_URL)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&json!({
                "query": query,
                "variables": variables
            }));

        if let Some(tok) = token.filter(|t| !t.trim().is_empty()) {
            req = req.bearer_auth(tok.trim());
        }

        let resp = req
            .send()
            .await
            .map_err(|e| TrackerError::Network(format!("AniList network error: {}", e)))?;
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());
        let text = resp
            .text()
            .await
            .map_err(|e| TrackerError::Network(format!("AniList network error: {}", e)))?;

        classify_graphql_response(status.as_u16(), retry_after, &text)
    }

    /// Resolve the authenticated viewer id (cached per token).
    async fn viewer_id(&self, token: &str) -> Result<i64, TrackerError> {
        if let Ok(guard) = self.viewer_cache.lock() {
            if let Some((cached_tok, id)) = guard.as_ref() {
                if cached_tok == token {
                    return Ok(*id);
                }
            }
        }
        let data = self
            .graphql_request("query { Viewer { id name } }", json!({}), Some(token))
            .await?;
        let id = data
            .get("Viewer")
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_i64())
            .ok_or_else(|| {
                TrackerError::Unauthorized("AniList did not return a Viewer for this token".into())
            })?;
        if let Ok(mut guard) = self.viewer_cache.lock() {
            *guard = Some((token.to_string(), id));
        }
        Ok(id)
    }
}

/// Map an AniList HTTP response (status + raw body) to either the GraphQL `data` object or a typed error.
/// Tolerates non-JSON bodies (HTML error pages from proxies / Cloudflare).
fn classify_graphql_response(
    status: u16,
    retry_after: Option<u64>,
    text: &str,
) -> Result<Value, TrackerError> {
    if status == 429 {
        return Err(TrackerError::RateLimited {
            retry_after_secs: retry_after.unwrap_or(60),
        });
    }

    let body: Option<Value> = serde_json::from_str(text).ok();
    let first_error = body
        .as_ref()
        .and_then(|b| b.get("errors"))
        .and_then(|e| e.as_array())
        .and_then(|a| a.first());
    let gql_message = first_error
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());
    let gql_status = first_error
        .and_then(|e| e.get("status"))
        .and_then(|s| s.as_u64())
        .map(|s| s as u16);

    let is_success = (200..300).contains(&status);
    if is_success && first_error.is_none() {
        let Some(body) = body else {
            return Err(TrackerError::Api(format!(
                "AniList returned a non-JSON response (HTTP {}): {}",
                status,
                snippet(text)
            )));
        };
        return body
            .get("data")
            .filter(|d| !d.is_null())
            .cloned()
            .ok_or_else(|| TrackerError::Api("AniList response missing 'data' field".into()));
    }

    let message = gql_message.unwrap_or_else(|| {
        if text.trim().is_empty() {
            format!("HTTP {}", status)
        } else {
            snippet(text)
        }
    });
    let lower = message.to_ascii_lowercase();
    let effective = gql_status.unwrap_or(status);

    if effective == 429 {
        return Err(TrackerError::RateLimited {
            retry_after_secs: retry_after.unwrap_or(60),
        });
    }
    if status == 401
        || effective == 401
        || lower.contains("invalid token")
        || lower.contains("unauthorized")
    {
        return Err(TrackerError::Unauthorized(format!(
            "AniList rejected the access token: {}",
            message
        )));
    }
    if status == 404 || effective == 404 || lower.contains("not found") {
        return Err(TrackerError::NotFound(format!("AniList: {}", message)));
    }
    if (500..600).contains(&status) {
        return Err(TrackerError::Network(format!(
            "AniList server error (HTTP {}): {}",
            status, message
        )));
    }
    Err(TrackerError::Api(format!(
        "AniList API Error (HTTP {}): {}",
        status, message
    )))
}

fn snippet(text: &str) -> String {
    let t = text.trim();
    let mut out: String = t.chars().take(200).collect();
    if t.chars().count() > 200 {
        out.push_str("...");
    }
    out
}

/// Convert `YYYY-MM-DD` into an AniList `FuzzyDateInput`. `None` / invalid → all-null (clears the date).
fn fuzzy_date_input(date: Option<&str>) -> Value {
    let parsed = date
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    match parsed {
        Some(d) => {
            use chrono::Datelike;
            json!({ "year": d.year(), "month": d.month(), "day": d.day() })
        }
        None => json!({ "year": null, "month": null, "day": null }),
    }
}

const MEDIA_FRAGMENT: &str = r#"
    id
    idMal
    title {
        romaji
        english
        native
    }
    synonyms
    format
    status
    episodes
    duration
    season
    seasonYear
    averageScore
    source
    siteUrl
    coverImage {
        extraLarge
        large
        color
    }
    bannerImage
    description(asHtml: false)
    genres
    studios(isMain: true) {
        nodes {
            name
        }
    }
    nextAiringEpisode {
        episode
        airingAt
    }
    trailer {
        id
        site
    }
    startDate {
        year
        month
        day
    }
    endDate {
        year
        month
        day
    }
"#;

/// Per-season page size (AniList `Page.perPage` maximum).
const SEASON_PAGE_SIZE: usize = 50;

/// Extra fields of a season item (Seasons sorting + Now Playing metadata), appended to `MEDIA_FRAGMENT`.
/// `studioEdges` aliases a second `studios` selection (all studios and producers, with ids).
const SEASON_EXTRA_FIELDS: &str = r#"
    popularity
    meanScore
    favourites
    rankings {
        rank
        type
        allTime
        season
        year
        context
    }
    tags {
        name
        rank
        isMediaSpoiler
        isGeneralSpoiler
    }
    studioEdges: studios {
        edges {
            isMain
            node {
                id
                name
                isAnimationStudio
            }
        }
    }
"#;

fn opt_u32(v: Option<&Value>) -> Option<u32> {
    v.and_then(|v| v.as_u64()).map(|n| n as u32)
}

/// `MEDIA_FRAGMENT + SEASON_EXTRA_FIELDS` media node → season item.
fn parse_seasonal_media(m: &Value) -> Option<SeasonalAnime> {
    let entry = AniListPlugin::parse_media_node(m, None)?;
    let tags = m
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(MediaTag {
                        name: t.get("name")?.as_str()?.to_string(),
                        rank: opt_u32(t.get("rank")),
                        is_spoiler: t.get("isMediaSpoiler").and_then(|v| v.as_bool()).unwrap_or(false)
                            || t.get("isGeneralSpoiler").and_then(|v| v.as_bool()).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let studios = m
        .get("studioEdges")
        .and_then(|s| s.get("edges"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let node = e.get("node")?;
                    Some(StudioRef {
                        id: node.get("id")?.as_i64()?,
                        name: node.get("name")?.as_str()?.to_string(),
                        is_main: e.get("isMain").and_then(|v| v.as_bool()).unwrap_or(false),
                        is_animation_studio: node
                            .get("isAnimationStudio")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let rankings = m
        .get("rankings")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    Some(MediaRanking {
                        rank: opt_u32(r.get("rank"))?,
                        kind: r.get("type")?.as_str()?.to_string(),
                        all_time: r.get("allTime").and_then(|v| v.as_bool()).unwrap_or(false),
                        season: r.get("season").and_then(|v| v.as_str()).map(|s| s.to_string()),
                        year: opt_u32(r.get("year")),
                        context: r
                            .get("context")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(SeasonalAnime {
        entry,
        popularity: opt_u32(m.get("popularity")),
        metadata: MediaMetadata {
            mean_score: opt_u32(m.get("meanScore")),
            favourites: opt_u32(m.get("favourites")),
            tags,
            studios,
            rankings,
        },
    })
}

/// AniList fuzzy date → `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (only the known parts). Used for airing dates.
fn parse_partial_date(obj: Option<&Value>) -> Option<String> {
    let d = obj?;
    let y = d.get("year").and_then(|v| v.as_i64()).filter(|&y| y > 0)?;
    let Some(m) = d.get("month").and_then(|v| v.as_i64()).filter(|m| (1..=12).contains(m)) else {
        return Some(format!("{:04}", y));
    };
    match d.get("day").and_then(|v| v.as_i64()).filter(|d| (1..=31).contains(d)) {
        Some(day) => Some(format!("{:04}-{:02}-{:02}", y, m, day)),
        None => Some(format!("{:04}-{:02}", y, m)),
    }
}

/// Light media fields for the list fetch: only what a sync compares / what can change between syncs.
/// Heavy metadata (`MEDIA_FRAGMENT`) is fetched separately for newly added entries only.
const MEDIA_LIST_FRAGMENT: &str = r#"
    id
    title {
        romaji
        english
        native
    }
    synonyms
    format
    status
    episodes
    season
    seasonYear
    averageScore
    coverImage {
        large
        color
    }
    nextAiringEpisode {
        episode
        airingAt
    }
    startDate {
        year
        month
        day
    }
    endDate {
        year
        month
        day
    }
"#;

/// `Page.airingSchedules` node (`episode`, `airingAt`, `media { MEDIA_LIST_FRAGMENT isAdult }`) → item.
/// Adult media and nodes missing a field are skipped.
fn parse_airing_schedule_node(node: &Value) -> Option<AiringScheduleItem> {
    let media = node.get("media")?;
    if media.get("isAdult").and_then(|v| v.as_bool()).unwrap_or(false) {
        return None;
    }
    Some(AiringScheduleItem {
        episode: opt_u32(node.get("episode"))?,
        airing_at: node.get("airingAt")?.as_i64()?,
        media: AniListPlugin::parse_media_node(media, None)?,
        country: media
            .get("countryOfOrigin")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

impl TrackerPlugin for AniListPlugin {
    fn descriptor(&self) -> TrackerPluginDescriptor {
        TrackerPluginDescriptor {
            id: "anilist".into(),
            name: "AniList".into(),
            description: "Official AniList GraphQL v2 tracker plugin. Supports public username list import, OAuth token 2-way sync, seasonal browser, and airing schedules.".into(),
            website_url: "https://anilist.co".into(),
            oauth_authorize_url: "https://anilist.co/api/v2/oauth/authorize?client_id=14954&response_type=token".into(),
            supports_public_username_sync: true,
            supports_oauth_token: true,
            supports_seasonal_browse: true,
            status: "active".into(),
        }
    }

    fn verify_account<'a>(
        &'a self,
        username: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<TrackerUserProfile, String>> {
        Box::pin(async move {
            if let Some(tok) = token.filter(|t| !t.trim().is_empty()) {
                let query = r#"
                    query {
                        Viewer {
                            id
                            name
                            avatar {
                                large
                            }
                            statistics {
                                anime {
                                    count
                                    episodesWatched
                                    minutesWatched
                                }
                            }
                        }
                    }
                "#;
                let data = self
                    .graphql_request(query, json!({}), Some(tok))
                    .await
                    .map_err(|e| e.to_string())?;
                let viewer = data
                    .get("Viewer")
                    .ok_or_else(|| "Invalid Viewer response".to_string())?;
                return Ok(TrackerUserProfile {
                    user_id: viewer.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                    username: viewer
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(username)
                        .to_string(),
                    avatar_url: viewer
                        .get("avatar")
                        .and_then(|a| a.get("large"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    anime_count: viewer
                        .get("statistics")
                        .and_then(|s| s.get("anime"))
                        .and_then(|a| a.get("count"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32,
                    episodes_watched: viewer
                        .get("statistics")
                        .and_then(|s| s.get("anime"))
                        .and_then(|a| a.get("episodesWatched"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32,
                    authenticated: true,
                });
            }

            if username.trim().is_empty() {
                return Err("Please provide an AniList username or OAuth access token.".into());
            }

            let query = r#"
                query ($name: String) {
                    User(name: $name) {
                        id
                        name
                        avatar {
                            large
                        }
                        statistics {
                            anime {
                                count
                                episodesWatched
                            }
                        }
                    }
                }
            "#;
            let data = self
                .graphql_request(query, json!({ "name": username.trim() }), None)
                .await
                .map_err(|e| e.to_string())?;
            let user = data
                .get("User")
                .ok_or_else(|| "AniList user not found".to_string())?;
            Ok(TrackerUserProfile {
                user_id: user.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                username: user
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(username)
                    .to_string(),
                avatar_url: user
                    .get("avatar")
                    .and_then(|a| a.get("large"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                anime_count: user
                    .get("statistics")
                    .and_then(|s| s.get("anime"))
                    .and_then(|a| a.get("count"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                episodes_watched: user
                    .get("statistics")
                    .and_then(|s| s.get("anime"))
                    .and_then(|a| a.get("episodesWatched"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                authenticated: false,
            })
        })
    }

    fn fetch_user_list<'a>(
        &'a self,
        token: &'a str,
    ) -> BoxFuture<'a, Result<RemoteListSnapshot, TrackerError>> {
        Box::pin(async move {
            let token = token.trim();
            if token.is_empty() {
                return Err(TrackerError::Unauthorized(
                    "AniList OAuth token is required to sync the list.".into(),
                ));
            }
            let viewer_id = self.viewer_id(token).await?;

            let query = format!(
                r#"
                query ($userId: Int) {{
                    MediaListCollection(userId: $userId, type: ANIME) {{
                        lists {{
                            name
                            isCustomList
                            entries {{
                                id
                                status
                                score(format: POINT_100)
                                progress
                                repeat
                                notes
                                startedAt {{
                                    year
                                    month
                                    day
                                }}
                                completedAt {{
                                    year
                                    month
                                    day
                                }}
                                updatedAt
                                media {{
                                    {MEDIA_LIST_FRAGMENT}
                                }}
                            }}
                        }}
                    }}
                }}
                "#
            );

            let data = self
                .graphql_request(&query, json!({ "userId": viewer_id }), Some(token))
                .await?;

            let collection = data
                .get("MediaListCollection")
                .filter(|c| !c.is_null())
                .ok_or_else(|| TrackerError::Api("AniList returned no MediaListCollection".into()))?;

            let mut seen: HashSet<i64> = HashSet::new();
            let mut entries = Vec::new();
            if let Some(lists) = collection.get("lists").and_then(|l| l.as_array()) {
                // Standard status lists first so the canonical entry wins over custom-list duplicates.
                let mut ordered: Vec<&Value> = lists.iter().collect();
                ordered.sort_by_key(|l| {
                    l.get("isCustomList")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                });
                for list_group in ordered {
                    let Some(list_entries) = list_group.get("entries").and_then(|e| e.as_array())
                    else {
                        continue;
                    };
                    for entry_node in list_entries {
                        let Some(media) = entry_node.get("media") else {
                            continue;
                        };
                        if let Some(parsed) = Self::parse_media_node(media, Some(entry_node)) {
                            if seen.insert(parsed.id) {
                                entries.push(parsed);
                            }
                        }
                    }
                }
            }
            Ok(RemoteListSnapshot { viewer_id, entries })
        })
    }

    fn fetch_media_details<'a>(
        &'a self,
        ids: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, TrackerError>> {
        Box::pin(async move {
            let query = format!(
                r#"
                query ($ids: [Int]) {{
                    Page(perPage: {MEDIA_DETAILS_CHUNK}) {{
                        media(id_in: $ids, type: ANIME) {{
                            {MEDIA_FRAGMENT}
                        }}
                    }}
                }}
                "#
            );
            let mut out = Vec::with_capacity(ids.len());
            for chunk in ids.chunks(MEDIA_DETAILS_CHUNK) {
                let data = self
                    .graphql_request(&query, json!({ "ids": chunk }), None)
                    .await?;
                if let Some(media_arr) = data
                    .get("Page")
                    .and_then(|p| p.get("media"))
                    .and_then(|m| m.as_array())
                {
                    out.extend(
                        media_arr
                            .iter()
                            .filter_map(|m| Self::parse_media_node(m, None)),
                    );
                }
            }
            Ok(out)
        })
    }

    fn search_anime<'a>(
        &'a self,
        query_str: &'a str,
        season: Option<&'a str>,
        year: Option<u32>,
    ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, String>> {
        Box::pin(async move {
            let gql = format!(
                r#"
                query ($search: String, $season: MediaSeason, $seasonYear: Int) {{
                    Page(page: 1, perPage: 28) {{
                        media(
                            type: ANIME,
                            search: $search,
                            season: $season,
                            seasonYear: $seasonYear,
                            sort: [POPULARITY_DESC, SCORE_DESC],
                            isAdult: false
                        ) {{
                            {MEDIA_FRAGMENT}
                        }}
                    }}
                }}
                "#
            );

            let mut vars = serde_json::Map::new();
            if !query_str.trim().is_empty() {
                vars.insert("search".into(), json!(query_str.trim()));
            }
            if let Some(s) = season.filter(|s| !s.trim().is_empty()) {
                vars.insert("season".into(), json!(s.to_uppercase()));
            }
            if let Some(y) = year {
                vars.insert("seasonYear".into(), json!(y));
            }

            let data = self
                .graphql_request(&gql, Value::Object(vars), None)
                .await
                .map_err(|e| e.to_string())?;
            let mut list = Vec::new();
            if let Some(media_arr) = data
                .get("Page")
                .and_then(|p| p.get("media"))
                .and_then(|m| m.as_array())
            {
                for m in media_arr {
                    if let Some(entry) = Self::parse_media_node(m, None) {
                        list.push(entry);
                    }
                }
            }
            Ok(list)
        })
    }

    fn fetch_season_page<'a>(
        &'a self,
        season: &'a str,
        year: u32,
        page: u32,
    ) -> BoxFuture<'a, Result<SeasonPage, TrackerError>> {
        Box::pin(async move {
            let gql = format!(
                r#"
                query ($season: MediaSeason, $seasonYear: Int, $page: Int) {{
                    Page(page: $page, perPage: {SEASON_PAGE_SIZE}) {{
                        pageInfo {{
                            hasNextPage
                        }}
                        media(
                            type: ANIME,
                            season: $season,
                            seasonYear: $seasonYear,
                            sort: [POPULARITY_DESC],
                            isAdult: false
                        ) {{
                            {MEDIA_FRAGMENT}
                            {SEASON_EXTRA_FIELDS}
                        }}
                    }}
                }}
                "#
            );
            let vars = json!({
                "season": season.to_uppercase(),
                "seasonYear": year,
                "page": page.max(1),
            });
            let data = self.graphql_request(&gql, vars, None).await?;
            let page_obj = data.get("Page");
            let has_next_page = page_obj
                .and_then(|p| p.get("pageInfo"))
                .and_then(|p| p.get("hasNextPage"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let items = page_obj
                .and_then(|p| p.get("media"))
                .and_then(|m| m.as_array())
                .map(|arr| arr.iter().filter_map(parse_seasonal_media).collect())
                .unwrap_or_default();
            Ok(SeasonPage {
                items,
                has_next_page,
            })
        })
    }

    fn fetch_airing_schedule_page<'a>(
        &'a self,
        from: i64,
        to: i64,
        page: u32,
    ) -> BoxFuture<'a, Result<AiringSchedulePage, TrackerError>> {
        Box::pin(async move {
            let gql = format!(
                r#"
                query ($from: Int, $to: Int, $page: Int) {{
                    Page(page: $page, perPage: {SEASON_PAGE_SIZE}) {{
                        pageInfo {{
                            hasNextPage
                        }}
                        airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: [TIME]) {{
                            episode
                            airingAt
                            media {{
                                {MEDIA_LIST_FRAGMENT}
                                isAdult
                                countryOfOrigin
                            }}
                        }}
                    }}
                }}
                "#
            );
            // airingAt_greater is exclusive, so start one second early to include `from` itself
            let vars = json!({
                "from": from - 1,
                "to": to,
                "page": page.max(1),
            });
            let data = self.graphql_request(&gql, vars, None).await?;
            let page_obj = data.get("Page");
            let has_next_page = page_obj
                .and_then(|p| p.get("pageInfo"))
                .and_then(|p| p.get("hasNextPage"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let items = page_obj
                .and_then(|p| p.get("airingSchedules"))
                .and_then(|m| m.as_array())
                .map(|arr| arr.iter().filter_map(parse_airing_schedule_node).collect())
                .unwrap_or_default();
            Ok(AiringSchedulePage {
                items,
                has_next_page,
            })
        })
    }

    fn fetch_media_metadata<'a>(
        &'a self,
        id: i64,
    ) -> BoxFuture<'a, Result<Option<SeasonalAnime>, TrackerError>> {
        Box::pin(async move {
            let gql = format!(
                r#"
                query ($id: Int) {{
                    Media(id: $id, type: ANIME) {{
                        {MEDIA_FRAGMENT}
                        {SEASON_EXTRA_FIELDS}
                    }}
                }}
                "#
            );
            match self.graphql_request(&gql, json!({ "id": id }), None).await {
                Ok(data) => Ok(data.get("Media").and_then(parse_seasonal_media)),
                Err(TrackerError::NotFound(_)) => Ok(None),
                Err(e) => Err(e),
            }
        })
    }

    fn save_list_entry<'a>(
        &'a self,
        token: &'a str,
        update: &'a TrackerEntryUpdate,
    ) -> BoxFuture<'a, Result<RemoteEntryState, TrackerError>> {
        Box::pin(async move {
            let token = token.trim();
            if token.is_empty() {
                return Err(TrackerError::Unauthorized(
                    "AniList OAuth token is required to push updates to AniList.".into(),
                ));
            }
            let mutation = r#"
                mutation (
                    $mediaId: Int,
                    $status: MediaListStatus,
                    $progress: Int,
                    $scoreRaw: Int,
                    $repeat: Int,
                    $notes: String,
                    $startedAt: FuzzyDateInput,
                    $completedAt: FuzzyDateInput
                ) {
                    SaveMediaListEntry(
                        mediaId: $mediaId,
                        status: $status,
                        progress: $progress,
                        scoreRaw: $scoreRaw,
                        repeat: $repeat,
                        notes: $notes,
                        startedAt: $startedAt,
                        completedAt: $completedAt
                    ) {
                        id
                        status
                        progress
                        updatedAt
                    }
                }
            "#;

            let vars = json!({
                "mediaId": update.media_id,
                "status": update.status,
                "progress": update.progress,
                "scoreRaw": update.score.clamp(0.0, 100.0).round() as i32,
                "repeat": update.repeat,
                "notes": update.notes,
                "startedAt": fuzzy_date_input(update.started_at.as_deref()),
                "completedAt": fuzzy_date_input(update.completed_at.as_deref()),
            });

            let data = self.graphql_request(mutation, vars, Some(token)).await?;
            let saved = data
                .get("SaveMediaListEntry")
                .filter(|v| !v.is_null())
                .ok_or_else(|| {
                    TrackerError::Api("AniList did not return the saved list entry".into())
                })?;
            Ok(RemoteEntryState {
                list_entry_id: saved
                    .get("id")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| TrackerError::Api("AniList saved entry has no id".into()))?,
                status: saved
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&update.status)
                    .to_string(),
                progress: saved
                    .get("progress")
                    .and_then(|v| v.as_u64())
                    .map(|p| p as u32)
                    .unwrap_or(update.progress),
                updated_at: saved
                    .get("updatedAt")
                    .and_then(|v| v.as_i64())
                    .filter(|&t| t > 0)
                    .unwrap_or_else(|| chrono::Utc::now().timestamp()),
            })
        })
    }

    fn delete_list_entry<'a>(
        &'a self,
        token: &'a str,
        media_id: i64,
        list_entry_id: Option<i64>,
    ) -> BoxFuture<'a, Result<(), TrackerError>> {
        Box::pin(async move {
            let token = token.trim();
            if token.is_empty() {
                return Err(TrackerError::Unauthorized(
                    "AniList OAuth token is required to delete AniList entries.".into(),
                ));
            }

            let entry_id = match list_entry_id {
                Some(id) => id,
                None => {
                    let viewer_id = self.viewer_id(token).await?;
                    let lookup = self
                        .graphql_request(
                            "query ($userId: Int, $mediaId: Int) { MediaList(userId: $userId, mediaId: $mediaId) { id } }",
                            json!({ "userId": viewer_id, "mediaId": media_id }),
                            Some(token),
                        )
                        .await;
                    match lookup {
                        Ok(data) => match data
                            .get("MediaList")
                            .and_then(|m| m.get("id"))
                            .and_then(|v| v.as_i64())
                        {
                            Some(id) => id,
                            // Nothing on the list for this media: already deleted.
                            None => return Ok(()),
                        },
                        Err(TrackerError::NotFound(_)) => return Ok(()),
                        Err(e) => return Err(e),
                    }
                }
            };

            let result = self
                .graphql_request(
                    "mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }",
                    json!({ "id": entry_id }),
                    Some(token),
                )
                .await;
            match result {
                Ok(_) | Err(TrackerError::NotFound(_)) => Ok(()),
                Err(e) => Err(e),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_http_and_graphql_errors() {
        assert_eq!(
            classify_graphql_response(429, Some(12), "<html>Too Many</html>"),
            Err(TrackerError::RateLimited { retry_after_secs: 12 })
        );
        assert_eq!(
            classify_graphql_response(429, None, ""),
            Err(TrackerError::RateLimited { retry_after_secs: 60 })
        );
        let unauthorized = classify_graphql_response(
            400,
            None,
            r#"{"errors":[{"message":"Invalid token","status":400}],"data":null}"#,
        );
        assert!(matches!(unauthorized, Err(TrackerError::Unauthorized(_))));
        assert!(matches!(
            classify_graphql_response(401, None, "nope"),
            Err(TrackerError::Unauthorized(_))
        ));
        let not_found = classify_graphql_response(
            404,
            None,
            r#"{"errors":[{"message":"Not Found.","status":404}],"data":{"MediaList":null}}"#,
        );
        assert!(matches!(not_found, Err(TrackerError::NotFound(_))));
        assert!(matches!(
            classify_graphql_response(502, None, "<html>Bad gateway</html>"),
            Err(TrackerError::Network(_))
        ));
        assert!(matches!(
            classify_graphql_response(200, None, "<html>not json</html>"),
            Err(TrackerError::Api(_))
        ));
        assert_eq!(
            classify_graphql_response(200, None, r#"{"data":{"Viewer":{"id":5}}}"#),
            Ok(json!({"Viewer":{"id":5}}))
        );
    }

    #[test]
    fn light_list_media_parses_with_heavy_fields_defaulted() {
        let media = json!({
            "id": 21, "title": { "romaji": "One Piece", "english": null, "native": "ONE PIECE" },
            "synonyms": ["OP"], "format": "TV", "status": "RELEASING", "episodes": null,
            "season": "FALL", "seasonYear": 1999, "averageScore": 88,
            "coverImage": { "large": "https://img/op.jpg", "color": "#e4a15d" },
            "nextAiringEpisode": { "episode": 1100, "airingAt": 1900000000 }
        });
        let entry_node = json!({
            "id": 900, "status": "CURRENT", "score": 90, "progress": 1099, "repeat": 0, "notes": null,
            "startedAt": { "year": 2020, "month": 1, "day": 2 }, "completedAt": { "year": null },
            "updatedAt": 1800000000, "media": media
        });
        let e = AniListPlugin::parse_media_node(&entry_node["media"], Some(&entry_node)).unwrap();
        assert_eq!(e.id, 21);
        assert_eq!(e.synonyms, vec!["OP".to_string()]);
        assert_eq!(e.cover_image, "https://img/op.jpg");
        assert_eq!(e.next_airing_episode, Some(1100));
        assert_eq!(e.user_progress, 1099);
        assert_eq!(e.user_started_at.as_deref(), Some("2020-01-02"));
        assert_eq!(e.user_completed_at, None);
        assert_eq!(e.anilist_list_entry_id, Some(900));
        assert_eq!(e.updated_at, 1_800_000_000);
        // Heavy metadata is absent in the light fetch (the merge never writes these for existing rows)
        assert!(e.synopsis.is_empty() && e.genres.is_empty() && e.studios.is_empty());
        assert_eq!((e.mal_id, e.banner_image, e.trailer_url), (None, None, None));
    }

    #[test]
    fn airing_schedule_nodes_parse_and_skip_adult_media() {
        let nodes = json!([
            { "episode": 5, "airingAt": 1900000000, "media": {
                "id": 7, "title": { "romaji": "Show" }, "format": "TV", "status": "RELEASING",
                "coverImage": { "large": "https://img/7.jpg" }, "isAdult": false, "countryOfOrigin": "CN" } },
            { "episode": 2, "airingAt": 1900003600, "media": {
                "id": 8, "title": { "romaji": "Adult" }, "isAdult": true } },
            { "episode": null, "airingAt": 1900007200, "media": { "id": 9, "title": { "romaji": "No ep" } } }
        ]);
        let items: Vec<_> = nodes.as_array().unwrap().iter().filter_map(parse_airing_schedule_node).collect();
        assert_eq!(items.len(), 1);
        assert_eq!((items[0].episode, items[0].airing_at), (5, 1_900_000_000));
        assert_eq!(items[0].media.id, 7);
        assert_eq!(items[0].media.cover_image, "https://img/7.jpg");
        assert_eq!(items[0].country.as_deref(), Some("CN"));
    }

    #[test]
    fn seasonal_media_parses_dates_and_metadata() {
        let media = json!({
            "id": 5, "title": { "romaji": "Show" }, "format": "TV", "status": "FINISHED",
            "startDate": { "year": 2026, "month": 7, "day": 4 }, "endDate": { "year": 2026, "month": 9, "day": null },
            "popularity": 1234, "meanScore": 81, "favourites": 56,
            "rankings": [
                { "rank": 3, "type": "RATED", "allTime": false, "season": "SUMMER", "year": 2026, "context": "highest rated" },
                { "rank": null, "type": "POPULAR" }
            ],
            "tags": [
                { "name": "Isekai", "rank": 90, "isMediaSpoiler": false, "isGeneralSpoiler": false },
                { "name": "Twist", "rank": 60, "isMediaSpoiler": true, "isGeneralSpoiler": false }
            ],
            "studios": { "nodes": [{ "name": "Studio A" }] },
            "studioEdges": { "edges": [
                { "isMain": true, "node": { "id": 11, "name": "Studio A", "isAnimationStudio": true } },
                { "isMain": false, "node": { "id": 12, "name": "Producer B", "isAnimationStudio": false } }
            ] }
        });
        let item = parse_seasonal_media(&media).unwrap();
        assert_eq!(item.entry.start_date.as_deref(), Some("2026-07-04"));
        assert_eq!(item.entry.end_date.as_deref(), Some("2026-09"));
        assert_eq!(item.entry.studios, vec!["Studio A".to_string()]);
        assert_eq!(item.popularity, Some(1234));
        let m = &item.metadata;
        assert_eq!((m.mean_score, m.favourites), (Some(81), Some(56)));
        assert_eq!(m.rankings.len(), 1);
        assert_eq!(m.rankings[0].season.as_deref(), Some("SUMMER"));
        assert_eq!(m.tags.iter().map(|t| t.is_spoiler).collect::<Vec<_>>(), vec![false, true]);
        assert_eq!(m.studios[1], StudioRef { id: 12, name: "Producer B".into(), is_main: false, is_animation_studio: false });
    }

    #[test]
    fn start_dates_keep_only_known_parts() {
        let full = json!({ "year": 2026, "month": 10, "day": 3 });
        let month = json!({ "year": 2026, "month": 10, "day": null });
        let year = json!({ "year": 2027, "month": null, "day": null });
        let none = json!({ "year": null, "month": null, "day": null });
        assert_eq!(parse_partial_date(Some(&full)).as_deref(), Some("2026-10-03"));
        assert_eq!(parse_partial_date(Some(&month)).as_deref(), Some("2026-10"));
        assert_eq!(parse_partial_date(Some(&year)).as_deref(), Some("2027"));
        assert_eq!(parse_partial_date(Some(&none)), None);
        assert_eq!(parse_partial_date(None), None);
    }

    #[test]
    fn fuzzy_dates_serialize_or_clear() {
        assert_eq!(
            fuzzy_date_input(Some("2026-10-27")),
            json!({"year":2026,"month":10,"day":27})
        );
        assert_eq!(
            fuzzy_date_input(None),
            json!({"year":null,"month":null,"day":null})
        );
        assert_eq!(
            fuzzy_date_input(Some("")),
            json!({"year":null,"month":null,"day":null})
        );
    }
}
