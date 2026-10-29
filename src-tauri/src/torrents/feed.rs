//! RSS feeds: fetching any RSS 2.0 torrent feed (Nyaa, SubsPlease, …) and parsing it into [`RawRelease`]s
//! (parsed once with Anitomy and cached), plus search URL templates (`%title%`).
//!
//! Tags are matched by local name, so `nyaa:size`, `subsplease:size` and `torrent:contentLength` all work.

use super::traits::{release_traits, ReleaseTraits};
use crate::detection::anitomy::{parse_filename, AnitomyElements};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use reqwest::Client;
use serde::Serialize;

const NYAA_RSS: &str = "https://nyaa.si/?page=rss";
/// Placeholder in search feed URLs, replaced by the URL-encoded anime title.
pub const TITLE_PLACEHOLDER: &str = "%title%";
pub const NYAA_SEARCH_DEFAULT: &str = "https://nyaa.si/?page=rss&c=1_2&f=0&q=%title%";
const MAGNET_TRACKERS: &str = "&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce\
&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce\
&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce\
&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce";

/// One feed item, independent of the user's list (matching happens per board build).
#[derive(Debug, Clone, Serialize)]
pub struct RawRelease {
    pub title: String,
    /// `.torrent` download link (empty when the feed only gives a magnet).
    pub torrent_url: String,
    /// Release page, when the feed gives one.
    pub view_url: String,
    /// Lowercase hex info hash.
    pub info_hash: Option<String>,
    pub magnet_url: String,
    pub size_label: String,
    pub size_bytes: Option<u64>,
    pub seeders: u32,
    pub leechers: u32,
    pub downloads: u32,
    /// The feed reports seeders / leechers (SubsPlease and most non-Nyaa feeds don't).
    pub peers_known: bool,
    pub pub_unix: Option<i64>,
    pub trusted: bool,
    pub remake: bool,
    #[serde(skip)]
    pub parsed: AnitomyElements,
    pub traits: ReleaseTraits,
}

impl RawRelease {
    /// Stable identity for de-duplication and selection (info hash, else the title).
    pub fn key(&self) -> String {
        self.info_hash.clone().unwrap_or_else(|| self.title.clone())
    }
}

pub fn is_feed_url(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("https://") || u.starts_with("http://")
}

/// Host of a URL, for names and error messages (`subsplease.org`).
pub fn url_host(url: &str) -> String {
    let rest = url.trim().split_once("://").map(|(_, r)| r).unwrap_or(url.trim());
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.trim_start_matches("www.").to_string()
}

/// Nyaa RSS URL from a query, category and uploader filter (the "Build Nyaa URL" helper).
pub fn nyaa_url(query: &str, category: &str, filter: u8) -> String {
    let category = if category.trim().is_empty() { "1_2" } else { category.trim() };
    let mut url = format!("{}&c={}&f={}", NYAA_RSS, urlencoding::encode(category), filter.min(2));
    if !query.trim().is_empty() {
        url.push_str("&q=");
        url.push_str(&urlencoding::encode(query.trim()));
    }
    url
}

pub fn has_title_placeholder(template: &str) -> bool {
    template.to_ascii_lowercase().contains(TITLE_PLACEHOLDER)
}

/// Characters a browser shows decoded in the address bar but sends percent-encoded. `src/torrents.ts`
/// `displayUrl` decodes exactly this set (plus non-ASCII), so display → save → display round-trips.
const DISPLAY_DECODED: &[u8] = br#" "<>`{}|\^[]"#;

/// Canonical stored form of a feed URL as typed or pasted: percent-encodes [`DISPLAY_DECODED`], control
/// characters and non-ASCII (UTF-8 bytes); everything else is kept as is, `%` included, so `%title%` and
/// existing `%XX` escapes survive and already-encoded URLs don't change.
pub fn normalize_url(url: &str) -> String {
    let mut out = String::with_capacity(url.len());
    for &b in url.trim().as_bytes() {
        if b < 0x20 || b >= 0x7f || DISPLAY_DECODED.contains(&b) {
            out.push_str(&format!("%{:02X}", b));
        } else {
            out.push(b as char);
        }
    }
    out
}

