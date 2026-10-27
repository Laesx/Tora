# AGENTS.md — Tora (虎) Developer & AI Agent Guide

## Project Overview
**Tora (虎)** is a fast, modern desktop anime library manager and episode tracker inspired by **Taiga**, built with **Tauri v2** (Rust backend + native C++23/20 FFI bindings + React 19 / TypeScript / Tailwind CSS v4 frontend).

Core capabilities:
- **Real-time Media Player Detection (`erengy/anisthesia`)**: Native Win32 window, process, and UI Automation inspection via direct C++20 FFI bindings with active playback session tracking, already-seen episode countdown suppression, and automatic scrobbling.
- **Anime Filename Parsing & Relations (`erengy/anitomy` + `erengy/anime-relations`)**: Direct C++23 FFI bindings to upstream `anitomy` combined with Taiga's `ExtendAnimeTitle`, title normalization, season isolation, parent folder fallback for numeric filenames, fuzzy matching, and sequential episode redirection (`anime-relations.txt`).
- **Multi-Drive Video Library Scanner & Native Win32 IOCP Watcher**: Two-tier filesystem scanner (full `scan_all_library_folders` and incremental `quick_scan_library_folders`) paired with a zero-polling native Win32 IOCP `ReadDirectoryChangesW` directory monitor (`LibraryMonitorHandle`, 0.00% idle CPU) that coalesces file bursts (250ms), auto-binds anime subfolders (`custom_folder`), and updates SQLite in microseconds.
- **O(1) In-Memory Title Matcher Index (`AnimeMatcherIndex`)**: High-speed matching engine leveraging SQLite WAL persistence, season-isolated core title fuzzy matching, user-linked aliases (`title_aliases`), and custom folder overrides.
- **Internal Tracker Plugin Architecture**: Modular `TrackerPlugin` trait (`src-tauri/src/plugins/mod.rs`) with full **AniList GraphQL v2** integration (`src-tauri/src/plugins/anilist.rs`), rate limiting, background synchronization, and extensible stubs for MyAnimeList and Kitsu.
- **Torrent Search, RSS Rule Engine & qBittorrent WebUI Client**: Live Nyaa.si / AnimeTosho RSS search, Taiga-style episode filter rules (`highlight` / `auto_download` / `discard`), magnet launching, and qBittorrent WebUI API integration.
- **High-Performance Virtualized UI**: Viewport-windowed virtual lists/grids (`VirtualWatchlist.tsx` for Grid, Compact, and Table modes; virtualized indexed episode explorer in `LibraryManagerView.tsx`), AniList CDN image downscaling (`getOptimizedCoverUrl`), and optimistic debounced episode stepping (+1 button) with sort position preservation.

---

## Tech Stack & Prerequisites
- **OS / Toolchain**: Windows 10/11 with **MSVC Build Tools (Visual Studio 2022)** supporting `/std:c++latest` (C++23) and `/std:c++20`.
- **Frontend**: Node.js + `pnpm`, React 19, TypeScript, Vite 6, Tailwind CSS v4, Lucide icons.
- **Backend**: Rust (Edition 2021), Tauri v2, `rusqlite` (`bundled` SQLite with WAL mode), `reqwest`, `tokio`, `rayon`, `cc` (for C++ FFI compilation), Win32 API (`kernel32` IOCP / directory change notifications, `oleacc.lib`, `uiautomationcore.lib`).

---

## Essential Commands

### Frontend & Full App
```powershell
# Install dependencies
pnpm install

# Type-check and build frontend bundle
pnpm build

# Run Tauri desktop app in development mode
pnpm tauri dev

# Build production Windows installer / binary
pnpm tauri build
```

