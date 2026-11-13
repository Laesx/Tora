//! The anime page's data: the media's metadata, its details (characters, staff, recommendations) and the
//! followed users' entries, in at most one AniList request per call.
//!
//! Details are public data stored next to the media's metadata (`media_metadata.details_json`) and
//! refreshed by age; the followed users' entries belong to the signed-in account, so they only live in
//! memory for a few minutes.

use super::TrackerSyncService;
use crate::plugins::{AnimePageFetch, AnimePageParts, FollowingPage, MediaDetails, SeasonalAnime};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::{Duration, Instant};

/// Stored details of a finished (or cancelled) anime are fetched again after this long.
const FINISHED_DETAILS_MAX_AGE_SECS: i64 = 30 * 24 * 3600;
/// Airing / upcoming anime gain characters as they air.
const AIRING_DETAILS_MAX_AGE_SECS: i64 = 7 * 24 * 3600;
/// A page of followed users' entries is served from memory this long.
pub(super) const FOLLOWING_MAX_AGE: Duration = Duration::from_secs(10 * 60);

/// How old stored details may get for an anime with this AniList airing status.
pub(super) fn details_max_age(airing_status: Option<&str>) -> i64 {
    match airing_status {
        Some("FINISHED") | Some("CANCELLED") => FINISHED_DETAILS_MAX_AGE_SECS,
        _ => AIRING_DETAILS_MAX_AGE_SECS,
    }
}

/// What the anime page shows right now (its open sections) and what it wants fetched again.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnimePageRequest {
    /// Characters, staff (and recommendations, when wanted) fetched regardless of age
    #[serde(default)]
    pub refresh_details: bool,
    /// The Recommendations section is open
    #[serde(default)]
    pub recommendations: bool,
    /// The Following section is open
    #[serde(default)]
    pub following: bool,
    #[serde(default)]
    pub refresh_following: bool,
    /// Users pinned on this device: their entries are wanted even outside the first 50 followed ones
    #[serde(default)]
    pub pinned_users: Vec<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnimePageData {
    /// `None` when AniList has no such media (or it couldn't be reached and nothing is stored)
    pub media: Option<SeasonalAnime>,
    pub details: Option<MediaDetails>,
    /// `None` while signed out or when the Following section isn't open
    pub following: Option<FollowingPage>,
    pub signed_in: bool,
    /// AniList couldn't be reached: what's shown is the stored copy (or nothing)
    pub error: Option<String>,
}

/// Stored recommendations count as fetched when the flag says so, or (stored before it) any are there.
fn has_recommendations(details: &MediaDetails) -> bool {
    details.recommendations_fetched || !details.recommendations.is_empty()
}

