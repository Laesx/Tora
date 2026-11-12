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
    /// The name puts the file between two episodes ("05.5", "S01E05.5"): `episode_number` is the one
    /// before it, used to find the anime, but the file is a recap or an OVA, not that episode.
    #[serde(skip)]
    pub between_episodes: bool,
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

/// What kind of extra a name says it is, from the parse alone (stored in `local_episodes.extra_kind`; the
/// UI only reads it for files that ended up with no episode number): `opening`, `ending`, `preview`
/// (previews, trailers, commercials, menus), `special` (season 0, OVA / OAD / SP / special types) or `recap`
/// (a number between two episodes, "05.5").
pub fn extra_kind(elements: &AnitomyElements) -> Option<&'static str> {
    if let Some(t) = elements.anime_type.as_deref() {
        match t.to_ascii_lowercase().as_str() {
            "op" | "opening" | "ncop" => return Some("opening"),
            "ed" | "ending" | "nced" => return Some("ending"),
            "preview" | "pv" | "cm" | "menu" | "trailer" => return Some("preview"),
            "ova" | "oad" | "oav" | "sp" | "special" | "specials" => return Some("special"),
            _ => {}
        }
    }
    if elements.anime_season == Some(0) {
        return Some("special");
    }
    if elements.between_episodes {
        return Some("recap");
    }
    None
}

/// A number that starts the file name: "25 Spice Girl", "14 Justice - Parte 1", "06_title".
static LEADING_NUMBER: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\d{1,3})[\s._-]+\S").expect("regex"));

