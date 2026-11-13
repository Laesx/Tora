//! The saga view: an anime's franchise as a graph, built from stored `media_metadata` rows.
//!
//! The walk goes out from the anime one ring of related anime at a time and asks AniList once per ring
//! (one batched request for every ring member that has no row, or an old one), so a franchise costs a
//! few requests the first time and none after that: opening the saga from another of its anime walks
//! the same stored rows. The story links are walked (sequels, side stories, summaries, alternatives…);
//! a spin-off is walked along its own prequels and sequels only, so a spin-off series shows whole
//! without pulling in its branches; "other" and shared-character links show as end boxes from the data
//! the walked anime already carry. Nothing about the graph itself is stored.

use super::details::details_max_age;
use super::TrackerSyncService;
use crate::plugins::{MediaRelation, SeasonalAnime, MEDIA_DETAILS_CHUNK};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque};
use std::time::Instant;

/// Most anime one saga walks (their relations read); neighbours past it stay end boxes.
pub const MAX_SAGA_NODES: usize = 120;
/// Most AniList requests one call sends; the walk stops there (`more`) and the next call continues.
pub const MAX_SAGA_REQUESTS: u32 = 8;

/// Relation types the walk follows: the franchise's own story.
const WALKED_RELATIONS: [&str; 8] = [
    "PREQUEL",
    "SEQUEL",
    "PARENT",
    "SIDE_STORY",
    "SUMMARY",
    "COMPILATION",
    "CONTAINS",
    "ALTERNATIVE",
];

/// How far the walk follows an anime's links.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Walk {
    /// Only its prequels and sequels: a spin-off series shows whole, without its own side branches
    Chain,
    /// Every story link (`WALKED_RELATIONS`), and spin-offs along their chain
    Full,
}

/// How two anime of a saga are linked, strongest first (the order picks anchors and edge styles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SagaLinkKind {
    /// Prequel / sequel
    Chain,
    /// Parent story / side story
    Parent,
    /// Summary, compilation, contains
    Summary,
    /// Spin-off, other, same characters
    Weak,
    Alternative,
}

pub fn link_kind(relation_type: &str) -> SagaLinkKind {
    match relation_type {
        "PREQUEL" | "SEQUEL" => SagaLinkKind::Chain,
        "PARENT" | "SIDE_STORY" => SagaLinkKind::Parent,
        "SUMMARY" | "COMPILATION" | "CONTAINS" => SagaLinkKind::Summary,
        "ALTERNATIVE" => SagaLinkKind::Alternative,
        _ => SagaLinkKind::Weak,
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SagaRequest {
    /// End boxes the user expanded: walked whatever links them
    #[serde(default)]
    pub expand: Vec<i64>,
    /// Fetch every walked anime again, whatever its age
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SagaNode {
    /// Card fields (`relation_type` left empty)
    pub media: MediaRelation,
    /// `YYYY[-MM[-DD]]`; end boxes only know their year (`media.year`)
    pub start_date: Option<String>,
    /// Its own relations were read; `false` for an end box
    pub walked: bool,
    pub popularity: Option<u32>,
    /// Minutes per episode (walked anime only)
    pub duration: Option<u32>,
}

/// Shortest episode of an ONA that counts as a series (shorter ones are web shorts)
const SERIES_ONA_MINUTES: u32 = 15;

/// A full series (TV, or an ONA with normal-length episodes), as opposed to shorts, OVAs, specials,
/// movies or music: a spin-off that is one gets a line of its own.
fn is_series(node: &SagaNode) -> bool {
    match node.media.format.as_deref() {
        Some("TV") => true,
        Some("ONA") => node.duration.is_some_and(|d| d >= SERIES_ONA_MINUTES),
        _ => false,
    }
}

/// Either side calls the link a spin-off
fn is_spin_off(edge: &SagaEdge) -> bool {
    edge.a_says.as_deref() == Some("SPIN_OFF") || edge.b_says.as_deref() == Some("SPIN_OFF")
}

/// One link between two anime, both directions merged (AniList stores each side on its own media).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SagaEdge {
    /// `a < b`
    pub a: i64,
    pub b: i64,
    /// What `b` is to `a` as `a`'s relations say ("SEQUEL": `b` is `a`'s sequel); `None` when only `b` names it
    pub a_says: Option<String>,
    /// What `a` is to `b` as `b`'s relations say
    pub b_says: Option<String>,
    /// The stronger of the two sides
    pub kind: SagaLinkKind,
}

/// A chain anime and the anime hanging off it (side stories, summaries, end boxes), oldest first.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SagaColumn {
    pub head: i64,
    pub satellites: Vec<i64>,
}

/// How a line hangs off the lines before it: the strongest link between them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SagaLineLink {
    /// An anime of this line
    pub from: i64,
    /// An anime of an earlier line (the main line when it can)
    pub to: i64,
    pub kind: SagaLinkKind,
}

