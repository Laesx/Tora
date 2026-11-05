//! Imported AniList list activity (the History tab's AniList source) and the import's resume state.
//!
//! Only episode activities ("watched episode 1 - 3", "rewatched episode 5") are stored. Each one is kept
//! as is in `anilist_activities` and expanded to one row per episode in `anilist_activity_episodes`, which
//! every query reads. An imported episode is *AniList-only* when no local watched-episode row
//! (`watch_history`, corrections excluded) exists for the same anime and episode: local history always
//! wins ([`ANILIST_ONLY`]). Local entry ids are AniList media ids, so `watch_history.anime_id` compares
//! directly with `media_id`.

use super::{Database, WatchEvent, MANUAL_HISTORY_PLAYER};
use crate::plugins::RemoteListActivity;
use rusqlite::{named_params, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// `app_settings` key of the import's [`AniListHistoryState`]. Kept out of `AppSettings` so a frontend
/// settings save never overwrites the resume point.
pub const ANILIST_HISTORY_STATE_KEY: &str = "anilist_history_import";
/// Episodes stored per activity at most (a bogus "1 - 99999" range must not explode the table).
pub const MAX_EPISODES_PER_ACTIVITY: u32 = 2000;
/// `player_name` of AniList rows in history and Stats events.
pub const ANILIST_HISTORY_PLAYER: &str = "AniList";

/// `e` (an `anilist_activity_episodes` row) has no local watched-episode row, and isn't the echo of a
/// local correction: AniList records a lowered progress by rewriting its recent "watched episode"
/// activity to the new value, so a correction 11 → 10 leaves "watched episode 10" there. An episode a
/// correction landed on, in an activity created up to an hour before it (or after it, when the push
/// was queued), is Tora's own.
const ANILIST_ONLY: &str = "NOT EXISTS (SELECT 1 FROM watch_history w
     WHERE w.anime_id = e.media_id AND w.episode_number = e.episode
       AND (w.progress_from IS NULL OR e.created_at >= w.timestamp_unix - 3600))";

pub(super) fn create_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS anilist_activities (
             id INTEGER PRIMARY KEY,
             media_id INTEGER NOT NULL,
             status TEXT NOT NULL,
             progress_from INTEGER NOT NULL,
             progress_to INTEGER NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_anilist_activities_created ON anilist_activities(created_at, id);
         CREATE INDEX IF NOT EXISTS idx_anilist_activities_media ON anilist_activities(media_id);

         CREATE TABLE IF NOT EXISTS anilist_activity_episodes (
             activity_id INTEGER NOT NULL REFERENCES anilist_activities(id) ON DELETE CASCADE,
             media_id INTEGER NOT NULL,
             episode INTEGER NOT NULL,
             created_at INTEGER NOT NULL,
             PRIMARY KEY (activity_id, episode)
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS idx_anilist_activity_episodes_media
             ON anilist_activity_episodes(media_id, episode);
         CREATE INDEX IF NOT EXISTS idx_anilist_activity_episodes_created
             ON anilist_activity_episodes(created_at);

         CREATE TABLE IF NOT EXISTS anilist_activity_media (
             media_id INTEGER PRIMARY KEY,
             title_romaji TEXT NOT NULL,
             title_english TEXT,
             title_native TEXT,
             cover TEXT NOT NULL DEFAULT '',
             format TEXT,
             episodes INTEGER
         );

         CREATE INDEX IF NOT EXISTS idx_watch_history_anime_episode
             ON watch_history(anime_id, episode_number);",
    )
    .map_err(|e| e.to_string())
}

