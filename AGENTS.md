# AGENTS.md — Tora (虎) Developer & AI Agent Guide

## Project Overview
**Tora (虎)** is a fast, modern desktop anime library manager and episode tracker inspired by **Taiga**, built with **Tauri v2** (Rust backend + native C++23/20 FFI bindings + React 19 / TypeScript / Tailwind CSS v4 frontend).

Core capabilities:
- **Real-time Media Player Detection (`erengy/anisthesia`)**: Native Win32 window, process, and UI Automation inspection via direct C++20 FFI bindings with active playback session tracking, already-seen episode countdown suppression, and automatic scrobbling.
- **Anime Filename Parsing & Relations (`erengy/anitomy` + `erengy/anime-relations`)**: Direct C++23 FFI bindings to upstream `anitomy` combined with Taiga's `ExtendAnimeTitle`, title normalization, season isolation, parent folder fallback for numeric filenames, fuzzy matching, and sequential episode redirection (`anime-relations.txt`).
- **Multi-Drive Video Library Scanner & Native Win32 IOCP Watcher**: Two-tier filesystem scanner (full `scan_all_library_folders` and incremental `quick_scan_library_folders`) paired with a zero-polling native Win32 IOCP `ReadDirectoryChangesW` directory monitor (`LibraryMonitorHandle`, 0.00% idle CPU) that coalesces file bursts (250ms), auto-binds anime subfolders (`custom_folder`), and updates SQLite in microseconds.
- **O(1) In-Memory Title Matcher Index (`AnimeMatcherIndex`)**: High-speed matching engine leveraging SQLite WAL persistence, season-isolated core title fuzzy matching, user-linked aliases (`title_aliases`), and custom folder overrides.
- **Internal Tracker Plugin Architecture**: Modular `TrackerPlugin` trait (`src-tauri/src/plugins/mod.rs`) with full **AniList GraphQL v2** integration (`src-tauri/src/plugins/anilist.rs`), typed `TrackerError`s, and extensible stubs for MyAnimeList and Kitsu.
- **Unified Tracker Sync Service (`TrackerSyncService`)**: Single pipeline (`src-tauri/src/sync/mod.rs`) for every list mutation and every AniList sync — validation, status/date derivation, SQLite writes, retry queue (`sync_pending` + deletion tombstones), rate limiting, newest-wins pull merge, and error events.
- **Torrents (Nyaa feeds, priority & filters, Taiga-style client launch)**: User-defined RSS feeds from any site (Nyaa, SubsPlease, …) plus `%title%` search feeds, cached in RAM (manual Refresh + background interval), one card per anime with auto-selected releases (global release-priority tiers, strict per-anime fansub overrides, Hide/Select filters in a text query language with a form editor), and downloads handed to the user's torrent app on the command line (qBittorrent `--save-path` / `--skip-dialog`, like Taiga) into per-anime folders.
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
├── src/                                  # React 19 + TypeScript Frontend (import with the `@/` alias = `src/`; same-folder files with `./`)
│   ├── main.tsx                          # React 19 entrypoint & root provider
│   ├── App.tsx                           # Wiring only: app state hooks, context providers, tab switch, drawer / palette / modals
│   ├── app/                              # App shell and app-wide state
│   │   ├── nav.ts                        # `NavTab`, `NAV_ITEMS` (the 8 tabs: sidebar rows, Ctrl+1–8, palette "Go to"), `SETTINGS_SHORTCUT_DIGIT` (Settings is a modal, not a tab)
│   │   ├── Sidebar.tsx                   # Brand, Ctrl+K + shortcuts + Settings (modal) buttons, tab navigation (Ctrl+N badges while Ctrl is held), AniList account card
│   │   ├── NowPlayingBanner.tsx          # Live playback strip above every tab except Now Playing
│   │   ├── SignOutModal.tsx              # Sign-out confirmation
│   │   ├── shortcuts.ts                  # `SHORTCUT_GROUPS`: every shortcut shown in the sheet (keep in step with the handlers)
│   │   ├── ShortcutsModal.tsx            # Keyboard shortcuts sheet (?, sidebar keyboard button, palette command)
│   │   ├── useModifierHint.ts            # Ctrl / Alt held alone ~400 ms → key badges (sidebar Ctrl+1–9, watchlist Alt+1–6 / Q W E)
│   │   ├── Toast.tsx                     # `useToastState` (stable `showToast`) + toast view
│   │   ├── ErrorBoundary.tsx             # Render errors show a panel (Try again / Reload) and are logged; wraps the root and each tab
│   │   ├── useBrowserGuards.ts           # No native right-click menu (except text fields), Ctrl+J/F/P/R… panels, Alt+←/→ or mouse back/forward
│   │   ├── useAppUpdater.ts              # App updates (`plugin-updater` check / install / relaunch), sidebar version dot (`tora.update.seenChangelog`)
│   │   ├── UpdatePromptModal.tsx         # "New version available" prompt (release notes, Later, Update & restart)
│   │   ├── ChangelogModal.tsx            # Changelog from GitHub releases (+ Update button), `ReleaseNotesHtml`, `compareVersions`
│   │   ├── useAnimeList.ts               # The list + drawer / selection / quick-menu state; `setList`, `replaceEntries`, `applyDelta`, `refreshEntries`, list mutations
│   │   ├── useEpisodeStepper.ts          # Optimistic debounced +1 / -1 (`stepEpisode`, position-locking `snapshots`)
│   │   ├── useTrackerSync.ts             # AniList pull state (spinner, last synced, manual sync) + sync event handlers
│   │   ├── useMediaPoll.ts               # 2.5 s player recognition poll (`inFlight` guard), new-session / scrobbled callbacks
│   │   ├── useAppEvents.ts               # Registers every Tauri listener before the initial load
│   │   ├── useCustomListsState.ts        # AniList custom lists state, membership maps, counts, `CustomListsContext` value
│   │   ├── useGlobalShortcuts.ts         # F5, F11 fullscreen, Ctrl+K, Ctrl+1–8 tabs / Ctrl+9 Settings, ?, watchlist type-to-search / arrows / Enter / Ctrl+A / Alt+1–6 status tabs / Alt+Q W E views, layered Escape
│   │   └── paletteCommands.ts            # Ctrl+K Commands tab entries
│   ├── contexts/                         # React contexts (provided by App)
│   │   ├── toast.ts                      # `useToast()`; never pass `showToast` as a prop
│   │   ├── animeActions.ts               # `useAnimeActions()`: open drawer, step, batch update / delete, change status, add, search torrents, open a season; never drill these as props
│   │   ├── customLists.ts                # AniList custom lists context (`useCustomLists`), optimistic membership edit, coverage helper
│   │   └── titles.ts                     # Display title language (`useAnimeTitle`, `altTitles`, `displayTitle` for plain helpers)
│   ├── hooks/                            # Generic hooks
│   │   ├── virtual.ts                    # `useScrollViewport` (list width / top / scroll / viewport height) + `visibleRange` (binary search)
│   │   ├── useNow.ts                     # Unix-seconds tick for relative labels ("3 days ago")
│   │   └── usePrefs.ts                   # Per-device view prefs in localStorage (guarded, laid over defaults)
│   ├── lib/                              # Plain helpers, no React state
│   │   ├── api.ts                        # Typed Tauri invoke wrappers (`toraApi`); every failure is logged (command name only)
│   │   ├── log.ts                        # `log.error/warn/info/debug(scope, msg, cause?)`, `logError`, global error / rejection logging
│   │   ├── types.ts                      # Shared TypeScript interfaces mirroring Rust database and detection models
│   │   ├── theme.ts                      # Theme presets, accent swatches, `applyThemeToDocument`, progress-strip color
│   │   ├── format.ts                     # Bytes, countdowns, "last synced", `plural`
│   │   ├── covers.ts                     # `getOptimizedCoverUrl` (AniList CDN downscaling)
│   │   ├── status.ts                     # List status labels / icons / colors (`LIST_STATUSES`, `STATUS_INFO`, `statusLabel`, watchlist tabs, search group order)
│   │   ├── anime.ts                      # AniList links, play / open-folder, date & enum formatting
│   │   ├── episodes.ts                   # Episode ranges, aired / estimated totals, progress bar model
│   │   ├── seasons.ts                    # Season helpers (current season, shift, labels; broadcast quarters)
│   │   ├── fuzzy.ts                      # Shared fuzzy search (normalized index, char-mask prefilter, subsequence scoring, match ranges)
│   │   └── torrents.ts                   # Anime-level torrent search (`torrentSearchFor`, season-suffix stripping), query field metadata, row → query text
│   ├── components/                       # Shared UI used by several features
│   │   ├── AnimeQuickMenu.tsx            # Context menu for anime cards (+1 episode, mark status, open folder, copy title)
│   │   ├── SeasonAnimeMenu.tsx           # Right-click menu for remote anime posters (Seasons, Schedule)
│   │   ├── FloatingQuickMenu.tsx         # Viewport-clamped portal for right-click quick menus (dashboard, schedule)
│   │   ├── AnimePosterCard.tsx           # Poster card for remote anime (Seasons / Search): opens drawer, quick-add
│   │   ├── CustomListsPanel.tsx          # Custom-list membership toggles + "hide from status lists" (quick menu rows / drawer chips)
│   │   ├── EpisodeProgressBar.tsx        # Taiga-style progress bar with on-disk strip (ready / missing episodes in its tooltip)
│   │   ├── ProgressStepper.tsx           # −1 / +1 `StepButton`s and the bar flanked by them (watchlist table, detailed cards; grid overlays them on the bar)
│   │   ├── KeyHint.tsx                   # Key badge shown while a modifier is held (`useModifierHint`)
│   │   ├── AiringDot.tsx                 # Airing status dot with next-episode countdown
│   │   └── UpdateCountdown.tsx           # Seconds until the playback auto update (from `update_due_at`, local clock)
│   ├── features/                         # One folder per tab / surface
│   │   ├── watchlist/
│   │   │   ├── WatchlistView.tsx         # Sticky toolbar (status tabs, custom-list chip, search, sort + direction, sync, view mode; Alt key badges) + the list
│   │   │   ├── useWatchlist.ts           # Filter state, sort prefs (`tora.watchlist.prefs`), `searchIndex`, status counts, search groups, `filteredAnime`, `focusAnime`
│   │   │   ├── sort.ts                   # `SORT_OPTIONS` (grouped keys, natural direction, unknown values last) + `watchlistComparator`
│   │   │   ├── VirtualWatchlist.tsx      # Viewport-windowed virtual grid/list for Grid, Compact & Table modes (row model with optional status group headers, scroll-to-anime, arrow-key `navRef`, last-updated labels)
│   │   │   ├── tableColumns.ts           # Table columns (`TABLE_COLUMNS`), per-device widths / hidden columns (`useTableColumns`, `tora.watchlist.columns`)
│   │   │   ├── CustomListsChip.tsx       # Single "Lists ▾" chip at the end of the status ribbon (filterable popover of custom lists, "New list…" row, per-list delete)
│   │   │   ├── NewCustomListModal.tsx    # Name prompt for creating an AniList custom list
│   │   │   └── DeleteCustomListModal.tsx # Confirmation before deleting an AniList custom list
│   │   ├── detail/AnimeDetailModal.tsx   # Slide-over drawer for editing progress, score, notes, custom folder & synonyms
│   │   ├── palette/
│   │   │   ├── CommandPalette.tsx        # Ctrl+K keyboard palette: Anime / Commands tabs, recents, AniList row, Right-arrow anime actions
│   │   │   └── animeActions.ts           # Keyboard action list for one anime (palette → Right arrow)
│   │   ├── nowplaying/
│   │   │   ├── NowPlayingView.tsx        # Now Playing tab: hero while playing, dashboard when idle
│   │   │   ├── NowPlayingHero.tsx        # Playing anime hero (cover → AniList, metadata, studios/genres/tags links, episodes, link prompt)
│   │   │   └── NowPlayingDashboard.tsx   # Idle: watch stats, continue watching (next ep on disk), recently started/finished airing
│   │   ├── seasons/SeasonsView.tsx       # Cached seasonal browser (chips, ‹ ›, picker, sort/group/format filters, virtualized grid)
│   │   ├── schedule/
│   │   │   ├── ScheduleView.tsx          # Weekly airing timetable (columns / agenda layouts, countdowns, my list / all anime, format/country/status filters, inferred breaks, "next episode ready" play, right-click add)
│   │   │   └── schedule.ts               # Airing schedule helpers (Mon–Sun local weeks, bounds, day/time labels, country labels, `detectBreaks`)
│   │   ├── search/SearchView.tsx         # Global AniList search (Enter in the Seasons filter lands here)
│   │   ├── history/HistoryView.tsx       # History tab: scrobbles + manual progress changes (decreases as correction rows), grouped by day
│   │   ├── stats/StatsView.tsx           # Stats tab: overview tiles, status bar, activity heatmap/streaks/monthly bars, backlog & ready-to-watch
│   │   ├── settings/
│   │   │   ├── SettingsModal.tsx         # Settings is a modal, not a tab (gear button, Ctrl+9, palette, `openSettings(section)`)
│   │   │   ├── SettingsView.tsx          # Sectioned settings: Appearance, Tracker, Library, Playback & Detection (update mode, Discord, Anisthesia players), Torrents, Diagnostics, About
│   │   │   ├── LibraryManagerView.tsx    # Multi-drive folder manager, disk usage & virtualized episode table (Settings → Library)
│   │   │   ├── AnitomyParserPanel.tsx    # Interactive Anitomy filename / window title parser (Settings → Diagnostics)
│   │   │   └── SettingsBackups.tsx       # Settings → About: settings snapshots list, Back up now, Restore
│   │   └── torrents/
│   │       ├── TorrentsView.tsx          # Torrents tab: Releases (feed chips, search, anime cards, Download selected) | Feeds | Filters & priority; gear → Settings → Torrents
│   │       ├── ReleaseCard.tsx           # One anime's releases (checkbox rows, traits badges, "Other releases" for outside-tier ones)
│   │       ├── ReleaseMenu.tsx           # Release right-click menu (download, copy, fansub pin, top priority, hide group, filter from release)
│   │       ├── FeedsPanel.tsx            # General feeds (any RSS URL) and search feeds (`%title%` templates): drag-to-reorder, browser-style URLs, "Build Nyaa URL" helper
│   │       ├── FiltersPanel.tsx          # Release priority tiers, fansubs per anime, Hide / Select filters
│   │       ├── FilterEditor.tsx          # One query as condition rows or text (same string)
│   │       ├── AnimePicker.tsx           # Fuzzy list-entry picker (fansub overrides, filter scope)
│   │       └── TorrentSettings.tsx       # Settings → Torrents: app (detected / chosen), category, download folder, refresh, auto-download
│   ├── assets/
│   │   └── tora-mark.svg                 # Brand mark (sidebar); same art as the app icon (`design/icons/tora-mark.svg` → `src-tauri/icons`)
│   └── styles/
│       └── index.css                     # Tailwind CSS v4 stylesheets, custom theme variables & scrollbars
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
        ├── data_migration.rs             # Moves data from the old `app.tora.anime` identifier's folders (runs in `run()` before the builder)
        ├── logging.rs                    # `tauri-plugin-log` setup (`%APPDATA%\Tora\logs\tora.log`, rotated), panic hook, log tail
        ├── lib.rs                        # Tauri state (`AppState`), async commands, background monitor & media poll loop, WebView2 accelerator keys off (release)
        ├── discord.rs                    # Discord Rich Presence worker thread ("Watching <anime>", cover, episode, AniList + GitHub buttons)
        ├── main.rs                       # Tauri binary entrypoint
        ├── db/mod.rs                     # SQLite schema, `AnimeMatcherIndex`, season-isolated fuzzy matching & aliases
        ├── db/settings.rs                # Lenient `get_settings`, JSON config keys, rolling settings backups & restore
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
        │   └── anilist.rs                # AniList GraphQL v2 search, user list fetch, save & delete mutations
        ├── sync/mod.rs                   # `TrackerSyncService`: unified push/pull/delete pipeline, `normalize_change`, rate limiter
        ├── updates.rs                    # anime-relations download + hot-swap (cached in app data), GitHub releases changelog
        └── torrents/
            ├── mod.rs                    # `TorrentCache` (RAM feeds + session sent set), `get_board`, `download_releases`, refresh loop
            ├── config.rs                 # Feeds / filters / priority tiers / fansub overrides (app_settings JSON keys), legacy rule conversion
            ├── feed.rs                   # Generic RSS 2.0 fetch & parse (`RawRelease`, Anitomy once per item), hash normalization, `%title%` search URLs
            ├── traits.rs                 # Codec / bit depth / audio / source / resolution / batch range from Anitomy + title
            ├── query.rs                  # Torrent query language: tokenizer, parser, canonical text, evaluation (`ReleaseFacts`)
            ├── board.rs                  # Matching + selection pipeline → `TorrentBoard` of `AnimeReleaseCard`s
            └── client.rs                 # Torrent app detection, per-client args (Taiga table), .torrent download, save-folder resolution, launch
