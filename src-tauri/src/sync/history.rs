//! AniList activity history: the opt-in full import (newest → oldest, resumable page by page) and the
//! small refresh that follows each pull once the import is done.
//!
//! Neither takes `op_lock`: a long import never blocks pushes or pulls. Every request still goes through
//! the shared rate limiter, and the import adds its own spacing ([`HISTORY_PAGE_INTERVAL`]) because
//! AniList currently allows 30 requests a minute.
//!
//! Events: `anilist-history-progress` ([`AniListHistoryStatus`]) after every page and state change,
//! `anilist-history-updated` `{ added }` when a refresh stored new activity.

use super::{TrackerSyncService, EVENT_AUTH_INVALID};
use crate::db::{AniListHistoryState, AniListHistoryStatus, ImportStatus};
use crate::plugins::{ActivityPage, ActivityPageQuery, TrackerError, TrackerPlugin, ACTIVITY_PAGE_SIZE};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const EVENT_HISTORY_PROGRESS: &str = "anilist-history-progress";
pub const EVENT_HISTORY_UPDATED: &str = "anilist-history-updated";

/// Spacing between import pages (AniList: 30 requests / minute).
pub(super) const HISTORY_PAGE_INTERVAL: Duration = Duration::from_millis(2100);
/// Waits before retrying a failed import page; after the last one the import pauses with the error.
const RETRY_DELAYS_SECS: [u64; 3] = [5, 15, 45];
/// Refreshes re-read this much before the newest stored activity: AniList grows a merged
/// "watched episode 1 - 3" activity in place, keeping its `createdAt`.
const REFRESH_OVERLAP_SECS: i64 = 48 * 60 * 60;
/// A refresh stops after this many pages (a long time signed out); the rest arrives with the next one.
const REFRESH_MAX_PAGES: u32 = 40;

/// Clears the "an import or refresh is running" flag when the task ends, however it ends.
struct RunningGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Why an import stopped before reaching the oldest activity.
enum Stop {
    Paused,
    Failed(String),
}

impl TrackerSyncService {
    pub async fn history_status(&self) -> Result<AniListHistoryStatus, String> {
        let active = self.history_running.load(Ordering::SeqCst);
        let (state, (activity_count, episode_count)) = self
            .blocking(|db| Ok((db.anilist_history_state()?, db.anilist_history_counts()?)))
            .await?;
        Ok(AniListHistoryStatus {
            state,
            active,
            activity_count,
            episode_count,
        })
    }

    async fn emit_history_status(&self) {
        match self.history_status().await {
            Ok(status) => self.emit(
                EVENT_HISTORY_PROGRESS,
                serde_json::to_value(&status).unwrap_or(Value::Null),
            ),
            Err(e) => log::warn!(target: "sync", "reading the history import state failed: {}", e),
        }
    }

    /// Start the import, or resume it from its cursor, in the background. A finished import is left
    /// alone (delete it first to import again); a running one keeps running.
    pub fn start_history_import(self: &Arc<Self>) {
        self.history_pause.store(false, Ordering::SeqCst);
        if self.history_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let svc = self.clone();
        tokio::spawn(async move {
            {
                let _guard = RunningGuard(&svc.history_running);
                svc.run_history_import().await;
            }
            svc.emit_history_status().await;
        });
    }

    /// Ask a running import to stop after the current page (it resumes from there).
    pub fn pause_history_import(&self) {
        self.history_pause.store(true, Ordering::SeqCst);
    }

    /// Startup: resume an import the app was closed during, or one an error paused. One the user
    /// paused stays paused.
    pub async fn resume_history_import_if_interrupted(self: &Arc<Self>) {
        let state = match self.blocking(|db| db.anilist_history_state()).await {
            Ok(s) => s,
            Err(_) => return,
        };
        let interrupted = state.status == ImportStatus::Running
            || (state.status == ImportStatus::Paused && state.last_error.is_some());
        if interrupted {
            log::info!(target: "sync", "resuming the AniList history import ({} activities read)", state.fetched);
            self.start_history_import();
        }
    }

    /// Delete every imported activity and the import state (a running import is stopped first).
    pub async fn clear_history_import(&self) -> Result<(), String> {
        self.pause_history_import();
        while self.history_running.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.blocking(|db| db.clear_anilist_history()).await?;
        log::info!(target: "sync", "imported AniList history deleted");
        self.emit_history_status().await;
        Ok(())
    }

    /// Token and AniList user id the import may use: the token's viewer must own the local list.
    async fn history_account(&self) -> Result<(String, i64, Arc<dyn TrackerPlugin>), TrackerError> {
        let token = self
            .current_token()
            .await
            .map_err(TrackerError::Api)?
            .ok_or_else(|| TrackerError::Unauthorized("Not signed in to AniList".into()))?;
        let plugin = self.plugin()?;
        let viewer = plugin.viewer_id(&token).await?;
        let owner = self.blocking(|db| db.list_owner()).await.map_err(TrackerError::Api)?;
        if let Some(owner) = owner.filter(|o| *o != viewer) {
            return Err(TrackerError::Api(format!(
                "The local list belongs to AniList user {} but the signed-in account is {}",
                owner, viewer
            )));
        }
        Ok((token, viewer, plugin))
    }

