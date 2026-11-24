//! Trackers: the list services Tora syncs with (AniList today; MyAnimeList and Kitsu next).
//!
//! A tracker is one [`Tracker`] object made of parts, so callers ask only for what they use:
//! - [`TrackerAuth`]: who a token belongs to;
//! - [`ListSync`]: the user's list (pull, save, delete);
//! - [`Catalog`]: public anime data (search, seasons, metadata, the anime page);
//! - [`AccountExtras`]: account features only some trackers have (custom lists, activity history).
//!
//! Optional methods default to [`TrackerError::Unsupported`]. Everything a tracker returns uses the neutral
//! types below, in AniList's vocabulary (statuses, formats, relation types, 0–100 scores): an adapter
//! translates its tracker's values. `docs/trackers.md` lists what each tracker supports.

pub mod anilist;

use crate::db::AnimeEntry;
use crate::trackers::anilist::AniListPlugin;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// The tracker a list without an owner belongs to (and the only one registered today).
pub const DEFAULT_TRACKER: &str = "anilist";

/// Request spacing of a tracker that doesn't say otherwise ([`Tracker::min_request_interval`]).
pub const DEFAULT_MIN_REQUEST_INTERVAL: Duration = Duration::from_secs(1);

/// How a tracker signs a user in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthMethod {
    /// The browser opens `authorize_url`; the tracker redirects to Tora's local listener with the access
    /// token in the URL fragment (OAuth implicit grant: AniList).
    BrowserToken { authorize_url: String },
}

/// URL templates of a tracker's public pages: `{id}` is replaced by the id, `{name}` by the URL-encoded
/// name (user, genre, tag). The frontend builds every external link from these (`trackerLink`); a page the
/// tracker doesn't have is `None`, and the UI shows plain text instead of a link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackerLinks {
    pub anime: String,
    pub manga: String,
    pub character: String,
    pub staff: String,
    pub user: String,
    /// An anime's full staff list.
    #[serde(default)]
    pub anime_staff: Option<String>,
    #[serde(default)]
    pub studio: Option<String>,
    /// Anime of one genre.
    #[serde(default)]
    pub genre: Option<String>,
    /// Anime with one tag.
    #[serde(default)]
    pub tag: Option<String>,
}

/// A feature only some trackers have (`docs/trackers.md`). Every tracker syncs the list, searches, browses
/// seasons and shows related anime; the app hides or disables what the active tracker lacks, and never
/// fills it in from another tracker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackerFeature {
    /// The weekly airing timetable (the Schedule tab).
    AiringSchedule,
    /// The next episode's air time (countdowns, "airing in").
    NextEpisode,
    /// Characters and voice actors on the anime page.
    Characters,
    /// Staff on the anime page.
    Staff,
    /// Recommendations on the anime page.
    Recommendations,
    /// The manga / novel an anime adapts ("Based on").
    SourceMaterial,
    /// Custom lists and "hide from status lists".
    CustomLists,
    /// Followed users' entries on the anime page.
    Following,
    /// Importing the account's watch activity into History.
    ActivityHistory,
}

impl TrackerFeature {
    /// Every feature, in the order the support table lists them.
    pub const ALL: [TrackerFeature; 9] = [
        TrackerFeature::AiringSchedule,
        TrackerFeature::NextEpisode,
        TrackerFeature::Characters,
        TrackerFeature::Staff,
        TrackerFeature::Recommendations,
        TrackerFeature::SourceMaterial,
        TrackerFeature::CustomLists,
        TrackerFeature::Following,
        TrackerFeature::ActivityHistory,
    ];

    /// What "<tracker> doesn't support …" messages call it.
    pub fn describe(self) -> &'static str {
        match self {
            TrackerFeature::AiringSchedule => "an airing schedule",
            TrackerFeature::NextEpisode => "next episode times",
            TrackerFeature::Characters => "characters",
            TrackerFeature::Staff => "staff",
            TrackerFeature::Recommendations => "recommendations",
            TrackerFeature::SourceMaterial => "source material",
            TrackerFeature::CustomLists => "custom lists",
            TrackerFeature::Following => "followed users",
            TrackerFeature::ActivityHistory => "activity history",
        }
    }
}

