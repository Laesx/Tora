use crate::detection::anitomy::normalize_anime_title;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// Embedded official upstream `erengy/anime-relations` database (`vendor/anime-relations/anime-relations.txt`).
pub const UPSTREAM_ANIME_RELATIONS_DATA: &str =
    include_str!("../../vendor/anime-relations/anime-relations.txt");

#[derive(Debug, Clone)]
pub struct RelationRule {
    pub src_mal_id: Option<i64>,
    pub src_kitsu_id: Option<i64>,
    pub src_anilist_id: Option<i64>,
    pub src_title: String,
    pub src_norm_title: String,
    pub src_start: u32,
    pub src_end: u32,
    pub dst_mal_id: Option<i64>,
    pub dst_kitsu_id: Option<i64>,
    pub dst_anilist_id: Option<i64>,
    pub dst_title: String,
    pub dst_norm_title: String,
    pub dst_season: Option<u32>,
    pub dst_start: u32,
    pub dst_end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeRedirection {
    pub dst_mal_id: Option<i64>,
    pub dst_kitsu_id: Option<i64>,
    pub dst_anilist_id: Option<i64>,
    pub dst_title: String,
    pub dst_norm_title: String,
    pub dst_season: Option<u32>,
    pub dst_episode: u32,
    pub dst_episode_alt: Option<u32>,
}

pub struct RelationsDatabase {
    /// `- last_modified: YYYY-MM-DD` from the `::meta` section (empty when missing)
    pub last_modified: String,
    /// Number of rules read from the `::rules` section (`!` mirrors not counted)
    pub rule_count: usize,
    pub by_anilist_id: HashMap<i64, Vec<RelationRule>>,
    pub by_mal_id: HashMap<i64, Vec<RelationRule>>,
    pub by_norm_title: HashMap<String, Vec<RelationRule>>,
}

/// The active database: the embedded copy until a newer download (or cached download) is installed.
static RELATIONS_DB: Lazy<RwLock<Arc<RelationsDatabase>>> = Lazy::new(|| {
    RwLock::new(Arc::new(RelationsDatabase::parse(
        UPSTREAM_ANIME_RELATIONS_DATA,
    )))
});

/// `last_modified` of the embedded copy (cheap: only scans the meta section).
pub fn embedded_relations_last_modified() -> String {
    meta_last_modified(UPSTREAM_ANIME_RELATIONS_DATA)
}

pub fn relations_db() -> Arc<RelationsDatabase> {
    RELATIONS_DB
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Swap the active database (a downloaded `anime-relations.txt`). Lookups already running keep the old one.
pub fn install_relations(db: RelationsDatabase) {
    *RELATIONS_DB.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(db);
}

/// `- last_modified: YYYY-MM-DD` from the `::meta` section; empty when missing.
pub fn meta_last_modified(contents: &str) -> String {
    let mut in_meta = false;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if let Some(section) = line.strip_prefix("::") {
            if in_meta {
                break;
            }
            in_meta = section.trim() == "meta";
            continue;
        }
        if in_meta {
            if let Some(value) = line
                .strip_prefix('-')
                .and_then(|rest| rest.trim().strip_prefix("last_modified:"))
            {
                return value.trim().to_string();
            }
        }
    }
    String::new()
}

fn parse_id_token(token: &str, fallback: Option<i64>) -> Option<i64> {
    let t = token.trim();
    if t == "~" {
        fallback
    } else if t == "?" || t.is_empty() {
        None
    } else {
        t.parse::<i64>().ok()
    }
}

fn parse_ep_range(range_str: &str) -> Option<(u32, u32)> {
    let s = range_str.trim();
    if let Some((start_s, end_s)) = s.split_once('-') {
        let start = start_s.trim().parse::<u32>().ok()?;
        let end = if end_s.trim() == "?" {
            u32::MAX
        } else {
            end_s.trim().parse::<u32>().ok()?
        };
        Some((start, end))
    } else {
        let single = s.parse::<u32>().ok()?;
        Some((single, single))
    }
}

/// Infer the season number from a destination title or suffix like `"~ 2nd Season"`, `"~ Season 3"`, `"~ II"`, `"~ 3"`.
pub fn infer_season_from_title_suffix(suffix: &str) -> Option<u32> {
    let lower = suffix.to_ascii_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();

    for (i, &tok) in tokens.iter().enumerate() {
        match tok {
            "1st" if tokens.get(i + 1) == Some(&"season") => return Some(1),
            "2nd" if tokens.get(i + 1) == Some(&"season") => return Some(2),
            "3rd" if tokens.get(i + 1) == Some(&"season") => return Some(3),
            "4th" if tokens.get(i + 1) == Some(&"season") => return Some(4),
            "5th" if tokens.get(i + 1) == Some(&"season") => return Some(5),
            "6th" if tokens.get(i + 1) == Some(&"season") => return Some(6),
            "7th" if tokens.get(i + 1) == Some(&"season") => return Some(7),
            "8th" if tokens.get(i + 1) == Some(&"season") => return Some(8),
            "9th" if tokens.get(i + 1) == Some(&"season") => return Some(9),
            "season" | "series" => {
                if let Some(&next) = tokens.get(i + 1) {
                    if let Ok(n) = next.parse::<u32>() {
                        if (1..=20).contains(&n) {
                            return Some(n);
                        }
                    }
                    match next {
                        "ii" => return Some(2),
                        "iii" => return Some(3),
                        "iv" => return Some(4),
                        "v" => return Some(5),
                        "vi" => return Some(6),
                        _ => {}
                    }
                }
            }
            "s2" | "s02" => return Some(2),
            "s3" | "s03" => return Some(3),
            "s4" | "s04" => return Some(4),
            "s5" | "s05" => return Some(5),
            "s6" | "s06" => return Some(6),
            _ => {}
        }
    }

    if let Some(&last) = tokens.last() {
        let prev = if tokens.len() >= 2 {
            tokens.get(tokens.len() - 2).copied()
        } else {
            None
        };
        let is_non_season_prefix = matches!(
            prev,
            Some("part" | "cour" | "episode" | "ep" | "vol" | "volume" | "movie" | "ova" | "special")
        );
        if !is_non_season_prefix {
            match last {
                "ii" | "2" => return Some(2),
                "iii" | "3" => return Some(3),
                "iv" | "4" => return Some(4),
                "v" | "5" => return Some(5),
                "vi" | "6" => return Some(6),
                _ => {}
            }
        }
    }

    None
}

impl RelationsDatabase {
    pub fn parse(contents: &str) -> Self {
        let mut by_anilist_id: HashMap<i64, Vec<RelationRule>> = HashMap::new();
        let mut by_mal_id: HashMap<i64, Vec<RelationRule>> = HashMap::new();
        let mut by_norm_title: HashMap<String, Vec<RelationRule>> = HashMap::new();

        let mut in_rules = false;
        let mut rule_count = 0usize;
        let mut current_src_title = String::new();
        let mut current_dst_title = String::new();
        let mut current_dst_season: Option<u32> = None;

        for raw_line in contents.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }

            if let Some(section) = line.strip_prefix("::") {
                in_rules = section.trim() == "rules";
                continue;
            }

            if !in_rules {
                continue;
            }

            // Parse comment header e.g. `# Kusuriya no Hitorigoto -> ~ 3rd Season`
            if let Some(comment) = line.strip_prefix('#') {
                if let Some((src_t, dst_pat)) = comment.trim().split_once(" -> ") {
                    let src_clean = src_t.trim();
                    let dst_clean = dst_pat.trim();
                    current_src_title = src_clean.to_string();
                    current_dst_title = if dst_clean == "~" {
                        src_clean.to_string()
                    } else if dst_clean.contains('~') {
                        dst_clean.replace('~', src_clean)
                    } else {
                        dst_clean.to_string()
                    };
                    current_dst_season = infer_season_from_title_suffix(dst_clean)
                        .or_else(|| infer_season_from_title_suffix(&current_dst_title));
                }
                continue;
            }

            let rule_body = line.strip_prefix('-').map(|s| s.trim()).unwrap_or(line);
            let Some((left, right_raw)) = rule_body.split_once(" -> ") else {
                continue;
            };

            let (right, has_bang) = match right_raw.trim().strip_suffix('!') {
                Some(stripped) => (stripped.trim(), true),
                None => (right_raw.trim(), false),
            };

            let Some((src_ids_str, src_range_str)) = left.trim().split_once(':') else {
                continue;
            };
            let Some((dst_ids_str, dst_range_str)) = right.split_once(':') else {
                continue;
            };

