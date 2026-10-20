use crate::db::{Database, TorrentRule};
use crate::detection::anitomy::{parse_filename, AnitomyElements};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentItem {
    pub title: String,
    pub torrent_url: String,
    pub magnet_url: String,
    pub info_hash: Option<String>,
    pub size: String,
    pub seeders: u32,
    pub leechers: u32,
    pub downloads: u32,
    pub pub_date: String,
    pub is_trusted: bool,
    pub provider: String,
    // Enriched via Anitomy + Library + Rules
    pub parsed: AnitomyElements,
    pub matched_anime_id: Option<i64>,
    pub matched_anime_title: Option<String>,
    pub matched_rule_name: Option<String>,
    pub matched_rule_action: Option<String>, // "highlight" | "auto_download" | "discard"
}

pub async fn search_torrents(
    query: &str,
    provider: &str,
    db: &Database,
) -> Result<Vec<TorrentItem>, String> {
    let client = Client::builder()
        .user_agent("Tora/0.1.0 (Anime Library Manager)")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let encoded_q = urlencoding::encode(query.trim());
    let url = if provider.eq_ignore_ascii_case("animetosho") {
        if query.trim().is_empty() {
            "https://feed.animetosho.org/rss2".to_string()
        } else {
            format!("https://feed.animetosho.org/rss2?q={}", encoded_q)
        }
    } else if query.trim().is_empty() {
        "https://nyaa.si/?page=rss&c=1_2&f=0".to_string()
    } else {
        format!("https://nyaa.si/?page=rss&c=1_2&f=0&q={}", encoded_q)
    };

    let rules = db.list_torrent_rules().unwrap_or_default();

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let xml_text = resp.text().await.map_err(|e| e.to_string())?;
            let items = parse_rss_xml(&xml_text, provider, db, &rules);
            Ok(items)
        }
        Ok(resp) => Err(format!(
            "Torrent feed returned HTTP {} from {}",
            resp.status(),
            provider
        )),
        Err(e) => Err(format!("Could not reach {} feed: {}", provider, e)),
    }
}

