//! Unified tracker (AniList) sync service.
//!
//! `TrackerSyncService` is the single owner of user-list state changes:
//! validation and status/date derivation ([`normalize_change`]), local SQLite writes, keeping the active
//! playback session in sync, pushing to AniList (save + delete through tombstones), pulling the remote
//! list with newest-wins conflict resolution, retries and error reporting via events.
//!
//! Events emitted (names are a frontend contract):
//! - `tracker-sync-started`  `{ reason }`
//! - `tracker-list-synced`   [`SyncSummary`]
//! - `tracker-sync-failed`   `{ reason, message }`
//! - `tracker-sync-error`    `{ anime_id, media_id, title, kind, message, operation: "save" | "delete" }`
//! - `tracker-auth-invalid`  `{ message }`
//! - `tracker-entry-synced`  `{ entry }`
//! - `library-changed`       `ScanSummary` (after a pull, when background matching bound new local files)
//! - `tracker-account-switched` `{ previous_user_id, user_id, username, discarded_changes }`
//!
//! Edits and deletes are always queued (`sync_pending` / tombstones), signed in or not; they are only sent
//! while signed in, so changes made while signed out reach AniList on the owner's next sign-in. Without a
//! token `pull` fails with "Not signed in to AniList". The local list belongs to one account
//! (`Database::list_owner`): a different account signing in wipes it ([`TrackerSyncService::sign_in`]).

use crate::db::{
    AnimeEntry, AppSettings, BatchAnimeUpdatePatch, CustomListChange, CustomListsState, Database,
};
use crate::detection::anisthesia::DetectedMediaSession;
use crate::library::scanner::ScanSummary;
use crate::plugins::{
    AiringScheduleItem, PluginManager, SeasonalAnime, TrackerEntryUpdate, TrackerError, TrackerPlugin,
    TrackerUserProfile, MEDIA_DETAILS_CHUNK,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use crate::db::ResolvedState;

/// Event sink, decoupled from Tauri so the service is testable. In the app:
/// `Arc::new(move |name, payload| { let _ = app.emit(name, payload); })`.
pub type SyncEmitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub const EVENT_SYNC_STARTED: &str = "tracker-sync-started";
pub const EVENT_LIST_SYNCED: &str = "tracker-list-synced";
pub const EVENT_SYNC_FAILED: &str = "tracker-sync-failed";
pub const EVENT_SYNC_ERROR: &str = "tracker-sync-error";
pub const EVENT_AUTH_INVALID: &str = "tracker-auth-invalid";
pub const EVENT_ENTRY_SYNCED: &str = "tracker-entry-synced";
/// Same event (and `ScanSummary` payload) the library scanner / watcher emits.
pub const EVENT_LIBRARY_CHANGED: &str = "library-changed";
pub const EVENT_ACCOUNT_SWITCHED: &str = "tracker-account-switched";

/// Plugin id used for all sync traffic (login is always AniList OAuth).
const TRACKER_PLUGIN_ID: &str = "anilist";
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(700);
const MAX_RETRY_AFTER_SECS: u64 = 90;

pub const STATUS_CURRENT: &str = "CURRENT";
pub const STATUS_PLANNING: &str = "PLANNING";
pub const STATUS_COMPLETED: &str = "COMPLETED";
pub const STATUS_DROPPED: &str = "DROPPED";
pub const STATUS_PAUSED: &str = "PAUSED";
pub const STATUS_REPEATING: &str = "REPEATING";
pub const VALID_STATUSES: [&str; 6] = [
    STATUS_CURRENT,
    STATUS_PLANNING,
    STATUS_COMPLETED,
    STATUS_DROPPED,
    STATUS_PAUSED,
    STATUS_REPEATING,
];

// ---------------------------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------------------------

/// Serializes tracker requests with a minimum spacing and waits out one `RateLimited` response.
pub struct RateLimiter {
    min_interval: Duration,
    last_request: tokio::sync::Mutex<Option<Instant>>,
}

impl RateLimiter {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_request: tokio::sync::Mutex::new(None),
        }
    }

    async fn wait_turn(&self) {
        let mut last = self.last_request.lock().await;
        if let Some(prev) = *last {
            let elapsed = prev.elapsed();
            if elapsed < self.min_interval {
                tokio::time::sleep(self.min_interval - elapsed).await;
            }
        }
        *last = Some(Instant::now());
    }

    /// Run `op` after waiting for our turn. On `RateLimited`, sleep `retry_after_secs` (capped at 90s)
    /// and retry exactly once.
    pub async fn run<T, F, Fut>(&self, mut op: F) -> Result<T, TrackerError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, TrackerError>>,
    {
        self.wait_turn().await;
        match op().await {
            Err(TrackerError::RateLimited { retry_after_secs }) => {
                let wait = retry_after_secs.clamp(1, MAX_RETRY_AFTER_SECS);
                log::warn!(target: "anilist", "rate limited, retrying in {}s", wait);
                tokio::time::sleep(Duration::from_secs(wait)).await;
                self.wait_turn().await;
                op().await
            }
            other => other,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Change model + pure normalization
// ---------------------------------------------------------------------------------------------

/// Where a user-state change came from. Scrobble/Step always get status derivation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ChangeSource {
    #[default]
    Manual,
    Step,
    Batch,
    Add,
    Scrobble,
}

/// A requested change to one entry's user state. `None` fields are left unchanged.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UserStateChange {
    pub anime_id: i64,
    pub status: Option<String>,
    /// Absolute progress (wins over `progress_delta`).
    pub progress: Option<u32>,
    pub progress_delta: Option<i32>,
    /// Set progress to the episode total (when known).
    pub mark_completed_progress: bool,
    /// 0..=100.
    pub score: Option<f64>,
    pub repeats: Option<u32>,
    pub notes: Option<String>,
    /// Append `notes` on a new line instead of replacing.
    pub notes_mode_append: bool,
    /// `Some("")` clears, `Some("YYYY-MM-DD")` sets.
    pub started_at: Option<String>,
    /// `Some("")` clears, `Some("YYYY-MM-DD")` sets.
    pub completed_at: Option<String>,
    /// `Some(None)` clears, `Some(Some(path))` sets.
    pub custom_folder: Option<Option<String>>,
    /// Replaces the synonym list.
    pub synonyms: Option<Vec<String>>,
    pub source: ChangeSource,
}

impl UserStateChange {
    pub fn new(anime_id: i64, source: ChangeSource) -> Self {
        Self {
            anime_id,
            source,
            ..Default::default()
        }
    }

    /// One entry's slice of a batch patch.
    pub fn from_batch_patch(patch: &BatchAnimeUpdatePatch, anime_id: i64) -> Self {
        Self {
            anime_id,
            status: patch.user_status.clone(),
            progress: patch.user_progress,
            progress_delta: patch.progress_delta,
            mark_completed_progress: patch.mark_completed_progress == Some(true),
            score: patch.user_score,
            repeats: patch.user_repeats,
            notes: patch.user_notes.clone(),
            notes_mode_append: patch.notes_mode.as_deref() == Some("append"),
            started_at: patch.user_started_at.clone(),
            completed_at: patch.user_completed_at.clone(),
            custom_folder: None,
            synonyms: None,
            source: ChangeSource::Batch,
        }
    }
}

fn is_valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

/// `None` = not provided, `Some(None)` = clear, `Some(Some(d))` = set.
fn parse_date_change(value: Option<&str>, field: &str) -> Result<Option<Option<String>>, String> {
    match value {
        None => Ok(None),
        Some(raw) => {
            let t = raw.trim();
            if t.is_empty() {
                Ok(Some(None))
            } else if is_valid_date(t) {
                Ok(Some(Some(t.to_string())))
            } else {
                Err(format!(
                    "Invalid {} date '{}': expected YYYY-MM-DD",
                    field, raw
                ))
            }
        }
    }
}

fn clean_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Validate a change and resolve the final user state. PURE (no I/O); `today` is `YYYY-MM-DD`.
///
/// Rules:
/// - status must be one of [`VALID_STATUSES`];
/// - progress = explicit or current + delta, clamped to `[0, episodes]` when the total is known;
///   `mark_completed_progress` sets it to the total; score is clamped to `0..=100`;
/// - dates must be `YYYY-MM-DD` (empty clears);
/// - when progress changes and the caller did not explicitly change the status (always for Scrobble/Step):
///   reaching the total → COMPLETED, else PLANNING with progress ≥ 1 → CURRENT;
/// - REPEATING → COMPLETED increments repeats (unless the caller changed repeats explicitly);
/// - an explicit date (one that differs from the stored value) always wins; otherwise the first watched
///   episode (0 → ≥1) sets an empty `started_at` to today, and entering COMPLETED sets `completed_at` to
///   today (and an empty `started_at` to today too).
pub fn normalize_change(
    current: &AnimeEntry,
    change: &UserStateChange,
    today: &str,
) -> Result<ResolvedState, String> {
    let requested_status = match &change.status {
        Some(s) => {
            let up = s.trim().to_ascii_uppercase();
            if !VALID_STATUSES.contains(&up.as_str()) {
                return Err(format!(
                    "Invalid list status '{}' (expected one of {})",
                    s,
                    VALID_STATUSES.join(", ")
                ));
            }
            Some(up)
        }
        None => None,
    };
    let started_req = parse_date_change(change.started_at.as_deref(), "start")?;
    let completed_req = parse_date_change(change.completed_at.as_deref(), "completion")?;
    if let Some(score) = change.score {
        if !score.is_finite() {
            return Err("Score must be a finite number".into());
        }
    }

    // Progress
    let total = current.episodes.filter(|&e| e > 0);
    let old_progress = current.user_progress;
    let mut progress: i64 = old_progress as i64;
    if let Some(p) = change.progress {
        progress = p as i64;
    } else if let Some(delta) = change.progress_delta {
        progress = old_progress as i64 + delta as i64;
    }
    if change.mark_completed_progress {
        if let Some(t) = total {
            progress = t as i64;
        }
    }
    progress = progress.max(0);
    if let Some(t) = total {
        progress = progress.min(t as i64);
    }
    let progress = progress.min(u32::MAX as i64) as u32;

    // Status
    let prev_status = current.user_status.as_str();
    let derives_always = matches!(change.source, ChangeSource::Scrobble | ChangeSource::Step);
    let status_explicit = !derives_always
        && requested_status
            .as_deref()
            .map_or(false, |s| s != prev_status);
    let mut status = requested_status.unwrap_or_else(|| prev_status.to_string());
    if !status_explicit && progress != old_progress {
        if total.map_or(false, |t| progress >= t) {
            status = STATUS_COMPLETED.to_string();
        } else if status == STATUS_PLANNING && progress >= 1 {
            status = STATUS_CURRENT.to_string();
        }
    }
    let entering_completed = status == STATUS_COMPLETED && prev_status != STATUS_COMPLETED;

    // Repeats
    let repeats_explicit = change
        .repeats
        .map_or(false, |r| r != current.user_repeats);
    let mut repeats = change.repeats.unwrap_or(current.user_repeats);
    if entering_completed && prev_status == STATUS_REPEATING && !repeats_explicit {
        repeats = repeats.saturating_add(1);
    }

    // Score / notes
    let score = change.score.unwrap_or(current.user_score).clamp(0.0, 100.0);
    let notes = match &change.notes {
        Some(new_text) if change.notes_mode_append => {
            let trimmed_new = new_text.trim();
            if trimmed_new.is_empty() {
                current.user_notes.clone()
            } else if current.user_notes.trim().is_empty() {
                trimmed_new.to_string()
            } else {
                format!("{}\n{}", current.user_notes.trim(), trimmed_new)
            }
        }
        Some(new_text) => new_text.clone(),
        None => current.user_notes.clone(),
    };

    // Dates
    let cur_started = clean_opt(current.user_started_at.as_deref());
    let cur_completed = clean_opt(current.user_completed_at.as_deref());
    let started_explicit = started_req.as_ref().map_or(false, |v| *v != cur_started);
    let completed_explicit = completed_req.as_ref().map_or(false, |v| *v != cur_completed);
    let mut started_at = match started_req {
        Some(v) if started_explicit => v,
        _ => cur_started,
    };
    let mut completed_at = match completed_req {
        Some(v) if completed_explicit => v,
        _ => cur_completed,
    };
    if !started_explicit && started_at.is_none() && old_progress == 0 && progress >= 1 {
        started_at = Some(today.to_string());
    }
    if entering_completed {
        if !completed_explicit {
            completed_at = Some(today.to_string());
        }
        if !started_explicit && started_at.is_none() {
            started_at = Some(today.to_string());
        }
    }

    let custom_folder = match &change.custom_folder {
        Some(v) => clean_opt(v.as_deref()),
        None => current.custom_folder.clone(),
    };

    Ok(ResolvedState {
        user_status: status,
        user_progress: progress,
        user_score: score,
        user_repeats: repeats,
        user_notes: notes,
        user_started_at: started_at,
        user_completed_at: completed_at,
        custom_folder,
        synonyms: change.synonyms.clone(),
    })
}

/// Local calendar date (`YYYY-MM-DD`) used for automatic start/completion dates.
pub fn today_string() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn has_token(settings: &AppSettings) -> bool {
    !settings.anilist_token.trim().is_empty()
}

/// Blocking: normalize + write one change. Rematches local episodes if folder/synonyms changed.
/// `sync_pending` only takes effect when a user field actually changed.
pub fn write_local_change(
    db: &Database,
    change: &UserStateChange,
    today: &str,
    sync_pending: bool,
) -> Result<AnimeEntry, String> {
    let current = db.get_anime_entry_by_id(change.anime_id)?;
    let st = normalize_change(&current, change, today)?;
    let (mut entry, needs_rematch) = db.update_anime_user_state(
        change.anime_id,
        &st.user_status,
        st.user_progress,
        st.user_score,
        st.user_repeats,
        &st.user_notes,
        st.custom_folder.clone(),
        st.synonyms.clone(),
        Some(st.user_started_at.clone().unwrap_or_default()),
        Some(st.user_completed_at.clone().unwrap_or_default()),
        sync_pending,
    )?;
    if needs_rematch {
        let _ = db.rematch_all_local_episodes();
        entry = db.get_anime_entry_by_id(change.anime_id)?;
    }
    if logs_manual_history(change.source) {
        db.record_manual_progress(&[(
            current.id,
            current.title_romaji.clone(),
            current.user_progress,
            st.user_progress,
        )])?;
    }
    Ok(entry)
}

