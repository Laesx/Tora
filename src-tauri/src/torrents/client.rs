//! Hands torrents to the user's torrent application the way Taiga does: download the `.torrent` (or use the
//! magnet), resolve a save folder per anime, and launch the client's exe with its own command-line flags.
//! qBittorrent is single-instance, so a launch while it's closed starts it, and later launches are
//! forwarded to the running instance, which queues everything.

use crate::db::{AnimeEntry, AppSettings};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    Qbittorrent,
    Utorrent,
    DelugeConsole,
    Picotorrent,
    Aria2,
    TransmissionRemote,
    /// Unknown exe: gets only the file / magnet.
    Generic,
}

impl ClientKind {
    /// Recognized by exe name, like Taiga.
    pub fn from_exe(exe: &Path) -> ClientKind {
        let name = exe
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name.contains("qbittorrent") {
            ClientKind::Qbittorrent
        } else if name.contains("utorrent") || name.contains("bittorrent") {
            ClientKind::Utorrent
        } else if name.contains("deluge-console") {
            ClientKind::DelugeConsole
        } else if name.contains("picotorrent") {
            ClientKind::Picotorrent
        } else if name.contains("aria2c") {
            ClientKind::Aria2
        } else if name.contains("transmission-remote") {
            ClientKind::TransmissionRemote
        } else {
            ClientKind::Generic
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ClientKind::Qbittorrent => "qBittorrent",
            ClientKind::Utorrent => "µTorrent / BitTorrent",
            ClientKind::DelugeConsole => "Deluge (console)",
            ClientKind::Picotorrent => "PicoTorrent",
            ClientKind::Aria2 => "aria2",
            ClientKind::TransmissionRemote => "Transmission (remote)",
            ClientKind::Generic => "Other application",
        }
    }

    /// Console clients run without a window.
    fn hidden(self) -> bool {
        matches!(self, ClientKind::DelugeConsole | ClientKind::TransmissionRemote)
    }

    /// Takes several torrents in one invocation.
    fn multi(self) -> bool {
        matches!(self, ClientKind::Qbittorrent)
    }

