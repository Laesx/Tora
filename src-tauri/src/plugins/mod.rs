pub mod anilist;

use crate::db::AnimeEntry;
use crate::plugins::anilist::AniListPlugin;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerPluginDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub website_url: String,
    pub oauth_authorize_url: String,
    pub supports_public_username_sync: bool,
    pub supports_oauth_token: bool,
    pub supports_seasonal_browse: bool,
    pub status: String, // "active" | "planned"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerUserProfile {
    pub user_id: i64,
    pub username: String,
    pub avatar_url: Option<String>,
    pub anime_count: u32,
    pub episodes_watched: u32,
    pub authenticated: bool,
}

/// Max media ids per [`TrackerPlugin::fetch_media_details`] request (AniList `Page.perPage` limit).
pub const MEDIA_DETAILS_CHUNK: usize = 50;

/// Boxed, `Send` future used by the object-safe [`TrackerPlugin`] trait.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Typed tracker failure so the sync service can decide between retrying, re-authenticating
/// or surfacing an error to the user.
#[derive(Debug, Clone, PartialEq)]
pub enum TrackerError {
    /// Transport failure, timeout or a 5xx from the tracker. Transient.
    Network(String),
    /// HTTP 429. The caller should wait `retry_after_secs` before retrying.
    RateLimited { retry_after_secs: u64 },
    /// Missing, expired or revoked OAuth token.
    Unauthorized(String),
    /// The requested media / list entry does not exist.
    NotFound(String),
    /// Any other tracker-side or protocol error.
    Api(String),
}

impl TrackerError {
    /// Stable machine-readable kind sent to the frontend in `tracker-sync-error` events.
    pub fn kind(&self) -> &'static str {
        match self {
            TrackerError::Network(_) => "network",
            TrackerError::RateLimited { .. } => "rate_limited",
            TrackerError::Unauthorized(_) => "unauthorized",
            TrackerError::NotFound(_) => "not_found",
            TrackerError::Api(_) => "api",
        }
    }
}

impl fmt::Display for TrackerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TrackerError::Network(m) => write!(f, "{}", m),
            TrackerError::RateLimited { retry_after_secs } => write!(
                f,
                "Tracker rate limit reached, retry after {} seconds",
                retry_after_secs
            ),
            TrackerError::Unauthorized(m) => write!(f, "{}", m),
            TrackerError::NotFound(m) => write!(f, "{}", m),
            TrackerError::Api(m) => write!(f, "{}", m),
        }
    }
}

impl std::error::Error for TrackerError {}

impl From<TrackerError> for String {
    fn from(e: TrackerError) -> Self {
        e.to_string()
    }
}

/// Full user-state payload pushed to a tracker for one media entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackerEntryUpdate {
    pub media_id: i64,
    pub status: String,
    pub progress: u32,
    /// 0..=100 (`POINT_100` / `scoreRaw` on AniList).
    pub score: f64,
    pub repeat: u32,
    pub notes: String,
    /// `YYYY-MM-DD`; `None` clears the date on the tracker.
    pub started_at: Option<String>,
    /// `YYYY-MM-DD`; `None` clears the date on the tracker.
    pub completed_at: Option<String>,
}

/// State the tracker reports back after a successful save.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemoteEntryState {
    pub list_entry_id: i64,
    pub status: String,
    pub progress: u32,
    /// Unix seconds.
    pub updated_at: i64,
}

/// The authenticated viewer's complete anime list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteListSnapshot {
    pub viewer_id: i64,
    /// Deduplicated by media id. Each entry carries `anilist_list_entry_id` and the remote `updated_at`.
    pub entries: Vec<AnimeEntry>,
}

/// One media tag (AniList `MediaTag`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaTag {
    pub name: String,
    /// Relevance 0–100.
    pub rank: Option<u32>,
    /// Media or general spoiler.
    pub is_spoiler: bool,
}

/// A studio or producer credited on a media (AniList `StudioEdge`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StudioRef {
    pub id: i64,
    pub name: String,
    pub is_main: bool,
    pub is_animation_studio: bool,
}

/// One AniList ranking (e.g. "#3 Highest rated Fall 2026").
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaRanking {
    pub rank: u32,
    /// `RATED` | `POPULAR`
    pub kind: String,
    pub all_time: bool,
    pub season: Option<String>,
    pub year: Option<u32>,
    pub context: String,
}

/// Non-essential metadata shown by the Now Playing hero. Written only by season fetches (or one
/// fetch for media that have none yet); never refreshed by playback.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub mean_score: Option<u32>,
    pub favourites: Option<u32>,
    pub tags: Vec<MediaTag>,
    pub studios: Vec<StudioRef>,
    pub rankings: Vec<MediaRanking>,
}

