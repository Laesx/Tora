//! System tray icon and the window behavior that goes with it: minimize / close to the tray, start
//! with Windows (optionally hidden), the playing anime in the tooltip, a playback detection toggle.
//!
//! Window events only read the atomics in [`TrayState`] (never SQLite: they run on the main thread).
//! [`apply_settings`] refreshes them after every settings save or restore.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Window, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::db::AppSettings;
use crate::AppState;

const TRAY_ID: &str = "main";
const MAIN_WINDOW: &str = "main";
/// Command-line flag of the Windows startup entry (`tauri_plugin_autostart::init`).
pub const AUTOSTART_ARG: &str = "--autostart";
/// Carries the full `AppSettings` after the backend changed them (tray detection toggle).
pub const EVENT_SETTINGS_CHANGED: &str = "settings-changed";

pub struct TrayState {
    tray_enabled: AtomicBool,
    minimize_to_tray: AtomicBool,
    close_to_tray: AtomicBool,
    now_playing: MenuItem<Wry>,
    detection: CheckMenuItem<Wry>,
    /// Last now-playing label shown, so the poll only touches the tray when it changes.
    last_label: Mutex<Option<String>>,
}

/// Builds the tray icon (hidden when the setting is off) and registers [`TrayState`].
pub fn init(app: &AppHandle, settings: &AppSettings) -> tauri::Result<()> {
    let now_playing = MenuItem::with_id(app, "now_playing", "Nothing playing", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show Tora", true, None::<&str>)?;
    let detection = CheckMenuItem::with_id(
        app,
        "detection",
        "Playback detection",
        true,
        settings.recognition_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Tora", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &now_playing,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &detection,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Tora")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "detection" => toggle_detection(app),
            "quit" => {
                log::info!(target: "app", "quit from the tray");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    tray.set_visible(settings.tray_icon_enabled)?;

    app.manage(TrayState {
        tray_enabled: AtomicBool::new(settings.tray_icon_enabled),
        minimize_to_tray: AtomicBool::new(settings.minimize_to_tray),
        close_to_tray: AtomicBool::new(settings.close_to_tray),
        now_playing,
        detection,
        last_label: Mutex::new(None),
    });
    Ok(())
}

/// After a settings save / restore: window behavior, tray visibility, the detection check mark and
/// the Windows startup entry. Call it off the main thread (the startup entry is a registry write).
pub fn apply_settings(app: &AppHandle, settings: &AppSettings) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    state.tray_enabled.store(settings.tray_icon_enabled, Ordering::Relaxed);
    state.minimize_to_tray.store(settings.minimize_to_tray, Ordering::Relaxed);
    state.close_to_tray.store(settings.close_to_tray, Ordering::Relaxed);
    let _ = state.detection.set_checked(settings.recognition_enabled);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(settings.tray_icon_enabled);
    }
    // Without the icon there would be no way back to a hidden window
    if !settings.tray_icon_enabled {
        let hidden = app
            .get_webview_window(MAIN_WINDOW)
            .is_some_and(|w| !w.is_visible().unwrap_or(true));
        if hidden {
            show_main_window(app);
        }
    }
    sync_autostart(app, settings.start_with_windows);
}

/// Makes the Windows startup entry match the setting (also fixes a stale entry after a reinstall).
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    let launcher = app.autolaunch();
    match launcher.is_enabled() {
        Ok(current) if current == enabled => {}
        _ => {
            let result = if enabled { launcher.enable() } else { launcher.disable() };
            match result {
                Ok(()) => log::info!(target: "app", "start with Windows {}", if enabled { "on" } else { "off" }),
                Err(e) => log::warn!(target: "app", "failed to update the Windows startup entry: {}", e),
            }
        }
    }
}

/// Launched by the Windows startup entry with "Start in the tray" on: the window stays hidden.
pub fn starts_hidden(settings: &AppSettings) -> bool {
    settings.tray_icon_enabled
        && settings.start_with_windows
        && settings.start_hidden
        && std::env::args().any(|a| a == AUTOSTART_ARG)
}

pub fn close_to_tray(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .is_some_and(|s| s.tray_enabled.load(Ordering::Relaxed) && s.close_to_tray.load(Ordering::Relaxed))
}

pub fn minimize_to_tray(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .is_some_and(|s| s.tray_enabled.load(Ordering::Relaxed) && s.minimize_to_tray.load(Ordering::Relaxed))
}

/// Tray click, "Show Tora", a second launch of the app.
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    #[cfg(windows)]
    crate::memory::set_low_memory_target(&window, false);
}

/// Hiding isn't a 0×0 resize, so WebView2's low memory target is set here.
pub fn hide_to_tray(window: &Window) {
    let _ = window.hide();
    #[cfg(windows)]
    if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
        crate::memory::set_low_memory_target(&webview, true);
    }
}

/// "Watching Frieren · Ep 5" in the tooltip and the menu's first line; None = nothing playing.
/// Only touches the tray when the label changes (the media poll calls this every pass).
pub fn set_now_playing(app: &AppHandle, label: Option<String>) {
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    {
        let Ok(mut last) = state.last_label.lock() else {
            return;
        };
        if *last == label {
            return;
        }
        last.clone_from(&label);
    }
    let _ = state.now_playing.set_text(label.as_deref().unwrap_or("Nothing playing"));
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tooltip = match &label {
            Some(label) => format!("Tora — {}", label),
            None => "Tora".to_string(),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

pub fn now_playing_label(title: &str, episode: Option<u32>) -> String {
    match episode {
        Some(ep) => format!("Watching {} · Ep {}", title, ep),
        None => format!("Watching {}", title),
    }
}

/// Tray "Playback detection": flips `recognition_enabled` (the poll reads it on its next pass) and
/// tells the frontend, so a later Settings save doesn't put the old value back.
fn toggle_detection(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let db = state.db.clone();
        let result = db.get_settings().and_then(|mut settings| {
            // Unreadable stored settings: never overwrite them with defaults from here
            if settings.settings_recovered {
                return Err("stored settings are unreadable".to_string());
            }
            settings.recognition_enabled = !settings.recognition_enabled;
            db.save_settings(&settings)?;
            db.get_settings()
        });
        match result {
            Ok(settings) => {
                log::info!(
                    target: "playback",
                    "detection {} from the tray",
                    if settings.recognition_enabled { "on" } else { "off" }
                );
                if let Some(tray) = app.try_state::<TrayState>() {
                    let _ = tray.detection.set_checked(settings.recognition_enabled);
                }
                let _ = app.emit(EVENT_SETTINGS_CHANGED, &settings);
            }
            Err(e) => {
                log::warn!(target: "settings", "tray detection toggle failed: {}", e);
                // Put the check mark back to what is stored
                let stored = db.get_settings().map(|s| s.recognition_enabled).unwrap_or(true);
                if let Some(tray) = app.try_state::<TrayState>() {
                    let _ = tray.detection.set_checked(stored);
                }
            }
        }
    });
}
