use crate::detection::relations::infer_season_from_title_suffix;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_int, c_void};

/// Parsed anime filename metadata populated directly from the C++ `anitomy` library (`erengy/anitomy`)
/// and extended like Taiga's `ExtendAnimeTitle`. It only says what the name says: which list entry and
/// which of its episodes that is (relations, folders) is decided by `AnimeMatcherIndex`.
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
    /// Year in the name ("Kanon (2006)"), tried as part of the title by the matcher.
    #[serde(skip)]
    pub anime_year: Option<u32>,
    /// Normalized title of the nearest parent folder that names an anime, tried by the matcher when the
    /// file's own title matches nothing (Taiga's `GetTitleFromPath`).
    #[serde(skip)]
    pub parent_title: Option<String>,
    /// Normalized title without the season, set when the season only came from a parent folder
    /// ("Season 2\\Non Non Biyori Repeat - 01"): the name may already be the sequel's own title.
    #[serde(skip)]
    pub own_title: Option<String>,
    /// A number at the very start of the name that Anitomy did not read as the episode
    /// ("25 Spice Girl.mkv"). Only used when the anime is known from its folder.
    #[serde(skip)]
    pub leading_number: Option<u32>,
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
        flags: u32,
        user_data: *mut c_void,
        callback: extern "C" fn(*mut c_void, c_int, *const c_char, usize, usize),
    );
}

/// Anitomy options for a directory name, as Taiga parses parent folders: no episode number, episode
/// title or file extension.
const PARSE_DIRECTORY: u32 = 1 | 2 | 4;

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
                if elements.anime_season.is_none() {
                    elements.anime_season = Some(s);
                }
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
            // Colon look-alikes used where Windows forbids ':' ("ReːZero")
            '꞉' | 'ː' | '：' => pre.push(' '),
            'Ō' | 'ō' => pre.push_str("ou"),
            // Accents are often dropped in file names ("Traumend" for "Träumend")
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => pre.push('a'),
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => pre.push('e'),
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => pre.push('i'),
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' | 'Ø' => pre.push('o'),
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => pre.push('u'),
            'ñ' | 'Ñ' => pre.push('n'),
            'ç' | 'Ç' => pre.push('c'),
            'ý' | 'ÿ' | 'Ý' => pre.push('y'),
            'ß' => pre.push_str("ss"),
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
        .split(|c: char| !c.is_alphanumeric() || matches!(c, '꞉' | 'ː' | '：'))
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