/// One media of a seasonal listing (or of `media_metadata`): full metadata plus the fields only the
/// Seasons view and Now Playing hero use. A response / cache type only — never written to `anime_entries`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeasonalAnime {
    #[serde(flatten)]
    pub entry: AnimeEntry,
    pub popularity: Option<u32>,
    #[serde(default)]
    pub metadata: MediaMetadata,
}

/// One page of [`TrackerPlugin::fetch_season_page`].
#[derive(Debug, Clone)]
pub struct SeasonPage {
    pub items: Vec<SeasonalAnime>,
    pub has_next_page: bool,
}

/// One episode airing (AniList `AiringSchedule`). `media` carries only the light list fields; a
/// response / cache type only — never written to `anime_entries` or `media_metadata`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiringScheduleItem {
    pub episode: u32,
    /// Unix seconds.
    pub airing_at: i64,
    pub media: AnimeEntry,
    /// ISO 3166-1 alpha-2 country of origin (`JP`, `CN`, `KR`, …).
    #[serde(default)]
    pub country: Option<String>,
}

/// One page of [`TrackerPlugin::fetch_airing_schedule_page`].
#[derive(Debug, Clone)]
pub struct AiringSchedulePage {
    pub items: Vec<AiringScheduleItem>,
    pub has_next_page: bool,
}

/// Core internal trait for all anime tracker plugins (AniList, MyAnimeList, Kitsu, Shikimori, etc.)
pub trait TrackerPlugin: Send + Sync {
    fn descriptor(&self) -> TrackerPluginDescriptor;

    fn verify_account<'a>(
        &'a self,
        username: &'a str,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<TrackerUserProfile, String>>;

    /// Fetch the authenticated viewer's full anime list. Media carry only the "light" fields
    /// (titles, synonyms, format, status, episodes, season, score, cover, next airing); heavy metadata
    /// (synopsis, genres, studios, banner, trailer, source, duration, site url, MAL id) is left at its
    /// defaults and must be fetched with [`fetch_media_details`](Self::fetch_media_details).
    fn fetch_user_list<'a>(
        &'a self,
        token: &'a str,
    ) -> BoxFuture<'a, Result<RemoteListSnapshot, TrackerError>>;

    /// User id of the account `token` belongs to (implementations cache it per token).
    fn viewer_id<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<i64, TrackerError>>;

    /// Fetch full media metadata for `ids` (no user-list fields). Callers should pass at most
    /// [`MEDIA_DETAILS_CHUNK`] ids per call (one request each); larger inputs are split into
    /// sequential requests. Unknown ids are simply missing from the result.
    fn fetch_media_details<'a>(
        &'a self,
        ids: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, TrackerError>>;

    fn search_anime<'a>(
        &'a self,
        query: &'a str,
        season: Option<&'a str>,
        year: Option<u32>,
    ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, String>>;

    /// Fetch one page (1-based) of every anime in `season` (`WINTER`..`FALL`) of `year`, most popular first.
    fn fetch_season_page<'a>(
        &'a self,
        season: &'a str,
        year: u32,
        page: u32,
    ) -> BoxFuture<'a, Result<SeasonPage, TrackerError>>;

    /// Fetch one page (1-based) of every episode airing in `from..to` (unix seconds), earliest first.
    /// Adult media are left out.
    fn fetch_airing_schedule_page<'a>(
        &'a self,
        from: i64,
        to: i64,
        page: u32,
    ) -> BoxFuture<'a, Result<AiringSchedulePage, TrackerError>>;

    /// Fetch one media with the same fields as a season page item. `Ok(None)` if it doesn't exist.
    fn fetch_media_metadata<'a>(
        &'a self,
        id: i64,
    ) -> BoxFuture<'a, Result<Option<SeasonalAnime>, TrackerError>>;

    /// Create or update the viewer's list entry for `update.media_id`.
    fn save_list_entry<'a>(
        &'a self,
        token: &'a str,
        update: &'a TrackerEntryUpdate,
    ) -> BoxFuture<'a, Result<RemoteEntryState, TrackerError>>;

    /// Delete the viewer's list entry for `media_id`. Already-missing entries count as success.
    fn delete_list_entry<'a>(
        &'a self,
        token: &'a str,
        media_id: i64,
        list_entry_id: Option<i64>,
    ) -> BoxFuture<'a, Result<(), TrackerError>>;
}

/// Stub plugin implementation for additional trackers in the plugin registry.
struct StubTrackerPlugin {
    desc: TrackerPluginDescriptor,
}

impl StubTrackerPlugin {
    fn not_configured(&self) -> TrackerError {
        TrackerError::Api(format!("{} plugin is not yet configured.", self.desc.name))
    }
}

impl TrackerPlugin for StubTrackerPlugin {
    fn descriptor(&self) -> TrackerPluginDescriptor {
        self.desc.clone()
    }

    fn verify_account<'a>(
        &'a self,
        _username: &'a str,
        _token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<TrackerUserProfile, String>> {
        let name = self.desc.name.clone();
        Box::pin(async move {
            Err(format!(
                "{} plugin slot is registered in Tora's PluginManager. Switch to AniList or configure API credentials.",
                name
            ))
        })
    }

