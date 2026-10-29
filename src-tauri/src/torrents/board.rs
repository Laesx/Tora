//! Builds the Torrents board: matches cached releases to the list, applies filters, priority tiers and
//! fansub overrides, auto-selects one release per new episode and groups everything into one card per anime.
//!
//! Pipeline per release: Discard filters → candidates (built-in rule or a Select filter) → the anime's
//! fansub override (strict) or the global priority tiers → one release per (anime, episode).

use super::config::{FansubOverride, FilterAction, PriorityConfig, TorrentFilter};
use super::feed::RawRelease;
use super::query::{Query, ReleaseFacts};
use super::traits::ReleaseTraits;
use crate::db::{AnimeEntry, AnimeMatcherIndex};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// A cached release plus the names of the feeds it appeared in.
#[derive(Debug, Clone)]
pub struct FeedRelease {
    pub release: RawRelease,
    pub feeds: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardRelease {
    pub key: String,
    pub title: String,
    pub torrent_url: String,
    pub view_url: String,
    pub magnet_url: String,
    pub size_label: String,
    pub size_bytes: Option<u64>,
    pub seeders: u32,
    pub leechers: u32,
    /// The feed reports seeders / leechers (otherwise both are 0 and the UI shows "—").
    pub peers_known: bool,
    pub downloads: u32,
    pub pub_unix: Option<i64>,
    pub trusted: bool,
    pub remake: bool,
    pub group: Option<String>,
    /// Anitomy's title for the release (used for unmatched cards and folders).
    pub parsed_title: String,
    /// Episode after anime-relations redirection.
    pub episode: Option<u32>,
    pub episode_end: Option<u32>,
    pub traits: ReleaseTraits,
    pub feeds: Vec<String>,
    pub on_disk: bool,
    pub watched: bool,
    /// Already sent to the torrent client this session.
    pub sent: bool,
    /// Name of the Discard filter that hid it.
    pub discarded_by: Option<String>,
    /// Name of the Select filter that made it a candidate (when the built-in rule didn't).
    pub selected_by: Option<String>,
    pub selected: bool,
    /// 0-based index of the matching priority tier / fansub group.
    pub tier: Option<usize>,
    /// Collapsed under "Other releases": a better tier or the fansub override covers this episode.
    pub outside_tier: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnimeReleaseCard {
    /// Stable card id: `anime:<id>` or `title:<normalized anitomy title>`.
    pub key: String,
    pub anime_id: Option<i64>,
    pub title: String,
    pub cover: String,
    pub status: Option<String>,
    pub progress: u32,
    pub episodes: Option<u32>,
    pub on_disk_count: u32,
    /// The anime's fansub override, when set (replaces the global tiers).
    pub fansub_override: Option<Vec<String>>,
    pub releases: Vec<BoardRelease>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TorrentBoard {
    pub cards: Vec<AnimeReleaseCard>,
    /// Labels of the global priority tiers, in order (for "tier" badges).
    pub tier_labels: Vec<String>,
    pub fetched_at: Option<i64>,
    pub errors: Vec<String>,
    /// Release groups seen in this board (suggestions for the fansub editor).
    pub groups: Vec<String>,
    /// Names of the selected feeds that were never fetched (the board waits for Refresh).
    pub unfetched: Vec<String>,
    /// Title matching work for the timing log.
    #[serde(skip)]
    pub match_stats: MatchStats,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MatchStats {
    /// Distinct normalized titles matched (each one once per build).
    pub titles: usize,
    /// Titles matched only by fuzzy similarity (not a user alias or an exact title).
    pub fuzzy_hits: usize,
}

/// Matches each distinct normalized title of `releases` once, in parallel: title → anime id. The fuzzy step
/// scans every list title, so it must never run once per release (a feed repeats each show many times).
pub fn match_titles(matcher: &AnimeMatcherIndex, releases: &[FeedRelease]) -> (HashMap<String, Option<i64>>, MatchStats) {
    let distinct: HashSet<&str> = releases.iter().map(|r| r.release.parsed.normalized_title.as_str()).collect();
    let matches: HashMap<String, Option<i64>> = distinct
        .into_par_iter()
        .map(|t| (t.to_string(), matcher.match_title_only(t)))
        .collect();
    let fuzzy_hits = matches
        .iter()
        .filter(|(t, aid)| {
            aid.is_some() && !matcher.user_aliases.contains_key(*t) && !matcher.exact_norm.contains_key(*t)
        })
        .count();
    let stats = MatchStats { titles: matches.len(), fuzzy_hits };
    (matches, stats)
}

pub struct BoardInput<'a> {
    pub releases: &'a [FeedRelease],
    pub entries: &'a HashMap<i64, AnimeEntry>,
    pub matcher: Option<&'a AnimeMatcherIndex>,
    pub filters: &'a [TorrentFilter],
    pub priority: &'a PriorityConfig,
    pub fansubs: &'a [FansubOverride],
    pub sent: &'a HashSet<String>,
    /// Anime the user searched for: its card is first, even when empty (and even if its status is hidden).
    pub focus_anime_id: Option<i64>,
    /// List statuses whose anime get no card (releases dropped before selection).
    pub hidden_statuses: &'a [String],
}

struct Compiled<'a> {
    filter: &'a TorrentFilter,
    query: Query,
}

fn compile_filters<'a>(filters: &'a [TorrentFilter], action: FilterAction) -> Vec<Compiled<'a>> {
    filters
        .iter()
        .filter(|f| f.enabled && f.action == action)
        .filter_map(|f| Query::parse(&f.query).ok().map(|query| Compiled { filter: f, query }))
        .collect()
}

