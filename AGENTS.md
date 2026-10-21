# AGENTS.md — Tora (虎) Developer & AI Agent Guide

## Project Overview
**Tora (虎)** is a fast, modern desktop anime library manager and episode tracker inspired by **Taiga**, built with **Tauri v2** (Rust backend + native C++23/20 FFI bindings + React 19 / TypeScript / Tailwind CSS v4 frontend).

Core capabilities:
- **Real-time Media Player Detection (`erengy/anisthesia`)**: Native Win32 window/process/UI Automation inspection via direct C++20 FFI bindings.
- **Anime Filename Parsing & Relations (`erengy/anitomy` + `erengy/anime-relations`)**: Direct C++23 FFI bindings to upstream `anitomy` combined with Taiga's `ExtendAnimeTitle`, title normalization, season isolation, fuzzy matching, and sequential episode redirection (`anime-relations.txt`).
- **Multi-Drive Video Library Scanner**: Parallel `walkdir` + `rayon` filesystem indexer with SQLite WAL persistence and O(1) in-memory title/alias matching (`AnimeMatcherIndex`).
- **Internal Tracker Plugin Architecture**: Modular `TrackerPlugin` trait (`src-tauri/src/plugins/mod.rs`) with full **AniList GraphQL v2** integration (`src-tauri/src/plugins/anilist.rs`) and extensible stubs for MyAnimeList and Kitsu.
- **Torrent Search, RSS Rule Engine & qBittorrent WebUI Client**: Live Nyaa.si / AnimeTosho RSS search, Taiga-style episode filter rules (`highlight` / `auto_download` / `discard`), magnet launching, and qBittorrent WebUI API integration.

---

## Tech Stack & Prerequisites
- **OS / Toolchain**: Windows 10/11 with **MSVC Build Tools (Visual Studio 2022)** supporting `/std:c++latest` (C++23) and `/std:c++20`.
- **Frontend**: Node.js + `pnpm`, React 19, TypeScript, Vite 6, Tailwind CSS v4, Lucide icons.
- **Backend**: Rust (Edition 2021), Tauri v2, `rusqlite` (`bundled` SQLite with WAL mode), `reqwest`, `tokio`, `rayon`, `cc` (for C++ FFI compilation).

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
# Run all Rust + C++ FFI unit tests (Anitomy, Anisthesia, Anime Relations, SQLite Fuzzy Matcher)
cargo test --manifest-path src-tauri/Cargo.toml

# Check Rust compilation quickly
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## Repository Structure

```text
Tora/
├── src/                                  # React 19 + TypeScript Frontend
│   ├── App.tsx                           # Main shell, sidebar navigation, live playback polling & scrobble bar
│   ├── api.ts                            # Typed Tauri invoke wrappers (`toraApi`), theme presets & helpers
│   ├── types.ts                          # Shared TypeScript interfaces mirroring Rust structs
│   └── components/
│       ├── AnimeDetailModal.tsx          # Slide-over drawer for editing progress, score, notes, folder & synonyms
│       ├── AnimeQuickMenu.tsx            # Right-click / context menu for anime cards
│       ├── CommandPalette.tsx            # Ctrl+K command palette
│       ├── DiscoverAndScheduleView.tsx   # Remote AniList seasonal browser & airing countdowns
│       ├── LibraryManagerView.tsx        # Multi-drive folder manager, disk usage & local episode matcher
│       ├── RecognitionView.tsx           # Live episode detection, unmatched anime linking prompt & watch history
│       ├── SettingsAndPluginsView.tsx    # Themes, AniList account sync, recognition delay & qBittorrent config
│       ├── TestingView.tsx               # Playback simulator, interactive Anitomy token parser & player registry
│       └── TorrentsView.tsx              # Nyaa/AnimeTosho RSS search & automated torrent rule editor
└── src-tauri/                            # Tauri v2 Rust Backend & Native C++ Bindings
    ├── build.rs                          # Compiles vendored C++ `anitomy` (/std:c++latest) & `anisthesia` (/std:c++20)
    ├── cpp/
    │   ├── tora_ffi.h                    # C ABI header bridging C++ Anitomy & Anisthesia to Rust
    │   └── tora_ffi.cpp                  # C++ implementation calling `anitomy::parse` & `anisthesia::win::GetResults`
    ├── vendor/
    │   ├── anitomy/                      # Upstream `erengy/anitomy` C++23 source
    │   ├── anisthesia/                   # Upstream `erengy/anisthesia` C++20 source + `data/players.anisthesia`
    │   └── anime-relations/              # Upstream `erengy/anime-relations` (`anime-relations.txt`)
    └── src/
        ├── lib.rs                        # Tauri state (`AppState`), async commands, and playback recognition loop
        ├── db/mod.rs                     # SQLite schema, `AnimeMatcherIndex`, season-isolated fuzzy matching & aliases
        ├── detection/
        │   ├── mod.rs                    # `DetectedMediaSession` and `FilenameTestResult` types
        │   ├── anitomy.rs                # Safe Rust wrapper over `tora_anitomy_parse` + Taiga title normalization
        │   ├── anisthesia.rs             # Safe Rust wrapper over `tora_anisthesia_detect_windows` + player registry
        │   └── relations.rs              # Parser & lookup engine for `erengy/anime-relations` sequential episodes
        ├── library/scanner.rs            # Multi-drive parallel video file scanner & batch episode matcher
        ├── plugins/
        │   ├── mod.rs                    # `TrackerPlugin` trait & `PluginManager`
        │   └── anilist.rs                # AniList GraphQL v2 search, user list import & progress mutation
        └── torrents/mod.rs               # Nyaa/AnimeTosho RSS parser, rule evaluator & qBittorrent WebUI client
```