/// Manual progress changes are logged to `watch_history` (scrobbles log themselves; adds are not watching).
fn logs_manual_history(source: ChangeSource) -> bool {
    matches!(source, ChangeSource::Manual | ChangeSource::Step | ChangeSource::Batch)
}

/// Blocking: normalize every id of a batch patch and write all states in one transaction.
/// Unknown ids are skipped; an invalid patch (bad status/date) rejects the whole batch.
pub fn write_batch_change(
    db: &Database,
    patch: &BatchAnimeUpdatePatch,
    today: &str,
    sync_pending: bool,
) -> Result<Vec<AnimeEntry>, String> {
    let mut states = Vec::with_capacity(patch.anime_ids.len());
    let mut progressed = Vec::new();
    for &id in &patch.anime_ids {
        let Ok(current) = db.get_anime_entry_by_id(id) else {
            continue;
        };
        let change = UserStateChange::from_batch_patch(patch, id);
        let st = normalize_change(&current, &change, today)?;
        if st.user_progress != current.user_progress {
            progressed.push((id, current.title_romaji.clone(), current.user_progress, st.user_progress));
        }
        states.push((id, st));
    }
    if db.write_resolved_states(&states, sync_pending)? {
        let _ = db.rematch_all_local_episodes();
    }
    db.record_manual_progress(&progressed)?;
    Ok(states
        .iter()
        .filter_map(|(id, _)| db.get_anime_entry_by_id(*id).ok())
        .collect())
}

// ---------------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------------

/// Result of a pull, sent as the `sync_tracker_list` result and the `tracker-list-synced` payload.
/// It is a delta: the frontend upserts `changed` and drops `removed_ids` instead of reloading the list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncSummary {
    pub added: usize,
    pub updated_from_remote: usize,
    pub kept_local: usize,
    pub deleted: usize,
    pub pushed: usize,
    pub push_failed: usize,
    pub remote_deleted: usize,
    pub deletion_skipped_reason: Option<String>,
    /// Entries inserted or whose stored row changed in this sync (full rows incl. local episodes).
    pub changed: Vec<AnimeEntry>,
    /// Local entry ids deleted because they are missing on the tracker.
    pub removed_ids: Vec<i64>,
    /// Custom list names or memberships changed; the frontend refetches `get_custom_lists`.
    pub custom_lists_changed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncStatus {
    pub in_progress: bool,
    pub last_synced_at: Option<i64>,
    pub pending_count: usize,
    pub pending_deletions: usize,
}

/// Result of [`TrackerSyncService::sign_in`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SignInOutcome {
    /// A different account than the list owner signed in; the previous account's list data was wiped.
    pub account_switched: bool,
    pub previous_user_id: Option<i64>,
    /// Unsent changes (pending entries + queued deletions) of the previous account that were dropped.
    pub discarded_changes: usize,
}

/// Result of [`TrackerSyncService::sign_out`], returned by the `sign_out_tracker` command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignOutOutcome {
    pub pushed: usize,
    pub deleted: usize,
    /// Changes still queued after the final flush; they are sent when the same account signs in again.
    pub unsent: usize,
    pub settings: AppSettings,
}

#[derive(Debug, Default)]
struct FlushOutcome {
    succeeded: usize,
    failed: usize,
    /// Set when the token was rejected; flushing stops at the first such error.
    auth_error: Option<TrackerError>,
}

struct PullFailure {
    error: TrackerError,
    /// `tracker-auth-invalid` was already emitted (from a per-entry error).
    auth_reported: bool,
}

struct InProgressGuard<'a>(&'a AtomicBool);

impl Drop for InProgressGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

/// A custom-list change sent to the tracker immediately (see `TrackerSyncService::edit_custom_lists`).
enum ListEdit {
    Create(String),
    Delete(String),
}

pub struct TrackerSyncService {
    db: Arc<Database>,
    plugins: Arc<PluginManager>,
    emit: SyncEmitter,
    active_session: Arc<Mutex<Option<DetectedMediaSession>>>,
    /// Serializes everything that talks to the tracker (pushes, deletion flushes, pulls).
    op_lock: tokio::sync::Mutex<()>,
    limiter: RateLimiter,
    in_progress: AtomicBool,
    last_synced_at: Mutex<Option<i64>>,
}

impl TrackerSyncService {
    pub fn new(
        db: Arc<Database>,
        plugins: Arc<PluginManager>,
        emit: SyncEmitter,
        active_session: Arc<Mutex<Option<DetectedMediaSession>>>,
    ) -> Self {
        Self {
            db,
            plugins,
            emit,
            active_session,
            op_lock: tokio::sync::Mutex::new(()),
            limiter: RateLimiter::new(MIN_REQUEST_INTERVAL),
            in_progress: AtomicBool::new(false),
            last_synced_at: Mutex::new(None),
        }
    }

    /// Override the minimum spacing between tracker requests (tests).
    pub fn with_min_request_interval(mut self, interval: Duration) -> Self {
        self.limiter = RateLimiter::new(interval);
        self
    }

