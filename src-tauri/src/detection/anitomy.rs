use crate::detection::relations::{infer_season_from_title_suffix, relations_db};
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_int, c_void};

/// Parsed anime filename metadata populated directly from the C++ `anitomy` library (`erengy/anitomy`)
/// and enriched with Taiga's `ExtendAnimeTitle` and `erengy/anime-relations` redirections.
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

/// Matches `anitomy::ElementKind` from `vendor/anitomy/include/anitomy/element.hpp`.
#[repr(i32)]
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum RawElementKind {
    AudioTerm = 0,
    Device = 1,
    Episode = 2,
    EpisodeTitle = 3,
    FileChecksum = 4,
    FileExtension = 5,
    Language = 6,
    Other = 7,
    Part = 8,
    ReleaseGroup = 9,
    ReleaseInformation = 10,
    ReleaseVersion = 11,
    Season = 12,
    Source = 13,
    Subtitles = 14,
    Title = 15,
    Type = 16,
    VideoResolution = 17,
    VideoTerm = 18,
    Volume = 19,
    Year = 20,
}

impl RawElementKind {
    fn from_c_int(value: c_int) -> Option<Self> {
        match value {
            0 => Some(Self::AudioTerm),
            1 => Some(Self::Device),
            2 => Some(Self::Episode),
            3 => Some(Self::EpisodeTitle),
            4 => Some(Self::FileChecksum),
            5 => Some(Self::FileExtension),
            6 => Some(Self::Language),
            7 => Some(Self::Other),
            8 => Some(Self::Part),
            9 => Some(Self::ReleaseGroup),
            10 => Some(Self::ReleaseInformation),
            11 => Some(Self::ReleaseVersion),
            12 => Some(Self::Season),
            13 => Some(Self::Source),
            14 => Some(Self::Subtitles),
            15 => Some(Self::Title),
            16 => Some(Self::Type),
            17 => Some(Self::VideoResolution),
            18 => Some(Self::VideoTerm),
            19 => Some(Self::Volume),
            20 => Some(Self::Year),
            _ => None,
        }
    }
}

extern "C" {
    fn tora_anitomy_parse(
        input_ptr: *const c_char,
        input_len: usize,
        user_data: *mut c_void,
        callback: extern "C" fn(*mut c_void, c_int, *const c_char, usize, usize),
    );
}

#[derive(Default)]
struct RawAnitomyParseState {
    elements: AnitomyElements,
    anime_part: Option<u32>,
    anime_year: Option<u32>,
}

fn parse_u32_prefix(s: &str) -> Option<u32> {
    let trimmed = s.trim();
    if let Ok(n) = trimmed.parse::<u32>() {
        return Some(n);
    }
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        digits.parse::<u32>().ok()
    } else {
        None
    }
}