    async fn fetch_activity_page(
        &self,
        plugin: &Arc<dyn TrackerPlugin>,
        token: &str,
        query: &ActivityPageQuery,
    ) -> Result<ActivityPage, TrackerError> {
        self.limiter
            .run(|| plugin.fetch_list_activities(token, query))
            .await
    }

    /// One page with retries for transient failures (network, 5xx, a second rate limit).
    async fn fetch_activity_page_retrying(
        &self,
        plugin: &Arc<dyn TrackerPlugin>,
        token: &str,
        query: &ActivityPageQuery,
    ) -> Result<ActivityPage, TrackerError> {
        let mut attempt = 0;
        loop {
            match self.fetch_activity_page(plugin, token, query).await {
                Err(e @ (TrackerError::Network(_) | TrackerError::RateLimited { .. }))
                    if attempt < RETRY_DELAYS_SECS.len() =>
                {
                    let wait = RETRY_DELAYS_SECS[attempt] * self.history_retry_scale;
                    log::warn!(target: "sync", "history page failed ({}), retrying in {}s", e, wait);
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    attempt += 1;
                }
                other => return other,
            }
        }
    }

    async fn save_history_state(&self, state: &AniListHistoryState) -> Result<(), String> {
        let state = state.clone();
        self.blocking(move |db| db.set_anilist_history_state(&state)).await
    }

    async fn run_history_import(self: &Arc<Self>) {
        let started = Instant::now();
        let mut state = match self.blocking(|db| db.anilist_history_state()).await {
            Ok(s) => s,
            Err(e) => {
                log::error!(target: "sync", "reading the history import state failed: {}", e);
                return;
            }
        };
        if state.status == ImportStatus::Done {
            return;
        }
        let fetched_before = state.fetched;
        state.status = ImportStatus::Running;
        state.last_error = None;
        state
            .started_at
            .get_or_insert_with(|| chrono::Utc::now().timestamp());

        let outcome = self.import_pages(&mut state).await;
        let read = state.fetched - fetched_before;
        match outcome {
            Ok(()) => {
                log::info!(
                    target: "sync",
                    "AniList history import finished: {} activities ({} this run) in {}s",
                    state.fetched,
                    read,
                    started.elapsed().as_secs()
                );
                // Activity that happened while the import walked back in time
                if let Err(e) = self.refresh_history_inner("import").await {
                    log::warn!(target: "sync", "history refresh after the import failed: {}", e);
                }
            }
            Err(stop) => {
                state.status = ImportStatus::Paused;
                state.last_error = match stop {
                    Stop::Paused => None,
                    Stop::Failed(m) => Some(m),
                };
                match &state.last_error {
                    Some(e) => log::warn!(
                        target: "sync",
                        "AniList history import paused after {} activities: {}",
                        state.fetched,
                        e
                    ),
                    None => log::info!(
                        target: "sync",
                        "AniList history import paused by the user after {} activities",
                        state.fetched
                    ),
                }
                if let Err(e) = self.save_history_state(&state).await {
                    log::error!(target: "sync", "saving the history import state failed: {}", e);
                }
            }
        }
    }