fn parse_raw_with_cpp_anitomy(input: &str, flags: u32) -> RawAnitomyParseState {
    let mut state = RawAnitomyParseState::default();
    if input.is_empty() {
        return state;
    }
    unsafe {
        tora_anitomy_parse(
            input.as_ptr() as *const c_char,
            input.len(),
            flags,
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

/// A title that names no anime: empty, only digits, or a bare episode / type word ("01.mkv", "Special.mkv").
fn is_weak_title(normalized: &str) -> bool {
    normalized.is_empty()
        || normalized.chars().all(|c| c.is_ascii_digit())
        || matches!(normalized, "episode" | "ep" | "ova" | "special" | "sp")
}

/// Types that mark an extra (opening, ending, preview...): the file belongs to its anime but is no episode.
fn is_extra_type(anime_type: Option<&str>) -> bool {
    anime_type.map_or(false, |t| {
        matches!(
            t.to_ascii_lowercase().as_str(),
            "op" | "opening" | "ncop" | "ed" | "ending" | "nced" | "preview" | "pv" | "cm" | "menu" | "trailer"
        )
    })
}

/// "Black Lagoon 13 - Llegan los vampiros": title, episode number, episode title. Anitomy 2 leaves a number
/// between two words in the title; the released Anitomy (Taiga) reads it as the episode.
static NUMBER_BEFORE_DASH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(.*?\p{L}.*?)\s+(\d{1,3})\s+[-\x{2013}]\s+(\S.*)$").expect("regex"));

/// A number that starts the file name: "25 Spice Girl", "14 Justice - Parte 1", "06_title".
static LEADING_NUMBER: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d{1,3})[\s._-]+\S").expect("regex"));

/// A CRC32 checksum in brackets: "[ED204890]".
static BRACKETED_CHECKSUM: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\[(]([0-9A-Fa-f]{8})[\])]").expect("regex"));

/// The bracket that starts a name ("[Y-467] Title ..."), usually the release group.
static LEADING_BRACKET: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\[([^\[\]]+)\]").expect("regex"));

static DIGITS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\d+").expect("regex"));

/// Anitomy 2 reads a checksum that starts with a type keyword as that type: "[ED204890]" becomes the
/// type "ED" (an ending) and no checksum. Gives the checksum back and drops the type.
fn fix_type_read_from_checksum(base_name: &str, elements: &mut AnitomyElements) {
    if elements.file_checksum.is_some() {
        return;
    }
    let Some(kind) = elements.anime_type.as_deref().map(str::to_ascii_uppercase) else { return };
    let checksum = BRACKETED_CHECKSUM
        .captures_iter(base_name)
        .map(|caps| caps[1].to_string())
        .find(|crc| crc.to_ascii_uppercase().starts_with(&kind));
    if let Some(crc) = checksum {
        elements.file_checksum = Some(crc);
        elements.anime_type = None;
    }
}

/// Anitomy 2 takes the number of a release group it does not know for the episode: "[Y-467] Josee to
/// Tora to Sakanatachi 804p BD" is no episode 467. When the only place the number appears is the
/// leading bracket, that bracket is the release group and the name has no episode.
fn fix_episode_read_from_release_group(base_name: &str, elements: &mut AnitomyElements) {
    if elements.release_group.is_some() {
        return;
    }
    let Some(episode) = elements.episode_number else { return };
    let Some(caps) = LEADING_BRACKET.captures(base_name) else { return };
    let group = caps[1].trim();
    if !group.chars().any(|c| c.is_alphabetic()) {
        return; // "[01] Title": a number in brackets can be the episode
    }
    let is_episode = |m: regex::Match| m.as_str().parse::<u32>().ok() == Some(episode);
    let in_group = DIGITS.find_iter(group).last().map_or(false, is_episode);
    let elsewhere = DIGITS.find_iter(&base_name[caps.get(0).map_or(0, |m| m.end())..]).any(is_episode);
    if in_group && !elsewhere {
        elements.release_group = Some(group.to_string());
        elements.episode_number = None;
        elements.episode_number_alt = None;
        elements.is_batch = false;
    }
}

/// "06 - Initial D Fourth Stage", "2 - Zero no Tsukaima F": a number that only orders the folders of a
/// franchise.
static ORDER_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{1,3}\s*[-.]\s+(\p{L}.*)$").expect("regex"));

/// Title of a directory from its Anitomy title, without an ordering number in front.
fn directory_anime_title(parsed_title: &str) -> String {
    match ORDER_PREFIX.captures(parsed_title) {
        Some(caps) => caps[1].to_string(),
        None => parsed_title.to_string(),
    }
}

/// Port of Taiga's `Engine::ExtendAnimeTitle`: Anitomy strips `S02`, `Season 2`, `2nd Season` and `Part 2`
/// out of the title, so they are appended again ("Title Season 2 Part 2").
fn extend_title(title: &str, season: Option<u32>, part: Option<u32>) -> String {
    let mut out = title.to_string();
    if let Some(s) = season {
        if s > 1 && infer_season_from_title_suffix(title).is_none() {
            out = format!("{} Season {}", out, s);
        }
    }
    if let Some(p) = part {
        if p > 1 && !out.to_ascii_lowercase().contains("part ") {
            out = format!("{} Part {}", out, p);
        }
    }
    out
}

/// Normalized anime title of a directory name ("[Judas] 06 - Initial D Fourth Stage").
pub fn directory_title(name: &str) -> String {
    let state = parse_raw_with_cpp_anitomy(name, PARSE_DIRECTORY);
    let title = if state.elements.anime_title.is_empty() {
        name.to_string()
    } else {
        directory_anime_title(&state.elements.anime_title)
    };
    let season = state
        .elements
        .anime_season
        .or_else(|| infer_season_from_title_suffix(name));
    normalize_anime_title(&extend_title(&title, season, None))
}

/// Parse an anime filename, window title, or full path into structured Anitomy elements:
/// 1. Direct C++ `erengy/anitomy` tokenization & parsing
/// 2. Fallbacks for names Anitomy 2 does not split ("Title 13 - Episode title", a leading number)
/// 3. Parent directory season / title (ported from Taiga's `GetTitleFromPath`)
/// 4. `ExtendAnimeTitle` season / part composition (ported from Taiga's `recognition.cpp`)
///
/// The result depends only on `input`. Relations and the user's list are applied by the matcher.
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

    let mut state = parse_raw_with_cpp_anitomy(base_name, 0);
    state.elements.file_name = input.to_string();
    state.elements.anime_year = state.anime_year;
    fix_type_read_from_checksum(base_name, &mut state.elements);
    fix_episode_read_from_release_group(base_name, &mut state.elements);

    if is_extra_type(state.elements.anime_type.as_deref()) {
        // "NCOP 2", "ED 01": the number counts openings, not episodes
        state.elements.episode_number = None;
        state.elements.episode_number_alt = None;
        state.elements.is_batch = false;
    } else if state.elements.episode_number.is_none() && state.elements.volume_number.is_none() {
        let split = NUMBER_BEFORE_DASH.captures(&state.elements.anime_title).and_then(|caps| {
            let episode = caps[2].parse::<u32>().ok()?;
            Some((caps[1].trim().to_string(), episode, caps[3].trim().to_string()))
        });
        if let Some((title, episode, episode_title)) = split {
            state.elements.anime_title = title;
            state.elements.episode_number = Some(episode);
            state.elements.episode_title = Some(episode_title);
        } else {
            state.elements.leading_number = LEADING_NUMBER
                .captures(base_name)
                .and_then(|caps| caps[1].parse::<u32>().ok());
        }
    }

    // Parent directories (the two nearest, like Taiga): a season-only folder ("Season 2") gives the season,
    // the first one with a title names the anime.
    let mut parent_title: Option<(String, Option<u32>)> = None;
    let mut parent_season: Option<u32> = None;
    if segments.len() > 1 {
        for &parent_dir in segments[..segments.len() - 1].iter().rev().take(2) {
            if is_invalid_parent_dir(parent_dir) {
                break;
            }
            let dir_state = parse_raw_with_cpp_anitomy(parent_dir, PARSE_DIRECTORY);
            let season = dir_state
                .elements
                .anime_season
                .or_else(|| infer_season_from_title_suffix(parent_dir));
            if parent_season.is_none() {
                parent_season = season;
            }
            if !dir_state.elements.anime_title.is_empty() {
                parent_title = Some((directory_anime_title(&dir_state.elements.anime_title), dir_state.anime_year));
                break;
            }
        }
    }
    let season_from_folder = state.elements.anime_season.is_none() && parent_season.map_or(false, |s| s > 1);
    if state.elements.anime_season.is_none() {
        state.elements.anime_season = parent_season;
    }

    // "01.mkv", "Special.mkv": the folder names the anime
    if is_weak_title(&normalize_anime_title(&state.elements.anime_title)) {
        if let Some((title, year)) = &parent_title {
            state.elements.anime_title = title.clone();
            if state.elements.anime_year.is_none() {
                state.elements.anime_year = *year;
            }
        }
    }
    if state.elements.anime_title.is_empty() {
        state.elements.anime_title = base_name.to_string();
    }

    // If `anime_season` wasn't tagged as a separate element by Anitomy (e.g. Roman numeral `II` in title),
    // infer it from the title so `elements.anime_season` is populated.
    if state.elements.anime_season.is_none() {
        if let Some(inferred_s) = infer_season_from_title_suffix(&state.elements.anime_title) {
            if inferred_s > 1 {
                state.elements.anime_season = Some(inferred_s);
            }
        }
    }

    let season = state.elements.anime_season;
    if season_from_folder {
        let own = normalize_anime_title(&extend_title(&state.elements.anime_title, None, state.anime_part));
        state.elements.own_title = Some(own).filter(|norm| !is_weak_title(norm));
    }
    state.elements.parent_title = parent_title
        .map(|(title, _)| normalize_anime_title(&extend_title(&title, season, None)))
        .filter(|norm| !is_weak_title(norm));
    state.elements.anime_title = extend_title(&state.elements.anime_title, season, state.anime_part);
    state.elements.normalized_title = normalize_anime_title(&state.elements.anime_title);

    state.elements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anitomy_misreads_that_are_undone() {
        // A checksum that starts with "ED" is no ending
        let ed = parse_filename("[AD]Clannad ~AFTER STORY~ - 10 (BD 1080p) [ED204890].mkv");
        assert_eq!(ed.episode_number, Some(10));
        assert_eq!(ed.anime_type, None);
        assert_eq!(ed.file_checksum.as_deref(), Some("ED204890"));
        // A real ending still has no episode
        let nced = parse_filename("[Group] Clannad - NCED [ABCD1234].mkv");
        assert_eq!(nced.episode_number, None);

        // The number of an unknown release group is no episode
        let movie = parse_filename("[Y-467] Josee to Tora to Sakanatachi 804p BD x265 [E819B791].mkv");
        assert_eq!(movie.release_group.as_deref(), Some("Y-467"));
        assert_eq!(movie.episode_number, None);
        assert_eq!(movie.normalized_title, "josee to tora to sakanatachi");
        // ...unless the number is in the name too, or the bracket is only a number
        let kept = parse_filename("[Y-467] Some Show - 467 [E819B791].mkv");
        assert_eq!(kept.episode_number, Some(467));
        let numbered = parse_filename("[01] Black Lagoon.mkv");
        assert_ne!(numbered.release_group.as_deref(), Some("01"));
    }

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
    fn parsing_says_what_the_name_says() {
        // Continuous numbering and seasons are left for the matcher (relations are applied by ID there)
        let ep27 = parse_filename("[SubsPlease] Kusuriya no Hitorigoto - 27 (1080p).mkv");
        assert_eq!(ep27.anime_title, "Kusuriya no Hitorigoto");
        assert_eq!(ep27.anime_season, None);
        assert_eq!(ep27.episode_number, Some(27));

        let judas_s3 = parse_filename("[Judas] Kusuriya - S03E03.mkv");
        assert_eq!(judas_s3.release_group.as_deref(), Some("Judas"));
        assert_eq!(judas_s3.anime_title, "Kusuriya Season 3");
        assert_eq!(judas_s3.anime_season, Some(3));
        assert_eq!(judas_s3.episode_number, Some(3));
        assert_eq!(judas_s3.normalized_title, "kusuriya 3");

        let aot = parse_filename("[Judas] Shingeki no Kyojin - Season 4 - 87 [1080p][HEVC x265 10bit].mkv");
        assert_eq!(aot.release_group.as_deref(), Some("Judas"));
        assert_eq!(aot.anime_season, Some(4));
        assert_eq!(aot.episode_number, Some(87));

        // The last episode of a season is not a rule's source range
        let ubw = parse_filename("[XMX] Fate Stay Night - Unlimited Blade Works - S02E13 Epilogue [7c1243ad].mkv");
        assert_eq!(ubw.normalized_title, "fate stay night unlimited blade works 2");
        assert_eq!(ubw.episode_number, Some(13));
        let fsn = parse_filename("[NSA-Team] Fate Stay Night - 13 [D1E79BBC].mkv");
        assert_eq!(fsn.normalized_title, "fate stay night");
        assert_eq!(fsn.episode_number, Some(13));
    }

    #[test]
    fn number_between_title_and_episode_title() {
        let res = parse_filename(
            "(NSA)(80sTvSeries)Black Lagoon 13 - Llegan los vampiros mellizos [BDrip by Josconcillo y xxx001].mkv",
        );
        assert_eq!(res.anime_title, "Black Lagoon");
        assert_eq!(res.episode_number, Some(13));
        assert_eq!(res.episode_title.as_deref(), Some("Llegan los vampiros mellizos"));

        // Not a "NN - " shape: left alone
        let special = parse_filename("[BB] Bakuman 2 Especial - TRAP [BD 720p] [EA479233].mkv");
        assert_eq!(special.episode_number, None);
    }

    #[test]
    fn leading_number_and_extras() {
        let jojo = parse_filename("JoJo\\25 Spice Girl.mkv");
        assert_eq!(jojo.episode_number, None);
        assert_eq!(jojo.leading_number, Some(25));
        assert_eq!(jojo.parent_title.as_deref(), Some("jojo"));

        // Anitomy reads "NN - Title" itself, and the folder names the anime
        let numbered = parse_filename("Sousou no Frieren\\10 - A Powerful Mage.mkv");
        assert_eq!(numbered.episode_number, Some(10));
        assert_eq!(numbered.normalized_title, "sousou no frieren");

        // An opening is not episode 2
        let ncop = parse_filename("[Commie] Nisekoi - NCOP2 [BD 1080p AAC] [7E30892A].mkv");
        assert_eq!(ncop.episode_number, None);
        assert_eq!(ncop.leading_number, None);
    }

    #[test]
    fn parent_folders_give_season_and_title() {
        let weak = parse_filename("Houseki no Kuni\\01.mkv");
        assert_eq!(weak.anime_title, "Houseki no Kuni");
        assert_eq!(weak.episode_number, Some(1));

        let season_folder = parse_filename("Bocchi the Rock!\\Season 2\\[EMBER] Bocchi the Rock! - 03.mkv");
        assert_eq!(season_folder.anime_season, Some(2));
        assert_eq!(season_folder.normalized_title, "bocchi rock 2");
        assert_eq!(season_folder.parent_title.as_deref(), Some("bocchi rock 2"));

        assert_eq!(directory_title("[Judas] 06 - Initial D Fourth Stage"), "initial d 4th stage");
        assert_eq!(directory_title("Clannad ~After Story~"), "clannad after story");
    }
}