/// A feature a tracker has; `note` says how it falls short when it does ("only anime before 2022").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeatureSupport {
    pub feature: TrackerFeature,
    #[serde(default)]
    pub note: Option<String>,
}

impl FeatureSupport {
    pub fn full(feature: TrackerFeature) -> Self {
        Self { feature, note: None }
    }

    pub fn partial(feature: TrackerFeature, note: &str) -> Self {
        Self {
            feature,
            note: Some(note.into()),
        }
    }
}

/// What the app shows about a tracker and how it signs in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackerDescriptor {
    /// Stable id stored with the account and the list owner (`anilist`).
    pub id: String,
    /// Display name ("AniList").
    pub name: String,
    pub website_url: String,
    pub auth: AuthMethod,
    pub links: TrackerLinks,
    /// The [`TrackerFeature`]s it has; anything missing is unsupported.
    pub features: Vec<FeatureSupport>,
}

impl TrackerDescriptor {
    pub fn supports(&self, feature: TrackerFeature) -> bool {
        self.features.iter().any(|f| f.feature == feature)
    }

    /// `Ok` when the tracker has `feature`, else the [`TrackerError::Unsupported`] naming both.
    pub fn require(&self, feature: TrackerFeature) -> Result<(), TrackerError> {
        if self.supports(feature) {
            Ok(())
        } else {
            Err(TrackerError::Unsupported(format!(
                "{} doesn't support {}.",
                self.name,
                feature.describe()
            )))
        }
    }
}

/// The tokens a sign-in produced (stored with the account, never sent to the frontend).
#[derive(Debug, Clone, PartialEq)]
pub struct AccessTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix second the access token expires; `None` when the tracker doesn't say.
    pub expires_at: Option<i64>,
}

impl AccessTokens {
    /// A token that can't be refreshed (AniList's implicit grant: valid for a year).
    pub fn access_only(token: &str) -> Self {
        Self {
            access_token: token.trim().to_string(),
            refresh_token: None,
            expires_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerUserProfile {
    pub user_id: i64,
    pub username: String,
    pub avatar_url: Option<String>,
    pub anime_count: u32,
    pub episodes_watched: u32,
}

/// Max media ids per [`Catalog::fetch_media_details`] request (AniList `Page.perPage` limit).
pub const MEDIA_DETAILS_CHUNK: usize = 50;

/// Boxed, `Send` future used by the object-safe tracker traits.
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
    /// The tracker has no such feature (the message names the tracker and the feature).
    Unsupported(String),
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
            TrackerError::Unsupported(_) => "unsupported",
        }
    }
}

/// `<tracker> doesn't support <what>.`
fn unsupported<T: Send + 'static>(tracker: &str, what: &str) -> BoxFuture<'static, Result<T, TrackerError>> {
    let message = format!("{} doesn't support {}.", tracker, what);
    Box::pin(async move { Err(TrackerError::Unsupported(message)) })
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
            TrackerError::Unsupported(m) => write!(f, "{}", m),
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
    /// Full set of custom lists the entry is in. `None` leaves the tracker's membership unchanged.
    #[serde(default)]
    pub custom_lists: Option<Vec<String>>,
    /// `None` leaves the tracker's flag unchanged.
    #[serde(default)]
    pub hidden_from_status_lists: Option<bool>,
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
    /// Deduplicated by media id. Each entry carries `remote_entry_id` and the remote `updated_at`.
    pub entries: Vec<AnimeEntry>,
    /// The viewer's custom list names in their own order (empty lists included).
    #[serde(default)]
    pub custom_lists: Vec<String>,
    /// Custom-list membership by media id; only entries in at least one list or hidden from status lists.
    #[serde(default)]
    pub memberships: HashMap<i64, RemoteListMembership>,
    /// The viewer's score format (AniList `ScoreFormat`); `None` when the tracker doesn't say.
    #[serde(default)]
    pub score_format: Option<String>,
}

/// Custom-list membership of one remote list entry.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RemoteListMembership {
    /// Names of the custom lists the entry is in, in the viewer's list order.
    pub lists: Vec<String>,
    pub hidden_from_status_lists: bool,
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

/// The anime a media directly continues (AniList `PREQUEL` relation), for the Seasons extended view.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaPrequel {
    pub id: i64,
    pub title_romaji: String,
    pub title_english: Option<String>,
    pub title_native: Option<String>,
}