/// "05.5", "S01E05.5", "Hyouka_11.5_": a file between episode 5 and 6 (a recap, an OVA). Not "5.1" audio,
/// "2.0x4", "3.33".
static HALF_EPISODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|[^\d.])(\d{1,4})\.5(?:[^\d.]|\.\p{L}|$)").expect("regex"));

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
    state.elements.between_episodes = state.elements.episode_number.map_or(false, |n| {
        HALF_EPISODE
            .captures_iter(base_name)
            .any(|caps| caps[1].parse::<u32>().ok() == Some(n))
    });

    if is_extra_type(state.elements.anime_type.as_deref()) {
        // "NCOP 2", "ED 01": the number counts openings, not episodes
        state.elements.episode_number = None;
        state.elements.episode_number_alt = None;
        state.elements.is_batch = false;
    } else if state.elements.episode_number.is_none() && state.elements.volume_number.is_none() {
        state.elements.leading_number = LEADING_NUMBER
            .captures(base_name)
            .and_then(|caps| caps[1].parse::<u32>().ok());
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

    /// Inputs of upstream's corpus that the vendored Anitomy parses differently from `data.json`.
    /// A fork change that fixes one must remove it here; one that breaks another case fails the test.
    const ANITOMY_CORPUS_KNOWN_FAILURES: &[&str] = &[
        r#"[BakaWolf-m.3.3.w] Special A 01 (H.264) [C83164B9].mkv"#,
        r#"[Juuni.Kokki]-(Les.12.Royaumes)-[Ep.24]-[x264+OGG]-[JAP+FR+Sub.FR]-[Chap]-[AzF].mkv"#,
        r#"Code_Geass_R2_TV_[20_of_25]_[ru_jp]_[HDTV]_[Varies_&_Cuba77_&_AnimeReactor_RU].mkv"#,
        r#"Noein_[01_of_24]_[ru_jp]_[bodlerov_&_torrents_ru].mkv"#,
        r#"Fate_Stay_Night_Ep05_The_Two_Magi_Part1_[720p,BluRay,x264]_-_THORA.mkv"#,
        r#"[Keroro].148.[Xvid.mp3].[FE68D5F1].avi"#,
        r#"Macross Frontier - Sayonara no Tsubasa (Central Anime, 720p) [46B35E25].mkv"#,
        r#"[Raizel] Persona 4 The Animation Episode 13 - A Stormy Summer Vacation Part 1  [BD_1080p_Dual_Audio_FLAC_Hi10p][8A45634B].mkv"#,
        r#"[Mobile Suit Gundam Seed Destiny HD REMASTER][07][Big5][720p][AVC_AAC][encoded by SEED].mp4"#,
        r#"「K」 Image Blu-ray WHITE & BLACK - Main (BD 1280x720 AVC AAC).mp4"#,
        r#"[[Zero-Raws] Shingeki no Kyojin - 05 (MBS 1280x720 x264 AAC).mp4"#,
        r#"[Hakugetsu&MGRT][Evangelion 3.0 You Can (Not) Redo][480P][V0].mp4"#,
        r#"[TV-J] Kidou Senshi Gundam UC Unicorn - episode.02 [BD 1920x1080 h264+AAC(5.1ch JP+EN) +Sub(JP-EN-SP-FR-CH) Chap].mp4"#,
        r#"[UTW-THORA] Evangelion 3.33 You Can (Not) Redo [BD][1080p,x264,flac][F2060CF5].mkv"#,
        r#"[Zero-Raws] Shingeki no Kyojin - 25 END (MBS 1280x720 x264 AAC).mp4"#,
        r#"【MMZYSUB】★【Golden Time】[24（END）][GB][720P_MP4]"#,
        r#"[異域字幕組][漆黑的子彈][Black Bullet][11][1280x720][繁体].mp4"#,
        r#"[AoJiaoZero][Mangaka-san to Assistant-san to the Animation] 02 [BIG][X264_AAC][720P].mp4"#,
        r#"Attack on Titan - Episode 3 - A Dim Light Amid Despair / Humanity's Comeback, Part 1"#,
        r#"DRAMAtical Murder Episode 1 - Data_01_Login"#,
        r#"__BLUE DROP 10 (1).avi"#,
        r#"37 [Ruberia]_Death_Note_-_37v2_[FINAL]_[XviD][6FA7D273].avi"#,
        r#"[UTW]_Accel_World_-_EX01_[BD][h264-720p_AAC][3E56EE18].mkv"#,
        r#"[Urusai]_Bokura_Ga_Ita_01_[DVD_h264_AC3]_[BFCE1627][Fixed].mkv"#,
        r#"[CH] Sword Art Online Extra Edition Dual Audio [BD 480p][10bitH.264+Vorbis]"#,
        r#"EvoBot.[Watakushi]_Akuma_no_Riddle_-_01v2_[720p][69A307A2].mkv"#,
        r#"Episode 14 Ore no Imouto ga Konnani Kawaii Wake ga Nai. (saison 2) VOSTFR"#,
        r#"[Yuurisan-Subs]_Darker_than_Black_-_Gemini_of_the_Meteor_-_01v2_[65274FDE].patch.7z"#,
        r#"[Coalgirls]_Fate_Zero_OVA3.5_(1280x720_Blu-ray_FLAC)_[5F5AD026].mkv"#,
        r#"[SpoonSubs]_Hidamari_Sketch_x365_-_04.1_(DVD)[B6CE8458].mkv"#,
        r#"[Hatsuyuki]_Kuroko_no_Basuke_S3_-_01_(51)_[720p][10bit][619C57A0].mkv"#,
        r#"[Elysium]Sora.no.Woto.EP07.5(BD.720p.AAC)[C37580F8].mkv"#,
        r#"[Hiryuu] Maji de Watashi ni Koi Shinasai!! - 02 [720].mkv"#,
        r#"[ANE] Yosuga no Sora - Ep01 Preview (Yorihime ver) [BDRip 1080p x264 FLAC].mkv"#,
        r#"[B-G_&_m.3.3.w]_Myself_Yourself_12.DVD(H.264_DD2.0)_[CB2B37F1].mkv"#,
        r#"The.Animatrix.08.A.Detective.Story.720p.BluRay.DTS.x264-ESiR.mkv"#,
        r#"[ReDone] Memories Off 3.5 - 04 (DVD 10-bit).mkv"#,
        r#"[Hatsuyuki] Dragon Ball Kai (2014) - 002 (100) [1280x720][DD66AFB7].mkv"#,
        r#"[Deep] Tegami Bachi (REVERSE) - Letter Bee - 29 (04) [5203142B].mkv"#,
        r#"[FB] Crayon Shin-Chan Movie 2 The Secret of Buri Buri Kingdom [DivX5 AC3] 1994 [852X480] V2.avi"#,
        r#"[Hatsuyuki-Kaitou]_Fairy_Tail_2_-_52_(227)_[720p][10bit][9DF6B8D5].mkv"#,
        r#"[5F] RWBY 14 Forever Fall Part 2 pt-BR.mp4"#,
        r#"[Anime"#,
        r#"[BM&T] Toradora! - 07v2 - Pool Opening [720p Hi10 ] [BD] [8F59F2BA]"#,
        r#"Fairy Tail - S06E32 - Tartaros Arc Iron Fist of the Fire Dragon [Episode 83]"#,
        r#"Noragami - S02E06 - What Must Be Done [Episode 6]"#,
        r#"[GS] Classroom Crisis Vol.1&2 (BD 1080p 10bit FLAC)"#,
        r#"[(´• ω •`)] Nintama Rantarou - S23E1821 - Buddhist Priest-sama is a Ninja.mkv"#,
        r#"05 - Hidan no Aria - Butei Charter Article 1 - [UTW](E7724B68).mkv"#,
        r#"Piano no Mori 2 (TV)"#,
        r#"One Piece - 1080"#,
        r#"Detective-Conan-656 Professor's Video Site (Part 1)"#,
        r#"The.Eminence.in.Shadow.S01E05.I.Am....1080p.BluRay.DD2.0.x265-ExCaLiBuR.mkv"#,
        r#"[xPearse] Great Mazinger - Episode 55 Preview [English Sub] [480p].mkv"#,
        r#"[Erai-raws] NieR-Automata Ver1_1a - 02 [1080p][Multiple Subtitle][5BCD4615].mkv"#,
        r#"[Erai-raws] NieR-Automata Ver1_1a Part 2 - 03 [1080p][Multiple Subtitle][AAF0612D].mkv"#,
        r#"Highschool.of.the.Dead.S00E01.v2.Drifters.of.the.Dead.1080p-Hi10p.BluRay.FLAC5.1.x264-CTR.[32FD04E5].mkv"#,
        r#"[CBM]_Monster_-_11_-_511_Kinderheim_[6C70C4E4].mkv"#,
        r#"Mahoutsukai Reimeiki E06v1.5 [1080p][AAC][JapDub][GerEngSub][Web-DL].mkv"#,
        r#"[Erai-raws] Ranma 1-2 (2024) - 03 [1080p][Multiple Subtitle]"#,
        r#"[Genderbender] Ranma 1+2 (2024) - 01 [HEVC 1080p] [Dual Audio].mkv"#,
        r#"Ranma.1-2.2024.S01E11.You.I.Love.1080p.NF.WEB-DL.AAC2.0.H.264.MULTi-VARYG.mkv"#,
        r#"[Erai-raws] Vanitas no Karte 2nd Cour - 01 [1080p][Multiple Subtitle][DE38A9CD].mkv"#,
        r#"[pat-e] The Devil is a Part-Timer! - Season 1 (BD 1080p AV1 Opus) [Dual Audio] | Hataraku Maou-sama! - S01"#,
        r#"[Judas] Sword Art Online S3 P2 - 01.mkv"#,
        r#"My.Hero.Academia.S04.P2.CRF-16.1080p.Blu-Ray.10-Bit.Dual-Audio.TrueHD.x265-iAHD"#,
    ];

    /// Anitomy's own corpus (`vendor/anitomy/test/data.json`) through Tora's FFI and build flags, compared
    /// the way upstream's `test/main.cpp --test-data` does: per element kind, values joined with ", ",
    /// both missing and extra elements. Upstream builds it with CMake; this catches a fork change that
    /// behaves differently in Tora's build.
    #[test]
    fn anitomy_corpus() {
        // `anitomy::ElementKind` order (`detail/format.hpp`)
        const KIND_NAMES: [&str; 21] = [
            "audio_term", "device", "episode", "episode_title", "file_checksum", "file_extension", "language",
            "other", "part", "release_group", "release_information", "release_version", "season", "source",
            "subtitles", "title", "type", "video_resolution", "video_term", "volume", "year",
        ];
        extern "C" fn collect(user_data: *mut c_void, kind: c_int, value_ptr: *const c_char, value_len: usize, _pos: usize) {
            let elements = unsafe { &mut *(user_data as *mut Vec<(c_int, String)>) };
            let value = if value_ptr.is_null() {
                String::new()
            } else {
                String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(value_ptr as *const u8, value_len) })
                    .into_owned()
            };
            elements.push((kind, value));
        }

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/anitomy/test/data.json");
        let data: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read data.json")).expect("parse data.json");
        let mut failures: Vec<(String, Vec<String>)> = Vec::new();
        for case in data.as_array().expect("an array of cases") {
            let input = case["input"].as_str().expect("input");
            let mut raw: Vec<(c_int, String)> = Vec::new();
            unsafe {
                tora_anitomy_parse(
                    input.as_ptr() as *const c_char,
                    input.len(),
                    0,
                    &mut raw as *mut Vec<(c_int, String)> as *mut c_void,
                    collect,
                );
            }
            let mut parsed: std::collections::BTreeMap<&str, Vec<String>> = Default::default();
            for (kind, value) in raw {
                let name = KIND_NAMES.get(kind as usize).copied().unwrap_or("?");
                parsed.entry(name).or_default().push(value);
            }
            let expected = case["output"].as_object().expect("output");
            let mut diffs = Vec::new();
            for (name, value) in expected {
                let want = match value {
                    serde_json::Value::Array(values) => {
                        values.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", ")
                    }
                    other => other.as_str().unwrap_or_default().to_string(),
                };
                let got = parsed.get(name.as_str()).map(|v| v.join(", ")).unwrap_or_default();
                if want != got {
                    diffs.push(format!("{name}: expected {want:?}, got {got:?}"));
                }
            }
            for (name, values) in &parsed {
                if !expected.contains_key(*name) {
                    diffs.push(format!("{name}: expected nothing, got {:?}", values.join(", ")));
                }
            }
            if !diffs.is_empty() {
                failures.push((input.to_string(), diffs));
            }
        }

        let known: std::collections::HashSet<&str> = ANITOMY_CORPUS_KNOWN_FAILURES.iter().copied().collect();
        let new: Vec<String> = failures
            .iter()
            .filter(|(input, _)| !known.contains(input.as_str()))
            .map(|(input, diffs)| format!("{input}\n    {}", diffs.join("\n    ")))
            .collect();
        let failing: std::collections::HashSet<&str> = failures.iter().map(|(i, _)| i.as_str()).collect();
        let fixed: Vec<&str> = ANITOMY_CORPUS_KNOWN_FAILURES.iter().copied().filter(|i| !failing.contains(i)).collect();
        assert!(new.is_empty(), "{} corpus case(s) newly differ:\n{}", new.len(), new.join("\n"));
        assert!(fixed.is_empty(), "now parsed as data.json says, remove from ANITOMY_CORPUS_KNOWN_FAILURES:\n{}", fixed.join("\n"));
    }

    #[test]
    fn extra_kinds_come_from_the_name() {
        for (name, kind) in [
            ("[Group] Show - NCOP 2 [1080p].mkv", Some("opening")),
            ("[Group] Show - NCED [1080p].mkv", Some("ending")),
            ("[Group] Show - PV [1080p].mkv", Some("preview")),
            ("[Group] Show S00E03 [1080p].mkv", Some("special")),
            ("[Coalgirls]_Hyouka_11.5_(1920x1080_Blu-Ray_FLAC)_[0428AD73].mkv", Some("recap")),
            ("[Group] Show - 05 [1080p].mkv", None),
        ] {
            assert_eq!(extra_kind(&parse_filename(name)), kind, "{name}");
        }
    }

    #[test]
    fn half_episodes_are_between_episodes() {
        for name in [
            "[Commie] Girls und Panzer - 5.5 [56CF43E1].mkv",
            "Link Click S01E05.5.mkv",
            "[Coalgirls]_Hyouka_11.5_(1920x1080_Blu-Ray_FLAC)_[0428AD73].mkv",
        ] {
            let res = parse_filename(name);
            assert!(res.between_episodes, "{name}");
            assert!(res.episode_number.is_some(), "{name}");
        }
        for name in [
            "[Group] Show - 05 [BD 1080p DDP5.1].mkv",
            "Evangelion 3.33 You Can (Not) Redo [BD].mkv",
            "[Group] Show - 05 (BDRip x265 AC3 2.0x2).mkv",
        ] {
            assert!(!parse_filename(name).between_episodes, "{name}");
        }
    }

    #[test]
    fn names_anitomy_used_to_misread() {
        // Fixed in the fork (`Laesx/anitomy`, AGENTS.md section 2); kept here as the names that broke.
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