pub fn parse_rss_xml(
    xml: &str,
    provider: &str,
    db: &Database,
    rules: &[TorrentRule],
) -> Vec<TorrentItem> {
    let matcher = db.build_matcher_index().ok();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut items = Vec::new();
    let mut in_item = false;
    let mut current_tag = String::new();

    let mut title = String::new();
    let mut link = String::new();
    let mut pub_date = String::new();
    let mut size = String::new();
    let mut seeders: u32 = 0;
    let mut leechers: u32 = 0;
    let mut downloads: u32 = 0;
    let mut info_hash: Option<String> = None;
    let mut is_trusted = false;

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if tag_name == "item" {
                    in_item = true;
                    title.clear();
                    link.clear();
                    pub_date.clear();
                    size.clear();
                    seeders = 0;
                    leechers = 0;
                    downloads = 0;
                    info_hash = None;
                    is_trusted = false;
                } else if in_item {
                    current_tag = tag_name;
                }
            }
            Ok(Event::Text(e)) if in_item => {
                let txt = e.unescape().unwrap_or_default().to_string();
                match current_tag.as_str() {
                    "title" => title = txt,
                    "link" => link = txt,
                    "pubDate" => pub_date = txt,
                    "nyaa:size" => size = txt,
                    "nyaa:seeders" => seeders = txt.parse().unwrap_or(0),
                    "nyaa:leechers" => leechers = txt.parse().unwrap_or(0),
                    "nyaa:downloads" => downloads = txt.parse().unwrap_or(0),
                    "nyaa:infoHash" => info_hash = Some(txt),
                    "nyaa:trusted" => is_trusted = txt.eq_ignore_ascii_case("yes"),
                    "description" if size.is_empty() => {
                        // Extract size from description if AnimeTosho
                        if let Some(idx) = txt.find("Size:") {
                            let rest = &txt[idx + 5..];
                            let snippet: String = rest
                                .chars()
                                .take_while(|c| *c != '<' && *c != '|' && *c != '\n')
                                .collect();
                            size = snippet.trim().to_string();
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if tag_name == "item" && in_item {
                    in_item = false;
                    if !title.is_empty() {
                        let parsed = parse_filename(&title);
                        let magnet_url = if let Some(ref hash) = info_hash {
                            format!(
                                "magnet:?xt=urn:btih:{}&dn={}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce",
                                hash,
                                urlencoding::encode(&title)
                            )
                        } else if link.starts_with("magnet:") {
                            link.clone()
                        } else {
                            link.clone()
                        };

                        let matched_anime = matcher
                            .as_ref()
                            .and_then(|m| m.match_title(&parsed.normalized_title, None));
                        let (matched_anime_id, matched_anime_title, user_progress) =
                            match matched_anime {
                                Some((id, t, _cov, prog, _eps)) => (Some(id), Some(t), prog),
                                None => (None, None, 0),
                            };

                        let (rule_name, rule_action) = evaluate_rules(
                            &title,
                            &parsed,
                            matched_anime_id,
                            user_progress,
                            rules,
                        );

                        items.push(TorrentItem {
                            title: title.clone(),
                            torrent_url: link.clone(),
                            magnet_url,
                            info_hash: info_hash.clone(),
                            size: if size.is_empty() {
                                "Unknown".into()
                            } else {
                                size.clone()
                            },
                            seeders,
                            leechers,
                            downloads,
                            pub_date: pub_date.clone(),
                            is_trusted,
                            provider: provider.to_string(),
                            parsed,
                            matched_anime_id,
                            matched_anime_title,
                            matched_rule_name: rule_name,
                            matched_rule_action: rule_action,
                        });
                    }
                }
                current_tag.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    items
}

fn evaluate_rules(
    raw_title: &str,
    parsed: &AnitomyElements,
    matched_anime_id: Option<i64>,
    user_progress: u32,
    rules: &[TorrentRule],
) -> (Option<String>, Option<String>) {
    let raw_lower = raw_title.to_lowercase();

    for rule in rules.iter().filter(|r| r.enabled) {
        // 1. Check anime_id or title filter
        if let Some(rid) = rule.anime_id {
            if matched_anime_id != Some(rid) {
                continue;
            }
        }
        if !rule.anime_title_filter.trim().is_empty() {
            let filter_lower = rule.anime_title_filter.trim().to_lowercase();
            if !parsed.anime_title.to_lowercase().contains(&filter_lower)
                && !raw_lower.contains(&filter_lower)
            {
                continue;
            }
        } else if rule.anime_id.is_none() && matched_anime_id.is_none() {
            // A generic rule (no specific title filter) only applies to shows in the user's library
            continue;
        }

        // 2. Check release group filter
        if !rule.release_group.trim().is_empty() {
            let rg_filter = rule.release_group.trim().to_lowercase();
            let group_matches = parsed
                .release_group
                .as_ref()
                .map(|g| g.to_lowercase().contains(&rg_filter))
                .unwrap_or(false);
            if !group_matches {
                continue;
            }
        }

        // 3. Check resolution filter
        if !rule.resolution.trim().is_empty() && rule.resolution != "any" {
            let res_matches = parsed
                .video_resolution
                .as_ref()
                .map(|r| r.eq_ignore_ascii_case(rule.resolution.trim()))
                .unwrap_or(false);
            if !res_matches {
                continue;
            }
        }

        // 4. Check exclude keywords
        if !rule.exclude_keywords.trim().is_empty() {
            let excluded = rule
                .exclude_keywords
                .split(',')
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .any(|kw| raw_lower.contains(&kw));
            if excluded {
                continue;
            }
        }

        // 5. Check only_unwatched
        if rule.only_unwatched {
            if let Some(ep) = parsed.episode_number {
                if ep <= user_progress {
                    continue;
                }
            }
        }

        return (Some(rule.name.clone()), Some(rule.action.clone()));
    }

    (None, None)
}

/// Send a magnet URI or .torrent URL to qBittorrent WebUI API.
pub async fn send_to_qbittorrent(
    qb_url: &str,
    username: &str,
    password: &str,
    magnet_or_url: &str,
    category: &str,
    save_path: &str,
) -> Result<String, String> {
    let base = qb_url.trim().trim_end_matches('/');
    let client = Client::builder()
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // 1. Login if username/password provided
    if !username.trim().is_empty() || !password.is_empty() {
        let login_url = format!("{}/api/v2/auth/login", base);
        let resp = client
            .post(&login_url)
            .header("Referer", base)
            .form(&[("username", username.trim()), ("password", password)])
            .send()
            .await
            .map_err(|e| format!("Failed to connect to qBittorrent WebUI at {}: {}", base, e))?;

        if !resp.status().is_success() {
            return Err(format!(
                "qBittorrent login failed with HTTP {}",
                resp.status()
            ));
        }
    }

    // 2. Add torrent
    let add_url = format!("{}/api/v2/torrents/add", base);
    let mut form_fields: Vec<(&str, &str)> = vec![("urls", magnet_or_url)];
    if !category.trim().is_empty() {
        form_fields.push(("category", category.trim()));
    }
    if !save_path.trim().is_empty() {
        form_fields.push(("savepath", save_path.trim()));
    }

    let add_resp = client
        .post(&add_url)
        .header("Referer", base)
        .form(&form_fields)
        .send()
        .await
        .map_err(|e| format!("Failed to send torrent to qBittorrent: {}", e))?;

    if add_resp.status().is_success() {
        Ok("Torrent queued in qBittorrent WebUI".into())
    } else {
        Err(format!(
            "qBittorrent rejected torrent add request (HTTP {})",
            add_resp.status()
        ))
    }
}

pub async fn test_qbittorrent_connection(
    qb_url: &str,
    username: &str,
    password: &str,
) -> Result<String, String> {
    let base = qb_url.trim().trim_end_matches('/');
    let client = Client::builder()
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    if !username.trim().is_empty() || !password.is_empty() {
        let login_url = format!("{}/api/v2/auth/login", base);
        client
            .post(&login_url)
            .header("Referer", base)
            .form(&[("username", username.trim()), ("password", password)])
            .send()
            .await
            .map_err(|e| format!("qBittorrent unreachable at {}: {}", base, e))?;
    }

    let ver_url = format!("{}/api/v2/app/version", base);
    let resp = client
        .get(&ver_url)
        .send()
        .await
        .map_err(|e| format!("qBittorrent unreachable at {}: {}", base, e))?;

    if resp.status().is_success() {
        let ver = resp.text().await.unwrap_or_else(|_| "unknown".into());
        Ok(format!("Connected to qBittorrent {}", ver.trim()))
    } else {
        Err(format!(
            "qBittorrent WebUI returned HTTP {} (check credentials or WebUI settings)",
            resp.status()
        ))
    }
}