/// One AniList relation of a media (sequel, side story, source manga…), for the anime drawer. Only the
/// light fields a card needs: the related media itself is fetched when it is opened.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaRelation {
    pub id: i64,
    /// AniList `MediaRelation` (version 2): `PREQUEL`, `SEQUEL`, `PARENT`, `SIDE_STORY`, `SOURCE`…
    pub relation_type: String,
    /// `ANIME` or `MANGA`
    pub media_type: String,
    pub title_romaji: String,
    pub title_english: Option<String>,
    pub title_native: Option<String>,
    pub format: Option<String>,
    pub status: Option<String>,
    pub episodes: Option<u32>,
    /// Year it started (season year, else start date)
    pub year: Option<u32>,
    pub cover_image: Option<String>,
}

/// A voice actor of a character (every language AniList knows; the page picks one).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VoiceActor {
    pub id: i64,
    pub name: String,
    pub name_native: Option<String>,
    pub image: Option<String>,
    /// AniList `languageV2`: "Japanese", "English", "Spanish"…
    pub language: String,
}

/// A character of a media, with its voice actors.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CharacterRole {
    pub id: i64,
    pub name: String,
    pub name_native: Option<String>,
    pub image: Option<String>,
    /// `MAIN`, `SUPPORTING` or `BACKGROUND`
    pub role: String,
    pub voice_actors: Vec<VoiceActor>,
}

/// A staff member of a media and what they did on it ("Director", "Original Creator"…).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StaffRole {
    pub id: i64,
    pub name: String,
    pub name_native: Option<String>,
    pub image: Option<String>,
    pub role: String,
}

/// An AniList user recommendation: the recommended media (light card fields) and its rating.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaRecommendation {
    pub rating: i64,
    pub media: MediaRelation,
}

/// The anime page's details, stored in `media_metadata.details_json` (never inside `payload_json`, which
/// season views read in bulk). Characters load 25 per page; more pages are appended on demand.
/// Recommendations are only fetched once someone opens their section (`recommendations_fetched`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaDetails {
    pub characters: Vec<CharacterRole>,
    /// Character pages loaded so far
    pub characters_page: u32,
    pub characters_has_more: bool,
    pub staff: Vec<StaffRole>,
    pub staff_has_more: bool,
    pub recommendations: Vec<MediaRecommendation>,
    /// Whether `recommendations` were fetched (stored before this field: they were, if any are there)
    #[serde(default)]
    pub recommendations_fetched: bool,
}

/// What one anime page request asks AniList for. Any combination goes out as one GraphQL document.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnimePageParts {
    /// The media itself, as a `SeasonalAnime` (entry fields, tags, studios, rankings, relations)
    pub metadata: bool,
    /// The first page of characters and the first 25 staff
    pub details: bool,
    /// The top 10 recommendations
    pub recommendations: bool,
    /// The followed users' entries (needs the token)
    pub following: bool,
    /// Users whose entries are wanted even outside the first 50 followed ones (with `following`)
    pub pinned_users: Vec<i64>,
}

impl AnimePageParts {
    pub fn is_empty(&self) -> bool {
        !(self.metadata || self.details || self.recommendations || self.following)
    }
}

/// The answer to an `AnimePageParts` request: each part is `Some` only when it was asked for.
#[derive(Debug, Clone, Default)]
pub struct AnimePageFetch {
    /// `None` also when AniList has no such media
    pub media: Option<SeasonalAnime>,
    /// Characters and staff (`recommendations` left empty: they come in their own field)
    pub details: Option<MediaDetails>,
    pub recommendations: Option<Vec<MediaRecommendation>>,
    /// The followed users' entries, the pinned users' ones included
    pub following: Option<FollowingPage>,
}

/// One page of a media's characters.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CharactersPage {
    pub characters: Vec<CharacterRole>,
    pub has_more: bool,
}

/// A followed user's list entry for one media (account-specific: never stored).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FollowingEntry {
    pub user_id: i64,
    pub user_name: String,
    pub avatar: Option<String>,
    pub status: String,
    pub progress: u32,
    pub repeat: u32,
    /// 0–100 (shown in the viewer's score format)
    pub score: f64,
    pub notes: Option<String>,
    /// Unix seconds
    pub updated_at: Option<i64>,
}