    fn fetch_user_list<'a>(
        &'a self,
        _token: &'a str,
    ) -> BoxFuture<'a, Result<RemoteListSnapshot, TrackerError>> {
        let err = self.not_configured();
        Box::pin(async move { Err(err) })
    }

    fn viewer_id<'a>(&'a self, _token: &'a str) -> BoxFuture<'a, Result<i64, TrackerError>> {
        let err = self.not_configured();
        Box::pin(async move { Err(err) })
    }

    fn fetch_media_details<'a>(
        &'a self,
        _ids: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, TrackerError>> {
        let err = self.not_configured();
        Box::pin(async move { Err(err) })
    }

    fn search_anime<'a>(
        &'a self,
        _query: &'a str,
        _season: Option<&'a str>,
        _year: Option<u32>,
    ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, String>> {
        let name = self.desc.name.clone();
        Box::pin(async move { Err(format!("{} plugin is not yet configured.", name)) })
    }

    fn fetch_season_page<'a>(
        &'a self,
        _season: &'a str,
        _year: u32,
        _page: u32,
    ) -> BoxFuture<'a, Result<SeasonPage, TrackerError>> {
        let err = self.not_configured();
        Box::pin(async move { Err(err) })
    }

    fn fetch_airing_schedule_page<'a>(
        &'a self,
        _from: i64,
        _to: i64,
        _page: u32,
    ) -> BoxFuture<'a, Result<AiringSchedulePage, TrackerError>> {
        let err = self.not_configured();
        Box::pin(async move { Err(err) })
    }

    fn fetch_media_metadata<'a>(
        &'a self,
        _id: i64,
    ) -> BoxFuture<'a, Result<Option<SeasonalAnime>, TrackerError>> {
        let err = self.not_configured();
        Box::pin(async move { Err(err) })
    }

    fn save_list_entry<'a>(
        &'a self,
        _token: &'a str,
        _update: &'a TrackerEntryUpdate,
    ) -> BoxFuture<'a, Result<RemoteEntryState, TrackerError>> {
        let err = self.not_configured();
        Box::pin(async move { Err(err) })
    }

    fn delete_list_entry<'a>(
        &'a self,
        _token: &'a str,
        _media_id: i64,
        _list_entry_id: Option<i64>,
    ) -> BoxFuture<'a, Result<(), TrackerError>> {
        let err = self.not_configured();
        Box::pin(async move { Err(err) })
    }
}

pub struct PluginManager {
    plugins: HashMap<String, Arc<dyn TrackerPlugin>>,
}

impl PluginManager {
    pub fn new() -> Self {
        let mut plugins: HashMap<String, Arc<dyn TrackerPlugin>> = HashMap::new();

        let anilist = Arc::new(AniListPlugin::new());
        plugins.insert("anilist".into(), anilist);

        let mal = Arc::new(StubTrackerPlugin {
            desc: TrackerPluginDescriptor {
                id: "myanimelist".into(),
                name: "MyAnimeList (MAL)".into(),
                description: "Internal plugin slot for MyAnimeList REST API v2.".into(),
                website_url: "https://myanimelist.net".into(),
                oauth_authorize_url: "https://myanimelist.net/v1/oauth2/authorize".into(),
                supports_public_username_sync: true,
                supports_oauth_token: true,
                supports_seasonal_browse: true,
                status: "plugin-slot".into(),
            },
        });
        plugins.insert("myanimelist".into(), mal);

        let kitsu = Arc::new(StubTrackerPlugin {
            desc: TrackerPluginDescriptor {
                id: "kitsu".into(),
                name: "Kitsu".into(),
                description: "Internal plugin slot for Kitsu JSON:API tracker sync.".into(),
                website_url: "https://kitsu.app".into(),
                oauth_authorize_url: "https://kitsu.app/api/oauth/token".into(),
                supports_public_username_sync: true,
                supports_oauth_token: true,
                supports_seasonal_browse: false,
                status: "plugin-slot".into(),
            },
        });
        plugins.insert("kitsu".into(), kitsu);

        Self { plugins }
    }

    pub fn list_descriptors(&self) -> Vec<TrackerPluginDescriptor> {
        let mut list: Vec<TrackerPluginDescriptor> =
            self.plugins.values().map(|p| p.descriptor()).collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// Register (or replace) a plugin under `plugin_id`. Used by tests to inject mock trackers.
    pub fn register(&mut self, plugin_id: &str, plugin: Arc<dyn TrackerPlugin>) {
        self.plugins.insert(plugin_id.to_string(), plugin);
    }

    pub fn get(&self, plugin_id: &str) -> Option<Arc<dyn TrackerPlugin>> {
        self.plugins
            .get(plugin_id)
            .cloned()
            .or_else(|| self.plugins.get("anilist").cloned())
    }
}
