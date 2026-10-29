//! User torrent config: feeds, filters, release-priority tiers and per-anime fansub overrides. Each list
//! is one JSON value under its own `app_settings` key (see `db::settings`), kept out of `AppSettings` so a
//! stale Settings-view save can never overwrite what the Torrents tab just edited.

use crate::db::{
    Database, TORRENT_BOARD_OPTIONS_KEY, TORRENT_FANSUBS_KEY, TORRENT_FEEDS_KEY, TORRENT_FILTERS_KEY,
    TORRENT_PRIORITY_KEY, TORRENT_SEARCH_FEEDS_KEY,
};
use super::feed::{has_title_placeholder, is_feed_url, normalize_url, nyaa_url, url_host, NYAA_SEARCH_DEFAULT};
use serde::{Deserialize, Serialize};

/// A general feed: any RSS 2.0 torrent feed (Nyaa, SubsPlease, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TorrentFeed {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
    /// Feeds saved before feeds were plain URLs were Nyaa query / category / filter fields; `load_feeds`
    /// turns them into their Nyaa URL and the next save drops them.
    #[serde(default, skip_serializing, rename = "query")]
    legacy_query: String,
    #[serde(default, skip_serializing, rename = "category")]
    legacy_category: String,
    #[serde(default, skip_serializing, rename = "filter")]
    legacy_filter: u8,
}

impl TorrentFeed {
    pub fn new(name: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            id: 0,
            name: name.into(),
            enabled: true,
            url: url.into(),
            legacy_query: String::new(),
            legacy_category: String::new(),
            legacy_filter: 0,
        }
    }
}

/// A search feed: a URL template where `%title%` becomes the searched anime's title.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchFeed {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterAction {
    /// Hidden and never selected.
    Discard,
    /// Candidate for auto-selection even when the built-in rule would skip it.
    Select,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TorrentFilter {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub action: FilterAction,
    /// Text query (see `torrents::query`); the form editor edits the same string.
    pub query: String,
    /// List entries the filter applies to; empty = every release.
    #[serde(default)]
    pub anime_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriorityTier {
    #[serde(default)]
    pub id: i64,
    pub query: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Global release priority: for each (anime, episode) the first tier with a matching release wins.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriorityConfig {
    pub tiers: Vec<PriorityTier>,
    /// When no tier matches: pick the best other release (`true`) or select nothing.
    #[serde(default = "default_true")]
    pub fallback_to_best: bool,
}

/// Ordered release groups for one anime; replaces the global tiers for it, with no fallback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FansubOverride {
    pub anime_id: i64,
    pub groups: Vec<String>,
}

/// Board-wide display options.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardOptions {
    /// List statuses (`PLANNING`, `DROPPED`, …) whose anime get no card at all: their releases are neither
    /// shown nor selected. A searched-for anime is still shown.
    #[serde(default = "default_hidden_statuses")]
    pub hidden_statuses: Vec<String>,
    /// Search feed used by searches (the dropdown next to the search box); `None` / deleted = the first one.
    #[serde(default)]
    pub search_feed_id: Option<i64>,
}

pub const LIST_STATUSES: [&str; 6] = ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"];

fn default_hidden_statuses() -> Vec<String> {
    vec!["PLANNING".into(), "DROPPED".into()]
}

impl Default for BoardOptions {
    fn default() -> Self {
        Self { hidden_statuses: default_hidden_statuses(), search_feed_id: None }
    }
}

fn default_true() -> bool {
    true
}

pub fn default_feeds() -> Vec<TorrentFeed> {
    vec![TorrentFeed {
        id: 1,
        ..TorrentFeed::new("Nyaa – English-translated", nyaa_url("", "1_2", 0))
    }]
}

pub fn default_search_feeds() -> Vec<SearchFeed> {
    vec![
        SearchFeed { id: 1, name: "Nyaa – English-translated".into(), url: NYAA_SEARCH_DEFAULT.into() },
        SearchFeed {
            id: 2,
            name: "Nyaa – All categories".into(),
            url: "https://nyaa.si/?page=rss&c=0_0&f=0&q=%title%".into(),
        },
    ]
}

