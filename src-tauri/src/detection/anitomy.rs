use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Parsed anime filename metadata (modeled after Anitomy's Elements structure).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AnitomyElements {
    pub file_name: String,
    pub file_extension: Option<String>,
    pub anime_title: String,
    pub normalized_title: String,
    pub anime_season: Option<u32>,
    pub episode_number: Option<u32>,
    pub episode_number_alt: Option<u32>,
    pub episode_version: Option<u32>,
    pub episode_title: Option<String>,
    pub release_group: Option<String>,
    pub video_resolution: Option<String>,
    pub video_term: Vec<String>,
    pub audio_term: Vec<String>,
    pub source: Option<String>,
    pub file_checksum: Option<String>,
    pub anime_type: Option<String>,
    pub volume_number: Option<u32>,
    pub is_batch: bool,
    pub subtitles: Option<String>,
}

static RE_CHECKSUM: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^[0-9A-F]{8}$").unwrap());
static RE_RESOLUTION: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(2160p|1080p|720p|576p|480p|4K|UHD|3840x2160|1920x1080|1280x720)\b")
        .unwrap()
});
static RE_BRACKETS: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\[([^\[\]]+)\]|\(([^\(\)]+)\)|\{([^\{\}]+)\}").unwrap());
static RE_LEADING_GROUP: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*\[([^\[\]]+)\]\s*").unwrap());
static RE_SXXEXX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\bS(\d{1,2})E(\d{1,4})(?:v(\d))?(?:-E?(\d{1,4}))?\b").unwrap()
});
static RE_EP_EXPLICIT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:EP|Ep\.?|Episode)\s*(\d{1,4})(?:v(\d))?\b").unwrap()
});
static RE_DASH_EP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\s+[-–—]\s+(\d{1,4})(?:v(\d))?(?:\s*[-~]\s*(\d{1,4}))?(?:\s+|\.|\[|\(|$)",
    )
    .unwrap()
});
static RE_SEASON_SUFFIX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:Season\s*(\d{1,2})|S(\d{1,2})|(\d{1,2})(?:nd|rd|th)\s+Season)\b")
        .unwrap()
});
static RE_TRAILING_EP: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(.+?)\s+(\d{1,3})(?:v(\d))?\s*$").unwrap()
});
static RE_BATCH_RANGE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b|\b(?:Batch|Complete\s*Series|Complete)\b")
        .unwrap()
});
static RE_VOLUME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(?:Vol\.?|Volume)\s*(\d{1,2})\b").unwrap());

const VIDEO_TERMS: &[(&str, &str)] = &[
    ("hevc", "HEVC"),
    ("x265", "x265"),
    ("h265", "H.265"),
    ("h.265", "H.265"),
    ("av1", "AV1"),
    ("x264", "x264"),
    ("h264", "H.264"),
    ("h.264", "H.264"),
    ("10bit", "10-bit"),
    ("10-bit", "10-bit"),
    ("hi10p", "10-bit"),
    ("hi10", "10-bit"),
    ("hdr", "HDR"),
    ("dv", "Dolby Vision"),
];

const AUDIO_TERMS: &[(&str, &str)] = &[
    ("flac", "FLAC"),
    ("aac", "AAC"),
    ("opus", "Opus"),
    ("eac3", "E-AC-3"),
    ("e-ac-3", "E-AC-3"),
    ("ac3", "AC3"),
    ("dts", "DTS"),
    ("truehd", "TrueHD"),
    ("dual audio", "Dual Audio"),
    ("dual-audio", "Dual Audio"),
    ("multi-audio", "Multi Audio"),
];

const SOURCE_TERMS: &[(&str, &str)] = &[
    ("blu-ray", "BluRay"),
    ("bluray", "BluRay"),
    ("bdrip", "BDRip"),
    ("bd", "BluRay"),
    ("web-dl", "WEB-DL"),
    ("webdl", "WEB-DL"),
    ("webrip", "WEBRip"),
    ("web", "WEB"),
    ("hdtv", "HDTV"),
    ("dvdrip", "DVDRip"),
];

const ANIME_TYPES: &[(&str, &str)] = &[
    ("ova", "OVA"),
    ("oad", "OAD"),
    ("ona", "ONA"),
    ("ncop", "NCOP"),
    ("nced", "NCED"),
    ("special", "Special"),
    ("sp", "Special"),
    ("movie", "Movie"),
];