    fn supports_save_path(self) -> bool {
        !matches!(self, ClientKind::Generic)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DetectedApp {
    /// Exe that will be launched (empty when none was found: the system default handler is used).
    pub path: String,
    pub kind: ClientKind,
    pub label: String,
    /// `custom` | `association` | `registry` | `program_files` | `none`.
    pub source: String,
}

/// One process launch.
#[derive(Debug, Clone, PartialEq)]
pub struct Invocation {
    pub args: Vec<String>,
    pub hidden: bool,
}

/// Trailing slashes are stripped: before a closing quote they would escape it.
fn clean_dir(dir: &str) -> String {
    dir.trim().trim_end_matches(['\\', '/']).to_string()
}

/// Builds the launches for torrents grouped by save folder (`None` = the client's default folder).
pub fn build_invocations(
    kind: ClientKind,
    category: &str,
    groups: &[(Option<String>, Vec<String>)],
) -> Vec<Invocation> {
    let mut out = Vec::new();
    for (dir, targets) in groups {
        let dir = dir.as_deref().map(clean_dir).filter(|d| !d.is_empty());
        let batches: Vec<Vec<String>> = if kind.multi() {
            vec![targets.clone()]
        } else {
            targets.iter().map(|t| vec![t.clone()]).collect()
        };
        for files in batches {
            if files.is_empty() {
                continue;
            }
            let mut args: Vec<String> = Vec::new();
            match (kind, dir.as_ref()) {
                (ClientKind::Qbittorrent, d) => {
                    if let Some(d) = d {
                        args.push(format!("--save-path={}", d));
                    }
                    if !category.trim().is_empty() {
                        args.push(format!("--category={}", category.trim()));
                    }
                    args.push("--skip-dialog=true".into());
                    args.extend(files);
                }
                (ClientKind::Utorrent, Some(d)) => {
                    args.extend(["/directory".to_string(), d.clone()]);
                    args.extend(files);
                }
                (ClientKind::DelugeConsole, d) => {
                    let mut cmd = String::from("add ");
                    if let Some(d) = d {
                        cmd.push_str(&format!("-p \"{}\" ", d));
                    }
                    cmd.push_str(&format!("\"{}\"", files[0]));
                    args.push(cmd);
                }
                (ClientKind::Picotorrent, d) => {
                    if let Some(d) = d {
                        args.push(format!("--save-path={}", d));
                    }
                    args.push("--silent".into());
                    args.extend(files);
                }
                (ClientKind::Aria2, d) => {
                    if let Some(d) = d {
                        args.push(format!("--dir={}", d));
                    }
                    args.extend(files);
                }
                (ClientKind::TransmissionRemote, d) => {
                    args.extend(["-a".to_string(), files[0].clone()]);
                    if let Some(d) = d {
                        args.extend(["-w".to_string(), d.clone()]);
                    }
                }
                (ClientKind::Utorrent, None) | (ClientKind::Generic, _) => args.extend(files),
            }
            out.push(Invocation {
                args,
                hidden: kind.hidden(),
            });
        }
    }
    out
}

/// Windows-safe folder name for an anime title.
pub fn sanitize_folder_name(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_end_matches(['.', ' ']).to_string();
    if s.chars().count() > 120 {
        s = s.chars().take(120).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    }
    let upper = s.to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        s.push('_');
    }
    s
}

#[derive(Debug, Clone, PartialEq)]
pub struct SaveTarget {
    pub dir: Option<String>,
    /// Folder to create before launching (a new per-anime subfolder).
    pub create: bool,
    /// Write `dir` to this anime's `custom_folder` (only if it's still empty).
    pub bind_anime: Option<i64>,
}

/// Save folder order: the anime's `custom_folder` (if it exists) → the folder its local episodes are in (if
/// they're all in one) → `<default folder>\<title>` (created; bound to the anime) → the client's default.
pub fn resolve_save_target(
    anime: Option<&AnimeEntry>,
    episode_dirs: &[String],
    parsed_title: &str,
    settings: &AppSettings,
) -> SaveTarget {
    if let Some(cf) = anime
        .and_then(|a| a.custom_folder.as_deref())
        .map(str::trim)
        .filter(|cf| !cf.is_empty() && Path::new(cf).is_dir())
    {
        return SaveTarget { dir: Some(clean_dir(cf)), create: false, bind_anime: None };
    }
    if anime.is_some() {
        let mut dirs: Vec<String> = episode_dirs.iter().map(|d| clean_dir(d).to_lowercase()).collect();
        dirs.sort();
        dirs.dedup();
        if dirs.len() == 1 {
            if let Some(d) = episode_dirs.first().filter(|d| Path::new(d.as_str()).is_dir()) {
                return SaveTarget { dir: Some(clean_dir(d)), create: false, bind_anime: None };
            }
        }
    }
    let root = clean_dir(&settings.torrent_download_folder);
    if root.is_empty() {
        return SaveTarget { dir: None, create: false, bind_anime: None };
    }
    if !settings.torrent_create_subfolder {
        return SaveTarget { dir: Some(root), create: true, bind_anime: None };
    }
    let title = anime.map(|a| a.title_romaji.as_str()).unwrap_or(parsed_title);
    let name = sanitize_folder_name(title);
    if name.is_empty() {
        return SaveTarget { dir: Some(root), create: true, bind_anime: None };
    }
    let dir = Path::new(&root).join(name).to_string_lossy().to_string();
    let bind_anime = anime
        .filter(|a| a.custom_folder.as_deref().map_or(true, |cf| cf.trim().is_empty()))
        .map(|a| a.id);
    SaveTarget { dir: Some(dir), create: true, bind_anime }
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn association_exe() -> Option<PathBuf> {
    use windows_sys::Win32::UI::Shell::{AssocQueryStringW, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR_EXECUTABLE};
    let ext = to_wide(".torrent");
    let verb = to_wide("open");
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    let hr = unsafe {
        AssocQueryStringW(
            ASSOCF_INIT_IGNOREUNKNOWN,
            ASSOCSTR_EXECUTABLE,
            ext.as_ptr(),
            verb.as_ptr(),
            buf.as_mut_ptr(),
            &mut len,
        )
    };
    if hr != 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let path = PathBuf::from(String::from_utf16_lossy(&buf[..end]));
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    // "Open with" placeholders and browsers aren't torrent clients.
    let not_client = ["openwith.exe", "rundll32.exe", "explorer.exe", "msedge.exe", "chrome.exe", "firefox.exe"];
    (path.is_file() && !not_client.contains(&name.as_str())).then_some(path)
}

#[cfg(windows)]
fn registry_qbittorrent() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    for key in ["SOFTWARE\\qBittorrent", "SOFTWARE\\WOW6432Node\\qBittorrent"] {
        let k = to_wide(key);
        let v = to_wide("InstallLocation");
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                k.as_ptr(),
                v.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr() as *mut _,
                &mut size,
            )
        };
        if rc == 0 {
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            let dir = PathBuf::from(String::from_utf16_lossy(&buf[..end]));
            let exe = dir.join("qbittorrent.exe");
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn association_exe() -> Option<PathBuf> {
    None
}

#[cfg(not(windows))]
fn registry_qbittorrent() -> Option<PathBuf> {
    None
}

fn program_files_qbittorrent() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|v| std::env::var_os(v))
        .map(|dir| PathBuf::from(dir).join("qBittorrent").join("qbittorrent.exe"))
        .find(|p| p.is_file())
}