            let src_ids: Vec<&str> = src_ids_str.split('|').collect();
            let dst_ids: Vec<&str> = dst_ids_str.split('|').collect();
            if src_ids.len() < 3 || dst_ids.len() < 3 {
                continue;
            }

            let src_mal_id = parse_id_token(src_ids[0], None);
            let src_kitsu_id = parse_id_token(src_ids[1], None);
            let src_anilist_id = parse_id_token(src_ids[2], None);

            let dst_mal_id = parse_id_token(dst_ids[0], src_mal_id);
            let dst_kitsu_id = parse_id_token(dst_ids[1], src_kitsu_id);
            let dst_anilist_id = parse_id_token(dst_ids[2], src_anilist_id);

            let Some((src_start, src_end)) = parse_ep_range(src_range_str) else {
                continue;
            };
            let Some((dst_start, dst_end)) = parse_ep_range(dst_range_str) else {
                continue;
            };

            let src_norm_title = normalize_anime_title(&current_src_title);
            let dst_norm_title = normalize_anime_title(&current_dst_title);

            rule_count += 1;
            let primary_rule = RelationRule {
                src_mal_id,
                src_kitsu_id,
                src_anilist_id,
                src_title: current_src_title.clone(),
                src_norm_title: src_norm_title.clone(),
                src_start,
                src_end,
                dst_mal_id,
                dst_kitsu_id,
                dst_anilist_id,
                dst_title: current_dst_title.clone(),
                dst_norm_title: dst_norm_title.clone(),
                dst_season: current_dst_season,
                dst_start,
                dst_end,
            };

            Self::insert_rule(
                &mut by_anilist_id,
                &mut by_mal_id,
                &mut by_norm_title,
                primary_rule.clone(),
            );

            // `!` shorthand: redirect destination ID & destination title to itself
            if has_bang {
                let mirror_rule = RelationRule {
                    src_mal_id: dst_mal_id,
                    src_kitsu_id: dst_kitsu_id,
                    src_anilist_id: dst_anilist_id,
                    src_title: current_dst_title.clone(),
                    src_norm_title: dst_norm_title,
                    src_start,
                    src_end,
                    dst_mal_id,
                    dst_kitsu_id,
                    dst_anilist_id,
                    dst_title: current_dst_title.clone(),
                    dst_norm_title: normalize_anime_title(&current_dst_title),
                    dst_season: current_dst_season,
                    dst_start,
                    dst_end,
                };
                Self::insert_rule(
                    &mut by_anilist_id,
                    &mut by_mal_id,
                    &mut by_norm_title,
                    mirror_rule,
                );
            }
        }