/// One prequel / sequel chain and the anime hanging off it (side stories, summaries, end boxes…). The
/// main line holds the saga's most popular chained anime; alternative versions, spin-off series (TV or
/// full-length ONA) and other long chains get lines of their own; any other short side chain (two
/// anime at most) is folded into the line it hangs off.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SagaLine {
    /// Story order: prequel → sequel, ties by start date
    pub columns: Vec<SagaColumn>,
    /// `None` for the main line
    pub link: Option<SagaLineLink>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SagaGraph {
    pub root: i64,
    /// The saga's name: its most popular walked anime
    pub title_id: i64,
    pub nodes: Vec<SagaNode>,
    pub edges: Vec<SagaEdge>,
    /// The main line first, the others oldest first
    pub lines: Vec<SagaLine>,
    /// Manga / novels the anime are adapted from (deduplicated)
    pub sources: Vec<MediaRelation>,
    /// Story-linked anime left as end boxes because the saga reached `MAX_SAGA_NODES`
    pub unwalked: usize,
    /// The walk stopped at `MAX_SAGA_REQUESTS`: calling again continues it
    pub more: bool,
    pub requests: u32,
    /// AniList couldn't be reached: stored rows were used, unfetched anime are end boxes
    pub error: Option<String>,
}

fn year_of(date: Option<&str>) -> Option<u32> {
    date?.split('-').next()?.parse().ok().filter(|y| *y > 0)
}

/// A walked anime's card fields.
fn card_of(m: &SeasonalAnime) -> MediaRelation {
    let e = &m.entry;
    MediaRelation {
        id: e.id,
        relation_type: String::new(),
        media_type: "ANIME".into(),
        title_romaji: e.title_romaji.clone(),
        title_english: e.title_english.clone(),
        title_native: e.title_native.clone(),
        format: Some(e.format.clone()).filter(|s| !s.is_empty()),
        status: Some(e.airing_status.clone()).filter(|s| !s.is_empty()),
        episodes: e.episodes,
        year: e.season_year.or_else(|| year_of(e.start_date.as_deref())),
        cover_image: Some(e.cover_image.clone()).filter(|s| !s.is_empty()),
    }
}

/// Sortable start date: `YYYYMMDD` with unknown parts 0; unknown dates sort last.
fn date_num(n: &SagaNode) -> u64 {
    if let Some(d) = n.start_date.as_deref() {
        let mut parts = d.split('-').map(|p| p.parse::<u64>().unwrap_or(0));
        if let Some(y) = parts.next().filter(|y| *y > 0) {
            return y.min(9999) * 10_000 + parts.next().unwrap_or(0) * 100 + parts.next().unwrap_or(0);
        }
    }
    n.media.year.map_or(u64::MAX, |y| u64::from(y.min(9999)) * 10_000)
}

/// `(first, then)` of a prequel / sequel link, from whichever side names one.
fn chain_direction(e: &SagaEdge) -> Option<(i64, i64)> {
    let from_a = match e.a_says.as_deref() {
        Some("SEQUEL") => Some((e.a, e.b)),
        Some("PREQUEL") => Some((e.b, e.a)),
        _ => None,
    };
    from_a.or(match e.b_says.as_deref() {
        Some("SEQUEL") => Some((e.b, e.a)),
        Some("PREQUEL") => Some((e.a, e.b)),
        _ => None,
    })
}