    async fn blocking<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Database) -> Result<T, String> + Send + 'static,
        T: Send + 'static,
    {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || f(&db))
            .await
            .map_err(|e| e.to_string())?
    }

    async fn current_token(&self) -> Result<Option<String>, String> {
        let settings = self.blocking(|db| db.get_settings()).await?;
        let tok = settings.anilist_token.trim().to_string();
        Ok(if tok.is_empty() { None } else { Some(tok) })
    }

    fn plugin(&self) -> Result<Arc<dyn TrackerPlugin>, TrackerError> {
        self.plugins
            .get(TRACKER_PLUGIN_ID)
            .ok_or_else(|| TrackerError::Api("AniList tracker plugin is not registered".into()))
    }

    fn emit(&self, event: &str, payload: Value) {
        (self.emit)(event, payload);
    }

    fn emit_entry_error(
        &self,
        anime_id: Option<i64>,
        media_id: Option<i64>,
        title: &str,
        err: &TrackerError,
        operation: &str,
    ) {
        log::warn!(
            target: "sync",
            "{} of {:?} (anime {:?}, media {:?}) failed: {}",
            operation,
            title,
            anime_id,
            media_id,
            err
        );
        self.emit(
            EVENT_SYNC_ERROR,
            json!({
                "anime_id": anime_id,
                "media_id": media_id,
                "title": title,
                "kind": err.kind(),
                "message": err.to_string(),
                "operation": operation,
            }),
        );
        if matches!(err, TrackerError::Unauthorized(_)) {
            self.emit(EVENT_AUTH_INVALID, json!({ "message": err.to_string() }));
        }
    }

    /// Mirror updated entries into the active playback session. Locks `active_session` briefly:
    /// callers must NOT hold that lock when calling any service method.
    fn sync_active_session(&self, entries: &[AnimeEntry]) {
        if let Ok(mut guard) = self.active_session.lock() {
            if let Some(session) = guard.as_mut() {
                if let Some(matched) = session.matched_anime_id {
                    if let Some(e) = entries.iter().find(|e| e.id == matched) {
                        session.matched_current_progress = Some(e.user_progress);
                        session.matched_total_episodes = e.episodes;
                    }
                }
            }
        }
    }

    fn unmatch_active_session(&self, deleted_ids: &[i64]) {
        if let Ok(mut guard) = self.active_session.lock() {
            if let Some(session) = guard.as_mut() {
                if session
                    .matched_anime_id
                    .map_or(false, |id| deleted_ids.contains(&id))
                {
                    session.matched_anime_id = None;
                    session.matched_anime_title = None;
                    session.matched_cover_image = None;
                    session.matched_current_progress = None;
                    session.matched_total_episodes = None;
                    let detected_at = session.detected_at_unix;
                    session.restart_countdown(detected_at);
                }
            }
        }
    }

    // ----------------------------------------------------------------- local mutations (push)

    /// Apply one user-state change locally (always queued) and, when signed in, push it to AniList in the
    /// background. Returns the updated entry immediately. Callers must not hold the `active_session` lock.
    pub async fn apply_local_update(
        self: &Arc<Self>,
        change: UserStateChange,
    ) -> Result<AnimeEntry, String> {
        self.apply_local_update_with_history(change, None).await
    }

    /// Like [`apply_local_update`](Self::apply_local_update); on a successful push the given
    /// `watch_history` row is marked as scrobbled (used by the auto-scrobbler).
    pub async fn apply_local_update_with_history(
        self: &Arc<Self>,
        change: UserStateChange,
        history_id: Option<i64>,
    ) -> Result<AnimeEntry, String> {
        let today = today_string();
        let (entry, signed_in) = self
            .blocking(move |db| {
                let signed_in = has_token(&db.get_settings()?);
                let entry = write_local_change(db, &change, &today, true)?;
                Ok((entry, signed_in))
            })
            .await?;

        self.sync_active_session(std::slice::from_ref(&entry));

        if signed_in && entry.sync_pending && entry.anilist_id.is_some() {
            let this = Arc::clone(self);
            let id = entry.id;
            tokio::spawn(async move {
                this.push_entry_with_history(id, history_id).await;
            });
        }
        Ok(entry)
    }

    /// Apply a batch patch (all ids in one transaction), then push the changed entries sequentially.
    pub async fn apply_batch(
        self: &Arc<Self>,
        patch: BatchAnimeUpdatePatch,
    ) -> Result<Vec<AnimeEntry>, String> {
        let today = today_string();
        let (entries, signed_in) = self
            .blocking(move |db| {
                let signed_in = has_token(&db.get_settings()?);
                let entries = write_batch_change(db, &patch, &today, true)?;
                Ok((entries, signed_in))
            })
            .await?;

        self.sync_active_session(&entries);

        if signed_in {
            let ids: Vec<i64> = entries
                .iter()
                .filter(|e| e.sync_pending && e.anilist_id.is_some())
                .map(|e| e.id)
                .collect();
            if !ids.is_empty() {
                let this = Arc::clone(self);
                tokio::spawn(async move {
                    for id in ids {
                        this.push_entry(id).await;
                    }
                });
            }
        }
        Ok(entries)
    }

    /// Add entries to / remove them from custom lists, or toggle "hidden from status lists". Changed entries
    /// are queued like any edit (`sync_pending` + a dirty membership row) and pushed in the background when
    /// signed in. Returns the full custom-list state.
    pub async fn set_custom_lists(
        self: &Arc<Self>,
        change: CustomListChange,
    ) -> Result<CustomListsState, String> {
        let now = chrono::Utc::now().timestamp();
        let (state, ids, signed_in) = self
            .blocking(move |db| {
                let signed_in = has_token(&db.get_settings()?);
                let ids = db.apply_custom_list_change(&change, now)?;
                Ok((db.get_custom_lists()?, ids, signed_in))
            })
            .await?;

        if signed_in && !ids.is_empty() {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                for id in ids {
                    this.push_entry(id).await;
                }
            });
        }
        Ok(state)
    }

    /// Create a custom list on AniList right away (signed in only; never queued) and store the
    /// tracker's resulting list names. Renaming lists stays on AniList. Returns the full
    /// custom-list state.
    pub async fn create_custom_list(&self, name: String) -> Result<CustomListsState, String> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("List name can't be empty".into());
        }
        self.edit_custom_lists(ListEdit::Create(name)).await
    }

    /// Delete a custom list on AniList right away (signed in only; never queued). Its entries stay
    /// on the list; their membership in it is dropped locally too. Returns the full custom-list state.
    pub async fn delete_custom_list(&self, name: String) -> Result<CustomListsState, String> {
        self.edit_custom_lists(ListEdit::Delete(name)).await
    }

    /// Shared create / delete flow: validate against the local names, require a signed-in token whose
    /// account owns the local list (same guard as pulls), call the tracker through the rate limiter and
    /// store its resulting names.
    async fn edit_custom_lists(&self, edit: ListEdit) -> Result<CustomListsState, String> {
        let _op = self.op_lock.lock().await;
        let (settings, owner, local) = self
            .blocking(|db| Ok((db.get_settings()?, db.list_owner()?, db.get_custom_lists()?.names)))
            .await?;
        match &edit {
            ListEdit::Create(name) if local.iter().any(|n| n.trim().eq_ignore_ascii_case(name)) => {
                return Err(format!("A list named \"{}\" already exists", name));
            }
            ListEdit::Delete(name) if !local.contains(name) => {
                return Err(format!("There is no list named \"{}\"", name));
            }
            _ => {}
        }
        let token = settings.anilist_token.trim().to_string();
        if token.is_empty() {
            return Err("Sign in to AniList to edit custom lists".into());
        }
        let plugin = self.plugin()?;
        let viewer = plugin.viewer_id(&token).await?;
        if [settings.anilist_user_id, owner].into_iter().flatten().any(|id| id != viewer) {
            return Err("The signed-in AniList account doesn't own this list; sign in again".into());
        }
        let names = match self
            .limiter
            .run(|| match &edit {
                ListEdit::Create(name) => plugin.create_custom_list(&token, name),
                ListEdit::Delete(name) => plugin.delete_custom_list(&token, name),
            })
            .await
        {
            Ok(names) => names,
            Err(e) => {
                if matches!(e, TrackerError::Unauthorized(_)) {
                    self.emit(EVENT_AUTH_INVALID, json!({ "message": e.to_string() }));
                }
                return Err(e.to_string());
            }
        };
        self.blocking(move |db| {
            db.set_custom_list_names(&names)?;
            db.get_custom_lists()
        })
        .await
    }

    /// Add an anime (e.g. from Discover). Requires an AniList id. If it is already in the list, its user
    /// state is kept and only metadata is refreshed (no push). Otherwise it is inserted with normalized
    /// status/dates and pushed. Returns the stored entry.
    pub async fn add_entry(self: &Arc<Self>, entry: AnimeEntry) -> Result<AnimeEntry, String> {
        let media_id = entry
            .anilist_id
            .ok_or_else(|| "Cannot add an anime without an AniList id".to_string())?;
        let today = today_string();
        let (stored, push_id) = self
            .blocking(move |db| {
                let signed_in = has_token(&db.get_settings()?);
                let mut entry = entry;
                let push_id = if let Some(existing_id) = db.find_entry_id_by_anilist_id(media_id)? {
                    entry.id = existing_id;
                    db.refresh_entry_metadata(&entry)?;
                    None
                } else {
                    entry.id = media_id;
                    let mut base = entry.clone();
                    base.user_status = STATUS_PLANNING.into();
                    base.user_progress = 0;
                    base.user_score = 0.0;
                    base.user_repeats = 0;
                    base.user_notes = String::new();
                    base.user_started_at = None;
                    base.user_completed_at = None;
                    let change = UserStateChange {
                        anime_id: media_id,
                        status: Some(entry.user_status.clone()),
                        progress: Some(entry.user_progress),
                        score: Some(entry.user_score),
                        repeats: Some(entry.user_repeats),
                        notes: Some(entry.user_notes.clone()),
                        started_at: entry.user_started_at.clone(),
                        completed_at: entry.user_completed_at.clone(),
                        source: ChangeSource::Add,
                        ..Default::default()
                    };
                    let st = normalize_change(&base, &change, &today)?;
                    entry.user_status = st.user_status;
                    entry.user_progress = st.user_progress;
                    entry.user_score = st.user_score;
                    entry.user_repeats = st.user_repeats;
                    entry.user_notes = st.user_notes;
                    entry.user_started_at = st.user_started_at;
                    entry.user_completed_at = st.user_completed_at;
                    entry.updated_at = chrono::Utc::now().timestamp();
                    entry.sync_pending = true;
                    db.upsert_anime_entry(&entry)?;
                    if signed_in {
                        Some(media_id)
                    } else {
                        None
                    }
                };
                let id = entry.id;
                let _ = db.match_unmatched_episodes_for_anime(id);
                Ok((db.get_anime_entry_by_id(id)?, push_id))
            })
            .await?;

        if let Some(id) = push_id {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                this.push_entry(id).await;
            });
        }
        Ok(stored)
    }

    /// Delete entries locally right away. A tombstone per entry queues the AniList delete (flushed in the
    /// background now when signed in, otherwise on the next pull).
    pub async fn delete_entries(self: &Arc<Self>, ids: Vec<i64>) -> Result<(), String> {
        let deleted_ids = ids.clone();
        let queued = self
            .blocking(move |db| {
                let signed_in = has_token(&db.get_settings()?);
                let queued = !db.delete_entries_with_tombstones(&ids)?.is_empty();
                Ok(queued && signed_in)
            })
            .await?;

        self.unmatch_active_session(&deleted_ids);

        if queued {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                let _ = this.flush_deletions().await;
            });
        }
        Ok(())
    }

    // ----------------------------------------------------------------- tracker I/O

    /// Push one entry's current state to AniList. Returns `true` if a save succeeded.
    /// Skips entries that are gone or no longer pending (already pushed by an earlier call).
    pub async fn push_entry(&self, anime_id: i64) -> bool {
        self.push_entry_with_history(anime_id, None).await
    }

    /// [`push_entry`](Self::push_entry) that also marks `history_id` as scrobbled once the state is on AniList.
    pub async fn push_entry_with_history(&self, anime_id: i64, history_id: Option<i64>) -> bool {
        let _op = self.op_lock.lock().await;
        let Ok(Some(token)) = self.current_token().await else {
            return false;
        };
        matches!(
            self.push_entry_inner(anime_id, history_id, &token).await,
            Ok(true)
        )
    }

    /// `Ok(true)` pushed, `Ok(false)` nothing to do, `Err` failed (already reported via events).
    async fn push_entry_inner(
        &self,
        anime_id: i64,
        history_id: Option<i64>,
        token: &str,
    ) -> Result<bool, TrackerError> {
        let Ok((entry, dirty_lists)) = self
            .blocking(move |db| {
                Ok((
                    db.get_anime_entry_by_id(anime_id)?,
                    db.dirty_custom_lists(anime_id)?,
                ))
            })
            .await
        else {
            return Ok(false);
        };

        if !entry.sync_pending {
            if let Some(h) = history_id {
                let _ = self
                    .blocking(move |db| db.mark_watch_history_scrobbled(h))
                    .await;
            }
            return Ok(false);
        }
        let Some(media_id) = entry.anilist_id else {
            let _ = self
                .blocking(move |db| db.set_sync_result(anime_id, false, None, None))
                .await;
            return Ok(false);
        };

        let update = TrackerEntryUpdate {
            media_id,
            status: entry.user_status.clone(),
            progress: entry.user_progress,
            score: entry.user_score,
            repeat: entry.user_repeats,
            notes: entry.user_notes.clone(),
            started_at: clean_opt(entry.user_started_at.as_deref()),
            completed_at: clean_opt(entry.user_completed_at.as_deref()),
            // Membership is only sent with an unsent local edit, so AniList's stays authoritative otherwise
            custom_lists: dirty_lists.as_ref().map(|m| m.lists.clone()),
            hidden_from_status_lists: dirty_lists.as_ref().map(|m| m.hidden_from_status_lists),
        };

        let result = match self.plugin() {
            Ok(plugin) => {
                self.limiter
                    .run(|| plugin.save_list_entry(token, &update))
                    .await
            }
            Err(e) => Err(e),
        };

        match result {
            Ok(remote) => {
                let pushed = entry.clone();
                let refreshed = self
                    .blocking(move |db| {
                        db.finish_push(
                            &pushed,
                            remote.updated_at,
                            remote.list_entry_id,
                            dirty_lists.as_ref(),
                        )?;
                        if let Some(h) = history_id {
                            db.mark_watch_history_scrobbled(h)?;
                        }
                        db.get_anime_entry_by_id(anime_id)
                    })
                    .await;
                if let Ok(updated) = refreshed {
                    self.emit(EVENT_ENTRY_SYNCED, json!({ "entry": updated }));
                }
                Ok(true)
            }
            Err(err) => {
                let _ = self
                    .blocking(move |db| db.set_sync_result(anime_id, true, None, None))
                    .await;
                self.emit_entry_error(
                    Some(anime_id),
                    Some(media_id),
                    &entry.title_romaji,
                    &err,
                    "save",
                );
                Err(err)
            }
        }
    }

    async fn flush_pending_inner(&self, token: &str) -> FlushOutcome {
        let mut out = FlushOutcome::default();
        let ids = match self.blocking(|db| db.list_pending_sync_ids()).await {
            Ok(ids) => ids,
            Err(_) => return out,
        };
        let total = ids.len();
        for (i, id) in ids.into_iter().enumerate() {
            match self.push_entry_inner(id, None, token).await {
                Ok(true) => out.succeeded += 1,
                Ok(false) => {}
                Err(e @ TrackerError::Unauthorized(_)) => {
                    out.failed += total - i;
                    out.auth_error = Some(e);
                    break;
                }
                Err(_) => out.failed += 1,
            }
        }
        out
    }

    async fn flush_deletions_inner(&self, token: &str) -> FlushOutcome {
        let mut out = FlushOutcome::default();
        let tombstones = match self.blocking(|db| db.list_pending_deletions()).await {
            Ok(t) => t,
            Err(_) => return out,
        };
        if tombstones.is_empty() {
            return out;
        }
        let plugin = match self.plugin() {
            Ok(p) => p,
            Err(e) => {
                out.failed = tombstones.len();
                for t in &tombstones {
                    self.emit_entry_error(None, Some(t.media_id), &t.title, &e, "delete");
                }
                return out;
            }
        };
        let total = tombstones.len();
        for (i, t) in tombstones.into_iter().enumerate() {
            let res = self
                .limiter
                .run(|| plugin.delete_list_entry(token, t.media_id, t.list_entry_id))
                .await;
            match res {
                Ok(()) => {
                    let media_id = t.media_id;
                    let _ = self
                        .blocking(move |db| db.remove_pending_deletion(media_id))
                        .await;
                    out.succeeded += 1;
                }
                Err(err) => {
                    self.emit_entry_error(None, Some(t.media_id), &t.title, &err, "delete");
                    if matches!(err, TrackerError::Unauthorized(_)) {
                        out.failed += total - i;
                        out.auth_error = Some(err);
                        break;
                    }
                    out.failed += 1;
                }
            }
        }
        out
    }

    /// Retry every entry with `sync_pending`. Returns `(pushed, failed)`.
    pub async fn flush_pending(&self) -> Result<(usize, usize), String> {
        let _op = self.op_lock.lock().await;
        let token = self
            .current_token()
            .await?
            .ok_or_else(|| "Not signed in to AniList".to_string())?;
        let out = self.flush_pending_inner(&token).await;
        Ok((out.succeeded, out.failed))
    }

    /// Retry every queued AniList deletion (tombstone). Returns `(deleted, failed)`.
    pub async fn flush_deletions(&self) -> Result<(usize, usize), String> {
        let _op = self.op_lock.lock().await;
        let token = self
            .current_token()
            .await?
            .ok_or_else(|| "Not signed in to AniList".to_string())?;
        let out = self.flush_deletions_inner(&token).await;
        Ok((out.succeeded, out.failed))
    }

    /// Adopt a verified AniList account and save its token/profile. If the list has no owner yet or belongs
    /// to this account, the local list and its queued changes are kept (the next pull sends them). A
    /// different account wipes the previous account's list data ([`Database::reset_for_account_switch`]),
    /// clears the playback match and emits `tracker-account-switched`. Callers run `pull("post_auth")` after.
    pub async fn sign_in(
        &self,
        token: &str,
        profile: &TrackerUserProfile,
    ) -> Result<SignInOutcome, String> {
        let _op = self.op_lock.lock().await;
        let token = token.trim().to_string();
        if token.is_empty() {
            return Err("AniList sign-in requires an OAuth access token".into());
        }
        let p = profile.clone();
        let outcome = self
            .blocking(move |db| {
                let previous = db.list_owner()?;
                let mut outcome = SignInOutcome {
                    previous_user_id: previous,
                    ..Default::default()
                };
                match previous {
                    Some(owner) if owner != p.user_id => {
                        outcome.account_switched = true;
                        outcome.discarded_changes = db.reset_for_account_switch(p.user_id)?;
                    }
                    Some(_) => {}
                    None => db.set_list_owner(p.user_id)?,
                }
                let mut settings = db.get_settings()?;
                settings.active_tracker_plugin = TRACKER_PLUGIN_ID.into();
                settings.anilist_username = p.username.clone();
                settings.anilist_user_id = Some(p.user_id);
                settings.anilist_avatar = p.avatar_url.clone();
                settings.anilist_token = token;
                db.save_settings(&settings)?;
                Ok(outcome)
            })
            .await?;

        if outcome.account_switched {
            log::info!(
                target: "sync",
                "signed in as a different AniList account ({:?} -> {}): local list reset",
                outcome.previous_user_id,
                profile.user_id
            );
            if let Ok(mut last) = self.last_synced_at.lock() {
                *last = None;
            }
            let matched = self
                .active_session
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().and_then(|s| s.matched_anime_id));
            if let Some(id) = matched {
                self.unmatch_active_session(&[id]);
            }
            self.emit(
                EVENT_ACCOUNT_SWITCHED,
                json!({
                    "previous_user_id": outcome.previous_user_id,
                    "user_id": profile.user_id,
                    "username": profile.username,
                    "discarded_changes": outcome.discarded_changes,
                }),
            );
        }
        Ok(outcome)
    }

    /// Send queued deletions and changes one last time, then clear the token and profile. The list and its
    /// owner stay, so anything that could not be sent goes out when the same account signs in again.
    pub async fn sign_out(&self) -> Result<SignOutOutcome, String> {
        let _op = self.op_lock.lock().await;
        let (mut pushed, mut deleted) = (0, 0);
        if let Some(token) = self.current_token().await? {
            let deletions = self.flush_deletions_inner(&token).await;
            deleted = deletions.succeeded;
            if deletions.auth_error.is_none() {
                pushed = self.flush_pending_inner(&token).await.succeeded;
            }
        }
        let (unsent, settings) = self
            .blocking(|db| {
                let unsent = db.count_pending()? + db.count_pending_deletions()?;
                let mut settings = db.get_settings()?;
                settings.anilist_username.clear();
                settings.anilist_token.clear();
                settings.anilist_user_id = None;
                settings.anilist_avatar = None;
                db.save_settings(&settings)?;
                Ok((unsent, db.get_settings()?))
            })
            .await?;
        Ok(SignOutOutcome {
            pushed,
            deleted,
            unsent,
            settings,
        })
    }

    /// Full two-way sync: flush queued deletions and pushes, fetch the AniList list and merge it
    /// (newest wins; remote-missing entries are deleted unless pending). Only changed rows are written and
    /// returned (delta). Local files are matched afterwards in the background, and only for new entries or
    /// entries whose titles changed (`library-changed` is emitted if anything matched).
    /// Never runs two pulls at once: a pull requested while one is running waits for it and returns an
    /// empty delta (the running pull's `tracker-list-synced` event carries the changes).
    pub async fn pull(&self, reason: &str) -> Result<SyncSummary, String> {
        let settings = self.blocking(|db| db.get_settings()).await?;
        let token = settings.anilist_token.trim().to_string();
        if token.is_empty() {
            return Err("Not signed in to AniList".into());
        }

        if self
            .in_progress
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            let _op = self.op_lock.lock().await;
            return Ok(SyncSummary::default());
        }
        let progress_guard = InProgressGuard(&self.in_progress);
        self.emit(EVENT_SYNC_STARTED, json!({ "reason": reason }));

        let op = self.op_lock.lock().await;
        // Re-read under the lock: a sign-in may have switched the account while this pull was waiting.
        let result = match self
            .blocking(|db| Ok((db.get_settings()?, db.list_owner()?)))
            .await
        {
            Ok((settings, owner)) if !settings.anilist_token.trim().is_empty() => {
                self.pull_inner(
                    settings.anilist_token.trim(),
                    owner,
                    settings.anilist_user_id,
                    reason,
                )
                .await
            }
            Ok(_) => Err(PullFailure {
                error: TrackerError::Unauthorized("Not signed in to AniList".into()),
                auth_reported: true,
            }),
            Err(m) => Err(PullFailure {
                error: TrackerError::Api(m),
                auth_reported: false,
            }),
        };
        drop(op);
        drop(progress_guard);

        match result {
            Ok((summary, rematch_ids)) => {
                if let Ok(mut last) = self.last_synced_at.lock() {
                    *last = Some(chrono::Utc::now().timestamp());
                }
                self.emit(
                    EVENT_LIST_SYNCED,
                    serde_json::to_value(&summary).unwrap_or(Value::Null),
                );
                self.spawn_targeted_matching(rematch_ids);
                Ok(summary)
            }
            Err(PullFailure {
                error,
                auth_reported,
            }) => {
                let message = error.to_string();
                log::warn!(target: "sync", "pull({}) failed: {}", reason, message);
                self.emit(
                    EVENT_SYNC_FAILED,
                    json!({ "reason": reason, "message": message }),
                );
                if matches!(error, TrackerError::Unauthorized(_)) && !auth_reported {
                    self.emit(EVENT_AUTH_INVALID, json!({ "message": message }));
                }
                Err(message)
            }
        }
    }

    /// Returns the delta summary plus the ids whose local files should be matched in the background.
    /// `owner` is the account the local list belongs to and `signed_in_user` the stored account of `token`
    /// (both set by [`sign_in`](Self::sign_in)). The token's real account is resolved first; if it differs
    /// from either, the local list must never reach it, so the pull stops before flushing or merging.
    async fn pull_inner(
        &self,
        token: &str,
        owner: Option<i64>,
        signed_in_user: Option<i64>,
        reason: &str,
    ) -> Result<(SyncSummary, Vec<i64>), PullFailure> {
        let started = Instant::now();
        let mismatch = |viewer: i64, owner: i64| PullFailure {
            error: TrackerError::Api(format!(
                "The local list belongs to AniList user {} but the signed-in account is {}; sign in again to switch accounts",
                owner, viewer
            )),
            auth_reported: false,
        };
        let plugin = self.plugin().map_err(|error| PullFailure {
            error,
            auth_reported: false,
        })?;
        // Resolve the token's account BEFORE anything is sent with it (cached per token by the plugin).
        let viewer = plugin.viewer_id(token).await.map_err(|error| PullFailure {
            error,
            auth_reported: false,
        })?;
        for expected in [signed_in_user, owner].into_iter().flatten() {
            if expected != viewer {
                return Err(mismatch(viewer, expected));
            }
        }
        if owner.is_none() {
            // A list from before owner tracking (or never signed in): it now belongs to this account.
            self.blocking(move |db| db.set_list_owner(viewer))
                .await
                .map_err(|m| PullFailure {
                    error: TrackerError::Api(m),
                    auth_reported: false,
                })?;
        }

        let phase = Instant::now();
        let deletions = self.flush_deletions_inner(token).await;
        let flush_del_ms = phase.elapsed().as_millis();
        if let Some(error) = deletions.auth_error {
            return Err(PullFailure {
                error,
                auth_reported: true,
            });
        }
        let phase = Instant::now();
        let pushes = self.flush_pending_inner(token).await;
        let flush_push_ms = phase.elapsed().as_millis();
        if let Some(error) = pushes.auth_error {
            return Err(PullFailure {
                error,
                auth_reported: true,
            });
        }

        let phase = Instant::now();
        let snapshot = self
            .limiter
            .run(|| plugin.fetch_user_list(token))
            .await
            .map_err(|error| PullFailure {
                error,
                auth_reported: false,
            })?;
        let fetch_ms = phase.elapsed().as_millis();
        let fetched = snapshot.entries.len();

        if snapshot.viewer_id != viewer {
            return Err(mismatch(snapshot.viewer_id, viewer));
        }

        let remote_entries = snapshot.entries;
        let custom_list_names = snapshot.custom_lists;
        let memberships = snapshot.memberships;
        let phase = Instant::now();
        let (stats, custom_lists_changed) = self
            .blocking(move |db| {
                let skip: HashSet<i64> = db
                    .list_pending_deletions()?
                    .into_iter()
                    .map(|t| t.media_id)
                    .collect();
                let stats = db.merge_remote_list(&remote_entries, &skip, true)?;
                // Same guard as entry deletions: an empty remote list never wipes local memberships
                let lists_changed = !remote_entries.is_empty()
                    && db.merge_remote_custom_lists(&custom_list_names, &memberships)?;
                Ok((stats, lists_changed))
            })
            .await
            .map_err(|m| PullFailure {
                error: TrackerError::Api(format!("Failed to merge AniList list: {}", m)),
                auth_reported: false,
            })?;
        let merge_ms = phase.elapsed().as_millis();

        // Heavy metadata (synopsis, genres, studios, …) only for entries new to the local list.
        // Best effort: a failure leaves the light metadata in place and never fails the sync.
        let phase = Instant::now();
        let mut details_written = 0usize;
        if !stats.new_ids.is_empty() {
            let mut details: Vec<AnimeEntry> = Vec::with_capacity(stats.new_ids.len());
            for chunk in stats.new_ids.chunks(MEDIA_DETAILS_CHUNK) {
                match self
                    .limiter
                    .run(|| plugin.fetch_media_details(chunk))
                    .await
                {
                    Ok(mut part) => details.append(&mut part),
                    Err(e) => {
                        log::warn!(
                            target: "sync",
                            "fetching details for {} new entries failed: {}",
                            stats.new_ids.len(),
                            e
                        );
                        break;
                    }
                }
            }
            let new_set: HashSet<i64> = stats.new_ids.iter().copied().collect();
            details.retain(|d| new_set.contains(&d.id));
            if !details.is_empty() {
                match self
                    .blocking(move |db| db.refresh_existing_entries_metadata(&details))
                    .await
                {
                    Ok(n) => details_written = n,
                    Err(e) => log::warn!(target: "sync", "writing details for new entries failed: {}", e),
                }
            }
        }
        let details_ms = phase.elapsed().as_millis();

        let phase = Instant::now();
        let changed_ids = stats.changed_ids.clone();
        let changed = self
            .blocking(move |db| db.get_anime_entries_by_ids(&changed_ids))
            .await
            .map_err(|m| PullFailure {
                error: TrackerError::Api(format!("Failed to load synced entries: {}", m)),
                auth_reported: false,
            })?;
        let delta_ms = phase.elapsed().as_millis();

        self.sync_active_session(&changed);
        self.unmatch_active_session(&stats.removed_ids);

        log::info!(
            target: "sync",
            "pull({}): flush-del {}ms ({}/{}) · flush-push {}ms ({}/{}) · fetch {}ms ({} entries) · merge {}ms (+{} ~{} -{}, {} kept, {} rematch) · details {}ms ({}/{}) · delta {}ms ({}) · total {}ms",
            reason,
            flush_del_ms,
            deletions.succeeded,
            deletions.failed,
            flush_push_ms,
            pushes.succeeded,
            pushes.failed,
            fetch_ms,
            fetched,
            merge_ms,
            stats.added,
            stats.changed_ids.len().saturating_sub(stats.added),
            stats.deleted,
            stats.kept_local,
            stats.rematch_ids.len(),
            details_ms,
            details_written,
            stats.new_ids.len(),
            delta_ms,
            changed.len(),
            started.elapsed().as_millis(),
        );

        let summary = SyncSummary {
            added: stats.added,
            updated_from_remote: stats.updated_from_remote,
            kept_local: stats.kept_local,
            deleted: stats.deleted,
            pushed: pushes.succeeded,
            push_failed: pushes.failed,
            remote_deleted: deletions.succeeded,
            deletion_skipped_reason: stats.deletion_skipped_reason,
            changed,
            removed_ids: stats.removed_ids,
            custom_lists_changed,
        };
        Ok((summary, stats.rematch_ids))
    }

    /// Match still-unmatched local files against `ids` (new entries / changed titles) in the background.
    /// Already matched files are never touched. Emits `library-changed` when something was bound.
    fn spawn_targeted_matching(&self, ids: Vec<i64>) {
        if ids.is_empty() {
            return;
        }
        let db = self.db.clone();
        let emit = self.emit.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let count = ids.len();
            let targets = ids.clone();
            let result =
                tokio::task::spawn_blocking(move || db.match_unmatched_episodes_for_ids(&targets)).await;
            match result {
                Ok(Ok(matched)) => {
                    log::info!(
                        target: "sync",
                        "matched {} local files for {} entries in {}ms",
                        matched,
                        count,
                        started.elapsed().as_millis()
                    );
                    if matched > 0 {
                        let summary = ScanSummary {
                            matched_files: matched,
                            elapsed_ms: started.elapsed().as_millis(),
                            changed_anime_ids: ids,
                            ..Default::default()
                        };
                        emit(
                            EVENT_LIBRARY_CHANGED,
                            serde_json::to_value(&summary).unwrap_or(Value::Null),
                        );
                    }
                }
                Ok(Err(e)) => log::warn!(target: "sync", "matching local files after sync failed: {}", e),
                Err(e) => log::error!(target: "sync", "matching task panicked: {}", e),
            }
        });
    }

    /// Current sync state. Does two quick COUNT queries on the DB connection.
    pub fn status(&self) -> SyncStatus {
        SyncStatus {
            in_progress: self.in_progress.load(Ordering::SeqCst),
            last_synced_at: self.last_synced_at.lock().ok().and_then(|g| *g),
            pending_count: self.db.count_pending().unwrap_or(0),
            pending_deletions: self.db.count_pending_deletions().unwrap_or(0),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Seasonal browsing (public data, snapshot per season in `seasonal_cache`)
// ---------------------------------------------------------------------------------------------

pub const SEASON_NAMES: [&str; 4] = ["WINTER", "SPRING", "SUMMER", "FALL"];
/// Current / upcoming seasons are refetched after this long; past seasons only on demand.
const SEASON_STALE_AFTER_SECS: i64 = 24 * 60 * 60;
/// Safety cap on pages per season (50 media each).
const MAX_SEASON_PAGES: u32 = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeasonResult {
    pub season: String,
    pub year: u32,
    pub fetched_at: i64,
    pub items: Vec<SeasonalAnime>,
    pub from_cache: bool,
    /// Served from cache, but old enough that the caller should refresh in the background.
    pub stale: bool,
}

/// Monotonic index (`year * 4 + quarter`) used to compare seasons. `None` for unknown names.
pub fn season_index(season: &str, year: u32) -> Option<u32> {
    let quarter = SEASON_NAMES
        .iter()
        .position(|s| s.eq_ignore_ascii_case(season))?;
    Some(year * 4 + quarter as u32)
}

/// Broadcast season containing `month` (1–12): Jan–Mar Winter, Apr–Jun Spring, Jul–Sep Summer, Oct–Dec Fall.
pub fn current_season(year: u32, month: u32) -> (&'static str, u32) {
    (SEASON_NAMES[((month.clamp(1, 12) - 1) / 3) as usize], year)
}

/// `true` when `season`/`year` ended before the season containing `today_year`/`today_month` started.
pub fn season_is_past(season: &str, year: u32, today_year: u32, today_month: u32) -> bool {
    let (cur, cur_year) = current_season(today_year, today_month);
    match (season_index(season, year), season_index(cur, cur_year)) {
        (Some(s), Some(c)) => s < c,
        _ => false,
    }
}

pub fn season_cache_is_stale(past: bool, fetched_at: i64, now: i64) -> bool {
    !past && now - fetched_at > SEASON_STALE_AFTER_SECS
}

impl TrackerSyncService {
    /// Every anime of a season. Serves the cached snapshot unless `force_refresh` or none exists;
    /// otherwise fetches all pages (through the shared rate limiter) and replaces the snapshot.
    /// Never touches `anime_entries`.
    pub async fn fetch_season(
        &self,
        season: &str,
        year: u32,
        force_refresh: bool,
    ) -> Result<SeasonResult, String> {
        use chrono::Datelike;

        let season = season.trim().to_uppercase();
        if season_index(&season, year).is_none() {
            return Err(format!("Unknown season '{}'", season));
        }
        let today = chrono::Local::now();
        let past = season_is_past(&season, year, today.year() as u32, today.month());
        let now = chrono::Utc::now().timestamp();

        if !force_refresh {
            let key = season.clone();
            if let Some((fetched_at, items)) = self
                .blocking(move |db| db.get_season_cache(&key, year))
                .await?
            {
                return Ok(SeasonResult {
                    season,
                    year,
                    fetched_at,
                    items,
                    from_cache: true,
                    stale: season_cache_is_stale(past, fetched_at, now),
                });
            }
        }

        let plugin = self.plugin()?;
        let phase = Instant::now();
        let mut items: Vec<SeasonalAnime> = Vec::new();
        let mut seen = HashSet::new();
        let mut page = 1;
        loop {
            let result = self
                .limiter
                .run(|| plugin.fetch_season_page(&season, year, page))
                .await?;
            items.extend(
                result
                    .items
                    .into_iter()
                    .filter(|m| seen.insert(m.entry.id)),
            );
            if !result.has_next_page || page >= MAX_SEASON_PAGES {
                break;
            }
            page += 1;
        }
        log::info!(
            target: "seasons",
            "fetched {} {}: {} media in {} page(s), {}ms",
            season,
            year,
            items.len(),
            page,
            phase.elapsed().as_millis()
        );

        let fetched_at = chrono::Utc::now().timestamp();
        let (key, to_store) = (season.clone(), items.clone());
        self.blocking(move |db| db.put_season_cache(&key, year, fetched_at, &to_store))
            .await?;

        Ok(SeasonResult {
            season,
            year,
            fetched_at,
            items,
            from_cache: false,
            stale: false,
        })
    }

    /// Stored metadata of one media (as written by season fetches). Only when none is stored yet is it
    /// fetched once (through the rate limiter) and stored; it is never refreshed here — season refreshes do that.
    pub async fn media_metadata(&self, anilist_id: i64) -> Result<Option<SeasonalAnime>, String> {
        if let Some((_, item)) = self
            .blocking(move |db| db.get_media_metadata(anilist_id))
            .await?
        {
            return Ok(Some(item));
        }
        let plugin = self.plugin()?;
        let Some(item) = self
            .limiter
            .run(|| plugin.fetch_media_metadata(anilist_id))
            .await?
        else {
            return Ok(None);
        };
        let fetched_at = chrono::Utc::now().timestamp();
        let to_store = item.clone();
        self.blocking(move |db| db.put_media_metadata(fetched_at, &to_store))
            .await?;
        Ok(Some(item))
    }
}

// ---------------------------------------------------------------------------------------------
// Airing schedule (public data, snapshot per week in `airing_schedule_cache`)
// ---------------------------------------------------------------------------------------------

/// A cached range that hasn't ended yet is refetched after this long (delays and breaks move episodes).
const SCHEDULE_STALE_AFTER_SECS: i64 = 6 * 60 * 60;
/// Safety cap on pages per range (50 airings each).
const MAX_SCHEDULE_PAGES: u32 = 10;
/// Longest range a single request may cover (a calendar week, with slack for DST).
const MAX_SCHEDULE_RANGE_SECS: i64 = 8 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiringScheduleResult {
    pub from: i64,
    pub to: i64,
    pub fetched_at: i64,
    /// Sorted by `airing_at`.
    pub items: Vec<AiringScheduleItem>,
    pub from_cache: bool,
    /// Served from cache, but old enough that the caller should refresh in the background.
    pub stale: bool,
}

/// Ranges that already ended never change; others go stale after [`SCHEDULE_STALE_AFTER_SECS`].
pub fn schedule_cache_is_stale(to: i64, fetched_at: i64, now: i64) -> bool {
    to > now && now - fetched_at > SCHEDULE_STALE_AFTER_SECS
}

impl TrackerSyncService {
    /// Every episode airing in `from..to` (unix seconds). Serves the cached snapshot unless
    /// `force_refresh` or none exists; otherwise fetches all pages (through the shared rate limiter)
    /// and replaces it. Never touches `anime_entries` or `media_metadata`.
    pub async fn fetch_airing_schedule(
        &self,
        from: i64,
        to: i64,
        force_refresh: bool,
    ) -> Result<AiringScheduleResult, String> {
        if to <= from || to - from > MAX_SCHEDULE_RANGE_SECS {
            return Err(format!("Invalid airing schedule range {}..{}", from, to));
        }
        let now = chrono::Utc::now().timestamp();

        if !force_refresh {
            if let Some((fetched_at, items)) = self
                .blocking(move |db| db.get_airing_schedule_cache(from, to))
                .await?
            {
                return Ok(AiringScheduleResult {
                    from,
                    to,
                    fetched_at,
                    items,
                    from_cache: true,
                    stale: schedule_cache_is_stale(to, fetched_at, now),
                });
            }
        }

        let plugin = self.plugin()?;
        let phase = Instant::now();
        let mut items: Vec<AiringScheduleItem> = Vec::new();
        let mut seen = HashSet::new();
        let mut page = 1;
        loop {
            let result = self
                .limiter
                .run(|| plugin.fetch_airing_schedule_page(from, to, page))
                .await?;
            items.extend(
                result
                    .items
                    .into_iter()
                    .filter(|it| it.airing_at >= from && it.airing_at < to)
                    .filter(|it| seen.insert((it.media.id, it.episode))),
            );
            if !result.has_next_page || page >= MAX_SCHEDULE_PAGES {
                break;
            }
            page += 1;
        }
        items.sort_by_key(|it| it.airing_at);
        log::info!(
            target: "schedule",
            "fetched {}..{}: {} airings in {} page(s), {}ms",
            from,
            to,
            items.len(),
            page,
            phase.elapsed().as_millis()
        );

        let fetched_at = chrono::Utc::now().timestamp();
        let to_store = items.clone();
        self.blocking(move |db| db.put_airing_schedule_cache(from, to, fetched_at, &to_store))
            .await?;

        Ok(AiringScheduleResult {
            from,
            to,
            fetched_at,
            items,
            from_cache: false,
            stale: false,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_entry;
    use crate::db::CustomListToggle;
    use crate::plugins::{
        BoxFuture, RemoteEntryState, RemoteListMembership, RemoteListSnapshot, TrackerUserProfile,
    };
    use std::collections::HashMap;

    const TODAY: &str = "2026-10-27";

    fn entry(status: &str, progress: u32, episodes: Option<u32>) -> AnimeEntry {
        let mut e = test_entry(1, "Test");
        e.user_status = status.into();
        e.user_progress = progress;
        e.episodes = episodes;
        e
    }

    fn step(progress: u32) -> UserStateChange {
        UserStateChange {
            anime_id: 1,
            progress: Some(progress),
            source: ChangeSource::Step,
            ..Default::default()
        }
    }

    #[test]
    fn planning_to_current_and_started_today_on_first_episode() {
        let st = normalize_change(&entry("PLANNING", 0, Some(12)), &step(1), TODAY).unwrap();
        assert_eq!(st.user_status, "CURRENT");
        assert_eq!(st.user_progress, 1);
        assert_eq!(st.user_started_at.as_deref(), Some(TODAY));
        assert_eq!(st.user_completed_at, None);
    }

    #[test]
    fn completed_at_total_with_completed_today() {
        let mut cur = entry("CURRENT", 11, Some(12));
        cur.user_started_at = Some("2026-01-01".into());
        let st = normalize_change(&cur, &step(12), TODAY).unwrap();
        assert_eq!(st.user_status, "COMPLETED");
        assert_eq!(st.user_completed_at.as_deref(), Some(TODAY));
        // started_at is never overwritten once set
        assert_eq!(st.user_started_at.as_deref(), Some("2026-01-01"));

        // Straight to completed with no start date: both dates today
        let st = normalize_change(&entry("PLANNING", 0, Some(12)), &step(12), TODAY).unwrap();
        assert_eq!(st.user_status, "COMPLETED");
        assert_eq!(st.user_started_at.as_deref(), Some(TODAY));
        assert_eq!(st.user_completed_at.as_deref(), Some(TODAY));
    }

    #[test]
    fn started_not_overwritten_and_no_autodate_after_first_episode() {
        let mut cur = entry("CURRENT", 3, Some(12));
        cur.user_started_at = Some("2025-05-05".into());
        let st = normalize_change(&cur, &step(4), TODAY).unwrap();
        assert_eq!(st.user_started_at.as_deref(), Some("2025-05-05"));

        // progress 3 -> 4 with no start date does not invent one (only 0 -> >=1 does)
        let st = normalize_change(&entry("CURRENT", 3, Some(12)), &step(4), TODAY).unwrap();
        assert_eq!(st.user_started_at, None);
    }

    #[test]
    fn explicit_dates_win_over_auto_dates() {
        let change = UserStateChange {
            anime_id: 1,
            progress: Some(12),
            started_at: Some("2026-02-02".into()),
            completed_at: Some("2026-03-03".into()),
            ..Default::default()
        };
        let st = normalize_change(&entry("CURRENT", 0, Some(12)), &change, TODAY).unwrap();
        assert_eq!(st.user_status, "COMPLETED");
        assert_eq!(st.user_started_at.as_deref(), Some("2026-02-02"));
        assert_eq!(st.user_completed_at.as_deref(), Some("2026-03-03"));

        // Explicit clear wins too
        let mut cur = entry("CURRENT", 0, Some(12));
        cur.user_started_at = Some("2026-01-01".into());
        let change = UserStateChange {
            anime_id: 1,
            progress: Some(1),
            started_at: Some(String::new()),
            ..Default::default()
        };
        let st = normalize_change(&cur, &change, TODAY).unwrap();
        assert_eq!(st.user_started_at, None);

        // Modal re-sending the unchanged (empty) date is not explicit: auto date applies
        let change = UserStateChange {
            anime_id: 1,
            progress: Some(1),
            started_at: Some(String::new()),
            completed_at: Some(String::new()),
            ..Default::default()
        };
        let st = normalize_change(&entry("PLANNING", 0, Some(12)), &change, TODAY).unwrap();
        assert_eq!(st.user_started_at.as_deref(), Some(TODAY));
    }

    #[test]
    fn repeating_to_completed_increments_repeats() {
        let mut cur = entry("REPEATING", 11, Some(12));
        cur.user_repeats = 1;
        cur.user_started_at = Some("2020-01-01".into());
        cur.user_completed_at = Some("2020-03-01".into());
        let st = normalize_change(&cur, &step(12), TODAY).unwrap();
        assert_eq!(st.user_status, "COMPLETED");
        assert_eq!(st.user_repeats, 2);
        assert_eq!(st.user_completed_at.as_deref(), Some(TODAY));
        assert_eq!(st.user_started_at.as_deref(), Some("2020-01-01"));
    }

    #[test]
    fn progress_is_clamped() {
        let st = normalize_change(&entry("CURRENT", 5, Some(12)), &step(40), TODAY).unwrap();
        assert_eq!(st.user_progress, 12);
        let change = UserStateChange {
            anime_id: 1,
            progress_delta: Some(-10),
            ..Default::default()
        };
        let st = normalize_change(&entry("CURRENT", 5, Some(12)), &change, TODAY).unwrap();
        assert_eq!(st.user_progress, 0);
        // Unknown total: no upper clamp, no auto-complete
        let st = normalize_change(&entry("CURRENT", 5, None), &step(40), TODAY).unwrap();
        assert_eq!(st.user_progress, 40);
        assert_eq!(st.user_status, "CURRENT");
        // Score clamp
        let change = UserStateChange {
            anime_id: 1,
            score: Some(250.0),
            ..Default::default()
        };
        let st = normalize_change(&entry("CURRENT", 5, Some(12)), &change, TODAY).unwrap();
        assert_eq!(st.user_score, 100.0);
    }

    #[test]
    fn explicit_status_is_not_rederived() {
        let change = UserStateChange {
            anime_id: 1,
            status: Some("PAUSED".into()),
            progress: Some(12),
            ..Default::default()
        };
        let st = normalize_change(&entry("CURRENT", 3, Some(12)), &change, TODAY).unwrap();
        assert_eq!(st.user_status, "PAUSED");
        assert_eq!(st.user_completed_at, None);

        // Same status re-sent by the modal counts as unchanged -> derivation applies
        let change = UserStateChange {
            anime_id: 1,
            status: Some("CURRENT".into()),
            progress: Some(12),
            ..Default::default()
        };
        let st = normalize_change(&entry("CURRENT", 3, Some(12)), &change, TODAY).unwrap();
        assert_eq!(st.user_status, "COMPLETED");

        // Editing notes on an entry already at total does not flip status
        let change = UserStateChange {
            anime_id: 1,
            notes: Some("hi".into()),
            ..Default::default()
        };
        let st = normalize_change(&entry("CURRENT", 12, Some(12)), &change, TODAY).unwrap();
        assert_eq!(st.user_status, "CURRENT");
        assert_eq!(st.user_completed_at, None);
    }

    #[test]
    fn invalid_status_and_dates_are_rejected() {
        let cur = entry("CURRENT", 3, Some(12));
        let bad_status = UserStateChange {
            anime_id: 1,
            status: Some("WATCHING".into()),
            ..Default::default()
        };
        assert!(normalize_change(&cur, &bad_status, TODAY).is_err());
        for bad in ["2026/01/01", "2026-13-01", "26-01-01", "2026-02-30", "yesterday"] {
            let change = UserStateChange {
                anime_id: 1,
                started_at: Some(bad.into()),
                ..Default::default()
            };
            assert!(normalize_change(&cur, &change, TODAY).is_err(), "{bad}");
        }
        let lower = UserStateChange {
            anime_id: 1,
            status: Some("dropped".into()),
            ..Default::default()
        };
        assert_eq!(
            normalize_change(&cur, &lower, TODAY).unwrap().user_status,
            "DROPPED"
        );
    }

    #[test]
    fn batch_patch_goes_through_normalization() {
        let db = Database::open_in_memory().unwrap();
        let mut a = test_entry(1, "Alpha");
        a.episodes = Some(24);
        a.user_notes = "Queued.".into();
        let mut b = test_entry(2, "Beta");
        b.episodes = Some(12);
        b.user_status = "CURRENT".into();
        b.user_progress = 11;
        db.upsert_anime_entries_batch(&[a, b]).unwrap();

        let patch = BatchAnimeUpdatePatch {
            anime_ids: vec![1, 2, 999],
            user_status: None,
            user_progress: None,
            progress_delta: Some(2),
            mark_completed_progress: None,
            user_score: Some(88.0),
            user_repeats: None,
            user_notes: Some("Watching seasonal".into()),
            notes_mode: Some("append".into()),
            user_started_at: None,
            user_completed_at: None,
        };
        let updated = write_batch_change(&db, &patch, TODAY, true).unwrap();
        assert_eq!(updated.len(), 2);
        let a = db.get_anime_entry_by_id(1).unwrap();
        assert_eq!(a.user_status, "CURRENT");
        assert_eq!(a.user_progress, 2);
        assert_eq!(a.user_score, 88.0);
        assert_eq!(a.user_notes, "Queued.\nWatching seasonal");
        assert_eq!(a.user_started_at.as_deref(), Some(TODAY));
        assert!(a.sync_pending);
        let b = db.get_anime_entry_by_id(2).unwrap();
        assert_eq!(b.user_progress, 12);
        assert_eq!(b.user_status, "COMPLETED");
        assert_eq!(b.user_completed_at.as_deref(), Some(TODAY));

        let clear_patch = BatchAnimeUpdatePatch {
            anime_ids: vec![1],
            user_status: None,
            user_progress: None,
            progress_delta: None,
            mark_completed_progress: Some(true),
            user_score: None,
            user_repeats: None,
            user_notes: None,
            notes_mode: None,
            user_started_at: Some(String::new()),
            user_completed_at: Some("2026-03-30".into()),
        };
        write_batch_change(&db, &clear_patch, TODAY, false).unwrap();
        let a = db.get_anime_entry_by_id(1).unwrap();
        assert_eq!(a.user_started_at, None);
        assert_eq!(a.user_completed_at.as_deref(), Some("2026-03-30"));
        assert_eq!(a.user_progress, 24);
        assert_eq!(a.user_status, "COMPLETED");

        let bad = BatchAnimeUpdatePatch {
            user_status: Some("NOPE".into()),
            ..clear_patch
        };
        assert!(write_batch_change(&db, &bad, TODAY, false).is_err());
    }

    // ------------------------------------------------------------- service tests (mock tracker)

    #[derive(Default)]
    struct MockTracker {
        viewer_id: i64,
        remote: Mutex<Vec<AnimeEntry>>,
        saves: Mutex<Vec<TrackerEntryUpdate>>,
        deletes: Mutex<Vec<(i64, Option<i64>)>>,
        save_error: Mutex<Option<TrackerError>>,
        fetch_error: Mutex<Option<TrackerError>>,
        /// Ids passed to every `fetch_media_details` call.
        details_calls: Mutex<Vec<Vec<i64>>>,
        /// Media returned by `fetch_season_page`, 2 per page.
        season_media: Mutex<Vec<AnimeEntry>>,
        /// `(season, year, page)` of every `fetch_season_page` call.
        season_calls: Mutex<Vec<(String, u32, u32)>>,
        /// Ids of every `fetch_media_metadata` call.
        metadata_calls: Mutex<Vec<i64>>,
        /// Airings returned by `fetch_airing_schedule_page`, 2 per page (unfiltered by range).
        schedule_items: Mutex<Vec<AiringScheduleItem>>,
        /// `(from, to, page)` of every `fetch_airing_schedule_page` call.
        schedule_calls: Mutex<Vec<(i64, i64, u32)>>,
        custom_lists: Mutex<Vec<String>>,
        /// By media id.
        memberships: Mutex<HashMap<i64, RemoteListMembership>>,
    }

    impl TrackerPlugin for MockTracker {
        fn descriptor(&self) -> crate::plugins::TrackerPluginDescriptor {
            unimplemented!()
        }
        fn verify_account<'a>(
            &'a self,
            _username: &'a str,
            _token: Option<&'a str>,
        ) -> BoxFuture<'a, Result<TrackerUserProfile, String>> {
            Box::pin(async { Err("mock".to_string()) })
        }
        fn viewer_id<'a>(&'a self, _token: &'a str) -> BoxFuture<'a, Result<i64, TrackerError>> {
            Box::pin(async move { Ok(self.viewer_id) })
        }
        fn fetch_user_list<'a>(
            &'a self,
            _token: &'a str,
        ) -> BoxFuture<'a, Result<RemoteListSnapshot, TrackerError>> {
            Box::pin(async move {
                if let Some(e) = self.fetch_error.lock().unwrap().clone() {
                    return Err(e);
                }
                Ok(RemoteListSnapshot {
                    viewer_id: self.viewer_id,
                    entries: self.remote.lock().unwrap().clone(),
                    custom_lists: self.custom_lists.lock().unwrap().clone(),
                    memberships: self.memberships.lock().unwrap().clone(),
                })
            })
        }
        fn fetch_media_details<'a>(
            &'a self,
            ids: &'a [i64],
        ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, TrackerError>> {
            Box::pin(async move {
                self.details_calls.lock().unwrap().push(ids.to_vec());
                Ok(self
                    .remote
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| ids.contains(&e.id))
                    .map(|e| {
                        let mut d = e.clone();
                        d.synopsis = format!("Details {}", e.id);
                        d.genres = vec!["Action".into()];
                        d.anilist_list_entry_id = None;
                        d
                    })
                    .collect())
            })
        }
        fn search_anime<'a>(
            &'a self,
            _query: &'a str,
            _season: Option<&'a str>,
            _year: Option<u32>,
        ) -> BoxFuture<'a, Result<Vec<AnimeEntry>, String>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn fetch_season_page<'a>(
            &'a self,
            season: &'a str,
            year: u32,
            page: u32,
        ) -> BoxFuture<'a, Result<crate::plugins::SeasonPage, TrackerError>> {
            Box::pin(async move {
                self.season_calls
                    .lock()
                    .unwrap()
                    .push((season.to_string(), year, page));
                let all = self.season_media.lock().unwrap().clone();
                let start = ((page - 1) * 2) as usize;
                let items = all
                    .iter()
                    .skip(start)
                    .take(2)
                    .map(|e| SeasonalAnime {
                        entry: e.clone(),
                        popularity: Some(1000 - e.id as u32),
                        metadata: Default::default(),
                    })
                    .collect();
                Ok(crate::plugins::SeasonPage {
                    items,
                    has_next_page: start + 2 < all.len(),
                })
            })
        }
        fn fetch_airing_schedule_page<'a>(
            &'a self,
            from: i64,
            to: i64,
            page: u32,
        ) -> BoxFuture<'a, Result<crate::plugins::AiringSchedulePage, TrackerError>> {
            Box::pin(async move {
                self.schedule_calls.lock().unwrap().push((from, to, page));
                let all = self.schedule_items.lock().unwrap().clone();
                let start = ((page - 1) * 2) as usize;
                Ok(crate::plugins::AiringSchedulePage {
                    items: all.iter().skip(start).take(2).cloned().collect(),
                    has_next_page: start + 2 < all.len(),
                })
            })
        }
        fn fetch_media_metadata<'a>(
            &'a self,
            id: i64,
        ) -> BoxFuture<'a, Result<Option<SeasonalAnime>, TrackerError>> {
            Box::pin(async move {
                self.metadata_calls.lock().unwrap().push(id);
                Ok(Some(SeasonalAnime {
                    entry: test_entry(id, "Fetched"),
                    popularity: Some(5),
                    metadata: crate::plugins::MediaMetadata {
                        favourites: Some(7),
                        ..Default::default()
                    },
                }))
            })
        }
        fn save_list_entry<'a>(
            &'a self,
            _token: &'a str,
            update: &'a TrackerEntryUpdate,
        ) -> BoxFuture<'a, Result<RemoteEntryState, TrackerError>> {
            Box::pin(async move {
                if let Some(e) = self.save_error.lock().unwrap().clone() {
                    return Err(e);
                }
                self.saves.lock().unwrap().push(update.clone());
                Ok(RemoteEntryState {
                    list_entry_id: 5000 + update.media_id,
                    status: update.status.clone(),
                    progress: update.progress,
                    updated_at: 1_900_000_000,
                })
            })
        }
        fn delete_list_entry<'a>(
            &'a self,
            _token: &'a str,
            media_id: i64,
            list_entry_id: Option<i64>,
        ) -> BoxFuture<'a, Result<(), TrackerError>> {
            Box::pin(async move {
                self.deletes.lock().unwrap().push((media_id, list_entry_id));
                Ok(())
            })
        }
        fn create_custom_list<'a>(
            &'a self,
            _token: &'a str,
            name: &'a str,
        ) -> BoxFuture<'a, Result<Vec<String>, TrackerError>> {
            Box::pin(async move {
                let mut lists = self.custom_lists.lock().unwrap();
                if !lists.iter().any(|n| n == name) {
                    lists.push(name.to_string());
                }
                Ok(lists.clone())
            })
        }
        fn delete_custom_list<'a>(
            &'a self,
            _token: &'a str,
            name: &'a str,
        ) -> BoxFuture<'a, Result<Vec<String>, TrackerError>> {
            Box::pin(async move {
                let mut lists = self.custom_lists.lock().unwrap();
                lists.retain(|n| n != name);
                Ok(lists.clone())
            })
        }
    }

    type Events = Arc<Mutex<Vec<(String, Value)>>>;

    fn service(db: Arc<Database>, mock: Arc<MockTracker>) -> (Arc<TrackerSyncService>, Events) {
        let mut plugins = PluginManager::new();
        plugins.register("anilist", mock);
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit: SyncEmitter = Arc::new(move |name: &str, payload: Value| {
            sink.lock().unwrap().push((name.to_string(), payload));
        });
        let svc = TrackerSyncService::new(db, Arc::new(plugins), emit, Arc::new(Mutex::new(None)))
            .with_min_request_interval(Duration::from_millis(0));
        (Arc::new(svc), events)
    }

    fn sign_in(db: &Database, user_id: i64) {
        let mut s = db.get_settings().unwrap();
        s.anilist_token = "token".into();
        s.anilist_user_id = Some(user_id);
        db.save_settings(&s).unwrap();
    }

    fn names(events: &Events) -> Vec<String> {
        events.lock().unwrap().iter().map(|(n, _)| n.clone()).collect()
    }

    async fn wait_until(mut cond: impl FnMut() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached");
    }

    #[test]
    fn season_helpers_follow_broadcast_quarters() {
        assert_eq!(current_season(2026, 1), ("WINTER", 2026));
        assert_eq!(current_season(2026, 6), ("SPRING", 2026));
        assert_eq!(current_season(2026, 9), ("SUMMER", 2026));
        assert_eq!(current_season(2026, 10), ("FALL", 2026));
        assert_eq!(current_season(2026, 12), ("FALL", 2026));

        assert!(season_index("fall", 2026) > season_index("SUMMER", 2026));
        assert!(season_index("WINTER", 2027) > season_index("FALL", 2026));
        assert_eq!(season_index("AUTUMN", 2026), None);

        // Today: 2026-10-28 → Fall 2026
        assert!(season_is_past("SUMMER", 2026, 2026, 10));
        assert!(season_is_past("FALL", 2025, 2026, 10));
        assert!(!season_is_past("FALL", 2026, 2026, 10));
        assert!(!season_is_past("WINTER", 2027, 2026, 10));

        let day = 24 * 60 * 60;
        assert!(!season_cache_is_stale(false, 1_000, 1_000 + day - 1));
        assert!(season_cache_is_stale(false, 1_000, 1_000 + day + 1));
        assert!(!season_cache_is_stale(true, 1_000, 1_000 + 100 * day));
    }

    #[tokio::test]
    async fn fetch_season_pages_through_and_caches() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let mock = Arc::new(MockTracker::default());
        *mock.season_media.lock().unwrap() = (1..=5)
            .map(|id| test_entry(id, &format!("Show {}", id)))
            .collect();
        let (svc, _events) = service(db.clone(), mock.clone());

        let first = svc.fetch_season("summer", 2025, false).await.unwrap();
        assert!(!first.from_cache);
        assert_eq!(first.season, "SUMMER");
        assert_eq!(first.items.len(), 5);
        assert_eq!(first.items[0].popularity, Some(999));
        assert_eq!(mock.season_calls.lock().unwrap().len(), 3);
        // Browsing never creates list entries
        assert!(db.list_anime_entries().unwrap().is_empty());

        // Second call is served from the cache without touching the tracker (past season → never stale)
        let cached = svc.fetch_season("SUMMER", 2025, false).await.unwrap();
        assert!(cached.from_cache);
        assert!(!cached.stale);
        assert_eq!(cached.items.len(), 5);
        assert_eq!(cached.items[2].entry.title_romaji, "Show 3");
        assert_eq!(mock.season_calls.lock().unwrap().len(), 3);

        // Forced refresh refetches and replaces the snapshot
        mock.season_media.lock().unwrap().truncate(1);
        let refreshed = svc.fetch_season("SUMMER", 2025, true).await.unwrap();
        assert!(!refreshed.from_cache);
        assert_eq!(refreshed.items.len(), 1);
        assert_eq!(db.get_season_cache("SUMMER", 2025).unwrap().unwrap().1.len(), 1);
        assert_eq!(
            db.list_cached_seasons().unwrap(),
            vec![crate::db::CachedSeason {
                season: "SUMMER".into(),
                year: 2025,
                fetched_at: refreshed.fetched_at,
            }]
        );

        assert!(svc.fetch_season("AUTUMN", 2025, false).await.is_err());
    }

    #[test]
    fn schedule_staleness_only_applies_to_unfinished_ranges() {
        let h = 60 * 60;
        // Range still running: stale after 6h
        assert!(!schedule_cache_is_stale(10_000_000, 1_000, 1_000 + 6 * h - 1));
        assert!(schedule_cache_is_stale(10_000_000, 1_000, 1_000 + 6 * h + 1));
        // Range already over: never stale
        assert!(!schedule_cache_is_stale(5_000, 1_000, 1_000 + 100 * h));
    }

    #[tokio::test]
    async fn fetch_airing_schedule_pages_through_and_caches() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let mock = Arc::new(MockTracker::default());
        let (from, to) = (1_000_000, 1_000_000 + 7 * 86_400);
        let airing = |id: i64, ep: u32, at: i64| AiringScheduleItem {
            episode: ep,
            airing_at: at,
            media: test_entry(id, &format!("Show {}", id)),
            country: Some("JP".into()),
        };
        *mock.schedule_items.lock().unwrap() = vec![
            airing(1, 3, from + 7_200),
            airing(2, 1, from + 3_600),
            airing(1, 3, from + 7_200), // duplicate across pages
            airing(3, 9, to),           // outside the range (end is exclusive)
            airing(4, 2, from),
        ];
        let (svc, _events) = service(db.clone(), mock.clone());

        let first = svc.fetch_airing_schedule(from, to, false).await.unwrap();
        assert!(!first.from_cache);
        let order: Vec<_> = first.items.iter().map(|it| (it.media.id, it.episode)).collect();
        assert_eq!(order, vec![(4, 2), (2, 1), (1, 3)]);
        assert_eq!(mock.schedule_calls.lock().unwrap().len(), 3);
        // Browsing never creates list entries or metadata rows
        assert!(db.list_anime_entries().unwrap().is_empty());
        assert!(db.get_media_metadata(1).unwrap().is_none());

        // Served from the cache without touching the tracker
        let cached = svc.fetch_airing_schedule(from, to, false).await.unwrap();
        assert!(cached.from_cache);
        assert_eq!(cached.items.len(), 3);
        assert_eq!(cached.items[2].media.title_romaji, "Show 1");
        assert_eq!(mock.schedule_calls.lock().unwrap().len(), 3);

        // A different end for the same start is a miss; a forced refresh replaces the snapshot
        mock.schedule_items.lock().unwrap().truncate(1);
        let refreshed = svc.fetch_airing_schedule(from, to, true).await.unwrap();
        assert!(!refreshed.from_cache);
        assert_eq!(refreshed.items.len(), 1);
        assert!(db.get_airing_schedule_cache(from, to - 3_600).unwrap().is_none());

        assert!(svc.fetch_airing_schedule(to, from, false).await.is_err());
        assert!(svc.fetch_airing_schedule(from, from + 30 * 86_400, false).await.is_err());
    }

    #[tokio::test]
    async fn pull_flushes_queues_then_merges() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        sign_in(&db, 42);
        let mut pending = test_entry(1, "Pending");
        pending.user_status = "CURRENT".into();
        pending.user_progress = 3;
        pending.sync_pending = true;
        let gone = test_entry(2, "Gone Remotely");
        let mut to_delete = test_entry(3, "Deleted Locally");
        to_delete.anilist_list_entry_id = Some(333);
        db.upsert_anime_entries_batch(&[pending, gone, to_delete]).unwrap();
        db.delete_entries_with_tombstones(&[3]).unwrap();

        let mock = Arc::new(MockTracker {
            viewer_id: 42,
            ..Default::default()
        });
        let mut remote_pending = test_entry(1, "Pending");
        remote_pending.user_progress = 1;
        remote_pending.updated_at = 1_000;
        let mut remote_new = test_entry(4, "New Remote");
        remote_new.updated_at = 1_000;
        // Remote still has the locally-deleted entry (its delete is flushed first, but the mock snapshot is static)
        let remote_tomb = test_entry(3, "Deleted Locally");
        *mock.remote.lock().unwrap() = vec![remote_pending, remote_new, remote_tomb];

        let (svc, events) = service(db.clone(), mock.clone());
        let summary = svc.pull("startup").await.unwrap();

        assert_eq!(summary.remote_deleted, 1);
        assert_eq!(summary.pushed, 1);
        assert_eq!(summary.push_failed, 0);
        assert_eq!(summary.added, 2); // entry 4, plus entry 3 again since its tombstone is gone
        assert_eq!(summary.deleted, 1); // entry 2
        assert_eq!(*mock.deletes.lock().unwrap(), vec![(3, Some(333))]);
        assert_eq!(mock.saves.lock().unwrap()[0].progress, 3);
        // No local membership edit: AniList's custom lists are left alone
        assert_eq!(mock.saves.lock().unwrap()[0].custom_lists, None);
        assert_eq!(mock.saves.lock().unwrap()[0].hidden_from_status_lists, None);

        // Pushed entry: no longer pending, adopted remote updatedAt, kept local progress
        let e1 = db.get_anime_entry_by_id(1).unwrap();
        assert!(!e1.sync_pending);
        assert_eq!(e1.user_progress, 3);
        assert_eq!(e1.anilist_list_entry_id, Some(5001));
        assert!(db.get_anime_entry_by_id(2).is_err());
        // Delta: entry 1 kept local and had nothing to write; 3 and 4 were inserted; 2 removed
        let mut changed: Vec<i64> = summary.changed.iter().map(|e| e.id).collect();
        changed.sort_unstable();
        assert_eq!(changed, vec![3, 4]);
        assert_eq!(summary.removed_ids, vec![2]);
        assert_eq!(summary.kept_local, 1);
        let mut detail_ids: Vec<i64> = mock.details_calls.lock().unwrap().concat();
        detail_ids.sort_unstable();
        assert_eq!(detail_ids, vec![3, 4]);
        assert!(summary.changed.iter().all(|e| e.synopsis.starts_with("Details ")));

        let n = names(&events);
        assert_eq!(n.first().map(String::as_str), Some(EVENT_SYNC_STARTED));
        assert_eq!(n.last().map(String::as_str), Some(EVENT_LIST_SYNCED));
        assert!(n.iter().any(|x| x == EVENT_ENTRY_SYNCED));
        let status = svc.status();
        assert!(!status.in_progress);
        assert!(status.last_synced_at.is_some());
        assert_eq!(status.pending_count, 0);
        assert_eq!(status.pending_deletions, 0);
    }

    #[tokio::test]
    async fn create_custom_list_needs_owner_sign_in_and_keeps_remote_lists() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let mock = Arc::new(MockTracker {
            viewer_id: 42,
            ..Default::default()
        });
        let (svc, _events) = service(db.clone(), mock.clone());

        // Signed out / empty name: nothing is sent
        assert!(svc.create_custom_list("Favs".into()).await.is_err());
        sign_in(&db, 42);
        assert!(svc.create_custom_list("   ".into()).await.is_err());
        assert!(mock.custom_lists.lock().unwrap().is_empty());

        // A list made on AniList since the last pull survives (the tracker's names are stored)
        *mock.custom_lists.lock().unwrap() = vec!["Made elsewhere".into()];
        let state = svc.create_custom_list("  Favs ".into()).await.unwrap();
        assert_eq!(state.names, vec!["Made elsewhere", "Favs"]);
        assert_eq!(db.get_custom_lists().unwrap().names, vec!["Made elsewhere", "Favs"]);

        // Duplicates (ignoring case) are rejected locally
        assert!(svc.create_custom_list("favs".into()).await.is_err());
        assert_eq!(mock.custom_lists.lock().unwrap().len(), 2);

        // Another account's token never writes
        sign_in(&db, 7);
        assert!(svc.create_custom_list("Other".into()).await.is_err());
        assert!(svc.delete_custom_list("Favs".into()).await.is_err());
        assert_eq!(mock.custom_lists.lock().unwrap().len(), 2);
        sign_in(&db, 42);

        // Deleting drops the list and its memberships locally, without queueing a push
        db.upsert_anime_entry(&test_entry(1, "Alpha")).unwrap();
        svc.set_custom_lists(CustomListChange {
            anime_ids: vec![1],
            toggles: vec![
                CustomListToggle { name: "Favs".into(), enabled: true },
                CustomListToggle { name: "Made elsewhere".into(), enabled: true },
            ],
            hidden_from_status_lists: Some(true),
        })
        .await
        .unwrap();
        wait_until(|| !db.get_anime_entry_by_id(1).unwrap().sync_pending).await;
        assert!(svc.delete_custom_list("Nope".into()).await.is_err());
        let state = svc.delete_custom_list("Favs".into()).await.unwrap();
        assert_eq!(state.names, vec!["Made elsewhere"]);
        assert_eq!(state.members[0].lists, vec!["Made elsewhere"]);
        assert!(state.members[0].hidden_from_status_lists);
        let state = svc.delete_custom_list("Made elsewhere".into()).await.unwrap();
        assert!(state.names.is_empty() && state.members.is_empty());
        assert!(mock.custom_lists.lock().unwrap().is_empty());
        assert!(!db.get_anime_entry_by_id(1).unwrap().sync_pending);
    }

    #[tokio::test]
    async fn custom_lists_pull_diff_only_edit_push_and_keep_unsent_edits() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        sign_in(&db, 42);
        let mock = Arc::new(MockTracker {
            viewer_id: 42,
            ..Default::default()
        });
        let mut a = test_entry(1, "Alpha");
        a.updated_at = 1_000;
        let mut b = test_entry(2, "Beta");
        b.updated_at = 1_000;
        *mock.remote.lock().unwrap() = vec![a, b];
        *mock.custom_lists.lock().unwrap() = vec!["Favs".into(), "Later".into()];
        mock.memberships.lock().unwrap().insert(
            1,
            RemoteListMembership {
                lists: vec!["Favs".into()],
                hidden_from_status_lists: false,
            },
        );
        let (svc, _events) = service(db.clone(), mock.clone());

        let summary = svc.pull("startup").await.unwrap();
        assert!(summary.custom_lists_changed);
        let state = db.get_custom_lists().unwrap();
        assert_eq!(state.names, vec!["Favs", "Later"]);
        assert_eq!(state.members.len(), 1);
        assert_eq!(state.members[0].anime_id, 1);
        assert_eq!(state.members[0].lists, vec!["Favs"]);

        // Nothing changed remotely: nothing to write
        let summary = svc.pull("manual").await.unwrap();
        assert!(!summary.custom_lists_changed);
        assert!(summary.changed.is_empty());

        // Unknown list names are rejected
        let bad = CustomListChange {
            anime_ids: vec![2],
            toggles: vec![CustomListToggle {
                name: "Nope".into(),
                enabled: true,
            }],
            hidden_from_status_lists: None,
        };
        assert!(svc.set_custom_lists(bad).await.is_err());

        // A local edit is queued, pushed with the full set and then no longer dirty
        let state = svc
            .set_custom_lists(CustomListChange {
                anime_ids: vec![2],
                toggles: vec![CustomListToggle {
                    name: "Later".into(),
                    enabled: true,
                }],
                hidden_from_status_lists: Some(true),
            })
            .await
            .unwrap();
        let member = state.members.iter().find(|m| m.anime_id == 2).unwrap();
        assert_eq!(member.lists, vec!["Later"]);
        assert!(member.hidden_from_status_lists);
        wait_until(|| mock.saves.lock().unwrap().iter().any(|s| s.media_id == 2)).await;
        let save = mock.saves.lock().unwrap().last().cloned().unwrap();
        assert_eq!(save.custom_lists, Some(vec!["Later".to_string()]));
        assert_eq!(save.hidden_from_status_lists, Some(true));
        wait_until(|| !db.get_anime_entry_by_id(2).unwrap().sync_pending).await;
        assert_eq!(db.dirty_custom_lists(2).unwrap(), None);

        // An unsent edit (push fails) survives a pull whose remote state differs
        *mock.save_error.lock().unwrap() = Some(TrackerError::Network("offline".into()));
        svc.set_custom_lists(CustomListChange {
            anime_ids: vec![1],
            toggles: vec![
                CustomListToggle {
                    name: "Favs".into(),
                    enabled: false,
                },
                CustomListToggle {
                    name: "Later".into(),
                    enabled: true,
                },
            ],
            hidden_from_status_lists: None,
        })
        .await
        .unwrap();
        svc.pull("manual").await.unwrap();
        let state = db.get_custom_lists().unwrap();
        let m1 = state.members.iter().find(|m| m.anime_id == 1).unwrap();
        assert_eq!(m1.lists, vec!["Later"]);
        assert!(db.dirty_custom_lists(1).unwrap().is_some());
        assert!(db.get_anime_entry_by_id(1).unwrap().sync_pending);

        // A list deleted on AniList drops out of unsent edits; removed from every list = not hidden
        *mock.custom_lists.lock().unwrap() = vec!["Favs".into()];
        mock.memberships.lock().unwrap().remove(&1);
        svc.pull("manual").await.unwrap();
        let state = db.get_custom_lists().unwrap();
        assert_eq!(state.names, vec!["Favs"]);
        assert!(state.members.iter().all(|m| m.anime_id != 1));
        assert_eq!(
            db.dirty_custom_lists(1).unwrap().map(|m| m.lists),
            Some(Vec::<String>::new())
        );
    }

    fn insert_local_file(db: &Database, file: &str, title: &str, ep: u32, matched: Option<i64>) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO library_folders (id, path, label, drive_root) VALUES (1, 'C:/lib', 'lib', 'C:')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO local_episodes (folder_id, file_path, file_name, drive_root, parsed_title, normalized_title, episode_number, matched_anime_id)
             VALUES (1, ?1, ?1, 'C:', ?2, ?3, ?4, ?5)",
            rusqlite::params![
                file,
                title,
                crate::detection::anitomy::normalize_anime_title(title),
                ep,
                matched
            ],
        )
        .unwrap();
    }

    fn matched_of(db: &Database, file: &str) -> Option<i64> {
        db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT matched_anime_id FROM local_episodes WHERE file_path = ?1",
                [file],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn pull_returns_delta_and_matches_only_new_entries_in_background() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        sign_in(&db, 42);
        let mut alpha = test_entry(1, "Alpha Show");
        alpha.user_status = "CURRENT".into();
        alpha.user_progress = 2;
        alpha.updated_at = 100;
        alpha.synopsis = "Stored synopsis".into();
        db.upsert_anime_entries_batch(&[alpha.clone(), test_entry(5, "Old Entry")])
            .unwrap();
        // Already matched file (deliberately "matched" to an id its title would not pick) + unmatched files
        insert_local_file(&db, "C:/lib/alpha-01.mkv", "Brand New Show", 1, Some(1));
        insert_local_file(&db, "C:/lib/new-02.mkv", "Brand New Show", 2, None);
        insert_local_file(&db, "C:/lib/other-01.mkv", "Unrelated Thing", 1, None);

        let mock = Arc::new(MockTracker {
            viewer_id: 42,
            ..Default::default()
        });
        let mut remote_alpha = alpha.clone();
        remote_alpha.synopsis = String::new(); // light fetch carries no synopsis
        let mut remote_new = test_entry(2, "Brand New Show");
        remote_new.user_status = "CURRENT".into();
        remote_new.updated_at = 1_000;
        *mock.remote.lock().unwrap() = vec![remote_alpha.clone(), remote_new];
        let (svc, events) = service(db.clone(), mock.clone());

        let summary = svc.pull("manual").await.unwrap();
        assert_eq!(summary.added, 1);
        assert_eq!(summary.deleted, 1);
        assert_eq!(summary.changed.len(), 1);
        assert_eq!(summary.changed[0].id, 2);
        assert_eq!(summary.changed[0].synopsis, "Details 2");
        assert_eq!(summary.removed_ids, vec![5]);
        assert_eq!(*mock.details_calls.lock().unwrap(), vec![vec![2]]);
        assert_eq!(db.get_anime_entry_by_id(1).unwrap().synopsis, "Stored synopsis");

        // The event carries the same delta
        let synced = events
            .lock()
            .unwrap()
            .iter()
            .find(|(n, _)| n == EVENT_LIST_SYNCED)
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(synced["changed"][0]["id"], 2);
        assert_eq!(synced["removed_ids"], json!([5]));
        assert!(synced.get("entries").is_none());

        // Background matching binds the unmatched file to the new entry; matched files are untouched
        wait_until(|| names(&events).iter().any(|n| n == EVENT_LIBRARY_CHANGED)).await;
        assert_eq!(matched_of(&db, "C:/lib/new-02.mkv"), Some(2));
        assert_eq!(matched_of(&db, "C:/lib/alpha-01.mkv"), Some(1));
        assert_eq!(matched_of(&db, "C:/lib/other-01.mkv"), None);
        let lib_event = events
            .lock()
            .unwrap()
            .iter()
            .find(|(n, _)| n == EVENT_LIBRARY_CHANGED)
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(lib_event["matched_files"], 1);
        assert_eq!(lib_event["newly_parsed"], 0);

        // Second pull with an unchanged remote list: empty delta, no detail fetch, no matching
        events.lock().unwrap().clear();
        let summary = svc.pull("manual").await.unwrap();
        assert!(summary.changed.is_empty());
        assert!(summary.removed_ids.is_empty());
        assert_eq!(summary.added + summary.updated_from_remote + summary.deleted, 0);
        assert_eq!(mock.details_calls.lock().unwrap().len(), 1);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!names(&events).iter().any(|n| n == EVENT_LIBRARY_CHANGED));
    }

    #[tokio::test]
    async fn pull_refuses_viewer_mismatch_and_requires_token() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let mock = Arc::new(MockTracker {
            viewer_id: 7,
            ..Default::default()
        });
        let (svc, _events) = service(db.clone(), mock.clone());
        assert_eq!(
            svc.pull("manual").await.unwrap_err(),
            "Not signed in to AniList"
        );

        // Token belongs to viewer 7 but the stored account is 42: nothing is flushed or merged
        sign_in(&db, 42);
        let mut local = test_entry(2, "Local");
        local.sync_pending = true;
        db.upsert_anime_entry(&local).unwrap();
        *mock.remote.lock().unwrap() = vec![test_entry(9, "Other")];
        assert!(svc.pull("manual").await.unwrap_err().contains("belongs to AniList user"));
        assert!(db.get_anime_entry_by_id(2).unwrap().sync_pending);
        assert!(db.get_anime_entry_by_id(9).is_err());
        assert!(mock.saves.lock().unwrap().is_empty());

        // Same for a list owned by another account than the signed-in one
        sign_in(&db, 7);
        db.set_list_owner(42).unwrap();
        assert!(svc.pull("manual").await.unwrap_err().contains("belongs to AniList user 42"));
        assert!(mock.saves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_push_stays_pending_and_reports_auth() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        sign_in(&db, 42);
        let mut e = test_entry(1, "Alpha");
        e.episodes = Some(12);
        db.upsert_anime_entry(&e).unwrap();
        let mock = Arc::new(MockTracker {
            viewer_id: 42,
            ..Default::default()
        });
        *mock.save_error.lock().unwrap() = Some(TrackerError::Unauthorized("bad token".into()));
        let (svc, events) = service(db.clone(), mock.clone());

        let updated = svc.apply_local_update(step_for(1, 1)).await.unwrap();
        assert!(updated.sync_pending);
        assert_eq!(updated.user_status, "CURRENT");
        wait_until(|| names(&events).iter().any(|n| n == EVENT_AUTH_INVALID)).await;
        let n = names(&events);
        assert!(n.iter().any(|x| x == EVENT_SYNC_ERROR));
        let err = events
            .lock()
            .unwrap()
            .iter()
            .find(|(n, _)| n == EVENT_SYNC_ERROR)
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(err["kind"], "unauthorized");
        assert_eq!(err["operation"], "save");
        assert_eq!(err["anime_id"], 1);
        assert!(db.get_anime_entry_by_id(1).unwrap().sync_pending);

        // Pull aborts on the rejected token without a duplicate auth event
        events.lock().unwrap().clear();
        assert!(svc.pull("manual").await.is_err());
        let n = names(&events);
        assert!(n.iter().any(|x| x == EVENT_SYNC_FAILED));
        assert_eq!(n.iter().filter(|x| *x == EVENT_AUTH_INVALID).count(), 1);

        // Recovery: next flush pushes it and marks the scrobble
        *mock.save_error.lock().unwrap() = None;
        let hid = db
            .record_watch_history(Some(1), "Alpha", 1, "mpv", "a.mkv", false)
            .unwrap();
        assert!(svc.push_entry_with_history(1, Some(hid)).await);
        assert!(!db.get_anime_entry_by_id(1).unwrap().sync_pending);
        assert!(db.list_watch_history(5, 0).unwrap()[0].scrobbled_to_tracker);
    }

    fn step_for(anime_id: i64, progress: u32) -> UserStateChange {
        UserStateChange {
            anime_id,
            progress: Some(progress),
            source: ChangeSource::Scrobble,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn add_existing_keeps_user_state_and_delete_queues_tombstone() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        sign_in(&db, 42);
        let mut existing = test_entry(10, "Existing");
        existing.user_status = "CURRENT".into();
        existing.user_progress = 5;
        db.upsert_anime_entry(&existing).unwrap();
        let mock = Arc::new(MockTracker {
            viewer_id: 42,
            ..Default::default()
        });
        let (svc, _events) = service(db.clone(), mock.clone());

        // Re-adding from Discover (PLANNING, 0) must not reset progress
        let mut readd = test_entry(10, "Existing (new title)");
        readd.cover_image = "https://example/cover.jpg".into();
        svc.add_entry(readd).await.unwrap();
        let e = db.get_anime_entry_by_id(10).unwrap();
        assert_eq!(e.user_progress, 5);
        assert_eq!(e.title_romaji, "Existing (new title)");
        assert!(!e.sync_pending);

        // Brand-new add as COMPLETED gets dates and is pushed
        let mut fresh = test_entry(11, "Fresh");
        fresh.user_status = "COMPLETED".into();
        fresh.user_progress = 12;
        svc.add_entry(fresh).await.unwrap();
        let f = db.get_anime_entry_by_id(11).unwrap();
        assert_eq!(f.user_completed_at.as_deref(), Some(today_string().as_str()));
        wait_until(|| !db.get_anime_entry_by_id(11).unwrap().sync_pending).await;

        let mut no_id = test_entry(12, "No id");
        no_id.anilist_id = None;
        assert!(svc.add_entry(no_id).await.is_err());

        svc.delete_entries(vec![10]).await.unwrap();
        assert!(db.get_anime_entry_by_id(10).is_err());
        wait_until(|| db.count_pending_deletions().unwrap() == 0).await;
        assert_eq!(*mock.deletes.lock().unwrap(), vec![(10, None)]);
    }

    fn profile(user_id: i64, username: &str) -> TrackerUserProfile {
        TrackerUserProfile {
            user_id,
            username: username.into(),
            avatar_url: None,
            anime_count: 0,
            episodes_watched: 0,
            authenticated: true,
        }
    }

    #[tokio::test]
    async fn signed_out_edits_are_queued_and_sent_when_the_owner_signs_back_in() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let mock = Arc::new(MockTracker {
            viewer_id: 42,
            ..Default::default()
        });
        let (svc, _events) = service(db.clone(), mock.clone());
        svc.sign_in("token", &profile(42, "alice")).await.unwrap();
        assert_eq!(db.list_owner().unwrap(), Some(42));
        let mut e = test_entry(1, "Alpha");
        e.episodes = Some(12);
        db.upsert_anime_entry(&e).unwrap();
        db.upsert_anime_entry(&test_entry(2, "Beta")).unwrap();

        let out = svc.sign_out().await.unwrap();
        assert_eq!(out.unsent, 0);
        assert!(out.settings.anilist_token.is_empty());
        assert_eq!(db.list_owner().unwrap(), Some(42));

        // Signed out: written locally and queued, nothing sent
        let updated = svc.apply_local_update(step_for(1, 3)).await.unwrap();
        assert!(updated.sync_pending);
        svc.delete_entries(vec![2]).await.unwrap();
        assert_eq!(db.count_pending_deletions().unwrap(), 1);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(mock.saves.lock().unwrap().is_empty());
        assert!(mock.deletes.lock().unwrap().is_empty());

        // Same account signs back in: the list is kept and the next pull sends the queue
        let outcome = svc.sign_in("token", &profile(42, "alice")).await.unwrap();
        assert!(!outcome.account_switched);
        *mock.remote.lock().unwrap() = vec![e.clone()];
        let summary = svc.pull("post_auth").await.unwrap();
        assert_eq!((summary.pushed, summary.remote_deleted), (1, 1));
        assert_eq!(mock.saves.lock().unwrap()[0].progress, 3);
        assert_eq!(*mock.deletes.lock().unwrap(), vec![(2, None)]);
        assert_eq!(db.get_anime_entry_by_id(1).unwrap().user_progress, 3);
    }

    #[tokio::test]
    async fn sign_out_sends_the_queue_before_clearing_the_token() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let mock = Arc::new(MockTracker {
            viewer_id: 42,
            ..Default::default()
        });
        let (svc, _events) = service(db.clone(), mock.clone());
        svc.sign_in("token", &profile(42, "alice")).await.unwrap();
        let mut e = test_entry(1, "Alpha");
        e.sync_pending = true;
        db.upsert_anime_entry(&e).unwrap();

        *mock.save_error.lock().unwrap() = Some(TrackerError::Network("offline".into()));
        let out = svc.sign_out().await.unwrap();
        assert_eq!((out.pushed, out.unsent), (0, 1));
        assert!(db.get_settings().unwrap().anilist_token.is_empty());

        svc.sign_in("token", &profile(42, "alice")).await.unwrap();
        *mock.save_error.lock().unwrap() = None;
        let out = svc.sign_out().await.unwrap();
        assert_eq!((out.pushed, out.unsent), (1, 0));
    }

    #[tokio::test]
    async fn a_different_account_wipes_the_previous_list_and_keeps_machine_data() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let mock = Arc::new(MockTracker {
            viewer_id: 7,
            ..Default::default()
        });
        let (svc, events) = service(db.clone(), mock.clone());
        svc.sign_in("token-a", &profile(42, "alice")).await.unwrap();

        let mut a = test_entry(1, "Alpha");
        a.sync_pending = true;
        a.custom_folder = Some("C:/lib/Alpha".into());
        db.upsert_anime_entry(&a).unwrap();
        db.upsert_anime_entry(&test_entry(2, "Beta")).unwrap();
        db.bind_title_alias("alpha alias", 1).unwrap();
        db.delete_entries_with_tombstones(&[2]).unwrap();
        db.record_watch_history(Some(1), "Alpha", 1, "mpv", "alpha-01.mkv", true)
            .unwrap();
        insert_local_file(&db, "C:/lib/alpha-01.mkv", "Alpha", 1, Some(1));
        crate::torrents::config::set_anime_fansubs(&db, 1, vec!["Judas".into()]).unwrap();
        let generation = db.matcher_generation();

        let outcome = svc.sign_in("token-b", &profile(7, "bob")).await.unwrap();
        assert!(outcome.account_switched);
        assert_eq!(outcome.previous_user_id, Some(42));
        assert_eq!(outcome.discarded_changes, 2);
        assert_eq!(db.list_owner().unwrap(), Some(7));
        let settings = db.get_settings().unwrap();
        assert_eq!((settings.anilist_user_id, settings.anilist_token.as_str()), (Some(7), "token-b"));

        // Account data is gone…
        assert!(db.list_anime_entries().unwrap().is_empty());
        assert_eq!(db.count_pending_deletions().unwrap(), 0);
        assert!(db.list_watch_history(10, 0).unwrap().is_empty());
        assert_ne!(db.matcher_generation(), generation);
        assert!(db.matcher_index().unwrap().user_aliases.is_empty());
        // …machine data stays: the indexed file (unmatched) and the torrent config
        assert_eq!(matched_of(&db, "C:/lib/alpha-01.mkv"), None);
        assert_eq!(crate::torrents::config::load_fansubs(&db).unwrap().len(), 1);
        let switched = events
            .lock()
            .unwrap()
            .iter()
            .find(|(n, _)| n == EVENT_ACCOUNT_SWITCHED)
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(switched["discarded_changes"], 2);
        assert_eq!(switched["username"], "bob");

        // The new account's list is imported fresh; nothing from the old account was ever sent
        *mock.remote.lock().unwrap() = vec![test_entry(9, "Bob's anime")];
        let summary = svc.pull("post_auth").await.unwrap();
        assert_eq!(summary.added, 1);
        assert!(mock.saves.lock().unwrap().is_empty());
        assert!(mock.deletes.lock().unwrap().is_empty());
    }

    #[test]
    fn manual_progress_increases_are_logged_once_per_episode() {
        let db = Database::open_in_memory().unwrap();
        let mut e = test_entry(1, "Alpha");
        e.user_status = "CURRENT".into();
        e.user_progress = 3;
        e.episodes = Some(12);
        db.upsert_anime_entry(&e).unwrap();

        // Step 3 → 5 logs episodes 4 and 5
        write_local_change(&db, &UserStateChange { anime_id: 1, ..step(5) }, TODAY, false).unwrap();
        let hist = db.list_watch_history(10, 0).unwrap();
        let mut eps: Vec<u32> = hist.iter().map(|h| h.episode_number).collect();
        eps.sort();
        assert_eq!(eps, vec![4, 5]);
        assert!(hist.iter().all(|h| h.player_name == crate::db::MANUAL_HISTORY_PLAYER));

        assert!(hist.iter().all(|h| h.progress_from.is_none()));

        // A decrease logs one correction row (5 → 2)
        write_local_change(&db, &UserStateChange { anime_id: 1, ..step(2) }, TODAY, false).unwrap();
        let hist = db.list_watch_history(10, 0).unwrap();
        assert_eq!(hist.len(), 3);
        let correction = hist.iter().find(|h| h.progress_from.is_some()).unwrap();
        assert_eq!((correction.progress_from, correction.episode_number), (Some(5), 2));

        // Scrobbles record their own row; the change itself is not logged again
        let scrobble = UserStateChange {
            anime_id: 1,
            progress: Some(3),
            source: ChangeSource::Scrobble,
            ..Default::default()
        };
        write_local_change(&db, &scrobble, TODAY, false).unwrap();
        assert_eq!(db.list_watch_history(10, 0).unwrap().len(), 3);

        // Batch +2 logs per entry
        let patch = BatchAnimeUpdatePatch {
            anime_ids: vec![1],
            user_status: None,
            user_progress: None,
            progress_delta: Some(2),
            mark_completed_progress: None,
            user_score: None,
            user_repeats: None,
            user_notes: None,
            notes_mode: None,
            user_started_at: None,
            user_completed_at: None,
        };
        write_batch_change(&db, &patch, TODAY, false).unwrap();
        assert_eq!(db.list_watch_history(10, 0).unwrap().len(), 5);

        // Batch -1 logs a correction too
        let patch = BatchAnimeUpdatePatch { progress_delta: Some(-1), ..patch };
        write_batch_change(&db, &patch, TODAY, false).unwrap();
        assert_eq!(db.list_watch_history(10, 0).unwrap().len(), 6);

        // Corrections are not watched episodes
        let now = chrono::Utc::now().timestamp();
        assert_eq!(db.watch_history_totals(now - 60, now + 1).unwrap().0, 4);
    }

    #[tokio::test]
    async fn media_metadata_is_fetched_once_then_served_from_store() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let mock = Arc::new(MockTracker::default());
        let (svc, _events) = service(db.clone(), mock.clone());

        let first = svc.media_metadata(42).await.unwrap().unwrap();
        assert_eq!(first.metadata.favourites, Some(7));
        let again = svc.media_metadata(42).await.unwrap().unwrap();
        assert_eq!(again.entry.title_romaji, "Fetched");
        assert_eq!(*mock.metadata_calls.lock().unwrap(), vec![42]);

        // Season fetches write the same store, so their media need no extra request
        *mock.season_media.lock().unwrap() = vec![test_entry(7, "Seasonal")];
        svc.fetch_season("SUMMER", 2025, false).await.unwrap();
        assert_eq!(svc.media_metadata(7).await.unwrap().unwrap().entry.title_romaji, "Seasonal");
        assert_eq!(*mock.metadata_calls.lock().unwrap(), vec![42]);
    }
}
