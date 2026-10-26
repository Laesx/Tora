use crate::db::AnimeEntry;
use crate::plugins::{TrackerPlugin, TrackerPluginDescriptor, TrackerUserProfile};
use reqwest::Client;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;

const ANILIST_GRAPHQL_URL: &str = "https://graphql.anilist.co";

pub struct AniListPlugin {
    client: Client,
}

impl AniListPlugin {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("Tora/0.1.0 (Anime Library Manager)")
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Self { client }
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
        let (user_status, user_progress, user_score, user_repeats, user_notes, updated_at) =
            if let Some(en) = entry_node {
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
                    en.get("updatedAt")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(now),
                )
            } else {
                ("PLANNING".to_string(), 0, 0.0, 0, String::new(), now)
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
            user_status,
            user_progress,
            user_score,
            user_repeats,
            user_notes,
            custom_folder: None,
            updated_at,
            local_episode_count: 0,
            available_episodes: vec![],
        })
    }

    async fn graphql_request(
        &self,
        query: &str,
        variables: Value,
        token: Option<&str>,
    ) -> Result<Value, String> {
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
            .map_err(|e| format!("AniList network error: {}", e))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse AniList JSON response: {}", e))?;

        if !status.is_success() || body.get("errors").is_some() {
            let err_msg = body
                .get("errors")
                .and_then(|e| e.as_array())
                .and_then(|a| a.first())
                .and_then(|first| first.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown AniList GraphQL error");
            return Err(format!("AniList API Error ({}): {}", status, err_msg));
        }

        body.get("data")
            .cloned()
            .ok_or_else(|| "AniList response missing 'data' field".into())
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
"#;

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
    ) -> Pin<Box<dyn Future<Output = Result<TrackerUserProfile, String>> + Send + 'a>> {
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
                let data = self.graphql_request(query, json!({}), Some(tok)).await?;
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
                .await?;
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
        username: &'a str,
        token: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AnimeEntry>, String>> + Send + 'a>> {
        Box::pin(async move {
            let resolved_username = if !username.trim().is_empty() {
                username.trim().to_string()
            } else if let Some(tok) = token.filter(|t| !t.trim().is_empty()) {
                let profile = self.verify_account("", Some(tok)).await?;
                profile.username
            } else {
                return Err("Provide an AniList username or OAuth token to sync.".into());
            };

            let query = format!(
                r#"
                query ($userName: String) {{
                    MediaListCollection(userName: $userName, type: ANIME) {{
                        lists {{
                            name
                            entries {{
                                id
                                status
                                score(format: POINT_100)
                                progress
                                repeat
                                notes
                                updatedAt
                                media {{
                                    {MEDIA_FRAGMENT}
                                }}
                            }}
                        }}
                    }}
                }}
                "#
            );

            let data = self
                .graphql_request(&query, json!({ "userName": resolved_username }), token)
                .await?;

            let mut results = Vec::new();
            if let Some(lists) = data
                .get("MediaListCollection")
                .and_then(|c| c.get("lists"))
                .and_then(|l| l.as_array())
            {
                for list_group in lists {
                    if let Some(entries) = list_group.get("entries").and_then(|e| e.as_array()) {
                        for entry_node in entries {
                            if let Some(media) = entry_node.get("media") {
                                if let Some(parsed) = Self::parse_media_node(media, Some(entry_node))
                                {
                                    results.push(parsed);
                                }
                            }
                        }
                    }
                }
            }
            Ok(results)
        })
    }

    fn search_anime<'a>(
        &'a self,
        query_str: &'a str,
        season: Option<&'a str>,
        year: Option<u32>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<AnimeEntry>, String>> + Send + 'a>> {
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

            let data = self.graphql_request(&gql, Value::Object(vars), None).await?;
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

    fn update_list_entry<'a>(
        &'a self,
        token: &'a str,
        media_id: i64,
        status: &'a str,
        progress: u32,
        score: f64,
        repeat: u32,
        notes: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            if token.trim().is_empty() {
                return Err("AniList OAuth token is required to push updates to AniList.".into());
            }
            let mutation = r#"
                mutation (
                    $mediaId: Int,
                    $status: MediaListStatus,
                    $progress: Int,
                    $scoreRaw: Int,
                    $repeat: Int,
                    $notes: String
                ) {
                    SaveMediaListEntry(
                        mediaId: $mediaId,
                        status: $status,
                        progress: $progress,
                        scoreRaw: $scoreRaw,
                        repeat: $repeat,
                        notes: $notes
                    ) {
                        id
                        status
                        progress
                    }
                }
            "#;

            let vars = json!({
                "mediaId": media_id,
                "status": status,
                "progress": progress,
                "scoreRaw": score.round() as i32,
                "repeat": repeat,
                "notes": notes,
            });

            self.graphql_request(mutation, vars, Some(token)).await?;
            Ok(())
        })
    }
}