/// Fills a search feed template: every `%title%` (any case) becomes the URL-encoded query.
pub fn search_url(template: &str, query: &str) -> String {
    let encoded = urlencoding::encode(query.trim()).to_string();
    let lower = template.to_ascii_lowercase();
    let mut out = String::with_capacity(template.len() + encoded.len());
    let mut last = 0;
    for (i, _) in lower.match_indices(TITLE_PLACEHOLDER) {
        out.push_str(&template[last..i]);
        out.push_str(&encoded);
        last = i + TITLE_PLACEHOLDER.len();
    }
    out.push_str(&template[last..]);
    out.trim().to_string()
}

pub async fn fetch_feed(url: &str) -> Result<Vec<RawRelease>, String> {
    let host = url_host(url);
    let client = Client::builder()
        .user_agent("Tora/0.1.0 (Anime Library Manager)")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not reach {}: {}", host, e))?;
    if !resp.status().is_success() {
        return Err(format!("{} returned HTTP {}", host, resp.status()));
    }
    let xml = resp.text().await.map_err(|e| e.to_string())?;
    // Anitomy runs through FFI per title; keep it off the async workers.
    tokio::task::spawn_blocking(move || parse_rss(&xml))
        .await
        .map_err(|e| e.to_string())
}

/// RFC 2822 date; a weekday that doesn't match the date is ignored instead of failing the parse.
fn parse_pub_date(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    chrono::DateTime::parse_from_rfc2822(raw)
        .or_else(|_| {
            let without_weekday = raw.split_once(',').map(|(_, rest)| rest.trim()).unwrap_or(raw);
            chrono::DateTime::parse_from_str(without_weekday, "%d %b %Y %H:%M:%S %z")
        })
        .ok()
        .map(|d| d.timestamp())
}

fn magnet_for(hash: &str, title: &str) -> String {
    format!(
        "magnet:?xt=urn:btih:{}&dn={}{}",
        hash,
        urlencoding::encode(title),
        MAGNET_TRACKERS
    )
}

/// RFC 4648 base32 (32 chars, as in magnet links) → 40-char lowercase hex.
pub fn base32_to_hex(s: &str) -> Option<String> {
    let s = s.trim().trim_end_matches('=').to_ascii_uppercase();
    if s.len() != 32 {
        return None;
    }
    let mut bits: u64 = 0;
    let mut nbits = 0;
    let mut out = String::with_capacity(40);
    for c in s.chars() {
        let v = match c {
            'A'..='Z' => c as u64 - 'A' as u64,
            '2'..='7' => c as u64 - '2' as u64 + 26,
            _ => return None,
        };
        bits = (bits << 5) | v;
        nbits += 5;
        if nbits >= 8 {
            nbits -= 8;
            out.push_str(&format!("{:02x}", (bits >> nbits) & 0xff));
        }
    }
    (out.len() == 40).then_some(out)
}

/// A 40-char hex or 32-char base32 info hash → lowercase hex.
fn normalize_hash(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(s.to_ascii_lowercase());
    }
    base32_to_hex(s)
}

