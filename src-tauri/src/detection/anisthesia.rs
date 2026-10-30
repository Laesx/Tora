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
    pub auto_synced: bool,
    /// Auto mode: the unix second the list update fires. Set only while the countdown runs; the UI
    /// shows `update_due_at - now` from its own clock.
    #[serde(default)]
    pub update_due_at: Option<i64>,
    /// Seconds left while the countdown is paused (the player lost focus); None = not started yet.
    #[serde(default)]
    pub update_remaining_seconds: Option<u64>,
    /// Manual update mode: the episode can be updated with the "Update" button (`confirm_playback_update`).
    #[serde(default)]
    pub awaiting_confirmation: bool,
    /// Auto mode with "wait for the player to close": the countdown finished, the update runs once
    /// the player closes or switches to another file.
    #[serde(default)]
    pub waiting_for_close: bool,
}

/// How a matched playback session turns into a list update (`AppSettings` update fields).
#[derive(Debug, Clone, Copy)]
pub struct UpdatePolicy {
    /// Never count down: offer the "Update" button instead.
    pub manual: bool,
    pub delay_seconds: u64,
    pub wait_for_close: bool,
    pub require_focus: bool,
}

impl DetectedMediaSession {
    /// Start the countdown over (new match, relinked episode, matched anime removed).
    pub fn restart_countdown(&mut self, now: i64) {
        self.detected_at_unix = now;
        self.auto_synced = false;
        self.update_due_at = None;
        self.update_remaining_seconds = None;
        self.awaiting_confirmation = false;
        self.waiting_for_close = false;
    }

    /// The detected episode is at or below the list progress (rewatch): never counts down or updates.
    pub fn is_already_seen(&self) -> bool {
        matches!(
            (self.parsed.episode_number, self.matched_current_progress),
            (Some(ep), Some(progress)) if ep <= progress
        )
    }

    /// One poll of a matched, still-playing session: advance the countdown and the update flags.
    /// Returns true when the episode should be scrobbled now (auto mode, countdown done, not held).
    ///
    /// The countdown is a pausable deadline: it starts as `now + delay`, a focus loss (when focus is
    /// required) pauses it into `update_remaining_seconds`, and regaining focus moves the deadline to
    /// `now + remaining`. It only changes on those transitions, so the UI can tick from its own clock.
    pub fn advance_update(&mut self, policy: &UpdatePolicy, player_focused: bool, now: i64) -> bool {
        if self.auto_synced || self.is_already_seen() || policy.manual {
            self.update_due_at = None;
            self.update_remaining_seconds = None;
            self.waiting_for_close = false;
            self.awaiting_confirmation = policy.manual
                && !self.auto_synced
                && !self.is_already_seen()
                && self.parsed.episode_number.is_some();
            return false;
        }
        self.awaiting_confirmation = false;
        if self.waiting_for_close {
            // Held until the player closes, unless the option was turned off meanwhile
            if policy.wait_for_close {
                return false;
            }
            self.waiting_for_close = false;
            return true;
        }

        let counting = !policy.require_focus || player_focused;
        match self.update_due_at {
            Some(due) if due <= now => {
                self.update_due_at = None;
                self.update_remaining_seconds = Some(0);
                self.waiting_for_close = policy.wait_for_close;
                !policy.wait_for_close
            }
            Some(due) => {
                if !counting {
                    self.update_due_at = None;
                    self.update_remaining_seconds = Some((due - now) as u64);
                }
                false
            }
            None => {
                let remaining = *self.update_remaining_seconds.get_or_insert(policy.delay_seconds);
                if counting {
                    self.update_due_at = Some(now + remaining as i64);
                    self.update_remaining_seconds = None;
                }
                false
            }
        }
    }
}

/// Process owning the foreground window (the countdown's "player must be in focus" check).
#[cfg(windows)]
pub fn foreground_process_id() -> Option<u32> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        (pid != 0).then_some(pid)
    }
}