/// The followed users' entries for one media, newest update first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FollowingPage {
    pub entries: Vec<FollowingEntry>,
    pub has_more: bool,
}

/// Non-essential metadata shown by the Now Playing hero, the Seasons view and the anime drawer. Written by
/// season fetches, or one fetch for media that have none yet (or were stored without `relations`); never
/// refreshed by playback.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaMetadata {
    pub mean_score: Option<u32>,
    pub favourites: Option<u32>,
    pub tags: Vec<MediaTag>,
    pub studios: Vec<StudioRef>,
    pub rankings: Vec<MediaRanking>,
    /// `None` only in payloads stored before this field existed (`fetch_season` refreshes those once)
    #[serde(default)]
    pub prequels: Option<Vec<MediaPrequel>>,
    /// Every relation, anime and not; `None` only in payloads stored before this field existed (the
    /// drawer's `media_metadata` read refreshes those once)
    #[serde(default)]
    pub relations: Option<Vec<MediaRelation>>,
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

/// One page of [`Catalog::fetch_season_page`].
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

/// One page of [`Catalog::fetch_airing_schedule_page`].
#[derive(Debug, Clone)]
pub struct AiringSchedulePage {
    pub items: Vec<AiringScheduleItem>,
    pub has_next_page: bool,
}

/// Media of a list activity: enough to show the row when the anime is no longer in the list.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ActivityMedia {
    pub title_romaji: String,
    pub title_english: Option<String>,
    pub title_native: Option<String>,
    pub cover: String,
    pub format: Option<String>,
    pub episodes: Option<u32>,
}

/// One anime list activity of the viewer (AniList `ListActivity`). Status-only activities ("completed",
/// "plans to watch", …) have no progress.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteListActivity {
    pub id: i64,
    pub media_id: i64,
    /// Tracker wording, e.g. "watched episode", "rewatched episode", "completed".
    pub status: String,
    pub progress_from: Option<u32>,
    pub progress_to: Option<u32>,
    /// Unix seconds.
    pub created_at: i64,
    pub media: ActivityMedia,
}

/// Bounds of one [`AccountExtras::fetch_list_activities`] request.
#[derive(Debug, Clone, Default)]
pub struct ActivityPageQuery {
    pub user_id: i64,
    /// Only activities created before this unix second (exclusive).
    pub created_before: Option<i64>,
    /// Only activities created after this unix second (exclusive).
    pub created_after: Option<i64>,
    /// Oldest first instead of newest first.
    pub oldest_first: bool,
    pub per_page: u32,
}

/// One page of [`AccountExtras::fetch_list_activities`].
#[derive(Debug, Clone, Default)]
pub struct ActivityPage {
    pub items: Vec<RemoteListActivity>,
    pub has_next_page: bool,
}

/// Max activities per [`AccountExtras::fetch_list_activities`] request (AniList `Page.perPage` limit).
pub const ACTIVITY_PAGE_SIZE: u32 = 50;

/// A tracker: its descriptor and its parts. One object implements every part (see the module docs).
pub trait Tracker: Send + Sync {
    fn descriptor(&self) -> TrackerDescriptor;
    /// Minimum spacing between two requests to this tracker. Each tracker gets its own rate limiter
    /// (`TrackerSyncService::limiter`), so one tracker's pace never slows another's.
    fn min_request_interval(&self) -> Duration {
        DEFAULT_MIN_REQUEST_INTERVAL
    }
    fn auth(&self) -> &dyn TrackerAuth;
    fn list(&self) -> &dyn ListSync;
    fn catalog(&self) -> &dyn Catalog;
    fn extras(&self) -> &dyn AccountExtras;
}

/// Who an access token belongs to.
pub trait TrackerAuth: Send + Sync {
    /// The profile of the account `token` belongs to (name, avatar, list counts).
    fn profile<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<TrackerUserProfile, TrackerError>>;

    /// User id of the account `token` belongs to (implementations cache it per token).
    fn viewer_id<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<i64, TrackerError>>;
}