```

---

## Critical Architectural Rules & Invariants

### 1. Never Block the Tauri Main (UI) Thread
- **All** `@tauri::command` functions in `src-tauri/src/lib.rs` that touch SQLite, filesystem I/O, network requests, or Win32 window enumeration **must** be `async fn` and offload synchronous work via `tokio::task::spawn_blocking`.
- On Windows, Tauri runs the Win32 message pump on the main thread; synchronous SQLite locks or Win32 `EnumWindows` / UI Automation calls on the main thread will freeze the UI.
- In React (`src/app/useMediaPoll.ts`), background polling (`pollMediaRecognition`) must use an `inFlight` guard so asynchronous poll calls never stack up concurrently.

### 1a. App Identifier & Data Folders
- The identifier is `Tora` (`tauri.conf.json`); Tauri derives `%APPDATA%\Tora` (SQLite library, backups, cached relations, .torrent files, logs) and `%LOCALAPPDATA%\Tora` (WebView2 profile) from it. `%LOCALAPPDATA%\Tora` is also the NSIS per-user install folder, so the WebView2 profile sits next to `tora.exe`.
- Before v0.3.0 the identifier was `app.tora.anime`. `data_migration::migrate_legacy_data_dirs` moves those folders' contents on startup, in `run()` before the builder (Tauri creates the main window, and its WebView2 profile, before `setup`). It never overwrites, and the database moves with its `-wal` / `-shm` files only when the new folder has none. Changing the identifier again needs the same kind of migration.

### 1b. Settings Must Never Silently Reset
- `Database::get_settings` (`db/settings.rs`) lays the stored JSON over `AppSettings::default()` field by field: a missing or invalid field keeps only its own default. Unreadable JSON leaves the row untouched and returns defaults with `settings_recovered: true` (the frontend offers a restore). Still give every new `AppSettings` field a `#[serde(default…)]`.
- Renamed fields go in `RENAMED_FIELDS` (old key → new key) so the old value carries over.
- Rolling snapshots of `main` + the torrent config keys live in `app_data\backups\settings-*.json` (startup, then at most hourly on change, newest 20). A restore snapshots first and keeps the current AniList account fields. Add any new user-config `app_settings` key to `BACKED_UP_KEYS`.

