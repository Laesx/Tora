use crate::detection::anitomy::{parse_filename, AnitomyElements};
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_int, c_void};

/// Official upstream Anisthesia player database (`vendor/anisthesia/data/players.anisthesia`).
pub const UPSTREAM_PLAYERS_DATA: &str =
    include_str!("../../vendor/anisthesia/data/players.anisthesia");

/// Represents a media player definition from Anisthesia's player registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerDefinition {
    pub id: String,
    pub name: String,
    pub executables: Vec<String>,
    pub window_classes: Vec<String>,
    pub title_prefixes: Vec<String>,
    pub title_suffixes: Vec<String>,
    pub enabled: bool,
}

/// Represents a currently detected active playback session from Anisthesia + Anitomy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedMediaSession {
    pub player_id: String,
    pub player_name: String,
    pub process_id: u32,
    pub executable_path: String,
    pub raw_window_title: String,
    pub cleaned_media_title: String,
    pub parsed: AnitomyElements,
    pub matched_anime_id: Option<i64>,
    pub matched_anime_title: Option<String>,
    pub matched_cover_image: Option<String>,
    pub matched_current_progress: Option<u32>,
    pub matched_total_episodes: Option<u32>,
    pub detected_at_unix: i64,
    pub elapsed_seconds: u64,
    pub auto_synced: bool,
}

/// Raw window & media candidate captured from `anisthesia::win::GetResults`.
#[derive(Debug, Clone)]
pub struct RawWindowCandidate {
    pub process_id: u32,
    pub exe_name: String,
    pub exe_path: String,
    pub window_title: String,
    pub window_class: String,
}

extern "C" {
    fn tora_anisthesia_parse_players(
        data_ptr: *const c_char,
        data_len: usize,
        user_data: *mut c_void,
        callback: extern "C" fn(
            *mut c_void,
            c_int,
            *const c_char,
            usize,
            *const c_char,
            usize,
            *const *const c_char,
            *const usize,
            usize,
            *const *const c_char,
            *const usize,
            usize,
        ),
    ) -> bool;

    fn tora_anisthesia_detect_media(
        players_data_ptr: *const c_char,
        players_data_len: usize,
        enabled_names_ptrs: *const *const c_char,
        enabled_names_lens: *const usize,
        enabled_names_count: usize,
        user_data: *mut c_void,
        callback: extern "C" fn(
            *mut c_void,
            *const c_char,
            usize,
            u32,
            *const c_char,
            usize,
            *const c_char,
            usize,
            *const c_char,
            usize,
            c_int,
            *const c_char,
            usize,
        ),
    ) -> bool;
}

