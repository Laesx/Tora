//! Torrents: cached RSS feeds, the anime-card board with auto-selection, and launching the user's torrent
//! application. General feeds are only fetched on Refresh or by the background interval (searches on a cache
//! miss); everything else (matching, filters, priority, selection) is recomputed from the RAM cache on every
//! board read.

pub mod board;
pub mod client;
pub mod config;
pub mod feed;
pub mod query;
pub mod traits;

use crate::db::{AnimeEntry, Database};
use board::{build_board, BoardInput, FeedRelease, TorrentBoard};
use feed::RawRelease;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

/// Pause between consecutive feed requests (Nyaa rate limits bursts).
const FETCH_GAP: std::time::Duration = std::time::Duration::from_millis(800);

#[derive(Debug, Clone)]
struct CachedFeed {
    fetched_at: i64,
    items: Arc<Vec<RawRelease>>,
    error: Option<String>,
}

/// In-memory feed cache (survives tab switches, not restarts) plus the releases sent this session.
pub struct TorrentCache {
    /// By feed URL.
    feeds: RwLock<HashMap<String, CachedFeed>>,
    /// Only the last ad-hoc search: (full search URL, result).
    search: RwLock<Option<(String, CachedFeed)>>,
    /// Release keys handed to the torrent client this session (never auto-selected again).
    sent: Mutex<HashSet<String>>,
    /// `.torrent` files are saved here before launching the client.
    torrent_dir: PathBuf,
    /// Serializes fetches so a manual Refresh and the background loop never hit a site twice at once.
    fetch_lock: tokio::sync::Mutex<()>,
}

/// What the board shows: the user's feeds (all enabled, or the ticked ones) or a search.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BoardSource {
    #[serde(default)]
    pub feed_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub search: Option<String>,
    /// Search feed to search with (`None` = the one chosen in board options).
    #[serde(default)]
    pub search_feed_id: Option<i64>,
    /// Anime the search was started from (its card goes first).
    #[serde(default)]
    pub anime_id: Option<i64>,
}