impl TrackerSyncService {
    /// Everything the anime page needs for one media: stored data while it's fresh, and one request for
    /// whatever is missing or old (metadata, details, recommendations, followed users). Calls are
    /// serialized, so a second identical call is served by the first one's results.
    pub async fn anime_page(&self, anilist_id: i64, req: AnimePageRequest) -> Result<AnimePageData, String> {
        let _turn = self.page_lock.lock().await;
        let stored_meta = self
            .blocking(move |db| db.get_media_metadata(anilist_id))
            .await?
            .map(|(_, item)| item);
        let stored_details = self.blocking(move |db| db.get_media_details(anilist_id)).await?;
        let token = self.current_token().await?;
        let now = chrono::Utc::now().timestamp();

        // Stored before relations existed: fetched once more, the stored copy serves if that fails
        let need_meta = stored_meta.as_ref().map_or(true, |m| m.metadata.relations.is_none());
        let max_age = details_max_age(stored_meta.as_ref().map(|m| m.entry.airing_status.as_str()));
        let need_details = req.refresh_details
            || stored_details.as_ref().map_or(true, |(at, _)| now - at >= max_age);
        let need_recommendations = req.recommendations
            && (need_details || !stored_details.as_ref().is_some_and(|(_, d)| has_recommendations(d)));
        let cached_following = match (&token, req.following && !req.refresh_following) {
            (Some(token), true) => self.cached_following(anilist_id, token)?,
            _ => None,
        };
        let need_following = req.following && token.is_some() && cached_following.is_none();

        let parts = AnimePageParts {
            metadata: need_meta,
            details: need_details,
            recommendations: need_recommendations,
            following: need_following,
            pinned_users: if need_following { req.pinned_users.clone() } else { vec![] },
        };
        let mut data = AnimePageData {
            media: stored_meta,
            details: stored_details.as_ref().map(|(_, d)| d.clone()),
            following: if req.following { cached_following } else { None },
            signed_in: token.is_some(),
            error: None,
        };
        if parts.is_empty() {
            return Ok(data);
        }

        let fetched = match self.plugin() {
            Ok(plugin) => {
                let token = token.as_deref();
                self.limiter.run(|| plugin.fetch_anime_page(anilist_id, &parts, token)).await
            }
            Err(e) => Err(e),
        };
        let fetched: AnimePageFetch = match fetched {
            Ok(fetched) => fetched,
            Err(e) => {
                log::warn!(target: "sync", "anime page {} not fetched: {}", anilist_id, e);
                if data.media.is_none() && data.details.is_none() {
                    return Err(e.into());
                }
                data.error = Some(e.to_string());
                return Ok(data);
            }
        };

        if let Some(media) = fetched.media {
            let to_store = media.clone();
            self.blocking(move |db| db.put_media_metadata(now, &to_store)).await?;
            data.media = Some(media);
        } else if parts.metadata && data.media.is_none() {
            // AniList has no such media
            return Ok(data);
        }

        // Details live on the metadata row, so they are stored after it
        let stored = stored_details;
        let details = match (fetched.details, fetched.recommendations) {
            (None, None) => None,
            (new_details, recommendations) => {
                let (fetched_at, mut details) = match (new_details, &stored) {
                    (Some(d), _) => (now, d),
                    // Only recommendations were missing: the rest keeps its age
                    (None, Some((at, d))) => (*at, d.clone()),
                    (None, None) => (now, MediaDetails::default()),
                };
                match (recommendations, &stored) {
                    (Some(recs), _) => {
                        details.recommendations = recs;
                        details.recommendations_fetched = true;
                    }
                    // Details fetched again without the closed Recommendations section: keep the stored ones
                    (None, Some((_, old))) => {
                        details.recommendations = old.recommendations.clone();
                        details.recommendations_fetched = has_recommendations(old);
                    }
                    (None, None) => {}
                }
                Some((fetched_at, details))
            }
        };
        if let Some((fetched_at, details)) = details {
            let to_store = details.clone();
            self.blocking(move |db| db.put_media_details(anilist_id, fetched_at, &to_store)).await?;
            data.details = Some(details);
        }

        if let (Some(page), Some(token)) = (fetched.following, token) {
            let mut cache = self.following_cache.lock().map_err(|e| e.to_string())?;
            // Entries of other accounts or long gone pages are dropped as new ones arrive
            cache.retain(|_, (at, t, _)| *t == token && at.elapsed() < FOLLOWING_MAX_AGE);
            cache.insert(anilist_id, (Instant::now(), token, page.clone()));
            data.following = Some(page);
        }
        Ok(data)
    }

    /// The followed users' entries for this media and account, while they are recent enough.
    fn cached_following(&self, media_id: i64, token: &str) -> Result<Option<FollowingPage>, String> {
        let cache = self.following_cache.lock().map_err(|e| e.to_string())?;
        Ok(cache
            .get(&media_id)
            .filter(|(at, cached_token, _)| cached_token == token && at.elapsed() < FOLLOWING_MAX_AGE)
            .map(|(_, _, page)| page.clone()))
    }

    /// Fetches the next page of characters, appends it to the stored details and returns them.
    pub async fn load_more_characters(&self, anilist_id: i64) -> Result<MediaDetails, String> {
        let Some((fetched_at, mut details)) = self.blocking(move |db| db.get_media_details(anilist_id)).await? else {
            return Err("No stored details for this anime".into());
        };
        if !details.characters_has_more {
            return Ok(details);
        }
        let page_number = details.characters_page + 1;
        let plugin = self.plugin()?;
        let page = self
            .limiter
            .run(|| plugin.fetch_characters_page(anilist_id, page_number))
            .await?;
        let known: HashSet<i64> = details.characters.iter().map(|c| c.id).collect();
        details
            .characters
            .extend(page.characters.into_iter().filter(|c| !known.contains(&c.id)));
        details.characters_page = page_number;
        details.characters_has_more = page.has_more;
        let to_store = details.clone();
        // Keeps the first fetch's time: the age rule is about the whole set
        self.blocking(move |db| db.put_media_details(anilist_id, fetched_at, &to_store)).await?;
        Ok(details)
    }
}