fn slugify_player_id(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

unsafe fn slice_to_string(ptr: *const c_char, len: usize) -> String {
    if ptr.is_null() || len == 0 {
        return String::new();
    }
    let bytes = std::slice::from_raw_parts(ptr as *const u8, len);
    String::from_utf8_lossy(bytes).into_owned()
}

extern "C" fn on_parsed_player(
    user_data: *mut c_void,
    player_type: c_int,
    name_ptr: *const c_char,
    name_len: usize,
    window_title_format_ptr: *const c_char,
    window_title_format_len: usize,
    windows_ptrs: *const *const c_char,
    windows_lens: *const usize,
    windows_count: usize,
    executables_ptrs: *const *const c_char,
    executables_lens: *const usize,
    executables_count: usize,
) {
    if user_data.is_null() {
        return;
    }

    let list = unsafe { &mut *(user_data as *mut Vec<PlayerDefinition>) };
    let name = unsafe { slice_to_string(name_ptr, name_len) };
    if name.is_empty() {
        return;
    }

    let window_title_format =
        unsafe { slice_to_string(window_title_format_ptr, window_title_format_len) };

    let mut window_classes = Vec::with_capacity(windows_count);
    if !windows_ptrs.is_null() && !windows_lens.is_null() {
        for i in 0..windows_count {
            let s = unsafe { slice_to_string(*windows_ptrs.add(i), *windows_lens.add(i)) };
            if !s.is_empty() {
                window_classes.push(s);
            }
        }
    }

    let mut executables = Vec::with_capacity(executables_count);
    if !executables_ptrs.is_null() && !executables_lens.is_null() {
        for i in 0..executables_count {
            let s = unsafe { slice_to_string(*executables_ptrs.add(i), *executables_lens.add(i)) };
            if !s.is_empty() {
                executables.push(s);
            }
        }
    }

    let title_suffixes = if window_title_format.is_empty() {
        Vec::new()
    } else {
        vec![window_title_format]
    };

    list.push(PlayerDefinition {
        id: slugify_player_id(&name),
        name,
        executables,
        window_classes,
        title_prefixes: Vec::new(),
        title_suffixes,
        // Enable desktop video players (PlayerType::Default == 0) by default;
        // keep web browsers (PlayerType::WebBrowser == 1) opt-in.
        enabled: player_type == 0,
    });
}

/// Load the official Anisthesia player definitions directly via `anisthesia::ParsePlayersData`.
pub fn default_players() -> Vec<PlayerDefinition> {
    let mut players = Vec::new();
    unsafe {
        tora_anisthesia_parse_players(
            UPSTREAM_PLAYERS_DATA.as_ptr() as *const c_char,
            UPSTREAM_PLAYERS_DATA.len(),
            &mut players as *mut Vec<PlayerDefinition> as *mut c_void,
            on_parsed_player,
        );
    }
    players
}

#[derive(Debug, Clone)]
struct FfiDetectedItem {
    player_name: String,
    process_id: u32,
    process_name: String,
    window_class: String,
    raw_window_title: String,
    media_type: i32,
    media_value: String,
}

extern "C" fn on_detected_media(
    user_data: *mut c_void,
    player_name_ptr: *const c_char,
    player_name_len: usize,
    process_id: u32,
    process_name_ptr: *const c_char,
    process_name_len: usize,
    window_class_ptr: *const c_char,
    window_class_len: usize,
    raw_window_title_ptr: *const c_char,
    raw_window_title_len: usize,
    media_type: c_int,
    media_value_ptr: *const c_char,
    media_value_len: usize,
) {
    if user_data.is_null() {
        return;
    }

    let items = unsafe { &mut *(user_data as *mut Vec<FfiDetectedItem>) };
    let player_name = unsafe { slice_to_string(player_name_ptr, player_name_len) };
    let process_name = unsafe { slice_to_string(process_name_ptr, process_name_len) };
    let window_class = unsafe { slice_to_string(window_class_ptr, window_class_len) };
    let raw_window_title = unsafe { slice_to_string(raw_window_title_ptr, raw_window_title_len) };
    let media_value = unsafe { slice_to_string(media_value_ptr, media_value_len) };

    if !media_value.trim().is_empty() {
        items.push(FfiDetectedItem {
            player_name,
            process_id,
            process_name,
            window_class,
            raw_window_title,
            media_type,
            media_value,
        });
    }
}

/// Normalize a Win32 extended-length path (`\\?\D:\...`) if returned by `GetFinalPathNameByHandle`.
fn normalize_win32_path(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.to_string()
    }
}