/// A release to download, as the board sent it.
#[derive(Debug, Clone, Deserialize)]
pub struct DownloadRequest {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub torrent_url: String,
    #[serde(default)]
    pub magnet_url: String,
    pub anime_id: Option<i64>,
    #[serde(default)]
    pub parsed_title: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadResult {
    pub key: String,
    pub ok: bool,
    pub message: String,
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadSummary {
    pub results: Vec<DownloadResult>,
    pub app: client::DetectedApp,
    /// Anime whose `custom_folder` was set to a new download folder.
    pub bound_anime_ids: Vec<i64>,
}

/// `.torrent` files older than this are removed at startup (the client has its own copy by then).
const TORRENT_FILE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);

fn prune_torrent_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > TORRENT_FILE_MAX_AGE);
        if old && path.extension().is_some_and(|x| x.eq_ignore_ascii_case("torrent")) {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl TorrentCache {
    pub fn new(torrent_dir: PathBuf) -> Self {
        prune_torrent_files(&torrent_dir);
        Self {
            feeds: RwLock::new(HashMap::new()),
            search: RwLock::new(None),
            sent: Mutex::new(HashSet::new()),
            torrent_dir,
            fetch_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn sent_keys(&self) -> HashSet<String> {
        self.sent.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn cached(&self, url: &str) -> Option<CachedFeed> {
        self.feeds.read().ok()?.get(url).cloned()
    }

    /// Fetches `url` (keeping the previous items when the fetch fails) and caches the result.
    async fn fetch_into_cache(&self, url: &str) -> CachedFeed {
        let now = chrono::Utc::now().timestamp();
        let entry = match feed::fetch_feed(url).await {
            Ok(items) => CachedFeed { fetched_at: now, items: Arc::new(items), error: None },
            Err(e) => CachedFeed {
                fetched_at: now,
                items: self.cached(url).map(|c| c.items).unwrap_or_default(),
                error: Some(e),
            },
        };
        if let Ok(mut feeds) = self.feeds.write() {
            feeds.insert(url.to_string(), entry.clone());
        }
        entry
    }

    /// Fetches the given feeds: all of them with `force`, otherwise the ones older than `max_age_secs`, plus
    /// never-fetched ones when `include_uncached`. Returns how many were fetched.
    async fn refresh(
        &self,
        feeds: &[config::TorrentFeed],
        force: bool,
        max_age_secs: Option<i64>,
        include_uncached: bool,
    ) -> usize {
        let _guard = self.fetch_lock.lock().await;
        let now = chrono::Utc::now().timestamp();
        let mut fetched = 0;
        for f in feeds {
            let url = f.url.clone();
            let due = force
                || match self.cached(&url) {
                    None => include_uncached,
                    Some(c) => max_age_secs.is_some_and(|age| now - c.fetched_at >= age),
                };
            if !due {
                continue;
            }
            if fetched > 0 {
                tokio::time::sleep(FETCH_GAP).await;
            }
            self.fetch_into_cache(&url).await;
            fetched += 1;
        }
        fetched
    }

    /// Searches `url` (a filled-in search feed template); the same URL is served from RAM unless `force`.
    async fn search(&self, url: &str, force: bool) -> CachedFeed {
        if !force {
            if let Some((cached_url, cached)) = self.search.read().ok().and_then(|s| s.clone()) {
                if cached_url == url {
                    return cached;
                }
            }
        }
        let _guard = self.fetch_lock.lock().await;
        let now = chrono::Utc::now().timestamp();
        let entry = match feed::fetch_feed(url).await {
            Ok(items) => CachedFeed { fetched_at: now, items: Arc::new(items), error: None },
            Err(e) => CachedFeed { fetched_at: now, items: Arc::default(), error: Some(e) },
        };
        if let Ok(mut s) = self.search.write() {
            *s = Some((url.to_string(), entry.clone()));
        }
        entry
    }
}

fn selected_feeds(all: Vec<config::TorrentFeed>, ids: Option<&Vec<i64>>) -> Vec<config::TorrentFeed> {
    all.into_iter()
        .filter(|f| match ids {
            Some(ids) => ids.contains(&f.id),
            None => f.enabled,
        })
        .collect()
}

/// Merges feeds into one release list, de-duplicated by info hash (feed names are unioned).
fn merge(sources: &[(String, Arc<Vec<RawRelease>>)]) -> Vec<FeedRelease> {
    let mut out: Vec<FeedRelease> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for (name, items) in sources {
        for r in items.iter() {
            let key = r.key();
            match index.get(&key) {
                Some(&i) => {
                    if !out[i].feeds.contains(name) {
                        out[i].feeds.push(name.clone());
                    }
                }
                None => {
                    index.insert(key, out.len());
                    out.push(FeedRelease { release: r.clone(), feeds: vec![name.clone()] });
                }
            }
        }
    }
    out
}

fn build_from_sources(
    db: &Database,
    cache: &TorrentCache,
    sources: &[(String, Arc<Vec<RawRelease>>)],
    focus_anime_id: Option<i64>,
) -> Result<TorrentBoard, String> {
    let start = std::time::Instant::now();
    let releases = merge(sources);
    let entries: HashMap<i64, AnimeEntry> = db
        .list_anime_entries()?
        .into_iter()
        .map(|e| (e.id, e))
        .collect();
    let matcher = db.matcher_index().ok();
    let filters = config::load_filters(db)?;
    let priority = config::load_priority(db)?;
    let fansubs = config::load_fansubs(db)?;
    let options = config::load_board_options(db)?;
    let sent = cache.sent_keys();
    let board = build_board(&BoardInput {
        releases: &releases,
        entries: &entries,
        matcher: matcher.as_deref(),
        filters: &filters,
        priority: &priority,
        fansubs: &fansubs,
        sent: &sent,
        focus_anime_id,
        hidden_statuses: &options.hidden_statuses,
    });
    log::info!(
        target: "torrents",
        "board: {} releases, {} distinct titles ({} fuzzy hits), {} cards in {} ms",
        releases.len(),
        board.match_stats.titles,
        board.match_stats.fuzzy_hits,
        board.cards.len(),
        start.elapsed().as_millis()
    );
    Ok(board)
}

/// The board for `source`. General feeds are fetched only with `force` (Refresh); otherwise the board is
/// built from what is cached and lists the never-fetched feeds in `unfetched`. A search fetches on a miss.
pub async fn get_board(
    db: Arc<Database>,
    cache: Arc<TorrentCache>,
    source: BoardSource,
    force: bool,
) -> Result<TorrentBoard, String> {
    let mut unfetched = Vec::new();
    let (sources, fetched_at, errors) = if let Some(q) = source.search.as_deref().filter(|q| !q.trim().is_empty()) {
        let db_c = db.clone();
        let requested = source.search_feed_id;
        let search_feed = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let feeds = config::load_search_feeds(&db_c)?;
            let chosen = requested.or(config::load_board_options(&db_c)?.search_feed_id);
            Ok(config::resolve_search_feed(&feeds, chosen))
        })
        .await
        .map_err(|e| e.to_string())??;
        let result = cache.search(&feed::search_url(&search_feed.url, q), force).await;
        let errors = result
            .error
            .iter()
            .map(|e| format!("{}: {}", search_feed.name, e))
            .collect::<Vec<_>>();
        let label = format!("Search ({}): {}", search_feed.name, q.trim());
        (vec![(label, result.items)], Some(result.fetched_at), errors)
    } else {
        let db_c = db.clone();
        let feeds = tokio::task::spawn_blocking(move || config::load_feeds(&db_c))
            .await
            .map_err(|e| e.to_string())??;
        let feeds = selected_feeds(feeds, source.feed_ids.as_ref());
        if force {
            cache.refresh(&feeds, true, None, true).await;
        }
        let mut sources = Vec::new();
        let mut errors = Vec::new();
        let mut oldest: Option<i64> = None;
        for f in &feeds {
            match cache.cached(&f.url) {
                Some(c) => {
                    if let Some(e) = &c.error {
                        errors.push(format!("{}: {}", f.name, e));
                    }
                    oldest = Some(oldest.map_or(c.fetched_at, |o| o.min(c.fetched_at)));
                    sources.push((f.name.clone(), c.items));
                }
                None => unfetched.push(f.name.clone()),
            }
        }
        (sources, oldest, errors)
    };
    let focus = source.anime_id;
    let mut board = tokio::task::spawn_blocking(move || build_from_sources(&db, &cache, &sources, focus))
        .await
        .map_err(|e| e.to_string())??;
    board.fetched_at = fetched_at;
    board.errors = errors;
    board.unfetched = unfetched;
    Ok(board)
}

/// Parent folders of an anime's indexed episodes.
fn episode_dirs(db: &Database, anime_id: i64) -> Vec<String> {
    db.list_local_episodes(Some(anime_id))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| Path::new(&f.file_path).parent().map(|p| p.to_string_lossy().to_string()))
        .collect()
}

/// Resolves folders (creating / binding new per-anime folders), fetches `.torrent` files (magnet fallback)
/// and launches the torrent application once per folder.
pub async fn download_releases(
    db: Arc<Database>,
    cache: Arc<TorrentCache>,
    requests: Vec<DownloadRequest>,
) -> Result<DownloadSummary, String> {
    let db_c = db.clone();
    let reqs = requests.clone();
    let (settings, plans) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let settings = db_c.get_settings()?;
        let mut entries: HashMap<i64, Option<AnimeEntry>> = HashMap::new();
        let mut plans = Vec::new();
        for r in &reqs {
            let anime = match r.anime_id {
                Some(id) => entries
                    .entry(id)
                    .or_insert_with(|| db_c.get_anime_entry_by_id(id).ok())
                    .clone(),
                None => None,
            };
            let dirs = anime.as_ref().map(|a| episode_dirs(&db_c, a.id)).unwrap_or_default();
            let mut target = client::resolve_save_target(anime.as_ref(), &dirs, &r.parsed_title, &settings);
            let mut error = None;
            if let (true, Some(dir)) = (target.create, target.dir.as_ref()) {
                if let Err(e) = std::fs::create_dir_all(dir) {
                    error = Some(format!("Couldn't create {}: {}", dir, e));
                }
            }
            if error.is_none() {
                if let (Some(aid), Some(dir)) = (target.bind_anime, target.dir.as_ref()) {
                    if db_c.set_custom_folder_if_empty(aid, dir)? {
                        // Later requests for the same anime see the new folder.
                        if let Some(Some(a)) = entries.get_mut(&aid) {
                            a.custom_folder = Some(dir.clone());
                        }
                    } else {
                        target.bind_anime = None;
                    }
                }
            }
            plans.push((target, error));
        }
        Ok((settings, plans))
    })
    .await
    .map_err(|e| e.to_string())??;

    let app = client::detect_app(&settings.torrent_app_path);
    let mut results = Vec::new();
    let mut groups: Vec<(Option<String>, Vec<String>)> = Vec::new();
    let mut launched_keys: Vec<(usize, String)> = Vec::new();
    let mut bound = Vec::new();
    for (req, (target, error)) in requests.iter().zip(plans) {
        if let Some(e) = error {
            results.push(DownloadResult { key: req.key.clone(), ok: false, message: e, folder: target.dir });
            continue;
        }
        if let Some(aid) = target.bind_anime {
            bound.push(aid);
        }
        let file = if req.torrent_url.trim().is_empty() {
            Err("no .torrent link".to_string())
        } else {
            client::download_torrent_file(&req.torrent_url, &req.title, &cache.torrent_dir).await
        };
        let item = match file {
            Ok(path) => path.to_string_lossy().to_string(),
            Err(_) if !req.magnet_url.trim().is_empty() => req.magnet_url.clone(),
            Err(e) => {
                results.push(DownloadResult { key: req.key.clone(), ok: false, message: e, folder: target.dir });
                continue;
            }
        };
        let gi = match groups.iter().position(|(d, _)| *d == target.dir) {
            Some(i) => i,
            None => {
                groups.push((target.dir.clone(), Vec::new()));
                groups.len() - 1
            }
        };
        groups[gi].1.push(item);
        launched_keys.push((results.len(), req.key.clone()));
        results.push(DownloadResult {
            key: req.key.clone(),
            ok: true,
            message: format!("Sent to {}", app.label),
            folder: target.dir,
        });
    }

    if !groups.is_empty() {
        if let Err(e) = client::launch(&app, &settings.torrent_category, groups).await {
            for (i, _) in &launched_keys {
                results[*i].ok = false;
                results[*i].message = e.clone();
            }
            launched_keys.clear();
        }
    }
    if let Ok(mut sent) = cache.sent.lock() {
        sent.extend(launched_keys.into_iter().map(|(_, k)| k));
    }
    bound.sort();
    bound.dedup();
    for r in results.iter().filter(|r| !r.ok) {
        log::warn!(target: "torrents", "download {} failed: {}", r.key, r.message);
    }
    log::info!(
        target: "torrents",
        "sent {}/{} releases to {} ({})",
        results.iter().filter(|r| r.ok).count(),
        results.len(),
        if app.label.is_empty() { "the default handler" } else { app.label.as_str() },
        app.source
    );
    Ok(DownloadSummary { results, app, bound_anime_ids: bound })
}

