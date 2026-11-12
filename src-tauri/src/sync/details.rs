//! The anime page's details (characters, staff, recommendations) and the followed users' entries.
//!
//! Details are public data stored next to the media's metadata (`media_metadata.details_json`) and
//! refreshed by age; the followed users' entries belong to the signed-in account, so they only live in
//! memory for a few minutes.

use super::TrackerSyncService;
use crate::plugins::{FollowingPage, MediaDetails};
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

impl TrackerSyncService {
    /// The anime page's details: stored ones while fresh, else fetched (through the limiter) and stored.
    /// `refresh` fetches regardless of age. When AniList can't be reached the stored copy is served.
    pub async fn media_details(&self, anilist_id: i64, refresh: bool) -> Result<Option<MediaDetails>, String> {
        // The details live on the metadata row: make sure it exists (stored, or fetched once)
        let Some(meta) = self.media_metadata(anilist_id).await? else {
            return Ok(None);
        };
        let stored = self.blocking(move |db| db.get_media_details(anilist_id)).await?;
        let now = chrono::Utc::now().timestamp();
        if let Some((fetched_at, details)) = &stored {
            if !refresh && now - fetched_at < details_max_age(Some(meta.entry.airing_status.as_str())) {
                return Ok(Some(details.clone()));
            }
        }

        let fetched = match self.plugin() {
            Ok(plugin) => self.limiter.run(|| plugin.fetch_media_page_details(anilist_id)).await,
            Err(e) => Err(e),
        };
        match fetched {
            Ok(Some(details)) => {
                let to_store = details.clone();
                self.blocking(move |db| db.put_media_details(anilist_id, now, &to_store)).await?;
                Ok(Some(details))
            }
            Ok(None) => Ok(stored.map(|(_, d)| d)),
            Err(e) => match stored {
                Some((_, details)) => {
                    log::warn!(target: "sync", "details of {} not refreshed: {}", anilist_id, e);
                    Ok(Some(details))
                }
                None => Err(e.into()),
            },
        }
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

    /// The signed-in account's followed users' entries for one media; `None` while signed out. Served
    /// from memory for a few minutes (per account), never stored.
    pub async fn following_entries(&self, media_id: i64, refresh: bool) -> Result<Option<FollowingPage>, String> {
        let Some(token) = self.current_token().await? else {
            return Ok(None);
        };
        if !refresh {
            let cache = self.following_cache.lock().map_err(|e| e.to_string())?;
            if let Some((at, cached_token, page)) = cache.get(&media_id) {
                if *cached_token == token && at.elapsed() < FOLLOWING_MAX_AGE {
                    return Ok(Some(page.clone()));
                }
            }
        }
        let plugin = self.plugin()?;
        let page = self
            .limiter
            .run(|| plugin.fetch_following_entries(&token, media_id))
            .await?;
        let mut cache = self.following_cache.lock().map_err(|e| e.to_string())?;
        // Entries of other accounts or long gone pages are dropped as new ones arrive
        cache.retain(|_, (at, t, _)| *t == token && at.elapsed() < FOLLOWING_MAX_AGE);
        cache.insert(media_id, (Instant::now(), token, page.clone()));
        Ok(Some(page))
    }
}