/// Drop every imported activity and the import state (account switch, "Delete imported history").
pub(super) fn clear_tx(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM anilist_activity_episodes;
         DELETE FROM anilist_activities;
         DELETE FROM anilist_activity_media;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?1",
        params![ANILIST_HISTORY_STATE_KEY],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// "watched episode" / "rewatched episode" with a parsed range; status-only activities are skipped.
pub fn is_episode_activity(a: &RemoteListActivity) -> bool {
    a.status.ends_with("episode") && a.progress_from.is_some() && a.progress_to.is_some()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportStatus {
    /// Never imported (or deleted).
    #[default]
    Idle,
    Running,
    /// Stopped by the user or by an error (`last_error`); resumes from `cursor`.
    Paused,
    /// Reached the oldest activity; later activity arrives through refreshes.
    Done,
}

/// Resume point and progress of the full import, stored under [`ANILIST_HISTORY_STATE_KEY`].
/// The import walks from the newest activity to the oldest.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AniListHistoryState {
    pub status: ImportStatus,
    /// `createdAt` of the oldest activity read so far: the next page asks for older ones.
    pub cursor: Option<i64>,
    /// `createdAt` of the newest activity when the import started (top of the progress bar).
    pub newest_at: Option<i64>,
    /// `createdAt` of the account's oldest activity (bottom of the progress bar).
    pub earliest_at: Option<i64>,
    /// Activities read so far, status-only ones included.
    pub fetched: u32,
    pub last_error: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_refreshed_at: Option<i64>,
}

/// [`AniListHistoryState`] plus what is stored, for the modal / Settings / History header.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AniListHistoryStatus {
    #[serde(flatten)]
    pub state: AniListHistoryState,
    /// An import loop is running right now (`status` alone says Running after a crash too).
    pub active: bool,
    pub activity_count: u32,
    pub episode_count: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistorySource {
    #[default]
    All,
    Local,
    Anilist,
}

/// Keyset position: rows strictly after this one in `(timestamp DESC, kind DESC, id DESC)` order.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HistoryCursor {
    pub ts: i64,
    /// 0 = local, 1 = AniList.
    pub kind: u8,
    pub id: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HistoryQuery {
    pub source: HistorySource,
    /// Only these anime (the fuzzy title search resolved in the frontend).
    pub title_filter: Option<HistoryTitleFilter>,
    /// Only this anime.
    pub media_id: Option<i64>,
    /// Only rows at or after this unix second (the History period).
    pub from: Option<i64>,
    /// Only rows before this unix second.
    pub to: Option<i64>,
    pub before: Option<HistoryCursor>,
    pub limit: u32,
}

/// What a History title search matched. The search is fuzzy, so it runs in the frontend (`lib/fuzzy.ts`,
/// over [`Database::history_titles`]) and the rows are then filtered here, which also covers rows that
/// aren't loaded yet.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HistoryTitleFilter {
    /// Anime ids (`watch_history.anime_id`, `anilist_activities.media_id`).
    pub ids: Vec<i64>,
    /// Logged titles of local rows with no anime id.
    pub titles: Vec<String>,
}

/// One anime's titles in the History, for the title search. `media_id` is `None` for a local row with
/// no anime id, which can only be found by its logged title.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HistoryTitles {
    pub media_id: Option<i64>,
    pub titles: Vec<String>,
}

/// Watched episodes in one local calendar month (the History period picker).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MonthCount {
    /// "YYYY-MM", local time.
    pub month: String,
    pub episodes: u32,
}

/// One History row: a local `watch_history` row (`kind` "local") or an AniList activity reduced to its
/// AniList-only episodes (`kind` "anilist", `episode_from..=episode_to`, `episode_count` of them).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HistoryRow {
    pub kind: &'static str,
    pub id: i64,
    pub anime_id: Option<i64>,
    pub anime_title: String,
    pub episode_from: u32,
    pub episode_to: u32,
    pub episode_count: u32,
    pub player_name: String,
    pub file_name: String,
    pub scrobbled_to_tracker: bool,
    pub timestamp_unix: i64,
    /// Correction rows only (see `WatchHistoryEntry::progress_from`).
    pub progress_from: Option<u32>,
    /// AniList "rewatched episode".
    pub rewatch: bool,
    /// AniList rows: the activity's medium cover (for anime no longer in the list).
    pub cover: Option<String>,
    pub cursor: HistoryCursor,
}

/// One watched episode of one anime, local or AniList-only (the per-anime timeline).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TimelineEpisode {
    pub episode: u32,
    pub timestamp_unix: i64,
    /// "player" | "manual" | "anilist"
    pub source: &'static str,
    pub player_name: String,
    pub rewatch: bool,
    /// AniList merged several episodes into this activity: the time is the activity's, not the episode's.
    pub batch: bool,
}