### 2. Native C++ FFI (`anitomy` & `anisthesia`)
- Do **not** rewrite Anitomy or Anisthesia in Rust. Both libraries are compiled directly from `src-tauri/vendor/anitomy` and `src-tauri/vendor/anisthesia` via `src-tauri/build.rs` and exposed through `src-tauri/cpp/tora_ffi.h` / `tora_ffi.cpp`.
- `anitomy` requires `/std:c++latest` (C++23 `std::views::slide`, `std::ranges`), while `anisthesia` is compiled with `/std:c++20` and links against `oleacc.lib` and `uiautomationcore.lib`.

### 3. Episode Recognition, Season Isolation & Matching Pipeline
When a filename or media player window title is parsed (`parse_filename` in `src-tauri/src/detection/anitomy.rs` and `AnimeMatcherIndex` in `src-tauri/src/db/mod.rs`):
1. **C++ Anitomy Tokenization**: Extracts raw `Title`, `Season`, `Episode`, `ReleaseGroup`, `VideoResolution`, etc. Note that Anitomy v2 strips `S02` / `2nd Season` / `Part 2` out of `ElementKind::Title`.
2. **Parent Directory Fallback for Weak Titles**:
   - If a video filename contains only numeric digits or generic episode markers (e.g., `Houseki no Kuni\01.mkv`, `special.mp4`, `ep.mkv`), the scanner inspects the parent folder name (`parse_filename(parent_name)`) to recover the true anime title.