### Rust Backend & C++ FFI Tests
```powershell
# Run all Rust + C++ FFI unit tests (Anitomy, Anisthesia, Anime Relations, SQLite Matcher, Scanner & Watcher)
cargo test --manifest-path src-tauri/Cargo.toml

# Check Rust compilation quickly
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## Repository Structure

```text
Tora/
├── src/                                  # React 19 + TypeScript Frontend
│   ├── App.tsx                           # Main shell, sidebar navigation, live playback scrobble polling & optimistic stepping
│   ├── api.ts                            # Typed Tauri invoke wrappers (`toraApi`), theme presets & image downscaling helpers
│   ├── types.ts                          # Shared TypeScript interfaces mirroring Rust database and detection models
│   ├── main.tsx                          # React 19 entrypoint & root provider
│   ├── styles/
│   │   └── index.css                     # Tailwind CSS v4 stylesheets, custom theme variables & scrollbars
│   └── components/
│       ├── AnimeDetailModal.tsx          # Slide-over drawer for editing progress, score, notes, custom folder & synonyms
│       ├── AnimeQuickMenu.tsx            # Context menu for anime cards (+1 episode, mark status, open folder, copy title)
│       ├── CommandPalette.tsx            # Ctrl+K fuzzy command palette & global search
│       ├── DiscoverAndScheduleView.tsx   # Remote AniList seasonal anime browser & weekly airing schedule countdowns
│       ├── LibraryManagerView.tsx        # Multi-drive folder manager, disk usage breakdown & virtualized episode table
│       ├── RecognitionView.tsx           # Live player detection, unmatched episode linking prompt & watch history log
│       ├── SettingsAndPluginsView.tsx    # Theme selector, AniList account sync, recognition delay & qBittorrent config
│       ├── TestingView.tsx               # Media player simulator, interactive Anitomy token parser & player registry
│       ├── TorrentsView.tsx              # Nyaa/AnimeTosho RSS search, feed preview & automated torrent rule editor
│       └── VirtualWatchlist.tsx          # Viewport-windowed virtual grid/list for Grid, Compact & Table display modes
└── src-tauri/                            # Tauri v2 Rust Backend & Native C++ Bindings
    ├── Cargo.toml                        # Rust dependencies (rusqlite bundled, tokio, rayon, reqwest, tauri v2)
    ├── build.rs                          # Compiles vendored C++ `anitomy` (/std:c++latest) & `anisthesia` (/std:c++20)
    ├── cpp/
    │   ├── tora_ffi.h                    # C ABI header bridging C++ Anitomy & Anisthesia to Rust
    │   └── tora_ffi.cpp                  # C++ implementation calling `anitomy::parse` & `anisthesia::win::GetResults`
    ├── vendor/
    │   ├── anitomy/                      # Upstream `erengy/anitomy` C++23 source
    │   ├── anisthesia/                   # Upstream `erengy/anisthesia` C++20 source + `data/players.anisthesia`
    │   └── anime-relations/              # Upstream `erengy/anime-relations` (`anime-relations.txt`)
    └── src/
        ├── lib.rs                        # Tauri state (`AppState`), async commands, background monitor & media poll loop
        ├── main.rs                       # Tauri binary entrypoint
        ├── db/mod.rs                     # SQLite schema, `AnimeMatcherIndex`, season-isolated fuzzy matching & aliases
        ├── detection/
        │   ├── mod.rs                    # `DetectedMediaSession` and `FilenameTestResult` types
        │   ├── anitomy.rs                # Safe Rust wrapper over `tora_anitomy_parse` + Taiga title normalization
        │   ├── anisthesia.rs             # Safe Rust wrapper over `tora_anisthesia_detect_windows` + player registry
        │   └── relations.rs              # Parser & lookup engine for `erengy/anime-relations` sequential episodes
        ├── library/
        │   ├── mod.rs                    # Library module declaration
        │   └── scanner.rs                # Fast filesystem scanner, Win32 IOCP directory watcher & batch episode matcher
        ├── plugins/
        │   ├── mod.rs                    # `TrackerPlugin` trait & `PluginManager`
        │   └── anilist.rs                # AniList GraphQL v2 search, user list import & progress mutation
        └── torrents/mod.rs               # Nyaa/AnimeTosho RSS parser, rule evaluator & qBittorrent WebUI client