pub const DEFAULT_PRIORITY_GROUPS: [&str; 6] =
    ["Judas", "Erai-raws", "SubsPlease", "ASW", "EMBER", "ToonsHub"];

pub fn default_priority() -> PriorityConfig {
    PriorityConfig {
        tiers: DEFAULT_PRIORITY_GROUPS
            .iter()
            .enumerate()
            .map(|(i, g)| PriorityTier {
                id: i as i64 + 1,
                query: format!("group:{}", super::query::quote_value(g)),
                enabled: true,
            })
            .collect(),
        fallback_to_best: true,
    }
}

/// Gives every id-0 item a fresh id (max + 1), keeping existing ids stable.
fn assign_ids<T>(items: &mut [T], id: impl Fn(&mut T) -> &mut i64) {
    let mut next = items.iter_mut().map(|x| *id(x)).max().unwrap_or(0).max(0) + 1;
    for item in items.iter_mut() {
        let slot = id(item);
        if *slot <= 0 {
            *slot = next;
            next += 1;
        }
    }
}

pub fn load_feeds(db: &Database) -> Result<Vec<TorrentFeed>, String> {
    let mut feeds: Vec<TorrentFeed> = db.get_config_json(TORRENT_FEEDS_KEY)?.unwrap_or_else(default_feeds);
    for f in feeds.iter_mut() {
        if f.url.trim().is_empty() {
            f.url = nyaa_url(&f.legacy_query, &f.legacy_category, f.legacy_filter);
        }
    }
    Ok(feeds)
}

pub fn save_feeds(db: &Database, mut feeds: Vec<TorrentFeed>) -> Result<Vec<TorrentFeed>, String> {
    for f in feeds.iter_mut() {
        f.url = normalize_url(&f.url);
        if !is_feed_url(&f.url) {
            return Err(format!("Feed \"{}\": \"{}\" is not an http(s) RSS URL", f.name.trim(), f.url));
        }
        f.name = f.name.trim().to_string();
        if f.name.is_empty() {
            f.name = url_host(&f.url);
        }
    }
    assign_ids(&mut feeds, |f| &mut f.id);
    db.set_config_json(TORRENT_FEEDS_KEY, &feeds)?;
    Ok(feeds)
}

pub fn load_search_feeds(db: &Database) -> Result<Vec<SearchFeed>, String> {
    let feeds: Vec<SearchFeed> = db.get_config_json(TORRENT_SEARCH_FEEDS_KEY)?.unwrap_or_default();
    Ok(if feeds.is_empty() { default_search_feeds() } else { feeds })
}

pub fn save_search_feeds(db: &Database, mut feeds: Vec<SearchFeed>) -> Result<Vec<SearchFeed>, String> {
    for f in feeds.iter_mut() {
        f.url = normalize_url(&f.url);
        f.name = f.name.trim().to_string();
        if !is_feed_url(&f.url) {
            return Err(format!("Search feed \"{}\": \"{}\" is not an http(s) RSS URL", f.name, f.url));
        }
        if !has_title_placeholder(&f.url) {
            return Err(format!("Search feed \"{}\" needs %title% in its URL", f.name));
        }
        if f.name.is_empty() {
            f.name = url_host(&f.url);
        }
    }
    assign_ids(&mut feeds, |f| &mut f.id);
    db.set_config_json(TORRENT_SEARCH_FEEDS_KEY, &feeds)?;
    Ok(feeds)
}

/// The search feed searches use: `id` if it still exists, else the first one.
pub fn resolve_search_feed(feeds: &[SearchFeed], id: Option<i64>) -> SearchFeed {
    id.and_then(|id| feeds.iter().find(|f| f.id == id))
        .or_else(|| feeds.first())
        .cloned()
        .unwrap_or_else(|| default_search_feeds().remove(0))
}

pub fn load_filters(db: &Database) -> Result<Vec<TorrentFilter>, String> {
    Ok(db.get_config_json(TORRENT_FILTERS_KEY)?.unwrap_or_default())
}

