use crate::detection::anitomy::{parse_filename, AnitomyElements};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

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

static RE_TIMECODE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\[?\d{1,2}:\d{2}(?::\d{2})?\s*/\s*\d{1,2}:\d{2}(?::\d{2})?\]?").unwrap()
});

/// Default built-in Anisthesia player database.
pub fn default_players() -> Vec<PlayerDefinition> {
    vec![
        PlayerDefinition {
            id: "mpv".into(),
            name: "mpv".into(),
            executables: vec!["mpv.exe".into(), "mpv".into()],
            window_classes: vec!["mpv".into()],
            title_prefixes: vec![],
            title_suffixes: vec![" - mpv".into(), " — mpv".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "mpvnet".into(),
            name: "mpv.net".into(),
            executables: vec!["mpvnet.exe".into()],
            window_classes: vec![],
            title_prefixes: vec![],
            title_suffixes: vec![" - mpv.net".into(), " - mpv".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "mpc-hc".into(),
            name: "MPC-HC (Media Player Classic Home Cinema)".into(),
            executables: vec![
                "mpc-hc.exe".into(),
                "mpc-hc64.exe".into(),
                "mpc-hc_nvo.exe".into(),
            ],
            window_classes: vec!["MediaPlayerClassicW".into()],
            title_prefixes: vec![],
            title_suffixes: vec![
                " - MPC-HC".into(),
                " - Media Player Classic Home Cinema".into(),
            ],
            enabled: true,
        },
        PlayerDefinition {
            id: "mpc-be".into(),
            name: "MPC-BE (Media Player Classic Black Edition)".into(),
            executables: vec!["mpc-be.exe".into(), "mpc-be64.exe".into()],
            window_classes: vec!["MPC-BE".into(), "MediaPlayerClassicW".into()],
            title_prefixes: vec![],
            title_suffixes: vec![" - MPC-BE".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "vlc".into(),
            name: "VLC media player".into(),
            executables: vec!["vlc.exe".into()],
            window_classes: vec!["Qt5QWindowIcon".into(), "QWidget".into()],
            title_prefixes: vec![],
            title_suffixes: vec![
                " - VLC media player".into(),
                " — VLC media player".into(),
            ],
            enabled: true,
        },
        PlayerDefinition {
            id: "potplayer".into(),
            name: "Daum PotPlayer".into(),
            executables: vec![
                "PotPlayerMini64.exe".into(),
                "PotPlayerMini.exe".into(),
                "PotPlayer64.exe".into(),
                "PotPlayer.exe".into(),
            ],
            window_classes: vec!["PotPlayer".into(), "PotPlayer64".into()],
            title_prefixes: vec![],
            title_suffixes: vec![
                " - PotPlayer".into(),
                " - Daum PotPlayer".into(),
            ],
            enabled: true,
        },
        PlayerDefinition {
            id: "kmplayer".into(),
            name: "KMPlayer".into(),
            executables: vec!["KMPlayer.exe".into(), "KMPlayer64.exe".into()],
            window_classes: vec!["Winamp v1.x".into()],
            title_prefixes: vec![],
            title_suffixes: vec![" - KMPlayer".into(), " - The KMPlayer".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "smplayer".into(),
            name: "SMPlayer".into(),
            executables: vec!["smplayer.exe".into()],
            window_classes: vec![],
            title_prefixes: vec![],
            title_suffixes: vec![" - SMPlayer".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "gom".into(),
            name: "GOM Player".into(),
            executables: vec!["GOM.exe".into(), "GOM64.exe".into()],
            window_classes: vec!["GomPlayer1.x".into()],
            title_prefixes: vec![],
            title_suffixes: vec![" - GOM Player".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "zoomplayer".into(),
            name: "Zoom Player".into(),
            executables: vec!["zplayer.exe".into()],
            window_classes: vec!["TApplication".into()],
            title_prefixes: vec![],
            title_suffixes: vec![" - Zoom Player".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "bsplayer".into(),
            name: "BS.Player".into(),
            executables: vec!["bsplayer.exe".into()],
            window_classes: vec!["BSPlayer".into()],
            title_prefixes: vec![],
            title_suffixes: vec![" - BS.Player".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "kodi".into(),
            name: "Kodi".into(),
            executables: vec!["kodi.exe".into()],
            window_classes: vec!["Kodi".into()],
            title_prefixes: vec![],
            title_suffixes: vec![],
            enabled: true,
        },
        PlayerDefinition {
            id: "wmp".into(),
            name: "Windows Media Player / Media Player".into(),
            executables: vec![
                "wmplayer.exe".into(),
                "Microsoft.Media.Player.exe".into(),
                "Video.UI.exe".into(),
            ],
            window_classes: vec!["WMPlayerApp".into(), "ApplicationFrameWindow".into()],
            title_prefixes: vec![],
            title_suffixes: vec![
                " - Windows Media Player".into(),
                " - Media Player".into(),
                " - Movies & TV".into(),
                " - Films & TV".into(),
            ],
            enabled: true,
        },
        PlayerDefinition {
            id: "haruna".into(),
            name: "Haruna Media Player".into(),
            executables: vec!["haruna.exe".into()],
            window_classes: vec![],
            title_prefixes: vec![],
            title_suffixes: vec![" — Haruna".into(), " - Haruna".into()],
            enabled: true,
        },
        PlayerDefinition {
            id: "bakamplayer".into(),
            name: "Baka MPlayer".into(),
            executables: vec!["Baka MPlayer.exe".into()],
            window_classes: vec![],
            title_prefixes: vec![],
            title_suffixes: vec![" - Baka MPlayer".into()],
            enabled: true,
        },
    ]
}

/// Strip player-specific prefixes, suffixes, timecodes, and playback status symbols from a window title.
pub fn clean_window_title(raw_title: &str, player: &PlayerDefinition) -> String {
    let mut title = raw_title.trim().to_string();

    for suffix in &player.title_suffixes {
        if title.len() > suffix.len()
            && title
                .to_lowercase()
                .ends_with(&suffix.to_lowercase())
        {
            let new_len = title.len() - suffix.len();
            title.truncate(new_len);
        }
    }

    for prefix in &player.title_prefixes {
        if title.len() > prefix.len()
            && title
                .to_lowercase()
                .starts_with(&prefix.to_lowercase())
        {
            title = title[prefix.len()..].to_string();
        }
    }

    // Remove playback timecodes like [04:12 / 24:10]
    title = RE_TIMECODE.replace_all(&title, "").to_string();

    // Strip leading play/pause glyphs
    let title = title
        .trim_start_matches(['▶', '⏸', '⏹', '•', ' '])
        .trim();

    title.to_string()
}

/// Raw window info captured from Win32 EnumWindows.
#[derive(Debug, Clone)]
pub struct RawWindowCandidate {
    pub process_id: u32,
    pub exe_name: String,
    pub exe_path: String,
    pub window_title: String,
    pub window_class: String,
}

#[cfg(windows)]
pub fn scan_active_player_windows_win32(allowed_exes: &HashSet<String>) -> Vec<RawWindowCandidate> {
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, MAX_PATH};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    struct EnumContext<'a> {
        self_pid: u32,
        allowed_exes: &'a HashSet<String>,
        results: Vec<RawWindowCandidate>,
    }

    unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }

        let ctx = &mut *(lparam as *mut EnumContext<'_>);

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 || pid == ctx.self_pid {
            return 1;
        }

        // Fast kernel query for executable path BEFORE sending any WM_GETTEXT messages
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return 1;
        }

        let mut path_buf = [0u16; (MAX_PATH as usize) * 2];
        let mut size = path_buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, path_buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);

        if ok == 0 || size == 0 {
            return 1;
        }

        let exe_path = String::from_utf16_lossy(&path_buf[..size as usize]);
        let exe_name = exe_path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&exe_path)
            .to_string();

        if !ctx.allowed_exes.contains(&exe_name.to_ascii_lowercase()) {
            return 1;
        }

        // Only now read window title for confirmed media player processes
        let text_len = GetWindowTextLengthW(hwnd);
        if text_len <= 0 || text_len > 2048 {
            return 1;
        }

        let mut title_buf = vec![0u16; (text_len + 2) as usize];
        let copied = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), (text_len + 1) as i32);
        if copied <= 0 {
            return 1;
        }
        let window_title = String::from_utf16_lossy(&title_buf[..copied as usize]);
        if window_title.trim().is_empty() {
            return 1;
        }

        ctx.results.push(RawWindowCandidate {
            process_id: pid,
            exe_name,
            exe_path,
            window_title,
            window_class: String::new(),
        });

        1
    }

    if allowed_exes.is_empty() {
        return Vec::new();
    }

    let mut ctx = EnumContext {
        self_pid: std::process::id(),
        allowed_exes,
        results: Vec::new(),
    };

    unsafe {
        EnumWindows(
            Some(enum_window_proc),
            (&mut ctx as *mut EnumContext<'_>) as LPARAM,
        );
    }
    ctx.results
}

#[cfg(not(windows))]
pub fn scan_active_player_windows_win32(_allowed_exes: &HashSet<String>) -> Vec<RawWindowCandidate> {
    Vec::new()
}

/// Detect any currently playing anime episode from active Windows media player windows.
pub fn detect_active_media_player(
    players: &[PlayerDefinition],
) -> Option<(PlayerDefinition, RawWindowCandidate, String, AnitomyElements)> {
    let allowed_exes: HashSet<String> = players
        .iter()
        .filter(|p| p.enabled)
        .flat_map(|p| p.executables.iter().map(|e| e.to_ascii_lowercase()))
        .collect();

    let windows = scan_active_player_windows_win32(&allowed_exes);
    for win in windows {
        let exe_lower = win.exe_name.to_ascii_lowercase();
        for player in players.iter().filter(|p| p.enabled) {
            let matched_exe = player
                .executables
                .iter()
                .any(|e| e.to_ascii_lowercase() == exe_lower);
            if !matched_exe {
                continue;
            }

            let cleaned = clean_window_title(&win.window_title, player);
            // Ignore idle player windows whose title is just the player name
            if cleaned.is_empty()
                || cleaned.eq_ignore_ascii_case(&player.name)
                || cleaned.eq_ignore_ascii_case(&player.id)
                || cleaned.eq_ignore_ascii_case("VLC media player")
                || cleaned.eq_ignore_ascii_case("PotPlayer")
                || cleaned.eq_ignore_ascii_case("MPC-HC")
                || cleaned.eq_ignore_ascii_case("MPC-BE")
                || cleaned.eq_ignore_ascii_case("mpv")
                || cleaned.eq_ignore_ascii_case("Media Player")
            {
                continue;
            }

            let parsed = parse_filename(&cleaned);
            if !parsed.anime_title.is_empty() {
                return Some((player.clone(), win, cleaned, parsed));
            }
        }
    }
    None
}
