//! App-wide logging through the `log` facade and `tauri-plugin-log`: the console in dev and a rotated
//! file in `%APPDATA%\<id>\logs\tora.log`. The frontend writes to the same file (`@tauri-apps/plugin-log`,
//! targets `webview:…`). Targets are short subsystem names (`sync`, `playback`, `anilist`, …).
//!
//! Never log the AniList token, request variables or file contents; hot paths (the recognition poll,
//! per-file matching, per-release evaluation) log only state changes, never every pass.

use std::path::{Path, PathBuf};
use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const LOG_FILE: &str = "tora";
const MAX_FILE_BYTES: u128 = 5 * 1024 * 1024;
const KEEP_FILES: usize = 5;

/// `%APPDATA%\<identifier>\logs`: next to the database, the same folder Tauri's `app_data_dir` resolves
/// (the plugin's own `LogDir` would be under `%LOCALAPPDATA%`).
pub fn log_dir(identifier: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(identifier)
        .join("logs")
}

pub fn plugin<R: Runtime>(dir: PathBuf) -> TauriPlugin<R> {
    let level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::Folder {
            path: dir,
            file_name: Some(LOG_FILE.into()),
        }))
        .level(level)
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_FILES))
        .timezone_strategy(TimezoneStrategy::UseLocal);
    // Dependencies only when something is wrong
    for noisy in [
        "reqwest",
        "hyper",
        "hyper_util",
        "rustls",
        "tao",
        "wry",
        "tracing",
        "h2",
    ] {
        builder = builder.level_for(noisy, log::LevelFilter::Warn);
    }
    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder.build()
}

/// Panics are logged (with their location) before the default hook prints them. Panics inside
/// `spawn_blocking` otherwise only surface as a `JoinError` string.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        log::error!(
            target: "panic",
            "thread '{}' panicked: {}",
            thread.name().unwrap_or("<unnamed>"),
            info
        );
        default_hook(info);
    }));
}

/// The last `lines` lines of the current log file (Settings → Diagnostics, for bug reports).
pub fn tail(dir: &Path, lines: usize) -> Result<String, String> {
    let path = dir.join(format!("{}.log", LOG_FILE));
    let bytes =
        std::fs::read(&path).map_err(|e| format!("can't read {}: {}", path.display(), e))?;
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    Ok(all[all.len().saturating_sub(lines)..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_returns_the_last_lines() {
        let dir = std::env::temp_dir().join(format!("tora-log-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tora.log"), "a\nb\nc\nd\n").unwrap();
        assert_eq!(tail(&dir, 2).unwrap(), "c\nd");
        assert_eq!(tail(&dir, 10).unwrap(), "a\nb\nc\nd");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