        Self {
            last_modified: meta_last_modified(contents),
            rule_count,
            by_anilist_id,
            by_mal_id,
            by_norm_title,
        }
    }

    fn insert_rule(
        by_anilist_id: &mut HashMap<i64, Vec<RelationRule>>,
        by_mal_id: &mut HashMap<i64, Vec<RelationRule>>,
        by_norm_title: &mut HashMap<String, Vec<RelationRule>>,
        rule: RelationRule,
    ) {
        if let Some(aid) = rule.src_anilist_id {
            by_anilist_id.entry(aid).or_default().push(rule.clone());
        }
        if let Some(mid) = rule.src_mal_id {
            by_mal_id.entry(mid).or_default().push(rule.clone());
        }
        if !rule.src_norm_title.is_empty() {
            by_norm_title
                .entry(rule.src_norm_title.clone())
                .or_default()
                .push(rule);
        }
    }

    fn apply_rule(
        rule: &RelationRule,
        episode: u32,
        episode_alt: Option<u32>,
    ) -> Option<EpisodeRedirection> {
        if episode < rule.src_start || episode > rule.src_end {
            return None;
        }
        let distance = episode - rule.src_start;
        let dst_ep = if rule.dst_start != rule.dst_end {
            rule.dst_start.saturating_add(distance)
        } else {
            rule.dst_start
        };
        if dst_ep > rule.dst_end {
            return None;
        }

        let dst_ep_alt = if let Some(alt) = episode_alt {
            if alt >= rule.src_start && alt <= rule.src_end {
                let alt_dist = alt - rule.src_start;
                let mapped = if rule.dst_start != rule.dst_end {
                    rule.dst_start.saturating_add(alt_dist)
                } else {
                    rule.dst_start
                };
                if mapped <= rule.dst_end {
                    Some(mapped)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        Some(EpisodeRedirection {
            dst_mal_id: rule.dst_mal_id,
            dst_kitsu_id: rule.dst_kitsu_id,
            dst_anilist_id: rule.dst_anilist_id,
            dst_title: rule.dst_title.clone(),
            dst_norm_title: rule.dst_norm_title.clone(),
            dst_season: rule.dst_season,
            dst_episode: dst_ep,
            dst_episode_alt: dst_ep_alt,
        })
    }

    /// Find an episode redirection by AniList ID or MyAnimeList ID (ported from Taiga's `Relations::find`).
    pub fn find_by_id(
        &self,
        anilist_id: Option<i64>,
        mal_id: Option<i64>,
        episode: u32,
        episode_alt: Option<u32>,
    ) -> Option<EpisodeRedirection> {
        if let Some(aid) = anilist_id {
            if let Some(rules) = self.by_anilist_id.get(&aid) {
                for rule in rules {
                    if let Some(red) = Self::apply_rule(rule, episode, episode_alt) {
                        return Some(red);
                    }
                }
            }
        }

        if let Some(mid) = mal_id {
            if let Some(rules) = self.by_mal_id.get(&mid) {
                for rule in rules {
                    if let Some(red) = Self::apply_rule(rule, episode, episode_alt) {
                        return Some(red);
                    }
                }
            }
        }

        None
    }

    /// Find an episode redirection by normalized anime title (both extended title with season and base title,
    /// including unambiguous word-prefix matches like `"kusuriya"` -> `"kusuriya no hitorigoto"`).
    pub fn find_by_title(
        &self,
        extended_norm_title: &str,
        base_norm_title: &str,
        episode: u32,
        episode_alt: Option<u32>,
    ) -> Option<EpisodeRedirection> {
        if !extended_norm_title.is_empty() {
            if let Some(rules) = self.by_norm_title.get(extended_norm_title) {
                for rule in rules {
                    if let Some(red) = Self::apply_rule(rule, episode, episode_alt) {
                        return Some(red);
                    }
                }
            }
        }

        if !base_norm_title.is_empty() && base_norm_title != extended_norm_title {
            if let Some(rules) = self.by_norm_title.get(base_norm_title) {
                for rule in rules {
                    // Only redirect from base title when the episode number is a continuous/sequential
                    // episode number beyond episode 1 (e.g. Shingeki no Kyojin Season 4 - 87 -> 76..=87 -> 1..=12).
                    if rule.src_start > 1 {
                        if let Some(red) = Self::apply_rule(rule, episode, episode_alt) {
                            return Some(red);
                        }
                    }
                }
            }
        }

        // Prefix fallback for abbreviated titles not directly in `by_norm_title` (e.g. "[Judas] Kusuriya - 51.mkv")
        if base_norm_title.len() >= 4 && !self.by_norm_title.contains_key(base_norm_title) {
            let prefix = format!("{} ", base_norm_title);
            let mut matched_redirection: Option<EpisodeRedirection> = None;
            let mut matched_dst: Option<&str> = None;

            for (norm_key, rules) in &self.by_norm_title {
                if norm_key.starts_with(&prefix) {
                    for rule in rules {
                        if rule.src_start > 1 {
                            if let Some(red) = Self::apply_rule(rule, episode, episode_alt) {
                                if let Some(prev_dst) = matched_dst {
                                    if prev_dst != rule.dst_norm_title {
                                        return None; // Ambiguous prefix
                                    }
                                } else {
                                    matched_dst = Some(&rule.dst_norm_title);
                                    matched_redirection = Some(red);
                                }
                            }
                        }
                    }
                }
            }
            if matched_redirection.is_some() {
                return matched_redirection;
            }
        }

        None
    }

    /// Resolve a canonical sequel/season title from `anime-relations.txt` when a filename specifies
    /// an explicit season > 1 (e.g. `[Judas] Kusuriya - S03E03.mkv` -> `"Kusuriya no Hitorigoto 3rd Season"`).
    pub fn resolve_canonical_season_title(
        &self,
        base_norm_title: &str,
        season: u32,
    ) -> Option<(String, String)> {
        if base_norm_title.is_empty() || season <= 1 {
            return None;
        }

        if let Some(rules) = self.by_norm_title.get(base_norm_title) {
            for rule in rules {
                if rule.dst_season == Some(season) && !rule.dst_title.is_empty() {
                    return Some((rule.dst_title.clone(), rule.dst_norm_title.clone()));
                }
            }
        }

        if base_norm_title.len() >= 4 {
            let prefix = format!("{} ", base_norm_title);
            let mut candidate: Option<(String, String)> = None; // (dst_title, dst_norm)

            for (norm_key, rules) in &self.by_norm_title {
                if norm_key.starts_with(&prefix) {
                    for rule in rules {
                        if rule.dst_season == Some(season) && !rule.dst_title.is_empty() {
                            if let Some((_, ref prev_dst_norm)) = candidate {
                                if prev_dst_norm != &rule.dst_norm_title {
                                    return None;
                                }
                            } else {
                                candidate =
                                    Some((rule.dst_title.clone(), rule.dst_norm_title.clone()));
                            }
                        }
                    }
                }
            }

            if let Some((dst_title, dst_norm)) = candidate {
                return Some((dst_title, dst_norm));
            }
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;
    use crate::detection::anitomy::parse_filename;

    #[test]
    fn test_db_matching_bocchi_s2_and_kusuriya_relations() {
        let tmp_db_path =
            std::env::temp_dir().join(format!("tora_test_relations_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp_db_path);
        let db = Database::open(&tmp_db_path).expect("open test db");
        db.upsert_anime_entries_batch(&crate::db::test_fixture_entries())
            .expect("load fixtures");

        // 1. Bocchi the Rock! S01E12 should match Season 1 (id 130003)
        let mut bocchi_s1 = parse_filename(
            "[EMBER] Bocchi the Rock! - S01E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
        );
        let m_s1 = db.match_episode_to_anime(&mut bocchi_s1, None);
        assert_eq!(m_s1.as_ref().map(|m| m.0), Some(130003));
        assert_eq!(bocchi_s1.anime_season, Some(1));
        assert_eq!(bocchi_s1.episode_number, Some(12));

        // 2. Bocchi the Rock! S02E12 must NOT falsely match Season 1!
        let mut bocchi_s2 = parse_filename(
            "[EMBER] Bocchi the Rock! - S02E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
        );
        assert_eq!(bocchi_s2.anime_season, Some(2));
        assert_eq!(bocchi_s2.episode_number, Some(12));
        let m_s2 = db.match_episode_to_anime(&mut bocchi_s2, None);
        assert!(
            m_s2.is_none(),
            "Bocchi S02E12 should not match Season 1 in DB, got {:?}",
            m_s2
        );

        // 3. Kusuriya no Hitorigoto ep 26 (continuous numbering) -> Season 2 (id 176301) Episode 2
        let mut kusuriya_26 =
            parse_filename("[SubsPlease] Kusuriya no Hitorigoto - 26 (1080p).mkv");
        let m_k26 = db.match_episode_to_anime(&mut kusuriya_26, None);
        assert_eq!(m_k26.as_ref().map(|m| m.0), Some(176301));
        assert_eq!(kusuriya_26.anime_season, Some(2));
        assert_eq!(kusuriya_26.episode_number, Some(2));

        // 4. English title "The Apothecary Diaries - 26" -> redirects via AniList ID 161645 -> 176301 (Season 2 Episode 2)
        let mut apothecary_26 =
            parse_filename("[SubsPlease] The Apothecary Diaries - 26 (1080p).mkv");
        let m_a26 = db.match_episode_to_anime(&mut apothecary_26, None);
        assert_eq!(m_a26.as_ref().map(|m| m.0), Some(176301));
        assert_eq!(apothecary_26.anime_season, Some(2));
        assert_eq!(apothecary_26.episode_number, Some(2));

        // 5. Kusuriya no Hitorigoto ep 51 -> Season 3 Episode 3
        let kusuriya_51 =
            parse_filename("[SubsPlease] Kusuriya no Hitorigoto - 51 (1080p).mkv");
        assert_eq!(kusuriya_51.anime_title, "Kusuriya no Hitorigoto 3rd Season");
        assert_eq!(kusuriya_51.anime_season, Some(3));
        assert_eq!(kusuriya_51.episode_number, Some(3));

        let _ = std::fs::remove_file(&tmp_db_path);
    }
}