/// Info hash from a magnet's `xt=urn:btih:…`.
fn magnet_hash(magnet: &str) -> Option<String> {
    let lower = magnet.to_ascii_lowercase();
    let start = lower.find("urn:btih:")? + "urn:btih:".len();
    let hash: String = magnet[start..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    normalize_hash(&hash)
}

fn is_torrent_link(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    let path = u.split(['?', '#']).next().unwrap_or(&u);
    path.ends_with(".torrent") || path.ends_with("/torrent") || path.contains("/download/")
}

/// Nyaa `/download/N.torrent` or `/view/N/torrent` → `/view/N`.
fn nyaa_view_from(link: &str) -> Option<String> {
    let lower = link.to_ascii_lowercase();
    if !lower.contains("nyaa.") {
        return None;
    }
    let (base, rest) = if let Some(i) = lower.find("/download/") {
        (&link[..i], &link[i + "/download/".len()..])
    } else if let Some(i) = lower.find("/view/") {
        (&link[..i], &link[i + "/view/".len()..])
    } else {
        return None;
    };
    let id: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!id.is_empty()).then(|| format!("{}/view/{}", base, id))
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.1} {}", v, UNITS[u])
    }
}

#[derive(Default)]
struct ItemFields {
    title: String,
    link: String,
    guid: String,
    comments: String,
    pub_date: String,
    size: String,
    size_bytes: Option<u64>,
    seeders: Option<u32>,
    leechers: Option<u32>,
    downloads: u32,
    info_hash: Option<String>,
    magnet: String,
    enclosure: String,
    trusted: bool,
    remake: bool,
}

impl ItemFields {
    fn into_release(self) -> Option<RawRelease> {
        if self.title.trim().is_empty() {
            return None;
        }
        let parsed = parse_filename(&self.title);
        let traits = release_traits(&self.title, &parsed);

        let link = self.link.trim();
        let magnet_in_feed = if self.magnet.starts_with("magnet:") {
            self.magnet.clone()
        } else if link.starts_with("magnet:") {
            link.to_string()
        } else {
            String::new()
        };
        let torrent_url = if !self.enclosure.is_empty() {
            self.enclosure.clone()
        } else if is_feed_url(link) && is_torrent_link(link) {
            link.to_string()
        } else {
            String::new()
        };
        let info_hash = self
            .info_hash
            .as_deref()
            .and_then(normalize_hash)
            .or_else(|| magnet_hash(&magnet_in_feed))
            .or_else(|| normalize_hash(&self.guid));
        let magnet_url = if !magnet_in_feed.is_empty() {
            magnet_in_feed
        } else {
            info_hash.as_deref().map(|h| magnet_for(h, &self.title)).unwrap_or_default()
        };
        let view_url = [self.guid.trim(), self.comments.trim()]
            .into_iter()
            .find(|u| is_feed_url(u) && !is_torrent_link(u))
            .map(String::from)
            .or_else(|| nyaa_view_from(link))
            .or_else(|| (is_feed_url(link) && !is_torrent_link(link)).then(|| link.to_string()))
            .unwrap_or_default();
        let size_bytes = self.size_bytes.or_else(|| super::query::parse_size(&self.size));
        let size_label = if !self.size.is_empty() {
            self.size.clone()
        } else {
            size_bytes.map(format_bytes).unwrap_or_else(|| "?".into())
        };

        Some(RawRelease {
            size_bytes,
            size_label,
            pub_unix: parse_pub_date(&self.pub_date),
            peers_known: self.seeders.is_some() || self.leechers.is_some(),
            seeders: self.seeders.unwrap_or(0),
            leechers: self.leechers.unwrap_or(0),
            title: self.title,
            torrent_url,
            view_url,
            info_hash,
            magnet_url,
            downloads: self.downloads,
            trusted: self.trusted,
            remake: self.remake,
            parsed,
            traits,
        })
    }
}

/// Tag name without its namespace prefix, lowercased (`nyaa:infoHash` → `infohash`).
fn local_name(raw: &[u8]) -> String {
    let name = String::from_utf8_lossy(raw);
    name.rsplit(':').next().unwrap_or(&name).to_ascii_lowercase()
}