3. **Canonical Season & Title Extension**:
   - `RelationsDatabase::resolve_canonical_season_title` checks `anime-relations.txt` to expand abbreviated titles with explicit seasons (e.g., `[Judas] Kusuriya - S03E03.mkv` $\rightarrow$ `"Kusuriya no Hitorigoto 3rd Season"`).
   - Otherwise, Taiga's `ExtendAnimeTitle` logic appends `Season N` / `Part N` when `season > 1` or `part > 1`.
4. **Sequential Episode Redirection (`erengy/anime-relations`)**:
   - Continuous episode numbers (e.g., `Kusuriya no Hitorigoto - 51` $\rightarrow$ `Kusuriya no Hitorigoto 3rd Season` Episode `3`, or `Shingeki no Kyojin Season 4 - 87` $\rightarrow$ `Final Season Part 2` Episode `12`) are redirected using `RelationsDatabase::find_by_title` and `RelationsDatabase::find_by_id`.
5. **Season-Isolated Matching (`AnimeMatcherIndex::match_title` / `match_episode`)**:
   - Priority sequence: Custom folder path prefix $\rightarrow$ user-linked aliases (`title_aliases`) $\rightarrow$ exact normalized titles $\rightarrow$ season-isolated fuzzy core-title matching (`entry_season == query_season`).
   - **Never** allow a Season 2/3 episode to fall back to a Season 1 library entry.
6. **Unmatched Media Behavior**:
   - If `matched_anime_id` is `None`, **never** auto-update or run the scrobble countdown. Focus the `Now Playing` tab and prompt the user to link the episode to an anime entry via `link_detected_episode_to_anime` (`Database::link_alias_to_anime`), which persists the relation in `title_aliases` and the anime's `synonyms` / `custom_synonyms` for all subsequent episodes.

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
- **Update mode** (`AppSettings.update_mode`, Settings → Playback): `auto` (default) counts down, then updates; `manual` never counts down: Now Playing opens as usual and the hero / banner offer "Update to episode N" (`awaiting_confirmation` → `confirm_playback_update`). The per-poll decision is the pure, unit-tested `DetectedMediaSession::advance_update` (`detection/anisthesia.rs`).
  - `update_wait_for_close` (auto only): when the countdown ends the update is held (`waiting_for_close`) and runs in `end_session` once the player closes or plays another file, emitting `playback-scrobbled` (the session is already gone).
  - The countdown is a pausable deadline: `update_due_at` (unix second the update fires) is set when it starts and only moves on pause / resume; while paused, `update_remaining_seconds` holds what's left. The UI (`components/UpdateCountdown.tsx`) ticks `update_due_at - now` from its own clock (`useNow`); the poll never drives the display.
  - `update_require_focus` (auto only): the deadline pauses on a poll where the player's process doesn't own the foreground window (`foreground_process_id`) and resumes at `now + remaining` once it does.
  - Closing the player (or playing another file) ends the session in every mode; a manual offer that wasn't used is dropped with it.
  - Default delay: `recognition_delay_seconds` = 120 (saved settings keep their value).
- **Discord Rich Presence** (`discord.rs`, `discord_presence_enabled`, default on): `poll_media_recognition` sends the matched, open session (or None) to `DiscordPresence` every poll; its worker thread owns the IPC pipe, skips unchanged presences, reconnects after 15 s. The anime's display data is cached per (id, title language). Never call Discord IPC from a command or the async runtime.
- **Auto-Sync Progression**:
  - Once `elapsed_seconds >= settings.recognition_delay_seconds` (auto mode; held while waiting for the player to close):
    - If `new_progress >= total_episodes`, the status automatically transitions to `COMPLETED`.
    - If the entry was in `PLANNING`, it transitions to `CURRENT`.
    - The watch history entry is recorded (`scrobbled_to_tracker = false`) and the change goes through `TrackerSyncService::apply_local_update_with_history`, which pushes to AniList and marks the history row scrobbled only after the push succeeds.
    - The `active_session` lock is only held to decide; it is released before any DB write or `.await`.