/// Detect any currently playing anime episode using upstream `anisthesia::win::GetResults` + `anitomy::parse`.
pub fn detect_active_media_player(
    players: &[PlayerDefinition],
) -> Option<(PlayerDefinition, RawWindowCandidate, String, AnitomyElements)> {
    let mut enabled_tokens: Vec<String> = Vec::new();
    for player in players.iter().filter(|p| p.enabled) {
        enabled_tokens.push(player.name.clone());
        for exe in &player.executables {
            let stem = exe.strip_suffix(".exe").unwrap_or(exe);
            enabled_tokens.push(stem.to_string());
        }
    }

    if enabled_tokens.is_empty() {
        return None;
    }

    let token_ptrs: Vec<*const c_char> = enabled_tokens
        .iter()
        .map(|s| s.as_ptr() as *const c_char)
        .collect();
    let token_lens: Vec<usize> = enabled_tokens.iter().map(|s| s.len()).collect();

    let mut detected_items: Vec<FfiDetectedItem> = Vec::new();
    unsafe {
        tora_anisthesia_detect_media(
            UPSTREAM_PLAYERS_DATA.as_ptr() as *const c_char,
            UPSTREAM_PLAYERS_DATA.len(),
            token_ptrs.as_ptr(),
            token_lens.as_ptr(),
            token_ptrs.len(),
            &mut detected_items as *mut Vec<FfiDetectedItem> as *mut c_void,
            on_detected_media,
        );
    }

    if detected_items.is_empty() {
        return None;
    }

    // Prioritize MediaInfoType::File (1) from Anisthesia's OpenFiles strategy first,
    // then fall back to WindowTitle / Title / Tab strategies.
    detected_items.sort_by_key(|item| if item.media_type == 1 { 0 } else { 1 });

    for item in detected_items {
        let cleaned_media = if item.media_type == 1 {
            let normalized_path = normalize_win32_path(&item.media_value);
            normalized_path
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or(&normalized_path)
                .to_string()
        } else {
            item.media_value.trim().to_string()
        };

        if cleaned_media.is_empty()
            || cleaned_media.eq_ignore_ascii_case(&item.player_name)
            || cleaned_media.eq_ignore_ascii_case(&item.process_name)
        {
            continue;
        }

        let parsed = parse_filename(&cleaned_media);
        if parsed.anime_title.is_empty() {
            continue;
        }

        let player_def = players
            .iter()
            .find(|p| {
                p.enabled
                    && (p.name.eq_ignore_ascii_case(&item.player_name)
                        || p.executables.iter().any(|e| {
                            e.strip_suffix(".exe")
                                .unwrap_or(e)
                                .eq_ignore_ascii_case(&item.process_name)
                        }))
            })
            .cloned()
            .unwrap_or_else(|| PlayerDefinition {
                id: slugify_player_id(&item.player_name),
                name: item.player_name.clone(),
                executables: vec![item.process_name.clone()],
                window_classes: vec![item.window_class.clone()],
                title_prefixes: Vec::new(),
                title_suffixes: Vec::new(),
                enabled: true,
            });

        let candidate = RawWindowCandidate {
            process_id: item.process_id,
            exe_name: item.process_name.clone(),
            exe_path: if item.media_type == 1 {
                normalize_win32_path(&item.media_value)
            } else {
                item.process_name
            },
            window_title: item.raw_window_title,
            window_class: item.window_class,
        };

        return Some((player_def, candidate, cleaned_media, parsed));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_upstream_players_parsed_via_cpp_anisthesia() {
        let players = default_players();
        assert!(
            players.len() >= 35,
            "Expected at least 35 upstream players from players.anisthesia, got {}",
            players.len()
        );
        assert!(players.iter().any(|p| p.name == "mpv" && p.enabled));
        assert!(players.iter().any(|p| p.name == "MPC-HC" && p.enabled));
        assert!(players
            .iter()
            .any(|p| p.name == "VLC media player" && p.enabled));
        assert!(players.iter().any(|p| p.name == "PotPlayer" && p.enabled));
        // Web browsers should be parsed and disabled by default
        assert!(players
            .iter()
            .any(|p| p.name == "Mozilla Firefox" && !p.enabled));
    }

    #[test]
    fn test_live_anisthesia_detection_call() {
        let players = default_players();
        // Verify calling `anisthesia::win::GetResults` via C++ FFI executes cleanly
        let _ = detect_active_media_player(&players);
    }
}