pub fn save_filters(db: &Database, mut filters: Vec<TorrentFilter>) -> Result<Vec<TorrentFilter>, String> {
    for f in filters.iter_mut() {
        f.query = super::query::Query::parse(&f.query)
            .map_err(|e| format!("Filter \"{}\": {}", f.name, e))?
            .to_string();
        if f.name.trim().is_empty() {
            f.name = f.query.clone();
        }
    }
    assign_ids(&mut filters, |f| &mut f.id);
    db.set_config_json(TORRENT_FILTERS_KEY, &filters)?;
    Ok(filters)
}

pub fn load_priority(db: &Database) -> Result<PriorityConfig, String> {
    Ok(db.get_config_json(TORRENT_PRIORITY_KEY)?.unwrap_or_else(default_priority))
}

pub fn save_priority(db: &Database, mut priority: PriorityConfig) -> Result<PriorityConfig, String> {
    for t in priority.tiers.iter_mut() {
        t.query = super::query::Query::parse(&t.query)
            .map_err(|e| format!("Priority tier \"{}\": {}", t.query, e))?
            .to_string();
    }
    priority.tiers.retain(|t| !t.query.is_empty());
    assign_ids(&mut priority.tiers, |t| &mut t.id);
    db.set_config_json(TORRENT_PRIORITY_KEY, &priority)?;
    Ok(priority)
}

pub fn load_board_options(db: &Database) -> Result<BoardOptions, String> {
    Ok(db.get_config_json(TORRENT_BOARD_OPTIONS_KEY)?.unwrap_or_default())
}

pub fn save_board_options(db: &Database, mut options: BoardOptions) -> Result<BoardOptions, String> {
    options.hidden_statuses = LIST_STATUSES
        .iter()
        .filter(|s| options.hidden_statuses.iter().any(|h| h.eq_ignore_ascii_case(s)))
        .map(|s| s.to_string())
        .collect();
    db.set_config_json(TORRENT_BOARD_OPTIONS_KEY, &options)?;
    Ok(options)
}

pub fn load_fansubs(db: &Database) -> Result<Vec<FansubOverride>, String> {
    Ok(db.get_config_json(TORRENT_FANSUBS_KEY)?.unwrap_or_default())
}

/// Replaces one anime's fansub list (empty `groups` removes the override).
pub fn set_anime_fansubs(db: &Database, anime_id: i64, groups: Vec<String>) -> Result<Vec<FansubOverride>, String> {
    let mut all = load_fansubs(db)?;
    let mut seen = std::collections::HashSet::new();
    let groups: Vec<String> = groups
        .into_iter()
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty() && seen.insert(g.to_lowercase()))
        .collect();
    all.retain(|o| o.anime_id != anime_id);
    if !groups.is_empty() {
        all.push(FansubOverride { anime_id, groups });
    }
    db.set_config_json(TORRENT_FANSUBS_KEY, &all)?;
    Ok(all)
}

/// A row of the removed `torrent_rules` table.
#[derive(Debug, Clone)]
pub struct LegacyRule {
    pub name: String,
    pub enabled: bool,
    pub anime_title_filter: String,
    pub anime_id: Option<i64>,
    pub release_group: String,
    pub resolution: String,
    pub exclude_keywords: String,
    pub action: String,
    pub only_unwatched: bool,
}

/// What the old rules become: filters, extra priority tiers and fansub overrides.
#[derive(Debug, Default)]
pub struct LegacyConversion {
    pub filters: Vec<TorrentFilter>,
    pub tier_groups: Vec<String>,
    pub fansubs: Vec<FansubOverride>,
}