/// `:filter` (a JSON [`HistoryTitleFilter`], `NULL` = no search). Returns (local `h.`, AniList `a.`).
fn title_filters() -> (&'static str, &'static str) {
    (
        "(:filter IS NULL OR h.anime_id IN (SELECT value FROM json_each(:filter, '$.ids'))
          OR h.anime_title IN (SELECT value FROM json_each(:filter, '$.titles')))",
        "(:filter IS NULL OR a.media_id IN (SELECT value FROM json_each(:filter, '$.ids')))",
    )
}

fn filter_json(filter: Option<&HistoryTitleFilter>) -> Result<Option<String>, String> {
    filter.map(|f| serde_json::to_string(f).map_err(|e| e.to_string())).transpose()
}

/// Imported AniList-only episodes and the oldest one's time (Stats "logged episodes").
pub(super) fn anilist_only_totals(conn: &Connection) -> Result<(u32, Option<i64>), String> {
    conn.query_row(
        &format!(
            "SELECT COUNT(*), MIN(e.created_at) FROM anilist_activity_episodes e WHERE {ANILIST_ONLY}"
        ),
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| e.to_string())
}

/// AniList-only episodes at or after `since` as Stats events (episode duration, 24 min if unknown).
pub(super) fn anilist_only_watch_events(
    conn: &Connection,
    since: i64,
) -> Result<Vec<WatchEvent>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT e.created_at, COALESCE(a.duration, 24)
             FROM anilist_activity_episodes e LEFT JOIN anime_entries a ON a.id = e.media_id
             WHERE e.created_at >= ?1 AND {ANILIST_ONLY}"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![since], |r| {
            Ok(WatchEvent {
                t: r.get(0)?,
                minutes: r.get(1)?,
                player: ANILIST_HISTORY_PLAYER.to_string(),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

impl Database {
    pub fn anilist_history_state(&self) -> Result<AniListHistoryState, String> {
        let conn = self.reader()?;
        read_state(&conn)
    }

    pub fn set_anilist_history_state(&self, state: &AniListHistoryState) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        write_state(&conn, state)
    }

    /// Stored activities and episodes (all of them, AniList-only or not).
    pub fn anilist_history_counts(&self) -> Result<(u32, u32), String> {
        let conn = self.reader()?;
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM anilist_activities), (SELECT COUNT(*) FROM anilist_activity_episodes)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())
    }

    /// `createdAt` of the newest stored activity (refreshes start a little before it).
    pub fn newest_anilist_activity_at(&self) -> Result<Option<i64>, String> {
        let conn = self.reader()?;
        conn.query_row("SELECT MAX(created_at) FROM anilist_activities", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    pub fn clear_anilist_history(&self) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        clear_tx(&tx)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Store one page of activities and, when given, the import state that follows it, in one
    /// transaction (the resume point never runs ahead of the stored rows). Non-episode activities are
    /// skipped; an activity seen before is replaced (AniList grows a merged range in place).
    /// Returns how many episode activities were new or changed.
    pub fn store_anilist_activities(
        &self,
        items: &[RemoteListActivity],
        state: Option<&AniListHistoryState>,
    ) -> Result<usize, String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut written = 0;
        {
            let mut existing = tx
                .prepare_cached(
                    "SELECT progress_from, progress_to, status FROM anilist_activities WHERE id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let mut put_media = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO anilist_activity_media
                       (media_id, title_romaji, title_english, title_native, cover, format, episodes)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(|e| e.to_string())?;
            let mut put_activity = tx
                .prepare_cached(
                    "INSERT OR REPLACE INTO anilist_activities
                       (id, media_id, status, progress_from, progress_to, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(|e| e.to_string())?;
            let mut drop_episodes = tx
                .prepare_cached("DELETE FROM anilist_activity_episodes WHERE activity_id = ?1")
                .map_err(|e| e.to_string())?;
            let mut put_episode = tx
                .prepare_cached(
                    "INSERT OR IGNORE INTO anilist_activity_episodes (activity_id, media_id, episode, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|e| e.to_string())?;

            for a in items.iter().filter(|a| is_episode_activity(a)) {
                let (from, to) = (a.progress_from.unwrap_or(0), a.progress_to.unwrap_or(0));
                let stored: Option<(u32, u32, String)> = existing
                    .query_row(params![a.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .optional()
                    .map_err(|e| e.to_string())?;
                if !a.media.title_romaji.is_empty() {
                    put_media
                        .execute(params![
                            a.media_id,
                            a.media.title_romaji,
                            a.media.title_english,
                            a.media.title_native,
                            a.media.cover,
                            a.media.format,
                            a.media.episodes,
                        ])
                        .map_err(|e| e.to_string())?;
                }
                if stored.as_ref() == Some(&(from, to, a.status.clone())) {
                    continue;
                }
                put_activity
                    .execute(params![a.id, a.media_id, a.status, from, to, a.created_at])
                    .map_err(|e| e.to_string())?;
                drop_episodes.execute(params![a.id]).map_err(|e| e.to_string())?;
                let last = to.min(from.saturating_add(MAX_EPISODES_PER_ACTIVITY - 1));
                for ep in from..=last {
                    put_episode
                        .execute(params![a.id, a.media_id, ep, a.created_at])
                        .map_err(|e| e.to_string())?;
                }
                written += 1;
            }
        }
        if let Some(state) = state {
            write_state(&tx, state)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(written)
    }

    /// One page of the History tab, newest first: local rows, AniList-only rows or both (local wins on
    /// duplicates, per episode). Keyset paginated by [`HistoryRow::cursor`].
    pub fn list_history(&self, query: &HistoryQuery) -> Result<Vec<HistoryRow>, String> {
        let conn = self.reader()?;
        let limit = query.limit.clamp(1, 500);
        let filter = filter_json(query.title_filter.as_ref())?;
        let before = query.before.unwrap_or(HistoryCursor {
            ts: i64::MAX,
            kind: u8::MAX,
            id: i64::MAX,
        });
        let (local_search, remote_search) = title_filters();
        let local = format!(
            "SELECT * FROM (
               SELECT 0 AS kind, h.id, h.anime_id, h.anime_title, h.episode_number AS ep_from,
                      h.episode_number AS ep_to, 1 AS ep_count, h.player_name, h.file_name,
                      h.scrobbled_to_tracker, h.timestamp_unix AS ts, h.progress_from, 0 AS rewatch,
                      NULL AS cover
               FROM watch_history h
               WHERE (h.timestamp_unix < :ts OR (h.timestamp_unix = :ts AND (0 < :kind OR (0 = :kind AND h.id < :id))))
                 AND h.timestamp_unix >= :from AND h.timestamp_unix < :to
                 AND (:mid IS NULL OR h.anime_id = :mid)
                 AND ({local_search})
               ORDER BY h.timestamp_unix DESC, h.id DESC LIMIT :limit)"
        );
        let only = |agg: &str| {
            format!(
                "(SELECT {agg} FROM anilist_activity_episodes e WHERE e.activity_id = a.id AND {ANILIST_ONLY})"
            )
        };
        let remote = format!(
            "SELECT * FROM (
               SELECT 1 AS kind, a.id, a.media_id AS anime_id, COALESCE(m.title_romaji, '') AS anime_title,
                      {} AS ep_from, {} AS ep_to, {} AS ep_count, '{ANILIST_HISTORY_PLAYER}' AS player_name,
                      '' AS file_name, 1 AS scrobbled_to_tracker, a.created_at AS ts, NULL AS progress_from,
                      a.status LIKE 'rewatched%' AS rewatch, m.cover
               FROM anilist_activities a LEFT JOIN anilist_activity_media m ON m.media_id = a.media_id
               WHERE (a.created_at < :ts OR (a.created_at = :ts AND (1 < :kind OR (1 = :kind AND a.id < :id))))
                 AND a.created_at >= :from AND a.created_at < :to
                 AND (:mid IS NULL OR a.media_id = :mid)
                 AND ({remote_search})
                 AND EXISTS (SELECT 1 FROM anilist_activity_episodes e WHERE e.activity_id = a.id AND {ANILIST_ONLY})
               ORDER BY a.created_at DESC, a.id DESC LIMIT :limit)",
            only("MIN(e.episode)"),
            only("MAX(e.episode)"),
            only("COUNT(*)"),
        );
        let union = match query.source {
            HistorySource::Local => local,
            HistorySource::Anilist => remote,
            HistorySource::All => format!("{local} UNION ALL {remote}"),
        };
        let sql = format!("SELECT * FROM ({union}) ORDER BY ts DESC, kind DESC, id DESC LIMIT :limit");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                named_params! {
                    ":ts": before.ts,
                    ":kind": before.kind,
                    ":id": before.id,
                    ":mid": query.media_id,
                    ":from": query.from.unwrap_or(i64::MIN),
                    ":to": query.to.unwrap_or(i64::MAX),
                    ":filter": filter,
                    ":limit": limit,
                },
                |r| {
                    let kind: u8 = r.get(0)?;
                    let id: i64 = r.get(1)?;
                    let ts: i64 = r.get(10)?;
                    Ok(HistoryRow {
                        kind: if kind == 0 { "local" } else { "anilist" },
                        id,
                        anime_id: r.get(2)?,
                        anime_title: r.get(3)?,
                        episode_from: r.get(4)?,
                        episode_to: r.get(5)?,
                        episode_count: r.get(6)?,
                        player_name: r.get(7)?,
                        file_name: r.get(8)?,
                        scrobbled_to_tracker: r.get::<_, i32>(9)? != 0,
                        timestamp_unix: ts,
                        progress_from: r.get(11)?,
                        rewatch: r.get::<_, i32>(12)? != 0,
                        cover: r.get(13)?,
                        cursor: HistoryCursor { ts, kind, id },
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Watched episodes per local calendar month (oldest first) for the History period picker, with the
    /// same source and title filter as [`Self::list_history`]; corrections don't count. Months are
    /// bucketed by SQLite's `localtime`, the OS timezone the webview uses too.
    pub fn history_month_counts(
        &self,
        source: HistorySource,
        filter: Option<&HistoryTitleFilter>,
    ) -> Result<Vec<MonthCount>, String> {
        let conn = self.reader()?;
        let filter = filter_json(filter)?;
        let (local_search, remote_search) = title_filters();
        let local = format!(
            "SELECT strftime('%Y-%m', h.timestamp_unix, 'unixepoch', 'localtime') AS m, COUNT(*) AS n
               FROM watch_history h
              WHERE h.progress_from IS NULL AND {local_search}
              GROUP BY m"
        );
        let remote = format!(
            "SELECT strftime('%Y-%m', e.created_at, 'unixepoch', 'localtime') AS m, COUNT(*) AS n
               FROM anilist_activity_episodes e JOIN anilist_activities a ON a.id = e.activity_id
              WHERE {ANILIST_ONLY} AND {remote_search}
              GROUP BY m"
        );
        let union = match source {
            HistorySource::Local => local,
            HistorySource::Anilist => remote,
            HistorySource::All => format!("{local} UNION ALL {remote}"),
        };
        let sql = format!("SELECT m, SUM(n) FROM ({union}) GROUP BY m ORDER BY m");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(named_params! { ":filter": filter }, |r| {
                Ok(MonthCount {
                    month: r.get(0)?,
                    episodes: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// The titles of every anime in the History: what local rows logged plus the imported media's. The
    /// list entries' titles and synonyms are already in the frontend, which adds them.
    pub fn history_titles(&self) -> Result<Vec<HistoryTitles>, String> {
        let conn = self.reader()?;
        let mut stmt = conn
            .prepare(
                "SELECT anime_id, anime_title FROM watch_history GROUP BY anime_id, anime_title
                 UNION ALL SELECT media_id, title_romaji FROM anilist_activity_media
                 UNION ALL SELECT media_id, title_english FROM anilist_activity_media WHERE title_english IS NOT NULL
                 UNION ALL SELECT media_id, title_native FROM anilist_activity_media WHERE title_native IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut by_id: std::collections::BTreeMap<i64, Vec<String>> = Default::default();
        let mut out = Vec::new();
        for row in rows {
            let (id, title) = row.map_err(|e| e.to_string())?;
            match id {
                Some(id) => {
                    let titles = by_id.entry(id).or_default();
                    if !title.is_empty() && !titles.contains(&title) {
                        titles.push(title);
                    }
                }
                None => out.push(HistoryTitles { media_id: None, titles: vec![title] }),
            }
        }
        out.extend(by_id.into_iter().map(|(id, titles)| HistoryTitles { media_id: Some(id), titles }));
        Ok(out)
    }

    /// Every watched episode of one anime, oldest first: local rows (corrections excluded) and the
    /// AniList-only episodes.
    pub fn history_timeline(&self, media_id: i64) -> Result<Vec<TimelineEpisode>, String> {
        let conn = self.reader()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT episode_number, timestamp_unix, player_name, 0, 0
                   FROM watch_history WHERE anime_id = ?1 AND progress_from IS NULL
                 UNION ALL
                 SELECT e.episode, e.created_at, '{ANILIST_HISTORY_PLAYER}', a.status LIKE 'rewatched%',
                        a.progress_to > a.progress_from
                   FROM anilist_activity_episodes e JOIN anilist_activities a ON a.id = e.activity_id
                   WHERE e.media_id = ?1 AND {ANILIST_ONLY}
                 ORDER BY 2, 1"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![media_id], |r| {
                let player: String = r.get(2)?;
                let source = if player == ANILIST_HISTORY_PLAYER {
                    "anilist"
                } else if player == MANUAL_HISTORY_PLAYER {
                    "manual"
                } else {
                    "player"
                };
                Ok(TimelineEpisode {
                    episode: r.get(0)?,
                    timestamp_unix: r.get(1)?,
                    source,
                    player_name: player,
                    rewatch: r.get::<_, i32>(3)? != 0,
                    batch: r.get::<_, i32>(4)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }
}

fn read_state(conn: &Connection) -> Result<AniListHistoryState, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            params![ANILIST_HISTORY_STATE_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(raw
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}

fn write_state(conn: &Connection, state: &AniListHistoryState) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value_json) VALUES (?1, ?2)",
        params![ANILIST_HISTORY_STATE_KEY, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_entry;
    use crate::plugins::ActivityMedia;

    fn activity(id: i64, media_id: i64, range: Option<(u32, u32)>, at: i64) -> RemoteListActivity {
        RemoteListActivity {
            id,
            media_id,
            status: if range.is_some() { "watched episode" } else { "completed" }.into(),
            progress_from: range.map(|r| r.0),
            progress_to: range.map(|r| r.1),
            created_at: at,
            media: ActivityMedia {
                title_romaji: format!("Remote {}", media_id),
                cover: "https://x/c.jpg".into(),
                ..Default::default()
            },
        }
    }

    fn query(source: HistorySource) -> HistoryQuery {
        HistoryQuery {
            source,
            limit: 50,
            ..Default::default()
        }
    }

    /// Anime 1 "Alpha" in the list with local episodes 1 and 2; AniList has 1–3 of it (one activity)
    /// and 1–2 of anime 2 (not in the list).
    fn seeded() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.upsert_anime_entry(&test_entry(1, "Alpha")).unwrap();
        db.record_watch_history(Some(1), "Alpha", 1, "mpv", "a1.mkv", true).unwrap();
        db.record_manual_progress(&[(1, "Alpha".into(), 1, 2)]).unwrap();
        db.store_anilist_activities(
            &[
                activity(100, 1, Some((1, 3)), 1_000),
                activity(101, 2, Some((1, 2)), 2_000),
                activity(102, 2, None, 2_001),
            ],
            None,
        )
        .unwrap();
        db
    }

    #[test]
    fn local_rows_win_per_episode() {
        let db = seeded();
        let remote = db.list_history(&query(HistorySource::Anilist)).unwrap();
        assert_eq!(remote.len(), 2);
        assert_eq!((remote[0].id, remote[0].episode_from, remote[0].episode_to), (101, 1, 2));
        // Episodes 1–2 of activity 100 are local: only 3 is left
        assert_eq!(
            (remote[1].id, remote[1].episode_from, remote[1].episode_to, remote[1].episode_count),
            (100, 3, 3, 1)
        );
        assert_eq!(remote[1].cover.as_deref(), Some("https://x/c.jpg"));

        let all = db.list_history(&query(HistorySource::All)).unwrap();
        assert_eq!(all.len(), 4);
        assert_eq!(all.iter().filter(|r| r.kind == "local").count(), 2);
        // Local rows are "now", newer than the imported ones
        assert_eq!(all[0].kind, "local");

        // A local row for episode 3 hides the whole activity
        db.record_manual_progress(&[(1, "Alpha".into(), 2, 3)]).unwrap();
        let remote = db.list_history(&query(HistorySource::Anilist)).unwrap();
        assert_eq!(remote.iter().map(|r| r.id).collect::<Vec<_>>(), vec![101]);
        // ...but a correction row is not a watched episode
        db.record_manual_progress(&[(2, "Remote 2".into(), 2, 1)]).unwrap();
        assert_eq!(db.list_history(&query(HistorySource::Anilist)).unwrap().len(), 1);
    }

    #[test]
    fn periods_bound_pages_and_months_count_episodes() {
        // Mid-month noon UTC, so the local month is the same in every timezone
        const MAR: i64 = 1_742_040_000; // 2025-03-15
        const APR: i64 = 1_744_718_400; // 2025-04-15
        const DAY: i64 = 86_400;
        let db = seeded();
        db.store_anilist_activities(
            &[
                activity(300, 2, Some((3, 4)), MAR),
                activity(301, 2, Some((5, 5)), MAR + 60),
                activity(302, 2, Some((6, 6)), APR),
            ],
            None,
        )
        .unwrap();
        let march = |source, before| HistoryQuery {
            from: Some(MAR - 5 * DAY),
            to: Some(APR - 5 * DAY),
            before,
            limit: 1,
            ..query(source)
        };
        let mut seen = vec![];
        let mut before = None;
        while let Some(row) = db.list_history(&march(HistorySource::All, before)).unwrap().first() {
            seen.push(row.id);
            before = Some(row.cursor);
        }
        assert_eq!(seen, vec![301, 300]);
        assert!(db.list_history(&march(HistorySource::Local, None)).unwrap().is_empty());

        let count = |source, id: Option<i64>, month: &str| {
            let filter = id.map(|id| HistoryTitleFilter { ids: vec![id], titles: vec![] });
            db.history_month_counts(source, filter.as_ref())
                .unwrap()
                .into_iter()
                .find(|m| m.month == month)
                .map_or(0, |m| m.episodes)
        };
        let this_month = chrono::Local::now().format("%Y-%m").to_string();
        assert_eq!(count(HistorySource::All, None, "2025-03"), 3);
        assert_eq!(count(HistorySource::Anilist, None, "2025-04"), 1);
        assert_eq!(count(HistorySource::Local, None, "2025-03"), 0);
        assert_eq!(count(HistorySource::Local, None, &this_month), 2);
        assert_eq!(count(HistorySource::All, Some(2), "2025-03"), 3);
        assert_eq!(count(HistorySource::All, Some(1), "2025-03"), 0);

        // A local row for episode 5 takes it out of March (local wins), and corrections never count
        db.record_manual_progress(&[(2, "Remote 2".into(), 4, 5)]).unwrap();
        db.record_manual_progress(&[(2, "Remote 2".into(), 5, 4)]).unwrap();
        assert_eq!(count(HistorySource::All, None, "2025-03"), 2);
        assert_eq!(count(HistorySource::All, None, &this_month), 3);
    }

    #[test]
    fn a_corrections_anilist_echo_is_local() {
        // Progress 10 → 11 → 10 in Tora; AniList rewrote its "watched episode 11" activity to 10
        let db = seeded();
        db.record_manual_progress(&[(1, "Alpha".into(), 10, 11)]).unwrap();
        db.record_manual_progress(&[(1, "Alpha".into(), 11, 10)]).unwrap();
        let now = chrono::Utc::now().timestamp();
        db.store_anilist_activities(&[activity(200, 1, Some((10, 10)), now - 60)], None)
            .unwrap();
        let ids = |src| db.list_history(&query(src)).unwrap().iter().map(|r| r.id).collect::<Vec<_>>();
        assert!(!ids(HistorySource::Anilist).contains(&200));
        assert!(db.history_timeline(1).unwrap().iter().all(|t| t.episode != 10));

        // Episode 10 watched on AniList long before the correction is still AniList's
        db.store_anilist_activities(&[activity(201, 1, Some((10, 10)), now - 86_400)], None)
            .unwrap();
        assert!(ids(HistorySource::Anilist).contains(&201));
    }

    #[test]
    fn history_pages_by_cursor_and_filters_by_title_match() {
        let db = seeded();
        let mut seen = vec![];
        let mut before = None;
        loop {
            let page = db
                .list_history(&HistoryQuery {
                    limit: 1,
                    before,
                    ..query(HistorySource::All)
                })
                .unwrap();
            let Some(row) = page.first() else { break };
            seen.push((row.kind, row.id));
            before = Some(row.cursor);
        }
        assert_eq!(seen.len(), 4);
        let mut unique = seen.clone();
        unique.dedup();
        assert_eq!(unique.len(), 4);

        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO watch_history (anime_id, anime_title, episode_number, player_name, file_name, scrobbled_to_tracker, timestamp_unix)
                 VALUES (NULL, 'Orphan', 1, 'mpv', 'orphan.mkv', 0, 1000)",
                [],
            )
            .unwrap();
        let matching = |ids: &[i64], titles: &[&str]| {
            let filter = HistoryTitleFilter {
                ids: ids.to_vec(),
                titles: titles.iter().map(|t| t.to_string()).collect(),
            };
            db.list_history(&HistoryQuery {
                title_filter: Some(filter),
                ..query(HistorySource::All)
            })
            .unwrap()
            .len()
        };
        assert_eq!(matching(&[1], &[]), 3);
        assert_eq!(matching(&[2], &[]), 1);
        assert_eq!(matching(&[1, 2], &[]), 4);
        assert_eq!(matching(&[], &["Orphan"]), 1);
        assert_eq!(matching(&[2], &["Orphan"]), 2);
        // A search that matched nothing shows nothing; no search shows everything
        assert_eq!(matching(&[], &[]), 0);
        assert_eq!(db.list_history(&query(HistorySource::All)).unwrap().len(), 5);
        // Every source takes the filter
        for source in [HistorySource::Local, HistorySource::Anilist] {
            let filter = HistoryTitleFilter { ids: vec![2], titles: vec![] };
            db.list_history(&HistoryQuery { title_filter: Some(filter.clone()), ..query(source) }).unwrap();
            db.history_month_counts(source, Some(&filter)).unwrap();
        }

        let titles = db.history_titles().unwrap();
        let of = |id| titles.iter().find(|t| t.media_id == id).unwrap().titles.clone();
        assert_eq!(of(None), vec!["Orphan".to_string()]);
        assert!(of(Some(1)).contains(&"Alpha".to_string()));
        assert!(of(Some(2)).contains(&"Remote 2".to_string()));

        let only = db
            .list_history(&HistoryQuery {
                media_id: Some(2),
                ..query(HistorySource::All)
            })
            .unwrap();
        assert_eq!(only.iter().map(|r| r.id).collect::<Vec<_>>(), vec![101]);
    }

    #[test]
    fn timeline_merges_sources_and_marks_batches() {
        let db = seeded();
        let timeline = db.history_timeline(1).unwrap();
        assert_eq!(
            timeline.iter().map(|t| (t.episode, t.source, t.batch)).collect::<Vec<_>>(),
            vec![(3, "anilist", true), (1, "player", false), (2, "manual", false)]
        );
    }

    #[test]
    fn stats_take_anilist_only_episodes_when_asked() {
        let db = seeded();
        let local = db.list_stats(0, false).unwrap();
        assert_eq!(local.logged_episodes, 2);
        let with = db.list_stats(0, true).unwrap();
        assert_eq!(with.logged_episodes, 2 + 3);
        assert_eq!(with.first_logged_at, Some(1_000));
        assert_eq!(with.watch_events.len(), 5);
        assert!(with.watch_events.windows(2).all(|w| w[0].t <= w[1].t));
        assert_eq!(with.watch_events.iter().filter(|e| e.player == ANILIST_HISTORY_PLAYER).count(), 3);
    }

    #[test]
    fn account_switch_and_clear_drop_imported_history() {
        let db = seeded();
        db.set_anilist_history_state(&AniListHistoryState {
            status: ImportStatus::Done,
            ..Default::default()
        })
        .unwrap();
        db.reset_for_account_switch(9).unwrap();
        assert_eq!(db.anilist_history_counts().unwrap(), (0, 0));
        assert_eq!(db.anilist_history_state().unwrap().status, ImportStatus::Idle);
    }

    #[test]
    fn huge_ranges_are_capped() {
        let db = Database::open_in_memory().unwrap();
        db.store_anilist_activities(&[activity(1, 5, Some((1, 99_999)), 10)], None).unwrap();
        assert_eq!(db.anilist_history_counts().unwrap(), (1, MAX_EPISODES_PER_ACTIVITY));
    }
}