#[cfg(not(windows))]
pub fn foreground_process_id() -> Option<u32> {
    None
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

    fn matched_session(ep: u32, progress: u32) -> DetectedMediaSession {
        DetectedMediaSession {
            player_id: "mpv".into(),
            player_name: "mpv".into(),
            process_id: 1,
            executable_path: String::new(),
            raw_window_title: String::new(),
            cleaned_media_title: "Show - 05.mkv".into(),
            parsed: AnitomyElements {
                episode_number: Some(ep),
                ..Default::default()
            },
            matched_anime_id: Some(1),
            matched_anime_title: Some("Show".into()),
            matched_cover_image: None,
            matched_current_progress: Some(progress),
            matched_total_episodes: Some(12),
            detected_at_unix: 1000,
            auto_synced: false,
            update_due_at: None,
            update_remaining_seconds: None,
            awaiting_confirmation: false,
            waiting_for_close: false,
        }
    }

    const AUTO: UpdatePolicy = UpdatePolicy {
        manual: false,
        delay_seconds: 120,
        wait_for_close: false,
        require_focus: false,
    };

    #[test]
    fn auto_mode_scrobbles_at_the_deadline() {
        let mut s = matched_session(5, 4);
        assert!(!s.advance_update(&AUTO, false, 1000));
        assert_eq!(s.update_due_at, Some(1120));
        // The deadline stays put between polls
        assert!(!s.advance_update(&AUTO, false, 1100));
        assert_eq!(s.update_due_at, Some(1120));
        assert!(s.advance_update(&AUTO, false, 1120));
        assert_eq!(s.update_due_at, None);
    }

    #[test]
    fn already_seen_episodes_never_count_down() {
        for policy in [AUTO, UpdatePolicy { manual: true, ..AUTO }] {
            let mut s = matched_session(4, 4);
            assert!(!s.advance_update(&policy, true, 5000));
            assert_eq!(s.update_due_at, None);
            assert!(!s.awaiting_confirmation && !s.waiting_for_close);
        }
    }

    #[test]
    fn manual_mode_offers_the_update_without_a_countdown() {
        let mut s = matched_session(5, 4);
        let manual = UpdatePolicy { manual: true, ..AUTO };
        assert!(!s.advance_update(&manual, false, 9000));
        assert!(s.awaiting_confirmation);
        assert_eq!(s.update_due_at, None);
    }

    #[test]
    fn wait_for_close_holds_the_update() {
        let mut s = matched_session(5, 4);
        let wait = UpdatePolicy { wait_for_close: true, ..AUTO };
        assert!(!s.advance_update(&wait, false, 1000));
        assert!(!s.advance_update(&wait, false, 1120));
        assert!(s.waiting_for_close);
        assert!(!s.advance_update(&wait, false, 1200));
        // Turning the option off while held scrobbles on the next poll
        assert!(s.advance_update(&AUTO, false, 1203));
    }

    #[test]
    fn focus_mode_pauses_and_resumes_the_deadline() {
        let mut s = matched_session(5, 4);
        let focus = UpdatePolicy { require_focus: true, delay_seconds: 60, ..AUTO };
        // Not focused at detection: never starts
        assert!(!s.advance_update(&focus, false, 1000));
        assert_eq!((s.update_due_at, s.update_remaining_seconds), (None, Some(60)));
        // Focused: runs
        assert!(!s.advance_update(&focus, true, 1010));
        assert_eq!(s.update_due_at, Some(1070));
        // Focus lost 20 s later: paused with 40 s left, however long it stays paused
        assert!(!s.advance_update(&focus, false, 1030));
        assert_eq!((s.update_due_at, s.update_remaining_seconds), (None, Some(40)));
        assert!(!s.advance_update(&focus, false, 5000));
        // Back in focus: the deadline moves by the pause
        assert!(!s.advance_update(&focus, true, 5005));
        assert_eq!(s.update_due_at, Some(5045));
        assert!(s.advance_update(&focus, true, 5045));
    }
}