fn filter_applies(c: &Compiled, anime_id: Option<i64>) -> bool {
    c.filter.anime_ids.is_empty() || anime_id.is_some_and(|id| c.filter.anime_ids.contains(&id))
}

/// Resolution closest to 1080p first, then seeders, then newest.
fn better(a: &BoardRelease, b: &BoardRelease) -> std::cmp::Ordering {
    let dist = |r: &BoardRelease| r.traits.resolution.map(|h| (h as i64 - 1080).abs()).unwrap_or(i64::MAX);
    dist(a)
        .cmp(&dist(b))
        .then(b.seeders.cmp(&a.seeders))
        .then(b.pub_unix.cmp(&a.pub_unix))
}

fn status_is_watching(status: &str) -> bool {
    status == "CURRENT" || status == "REPEATING"
}

pub fn build_board(input: &BoardInput) -> TorrentBoard {
    let discards = compile_filters(input.filters, FilterAction::Discard);
    let selects = compile_filters(input.filters, FilterAction::Select);
    let tiers: Vec<(String, Query)> = input
        .priority
        .tiers
        .iter()
        .filter(|t| t.enabled)
        .filter_map(|t| Query::parse(&t.query).ok().map(|q| (t.query.clone(), q)))
        .collect();
    let overrides: HashMap<i64, &Vec<String>> =
        input.fansubs.iter().map(|o| (o.anime_id, &o.groups)).collect();

    let mut cards: Vec<AnimeReleaseCard> = Vec::new();
    let mut card_index: HashMap<String, usize> = HashMap::new();
    // Candidate releases per (card, episode range): (card idx, release idx)
    let mut candidates: HashMap<(usize, Option<u32>, Option<u32>), Vec<usize>> = HashMap::new();
    let mut groups_seen: Vec<String> = Vec::new();
    let mut groups_lower: HashSet<String> = HashSet::new();
    let (title_matches, match_stats) = match input.matcher {
        Some(m) => match_titles(m, input.releases),
        None => (HashMap::new(), MatchStats::default()),
    };

    let new_card = |key: String, anime_id: Option<i64>, title: String, entry: Option<&AnimeEntry>| {
        AnimeReleaseCard {
            key,
            anime_id,
            title,
            cover: entry.map(|e| e.cover_image.clone()).unwrap_or_default(),
            status: entry.map(|e| e.user_status.clone()),
            progress: entry.map(|e| e.user_progress).unwrap_or(0),
            episodes: entry.and_then(|e| e.episodes),
            on_disk_count: entry.map(|e| e.available_episodes.len() as u32).unwrap_or(0),
            fansub_override: anime_id.and_then(|id| overrides.get(&id).map(|g| (*g).clone())),
            releases: Vec::new(),
        }
    };

    if let Some(focus) = input.focus_anime_id {
        if let Some(entry) = input.entries.get(&focus) {
            let key = format!("anime:{}", focus);
            card_index.insert(key.clone(), 0);
            cards.push(new_card(key, Some(focus), entry.title_romaji.clone(), Some(entry)));
        }
    }

    for fr in input.releases {
        let r = &fr.release;
        let mut parsed = r.parsed.clone();
        let original_ep = parsed.episode_number;
        // Same as `match_episode(&mut parsed, None)`, with the title step looked up from `title_matches`.
        let matched = input.matcher.and_then(|m| {
            let aid = title_matches.get(&parsed.normalized_title).copied().flatten()?;
            m.resolve_episode(m.title_match_for(aid)?, &mut parsed, None)
        });
        let anime_id = matched.as_ref().map(|m| m.0).filter(|id| input.entries.contains_key(id));
        let entry = anime_id.and_then(|id| input.entries.get(&id));
        if entry.is_some_and(|e| input.hidden_statuses.contains(&e.user_status))
            && anime_id != input.focus_anime_id
        {
            continue;
        }

        let mut episode = parsed.episode_number;
        let mut episode_end = r.traits.episode_end;
        if let (Some(orig), Some(now), Some(end)) = (original_ep, episode, episode_end) {
            // Relations redirection shifted the start; shift the end of a range the same way.
            episode_end = Some((end as i64 + now as i64 - orig as i64).max(now as i64) as u32);
        }
        // A movie / single-episode release without a number is episode 1.
        if episode.is_none() && !r.traits.batch && entry.is_some_and(|e| e.episodes == Some(1)) {
            episode = Some(1);
        }

        let (on_disk, watched, is_new) = match (entry, episode) {
            (Some(e), Some(start)) => {
                let end = episode_end.unwrap_or(start);
                let on_disk = (start..=end).all(|ep| e.available_episodes.contains(&ep));
                (on_disk, end <= e.user_progress, end > e.user_progress)
            }
            _ => (false, false, false),
        };

        let group = parsed.release_group.clone();
        if let Some(g) = &group {
            if groups_lower.insert(g.to_lowercase()) {
                groups_seen.push(g.clone());
            }
        }

        let facts = ReleaseFacts {
            title: r.title.clone(),
            anime_title: entry.map(|e| {
                [Some(e.title_romaji.as_str()), e.title_english.as_deref(), e.title_native.as_deref()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" / ")
            }),
            group: group.clone(),
            resolution: r.traits.resolution,
            codec: r.traits.codec.clone(),
            bit_depth: r.traits.bit_depth,
            audio: r.traits.audio.clone(),
            dual_audio: r.traits.dual_audio,
            source: r.traits.source.clone(),
            size_bytes: r.size_bytes,
            seeders: r.seeders,
            leechers: r.leechers,
            trusted: r.trusted,
            remake: r.remake,
            batch: r.traits.batch,
            status: entry.map(|e| e.user_status.clone()),
            episode,
            episode_end,
            is_new,
            on_disk,
            feeds: fr.feeds.clone(),
        };

        let discarded_by = discards
            .iter()
            .find(|c| filter_applies(c, anime_id) && c.query.matches(&facts))
            .map(|c| c.filter.name.clone());
        let key = r.key();
        let sent = input.sent.contains(&key);

        let builtin = entry.is_some_and(|e| status_is_watching(&e.user_status))
            && episode.is_some()
            && is_new
            && !on_disk
            && !r.traits.batch;
        let selected_by = if builtin {
            None
        } else {
            selects
                .iter()
                .find(|c| filter_applies(c, anime_id) && c.query.matches(&facts))
                .map(|c| c.filter.name.clone())
        };
        let is_candidate = discarded_by.is_none() && !sent && !on_disk && (builtin || selected_by.is_some());

        let tier = match anime_id.and_then(|id| overrides.get(&id)) {
            Some(groups) => group
                .as_ref()
                .and_then(|g| groups.iter().position(|o| o.eq_ignore_ascii_case(g))),
            None => tiers.iter().position(|(_, q)| q.matches(&facts)),
        };

        let card_key = match anime_id {
            Some(id) => format!("anime:{}", id),
            None => {
                let norm = if parsed.normalized_title.is_empty() {
                    r.title.to_lowercase()
                } else {
                    parsed.normalized_title.clone()
                };
                format!("title:{}", norm)
            }
        };
        let ci = *card_index.entry(card_key.clone()).or_insert_with(|| {
            let title = match entry {
                Some(e) => e.title_romaji.clone(),
                None if !parsed.anime_title.is_empty() => parsed.anime_title.clone(),
                None => r.title.clone(),
            };
            cards.push(new_card(card_key, anime_id, title, entry));
            cards.len() - 1
        });

        let ri = cards[ci].releases.len();
        cards[ci].releases.push(BoardRelease {
            key,
            title: r.title.clone(),
            torrent_url: r.torrent_url.clone(),
            view_url: r.view_url.clone(),
            magnet_url: r.magnet_url.clone(),
            size_label: r.size_label.clone(),
            size_bytes: r.size_bytes,
            seeders: r.seeders,
            leechers: r.leechers,
            peers_known: r.peers_known,
            downloads: r.downloads,
            pub_unix: r.pub_unix,
            trusted: r.trusted,
            remake: r.remake,
            group,
            parsed_title: parsed.anime_title.clone(),
            episode,
            episode_end,
            traits: ReleaseTraits {
                episode,
                episode_end,
                ..r.traits.clone()
            },
            feeds: fr.feeds.clone(),
            on_disk,
            watched,
            sent,
            discarded_by,
            selected_by,
            selected: false,
            tier,
            outside_tier: false,
        });
        if is_candidate {
            candidates.entry((ci, episode, episode_end)).or_default().push(ri);
        }
    }

    // Collapse releases a better tier (or the fansub override) already covers, per episode.
    for card in cards.iter_mut() {
        let has_override = card.fansub_override.is_some();
        let mut best_tier: HashMap<(Option<u32>, Option<u32>), usize> = HashMap::new();
        for r in card.releases.iter().filter(|r| r.discarded_by.is_none()) {
            if let Some(t) = r.tier {
                let slot = best_tier.entry((r.episode, r.episode_end)).or_insert(t);
                *slot = (*slot).min(t);
            }
        }
        for r in card.releases.iter_mut() {
            r.outside_tier = match (r.tier, best_tier.get(&(r.episode, r.episode_end))) {
                _ if has_override => r.tier.is_none(),
                (Some(t), Some(best)) => t > *best,
                (None, Some(_)) => true,
                _ => false,
            };
        }
    }

    // One release per (anime, episode): the best tier, then resolution / seeders.
    for ((ci, _, _), idxs) in candidates {
        let card = &cards[ci];
        let has_override = card.fansub_override.is_some();
        let best_tier = idxs.iter().filter_map(|&i| card.releases[i].tier).min();
        let pool: Vec<usize> = match best_tier {
            Some(t) => idxs.iter().copied().filter(|&i| card.releases[i].tier == Some(t)).collect(),
            None if has_override || !input.priority.fallback_to_best => Vec::new(),
            None => idxs,
        };
        if let Some(&pick) = pool
            .iter()
            .min_by(|&&a, &&b| better(&card.releases[a], &card.releases[b]))
        {
            cards[ci].releases[pick].selected = true;
        }
    }

    for card in cards.iter_mut() {
        card.releases.sort_by(|a, b| {
            b.episode
                .cmp(&a.episode)
                .then(a.outside_tier.cmp(&b.outside_tier))
                .then(a.tier.unwrap_or(usize::MAX).cmp(&b.tier.unwrap_or(usize::MAX)))
                .then(b.seeders.cmp(&a.seeders))
        });
    }

    let latest = |c: &AnimeReleaseCard| c.releases.iter().filter_map(|r| r.pub_unix).max().unwrap_or(0);
    cards.sort_by(|a, b| {
        let focus = |c: &AnimeReleaseCard| c.anime_id.is_some() && c.anime_id == input.focus_anime_id;
        let selected = |c: &AnimeReleaseCard| c.releases.iter().any(|r| r.selected);
        focus(b)
            .cmp(&focus(a))
            .then(b.anime_id.is_some().cmp(&a.anime_id.is_some()))
            .then(selected(b).cmp(&selected(a)))
            .then(latest(b).cmp(&latest(a)))
    });

    groups_seen.sort_by_key(|g| g.to_lowercase());
    TorrentBoard {
        cards,
        tier_labels: tiers.into_iter().map(|(label, _)| label).collect(),
        fetched_at: None,
        errors: Vec::new(),
        groups: groups_seen,
        unfetched: Vec::new(),
        match_stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{test_entry, Database};
    use crate::torrents::config::{default_priority, PriorityTier};
    use crate::torrents::feed::parse_rss;

    fn item(title: &str, hash: &str, seeders: u32) -> String {
        format!(
            "<item><title>{}</title><link>https://nyaa.si/download/1.torrent</link>\
             <guid>https://nyaa.si/view/1</guid><nyaa:seeders>{}</nyaa:seeders>\
             <nyaa:infoHash>{}</nyaa:infoHash><nyaa:size>1 GiB</nyaa:size></item>",
            title, seeders, hash
        )
    }

    fn releases(items: &[(&str, &str, u32)]) -> Vec<FeedRelease> {
        let xml = format!(
            "<rss><channel>{}</channel></rss>",
            items.iter().map(|(t, h, s)| item(t, h, *s)).collect::<String>()
        );
        parse_rss(&xml)
            .into_iter()
            .map(|release| FeedRelease { release, feeds: vec!["Feed".into()] })
            .collect()
    }

    struct Fixture {
        db: Database,
        entries: HashMap<i64, AnimeEntry>,
    }

    fn fixture() -> Fixture {
        let db = Database::open_in_memory().unwrap();
        let mut frieren = test_entry(154587, "Sousou no Frieren");
        frieren.user_status = "CURRENT".into();
        frieren.user_progress = 4;
        frieren.episodes = Some(28);
        frieren.available_episodes = vec![1, 2, 3, 4, 5];
        let mut dandadan = test_entry(171018, "Dandadan");
        dandadan.user_status = "CURRENT".into();
        dandadan.user_progress = 2;
        let mut done = test_entry(5114, "Fullmetal Alchemist: Brotherhood");
        done.user_status = "COMPLETED".into();
        done.user_progress = 64;
        done.episodes = Some(64);
        db.upsert_anime_entries_batch(&[frieren.clone(), dandadan.clone(), done.clone()]).unwrap();
        let entries = [frieren, dandadan, done].into_iter().map(|e| (e.id, e)).collect();
        Fixture { db, entries }
    }

    fn build(
        f: &Fixture,
        rel: &[FeedRelease],
        filters: &[TorrentFilter],
        priority: &PriorityConfig,
        fansubs: &[FansubOverride],
        sent: &HashSet<String>,
    ) -> TorrentBoard {
        let matcher = f.db.matcher_index().unwrap();
        build_board(&BoardInput {
            releases: rel,
            entries: &f.entries,
            matcher: Some(&matcher),
            filters,
            priority,
            fansubs,
            sent,
            focus_anime_id: None,
            hidden_statuses: &[],
        })
    }

    fn card<'a>(b: &'a TorrentBoard, id: i64) -> &'a AnimeReleaseCard {
        b.cards.iter().find(|c| c.anime_id == Some(id)).expect("card")
    }

    fn selected(c: &AnimeReleaseCard) -> Vec<String> {
        c.releases.iter().filter(|r| r.selected).map(|r| r.title.clone()).collect()
    }

    const DANDA_ERAI: &str = "[Erai-raws] Dandadan - 03 [1080p][Multiple Subtitle]";
    const DANDA_SP: &str = "[SubsPlease] Dandadan - 03 (1080p) [AAAA1111].mkv";
    const DANDA_SP_720: &str = "[SubsPlease] Dandadan - 03 (720p) [BBBB2222].mkv";
    const DANDA_JUDAS: &str = "[Judas] Dandadan - 03 [1080p][HEVC x265 10bit]";
    const DANDA_OTHER: &str = "[Nobody] Dandadan - 04 [1080p]";

    #[test]
    fn first_tier_wins_one_per_episode() {
        let f = fixture();
        let rel = releases(&[
            (DANDA_SP, "a1", 500),
            (DANDA_SP_720, "a2", 900),
            (DANDA_ERAI, "a3", 50),
            (DANDA_OTHER, "a4", 5),
        ]);
        let b = build(&f, &rel, &[], &default_priority(), &[], &HashSet::new());
        let c = card(&b, 171018);
        // Erai-raws is ranked above SubsPlease; ep 4 falls back to the only release.
        assert_eq!(selected(c), vec![DANDA_OTHER.to_string(), DANDA_ERAI.to_string()]);
        assert!(c.releases.iter().find(|r| r.title == DANDA_SP).unwrap().outside_tier);

        let no_fallback = PriorityConfig { fallback_to_best: false, ..default_priority() };
        let b = build(&f, &rel, &[], &no_fallback, &[], &HashSet::new());
        assert_eq!(selected(card(&b, 171018)), vec![DANDA_ERAI.to_string()]);

        // Within one tier: resolution closest to 1080p beats more seeders.
        let sp_only = PriorityConfig {
            tiers: vec![PriorityTier { id: 1, query: "group:SubsPlease".into(), enabled: true }],
            fallback_to_best: false,
        };
        let b = build(&f, &rel, &[], &sp_only, &[], &HashSet::new());
        assert_eq!(selected(card(&b, 171018)), vec![DANDA_SP.to_string()]);
    }

    #[test]
    fn fansub_override_is_strict() {
        let f = fixture();
        let rel = releases(&[(DANDA_ERAI, "a3", 50), (DANDA_JUDAS, "a5", 10), (DANDA_OTHER, "a4", 5)]);
        let judas = [FansubOverride { anime_id: 171018, groups: vec!["Judas".into()] }];
        let b = build(&f, &rel, &[], &default_priority(), &judas, &HashSet::new());
        let c = card(&b, 171018);
        assert_eq!(selected(c), vec![DANDA_JUDAS.to_string()]);
        assert!(c.releases.iter().find(|r| r.title == DANDA_ERAI).unwrap().outside_tier);
        assert_eq!(c.fansub_override.as_deref(), Some(&["Judas".to_string()][..]));
    }

    #[test]
    fn skips_watched_on_disk_sent_batches_and_discarded() {
        let f = fixture();
        let rel = releases(&[
            ("[SubsPlease] Sousou no Frieren - 04 (1080p) [C1].mkv", "f4", 10),
            ("[SubsPlease] Sousou no Frieren - 05 (1080p) [C2].mkv", "f5", 10),
            ("[SubsPlease] Sousou no Frieren - 06 (1080p) [C3].mkv", "f6", 10),
            ("[SubsPlease] Sousou no Frieren - 07 (1080p) [C4].mkv", "f7", 10),
            ("[ASW] Sousou no Frieren - 01-28 (1080p) [Batch]", "fb", 10),
            ("[SubsPlease] Fullmetal Alchemist Brotherhood - 65 (1080p) [C5].mkv", "fm", 10),
            (DANDA_SP, "a1", 10),
        ]);
        let sent: HashSet<String> = rel
            .iter()
            .filter(|r| r.release.title.contains(" - 07 "))
            .map(|r| r.release.key())
            .collect();
        let filters = [TorrentFilter {
            id: 1,
            name: "No SubsPlease Dandadan".into(),
            enabled: true,
            action: FilterAction::Discard,
            query: "group:SubsPlease".into(),
            anime_ids: vec![171018],
        }];
        let b = build(&f, &rel, &filters, &default_priority(), &[], &sent);
        let c = card(&b, 154587);
        assert_eq!(selected(c), vec!["[SubsPlease] Sousou no Frieren - 06 (1080p) [C3].mkv".to_string()]);
        let ep = |n: u32| c.releases.iter().find(|r| r.episode == Some(n) && r.episode_end.is_none()).unwrap();
        assert!(ep(4).watched && ep(4).on_disk);
        assert!(ep(5).on_disk && !ep(5).watched);
        assert!(ep(7).sent);
        assert!(selected(card(&b, 171018)).is_empty());
        assert_eq!(
            card(&b, 171018).releases[0].discarded_by.as_deref(),
            Some("No SubsPlease Dandadan")
        );
        // A Select filter can pick a batch the built-in rule skips.
        let select = [TorrentFilter {
            id: 2,
            name: "Batches".into(),
            enabled: true,
            action: FilterAction::Select,
            query: "batch:yes group:ASW".into(),
            anime_ids: vec![],
        }];
        let b = build(&f, &rel, &select, &default_priority(), &[], &sent);
        let c = card(&b, 154587);
        assert!(c.releases.iter().any(|r| r.traits.batch && r.selected && r.selected_by.as_deref() == Some("Batches")));
    }

    #[test]
    fn hidden_statuses_drop_cards_except_the_searched_anime() {
        let mut f = fixture();
        f.entries.get_mut(&171018).unwrap().user_status = "DROPPED".into();
        let rel = releases(&[(DANDA_SP, "a1", 10), ("[SubsPlease] Sousou no Frieren - 06 (1080p) [C3].mkv", "f6", 10)]);
        let matcher = f.db.matcher_index().unwrap();
        let hidden = vec!["PLANNING".to_string(), "DROPPED".to_string()];
        let build_with = |focus: Option<i64>| {
            build_board(&BoardInput {
                releases: &rel,
                entries: &f.entries,
                matcher: Some(&matcher),
                filters: &[],
                priority: &default_priority(),
                fansubs: &[],
                sent: &HashSet::new(),
                focus_anime_id: focus,
                hidden_statuses: &hidden,
            })
        };
        let b = build_with(None);
        assert!(b.cards.iter().all(|c| c.anime_id != Some(171018)));
        assert!(b.cards.iter().any(|c| c.anime_id == Some(154587)));
        // Searching the dropped anime from its drawer still shows it.
        let b = build_with(Some(171018));
        assert_eq!(b.cards[0].anime_id, Some(171018));
        assert_eq!(b.cards[0].releases.len(), 1);
    }

    #[test]
    fn unmatched_releases_get_their_own_cards_after_list_cards() {
        let f = fixture();
        let rel = releases(&[("[SubsPlease] Totally Unknown Show - 01 (1080p) [D1].mkv", "u1", 3), (DANDA_SP, "a1", 10)]);
        let b = build(&f, &rel, &[], &default_priority(), &[], &HashSet::new());
        assert_eq!(b.cards[0].anime_id, Some(171018));
        let last = b.cards.last().unwrap();
        assert_eq!(last.anime_id, None);
        assert!(last.releases.iter().all(|r| !r.selected));
        assert!(b.groups.contains(&"SubsPlease".to_string()));
    }

    #[test]
    fn deduped_title_matching_equals_match_episode() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_anime_entries_batch(&crate::db::test_fixture_entries()).unwrap();
        let matcher = db.matcher_index().unwrap();
        let rel = releases(&[
            ("[Judas] Kusuriya no Hitorigoto - 51 [1080p][HEVC x265 10bit].mkv", "k1", 5),
            ("[Judas] Kusuriya - S03E03 [1080p].mkv", "k2", 5),
            ("[SubsPlease] Sousou no Frieren - 05 (1080p) [A1B2C3D4].mkv", "f1", 5),
            ("[Erai-raws] Frieren - 06 [1080p][Multiple Subtitle].mkv", "f2", 5),
            ("[SubsPlease] Totally Unknown Show - 01 (1080p) [D1].mkv", "u1", 5),
        ]);
        let (titles, stats) = match_titles(&matcher, &rel);
        assert!(stats.titles <= rel.len());
        for r in &rel {
            let mut expected = r.release.parsed.clone();
            let want = matcher.match_episode(&mut expected, None).map(|m| m.0);
            let mut parsed = r.release.parsed.clone();
            let got = titles
                .get(&parsed.normalized_title)
                .copied()
                .flatten()
                .and_then(|aid| matcher.resolve_episode(matcher.title_match_for(aid)?, &mut parsed, None))
                .map(|m| m.0);
            assert_eq!(got, want, "{}", r.release.title);
            assert_eq!(parsed.episode_number, expected.episode_number, "{}", r.release.title);
        }
        // The relations redirect really happened (Kusuriya 51 → 3rd Season episode 3).
        let mut k = rel[0].release.parsed.clone();
        assert_eq!(matcher.match_episode(&mut k, None).map(|m| m.0), Some(195516));
        assert_eq!(k.episode_number, Some(3));
    }
}