/// `<enclosure url=… length=… type=…/>`: a torrent link and its size.
fn read_enclosure(item: &mut ItemFields, e: &BytesStart) {
    let mut url = String::new();
    let mut length = None;
    let mut kind = String::new();
    for attr in e.attributes().flatten() {
        let value = attr.unescape_value().map(|v| v.to_string()).unwrap_or_default();
        match local_name(attr.key.as_ref()).as_str() {
            "url" => url = value,
            "length" => length = value.trim().parse::<u64>().ok().filter(|n| *n > 0),
            "type" => kind = value.to_ascii_lowercase(),
            _ => {}
        }
    }
    if url.starts_with("magnet:") {
        item.magnet = url;
    } else if kind.contains("bittorrent") || is_torrent_link(&url) {
        item.enclosure = url;
        if item.size_bytes.is_none() {
            item.size_bytes = length;
        }
    }
}

pub fn parse_rss(xml: &str) -> Vec<RawRelease> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut items = Vec::new();
    let mut current: Option<ItemFields> = None;
    let mut tag = String::new();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref());
                if name == "item" {
                    current = Some(ItemFields::default());
                } else if let Some(item) = current.as_mut() {
                    if name == "enclosure" {
                        read_enclosure(item, &e);
                    }
                    tag = name;
                }
            }
            Ok(Event::Empty(e)) => {
                if let Some(item) = current.as_mut() {
                    if local_name(e.name().as_ref()) == "enclosure" {
                        read_enclosure(item, &e);
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(item) = current.as_mut() {
                    let txt = e.unescape().unwrap_or_default().trim().to_string();
                    set_field(item, &tag, txt);
                }
            }
            Ok(Event::CData(e)) => {
                if let Some(item) = current.as_mut() {
                    let txt = String::from_utf8_lossy(&e.into_inner()).trim().to_string();
                    set_field(item, &tag, txt);
                }
            }
            Ok(Event::End(e)) => {
                if local_name(e.name().as_ref()) == "item" {
                    if let Some(release) = current.take().and_then(ItemFields::into_release) {
                        items.push(release);
                    }
                }
                tag.clear();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    items
}

fn set_field(item: &mut ItemFields, tag: &str, txt: String) {
    let yes = txt.eq_ignore_ascii_case("yes") || txt.eq_ignore_ascii_case("true");
    match tag {
        "title" => item.title = txt,
        "link" => item.link = txt,
        "guid" => item.guid = txt,
        "comments" => item.comments = txt,
        "pubdate" => item.pub_date = txt,
        "size" => item.size = txt,
        "contentlength" => item.size_bytes = txt.parse().ok().filter(|n| *n > 0),
        "seeders" | "seeds" => item.seeders = txt.parse().ok(),
        "leechers" => item.leechers = txt.parse().ok(),
        "downloads" => item.downloads = txt.parse().unwrap_or(0),
        "infohash" => item.info_hash = Some(txt),
        "magneturi" => item.magnet = txt,
        "trusted" => item.trusted = yes,
        "remake" => item.remake = yes,
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0">
  <channel>
    <title>Nyaa - Home - Torrent File RSS</title>
    <item>
      <title>[Judas] Kusuriya no Hitorigoto S3 - 03 [1080p][HEVC x265 10bit][Eng-Subs]</title>
      <link>https://nyaa.si/download/1999999.torrent</link>
      <guid isPermaLink="true">https://nyaa.si/view/1999999</guid>
      <pubDate>Tue, 28 Oct 2026 18:02:11 -0000</pubDate>
      <nyaa:seeders>412</nyaa:seeders>
      <nyaa:leechers>37</nyaa:leechers>
      <nyaa:downloads>1890</nyaa:downloads>
      <nyaa:infoHash>ABCDEF0123456789ABCDEF0123456789ABCDEF01</nyaa:infoHash>
      <nyaa:categoryId>1_2</nyaa:categoryId>
      <nyaa:size>431.2 MiB</nyaa:size>
      <nyaa:trusted>Yes</nyaa:trusted>
      <nyaa:remake>No</nyaa:remake>
      <description><![CDATA[<a href="https://nyaa.si/view/1999999">#1999999 | x</a>]]></description>
    </item>
    <item>
      <title>[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv</title>
      <link>https://nyaa.si/download/2000000.torrent</link>
      <guid isPermaLink="true">https://nyaa.si/view/2000000</guid>
      <pubDate>Tue, 28 Oct 2026 19:00:00 -0000</pubDate>
      <nyaa:seeders>9</nyaa:seeders>
      <nyaa:leechers>1</nyaa:leechers>
      <nyaa:downloads>10</nyaa:downloads>
      <nyaa:infoHash>1111111111111111111111111111111111111111</nyaa:infoHash>
      <nyaa:size>1.4 GiB</nyaa:size>
      <nyaa:trusted>No</nyaa:trusted>
      <nyaa:remake>Yes</nyaa:remake>
    </item>
  </channel>
</rss>"#;

    // SubsPlease, captured live: `?t` gives a Nyaa .torrent link and a base32 hash guid; without it, a magnet.
    const SUBSPLEASE: &str = r#"<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:subsplease="https://subsplease.org/rss"><channel><title>SubsPlease RSS</title>
<item><title>[SubsPlease] Link Click S3 (01-12) (1080p) [Batch]</title><link>https://nyaa.si/view/2179935/torrent</link><guid isPermaLink="false">QEAIIINCROIRXB42DA6HGRZA7YNU3JT4</guid><pubDate>Wed, 28 Oct 2026 16:54:37 +0000</pubDate><category>Link Click S3 - 1080</category><subsplease:size>15.93 GiB</subsplease:size></item>
<item><title>[SubsPlease] Kikansha no Mahou wa Tokubetsu desu - 16 (1080p) [7579A878].mkv</title><link>magnet:?xt=urn:btih:QEAIIINCROIRXB42DA6HGRZA7YNU3JT4&amp;dn=x&amp;tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce</link><guid isPermaLink="false">QEAIIINCROIRXB42DA6HGRZA7YNU3JT4</guid><pubDate>Wed, 28 Oct 2026 10:16:58 +0000</pubDate><subsplease:size>1.34 GiB</subsplease:size></item>
</channel></rss>"#;

    const ENCLOSURE: &str = r#"<rss version="2.0" xmlns:torrent="http://xmlns.ezrss.it/0.1/"><channel>
<item><title>[ASW] Dandadan - 07 [1080p HEVC]</title><link>https://example.org/releases/77</link>
<enclosure url="https://example.org/dl/77.torrent" length="734003200" type="application/x-bittorrent"/>
<torrent:infoHash>2222222222222222222222222222222222222222</torrent:infoHash><torrent:seeds>15</torrent:seeds></item>
</channel></rss>"#;

    #[test]
    fn parses_nyaa_items() {
        let items = parse_rss(FIXTURE);
        assert_eq!(items.len(), 2);
        let a = &items[0];
        assert_eq!(a.torrent_url, "https://nyaa.si/download/1999999.torrent");
        assert_eq!(a.view_url, "https://nyaa.si/view/1999999");
        assert_eq!(a.info_hash.as_deref(), Some("abcdef0123456789abcdef0123456789abcdef01"));
        assert!(a.magnet_url.starts_with("magnet:?xt=urn:btih:abcdef0123456789"));
        assert_eq!(a.size_bytes, Some((431.2 * 1024.0 * 1024.0) as u64));
        assert_eq!(a.seeders, 412);
        assert!(a.peers_known);
        assert!(a.trusted && !a.remake);
        assert_eq!(a.parsed.release_group.as_deref(), Some("Judas"));
        assert_eq!(a.traits.codec.as_deref(), Some("hevc"));
        assert!(a.pub_unix.is_some());
        assert!(items[1].remake && !items[1].trusted);
    }

    #[test]
    fn parses_subsplease_items() {
        let items = parse_rss(SUBSPLEASE);
        assert_eq!(items.len(), 2);
        let hex = "81008421a28b911b879a183c734720fe1b4da67c";
        let t = &items[0];
        assert_eq!(t.torrent_url, "https://nyaa.si/view/2179935/torrent");
        assert_eq!(t.view_url, "https://nyaa.si/view/2179935");
        assert_eq!(t.info_hash.as_deref(), Some(hex));
        assert!(t.magnet_url.contains(hex));
        assert_eq!(t.size_label, "15.93 GiB");
        assert!(t.size_bytes.is_some());
        assert!(!t.peers_known);
        assert!(t.traits.batch);

        let m = &items[1];
        assert!(m.torrent_url.is_empty());
        assert!(m.magnet_url.starts_with("magnet:?xt=urn:btih:QEAIIINC"));
        assert_eq!(m.info_hash.as_deref(), Some(hex));
        assert_eq!(m.view_url, "");
    }

    #[test]
    fn parses_enclosures_and_ezrss_tags() {
        let items = parse_rss(ENCLOSURE);
        let r = &items[0];
        assert_eq!(r.torrent_url, "https://example.org/dl/77.torrent");
        assert_eq!(r.view_url, "https://example.org/releases/77");
        assert_eq!(r.size_bytes, Some(734003200));
        assert_eq!(r.size_label, "700.0 MiB");
        assert_eq!(r.seeders, 15);
        assert!(r.peers_known);
        assert_eq!(r.info_hash.as_deref(), Some("2222222222222222222222222222222222222222"));
    }

    #[test]
    fn hashes_and_hosts() {
        assert_eq!(base32_to_hex("QEAIIINCROIRXB42DA6HGRZA7YNU3JT4").as_deref(), Some("81008421a28b911b879a183c734720fe1b4da67c"));
        assert_eq!(base32_to_hex("not-a-hash"), None);
        assert_eq!(url_host("https://www.subsplease.org/rss/?t&r=1080"), "subsplease.org");
    }

    #[test]
    fn builds_urls() {
        assert_eq!(nyaa_url("", "1_2", 0), "https://nyaa.si/?page=rss&c=1_2&f=0");
        assert_eq!(
            nyaa_url("Kusuriya no Hitorigoto", "", 2),
            "https://nyaa.si/?page=rss&c=1_2&f=2&q=Kusuriya%20no%20Hitorigoto"
        );
        assert_eq!(
            search_url("https://nyaa.si/?page=rss&c=0_0&f=0&q=%TITLE%+1080p", "Re:Zero kara"),
            "https://nyaa.si/?page=rss&c=0_0&f=0&q=Re%3AZero%20kara+1080p"
        );
        assert!(has_title_placeholder(NYAA_SEARCH_DEFAULT));
        assert!(!has_title_placeholder("https://subsplease.org/rss/?r=1080"));
    }

    #[test]
    fn normalizes_urls_like_a_browser_sends_them() {
        assert_eq!(
            normalize_url(" https://nyaa.si/?page=rss&c=1_2&f=0&q=Erai+1080p|Ironclad|Judas "),
            "https://nyaa.si/?page=rss&c=1_2&f=0&q=Erai+1080p%7CIronclad%7CJudas"
        );
        assert_eq!(
            normalize_url("https://nyaa.si/?q=[Judas] 薬屋"),
            "https://nyaa.si/?q=%5BJudas%5D%20%E8%96%AC%E5%B1%8B"
        );
        // Already-encoded URLs, `+`, other escapes and `%title%` are untouched (idempotent).
        for url in [
            "https://nyaa.si/?page=rss&c=0_0&f=0&q=Erai+1080p%7CJudas%7CIronclad",
            "https://nyaa.si/?page=rss&c=0_0&f=0&q=%title%+%26+more%3D",
            NYAA_SEARCH_DEFAULT,
        ] {
            assert_eq!(normalize_url(url), url);
            assert_eq!(normalize_url(&normalize_url(url)), url);
        }
    }
}