/// The graph of the walked anime (`rows`) and their anime neighbours. Pure: same rows, same graph.
pub(crate) fn build_saga(root: i64, rows: &HashMap<i64, SeasonalAnime>) -> SagaGraph {
    let mut walked_ids: Vec<i64> = rows.keys().copied().collect();
    // The root's own sources first
    walked_ids.sort_by_key(|id| (*id != root, *id));
    let mut nodes: HashMap<i64, SagaNode> = rows
        .values()
        .map(|m| {
            let node = SagaNode {
                media: card_of(m),
                start_date: m.entry.start_date.clone(),
                walked: true,
                popularity: m.popularity,
                duration: m.entry.duration,
            };
            (m.entry.id, node)
        })
        .collect();
    let mut says: HashMap<(i64, i64), (Option<String>, Option<String>)> = HashMap::new();
    let mut sources = Vec::new();
    let mut source_ids = HashSet::new();
    for &id in &walked_ids {
        for r in rows[&id].metadata.relations.iter().flatten() {
            if r.media_type != "ANIME" {
                if matches!(r.relation_type.as_str(), "SOURCE" | "ADAPTATION") && source_ids.insert(r.id) {
                    sources.push(r.clone());
                }
                continue;
            }
            if r.id == id {
                continue;
            }
            nodes.entry(r.id).or_insert_with(|| SagaNode {
                media: MediaRelation {
                    relation_type: String::new(),
                    ..r.clone()
                },
                start_date: None,
                walked: false,
                popularity: None,
                duration: None,
            });
            let (a, b) = if id < r.id { (id, r.id) } else { (r.id, id) };
            let slot = says.entry((a, b)).or_default();
            let side = if id == a { &mut slot.0 } else { &mut slot.1 };
            // Two links from one side (rare): the stronger one
            if side.as_deref().map_or(true, |t| link_kind(&r.relation_type) < link_kind(t)) {
                *side = Some(r.relation_type.clone());
            }
        }
    }

    let mut edges: Vec<SagaEdge> = says
        .into_iter()
        .map(|((a, b), (a_says, b_says))| {
            let kind = [&a_says, &b_says]
                .into_iter()
                .flatten()
                .map(|t| link_kind(t))
                .min()
                .unwrap_or(SagaLinkKind::Weak);
            SagaEdge { a, b, a_says, b_says, kind }
        })
        .collect();
    edges.sort_by_key(|e| (e.a, e.b));

    let mut adj: Adjacency = HashMap::new();
    for (i, e) in edges.iter().enumerate() {
        adj.entry(e.a).or_default().push((e.b, i));
        adj.entry(e.b).or_default().push((e.a, i));
    }
    let lines = build_lines(root, &nodes, &edges, &adj);
    let title_id = nodes
        .values()
        .filter(|n| n.walked)
        .max_by_key(|n| (n.popularity.unwrap_or(0), n.media.id == root, Reverse(n.media.id)))
        .map_or(root, |n| n.media.id);

    let mut nodes: Vec<SagaNode> = nodes.into_values().collect();
    nodes.sort_by_key(|n| n.media.id);
    SagaGraph {
        root,
        title_id,
        nodes,
        edges,
        lines,
        sources,
        unwalked: 0,
        more: false,
        requests: 0,
        error: None,
    }
}

type Adjacency = HashMap<i64, Vec<(i64, usize)>>;

/// Prequel / sequel order of one chain (Kahn's algorithm, ties by start date; a cycle of contradictory
/// links is broken at its oldest anime).
fn story_order(members: &[i64], nodes: &HashMap<i64, SagaNode>, edges: &[SagaEdge], adj: &Adjacency) -> Vec<i64> {
    let date = |id: &i64| date_num(&nodes[id]);
    let member: HashSet<i64> = members.iter().copied().collect();
    let mut succ: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut indegree: HashMap<i64, usize> = HashMap::new();
    let mut pairs = HashSet::new();
    for &id in members {
        for &(other, i) in adj.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
            if edges[i].kind != SagaLinkKind::Chain || !member.contains(&other) {
                continue;
            }
            if let Some(pair) = chain_direction(&edges[i]).filter(|p| pairs.insert(*p)) {
                succ.entry(pair.0).or_default().push(pair.1);
                *indegree.entry(pair.1).or_default() += 1;
            }
        }
    }
    let mut remaining: BTreeSet<(u64, i64)> = members.iter().map(|id| (date(id), *id)).collect();
    let mut ready: BinaryHeap<Reverse<(u64, i64)>> = remaining
        .iter()
        .filter(|(_, id)| indegree.get(id).copied().unwrap_or(0) == 0)
        .map(|k| Reverse(*k))
        .collect();
    let mut done = HashSet::new();
    let mut order = Vec::with_capacity(members.len());
    while !remaining.is_empty() {
        let next = loop {
            match ready.pop() {
                Some(Reverse(k)) if !done.contains(&k.1) => break k,
                Some(_) => continue,
                None => break *remaining.iter().next().unwrap(),
            }
        };
        remaining.remove(&next);
        done.insert(next.1);
        order.push(next.1);
        for s in succ.get(&next.1).map(Vec::as_slice).unwrap_or(&[]) {
            let d = indegree.entry(*s).or_default();
            *d = d.saturating_sub(1);
            if *d == 0 && !done.contains(s) {
                ready.push(Reverse((date(s), *s)));
            }
        }
    }
    order
}