/// Custom exe → `.torrent` association → qBittorrent's install key → Program Files.
pub fn detect_app(custom_path: &str) -> DetectedApp {
    let found = {
        let custom = custom_path.trim();
        if !custom.is_empty() && Path::new(custom).is_file() {
            Some((PathBuf::from(custom), "custom"))
        } else {
            association_exe()
                .map(|p| (p, "association"))
                .or_else(|| registry_qbittorrent().map(|p| (p, "registry")))
                .or_else(|| program_files_qbittorrent().map(|p| (p, "program_files")))
        }
    };
    match found {
        Some((path, source)) => {
            let kind = ClientKind::from_exe(&path);
            DetectedApp {
                path: path.to_string_lossy().to_string(),
                kind,
                label: kind.label().to_string(),
                source: source.into(),
            }
        }
        None => DetectedApp {
            path: String::new(),
            kind: ClientKind::Generic,
            label: "System default".into(),
            source: "none".into(),
        },
    }
}

#[cfg(windows)]
pub fn is_process_running(exe_name: &str) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let want = exe_name.to_ascii_lowercase();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase() == want {
                    found = true;
                    break;
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        found
    }
}

#[cfg(not(windows))]
pub fn is_process_running(_exe_name: &str) -> bool {
    false
}

fn spawn(exe: &Path, inv: &Invocation) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    cmd.args(&inv.args);
    #[cfg(windows)]
    if inv.hidden {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't start {}: {}", exe.display(), e))
}

/// Opens a `.torrent` file or magnet with the system's default handler.
fn open_default(target: &str) -> Result<(), String> {
    let result = if target.starts_with("magnet:") {
        tauri_plugin_opener::open_url(target, None::<&str>)
    } else {
        tauri_plugin_opener::open_path(target, None::<&str>)
    };
    result.map_err(|e| format!("Couldn't open the torrent with the default application: {}", e))
}