- **Optimistic Episode Stepping (+1 Button) with Debounce**:
  - In React (`stepEpisode` in `src/app/useEpisodeStepper.ts`, reached through `useAnimeActions()`), clicking `+` / `−` next to an anime's progress bar (`components/ProgressStepper.tsx`) applies an instant 0ms optimistic UI update to the badge count.
  - Card sorting position in the watchlist is locked using the stepper's `snapshots` during rapid successive clicks to prevent jarring layout jumps.
  - A debounce timer coalesces repeated clicks, persisting the final state to SQLite and AniList once clicking stops.
  - Active recognition session state (`active_session.matched_current_progress`) is kept in immediate sync when an entry is updated.

### 5b. The Webview Is Not a Browser
- Release builds turn off WebView2 browser accelerator keys (`disable_browser_accelerator_keys` in `lib.rs` setup: Ctrl+J downloads, Ctrl+F / P / R / U, zoom, DevTools); keys still reach the page. Debug builds keep them for DevTools.
- `useBrowserGuards` blocks the native context menu outside text fields, the same Ctrl shortcuts (dev builds), Alt+← / → and mouse back / forward. Custom right-click menus use React `onContextMenu` as before.
- F11 toggles fullscreen (`useGlobalShortcuts`, `core:window:allow-set-fullscreen`).