/// The signed-in user's list.
pub trait ListSync: Send + Sync {
    /// Fetch the authenticated viewer's full anime list. Media carry only the "light" fields
    /// (titles, synonyms, format, status, episodes, season, score, cover, next airing); heavy metadata
    /// (synopsis, genres, studios, banner, trailer, source, duration, site url, MAL id) may be left at its
    /// defaults, to be fetched with [`Catalog::fetch_media_details`].
    fn fetch_user_list<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<RemoteListSnapshot, TrackerError>>;

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
        remote_entry_id: Option<i64>,
    ) -> BoxFuture<'a, Result<(), TrackerError>>;
}

/// Public anime data. Needs no account (the anime page's followed users excepted).
pub trait Catalog: Send + Sync {
    /// Name used in "doesn't support" messages.
    fn tracker_name(&self) -> &str;

    /// Fetch full media metadata for `ids` (no user-list fields). Callers should pass at most
    /// [`MEDIA_DETAILS_CHUNK`] ids per call (one request each); larger inputs are split into
    /// sequential requests. Unknown ids are simply missing from the result.
    fn fetch_media_details<'a>(&'a self, ids: &'a [i64]) -> BoxFuture<'a, Result<Vec<AnimeEntry>, TrackerError>>;

    fn search_anime<'a>(
        &'a self,
        query: &'a str,
        season: Option<&'a str>,
        year: Option<u32>,
    ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, TrackerError>>;

    /// Fetch one page (1-based) of every anime in `season` (`WINTER`..`FALL`) of `year`, most popular first.
    fn fetch_season_page<'a>(
        &'a self,
        season: &'a str,
        year: u32,
        page: u32,
    ) -> BoxFuture<'a, Result<SeasonPage, TrackerError>>;

    /// Fetch one media with the same fields as a season page item. `Ok(None)` if it doesn't exist.
    fn fetch_media_metadata<'a>(&'a self, id: i64) -> BoxFuture<'a, Result<Option<SeasonalAnime>, TrackerError>>;

    /// Several media with the same fields as [`fetch_media_metadata`](Self::fetch_media_metadata), at most
    /// [`MEDIA_DETAILS_CHUNK`] per request. Unknown ids are simply missing from the result. The default
    /// asks for them one by one; trackers that can batch override it.
    fn fetch_media_metadata_batch<'a>(
        &'a self,
        ids: &'a [i64],
    ) -> BoxFuture<'a, Result<Vec<SeasonalAnime>, TrackerError>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(ids.len());
            for &id in ids {
                if let Some(item) = self.fetch_media_metadata(id).await? {
                    out.push(item);
                }
            }
            Ok(out)
        })
    }

    /// Fetch one page (1-based) of every episode airing in `from..to` (unix seconds), earliest first.
    /// Adult media are left out.
    fn fetch_airing_schedule_page<'a>(
        &'a self,
        _from: i64,
        _to: i64,
        _page: u32,
    ) -> BoxFuture<'a, Result<AiringSchedulePage, TrackerError>> {
        unsupported(self.tracker_name(), "an airing schedule")
    }

    /// Whatever the anime page still needs for one media, in one request: its metadata, details
    /// (first page of characters with every voice actor, first 25 staff), recommendations and the
    /// followed / pinned users' entries (`token` required for those). A media that doesn't exist
    /// answers with every media part `None`.
    fn fetch_anime_page<'a>(
        &'a self,
        _id: i64,
        _parts: &'a AnimePageParts,
        _token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<AnimePageFetch, TrackerError>> {
        unsupported(self.tracker_name(), "anime page details")
    }

    /// One page (1-based, 25 per page) of a media's characters.
    fn fetch_characters_page<'a>(&'a self, _id: i64, _page: u32) -> BoxFuture<'a, Result<CharactersPage, TrackerError>> {
        unsupported(self.tracker_name(), "characters")
    }
}

/// Account features only some trackers have. Every method defaults to [`TrackerError::Unsupported`].
pub trait AccountExtras: Send + Sync {
    /// Name used in "doesn't support" messages.
    fn tracker_name(&self) -> &str;