/// Background refresh: every minute, fetches enabled feeds older than `torrent_refresh_minutes` (0 = never),
/// emits `torrent-feeds-refreshed`, and with `torrent_auto_download` sends the auto-selected releases.
/// Never-fetched feeds are left for the user's first Refresh, unless auto-download needs them.
pub fn spawn_refresh_loop(
    db: Arc<Database>,
    cache: Arc<TorrentCache>,
    emit: Arc<dyn Fn(&str, Value) + Send + Sync>,
) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        tick.tick().await;
        loop {
            tick.tick().await;
            let db_c = db.clone();
            let Ok(Ok((settings, feeds))) = tokio::task::spawn_blocking(move || -> Result<_, String> {
                Ok((db_c.get_settings()?, config::load_feeds(&db_c)?))
            })
            .await
            else {
                continue;
            };
            if settings.torrent_refresh_minutes == 0 {
                continue;
            }
            let feeds = selected_feeds(feeds, None);
            let max_age = settings.torrent_refresh_minutes as i64 * 60;
            if cache.refresh(&feeds, false, Some(max_age), settings.torrent_auto_download).await == 0 {
                continue;
            }
            emit("torrent-feeds-refreshed", json!({ "at": chrono::Utc::now().timestamp() }));
            if !settings.torrent_auto_download {
                continue;
            }
            let Ok(board) = get_board(db.clone(), cache.clone(), BoardSource::default(), false).await else {
                continue;
            };
            let requests: Vec<DownloadRequest> = board
                .cards
                .iter()
                .flat_map(|c| {
                    c.releases.iter().filter(|r| r.selected).map(move |r| DownloadRequest {
                        key: r.key.clone(),
                        title: r.title.clone(),
                        torrent_url: r.torrent_url.clone(),
                        magnet_url: r.magnet_url.clone(),
                        anime_id: c.anime_id,
                        parsed_title: r.parsed_title.clone(),
                    })
                })
                .collect();
            if requests.is_empty() {
                continue;
            }
            let titles: Vec<String> = requests.iter().map(|r| r.title.clone()).collect();
            match download_releases(db.clone(), cache.clone(), requests).await {
                Ok(summary) => emit(
                    "torrent-auto-downloaded",
                    json!({
                        "count": summary.results.iter().filter(|r| r.ok).count(),
                        "failed": summary.results.iter().filter(|r| !r.ok).map(|r| r.message.clone()).collect::<Vec<_>>(),
                        "titles": titles,
                        "bound_anime_ids": summary.bound_anime_ids,
                    }),
                ),
                Err(e) => emit("torrent-auto-downloaded", json!({ "count": 0, "failed": [e], "titles": [] })),
            }
        }
    });
}