---

## Critical Architectural Rules & Invariants

### 1. Never Block the Tauri Main (UI) Thread
- **All** `@tauri::command` functions in `src-tauri/src/lib.rs` that touch SQLite, filesystem I/O, or Win32 window enumeration **must** be `async fn` and offload synchronous work via `tokio::task::spawn_blocking`.
- On Windows, Tauri runs the Win32 message pump on the main thread; synchronous SQLite locks or Win32 `EnumWindows` / UI Automation calls on the main thread will freeze the UI.
- In React (`src/App.tsx`), background polling (`pollMediaRecognition`) must use an `inFlight` guard so polls never stack up concurrently.

### 2. Native C++ FFI (`anitomy` & `anisthesia`)
- Do **not** rewrite Anitomy or Anisthesia in Rust. Both libraries are compiled directly from `src-tauri/vendor/anitomy` and `src-tauri/vendor/anisthesia` via `src-tauri/build.rs` and exposed through `src-tauri/cpp/tora_ffi.h` / `tora_ffi.cpp`.
- `anitomy` requires `/std:c++latest` (C++23 `std::views::slide`, `std::ranges`), while `anisthesia` is compiled with `/std:c++20` and links against `oleacc.lib` and `uiautomationcore.lib`.

### 3. Episode Recognition, Season Isolation & Fuzzy Matching Pipeline
When a filename or media player window title is parsed (`parse_filename` in `src-tauri/src/detection/anitomy.rs` and `AnimeMatcherIndex` in `src-tauri/src/db/mod.rs`):
1. **C++ Anitomy Tokenization**: Extracts raw `Title`, `Season`, `Episode`, `ReleaseGroup`, `VideoResolution`, etc. Note that Anitomy v2 strips `S02` / `2nd Season` / `Part 2` out of `ElementKind::Title`.
2. **Canonical Season & Title Extension**:
   - `RelationsDatabase::resolve_canonical_season_title` checks `anime-relations.txt` to expand abbreviated titles with explicit seasons (e.g., `[Judas] Kusuriya - S03E03.mkv` $\rightarrow$ `"Kusuriya no Hitorigoto 3rd Season"`).
   - Otherwise, Taiga's `ExtendAnimeTitle` logic appends `Season N` / `Part N` when `season > 1` or `part > 1`.
3. **Sequential Episode Redirection (`erengy/anime-relations`)**:
   - Continuous episode numbers (e.g., `Kusuriya no Hitorigoto - 51` $\rightarrow$ `Kusuriya no Hitorigoto 3rd Season` Episode `3`, or `Shingeki no Kyojin Season 4 - 87` $\rightarrow$ `Final Season Part 2` Episode `12`) are redirected using `RelationsDatabase::find_by_title` and `RelationsDatabase::find_by_id`.
4. **Season-Isolated Matching (`AnimeMatcherIndex::match_title`)**:
   - Checks custom folder prefixes $\rightarrow$ user-linked aliases (`title_aliases`) $\rightarrow$ exact normalized titles $\rightarrow$ season-isolated fuzzy core-title matching (`entry_season == query_season`).
   - **Never** allow a Season 2/3 episode to fall back to a Season 1 library entry.
5. **Unmatched Media Behavior**:
   - If `matched_anime_id` is `None`, **never** auto-update or run the scrobble countdown. Focus the `Episode Detection` tab and prompt the user to link the episode to an anime entry via `link_detected_episode_to_anime` (`Database::link_alias_to_anime`), which persists the relation in `title_aliases` and the anime's `synonyms` for all subsequent episodes.

### 4. Database Performance (`src-tauri/src/db/mod.rs`)
- Use `AnimeMatcherIndex` (`db.build_matcher_index()`) for any batch matching (library scans, torrent RSS evaluation). It loads all titles, synonyms, and aliases in a single SQL query and performs matching in memory in O(1) / microsecond time.
- Single-entry mutations (`update_anime_user_state`) must query only the target `anime_id` (`get_anime_entry_by_id`) and only trigger `rematch_all_local_episodes()` if `custom_folder` or `synonyms` actually changed.