### 6. Database Performance & In-Memory Matching (`src-tauri/src/db/mod.rs`)
- Use the cached `AnimeMatcherIndex` (`db.matcher_index()`) for any matching (library scans, torrent RSS evaluation, playback recognition). It is built from the stored `normalized_titles_json` (keep that column correct on every title/synonym write) and cached until `matcher_generation` changes; an SQLite `update_hook` bumps the generation on any write to `anime_entries` or `title_aliases`, so writers never invalidate manually. Do not call the uncached `build_matcher_index()` in hot paths. The recognition poll only re-matches an unmatched session when the generation changed.
- **Fuzzy matching cost**: `NormTitle.core` is a `PreparedTitle` (sorted `u16` bigrams, word ranges + bigrams, a 64-bit bigram mask) and titles are bucketed by season (`norms_by_season`), so `core_title_similarity` never allocates: mask counts rule steps out with exact bounds, dice is a sorted merge. Scores must stay bit-identical to the reference in `merge_dice_equals_reference`; time changes with `cargo test --release fuzzy_bench -- --ignored --nocapture` (its checksum must not change).
- UI read paths (`list_anime_entries`, `get_anime_entry_by_id`, `get_anime_entries_by_ids`, `list_local_episodes`, `get_settings`) use the query-only `Database::reader()` connection so they don't queue behind writes; never call a write method while holding it.
- **Aliases**: `synonyms_json` is the matchable union (AniList synonyms + the user's own); `custom_synonyms_json` holds only the user's own aliases (`AnimeEntry.custom_synonyms`), the only ones shown and edited in the drawer. `UserStateChange.synonyms` / `ResolvedState.synonyms` replace the *custom* list (`replace_custom_synonyms` rebuilds the union). NULL `custom_synonyms_json` marks a legacy row: the next pull splits it once (`backfill_custom_synonyms`: stored − remote).
- Single-entry mutations (`update_anime_user_state`) must query only the target `anime_id` (`get_anime_entry_by_id`) and only trigger `rematch_all_local_episodes()` if `custom_folder` or `synonyms` actually changed.
- Adding anime (`add_or_upsert_anime` → `TrackerSyncService::add_entry`) must never block on `rematch_all_local_episodes()`. Instead, run targeted background matching for unmatched episodes via `match_unmatched_episodes_for_anime(anime_id)` and provide instant 0ms optimistic UI updates in React.
- **SQLite Page Cache & WAL**:
  - Keep `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, and `PRAGMA cache_size = -4000` (4 MB) in `Database::open` to minimize native memory consumption while providing high concurrent read performance.

### 6b. Frontend List Updates Are Deltas
- The full list (`get_anime_list`) crosses IPC only at startup and after rare manual actions (link a detected episode, Settings → Library actions, Torrents downloads that bind folders); pulls already arrive as `SyncSummary` deltas. Everything else applies a delta through `useAnimeList`: `replaceEntries` (known ids only), `applyDelta(changed, removedIds)`, or `refreshEntries(ids)` (`get_anime_entries`).
- `add_or_upsert_anime` returns the one stored entry; `delete_anime_entry` / `batch_delete_anime_entries` return nothing. `ScanSummary.changed_anime_ids` lists the entries whose files or folder a scan / watcher batch / background matching changed, and the frontend refetches only those. Keep it complete when touching the scanner (owners before and after a change).
- UI-only computation over data already in memory (fuzzy search, filtering, sorting, local-day stats bucketing) stays in TypeScript: it is cheap, synchronous where it must be (palette Enter), and needs the local timezone.

### 7. Memory Footprint & DOM Virtualization
- **Title language**: `AppSettings.title_language` (`romaji` | `english` | `native`, serde default `romaji`; missing titles fall back to Romaji). Show titles with `useAnimeTitle()` (or `displayTitle` in plain helpers), never `title_romaji` directly. Torrent search queries always use `title_romaji`.
- **DOM Virtualization**:
  - Large lists (`VirtualWatchlist.tsx` for the Anime Watchlist across `"grid"`, `"compact"`, and `"table"` modes, and the Indexed Local Episodes table in `LibraryManagerView.tsx`) must remain virtualized so WebView2 only mounts visible rows (+ overscan) and releases decoded cover image bitmaps for off-screen rows.
  - Every virtualized row must be exactly the height the row model says: no wrapping text, no borders (separators are inset shadows), and the list element carries `[overflow-anchor:none]`. Otherwise Chromium scroll anchoring and the re-measure in `useScrollViewport` feed each other and the page locks up.
  - Table mode uses `table-fixed` with a `<colgroup>` from `useTableColumns` (`tableColumns.ts`): column widths never depend on the mounted rows. Title takes the remaining width and can't be hidden, so the columns after it are anchored to the right edge: each header boundary (Title|Type included) is dragged by resizing the column on its **right** (`startResize`, capped so the title keeps its minimum; double-click resets). Right-clicking the header shows or hides columns. The header is sticky under the toolbar, so the table's wrapper is `overflow-clip` (never a scroll container) and scroll-into-view accounts for the `thead` height. The Season cell opens that season in the Seasons tab. Widths and hidden columns are per-device prefs (`tora.watchlist.columns`), not `AppSettings`.
  - `VirtualWatchlist` virtualizes a row model (optional group header rows + rows of `cols` cards with prefix-sum offsets, `visibleRange` binary search for the first visible row); search results grouped by status go through the same path. Lists scrolling inside `<main>` measure with `useScrollViewport` (`src/hooks/virtual.ts`).
- **Search (`src/lib/fuzzy.ts`)**:
  - The watchlist search and the command palette both use `searchAnime` over the one `searchIndex` built in `useWatchlist` (`buildAnimeSearchIndex`, rebuilt only when `animeList` changes). Don't add another filter path: an anime picked in the palette must always appear in the watchlist results for the same text.
  - A non-empty watchlist search shows matches from every list grouped by status (`SEARCH_GROUP_ORDER` in `src/lib/status.ts`), best match first; it is computed from `useDeferredValue(searchQuery)`. The palette searches synchronously so Enter always acts on what was typed.
  - Never scan full titles per keystroke without the index: normalization happens once at index time and the character bitmask rejects most entries before scoring.
- **Cover Image Resolution (`getOptimizedCoverUrl`)**:
  - **Never** use AniList `/cover/extraLarge/` URLs (up to 6 MB RGBA per decoded bitmap) in lists, cards, or grids.
  - Use `getOptimizedCoverUrl(url, "medium")` (230x325, ~299 KB) for small thumbnails (`w-7` to `w-24`, table rows, compact cards, search selectors).
  - Use `getOptimizedCoverUrl(url, "large")` (460x650, ~1.19 MB) for poster cards and the detail drawer.

### 7b. Logging & Crash Reporting
- **Rust**: use the `log` macros with a short subsystem target (`log::warn!(target: "sync", …)`: `app`, `sync`, `anilist`, `playback`, `scrobble`, `library`, `matcher`, `torrents`, `relations`, `settings`, `discord`, `webview`), never `println!` / `eprintln!` (exception: `data_migration`, which runs before the logger exists, and benchmark output in tests). `logging::plugin` is registered first in `run()`: a file in `%APPDATA%\Tora\logs` (`tora.log`, 5 MB, last 5 kept) plus stdout in debug builds; `Debug` level in debug builds, `Info` in release, dependencies at `Warn`. A panic hook logs panics with their location.
- **Frontend**: `log` from `src/lib/log.ts` writes to the same file (`@tauri-apps/plugin-log`, `log:default` capability) and to the console in dev; no bare `console.*`. `toraApi` logs every failed command (rate-limited per command); uncaught errors and unhandled rejections are logged from `main.tsx`; `ErrorBoundary` wraps the root and the tab content (keyed by tab) so a render error never leaves an empty window.
- **Levels**: `error` = a bug or lost work, `warn` = a failed operation that the user may notice (sync, network, file), `info` = one line per meaningful event (startup, pull summary, scan, session start/end, scrobble, downloads), `debug` = detail (each AniList request, watcher batches).
- **Never log** the AniList token, GraphQL variables, request bodies, notes or file contents; titles and paths are fine. Hot paths (the 2.5 s recognition poll, per-file matching, per-release evaluation) log only state changes, never every pass.
- Settings → Diagnostics → Logs shows the folder, opens it and copies the last 200 lines (`get_recent_logs`).

### 8. Tracker Sync Service (`src-tauri/src/sync/mod.rs`)
- **Single entry point**: Every user-state mutation (`update_anime_entry`, `batch_update_anime_entries`, `add_or_upsert_anime`, `delete_anime_entry` / `batch_delete_anime_entries`, scrobbling) and every pull (startup, manual "Sync from AniList" button, post-OAuth) goes through `TrackerSyncService`. **Never** call `TrackerPlugin::save_list_entry` / `delete_list_entry` / `fetch_user_list` or write user fields directly from commands.
- **`normalize_change`** (pure, unit-tested) owns validation and derivation: status enum, progress clamp to `episodes`, score 0–100, `YYYY-MM-DD` dates, PLANNING→CURRENT on progress ≥ 1, →COMPLETED at total, REPEATING→COMPLETED increments `user_repeats`, `user_started_at = today` on first watched episode (if empty), `user_completed_at = today` on transition into COMPLETED. Explicit dates in the same change win.
- **Push**: local write happens first with `sync_pending = 1`, then a background push. Success clears `sync_pending` (only if the row still equals what was pushed) and stores AniList's `updatedAt` and list-entry id. Failure keeps it pending and emits `tracker-sync-error`; `Unauthorized` also emits `tracker-auth-invalid`.
- **Delete**: local delete is immediate and writes a tombstone in `tracker_pending_deletions`; the AniList delete is retried until it succeeds, and tombstoned media are never re-added by a pull.
- **Pull**: serialized by `op_lock`; flushes tombstones and pending pushes first, then fetches the viewer's list with the light `MEDIA_LIST_FRAGMENT` and calls `Database::merge_remote_list` (newest `updated_at` wins per entry, pending entries keep local state, `custom_folder` preserved, remote-missing entries deleted locally unless pending — skipped on viewer mismatch or empty remote list). Emits `tracker-sync-started` / `tracker-list-synced` (`SyncSummary` delta: `changed` + `removed_ids`) / `tracker-sync-failed`. No background polling. Each pull logs one `[sync] pull(...)` timing line.
- **Pulls must stay diff-only and must never rematch the library**: `merge_remote_list` writes nothing for unchanged entries, uses targeted UPDATEs for changed ones, rewrites `normalized_titles_json` only when titles/synonyms change, and only touches `local_episodes.watched` for entries whose progress changed. Heavy metadata (`fetch_media_details`) is fetched only for new entries. Episode matching after a pull is limited to `rematch_ids` (new or retitled entries) via `match_unmatched_episodes_for_ids` in a background task that emits `library-changed`. **Never** call `rematch_all_local_episodes()` from a pull.
- **Invariants**: every `anime_entries` row has an `anilist_id`; there is no seed data. A signed-in AniList OAuth token is required for any push/pull.
- **Account ownership**: the local list belongs to one AniList account, `Database::list_owner()` (an `app_settings` key kept out of `AppSettings` so frontend saves can't overwrite it). Edits and deletes are **always** queued (`sync_pending` / tombstones), signed in or not, and only sent while signed in, so signed-out changes reach AniList on the owner's next sign-in. Every sign-in goes through `TrackerSyncService::sign_in` (OAuth callback and `verify_tracker_account`): same owner keeps the list; a **different** account runs `Database::reset_for_account_switch` (wipes entries, queue, watch history and title aliases; keeps library folders, indexed files, settings, torrent rules and public caches), emits `tracker-account-switched` and imports fresh. `sign_out` flushes the queue before clearing the token and keeps the owner. Every pull resolves the token's account first (`TrackerPlugin::viewer_id`) and stops before flushing or merging if it differs from the owner or the stored user.
- **Seasons** (`TrackerSyncService::fetch_season`): public data, no token. All pages of `Page.media(season, seasonYear)` (50/page, `hasNextPage`) go through the shared rate limiter. Each media (`SeasonalAnime`: full metadata + popularity + `MediaMetadata` tags/studios with ids/rankings/mean score/favourites) is upserted into `media_metadata` (one row per AniList id); `seasonal_cache` stores only the season's ordered id list. Browsing never writes `anime_entries`; list status in the Seasons view comes from the local list by id. Cached past seasons are only refetched on demand; current/upcoming ones are flagged `stale` after 24h and refreshed in the background by the frontend.
- **Airing schedule** (`TrackerSyncService::fetch_airing_schedule`): public data, no token. All pages of `Page.airingSchedules(airingAt_greater, airingAt_lesser)` for one `[from, to)` range (a local Mon–Sun week computed by the frontend, ≤ 8 days) go through the shared rate limiter; media carry only the light `MEDIA_LIST_FRAGMENT` fields (adult media dropped) plus the item's `country` (`countryOfOrigin`). Opening or adding a non-list anime from the schedule first swaps the light media for `media_metadata` (`getMediaMetadata`). "No episode this week" breaks are inferred in the frontend (`detectBreaks`, from list entries' `next_airing_at`) and never stored. Each range is cached as one row in `airing_schedule_cache`; ranges that already ended are never stale, others are flagged `stale` after 6h and refreshed in the background by the frontend. Browsing **never** writes `anime_entries` or `media_metadata`; list state comes from the local list by id.
- **Media metadata** (`TrackerSyncService::media_metadata`, used by the Now Playing hero): served from `media_metadata`. Only a media with no row is fetched (once, `fetch_media_metadata`, through the rate limiter); playback **never** refreshes it — season fetches are the only refresh path.
- **Airing dates**: `start_date` / `end_date` (fuzzy `YYYY[-MM[-DD]]`) are part of the light `MEDIA_LIST_FRAGMENT` and compared in `merge_remote_list`, so pulls keep them current without extra requests.
- **Custom lists** (AniList `customLists` / `hiddenFromStatusLists`): a side channel that never touches `AnimeEntry`, the search index or the matcher. Names live in `tracker_custom_lists` (user order); membership in `anime_custom_lists` (one row per entry, `ON DELETE CASCADE`, wiped by `reset_for_account_switch`). The pull reads both from the existing `MediaListCollection` query and `Database::merge_remote_custom_lists` merges them diff-only (never writes `anime_entries`, never rematches; skipped when the remote list is empty). Edits go through `TrackerSyncService::set_custom_lists` → `apply_custom_list_change`: the row is marked `dirty` and the entry `sync_pending`, so the normal push queue sends it; `SaveMediaListEntry` gets `customLists` / `hiddenFromStatusLists` **only** while the row is dirty, and `finish_push` clears `dirty` (and `sync_pending` only once no membership edit is still unsent). Dirty rows keep local membership through pulls. Creating and deleting a list go through `TrackerSyncService::create_custom_list` / `delete_custom_list` → `TrackerPlugin::create_custom_list` / `delete_custom_list`: immediate (never queued), signed-in owner only, they re-read the viewer's names from AniList before `UpdateUser(animeListOptions.customLists)` (AniList replaces the whole array, so a cached copy would delete lists made elsewhere) and store the returned names (`Database::set_custom_list_names`, which drops memberships of removed lists, unsent edits included, without queueing a push). Deleting a list never removes its anime from the list. Renaming lists stays on AniList. Frontend: `get_custom_lists` state in `useCustomListsState`, provided through `CustomListsContext`; a selected list replaces the status filter (`customListFilter`), hidden entries leave the status tabs and counts (still in All Anime and search), and the watchlist search is unchanged.
- **Watch history**: scrobbles log their own row. `Manual`, `Step` and `Batch` changes that raise progress log one row per newly watched episode (`player_name = "Manual"`, no file) via `Database::record_manual_progress`; a decrease logs one correction row (`progress_from` = old progress, `episode_number` = new). `Add` never logs. Anything counting watched episodes (`watch_history_totals`, `list_stats`) filters `progress_from IS NULL`. The drawer flushes a pending ± step save when it closes instead of dropping it.
- **Stats** (`get_stats` → `Database::list_stats`, reader only): list totals, backlog, ready-to-watch and the last 366 days of watched-episode events; the frontend buckets events by local day. Drive usage comes from `get_drive_summaries`. No AniList requests.

### 8b. Updates (`src-tauri/src/updates.rs`, `src/app/useAppUpdater.ts`)
- **App**: `tauri-plugin-updater` reads `https://github.com/Laesx/Tora/releases/latest/download/latest.json` (drafts are invisible, so publishing the draft release ships the update). Bundles are signed: the public key is `plugins.updater.pubkey` in `tauri.conf.json`; the release workflow signs with the `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` secrets, and local `pnpm tauri build` needs the same env vars (`createUpdaterArtifacts` is on). The check, prompt, download and relaunch run in the frontend; startup checks are silent unless an update is found.
- **Sidebar version**: a click checks for updates (app + relations, with "up to date" / error toasts). A dot shows while a found update was postponed or the running version's changelog is unseen (`tora.update.seenChangelog` in localStorage, initialized on first run); then a click opens the changelog, which offers the update when one is available.
- **Changelog**: `get_changelog` reads the GitHub releases API with `Accept: application/vnd.github.html+json` and returns GitHub's rendered `body_html` (drafts / prereleases dropped). `ReleaseNotesHtml` routes link clicks to `open_external_url`; the webview never navigates.
- **Anime relations**: the embedded `anime-relations.txt` is the fallback. `relations_db()` returns an `Arc` of the active database (swap with `install_relations`); never hold it across long work. A downloaded copy (`app_data\anime-relations.txt`) is loaded in `setup` before the library monitor starts when its `last_modified` is newer than the embedded one. `update_relations` installs a download only if it has rules and a strictly newer `last_modified`, saves it atomically and emits `relations-updated`. New rules apply to later parses; nothing is rematched.
- **Startup toggle**: `AppSettings.check_updates_on_startup` (default on) gates both startup checks; manual checks always work.

### 9. Torrents (`src-tauri/src/torrents/`)
- **Any RSS 2.0 feed.** `feed::parse_rss` is generic: tags are matched by local name (`nyaa:size`, `subsplease:size`, `torrent:contentLength`, `seeders`/`seeds`, `infoHash`, `magnetURI`, `<enclosure url length type>`). Info hashes are normalized to lowercase hex (`infoHash`, else the magnet's `btih`, base32 included, else a hash-shaped `guid`), so dedupe works across feeds. The release page is a URL `guid` / `comments` / a Nyaa view link derived from the .torrent link. `peers_known` is false when a feed has no seeder tags (the UI shows "—"; selection and filters treat peers as 0).
- **General feeds** (`TorrentFeed { id, name, enabled, url }`, key `torrent_feeds`) and **search feeds** (`SearchFeed { id, name, url }` with `%title%`, key `torrent_search_feeds`, never empty: defaults to Nyaa English-translated and all categories). Feeds saved as Nyaa query / category / filter fields load once as their Nyaa URL (`load_feeds`), and the next save drops the old fields. All torrent config lives in its own `app_settings` keys (`torrent_feeds`, `torrent_search_feeds`, `torrent_filters`, `torrent_priority`, `torrent_fansubs`, `torrent_board_options`), never inside `AppSettings` (a stale Settings save would overwrite them), and is kept on account switch. There are no torrent tables; the old `torrent_rules` is converted once and dropped.
- **RAM cache** (`TorrentCache` in `AppState`): raw items + Anitomy output per feed URL and the last search, keyed by its full filled-in URL. `get_torrent_board` **never fetches general feeds** unless `force` (the Refresh button); never-fetched selected feeds come back in `TorrentBoard.unfetched` and the tab waits for Refresh. Searches fetch on a cache miss. The background loop refreshes enabled feeds older than `torrent_refresh_minutes` (0 = never), only ones already fetched this session unless `torrent_auto_download` is on, and emits `torrent-feeds-refreshed`. Matching, filters and selection are recomputed from the cache on every board read — never refetch to re-select. The frontend keeps the last board in module memory so re-entering the tab shows it at once.
- **Board matching**: `board::match_titles` matches each distinct normalized title once (rayon), then each release does `title_match_for` + `resolve_episode` (= `match_episode`). Never call `match_episode` per release in `build_board`. Each build logs `[torrents] board: … in N ms`.
- **Feed URLs** are stored percent-encoded (`feed::normalize_url` on save encodes spaces, the `DISPLAY_DECODED` characters such as `|`, `[`, `]`, control characters and non-ASCII; `%` is untouched so `%title%` survives) and shown decoded like a browser (`displayUrl` in `src/lib/torrents.ts`, the same set). Feed order is the saved array order (chips, search dropdown; the first search feed is the default).
- **Searches** use `BoardOptions.search_feed_id` (the dropdown next to the search box; a deleted / unset choice = the first search feed, `config::resolve_search_feed`), filled by `feed::search_url` (`%title%`, any case → the URL-encoded query). The frontend saves the choice before reloading; it never sends a template.
- **Anime-level search everywhere**: callers pass `torrentSearchFor(anime)` (Romaji title without season/part suffix, plus the anime id whose card is pinned first). Never search per episode.
- **Hidden list statuses** (`BoardOptions.hidden_statuses`, key `torrent_board_options`, default Planning + Dropped): releases matched to an entry with one of these statuses are dropped before everything else (no card, never selected or auto-downloaded), except the anime a search was started from.
- **Selection pipeline** (`board.rs`): Discard filters → candidates (built-in: list status Watching/Rewatching, episode > progress, not on disk, not a batch, not sent this session; or a Select filter) → the anime's fansub override (strict: listed groups only, in order) or the global priority tiers (first tier with a matching release wins; `fallback_to_best` when none) → one release per (anime, episode range), ties by resolution closest to 1080p, then seeders, then newest. "Already downloaded" is the library (`available_episodes`) plus the session-only sent set; there is no download history table.
- **Query language** (`query.rs`, shared by filters and tiers): space = AND, `OR`/`|` = ANY (mixing is an error so the form editor stays equivalent), `-` negates, bare word / quoted phrase = title contains, `/regex/` on the raw title, `field:value` and `> >= < <=` for numeric fields. `QUERY_FIELDS` in `src/lib/torrents.ts` must list the same fields.
- **Downloads** (`download_releases`): save folder = existing `custom_folder` → the single folder of the anime's local episodes → `<torrent_download_folder>\<sanitized title_romaji>` (created; written to `custom_folder` only if empty, via `set_custom_folder_if_empty` — local-only, no AniList push) → the client default. The `.torrent` is downloaded to `app_data\torrents` (magnet fallback) and the app is launched with per-client flags by exe name (qBittorrent `--save-path= --category= --skip-dialog=true`, one process per folder with all its files; if qBittorrent wasn't running, wait for it before the next launch). No app found → the system default handler. No WebUI.
- Saving a new `torrent_download_folder` adds it as a library folder unless an enabled one already contains it, so downloaded files are watched and matched. The Settings field commits on blur / Browse, never per keystroke.