/// discard → Discard filter; auto_download → Select filter; highlight naming a group (and nothing else) →
/// a priority tier; any non-discard rule with an anime and a group → that anime's fansub override.
pub fn convert_legacy_rules(rules: &[LegacyRule]) -> LegacyConversion {
    use super::query::quote_value;
    let mut out = LegacyConversion::default();
    for r in rules {
        let group = r.release_group.trim();
        let title = r.anime_title_filter.trim();
        let res = r.resolution.trim();
        if r.action != "discard" && !group.is_empty() {
            if let Some(aid) = r.anime_id {
                if let Some(o) = out.fansubs.iter_mut().find(|o| o.anime_id == aid) {
                    o.groups.push(group.to_string());
                } else {
                    out.fansubs.push(FansubOverride { anime_id: aid, groups: vec![group.to_string()] });
                }
            }
        }
        let action = match r.action.as_str() {
            "discard" => FilterAction::Discard,
            "auto_download" => FilterAction::Select,
            _ => {
                if !group.is_empty() && r.anime_id.is_none() && title.is_empty() {
                    out.tier_groups.push(group.to_string());
                }
                continue;
            }
        };
        let mut terms = Vec::new();
        if !title.is_empty() {
            terms.push(format!("title:{}", quote_value(title)));
        }
        if !group.is_empty() {
            terms.push(format!("group:{}", quote_value(group)));
        }
        if !res.is_empty() && !res.eq_ignore_ascii_case("any") {
            terms.push(format!("res:{}", quote_value(res)));
        }
        for kw in r.exclude_keywords.split(',').map(str::trim).filter(|k| !k.is_empty()) {
            terms.push(format!("-{}", quote_value(kw)));
        }
        if r.only_unwatched && action == FilterAction::Select {
            terms.push("new:yes".into());
        }
        if terms.is_empty() {
            continue;
        }
        out.filters.push(TorrentFilter {
            id: 0,
            name: r.name.clone(),
            enabled: r.enabled,
            action,
            query: terms.join(" "),
            anime_ids: r.anime_id.into_iter().collect(),
        });
    }
    out
}