    /// Walk pages below `state.cursor` until the oldest activity, storing each page with the state that
    /// follows it. `Ok` = reached the end (state saved as Done).
    async fn import_pages(&self, state: &mut AniListHistoryState) -> Result<(), Stop> {
        let failed = |e: TrackerError, svc: &Self| {
            if matches!(e, TrackerError::Unauthorized(_)) {
                svc.emit(EVENT_AUTH_INVALID, json!({ "message": e.to_string() }));
            }
            Stop::Failed(e.to_string())
        };
        let (token, user_id, plugin) = self.history_account().await.map_err(|e| failed(e, self))?;
        self.save_history_state(state).await.map_err(Stop::Failed)?;
        self.emit_history_status().await;

        if state.earliest_at.is_none() {
            let oldest = ActivityPageQuery {
                user_id,
                oldest_first: true,
                per_page: 1,
                ..Default::default()
            };
            let page = self
                .fetch_activity_page_retrying(&plugin, &token, &oldest)
                .await
                .map_err(|e| failed(e, self))?;
            state.earliest_at = page.items.first().map(|a| a.created_at);
            log::info!(
                target: "sync",
                "AniList history import started (oldest activity at {:?})",
                state.earliest_at
            );
        }

        loop {
            if self.history_pause.load(Ordering::SeqCst) {
                return Err(Stop::Paused);
            }
            // `createdAt_lesser` is exclusive: + 1 keeps activities sharing the cursor's second (stored
            // ones are deduplicated by id)
            let query = ActivityPageQuery {
                user_id,
                created_before: state.cursor.map(|c| c + 1),
                per_page: ACTIVITY_PAGE_SIZE,
                ..Default::default()
            };
            let page = self
                .fetch_activity_page_retrying(&plugin, &token, &query)
                .await
                .map_err(|e| failed(e, self))?;

            if state.newest_at.is_none() {
                state.newest_at = page.items.iter().map(|a| a.created_at).max();
            }
            state.fetched += page
                .items
                .iter()
                .filter(|a| state.cursor.map_or(true, |c| a.created_at < c))
                .count() as u32;
            let oldest_in_page = page.items.iter().map(|a| a.created_at).min();
            let done = !page.has_next_page || oldest_in_page.is_none();
            if let Some(oldest) = oldest_in_page {
                // A full page that never got below the cursor would repeat forever: step past its second
                state.cursor = Some(if Some(oldest) == state.cursor { oldest - 1 } else { oldest });
            }
            if done {
                let now = chrono::Utc::now().timestamp();
                state.status = ImportStatus::Done;
                state.finished_at = Some(now);
                state.last_refreshed_at = Some(now);
            }
            let items = page.items;
            let snapshot = state.clone();
            let stored = self
                .blocking(move |db| db.store_anilist_activities(&items, Some(&snapshot)))
                .await
                .map_err(Stop::Failed)?;
            log::debug!(
                target: "sync",
                "history page: {} episode activities stored, cursor {:?}",
                stored,
                state.cursor
            );
            self.emit_history_status().await;
            if done {
                return Ok(());
            }
            tokio::time::sleep(self.history_page_interval).await;
        }
    }

    /// After a pull: fetch activity newer than what's stored, if the user imported their history and
    /// keeps it updated. Runs in the background; logs its own cost.
    pub(super) fn spawn_history_refresh(self: &Arc<Self>, reason: &str) {
        let svc = self.clone();
        let reason = reason.to_string();
        tokio::spawn(async move {
            if let Err(e) = svc.refresh_history(&reason).await {
                log::warn!(target: "sync", "history refresh({}) failed: {}", reason, e);
            }
        });
    }

    /// Fetch activity newer than the newest stored one (with an overlap). Does nothing unless the
    /// setting is on and the full import is done. Returns how many activities were new or changed.
    pub async fn refresh_history(&self, reason: &str) -> Result<usize, String> {
        let settings = self.blocking(|db| db.get_settings()).await?;
        let state = self.blocking(|db| db.anilist_history_state()).await?;
        if !settings.anilist_history_enabled || state.status != ImportStatus::Done {
            return Ok(0);
        }
        if self.history_running.swap(true, Ordering::SeqCst) {
            return Ok(0);
        }
        let result = {
            let _guard = RunningGuard(&self.history_running);
            self.refresh_history_inner(reason).await
        };
        self.emit_history_status().await;
        result
    }

    async fn refresh_history_inner(&self, reason: &str) -> Result<usize, String> {
        let started = Instant::now();
        let (token, user_id, plugin) = self.history_account().await.map_err(|e| e.to_string())?;
        let newest = self.blocking(|db| db.newest_anilist_activity_at()).await?;
        let since = newest.unwrap_or_else(|| chrono::Utc::now().timestamp()) - REFRESH_OVERLAP_SECS;
        let mut cursor: Option<i64> = None;
        let (mut pages, mut added) = (0u32, 0usize);
        loop {
            let query = ActivityPageQuery {
                user_id,
                created_after: Some(since),
                created_before: cursor.map(|c| c + 1),
                per_page: ACTIVITY_PAGE_SIZE,
                ..Default::default()
            };
            let page = self
                .fetch_activity_page(&plugin, &token, &query)
                .await
                .map_err(|e| e.to_string())?;
            pages += 1;
            let oldest = page.items.iter().map(|a| a.created_at).min();
            let more = page.has_next_page && oldest.is_some() && pages < REFRESH_MAX_PAGES;
            if let Some(oldest) = oldest {
                cursor = Some(if Some(oldest) == cursor { oldest - 1 } else { oldest });
            }
            let items = page.items;
            added += self
                .blocking(move |db| db.store_anilist_activities(&items, None))
                .await?;
            if !more {
                break;
            }
        }
        let mut state = self.blocking(|db| db.anilist_history_state()).await?;
        state.last_refreshed_at = Some(chrono::Utc::now().timestamp());
        self.save_history_state(&state).await?;
        log::info!(
            target: "sync",
            "history refresh({}): {} page(s), +{} in {}ms",
            reason,
            pages,
            added,
            started.elapsed().as_millis()
        );
        if added > 0 {
            self.emit(EVENT_HISTORY_UPDATED, json!({ "added": added }));
        }
        Ok(added)
    }
}