/// Downloads a `.torrent` into `dir` (rejects HTML / error pages, like Taiga) and returns its path.
pub async fn download_torrent_file(url: &str, title: &str, dir: &Path) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .user_agent("Tora/0.1.0 (Anime Library Manager)")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .header("Accept", "application/x-bittorrent")
        .send()
        .await
        .map_err(|e| format!("Couldn't download the .torrent: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("The .torrent download returned HTTP {}", resp.status()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("text/html") {
        return Err("The .torrent link returned a web page".into());
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    // Bencoded dictionaries start with 'd'.
    if bytes.first() != Some(&b'd') {
        return Err("The downloaded file isn't a .torrent".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut name = sanitize_folder_name(title);
    if name.is_empty() {
        name = "release".into();
    }
    let path = dir.join(format!("{}.torrent", name));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Launches the client for torrents grouped by save folder. With qBittorrent closed, waits for it to come
/// up after the first launch so the next ones reach the running instance instead of racing its startup.
pub async fn launch(app: &DetectedApp, category: &str, groups: Vec<(Option<String>, Vec<String>)>) -> Result<(), String> {
    if app.path.is_empty() {
        for (_, targets) in &groups {
            for t in targets {
                open_default(t)?;
            }
        }
        return Ok(());
    }
    let exe = PathBuf::from(&app.path);
    let groups = if app.kind.supports_save_path() {
        groups
    } else {
        vec![(None, groups.into_iter().flat_map(|(_, t)| t).collect())]
    };
    let invocations = build_invocations(app.kind, category, &groups);
    let exe_name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let mut wait_for_start = app.kind == ClientKind::Qbittorrent && !is_process_running(&exe_name);
    let total = invocations.len();
    for (i, inv) in invocations.iter().enumerate() {
        spawn(&exe, inv)?;
        if i + 1 < total {
            if wait_for_start {
                for _ in 0..40 {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    if is_process_running(&exe_name) {
                        break;
                    }
                }
                // The single-instance server starts a moment after the process.
                tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
                wait_for_start = false;
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_entry;

    #[test]
    fn kind_from_exe_name() {
        assert_eq!(ClientKind::from_exe(Path::new("C:\\Program Files\\qBittorrent\\qbittorrent.exe")), ClientKind::Qbittorrent);
        assert_eq!(ClientKind::from_exe(Path::new("uTorrent.exe")), ClientKind::Utorrent);
        assert_eq!(ClientKind::from_exe(Path::new("deluge-console.exe")), ClientKind::DelugeConsole);
        assert_eq!(ClientKind::from_exe(Path::new("Tixati.exe")), ClientKind::Generic);
    }

    #[test]
    fn qbittorrent_args_group_per_folder() {
        let inv = build_invocations(
            ClientKind::Qbittorrent,
            "anime",
            &[
                (Some("D:\\Anime\\Kusuriya no Hitorigoto 3rd Season\\".into()), vec!["a.torrent".into(), "magnet:?xt=b".into()]),
                (None, vec!["c.torrent".into()]),
            ],
        );
        assert_eq!(inv.len(), 2);
        assert_eq!(
            inv[0].args,
            vec![
                "--save-path=D:\\Anime\\Kusuriya no Hitorigoto 3rd Season",
                "--category=anime",
                "--skip-dialog=true",
                "a.torrent",
                "magnet:?xt=b",
            ]
        );
        assert_eq!(inv[1].args, vec!["--category=anime", "--skip-dialog=true", "c.torrent"]);
        assert!(!inv[0].hidden);
    }

    #[test]
    fn other_clients_follow_taiga() {
        let groups = [(Some("D:/Anime/Show/".to_string()), vec!["x.torrent".to_string(), "y.torrent".to_string()])];
        let ut = build_invocations(ClientKind::Utorrent, "", &groups);
        assert_eq!(ut.len(), 2);
        assert_eq!(ut[0].args, vec!["/directory", "D:/Anime/Show", "x.torrent"]);
        let dc = build_invocations(ClientKind::DelugeConsole, "", &groups);
        assert_eq!(dc[0].args, vec!["add -p \"D:/Anime/Show\" \"x.torrent\""]);
        assert!(dc[0].hidden);
        let tr = build_invocations(ClientKind::TransmissionRemote, "", &groups);
        assert_eq!(tr[1].args, vec!["-a", "y.torrent", "-w", "D:/Anime/Show"]);
        let pico = build_invocations(ClientKind::Picotorrent, "", &groups);
        assert_eq!(pico[0].args, vec!["--save-path=D:/Anime/Show", "--silent", "x.torrent"]);
        let aria = build_invocations(ClientKind::Aria2, "", &groups);
        assert_eq!(aria[0].args, vec!["--dir=D:/Anime/Show", "x.torrent"]);
    }

    #[test]
    fn folder_names_are_windows_safe() {
        assert_eq!(sanitize_folder_name("Re:Zero kara Hajimeru Isekai Seikatsu"), "Re Zero kara Hajimeru Isekai Seikatsu");
        assert_eq!(sanitize_folder_name("Why? / Because..."), "Why Because");
        assert_eq!(sanitize_folder_name("CON"), "CON_");
    }

    #[test]
    fn save_target_order() {
        let base = std::env::temp_dir().join(format!("tora-save-{}", std::process::id()));
        let existing = base.join("Existing");
        std::fs::create_dir_all(&existing).unwrap();
        let mut settings = AppSettings::default();
        settings.torrent_download_folder = base.join("Downloads").to_string_lossy().to_string();

        let mut anime = test_entry(1, "Kusuriya no Hitorigoto 3rd Season");
        // 1. existing custom folder
        anime.custom_folder = Some(existing.to_string_lossy().to_string());
        let t = resolve_save_target(Some(&anime), &[], "", &settings);
        assert_eq!(t.dir.as_deref(), Some(existing.to_string_lossy().as_ref()));
        assert_eq!(t.bind_anime, None);
        // 2. the single folder its episodes are in
        anime.custom_folder = Some(base.join("Gone").to_string_lossy().to_string());
        let eps = [existing.to_string_lossy().to_string()];
        let t = resolve_save_target(Some(&anime), &eps, "", &settings);
        assert_eq!(t.dir.as_deref(), Some(existing.to_string_lossy().as_ref()));
        // 3. a new subfolder, bound only when custom_folder is empty
        anime.custom_folder = None;
        let t = resolve_save_target(Some(&anime), &[], "", &settings);
        let want = base.join("Downloads").join("Kusuriya no Hitorigoto 3rd Season");
        assert_eq!(t.dir.as_deref(), Some(want.to_string_lossy().as_ref()));
        assert!(t.create);
        assert_eq!(t.bind_anime, Some(1));
        anime.custom_folder = Some(base.join("Gone").to_string_lossy().to_string());
        assert_eq!(resolve_save_target(Some(&anime), &[], "", &settings).bind_anime, None);
        // unmatched: folder named after the parsed title, never bound
        let t = resolve_save_target(None, &[], "Some Show", &settings);
        assert!(t.dir.unwrap().ends_with("Some Show"));
        assert_eq!(t.bind_anime, None);
        // 4. no default folder
        settings.torrent_download_folder.clear();
        assert_eq!(resolve_save_target(None, &[], "Some Show", &settings).dir, None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