/// The saga's lines: prequel / sequel chains, each with the anime hanging off it.
fn build_lines(root: i64, nodes: &HashMap<i64, SagaNode>, edges: &[SagaEdge], adj: &Adjacency) -> Vec<SagaLine> {
    let date = |id: &i64| date_num(&nodes[id]);
    let neighbours = |id: i64| adj.get(&id).map(Vec::as_slice).unwrap_or(&[]);
    let is_chain = |i: usize| edges[i].kind == SagaLinkKind::Chain;
    let mut ids: Vec<i64> = nodes.keys().copied().collect();
    ids.sort_unstable();

    // Prequel / sequel chains
    let mut chains: Vec<Vec<i64>> = Vec::new();
    let mut chain_of: HashMap<i64, usize> = HashMap::new();
    for &start in &ids {
        if chain_of.contains_key(&start) || !neighbours(start).iter().any(|(_, i)| is_chain(*i)) {
            continue;
        }
        let index = chains.len();
        let mut group = vec![start];
        chain_of.insert(start, index);
        let mut queue = VecDeque::from([start]);
        while let Some(x) = queue.pop_front() {
            for &(y, i) in neighbours(x) {
                if is_chain(i) && !chain_of.contains_key(&y) {
                    chain_of.insert(y, index);
                    group.push(y);
                    queue.push_back(y);
                }
            }
        }
        chains.push(group);
    }

    // The main line: the chain of the most popular chained anime, whichever anime the saga is seen from
    let popularity = |id: &i64| (nodes[id].popularity.unwrap_or(0), Reverse(*id));
    let main = chains
        .iter()
        .enumerate()
        .max_by_key(|(_, c)| c.iter().map(popularity).max())
        .map(|(i, _)| i);
    let mut heads: Vec<Vec<i64>> = Vec::new();
    match main {
        Some(m) => heads.push(story_order(&chains[m], nodes, edges, adj)),
        None => {
            let alone = nodes
                .values()
                .filter(|n| n.walked)
                .max_by_key(|n| (n.popularity.unwrap_or(0), n.media.id == root, Reverse(n.media.id)))
                .map_or(root, |n| n.media.id);
            heads.push(vec![alone]);
        }
    }
    // Short side chains (two anime at most) hang off their line instead, unless they are an alternative
    // version or a spin-off series (TV / full-length ONA)
    for (i, chain) in chains.iter().enumerate() {
        if Some(i) == main {
            continue;
        }
        let outside: Vec<&SagaEdge> = chain
            .iter()
            .flat_map(|id| neighbours(*id).iter().filter(|(y, _)| chain_of.get(y) != Some(&i)))
            .map(|(_, e)| &edges[*e])
            .collect();
        let alternative = outside.iter().any(|e| e.kind == SagaLinkKind::Alternative);
        let spin_off_series =
            outside.iter().any(|e| is_spin_off(e)) && chain.iter().any(|id| is_series(&nodes[id]));
        if chain.len() <= 2 && !outside.is_empty() && !alternative && !spin_off_series {
            continue;
        }
        heads.push(story_order(chain, nodes, edges, adj));
    }

    // Everything else hangs off the closest line anime: the strongest link, then the latest anchor that
    // is not newer than it, then the oldest one. A walked anime tied to its anchor only by an
    // alternative link, or a spin-off that is a series, starts a line of its own.
    let mut line_of: HashMap<i64, usize> = HashMap::new();
    let mut column_of: HashMap<i64, i64> = HashMap::new();
    let mut dist: HashMap<i64, usize> = HashMap::new();
    let mut queue = VecDeque::new();
    for (l, line) in heads.iter().enumerate() {
        for &h in line {
            line_of.insert(h, l);
            column_of.insert(h, h);
            dist.insert(h, 0);
            queue.push_back(h);
        }
    }
    while let Some(x) = queue.pop_front() {
        let d = dist[&x];
        for &(y, _) in neighbours(x) {
            if !dist.contains_key(&y) {
                dist.insert(y, d + 1);
                queue.push_back(y);
            }
        }
    }
    let mut satellites: Vec<i64> = ids.iter().copied().filter(|id| dist.get(id).is_some_and(|d| *d > 0)).collect();
    satellites.sort_by_key(|id| (dist[id], date(id), *id));
    for &s in &satellites {
        let ds = date(&s);
        let anchor = neighbours(s)
            .iter()
            .filter(|(c, _)| column_of.contains_key(c) && dist.get(c).is_some_and(|d| d + 1 == dist[&s]))
            .min_by_key(|(c, i)| {
                let dc = date(c);
                let not_after = dc <= ds;
                (edges[*i].kind, !not_after, if not_after { ds - dc } else { dc }, *c)
            });
        let Some(&(c, i)) = anchor else { continue };
        let node = &nodes[&s];
        let own_line = edges[i].kind == SagaLinkKind::Alternative || (is_spin_off(&edges[i]) && is_series(node));
        if own_line && node.walked {
            line_of.insert(s, heads.len());
            column_of.insert(s, s);
            heads.push(vec![s]);
        } else {
            let col = column_of[&c];
            column_of.insert(s, col);
            line_of.insert(s, line_of[&col]);
        }
    }

    // The main line first, the others oldest first
    let mut order: Vec<usize> = (0..heads.len()).collect();
    order[1..].sort_by_key(|l| heads[*l].iter().map(|id| (date(id), *id)).min());
    let rank: HashMap<usize, usize> = order.iter().enumerate().map(|(r, l)| (*l, r)).collect();

    let mut by_date = satellites;
    by_date.sort_by_key(|id| (date(id), *id));
    order
        .iter()
        .map(|&l| {
            let columns = heads[l]
                .iter()
                .map(|&head| SagaColumn {
                    head,
                    satellites: by_date
                        .iter()
                        .copied()
                        .filter(|s| *s != head && column_of.get(s) == Some(&head))
                        .collect(),
                })
                .collect();
            // The strongest link to an earlier line, the main one when it can
            let link = if rank[&l] == 0 {
                None
            } else {
                edges
                    .iter()
                    .filter_map(|e| {
                        let (la, lb) = (*line_of.get(&e.a)?, *line_of.get(&e.b)?);
                        let (from, to, other) = if la == l && lb != l {
                            (e.a, e.b, lb)
                        } else if lb == l && la != l {
                            (e.b, e.a, la)
                        } else {
                            return None;
                        };
                        let later = rank[&other] > rank[&l];
                        Some(((later, e.kind, rank[&other], from, to), SagaLineLink { from, to, kind: e.kind }))
                    })
                    .min_by(|a, b| a.0.cmp(&b.0))
                    .map(|(_, link)| link)
            };
            SagaLine { columns, link }
        })
        .collect()
}