/// Normalize an anime title for fast O(1) dictionary/index lookups and fuzzy comparisons.
pub fn normalize_anime_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_space = true;
    for ch in title.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim().to_string()
}

/// Parse an anime filename or window title into structured Anitomy elements.
pub fn parse_filename(input: &str) -> AnitomyElements {
    let mut elements = AnitomyElements {
        file_name: input.to_string(),
        ..Default::default()
    };

    // Strip path if present
    let base_name = input
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(input)
        .trim();

    // Extract known video extension if present
    let working = if let Some((stem, ext)) = base_name.rsplit_once('.') {
        let ext_lower = ext.to_lowercase();
        if matches!(
            ext_lower.as_str(),
            "mkv" | "mp4" | "avi" | "webm" | "m4v" | "mov" | "ts" | "m2ts" | "flv" | "ogm"
        ) {
            elements.file_extension = Some(ext_lower);
            stem.to_string()
        } else {
            base_name.to_string()
        }
    } else {
        base_name.to_string()
    };

    // Replace underscores with spaces if there are few or no spaces
    let mut cleaned = if !working.contains(' ') && working.contains('_') {
        working.replace('_', " ")
    } else {
        working.replace('_', " ")
    };

    // Extract leading release group [Group]
    if let Some(cap) = RE_LEADING_GROUP.captures(&cleaned) {
        let group = cap.get(1).unwrap().as_str().trim();
        // Ensure it's not a resolution or checksum
        if !RE_CHECKSUM.is_match(group) && !RE_RESOLUTION.is_match(group) {
            elements.release_group = Some(group.to_string());
        }
    }

    // Inspect all bracketed segments [ ... ], ( ... ), { ... }
    for cap in RE_BRACKETS.captures_iter(&cleaned) {
        let inner = cap
            .get(1)
            .or_else(|| cap.get(2))
            .or_else(|| cap.get(3))
            .map(|m| m.as_str().trim())
            .unwrap_or("");
        if inner.is_empty() {
            continue;
        }

        // Checksum e.g. [F02B9C1A]
        if RE_CHECKSUM.is_match(inner) {
            elements.file_checksum = Some(inner.to_uppercase());
            continue;
        }

        // Resolution inside brackets
        if let Some(res_m) = RE_RESOLUTION.find(inner) {
            let r = res_m.as_str().to_lowercase();
            elements.video_resolution = Some(match r.as_str() {
                "3840x2160" | "4k" | "uhd" | "2160p" => "2160p".to_string(),
                "1920x1080" | "1080p" => "1080p".to_string(),
                "1280x720" | "720p" => "720p".to_string(),
                _ => r,
            });
        }

        let inner_lower = inner.to_lowercase();

        for (needle, label) in VIDEO_TERMS {
            if inner_lower.contains(needle) && !elements.video_term.contains(&label.to_string()) {
                elements.video_term.push(label.to_string());
            }
        }
        for (needle, label) in AUDIO_TERMS {
            if inner_lower.contains(needle) && !elements.audio_term.contains(&label.to_string()) {
                elements.audio_term.push(label.to_string());
            }
        }
        if elements.source.is_none() {
            for (needle, label) in SOURCE_TERMS {
                if inner_lower.split(|c: char| !c.is_alphanumeric() && c != '-').any(|tok| tok == *needle) {
                    elements.source = Some(label.to_string());
                    break;
                }
            }
        }
        if inner_lower.contains("multi-sub")
            || inner_lower.contains("multiple subtitle")
            || inner_lower.contains("multisub")
        {
            elements.subtitles = Some("Multi-Subs".to_string());
        } else if inner_lower.contains("eng") || inner_lower.contains("english") {
            elements.subtitles = Some("ENG".to_string());
        }
        if inner_lower.contains("batch") || inner_lower.contains("complete") {
            elements.is_batch = true;
        }
    }

    // Check trailing release group like "-Group" at end before extension if release_group is still None
    // Now remove all bracketed tags to isolate Title + Episode + Season
    let without_brackets = RE_BRACKETS.replace_all(&cleaned, " ").to_string();
    cleaned = without_brackets
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    // Also scan non-bracketed string for resolution / video terms / source if not found yet
    if elements.video_resolution.is_none() {
        if let Some(res_m) = RE_RESOLUTION.find(&cleaned) {
            let r = res_m.as_str().to_lowercase();
            elements.video_resolution = Some(match r.as_str() {
                "3840x2160" | "4k" | "uhd" | "2160p" => "2160p".to_string(),
                "1920x1080" | "1080p" => "1080p".to_string(),
                "1280x720" | "720p" => "720p".to_string(),
                _ => r,
            });
            cleaned = cleaned.replace(res_m.as_str(), " ");
        }
    }

    let cleaned_lower = cleaned.to_lowercase();
    for (needle, label) in VIDEO_TERMS {
        if cleaned_lower
            .split(|c: char| !c.is_alphanumeric() && c != '.' && c != '-')
            .any(|t| t == *needle)
            && !elements.video_term.contains(&label.to_string())
        {
            elements.video_term.push(label.to_string());
        }
    }
    for (needle, label) in AUDIO_TERMS {
        if cleaned_lower
            .split(|c: char| !c.is_alphanumeric() && c != '-')
            .any(|t| t == *needle)
            && !elements.audio_term.contains(&label.to_string())
        {
            elements.audio_term.push(label.to_string());
        }
    }
    if elements.source.is_none() {
        for (needle, label) in SOURCE_TERMS {
            if cleaned_lower
                .split(|c: char| !c.is_alphanumeric() && c != '-')
                .any(|t| t == *needle)
            {
                elements.source = Some(label.to_string());
                break;
            }
        }
    }

    // Detect volume number if present
    if let Some(cap) = RE_VOLUME.captures(&cleaned) {
        if let Ok(v) = cap[1].parse::<u32>() {
            elements.volume_number = Some(v);
        }
    }

    // 1. Check S01E12 pattern
    let mut title_part = cleaned.clone();
    if let Some(cap) = RE_SXXEXX.captures(&cleaned) {
        let full_match = cap.get(0).unwrap();
        if let Ok(s) = cap[1].parse::<u32>() {
            elements.anime_season = Some(s);
        }
        if let Ok(ep) = cap[2].parse::<u32>() {
            elements.episode_number = Some(ep);
        }
        if let Some(v) = cap.get(3).and_then(|m| m.as_str().parse::<u32>().ok()) {
            elements.episode_version = Some(v);
        }
        if let Some(ep2) = cap.get(4).and_then(|m| m.as_str().parse::<u32>().ok()) {
            elements.episode_number_alt = Some(ep2);
        }
        title_part = cleaned[..full_match.start()].trim_end_matches(['-', '–', '—', ' ', '.']).to_string();
    } else if let Some(cap) = RE_DASH_EP.captures(&cleaned) {
        // 2. Check "Title - 04v2" pattern (use last occurrence if Title itself has a dash like "Title - Season 2 - 04")
        let mut last_cap = cap;
        for c in RE_DASH_EP.captures_iter(&cleaned) {
            last_cap = c;
        }
        let full_match = last_cap.get(0).unwrap();
        if let Ok(ep) = last_cap[1].parse::<u32>() {
            elements.episode_number = Some(ep);
        }
        if let Some(v) = last_cap.get(2).and_then(|m| m.as_str().parse::<u32>().ok()) {
            elements.episode_version = Some(v);
        }
        if let Some(ep2) = last_cap.get(3).and_then(|m| m.as_str().parse::<u32>().ok()) {
            elements.episode_number_alt = Some(ep2);
            elements.is_batch = true;
        }
        let after = cleaned[full_match.end()..].trim();
        if !after.is_empty() && !after.starts_with('-') {
            elements.episode_title = Some(after.trim_start_matches(['-', ' ', ':']).to_string());
        }
        title_part = cleaned[..full_match.start()].trim().to_string();
    } else if let Some(cap) = RE_EP_EXPLICIT.captures(&cleaned) {
        // 3. Check "Title Episode 05" / "Title Ep 05"
        let full_match = cap.get(0).unwrap();
        if let Ok(ep) = cap[1].parse::<u32>() {
            elements.episode_number = Some(ep);
        }
        if let Some(v) = cap.get(2).and_then(|m| m.as_str().parse::<u32>().ok()) {
            elements.episode_version = Some(v);
        }
        title_part = cleaned[..full_match.start()]
            .trim_end_matches(['-', '–', '—', ' ', '.'])
            .to_string();
    } else if let Some(cap) = RE_TRAILING_EP.captures(&cleaned) {
        // 4. Check "Title 05" at end of string (avoid matching years like 2024 or "Mob Psycho 100")
        if let Ok(ep) = cap[2].parse::<u32>() {
            let prefix = cap[1].trim();
            let is_hundred_title = ep == 100 && prefix.to_lowercase().ends_with("psycho");
            let is_eighty_six = ep == 86 && prefix.is_empty();
            if !is_hundred_title && !is_eighty_six && ep <= 1500 {
                elements.episode_number = Some(ep);
                if let Some(v) = cap.get(3).and_then(|m| m.as_str().parse::<u32>().ok()) {
                    elements.episode_version = Some(v);
                }
                title_part = prefix.trim_end_matches(['-', '–', '—', ' ']).to_string();
            }
        }
    }

    // Check if Season indicator is inside title_part (e.g., "Kusuriya no Hitorigoto 2nd Season" or "Attack on Titan - Season 4")
    if let Some(cap) = RE_SEASON_SUFFIX.captures(&title_part) {
        let s_num = cap
            .get(1)
            .or_else(|| cap.get(2))
            .or_else(|| cap.get(3))
            .and_then(|m| m.as_str().parse::<u32>().ok());
        if let Some(s) = s_num {
            if elements.anime_season.is_none() {
                elements.anime_season = Some(s);
            }
        }
    }

    // Check batch indicator
    if !elements.is_batch && RE_BATCH_RANGE.is_match(&cleaned) && elements.episode_number.is_none() {
        elements.is_batch = true;
    }

    // Detect OVA / ONA / Movie type tokens
    for (needle, label) in ANIME_TYPES {
        if cleaned_lower
            .split(|c: char| !c.is_alphanumeric())
            .any(|tok| tok == *needle)
        {
            elements.anime_type = Some(label.to_string());
            break;
        }
    }

    // Clean dots if filename was dot-separated (e.g. "Sousou.no.Frieren.S01E28.1080p")
    if !title_part.contains(' ') && title_part.contains('.') {
        title_part = title_part.replace('.', " ");
    }

    let final_title = title_part
        .trim_matches(|c: char| c == '-' || c == '–' || c == '—' || c.is_whitespace())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    elements.anime_title = if final_title.is_empty() {
        working
    } else {
        final_title
    };
    elements.normalized_title = normalize_anime_title(&elements.anime_title);

    elements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_subsplease_standard() {
        let res = parse_filename("[SubsPlease] Sousou no Frieren - 28 (1080p) [F02B9C1A].mkv");
        assert_eq!(res.release_group.as_deref(), Some("SubsPlease"));
        assert_eq!(res.anime_title, "Sousou no Frieren");
        assert_eq!(res.episode_number, Some(28));
        assert_eq!(res.video_resolution.as_deref(), Some("1080p"));
        assert_eq!(res.file_checksum.as_deref(), Some("F02B9C1A"));
        assert_eq!(res.file_extension.as_deref(), Some("mkv"));
    }

    #[test]
    fn test_erairaws_v2() {
        let res = parse_filename(
            "[Erai-raws] Dandadan - 04v2 [1080p][Multiple Subtitle][ABCD1234].mkv",
        );
        assert_eq!(res.release_group.as_deref(), Some("Erai-raws"));
        assert_eq!(res.anime_title, "Dandadan");
        assert_eq!(res.episode_number, Some(4));
        assert_eq!(res.episode_version, Some(2));
        assert_eq!(res.video_resolution.as_deref(), Some("1080p"));
        assert_eq!(res.subtitles.as_deref(), Some("Multi-Subs"));
    }

    #[test]
    fn test_sxxexx_hevc() {
        let res = parse_filename(
            "[EMBER] Bocchi the Rock! - S01E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
        );
        assert_eq!(res.release_group.as_deref(), Some("EMBER"));
        assert_eq!(res.anime_title, "Bocchi the Rock!");
        assert_eq!(res.anime_season, Some(1));
        assert_eq!(res.episode_number, Some(12));
        assert_eq!(res.video_resolution.as_deref(), Some("1080p"));
        assert!(res.video_term.contains(&"HEVC".to_string()));
        assert!(res.video_term.contains(&"10-bit".to_string()));
        assert!(res.audio_term.contains(&"Dual Audio".to_string()));
    }

    #[test]
    fn test_multi_dash_season() {
        let res = parse_filename(
            "[Judas] Shingeki no Kyojin - Season 4 - 87 [1080p][HEVC x265 10bit].mkv",
        );
        assert_eq!(res.release_group.as_deref(), Some("Judas"));
        assert_eq!(res.anime_title, "Shingeki no Kyojin - Season 4");
        assert_eq!(res.anime_season, Some(4));
        assert_eq!(res.episode_number, Some(87));
    }
}