```

---

## Critical Architectural Rules & Invariants

### 1. Never Block the Tauri Main (UI) Thread
- **All** `@tauri::command` functions in `src-tauri/src/lib.rs` that touch SQLite, filesystem I/O, network requests, or Win32 window enumeration **must** be `async fn` and offload synchronous work via `tokio::task::spawn_blocking`.
- On Windows, Tauri runs the Win32 message pump on the main thread; synchronous SQLite locks or Win32 `EnumWindows` / UI Automation calls on the main thread will freeze the UI.
- In React (`src/App.tsx`), background polling (`pollMediaRecognition`) must use an `inFlight` guard so asynchronous poll calls never stack up concurrently.

### 2. Native C++ FFI (`anitomy` & `anisthesia`)
- Do **not** rewrite Anitomy or Anisthesia in Rust. Both libraries are compiled directly from `src-tauri/vendor/anitomy` and `src-tauri/vendor/anisthesia` via `src-tauri/build.rs` and exposed through `src-tauri/cpp/tora_ffi.h` / `tora_ffi.cpp`.
- `anitomy` requires `/std:c++latest` (C++23 `std::views::slide`, `std::ranges`), while `anisthesia` is compiled with `/std:c++20` and links against `oleacc.lib` and `uiautomationcore.lib`.

### 3. Episode Recognition, Season Isolation & Matching Pipeline
When a filename or media player window title is parsed (`parse_filename` in `src-tauri/src/detection/anitomy.rs` and `AnimeMatcherIndex` in `src-tauri/src/db/mod.rs`):
1. **C++ Anitomy Tokenization**: Extracts raw `Title`, `Season`, `Episode`, `ReleaseGroup`, `VideoResolution`, etc. Note that Anitomy v2 strips `S02` / `2nd Season` / `Part 2` out of `ElementKind::Title`.
2. **Parent Directory Fallback for Weak Titles**:
   - If a video filename contains only numeric digits or generic episode markers (e.g., `Sousou no Frieren\01.mkv`, `special.mp4`, `ep.mkv`), the scanner inspects the parent folder name (`parse_filename(parent_name)`) to recover the true anime title.
3. **Canonical Season & Title Extension**:
   - `RelationsDatabase::resolve_canonical_season_title` checks `anime-relations.txt` to expand abbreviated titles with explicit seasons (e.g., `[Judas] Kusuriya - S03E03.mkv` $\rightarrow$ `"Kusuriya no Hitorigoto 3rd Season"`).
   - Otherwise, Taiga's `ExtendAnimeTitle` logic appends `Season N` / `Part N` when `season > 1` or `part > 1`.
4. **Sequential Episode Redirection (`erengy/anime-relations`)**:
   - Continuous episode numbers (e.g., `Kusuriya no Hitorigoto - 51` $\rightarrow$ `Kusuriya no Hitorigoto 3rd Season` Episode `3`, or `Shingeki no Kyojin Season 4 - 87` $\rightarrow$ `Final Season Part 2` Episode `12`) are redirected using `RelationsDatabase::find_by_title` and `RelationsDatabase::find_by_id`.
5. **Season-Isolated Matching (`AnimeMatcherIndex::match_title` / `match_episode`)**:
   - Priority sequence: Custom folder path prefix $\rightarrow$ user-linked aliases (`title_aliases`) $\rightarrow$ exact normalized titles $\rightarrow$ season-isolated fuzzy core-title matching (`entry_season == query_season`).
   - **Never** allow a Season 2/3 episode to fall back to a Season 1 library entry.
6. **Unmatched Media Behavior**:
   - If `matched_anime_id` is `None`, **never** auto-update or run the scrobble countdown. Focus the `Episode Detection` tab and prompt the user to link the episode to an anime entry via `link_detected_episode_to_anime` (`Database::link_alias_to_anime`), which persists the relation in `title_aliases` and the anime's `synonyms` for all subsequent episodes.

### 4. Zero-Polling Win32 IOCP Directory Monitoring & Incremental Scanning
- **Native Win32 IOCP Monitor (`LibraryMonitorHandle`)**:
  - Monitors all enabled library folders via Win32 `ReadDirectoryChangesW` backed by an I/O Completion Port (`CreateIoCompletionPort`).
  - Worker thread blocks in the Windows kernel with **0.00% idle CPU** (`GetQueuedCompletionStatus`).
  - Coalesces burst file system notifications (250ms debounce) to handle bulk torrent additions, file unpacks, or temporary file renames without stutter.
  - Dynamically reloads watched directory handles on folder add/remove by posting a zero-key completion packet (`PostQueuedCompletionStatus`).
- **Atomic Delta Handling (`Database::handle_directory_change_events`)**:
  - Handles `Added`, `Removed`, and `Renamed` notifications in a single SQLite transaction without full directory rescans.
  - Emits the `library-changed` Tauri event with `ScanSummary` so the frontend updates instantly.
- **Subfolder Auto-Binding**:
  - When episodes are scanned inside a dedicated anime subfolder, the scanner automatically populates `anime_entries.custom_folder` if it is currently unset, giving future files in that folder instant O(1) matching.
  - Folder renames in Windows Explorer automatically update `anime_entries.custom_folder`.
- **System and Hidden File Filtering**:
  - The scanner filters out Windows hidden and system files/directories (`FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM`) such as `$RECYCLE.BIN`, `.git`, or hidden OS thumbnails.

### 5. Playback Recognition, Scrobbling & Optimistic Stepping
- **Already-Seen Episode Suppression**:
  - The scrobbler countdown timer (`elapsed_seconds`) **only** advances if the detected episode is strictly greater than the user's current progress (`detected_ep > user_progress`).
  - If a user rewinds or rewatches an episode (`detected_ep <= user_progress`), `elapsed_seconds` stays reset to `0` and auto-scrobbling is suppressed to prevent accidental regressions or redundant notifications.
- **Auto-Sync Progression**:
  - Once `elapsed_seconds >= settings.recognition_delay_seconds`:
    - If `new_progress >= total_episodes`, the status automatically transitions to `COMPLETED`.
    - If the entry was in `PLANNING`, it transitions to `CURRENT`.
    - The watch history entry is recorded and AniList is notified if auto-sync is enabled.
- **Optimistic Episode Stepping (+1 Button) with Debounce**:
  - In React (`handleStepEpisode` in `src/App.tsx`), clicking `+1` on an anime card applies an instant 0ms optimistic UI update to the badge count.
  - Card sorting position in the watchlist is locked using `pendingStepSnapshots` during rapid successive clicks to prevent jarring layout jumps.
  - A debounce timer coalesces repeated clicks, persisting the final state to SQLite and AniList once clicking stops.
  - Active recognition session state (`active_session.matched_current_progress`) is kept in immediate sync when an entry is updated.

### 6. Database Performance & In-Memory Matching (`src-tauri/src/db/mod.rs`)
- Use `AnimeMatcherIndex` (`db.build_matcher_index()`) for any batch matching (library scans, torrent RSS evaluation). It loads all titles, synonyms, and aliases in a single SQL query and performs matching in memory in O(1) / microsecond time.
- Single-entry mutations (`update_anime_user_state`) must query only the target `anime_id` (`get_anime_entry_by_id`) and only trigger `rematch_all_local_episodes()` if `custom_folder` or `synonyms` actually changed.
- Adding anime (`add_or_upsert_anime`) must never block on `rematch_all_local_episodes()`. Instead, run targeted background matching for unmatched episodes via `match_unmatched_episodes_for_anime(anime_id)` and provide instant 0ms optimistic UI updates in React.
- **SQLite Page Cache & WAL**:
  - Keep `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, and `PRAGMA cache_size = -4000` (4 MB) in `Database::open` to minimize native memory consumption while providing high concurrent read performance.

### 7. Memory Footprint & DOM Virtualization
- **DOM Virtualization**:
  - Large lists (`VirtualWatchlist.tsx` for the Anime Watchlist across `"grid"`, `"compact"`, and `"table"` modes, and the Indexed Local Episodes table in `LibraryManagerView.tsx`) must remain virtualized so WebView2 only mounts visible rows (+ overscan) and releases decoded cover image bitmaps for off-screen rows.
- **Cover Image Resolution (`getOptimizedCoverUrl`)**:
  - **Never** use AniList `/cover/extraLarge/` URLs (up to 6 MB RGBA per decoded bitmap) in lists, cards, or grids.
  - Use `getOptimizedCoverUrl(url, "medium")` (230x325, ~299 KB) for small thumbnails (`w-7` to `w-24`, table rows, compact cards, search selectors).
  - Use `getOptimizedCoverUrl(url, "large")` (460x650, ~1.19 MB) for poster cards and the detail drawer.