extern "C" fn on_anitomy_element(
    user_data: *mut c_void,
    kind: c_int,
    value_ptr: *const c_char,
    value_len: usize,
    _position: usize,
) {
    if user_data.is_null() || value_ptr.is_null() || value_len == 0 {
        return;
    }

    let state = unsafe { &mut *(user_data as *mut RawAnitomyParseState) };
    let elements = &mut state.elements;
    let bytes = unsafe { std::slice::from_raw_parts(value_ptr as *const u8, value_len) };
    let value = String::from_utf8_lossy(bytes);
    let val = value.trim();
    if val.is_empty() {
        return;
    }

    let Some(element_kind) = RawElementKind::from_c_int(kind) else {
        return;
    };

    match element_kind {
        RawElementKind::AudioTerm => {
            if !elements
                .audio_term
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(val))
            {
                elements.audio_term.push(val.to_string());
            }
        }
        RawElementKind::Episode => {
            if let Some(ep) = parse_u32_prefix(val) {
                if elements.episode_number.is_none() {
                    elements.episode_number = Some(ep);
                } else {
                    elements.episode_number_alt = Some(ep);
                    elements.is_batch = true;
                }
            }
        }
        RawElementKind::EpisodeTitle => {
            elements.episode_title = Some(val.to_string());
        }
        RawElementKind::FileChecksum => {
            elements.file_checksum = Some(val.to_string());
        }
        RawElementKind::FileExtension => {
            elements.file_extension = Some(val.to_lowercase());
        }
        RawElementKind::Part => {
            if let Some(part) = parse_u32_prefix(val) {
                state.anime_part = Some(part);
            }
        }
        RawElementKind::ReleaseGroup => {
            elements.release_group = Some(val.to_string());
        }
        RawElementKind::ReleaseInformation => {
            let lower = val.to_ascii_lowercase();
            if lower.contains("batch") || lower.contains("complete") {
                elements.is_batch = true;
            }
        }
        RawElementKind::ReleaseVersion => {
            if let Some(v) = parse_u32_prefix(val) {
                elements.episode_version = Some(v);
            }
        }
        RawElementKind::Season => {
            if let Some(s) = parse_u32_prefix(val) {
                elements.anime_season = Some(s);
            }
        }
        RawElementKind::Source => {
            elements.source = Some(val.to_string());
        }
        RawElementKind::Subtitles => {
            elements.subtitles = Some(val.to_string());
        }
        RawElementKind::Title => {
            elements.anime_title = val.to_string();
        }
        RawElementKind::Type => {
            elements.anime_type = Some(val.to_string());
        }
        RawElementKind::VideoResolution => {
            elements.video_resolution = Some(val.to_string());
        }
        RawElementKind::VideoTerm => {
            if !elements
                .video_term
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(val))
            {
                elements.video_term.push(val.to_string());
            }
        }
        RawElementKind::Volume => {
            if let Some(vol) = parse_u32_prefix(val) {
                elements.volume_number = Some(vol);
            }
        }
        RawElementKind::Year => {
            if let Some(yr) = parse_u32_prefix(val) {
                state.anime_year = Some(yr);
            }
        }
        RawElementKind::Language => {
            if elements.subtitles.is_none() {
                elements.subtitles = Some(val.to_string());
            }
        }
        RawElementKind::Device | RawElementKind::Other => {}
    }
}

