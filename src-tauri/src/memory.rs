//! Memory of Tora's processes (Settings → Diagnostics) and the WebView2 memory target while minimized.
//!
//! Tora is several processes: `tora.exe` (the core) plus the WebView2 browser, renderer, GPU and
//! utility processes. Task Manager adds them up; this splits them so a regression can be traced to
//! the one that grew. `scripts/mem-snapshot.ps1` reports the same numbers from outside the app.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Serialize)]
pub struct ProcessMemory {
    /// `core`, `browser`, `renderer`, `gpu`, `utility`, `other`
    pub kind: &'static str,
    pub pid: u32,
    /// What Task Manager's "Memory" column shows
    pub private_working_set: u64,
    /// Committed private memory (includes pages swapped out)
    pub private_bytes: u64,
    /// Full working set (includes shared DLL pages)
    pub working_set: u64,
}

/// The WebView2 processes of `window` (pid, kind). Must run on the main thread: call it from
/// `with_webview`.
#[cfg(windows)]
pub fn webview_processes(webview: &tauri::webview::PlatformWebview) -> Vec<(u32, &'static str)> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_core::Interface;
    let list = || -> windows_core::Result<Vec<(u32, &'static str)>> {
        unsafe {
            let infos = webview.environment().cast::<ICoreWebView2Environment8>()?.GetProcessInfos()?;
            let mut count = 0u32;
            infos.Count(&mut count)?;
            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                let info = infos.GetValueAtIndex(i)?;
                let (mut pid, mut kind) = (0i32, COREWEBVIEW2_PROCESS_KIND::default());
                info.ProcessId(&mut pid)?;
                info.Kind(&mut kind)?;
                let kind = match kind {
                    COREWEBVIEW2_PROCESS_KIND_BROWSER => "browser",
                    COREWEBVIEW2_PROCESS_KIND_RENDERER => "renderer",
                    COREWEBVIEW2_PROCESS_KIND_GPU => "gpu",
                    COREWEBVIEW2_PROCESS_KIND_UTILITY => "utility",
                    _ => "other",
                };
                out.push((pid as u32, kind));
            }
            Ok(out)
        }
    };
    list().unwrap_or_else(|e| {
        log::warn!(target: "webview", "listing WebView2 processes failed: {}", e);
        Vec::new()
    })
}

/// Memory counters of one process; None when it is gone or can't be opened.
#[cfg(windows)]
pub fn process_memory(pid: u32, kind: &'static str) -> Option<ProcessMemory> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut counters: PROCESS_MEMORY_COUNTERS_EX2 = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
        let ok = K32GetProcessMemoryInfo(
            handle,
            &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            counters.cb,
        );
        CloseHandle(handle);
        (ok != 0).then(|| ProcessMemory {
            kind,
            pid,
            private_working_set: counters.PrivateWorkingSetSize as u64,
            private_bytes: counters.PrivateUsage as u64,
            working_set: counters.WorkingSetSize as u64,
        })
    }
}

/// Last level applied, so repeated resize events don't call into WebView2 again.
static LOW_TARGET: AtomicBool = AtomicBool::new(false);

/// While the window is minimized WebView2 is asked to use as little memory as it can (it trims
/// caches and the renderer / GPU working sets); back to normal when it is restored.
#[cfg(windows)]
pub fn set_low_memory_target<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, low: bool) {
    if LOW_TARGET.swap(low, Ordering::Relaxed) == low {
        return;
    }
    let result = window.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows_core::Interface;
        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        let apply = || -> windows_core::Result<()> {
            unsafe {
                webview
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_19>()?
                    .SetMemoryUsageTargetLevel(level)
            }
        };
        match apply() {
            Ok(()) => log::debug!(target: "webview", "memory target {}", if low { "low" } else { "normal" }),
            Err(e) => log::warn!(target: "webview", "setting the memory target failed: {}", e),
        }
    });
    if let Err(e) = result {
        log::warn!(target: "webview", "with_webview failed: {}", e);
    }
}