    /// Add a custom anime list named `name` to the viewer's lists (a name that already exists is
    /// left as is). Returns every custom list name in the viewer's order afterwards.
    fn create_custom_list<'a>(&'a self, _token: &'a str, _name: &'a str) -> BoxFuture<'a, Result<Vec<String>, TrackerError>> {
        unsupported(self.tracker_name(), "creating custom lists")
    }

    /// Delete the viewer's custom anime list named `name` (a missing one counts as deleted); its
    /// entries stay on the list. Returns every custom list name in the viewer's order afterwards.
    fn delete_custom_list<'a>(&'a self, _token: &'a str, _name: &'a str) -> BoxFuture<'a, Result<Vec<String>, TrackerError>> {
        unsupported(self.tracker_name(), "deleting custom lists")
    }

    /// Rename the viewer's custom anime list `old` to `new` in place (its entries stay in it). Returns
    /// every custom list name in the viewer's order afterwards.
    fn rename_custom_list<'a>(
        &'a self,
        _token: &'a str,
        _old: &'a str,
        _new: &'a str,
    ) -> BoxFuture<'a, Result<Vec<String>, TrackerError>> {
        unsupported(self.tracker_name(), "renaming custom lists")
    }

    /// One page of the user's anime list activity within `query`'s bounds (`query.per_page` items,
    /// at most [`ACTIVITY_PAGE_SIZE`]).
    fn fetch_list_activities<'a>(
        &'a self,
        _token: &'a str,
        _query: &'a ActivityPageQuery,
    ) -> BoxFuture<'a, Result<ActivityPage, TrackerError>> {
        unsupported(self.tracker_name(), "activity history")
    }
}

/// Every tracker Tora knows, by id.
pub struct TrackerRegistry {
    trackers: HashMap<String, Arc<dyn Tracker>>,
}

impl TrackerRegistry {
    pub fn new() -> Self {
        let mut registry = Self { trackers: HashMap::new() };
        registry.register(Arc::new(AniListPlugin::new()));
        registry
    }

    /// Register (or replace) a tracker under its descriptor's id. Tests use it to inject mocks.
    pub fn register(&mut self, tracker: Arc<dyn Tracker>) {
        self.trackers.insert(tracker.descriptor().id, tracker);
    }

    /// The tracker with this id; `None` for an unknown id (never another tracker in its place).
    pub fn get(&self, id: &str) -> Option<Arc<dyn Tracker>> {
        self.trackers.get(id).cloned()
    }

    /// Every tracker's descriptor, by id.
    pub fn descriptors(&self) -> Vec<TrackerDescriptor> {
        let mut list: Vec<TrackerDescriptor> = self.trackers.values().map(|t| t.descriptor()).collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }
}

impl Default for TrackerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_knows_anilist_and_nothing_else() {
        let registry = TrackerRegistry::new();
        assert!(registry.get(DEFAULT_TRACKER).is_some());
        // An unknown id is never answered by another tracker
        assert!(registry.get("myanimelist").is_none());
        let ids: Vec<String> = registry.descriptors().into_iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["anilist"]);
    }

    #[test]
    fn unsupported_errors_name_the_tracker() {
        struct Bare;
        impl AccountExtras for Bare {
            fn tracker_name(&self) -> &str {
                "Bare"
            }
        }
        let err = futures_lite_block_on(Bare.create_custom_list("t", "x")).unwrap_err();
        assert_eq!(err.kind(), "unsupported");
        assert_eq!(err.to_string(), "Bare doesn't support creating custom lists.");
    }

    #[test]
    fn anilist_has_every_feature_and_require_names_what_is_missing() {
        let anilist = TrackerRegistry::new().get(DEFAULT_TRACKER).unwrap().descriptor();
        for feature in TrackerFeature::ALL {
            assert!(anilist.supports(feature), "{feature:?}");
        }
        let bare = TrackerDescriptor {
            name: "Bare".into(),
            features: vec![FeatureSupport::partial(TrackerFeature::Characters, "older anime only")],
            ..anilist
        };
        assert!(bare.require(TrackerFeature::Characters).is_ok());
        let err = bare.require(TrackerFeature::CustomLists).unwrap_err();
        assert_eq!(err.kind(), "unsupported");
        assert_eq!(err.to_string(), "Bare doesn't support custom lists.");
        // The frontend reads features by these names
        assert_eq!(
            serde_json::to_value(&bare.features).unwrap(),
            serde_json::json!([{ "feature": "characters", "note": "older anime only" }])
        );
    }

    fn futures_lite_block_on<T>(f: BoxFuture<'_, T>) -> T {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }
}
