//! Normalized release properties (codec, bit depth, audio, source…) from Anitomy terms, with a raw-title
//! fallback for tags Anitomy doesn't classify.

use crate::detection::anitomy::AnitomyElements;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ReleaseTraits {
    /// `hevc` | `avc` | `av1`.
    pub codec: Option<String>,
    pub bit_depth: Option<u32>,
    /// Lowercase audio codecs: `aac`, `flac`, `opus`, `ac3`, `eac3`, `dts`.
    pub audio: Vec<String>,
    pub dual_audio: bool,
    /// `web` | `bd` | `dvd` | `tv`.
    pub source: Option<String>,
    /// Vertical resolution, e.g. 1080.
    pub resolution: Option<u32>,
    pub batch: bool,
    pub episode: Option<u32>,
    /// Last episode of a range (`01-12`), when the release covers several.
    pub episode_end: Option<u32>,
}

static RE_HEVC: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(hevc|x\.?265|h\.?265)\b").unwrap());
static RE_AVC: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(avc|x\.?264|h\.?264)\b").unwrap());
static RE_AV1: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bav1\b").unwrap());
static RE_10BIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(10[- ]?bits?|hi10p?|yuv420p10)\b").unwrap());
static RE_8BIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b8[- ]?bits?\b").unwrap());
static RE_DUAL: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(dual[- ]?audio|multi[- ]?audio)\b").unwrap());
static RE_AUDIO: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(aac(?:2\.0|5\.1)?|flac|opus|e-?ac-?3|ddp(?:2\.0|5\.1)?|ac-?3|dts(?:-hd)?)\b").unwrap()
});
static RE_WEB: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(web[- ]?dl|web[- ]?rip|web)\b").unwrap());
static RE_BD: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(blu[- ]?ray|bd[- ]?rip|bd[- ]?remux|bd|bdmv)\b").unwrap());
static RE_RES: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:\d{3,4}x)?(2160|1440|1080|720|576|540|480)[pi]?\b").unwrap());

fn normalize_audio(tag: &str) -> Option<&'static str> {
    let t = tag.to_ascii_lowercase().replace(['-', '.', ' '], "");
    Some(if t.starts_with("aac") {
        "aac"
    } else if t == "flac" {
        "flac"
    } else if t == "opus" {
        "opus"
    } else if t == "eac3" || t.starts_with("ddp") {
        "eac3"
    } else if t == "ac3" {
        "ac3"
    } else if t.starts_with("dts") {
        "dts"
    } else {
        return None;
    })
}

fn normalize_source(tag: &str) -> Option<&'static str> {
    let t = tag.to_ascii_lowercase().replace(['-', ' '], "");
    Some(if t.starts_with("web") || matches!(t.as_str(), "cr" | "amzn" | "nf" | "dsnp" | "hidive" | "b-global") {
        "web"
    } else if t.starts_with("bd") || t.starts_with("bluray") {
        "bd"
    } else if t.starts_with("dvd") {
        "dvd"
    } else if t.contains("tv") {
        "tv"
    } else {
        return None;
    })
}

pub fn release_traits(title: &str, parsed: &AnitomyElements) -> ReleaseTraits {
    let terms = parsed.video_term.join(" ");
    let haystack = format!("{} {}", terms, title);

    let codec = if RE_AV1.is_match(&haystack) {
        Some("av1")
    } else if RE_HEVC.is_match(&haystack) {
        Some("hevc")
    } else if RE_AVC.is_match(&haystack) {
        Some("avc")
    } else {
        None
    };
    let bit_depth = if RE_10BIT.is_match(&haystack) {
        Some(10)
    } else if RE_8BIT.is_match(&haystack) {
        Some(8)
    } else {
        None
    };

    let mut audio: Vec<String> = Vec::new();
    let mut push_audio = |a: &str| {
        if !audio.iter().any(|x| x == a) {
            audio.push(a.to_string());
        }
    };
    for tag in &parsed.audio_term {
        if let Some(a) = normalize_audio(tag) {
            push_audio(a);
        }
    }
    for m in RE_AUDIO.find_iter(title) {
        if let Some(a) = normalize_audio(m.as_str()) {
            push_audio(a);
        }
    }
    let dual_audio = RE_DUAL.is_match(title)
        || parsed
            .audio_term
            .iter()
            .any(|t| RE_DUAL.is_match(t));

    let source = parsed
        .source
        .as_deref()
        .and_then(normalize_source)
        .or_else(|| {
            if RE_BD.is_match(title) {
                Some("bd")
            } else if RE_WEB.is_match(title) {
                Some("web")
            } else {
                None
            }
        });

    let resolution = parsed
        .video_resolution
        .as_deref()
        .and_then(super::query::parse_resolution)
        .or_else(|| {
            RE_RES
                .captures(title)
                .and_then(|c| c.get(1))
                .and_then(|m| m.as_str().parse().ok())
        });

    let episode_end = parsed
        .episode_number_alt
        .filter(|end| parsed.episode_number.is_some_and(|start| *end > start));

    ReleaseTraits {
        codec: codec.map(String::from),
        bit_depth,
        audio,
        dual_audio,
        source: source.map(String::from),
        resolution,
        batch: parsed.is_batch || episode_end.is_some(),
        episode: parsed.episode_number,
        episode_end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detection::anitomy::parse_filename;

    fn traits(title: &str) -> ReleaseTraits {
        release_traits(title, &parse_filename(title))
    }

    #[test]
    fn extracts_common_tags() {
        let t = traits("[Judas] Kusuriya no Hitorigoto S3 - 03 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]");
        assert_eq!(t.codec.as_deref(), Some("hevc"));
        assert_eq!(t.bit_depth, Some(10));
        assert!(t.dual_audio);
        assert_eq!(t.resolution, Some(1080));
        assert_eq!(t.episode, Some(3));
        assert!(!t.batch);

        let t = traits("[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv");
        assert_eq!(t.resolution, Some(1080));
        assert_eq!(t.codec, None);

        let t = traits("[Erai-raws] Dandadan - 07 [1080p CR WEB-DL AVC AAC][MultiSub][1A2B3C4D]");
        assert_eq!(t.codec.as_deref(), Some("avc"));
        assert_eq!(t.source.as_deref(), Some("web"));
        assert_eq!(t.audio, vec!["aac"]);

        let t = traits("[ToonsHub] Dandadan S02E03 1080p AMZN WEB-DL DDP2.0 H.264");
        assert_eq!(t.audio, vec!["eac3"]);
        assert_eq!(t.codec.as_deref(), Some("avc"));

        let t = traits("[Group] Show - 01 [BD 1080p AV1 Opus]");
        assert_eq!(t.codec.as_deref(), Some("av1"));
        assert_eq!(t.source.as_deref(), Some("bd"));
        assert!(t.audio.contains(&"opus".to_string()));
    }

    #[test]
    fn ranges_are_batches() {
        let t = traits("[ASW] Kusuriya no Hitorigoto - 01-24 [1080p HEVC][Batch]");
        assert!(t.batch);
        assert_eq!(t.episode, Some(1));
        assert_eq!(t.episode_end, Some(24));
    }
}