/// Merges converted legacy rules into the stored config (called once, before `torrent_rules` is dropped).
pub fn apply_legacy_conversion(db: &Database, conv: LegacyConversion) -> Result<(), String> {
    if !conv.filters.is_empty() {
        let mut filters = load_filters(db)?;
        filters.extend(conv.filters);
        assign_ids(&mut filters, |f| &mut f.id);
        db.set_config_json(TORRENT_FILTERS_KEY, &filters)?;
    }
    if !conv.tier_groups.is_empty() {
        let mut priority = load_priority(db)?;
        for g in conv.tier_groups {
            let q = format!("group:{}", super::query::quote_value(&g));
            if !priority.tiers.iter().any(|t| t.query.eq_ignore_ascii_case(&q)) {
                priority.tiers.push(PriorityTier { id: 0, query: q, enabled: true });
            }
        }
        assign_ids(&mut priority.tiers, |t| &mut t.id);
        db.set_config_json(TORRENT_PRIORITY_KEY, &priority)?;
    }
    for o in conv.fansubs {
        let mut groups = load_fansubs(db)?
            .into_iter()
            .find(|x| x.anime_id == o.anime_id)
            .map(|x| x.groups)
            .unwrap_or_default();
        groups.extend(o.groups);
        set_anime_fansubs(db, o.anime_id, groups)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str, action: &str, group: &str, anime_id: Option<i64>) -> LegacyRule {
        LegacyRule {
            name: name.into(),
            enabled: true,
            anime_title_filter: String::new(),
            anime_id,
            release_group: group.into(),
            resolution: "1080p".into(),
            exclude_keywords: "480p, Dub".into(),
            action: action.into(),
            only_unwatched: true,
        }
    }

    #[test]
    fn legacy_rules_convert() {
        let conv = convert_legacy_rules(&[
            rule("Hide", "discard", "", None),
            rule("Auto", "auto_download", "Erai-raws", None),
            rule("Hl", "highlight", "MyGroup", None),
            rule("Kusuriya", "highlight", "Judas", Some(195516)),
        ]);
        assert_eq!(conv.filters.len(), 2);
        assert_eq!(conv.filters[0].action, FilterAction::Discard);
        assert_eq!(conv.filters[0].query, "res:1080p -480p -Dub");
        assert_eq!(conv.filters[1].action, FilterAction::Select);
        assert_eq!(conv.filters[1].query, "group:Erai-raws res:1080p -480p -Dub new:yes");
        assert_eq!(conv.tier_groups, vec!["MyGroup"]);
        assert_eq!(conv.fansubs, vec![FansubOverride { anime_id: 195516, groups: vec!["Judas".into()] }]);
    }

    #[test]
    fn config_roundtrip_assigns_ids() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(load_feeds(&db).unwrap(), default_feeds());
        let mut feeds = default_feeds();
        feeds.push(TorrentFeed::new("", " https://subsplease.org/rss/?t&r=1080 "));
        let saved = save_feeds(&db, feeds).unwrap();
        assert_eq!(saved[1].id, 2);
        assert_eq!(saved[1].name, "subsplease.org");
        assert_eq!(saved[1].url, "https://subsplease.org/rss/?t&r=1080");
        // Typed in its display form, stored encoded; the order given is kept.
        let reordered = vec![
            TorrentFeed::new("Mine", "https://nyaa.si/?page=rss&q=Erai+1080p|Judas"),
            saved[1].clone(),
            saved[0].clone(),
        ];
        let saved2 = save_feeds(&db, reordered).unwrap();
        assert_eq!(saved2[0].url, "https://nyaa.si/?page=rss&q=Erai+1080p%7CJudas");
        assert_eq!(
            saved2.iter().skip(1).map(|f| f.id).collect::<Vec<_>>(),
            vec![saved[1].id, saved[0].id]
        );
        assert!(save_feeds(&db, vec![TorrentFeed { url: "ftp://example.com/rss".into(), ..saved[0].clone() }]).is_err());

        let all = set_anime_fansubs(&db, 7, vec!["Judas".into(), "judas".into(), "ASW".into()]).unwrap();
        assert_eq!(all[0].groups, vec!["Judas", "ASW"]);
        assert!(set_anime_fansubs(&db, 7, vec![]).unwrap().is_empty());
        assert_eq!(load_priority(&db).unwrap().tiers[0].query, "group:Judas");
    }

    #[test]
    fn legacy_nyaa_feeds_load_as_urls() {
        let db = Database::open_in_memory().unwrap();
        db.set_config_json(
            TORRENT_FEEDS_KEY,
            &serde_json::json!([{ "id": 3, "name": "Frieren", "enabled": true, "query": "Frieren", "category": "1_0", "filter": 2, "url": "" }]),
        )
        .unwrap();
        let feeds = load_feeds(&db).unwrap();
        assert_eq!(feeds[0].url, "https://nyaa.si/?page=rss&c=1_0&f=2&q=Frieren");
        // Saving drops the old fields.
        save_feeds(&db, feeds).unwrap();
        let raw: serde_json::Value = db.get_config_json(TORRENT_FEEDS_KEY).unwrap().unwrap();
        assert!(raw[0].get("query").is_none());
        assert_eq!(raw[0]["url"], "https://nyaa.si/?page=rss&c=1_0&f=2&q=Frieren");
    }

    #[test]
    fn search_feeds_need_a_title_placeholder() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(load_search_feeds(&db).unwrap(), default_search_feeds());
        let bad = vec![SearchFeed { id: 0, name: "SP".into(), url: "https://subsplease.org/rss/?r=1080".into() }];
        assert!(save_search_feeds(&db, bad).is_err());
        let saved = save_search_feeds(
            &db,
            vec![SearchFeed { id: 0, name: String::new(), url: "https://nyaa.si/?page=rss&c=0_0&f=0&q=%Title%".into() }],
        )
        .unwrap();
        assert_eq!(saved[0].id, 1);
        assert_eq!(saved[0].name, "nyaa.si");
        assert_eq!(resolve_search_feed(&saved, Some(1)).id, 1);
        // A deleted choice falls back to the first feed.
        let two = vec![SearchFeed { id: 5, ..saved[0].clone() }, SearchFeed { id: 9, ..saved[0].clone() }];
        assert_eq!(resolve_search_feed(&two, Some(42)).id, 5);
        assert_eq!(resolve_search_feed(&two, Some(9)).id, 9);
    }
}