/// Normalize an anime title using Taiga's `recognition_normalize.cpp` rules:
/// - Roman numerals (`II` -> `2`, `III` -> `3`, ..., `XIII` -> `13`)
/// - Character transliteration (`@` -> `a`, `×` -> `x`, `ō` -> `ou`, `ū` -> `uu`, `&` -> `and`)
/// - Ordinal & season normalization (`2nd season` / `season 2` / `s2` / `s02` -> `2`, `1st season` / `season 1` / `s1` -> removed)
/// - Common noise word removal (`the animation`, `the`, `(tv)`, `episode`, `special` -> `sp`, `oad`/`oav` -> `ova`)
pub fn normalize_anime_title(title: &str) -> String {
    let mut pre = String::with_capacity(title.len() + 8);
    for ch in title.chars() {
        match ch {
            '@' => pre.push('a'),
            '×' => pre.push('x'),
            '꞉' => pre.push(':'),
            'Ō' | 'ō' => pre.push_str("ou"),
            'Ū' | 'ū' => pre.push_str("uu"),
            '&' => pre.push_str(" and "),
            _ if ch.is_alphanumeric() => {
                for l in ch.to_lowercase() {
                    pre.push(l);
                }
            }
            _ => pre.push(' '),
        }
    }

    // Split into raw case-preserved and lowercased word pairs so we only convert uppercase Roman numerals
    let orig_words: Vec<&str> = title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    let lower_words: Vec<&str> = pre.split_whitespace().collect();

    let mut tokens: Vec<String> = Vec::with_capacity(lower_words.len());
    for (idx, &w) in lower_words.iter().enumerate() {
        // Check if original word at similar position was uppercase Roman numeral (like Taiga's `normalizeRomanNumbers`)
        let is_upper_roman = orig_words
            .get(idx)
            .map(|orig| orig.chars().all(|c| matches!(c, 'I' | 'V' | 'X')))
            .unwrap_or(false);

        let mapped = if is_upper_roman {
            match w {
                "ii" => "2",
                "iii" => "3",
                "iv" => "4",
                "v" => "5",
                "vi" => "6",
                "vii" => "7",
                "viii" => "8",
                "ix" => "9",
                "xi" => "11",
                "xii" => "12",
                "xiii" => "13",
                _ => w,
            }
        } else {
            match w {
                "first" => "1st",
                "second" => "2nd",
                "third" => "3rd",
                "fourth" => "4th",
                "fifth" => "5th",
                "sixth" => "6th",
                "seventh" => "7th",
                "eighth" => "8th",
                "ninth" => "9th",
                "oad" | "oav" => "ova",
                "special" | "specials" => "sp",
                _ => w,
            }
        };
        tokens.push(mapped.to_string());
    }

    // Multi-word and single-word season/noise normalization (ported from `normalizeSeasonNumbers`)
    let mut out_tokens: Vec<String> = Vec::with_capacity(tokens.len());
    let mut i = 0;
    while i < tokens.len() {
        let cur = tokens[i].as_str();
        let next = tokens.get(i + 1).map(|s| s.as_str());

        // "the animation" -> skip both
        if cur == "the" && next == Some("animation") {
            i += 2;
            continue;
        }

        // Ordinal + "season": "1st season" -> skip, "2nd season" -> "2", etc.
        if next == Some("season") {
            match cur {
                "1st" => {
                    i += 2;
                    continue;
                }
                "2nd" => {
                    out_tokens.push("2".to_string());
                    i += 2;
                    continue;
                }
                "3rd" => {
                    out_tokens.push("3".to_string());
                    i += 2;
                    continue;
                }
                "4th" => {
                    out_tokens.push("4".to_string());
                    i += 2;
                    continue;
                }
                "5th" => {
                    out_tokens.push("5".to_string());
                    i += 2;
                    continue;
                }
                "6th" => {
                    out_tokens.push("6".to_string());
                    i += 2;
                    continue;
                }
                "7th" => {
                    out_tokens.push("7".to_string());
                    i += 2;
                    continue;
                }
                "8th" => {
                    out_tokens.push("8".to_string());
                    i += 2;
                    continue;
                }
                "9th" => {
                    out_tokens.push("9".to_string());
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }

        // "season N" / "series N"
        if cur == "season" || cur == "series" {
            if let Some(n_str) = next {
                if let Ok(n) = n_str.parse::<u32>() {
                    if n == 1 {
                        i += 2;
                        continue;
                    } else if (2..=20).contains(&n) {
                        out_tokens.push(n.to_string());
                        i += 2;
                        continue;
                    }
                }
            }
        }

        // Single-token season shorthands: "s1"/"s01" -> skip, "s2"/"s02" -> "2", etc.
        if let Some(digits) = cur.strip_prefix('s') {
            if !digits.is_empty() && digits.len() <= 2 && digits.chars().all(|c| c.is_ascii_digit())
            {
                if let Ok(n) = digits.parse::<u32>() {
                    if n == 1 {
                        i += 1;
                        continue;
                    } else if (2..=20).contains(&n) {
                        out_tokens.push(n.to_string());
                        i += 1;
                        continue;
                    }
                }
            }
        }

        // Skip noise words
        if matches!(cur, "the" | "episode" | "tv") {
            i += 1;
            continue;
        }

        out_tokens.push(cur.to_string());
        i += 1;
    }

    out_tokens.join(" ")
}

/// Extract the effective season number from a raw or normalized anime title (defaults to 1).
pub fn extract_effective_season(title: &str) -> u32 {
    if let Some(s) = infer_season_from_title_suffix(title) {
        return s;
    }
    let norm = normalize_anime_title(title);
    if let Some(last) = norm.split_whitespace().last() {
        if let Ok(n) = last.parse::<u32>() {
            if (2..=15).contains(&n) {
                return n;
            }
        }
    }
    1
}

fn parse_raw_with_cpp_anitomy(input: &str) -> RawAnitomyParseState {
    let mut state = RawAnitomyParseState::default();
    if input.is_empty() {
        return state;
    }
    unsafe {
        tora_anitomy_parse(
            input.as_ptr() as *const c_char,
            input.len(),
            &mut state as *mut RawAnitomyParseState as *mut c_void,
            on_anitomy_element,
        );
    }
    state
}

fn is_invalid_parent_dir(name: &str) -> bool {
    if name.is_empty() || name.contains(':') {
        return true;
    }
    matches!(
        name.to_ascii_lowercase().as_str(),
        "anime" | "download" | "downloads" | "extra" | "extras" | "subs" | "subtitles"
    )
}

/// Parse an anime filename, window title, or full path into structured Anitomy elements:
/// 1. Direct C++ `erengy/anitomy` tokenization & parsing
/// 2. Parent directory season/title fallback (ported from Taiga's `recognition_path.cpp`)
/// 3. `ExtendAnimeTitle` season/part composition (ported from Taiga's `recognition.cpp`)
/// 4. `erengy/anime-relations` sequential episode redirection (ported from Taiga's `recognition_relations.cpp`)
pub fn parse_filename(input: &str) -> AnitomyElements {
    let segments: Vec<&str> = input
        .split(['\\', '/'])
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    let base_name = segments.last().copied().unwrap_or(input.trim());
    if base_name.is_empty() {
        return AnitomyElements {
            file_name: input.to_string(),
            ..Default::default()
        };
    }

    let mut state = parse_raw_with_cpp_anitomy(base_name);
    state.elements.file_name = input.to_string();

    // Parent directory fallback (up to 2 levels up, matching Taiga's `parseParentDirectories`)
    if segments.len() > 1
        && (state.elements.anime_title.is_empty() || state.elements.anime_season.is_none())
    {
        for &parent_dir in segments[..segments.len() - 1].iter().rev().take(2) {
            if is_invalid_parent_dir(parent_dir) {
                continue;
            }
            let dir_state = parse_raw_with_cpp_anitomy(parent_dir);
            if state.elements.anime_season.is_none() {
                if let Some(s) = dir_state
                    .elements
                    .anime_season
                    .or_else(|| infer_season_from_title_suffix(parent_dir))
                {
                    state.elements.anime_season = Some(s);
                }
            }
            if state.elements.anime_title.is_empty() && !dir_state.elements.anime_title.is_empty() {
                state.elements.anime_title = dir_state.elements.anime_title;
            }
        }
    }

    if state.elements.anime_title.is_empty() {
        state.elements.anime_title = base_name.to_string();
    }

    let base_title = state.elements.anime_title.clone();
    let base_norm_title = normalize_anime_title(&base_title);

    // If `anime_season` wasn't tagged as a separate element by Anitomy (e.g. Roman numeral `II` in title),
    // infer it from the title so `elements.anime_season` is populated.
    if state.elements.anime_season.is_none() {
        if let Some(inferred_s) = infer_season_from_title_suffix(&base_title) {
            if inferred_s > 1 {
                state.elements.anime_season = Some(inferred_s);
            }
        }
    }

    // Port of Taiga's `Engine::ExtendAnimeTitle` + canonical season title resolution from `anime-relations`:
    // Anitomy v2 strips `S02`, `Season 2`, `2nd Season`, and `Part 2` out of `ElementKind::Title`.
    let target_season = state.elements.anime_season.unwrap_or(1);
    if let Some((canonical_title, _)) =
        relations_db().resolve_canonical_season_title(&base_norm_title, target_season)
    {
        state.elements.anime_title = canonical_title;
    } else if let Some(s) = state.elements.anime_season {
        if s > 1 && infer_season_from_title_suffix(&state.elements.anime_title).is_none() {
            state.elements.anime_title = format!("{} Season {}", state.elements.anime_title, s);
        }
    }

    if let Some(part) = state.anime_part {
        if part > 1
            && !state
                .elements
                .anime_title
                .to_ascii_lowercase()
                .contains("part ")
        {
            state.elements.anime_title = format!("{} Part {}", state.elements.anime_title, part);
        }
    }

    state.elements.normalized_title = normalize_anime_title(&state.elements.anime_title);

    // Check `erengy/anime-relations` for sequential episode redirections
    // (e.g., `Kusuriya no Hitorigoto - 51` -> `Kusuriya no Hitorigoto 3rd Season`, Season 3, Episode 3)
    if let Some(ep) = state.elements.episode_number {
        if let Some(redirection) = relations_db().find_by_title(
            &state.elements.normalized_title,
            &base_norm_title,
            ep,
            state.elements.episode_number_alt,
        ) {
            state.elements.episode_number = Some(redirection.dst_episode);
            if let Some(alt_ep) = redirection.dst_episode_alt {
                state.elements.episode_number_alt = Some(alt_ep);
            }
            if !redirection.dst_title.is_empty() {
                state.elements.anime_title = redirection.dst_title;
                state.elements.normalized_title = redirection.dst_norm_title;
            }
            if let Some(dst_season) = redirection.dst_season {
                state.elements.anime_season = Some(dst_season);
            }
        }
    }

    state.elements
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
        assert_eq!(res.subtitles.as_deref(), Some("Multiple Subtitle"));
    }

    #[test]
    fn test_sxxexx_hevc_season_1_and_season_2() {
        let s1 = parse_filename(
            "[EMBER] Bocchi the Rock! - S01E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
        );
        assert_eq!(s1.release_group.as_deref(), Some("EMBER"));
        assert_eq!(s1.anime_title, "Bocchi the Rock!");
        assert_eq!(s1.anime_season, Some(1));
        assert_eq!(s1.episode_number, Some(12));
        assert_eq!(s1.normalized_title, "bocchi rock");

        let s2 = parse_filename(
            "[EMBER] Bocchi the Rock! - S02E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
        );
        assert_eq!(s2.release_group.as_deref(), Some("EMBER"));
        assert_eq!(s2.anime_title, "Bocchi the Rock! Season 2");
        assert_eq!(s2.anime_season, Some(2));
        assert_eq!(s2.episode_number, Some(12));
        assert_eq!(s2.normalized_title, "bocchi rock 2");
        assert_ne!(s1.normalized_title, s2.normalized_title);
    }

    #[test]
    fn test_kusuriya_no_hitorigoto_sequential_redirection() {
        // Season 1 (ep 1..24) stays Season 1
        let ep12 = parse_filename("[SubsPlease] Kusuriya no Hitorigoto - 12 (1080p).mkv");
        assert_eq!(ep12.anime_title, "Kusuriya no Hitorigoto");
        assert_eq!(ep12.episode_number, Some(12));

        // Season 2 (ep 25..48 -> S2 ep 1..24)
        let ep27 = parse_filename("[SubsPlease] Kusuriya no Hitorigoto - 27 (1080p).mkv");
        assert_eq!(ep27.anime_title, "Kusuriya no Hitorigoto 2nd Season");
        assert_eq!(ep27.anime_season, Some(2));
        assert_eq!(ep27.episode_number, Some(3));

        // Season 3 (ep 49..60 -> S3 ep 1..12): ep 51 is ep 3 of season 3!
        let ep51 = parse_filename("[SubsPlease] Kusuriya no Hitorigoto - 51 (1080p).mkv");
        assert_eq!(ep51.anime_title, "Kusuriya no Hitorigoto 3rd Season");
        assert_eq!(ep51.anime_season, Some(3));
        assert_eq!(ep51.episode_number, Some(3));
        assert_eq!(ep51.normalized_title, "kusuriya no hitorigoto 3");

        // Abbreviated title with explicit season: [Judas] Kusuriya - S03E03.mkv
        let judas_s3 = parse_filename("[Judas] Kusuriya - S03E03.mkv");
        assert_eq!(judas_s3.release_group.as_deref(), Some("Judas"));
        assert_eq!(judas_s3.anime_title, "Kusuriya no Hitorigoto 3rd Season");
        assert_eq!(judas_s3.anime_season, Some(3));
        assert_eq!(judas_s3.episode_number, Some(3));
        assert_eq!(judas_s3.normalized_title, "kusuriya no hitorigoto 3");
    }

    #[test]
    fn test_multi_dash_season_and_relations_redirection() {
        // Shingeki no Kyojin Season 4 Ep 87 is continuous numbering (76-87 -> Final Season Part 2 Ep 1-12)
        let res = parse_filename(
            "[Judas] Shingeki no Kyojin - Season 4 - 87 [1080p][HEVC x265 10bit].mkv",
        );
        assert_eq!(res.release_group.as_deref(), Some("Judas"));
        assert_eq!(res.anime_season, Some(4));
        assert_eq!(res.episode_number, Some(12));
    }
}