/// Whether a stored row must be fetched again before the walk reads its relations.
fn needs_fetch(row: Option<&(i64, SeasonalAnime)>, refresh: bool, now: i64) -> bool {
    match row {
        None => true,
        Some((fetched_at, m)) => {
            refresh
                || m.metadata.relations.is_none()
                || now - fetched_at >= details_max_age(Some(m.entry.airing_status.as_str()))
        }
    }
}

impl TrackerSyncService {
    /// The saga of `root`: every anime its story links reach (up to `MAX_SAGA_NODES`), from stored rows,
    /// with one batched request per ring for rows that are missing or old (at most `MAX_SAGA_REQUESTS`).
    pub async fn saga(&self, root: i64, req: SagaRequest) -> Result<SagaGraph, String> {
        let _turn = self.saga_lock.lock().await;
        let started = Instant::now();
        let now = chrono::Utc::now().timestamp();
        let expand: HashSet<i64> = req.expand.iter().copied().collect();
        let mut rows: HashMap<i64, SeasonalAnime> = HashMap::new();
        let mut queued: HashMap<i64, Walk> = HashMap::from([(root, Walk::Full)]);
        let mut frontier = vec![root];
        let (mut requests, mut more, mut unwalked) = (0u32, false, HashSet::new());
        let mut error: Option<String> = None;

        while !frontier.is_empty() {
            let ids = frontier.clone();
            let stored = self.blocking(move |db| db.get_media_metadata_many(&ids)).await?;
            let stale: Vec<i64> = frontier
                .iter()
                .copied()
                // Walked again with more links: already read this call
                .filter(|id| !rows.contains_key(id) && needs_fetch(stored.get(id), req.refresh, now))
                .collect();
            let mut fetched = Vec::new();
            for chunk in stale.chunks(MEDIA_DETAILS_CHUNK) {
                if error.is_some() {
                    break;
                }
                if requests >= MAX_SAGA_REQUESTS {
                    more = true;
                    break;
                }
                requests += 1;
                let result = match self.plugin() {
                    Ok(plugin) => self.limiter.run(|| plugin.fetch_media_metadata_batch(chunk)).await,
                    Err(e) => Err(e),
                };
                match result {
                    Ok(items) => fetched.extend(items),
                    Err(e) => {
                        log::warn!(target: "sync", "saga {}: AniList not reached: {}", root, e);
                        error = Some(e.to_string());
                    }
                }
            }
            if !fetched.is_empty() {
                let to_store = fetched.clone();
                self.blocking(move |db| db.put_media_metadata_many(now, &to_store)).await?;
            }
            for (id, (_, item)) in stored {
                rows.entry(id).or_insert(item);
            }
            for item in fetched {
                rows.insert(item.entry.id, item);
            }

            let mut next = Vec::new();
            for id in &frontier {
                let Some(m) = rows.get(id) else { continue };
                let here = queued[id];
                for r in m.metadata.relations.iter().flatten() {
                    if r.media_type != "ANIME" {
                        continue;
                    }
                    let t = r.relation_type.as_str();
                    let reach = if expand.contains(&r.id) {
                        Walk::Full
                    } else {
                        match here {
                            Walk::Full if WALKED_RELATIONS.contains(&t) => Walk::Full,
                            Walk::Full if t == "SPIN_OFF" => Walk::Chain,
                            Walk::Chain if t == "PREQUEL" || t == "SEQUEL" => Walk::Chain,
                            _ => continue,
                        }
                    };
                    match queued.get(&r.id) {
                        Some(had) if *had >= reach => {}
                        // Reached through a fuller link: walked again, its other links too
                        Some(_) => {
                            queued.insert(r.id, reach);
                            if !next.contains(&r.id) {
                                next.push(r.id);
                            }
                        }
                        None if queued.len() >= MAX_SAGA_NODES => {
                            unwalked.insert(r.id);
                        }
                        None => {
                            queued.insert(r.id, reach);
                            next.push(r.id);
                        }
                    }
                }
            }
            frontier = next;
        }

        if !rows.contains_key(&root) {
            return Err(error.unwrap_or_else(|| "AniList has no data for this anime".into()));
        }
        let mut graph = build_saga(root, &rows);
        graph.unwalked = unwalked.len();
        graph.more = more;
        graph.requests = requests;
        graph.error = error;
        log::info!(
            target: "sync",
            "saga {}: {} anime ({} walked), {} request(s), {} ms",
            root,
            graph.nodes.len(),
            rows.len(),
            requests,
            started.elapsed().as_millis()
        );
        Ok(graph)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_entry;
    use crate::plugins::MediaMetadata;

    pub(crate) fn rel(id: i64, kind: &str, media_type: &str, year: Option<u32>) -> MediaRelation {
        MediaRelation {
            id,
            relation_type: kind.into(),
            media_type: media_type.into(),
            title_romaji: format!("Media {id}"),
            year,
            ..Default::default()
        }
    }

    pub(crate) fn media(id: i64, start: &str, popularity: u32, relations: Vec<MediaRelation>) -> SeasonalAnime {
        let mut entry = test_entry(id, &format!("Media {id}"));
        entry.start_date = Some(start.into());
        entry.season_year = None;
        entry.airing_status = "FINISHED".into();
        SeasonalAnime {
            entry,
            popularity: Some(popularity),
            metadata: MediaMetadata {
                relations: Some(relations),
                ..Default::default()
            },
        }
    }

    fn shaped(mut m: SeasonalAnime, format: &str, duration: u32) -> SeasonalAnime {
        m.entry.format = format.into();
        m.entry.duration = Some(duration);
        m
    }

    fn rows(items: Vec<SeasonalAnime>) -> HashMap<i64, SeasonalAnime> {
        items.into_iter().map(|m| (m.entry.id, m)).collect()
    }

    /// Kizu (1, 2016) → Neko Kuro (2, 2012) → Bake (3, 2009) → Nise (4, 2012): story order differs from
    /// release order. Koyomi Vamp (5) is Kizu's summary (only Kizu names it), Koyomimonogatari (6) a side
    /// story of Bake and Nise, Nisekoimonogatari (90) an end box, 500 the source novel.
    fn monogatari() -> HashMap<i64, SeasonalAnime> {
        rows(vec![
            media(1, "2016-01-08", 50, vec![rel(2, "SEQUEL", "ANIME", None), rel(5, "SUMMARY", "ANIME", None)]),
            media(2, "2012-12-31", 40, vec![rel(1, "PREQUEL", "ANIME", None), rel(3, "SEQUEL", "ANIME", None)]),
            media(
                3,
                "2009-07-03",
                90,
                vec![
                    rel(2, "PREQUEL", "ANIME", None),
                    rel(4, "SEQUEL", "ANIME", None),
                    rel(6, "SIDE_STORY", "ANIME", None),
                    rel(90, "OTHER", "ANIME", Some(2015)),
                    rel(500, "SOURCE", "NOVEL", None),
                ],
            ),
            media(4, "2012-01-08", 70, vec![rel(3, "PREQUEL", "ANIME", None), rel(500, "SOURCE", "NOVEL", None)]),
            media(5, "2024-01-12", 10, vec![]),
            media(6, "2016-01-10", 20, vec![rel(3, "PARENT", "ANIME", None), rel(4, "PARENT", "ANIME", None)]),
        ])
    }

    /// Heads of every line, main line first.
    fn heads(g: &SagaGraph) -> Vec<Vec<i64>> {
        g.lines.iter().map(|l| l.columns.iter().map(|c| c.head).collect()).collect()
    }

    #[test]
    fn story_order_follows_the_links_and_side_anime_hang_off_their_anchor() {
        let g = build_saga(4, &monogatari());
        assert_eq!(g.lines.len(), 1);
        let columns: Vec<(i64, Vec<i64>)> =
            g.lines[0].columns.iter().map(|c| (c.head, c.satellites.clone())).collect();
        // Koyomimonogatari hangs off the latest of its parents, the end box off the anime naming it
        assert_eq!(columns, vec![(1, vec![5]), (2, vec![]), (3, vec![90]), (4, vec![6])]);
        assert_eq!(g.lines[0].link, None);
        assert_eq!(g.title_id, 3);
        assert_eq!(g.sources.iter().map(|s| s.id).collect::<Vec<_>>(), vec![500]);
        let end_box = g.nodes.iter().find(|n| n.media.id == 90).unwrap();
        assert!(!end_box.walked && end_box.media.relation_type.is_empty());
        assert_eq!(end_box.media.year, Some(2015));
    }

    #[test]
    fn both_sides_of_a_link_are_merged_and_a_one_sided_link_still_shows() {
        let g = build_saga(1, &monogatari());
        let edge = |a, b| g.edges.iter().find(|e| e.a == a && e.b == b).unwrap();
        assert_eq!(
            (edge(1, 2).a_says.as_deref(), edge(1, 2).b_says.as_deref(), edge(1, 2).kind),
            (Some("SEQUEL"), Some("PREQUEL"), SagaLinkKind::Chain)
        );
        assert_eq!((edge(1, 5).a_says.as_deref(), edge(1, 5).b_says.as_deref()), (Some("SUMMARY"), None));
        assert_eq!(edge(1, 5).kind, SagaLinkKind::Summary);
        assert_eq!(edge(3, 90).kind, SagaLinkKind::Weak);
        assert_eq!(g.edges.len(), 7);
    }

    /// The prequel OVA (1, 2014-12) → season 1 (2, 2013) → season 2 (3); the two summary movies
    /// (10, 2014-11 → 11, 2015) are a chain of their own, an alternative version of season 1; a music
    /// video (20) only "other". Mixed by date they used to read movie 1, OVA, season 1, movie 2.
    #[test]
    fn a_second_chain_is_its_own_line_not_mixed_into_the_main_one() {
        let aot = rows(vec![
            media(1, "2014-12-09", 30, vec![rel(2, "SEQUEL", "ANIME", None)]),
            media(
                2,
                "2013-04-07",
                100,
                vec![
                    rel(1, "PREQUEL", "ANIME", None),
                    rel(3, "SEQUEL", "ANIME", None),
                    rel(10, "ALTERNATIVE", "ANIME", None),
                    rel(20, "OTHER", "ANIME", Some(2014)),
                ],
            ),
            media(3, "2017-04-01", 90, vec![rel(2, "PREQUEL", "ANIME", None)]),
            media(10, "2014-11-22", 20, vec![rel(11, "SEQUEL", "ANIME", None), rel(2, "ALTERNATIVE", "ANIME", None)]),
            media(11, "2015-06-27", 15, vec![rel(10, "PREQUEL", "ANIME", None)]),
        ]);
        // The same board whichever anime it is opened from
        for root in [1, 2, 10, 11] {
            let g = build_saga(root, &aot);
            assert_eq!(heads(&g), vec![vec![1, 2, 3], vec![10, 11]], "from {root}");
            assert_eq!(g.lines[0].columns[1].satellites, vec![20]);
            assert_eq!(
                g.lines[1].link,
                Some(SagaLineLink { from: 10, to: 2, kind: SagaLinkKind::Alternative })
            );
        }
    }

    #[test]
    fn alternative_versions_get_lines_short_side_chains_fold_into_theirs() {
        let g = build_saga(
            11,
            &rows(vec![
                // FMA 2003 and its sequel movie: two anime, but an alternative version: a line
                media(10, "2003-10-04", 80, vec![rel(11, "ALTERNATIVE", "ANIME", None), rel(13, "SEQUEL", "ANIME", None)]),
                media(13, "2005-07-23", 40, vec![rel(10, "PREQUEL", "ANIME", None)]),
                // Brotherhood and its sequel: the main line (most popular)
                media(
                    11,
                    "2009-04-05",
                    99,
                    vec![
                        rel(10, "ALTERNATIVE", "ANIME", None),
                        rel(12, "SEQUEL", "ANIME", None),
                        rel(14, "ALTERNATIVE", "ANIME", None),
                        rel(15, "SIDE_STORY", "ANIME", None),
                    ],
                ),
                media(12, "2011-07-02", 50, vec![rel(11, "PREQUEL", "ANIME", None)]),
                // A remake movie only linked as an alternative: a line of its own
                media(14, "2017-12-01", 30, vec![rel(11, "ALTERNATIVE", "ANIME", None)]),
                // Two OVAs in a row, a side story of Brotherhood: folded under it
                media(15, "2009-10-21", 10, vec![rel(11, "PARENT", "ANIME", None), rel(16, "SEQUEL", "ANIME", None)]),
                media(16, "2010-01-20", 5, vec![rel(15, "PREQUEL", "ANIME", None)]),
            ]),
        );
        assert_eq!(heads(&g), vec![vec![11, 12], vec![10, 13], vec![14]]);
        assert_eq!(g.lines[0].columns[0].satellites, vec![15, 16]);
        assert_eq!(g.lines[2].link, Some(SagaLineLink { from: 14, to: 11, kind: SagaLinkKind::Alternative }));
        assert_eq!(g.title_id, 11);
    }

    /// Uma Musume (1 → 2). Its spin-offs: Cinderella Gray (10 → 11, two TV seasons), a single TV spin-off
    /// (30), a full-length ONA (40); a TV short (20) and a web-short ONA (41) stay under the main series.
    #[test]
    fn spin_off_series_get_lines_shorts_stay_satellites() {
        let spin = |id| rel(id, "SPIN_OFF", "ANIME", None);
        let parent = || rel(1, "PARENT", "ANIME", None);
        let g = build_saga(
            1,
            &rows(vec![
                shaped(
                    media(1, "2018-04-02", 99, vec![rel(2, "SEQUEL", "ANIME", None), spin(10), spin(20), spin(30), spin(40), spin(41)]),
                    "TV",
                    24,
                ),
                shaped(media(2, "2021-01-04", 90, vec![rel(1, "PREQUEL", "ANIME", None)]), "TV", 24),
                shaped(media(10, "2025-04-06", 50, vec![parent(), rel(11, "SEQUEL", "ANIME", None)]), "TV", 24),
                shaped(media(11, "2025-10-05", 40, vec![rel(10, "PREQUEL", "ANIME", None)]), "TV", 24),
                shaped(media(20, "2018-07-01", 5, vec![parent()]), "TV_SHORT", 3),
                shaped(media(30, "2020-01-01", 20, vec![parent()]), "TV", 24),
                shaped(media(40, "2022-01-01", 20, vec![parent()]), "ONA", 23),
                shaped(media(41, "2019-01-01", 5, vec![parent()]), "ONA", 4),
            ]),
        );
        assert_eq!(heads(&g), vec![vec![1, 2], vec![30], vec![40], vec![10, 11]]);
        assert_eq!(g.lines[0].columns[0].satellites, vec![20, 41]);
        assert!(g.lines[1..].iter().all(|l| l.link.as_ref().is_some_and(|k| k.to == 1)));
    }

    #[test]
    fn contradictory_links_and_no_chain_still_give_every_anime_a_column() {
        // Sequels in a circle: the oldest goes first, the links order the rest
        let g = build_saga(
            21,
            &rows(vec![
                media(20, "2001-01-01", 1, vec![rel(21, "SEQUEL", "ANIME", None)]),
                media(21, "2003-01-01", 1, vec![rel(22, "SEQUEL", "ANIME", None)]),
                media(22, "2002-01-01", 1, vec![rel(20, "SEQUEL", "ANIME", None)]),
            ]),
        );
        assert_eq!(heads(&g), vec![vec![20, 21, 22]]);

        // A movie and its summary: the more popular heads the only column
        let g = build_saga(
            31,
            &rows(vec![
                media(30, "2010-01-01", 5, vec![rel(31, "SUMMARY", "ANIME", None)]),
                media(31, "2012-01-01", 1, vec![]),
            ]),
        );
        let c = &g.lines[0].columns;
        assert_eq!((c.len(), c[0].head, c[0].satellites.clone()), (1, 30, vec![31]));
    }
}
