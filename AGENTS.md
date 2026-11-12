# AGENTS.md — Tora (虎) Developer & AI Agent Guide

## Project Overview
**Tora (虎)** is a fast, modern desktop anime library manager and episode tracker inspired by **Taiga**, built with **Tauri v2** (Rust backend + native C++23/20 FFI bindings + React 18 / TypeScript / Tailwind CSS v3 frontend).

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
- **Frontend**: Node.js + `pnpm`, React 18, TypeScript, Vite 6, Tailwind CSS v3, Lucide icons.
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

### Match Lab (parser / matcher changes) & Anitomy Fork
```powershell
# Snapshot the library database (read-only VACUUM INTO; the app's file is never written) into .match-lab\
scripts/match-lab.ps1 snapshot

# Match every file of the snapshot with the current code, save a report, open the review page
# (http://127.0.0.1:4719: ground truth review, verdicts, compare with any earlier report)
scripts/match-lab.ps1 run "label of this iteration"

# Only the review page
scripts/match-lab.ps1 serve

# Check the obviously right files of the newest report (single-anime folders, by exact title or a folder
# named after the anime; never changes an existing check), so a person reviews only the rest. Counts without --write
python scripts/match-lab-accept-obvious.py --write

# Copy Anitomy from a local clone of the fork (never edit src-tauri\vendor\anitomy directly); -Check verifies the copy
scripts/sync-anitomy.ps1 -Fork D:\path\to\anitomy -Ref tora
scripts/sync-anitomy.ps1 -Check
```

---

## Repository Structure

```text
Tora/
├── src/                                  # React 18 + TypeScript Frontend (import with the `@/` alias = `src/`; same-folder files with `./`)
│   ├── main.tsx                          # React 18 entrypoint & root provider
│   ├── App.tsx                           # Wiring only: app state hooks, context providers, tab switch, drawer / palette / modals
│   ├── app/                              # App shell and app-wide state
│   │   ├── nav.ts                        # `NavTab`, `NAV_ITEMS` (the 8 tabs: sidebar rows, Ctrl+1–8, palette "Go to"), `SETTINGS_SHORTCUT_DIGIT` (Settings is a modal, not a tab)
│   │   ├── Sidebar.tsx                   # Brand + version, ← → (back / forward) and Settings (modal) buttons, Quick Jump (Ctrl+S) bar, tab navigation (Ctrl+N badges while Ctrl is held), keyboard shortcuts row, AniList account card
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
│   │   ├── useAniListHistory.ts          # AniList activity import state (`anilist-history-*` events), actions, import modal open state
│   │   ├── useGlobalShortcuts.ts         # F5, F11 fullscreen, Ctrl+S, Ctrl+1–8 tabs / Ctrl+9 Settings, ?, Alt+← / → and mouse back / forward, watchlist type-to-search / arrows / Enter / Ctrl+A / Alt+1–6 status tabs / Alt+Q W E views, layered Escape
│   │   ├── navigation.ts                 # Back / forward model: `NavView` (typed per tab), `NavCache`, `NavLocation`, `useNavCapture` registry, `sameLocation`
│   │   ├── useNavHistory.ts              # Back / forward stacks (10 entries each, cache kept on the newest 3, equal entries skipped)
│   │   └── paletteCommands.ts            # Ctrl+S Commands tab entries
│   ├── contexts/                         # React contexts (provided by App)
│   │   ├── toast.ts                      # `useToast()`; never pass `showToast` as a prop
│   │   ├── navigation.ts                 # `useNavigation().remember()`: a view changing its own "page" (History → anime timeline)
│   │   ├── animeActions.ts               # `useAnimeActions()`: open drawer, step, batch update / delete, change status, add, search torrents, open a season; never drill these as props
│   │   ├── customLists.ts                # AniList custom lists context (`useCustomLists`), optimistic membership edit, coverage helper
│   │   ├── anilistHistory.ts             # AniList activity import context (`useAniListHistory`), `importProgress`
│   │   ├── scoreFormat.ts                # The AniList account's score format (`useScoreFormat`)
│   │   └── titles.ts                     # Display title language (`useAnimeTitle`, `altTitles`, `displayTitle` for plain helpers)
│   ├── hooks/                            # Generic hooks
│   │   ├── virtual.ts                    # `useScrollViewport` (list width / top / scroll / viewport height) + `visibleRange` (binary search)
│   │   ├── useClickSelection.ts          # Click / Ctrl / Shift selection over a list (watchlist, Seasons)
│   │   ├── useNow.ts                     # Unix-seconds tick for relative labels ("3 days ago")
│   │   └── usePrefs.ts                   # Per-device view prefs in localStorage (guarded, laid over defaults)
│   ├── lib/                              # Plain helpers, no React state
│   │   ├── api.ts                        # Typed Tauri invoke wrappers (`toraApi`); every failure is logged (command name only)
│   │   ├── log.ts                        # `log.error/warn/info/debug(scope, msg, cause?)`, `logError`, global error / rejection logging
│   │   ├── types.ts                      # Shared TypeScript interfaces mirroring Rust database and detection models
│   │   ├── theme.ts                      # Theme presets, accent swatches, `applyThemeToDocument`, progress-strip color
│   │   ├── format.ts                     # Bytes, countdowns, "last synced", `plural`
│   │   ├── dates.ts                      # Date locale + clock from Settings (`dateLocale`, `formatTime`, `formatDateTime`, `formatDate`, `todayIso`), date field parsing
│   │   ├── scores.ts                     # User scores in the AniList score format: `formatScore`, `formatMeanScore`, 0–100 ⇄ format value, `SCORE_SCALES`
│   │   ├── covers.ts                     # `getOptimizedCoverUrl` (AniList CDN downscaling)
│   │   ├── status.ts                     # List status labels / icons / colors (`LIST_STATUSES`, `STATUS_INFO`, `statusLabel`, watchlist tabs, search group order)
│   │   ├── anime.ts                      # AniList links, play / open-folder, date & enum formatting
│   │   ├── episodes.ts                   # Episode ranges, aired / estimated totals, progress bar model
│   │   ├── seasons.ts                    # Season helpers (current season, shift, labels; broadcast quarters)
│   │   ├── fuzzy.ts                      # Shared fuzzy search (normalized index, char-mask prefilter, subsequence scoring, match ranges)
│   │   ├── torrents.ts                   # Anime-level torrent search (`torrentSearchFor`, season-suffix stripping), query field metadata, row → query text
│   │   └── releases.ts                   # An anime's files as releases (`groupReleases`), extras, the file that plays an episode (`pickEpisodeFile`), pinned releases
│   ├── components/                       # Shared UI used by several features
│   │   ├── AnimeQuickMenu.tsx            # Context menu for anime cards (+1 episode, mark status, open folder, copy title)
│   │   ├── SeasonAnimeMenu.tsx           # Right-click menu for remote anime posters (Seasons, Schedule)
│   │   ├── FloatingQuickMenu.tsx         # Viewport-clamped portal for right-click quick menus (dashboard, schedule)
│   │   ├── AnimePosterCard.tsx           # Poster card for remote anime (Seasons / Search): opens drawer, quick-add
│   │   ├── CustomListsPanel.tsx          # Custom-list membership toggles + "hide from status lists" (quick menu rows / drawer chips)
│   │   ├── EpisodeProgressBar.tsx        # Taiga-style progress bar with on-disk strip (ready / missing episodes in its tooltip)
│   │   ├── ProgressStepper.tsx           # −1 / +1 `StepButton`s and the bar flanked by them (watchlist table, detailed cards; grid overlays them on the bar)
│   │   ├── KeyHint.tsx                   # Key badge shown while a modifier is held (`useModifierHint`)
│   │   ├── DateInput.tsx                 # Date text field in the chosen format, calendar popup (never `<input type="date">` directly)
│   │   ├── AiringDot.tsx                 # Airing status dot with next-episode countdown
│   │   ├── ScoreInput.tsx                # Score editor in the account's format (number field, or star / smiley buttons)
│   │   └── UpdateCountdown.tsx           # Seconds until the playback auto update (from `update_due_at`, local clock)
│   ├── features/                         # One folder per tab / surface
│   │   ├── watchlist/
│   │   │   ├── WatchlistView.tsx         # Sticky toolbar (status tabs, custom-list chip, search, sort + direction, sync, view mode; Alt key badges) + the list
│   │   │   ├── useWatchlist.ts           # Filter state, sort prefs (`tora.watchlist.prefs`), `searchIndex`, status counts, search groups, `filteredAnime`, `focusAnime`
│   │   │   ├── sort.ts                   # `SORT_OPTIONS` (grouped keys, natural direction, unknown values last) + `watchlistComparator`
│   │   │   ├── VirtualWatchlist.tsx      # Viewport-windowed virtual grid/list for Grid, Compact & Table modes (row model with optional status group headers, scroll-to-anime, arrow-key `navRef`, last-updated labels)
│   │   │   ├── tableColumns.ts           # Table columns (`TABLE_COLUMNS`), per-device order / widths / visibility (`useTableColumns`, `tora.watchlist.columns`)
│   │   │   ├── ScoreDropdown.tsx         # Table Score cell picker in the account's score format (values, number field, Clear)
│   │   │   ├── useStatusDrag.ts          # Drag cards / rows onto the status board (pointer events on `window`, 6 px threshold, Esc cancels)
│   │   │   ├── StatusDropBoard.tsx       # Drop board shown while dragging: dimmed list, 3×2 status tiles with counts, cover-stack ghost
│   │   │   ├── CustomListsChip.tsx       # Single "Lists ▾" chip at the end of the status ribbon (filterable popover of custom lists, "New list…" row, per-list delete)
│   │   │   ├── NewCustomListModal.tsx    # Name prompt for creating an AniList custom list
│   │   │   └── DeleteCustomListModal.tsx # Confirmation before deleting an AniList custom list
│   │   ├── detail/
│   │   │   ├── AnimeDetailModal.tsx      # Slide-over drawer: composes the sections below (quick actions, custom lists, synopsis)
│   │   │   ├── useEntryEditor.ts         # The drawer's editable copy of an entry, files on disk, saves (debounced ± step, staged dates flushed on close)
│   │   │   ├── DetailHero.tsx            # Banner, cover / title (→ AniList), badges, meta line (season → Seasons, studios)
│   │   │   ├── UserStatePanel.tsx        # Status, progress, score, rewatches, dates
│   │   │   ├── EpisodesPanel.tsx         # Release chips (filter, pin), episode grid, windowed file list by episode, collapsed extras
│   │   │   ├── RelationsPanel.tsx        # Related anime cards (list status / progress / on disk, not-in-list quick add) + source chips
│   │   │   └── EntrySettings.tsx         # Aliases, custom folder, notes, remove / save
│   │   ├── palette/
│   │   │   ├── CommandPalette.tsx        # Ctrl+S keyboard palette: Anime / Commands tabs, recents, AniList row, Right-arrow anime actions
│   │   │   └── animeActions.ts           # Keyboard action list for one anime (palette → Right arrow)
│   │   ├── nowplaying/
│   │   │   ├── NowPlayingView.tsx        # Now Playing tab: hero while playing, dashboard when idle
│   │   │   ├── NowPlayingHero.tsx        # Playing anime hero (cover → AniList, metadata, studios/genres/tags links, episodes, link prompt)
│   │   │   └── NowPlayingDashboard.tsx   # Idle: watch stats, continue watching (next ep on disk, custom-list filter in `tora.nowplaying.prefs`), recently started/finished airing
│   │   ├── seasons/
│   │   │   ├── SeasonsView.tsx           # Cached seasonal browser (chips, ‹ ›, picker, sort/group/format filters, selection + keyboard triage, "Not interested" group, virtualized grid / extended rows)
│   │   │   ├── SeasonExtendedCard.tsx    # Extended view card: both titles, facts, prequel + list status, synopsis, genre / tag chips, trailer, actions
│   │   │   ├── SeasonTagFilter.tsx       # "Genres & tags" popover (show only / hide / off)
│   │   │   └── tagFilters.ts             # Relevant tags, include / exclude matching, the season's genre / tag options
│   │   ├── schedule/
│   │   │   ├── ScheduleView.tsx          # Weekly airing timetable (columns / agenda layouts, countdowns, my list / all anime, format/country/status filters, inferred breaks, "next episode ready" play, right-click add)
│   │   │   └── schedule.ts               # Airing schedule helpers (Mon–Sun local weeks, bounds, day/time labels, country labels, `detectBreaks`)
│   │   ├── search/SearchView.tsx         # Global AniList search (Enter in the Seasons filter lands here)
│   │   ├── history/
│   │   │   ├── HistoryView.tsx           # History tab: All / AniList / Local (backend keyset pages + title search), period stepper chip, grouped by day; per-anime episode timeline
│   │   │   ├── PeriodPicker.tsx          # Year × month popover (episode-count shading, season strips, shift-click ranges)
│   │   │   ├── titleSearch.ts                # Fuzzy title search: index over every title in the History → the backend's `HistoryTitleFilter`
│   │   │   ├── timeline.ts               # Per-anime timeline: watch-throughs (a repeated episode starts a rewatch) → months → one row per day and source
│   │   │   ├── period.ts                 # `HistoryPeriod` (day / month / season / year / month range): local bounds, stepping, labels; `HistoryRequest`
│   │   │   └── AniListImportModal.tsx    # AniList activity import: explanation, Start, progress bar, Pause / Resume
│   │   ├── stats/StatsView.tsx           # Stats tab: overview tiles, status bar, activity heatmap/streaks/monthly bars, backlog & ready-to-watch
│   │   ├── settings/
│   │   │   ├── SettingsModal.tsx         # Settings is a modal, not a tab (gear button, Ctrl+9, palette, `openSettings(section)`)
│   │   │   ├── SettingsView.tsx          # Sectioned settings: Appearance, Tracker, Library, Playback & Detection (update mode, Discord, Anisthesia players), Torrents, System (tray, start with Windows), Diagnostics, About
│   │   │   ├── LibraryManagerView.tsx    # Multi-drive folder manager, disk usage & virtualized episode table (Settings → Library)
│   │   │   ├── AnitomyParserPanel.tsx    # Interactive Anitomy filename / window title parser (Settings → Diagnostics)
│   │   │   ├── AniListHistorySettings.tsx # Settings → Tracker: AniList activity import status, Keep it updated, Update now, Delete
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
│       └── index.css                     # Tailwind CSS v3 stylesheets, custom theme variables & scrollbars
├── .match-lab/                           # Match lab data, gitignored (private paths): `snapshots/`, `lab.json`, `truth.json`, `reports/`
├── scripts/
│   ├── match-lab.ps1                     # Builds and runs the match lab (`snapshot`, `run "<label>"`, `serve`) from a copy of its exe
│   ├── match-lab-accept-obvious.py       # Pre-checks the obviously right files of a report (note "auto: …"; the page's Auto-checked filter)
│   ├── sync-anitomy.ps1                  # Vendors Anitomy from the fork (`-Fork <clone> -Ref tora`), `-Check` that the copy is the recorded commit
│   ├── mem-snapshot.ps1                  # Per-process memory / CPU of a running Tora (core + each WebView2 process), `-Watch`, `-Csv`, `-PassThru`
│   └── bench/
│       ├── mem-compare.ps1               # Release-builds the working tree (and `-Ref <git ref>`, cached by hash), runs mem-tour on each, prints averages + diff
│       ├── mem-tour.ps1                  # One build on the bench data: DevTools-driven tour of every tab, memory per phase (start / tours / settled / minimized / restored)
│       └── bench-data.py                 # Signed-out copy of the library for benchmarks (%APPDATA%\ToraBenchPristine)
└── src-tauri/                            # Tauri v2 Rust Backend & Native C++ Bindings
    ├── Cargo.toml                        # Rust dependencies (rusqlite bundled, tokio, rayon, reqwest, tauri v2)
    ├── build.rs                          # Compiles vendored C++ `anitomy` (/std:c++latest) & `anisthesia` (/std:c++20)
    ├── cpp/
    │   ├── tora_ffi.h                    # C ABI header bridging C++ Anitomy & Anisthesia to Rust
    │   └── tora_ffi.cpp                  # C++ implementation calling `anitomy::parse` & `anisthesia::win::GetResults`
    ├── examples/match_lab/               # Match lab (`main.rs`: snapshot / run / review server; `index.html`: the review page)
    ├── vendor/
    │   ├── anitomy/                      # `erengy/anitomy` C++23 source, copied from the `Laesx/anitomy` fork (never edited here)
    │   ├── anitomy.source                # Fork commit and tree hash of that copy, upstream base (`scripts/sync-anitomy.ps1`)
    │   ├── anisthesia/                   # Upstream `erengy/anisthesia` C++20 source + `data/players.anisthesia`
    │   └── anime-relations/              # Upstream `erengy/anime-relations` (`anime-relations.txt`); a rule added here must also go upstream as a PR (bump `last_modified`): a newer downloaded copy replaces this one
    └── src/
        ├── data_migration.rs             # Moves data from the old `app.tora.anime` identifier's folders (runs in `run()` before the builder)
        ├── logging.rs                    # `tauri-plugin-log` setup (`%APPDATA%\Tora\logs\tora.log`, rotated), panic hook, log tail
        ├── memory.rs                     # Per-process memory (core + WebView2 processes) for Diagnostics, WebView2 low memory target while minimized
        ├── lib.rs                        # Tauri state (`AppState`), async commands, background monitor & media poll loop, WebView2 accelerator keys off (release)
        ├── tray.rs                       # Tray icon + menu (now playing, Show, detection toggle, Quit), minimize / close to tray, start with Windows
        ├── discord.rs                    # Discord Rich Presence worker thread ("Watching <anime>", cover, episode, AniList + GitHub buttons)
        ├── main.rs                       # Tauri binary entrypoint
        ├── db/mod.rs                     # SQLite schema, `AnimeMatcherIndex` (title vs folder rules, season-isolated fuzzy matching, relations by ID) & aliases
        ├── db/settings.rs                # Lenient `get_settings`, JSON config keys, rolling settings backups & restore
        ├── db/activity.rs                # Imported AniList activity tables, import state, merged History query (`list_history`), timeline
        ├── detection/
        │   ├── mod.rs                    # `DetectedMediaSession` and `FilenameTestResult` types
        │   ├── anitomy.rs                # Safe Rust wrapper over `tora_anitomy_parse`, pure `parse_filename` (parent folders, title extension), Taiga title normalization
        │   ├── anisthesia.rs             # Safe Rust wrapper over `tora_anisthesia_detect_windows` + player registry
        │   └── relations.rs              # Parser & lookup engine for `erengy/anime-relations` (by ID, or by exact title)
        ├── library/
        │   ├── mod.rs                    # Library module declaration
        │   └── scanner.rs                # Fast filesystem scanner, Win32 IOCP directory watcher, batch episode matcher, folder links, one-time match repair
        ├── plugins/
        │   ├── mod.rs                    # `TrackerPlugin` trait & `PluginManager`
        │   └── anilist.rs                # AniList GraphQL v2 search, user list fetch, save & delete mutations
        ├── sync/mod.rs                   # `TrackerSyncService`: unified push/pull/delete pipeline, `normalize_change`, rate limiter
        ├── sync/history.rs               # AniList activity import (resumable, paced) and the refresh after each pull
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
- The vendored Anitomy is `2.0.0-alpha`, upstream's `develop` rewrite. Taiga 1.4.1 builds against the older released line (`master`, commit `a538eff`). They were compared on a real library of 11,595 files (November 2026): the release found 10,872 episode numbers, the rewrite 10,886; the release fails on dotted names (`Show.S03E01.Title...`) and `01. Title`, the rewrite on "Title 13 - Episode title". So the rewrite stays, and `parse_filename` covers its gaps (section 3). Compare again before swapping.
- **Anitomy is changed in the fork, `Laesx/anitomy`, never in `src-tauri/vendor/anitomy`.** Its branches: `develop` tracks upstream unchanged; `fix/<name>` holds one fix plus its case in `test/data.json`, cut from `develop` and opened as a PR to `erengy/anitomy`; `tora` = `develop` + our merged fixes, the branch Tora vendors. `scripts/sync-anitomy.ps1 -Fork <clone> -Ref tora` copies it (`git archive`) and writes `src-tauri/vendor/anitomy.source` (commit, tree hash, upstream base); `-Check` fails when the copy differs from the recorded tree. A fix moves into the fork when it is about one name (a checksum read as a type, a release group's number read as the episode); what needs the path or the list stays in `parse_filename`, as in Taiga. Clone the fork outside the repo (e.g. `D:\dev\anitomy`, `upstream` = erengy); run the sync from PowerShell (Git Bash's `tar` can't read Windows paths). `build.rs` watches `vendor/anitomy/include`, so a sync rebuilds the FFI.
- `anitomy_corpus` (`detection/anitomy.rs`) runs upstream's corpus (`test/data.json`) through Tora's FFI and build flags, compared like upstream's `test/main.cpp --test-data`. `ANITOMY_CORPUS_KNOWN_FAILURES` lists the cases the vendored version parses differently: a fork change that breaks another case fails the test, and one that fixes a listed case must remove it.
- `tora_anitomy_parse` takes `flags` (`TORA_ANITOMY_NO_*`): directory names are parsed without episode, episode title and extension, as Taiga does.

### 3. Episode Recognition: Parse, Then Match
A match is a **pure function of (path, parse, index)**: nothing is remembered from an earlier match, the parser never rewrites what a name says, and relations are applied by ID after the anime is known (as Taiga does). Two steps, never mixed:

**Parse** (`parse_filename` in `src-tauri/src/detection/anitomy.rs`), depends only on the input string:
1. **C++ Anitomy tokenization**: raw `Title`, `Season`, `Episode`, `ReleaseGroup`, `VideoResolution`, etc. Anitomy v2 strips `S02` / `2nd Season` / `Part 2` out of the title.
2. **Fallbacks**: a number that starts the name (`leading_number`, only used when the anime is known from its folder). Opening / ending / preview types never carry an episode number. Name-only misreads are fixed in the fork, not here: `[ED204890]` read as an ending, `[Y-467] Movie Title` read as episode 467, "Title 13 - Episode title" without an episode (the `tora` branch's `fix/*` commits, cases in `test/data.json`).
3. **Parent folders** (the two nearest, like Taiga's `GetTitleFromPath`): a season-only folder gives the season, the first titled one gives `parent_title` (an ordering prefix like `06 - ` is dropped) and replaces a weak title (`01.mkv`). When the season only came from a folder, `own_title` keeps the title without it ("Season 2\Non Non Biyori Repeat - 01").
4. **`ExtendAnimeTitle`**: appends `Season N` / `Part N` when `season > 1` or `part > 1`.
5. **No relations, no list**: `parse_filename` must never call `relations_db()` or look at the user's entries.

**Match** (`AnimeMatcherIndex` in `src-tauri/src/db/mod.rs`): `title_candidates(norm)` (alias, every entry with that exact title, one unambiguous fuzzy match; memoizable per title) then `resolve(&cands, &parsed, path)`:
1. A user alias (`title_aliases`) wins.
2. **Title against folder**. The folder is the *nearest* linked ancestor (`custom_folders`, whole path segments via `normalize_dir_key`, Unicode case-insensitive; several entries may share a folder).
   - the exact title and the folder agree: that entry;
   - the name is exactly another entry's title: **the title wins** ("Chihayafuru 2 - 01" in Chihayafuru's folder);
   - unless the name is only a shorter form of the folder entry's title *and* the file's own folder is named after that entry, or the number is no episode of the titled entry ("Clannad - 01" in `Clannad ~After Story~`, "Black Lagoon 13" in the second season's folder): then the folder wins (`folder_says_more`). A name that states season 1 always means it;
   - a name that matches no title belongs to the folder's entry ("Tambor Pinguino - 03").
3. **Fuzzy** (`fuzzy_match`): same season only; a nearly identical title beats an abbreviation, which beats a title the name extends, which beats letters that are only similar (`FuzzyTier`); rivals within `FUZZY_RIVAL_MARGIN` are only accepted when their titles form one chain, otherwise the name is ambiguous and stays unmatched ("fate" against every Fate entry). When the season came only from a folder, the name without it is guessed the same way (`own_title_fuzzy`: `Season 3\Show - Goddesses Arc - 04` → "Show: Goddesses"). Then the parent folder's own name, exact only (`MatchKind::Directory`).
4. **Never a file of one season on the entry of another**: `folder_entries_for` drops entries of the same series with another season, the series as the name states it or, when the season came from a `Season N` folder, as the folders do.
5. **Specials are not episodes** (`names_a_special`): a guessed or folder match whose name adds a marker word (`SPECIAL_MARKERS`: "Especial", "OVA", "Mini"...) or, for a guess from a longer name, more than a short tag, keeps the anime but gets no episode number. Title words written together ("Konnani" for "Konna ni") are no added words. A guess that hit an entry whose AniList format is OVA / special / ONA (`special_formats`) keeps its number ("Kiss X Sis OVA - 01"). Season 0 (`S00E10`) is the specials season: never an episode of the series (except on an alias or a special-format entry). A name between two episodes ("05.5", `between_episodes`) is a recap or an OVA: it is matched as episode 5 would be, then loses the number (`resolve`), so "play episode 5" never opens it. A year in the name picks the entry that started that year, also for `own_title` ("Season 3\Rozen Maiden (2013) - 01").
6. **Episode** (`finish`, a port of Taiga's `ValidateEpisodeNumber`): in range, done. Episode 0 or past the total: `anime-relations` by ID from the entry, then from the base title's entries, then a rule for the exact title whose destination is on the list by ID, then the list's own "`<title> N`" seasons. A valid episode is never redirected. Still no home: unmatched (an alias keeps the file; a folder match tries the linked folders above).
7. **Unmatched media**: if `matched_anime_id` is `None`, **never** auto-update or run the scrobble countdown. Focus the `Now Playing` tab and prompt the user to link the episode via `link_detected_episode_to_anime` (`Database::link_alias_to_anime`), which persists the relation in `title_aliases` and the anime's `synonyms` / `custom_synonyms`.

Rules that keep it that way:
- **When in doubt, unmatched.** A wrong match pushes wrong progress to AniList; an unmatched file costs one link.
- `local_episodes.match_kind` (`alias | title | folder | directory | fuzzy | relation`) says what decided a match; `parsed_episode` is the number in the name, `episode_number` the matched entry's episode.
- Relation lookups are by ID (`find_by_id`, `season_by_id`) or by **exact** title (`find_by_exact_title`): never by title prefix.
- **Releases and extras** (`src/lib/releases.ts`): a release is a folder, split by release group only when two groups hold the same episode there. Every "play episode N" (`playLocalEpisode`, the drawer, Now Playing) goes through `pickEpisodeFile` / `episodeFileMap`: the pinned release (`release_preferences` app_settings key, anime id → release key, local only, backed up, kept on account switch), else the oldest release on disk (earliest file date), then the most complete. A file with no episode number is an extra, labeled by `local_episodes.extra_kind` (`anitomy::extra_kind`, from the parse alone: opening / ending / preview / special / recap).
- Stored matches are versioned by `LIBRARY_MATCH_VERSION` (`library/scanner.rs`). Bump it when a parser or matcher change should reach files that are already indexed: the next startup scan runs `repair_library_matches` (normalizes titles again, rematches everything, clears folder links the files contradict).
- **Check every parser / matcher change in the match lab before shipping** (`src-tauri/examples/match_lab`, commands above). `run` copies the current snapshot, runs `Database::rematch_from_index` on the copy (the one-time repair without the disk walk: deterministic for a snapshot and the code) and saves a report: each file's parse and result (AniList ID, episode, `match_kind`), the folder links, the list. The review page scores every report against `.match-lab/truth.json`, the user's checked answer per file (`anilist_id: null` = must stay unmatched; an ID with `episode: null` = an extra): **wrong anime** and **unexpected** (matched, should not be) are the costly verdicts, then missed, wrong episode, correct, unreviewed. Keep a change only if it adds no costly verdict. Reports store raw output, so a corrected truth rescores every report. `verdict()` exists in `main.rs` (CLI summary, Reports view counts) and `index.html` (Review view): keep them equal.

### 4. Zero-Polling Win32 IOCP Directory Monitoring & Incremental Scanning
- **Native Win32 IOCP Monitor (`LibraryMonitorHandle`)**:
  - Monitors all enabled library folders via Win32 `ReadDirectoryChangesW` backed by an I/O Completion Port (`CreateIoCompletionPort`).
  - Worker thread blocks in the Windows kernel with **0.00% idle CPU** (`GetQueuedCompletionStatus`).
  - Coalesces burst file system notifications (250ms debounce) to handle bulk torrent additions, file unpacks, or temporary file renames without stutter.
  - Dynamically reloads watched directory handles on folder add/remove by posting a zero-key completion packet (`PostQueuedCompletionStatus`).
- **Atomic Delta Handling (`Database::handle_directory_change_events`)**:
  - Handles `Added`, `Removed`, and `Renamed` notifications in a single SQLite transaction without full directory rescans.
  - Emits the `library-changed` Tauri event with `ScanSummary` so the frontend updates instantly.
- **Folder links (`custom_folder`) come from files, never from loose names**:
  - An entry with no folder is linked to the folder where most of its files were found **by name** (`MatchKind::is_title_evidence`: alias, exact title, the folder's own exact name, a relation), never a library root. Several entries can share a folder (two seasons in one). There is no fuzzy matching of directory names: that once linked `python\lib\curses` to an anime.
  - A link is a fallback for files whose title names nothing, not an override (section 3). After a scan links a folder, the unmatched files are matched again for those entries.
  - Folder renames in Windows Explorer automatically update `anime_entries.custom_folder`.
- **Matches are never sticky**: scans and rematches write what the file resolves to now, also when that is "nothing". A full scan ("Rescan") ends with a rematch of every indexed file (each one parsed again from its path, ~1 s for 11,000 files), so it repairs wrong matches. A folder whose root is missing (unplugged drive) keeps its rows.
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

### 5b2. Tray, Window & Single Instance (`src-tauri/src/tray.rs`)
- `tauri_plugin_single_instance` is registered **first** (before logging, the plugin requires it): a second launch focuses the running window and exits, so a window hidden in the tray never gets a second process on the same database.
- The main window is created hidden (`"visible": false`); `setup` shows it unless Windows launched Tora (`--autostart`, `tauri-plugin-autostart`) with `start_hidden` on.
- `on_window_event` reads only the `TrayState` atomics (close / minimize to tray), never SQLite. `tray::apply_settings` refreshes them, the tray visibility, the detection check mark and the startup entry after every `save_app_settings` / `restore_settings_backup` (off the main thread). Hiding to the tray sets WebView2's low memory target (hiding isn't a 0×0 resize).
- The tray's "Playback detection" toggle writes `recognition_enabled` and emits `settings-changed` (full `AppSettings`) so the frontend never saves the old value back. The tooltip / now-playing line is set from `poll_media_recognition` only when its label changes (title via the same cached `presence_anime_for` lookup as Discord).
- The recognition poll runs in the webview: while the window is hidden Chromium may throttle its timers. Check the `playback` log cadence before relying on hidden-window timing.
- **Window state**: `tauri_plugin_window_state` (registered after autostart) restores the main window's size, position and maximized state (`tray::WINDOW_STATE_FLAGS`; never visibility, which `setup` decides, nor fullscreen) to `%APPDATA%\Tora\.window-state.json`. It saves on a clean exit; `hide_to_tray` also saves (off the main thread), since a tray app is often ended by a shutdown.

### 5b3. Watchlist Drag to Change Status (`features/watchlist/useStatusDrag.ts`)
- Pointer events, not HTML5 drag and drop (WebView2 drops HTML5 drag events while Tauri's file drop is on). After the press every listener is on `window`, because a virtualized card can unmount mid-drag. Controls inside cards (`button, a, input…`, `[data-no-drag]`) never start a drag; cards cancel `dragstart` so covers don't start the browser's image drag.
- A selected card drags the selection; any other card becomes the selection. Drops go through `batchUpdate` (never `changeStatus`, whose Rewatching path plays episode 1); Esc is caught in the capture phase so it doesn't also clear the selection; the click after a release is swallowed.

### 5c. Back / Forward Navigation (`src/app/navigation.ts`, `useNavHistory.ts`)
- An in-app history like a browser's (no router, no `history.pushState`): the sidebar ← / → buttons, Alt+← / →, mouse back / forward and the palette's Go Back / Go Forward. They wait while a modal, the palette or Settings is open; the drawer is part of the page.
- A location is the active tab's `NavView` (small, serializable, typed per tab) + the open drawer + `<main>`'s scroll, plus an optional `NavCache` (History rows, Search results) that only the newest 3 entries keep. Tabs still unmount; nothing else is kept.
- **Every jump pushes first**: App's handlers call `remember()` before changing the tab or opening a different anime (sidebar, Ctrl+1–8, palette, drawer → Seasons / Torrents, Stats → History / Watchlist, new playback session → Now Playing…). A view changing its own page calls `useNavigation().remember()` (History → anime timeline). Closing the drawer drops the entry its opening added.
- Views report their state with `useNavCapture(tab, …)` (the Watchlist's lives in App) and take it back through their existing request prop (`SeasonRequest.filter`, `HistoryRequest.search / anime / cache`, `SearchRequest.cache`, `TorrentsRequest`, `ScheduleRequest`). A new tab with state to restore needs a `NavView` variant, a capture and a case in App's `applyLocation`.
- Scroll is restored on animation frames until the view is tall enough (≤ 90 frames); user scroll input stops it. An account switch clears the history.

### 6. Database Performance & In-Memory Matching (`src-tauri/src/db/mod.rs`)
- Use the cached `AnimeMatcherIndex` (`db.matcher_index()`) for any matching (library scans, torrent RSS evaluation, playback recognition). Batch callers run `title_candidates` once per distinct normalized title (it holds the fuzzy step) and `resolve` per file; `match_episode` is both for a single name. Playback goes through `Database::match_playback`: a file the library already indexed is taken from its row, so Now Playing and the Library never disagree. It is built from the stored `normalized_titles_json` (keep that column correct on every title/synonym write) and cached until `matcher_generation` changes; an SQLite `update_hook` bumps the generation on any write to `anime_entries` or `title_aliases`, so writers never invalidate manually. Do not call the uncached `build_matcher_index()` in hot paths. The recognition poll only re-matches an unmatched session when the generation changed.
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
  - Poster grid columns: today's breakpoints (2–5), plus one more column whenever posters would grow past `MAX_POSTER_WIDTH` (260 px), so wide / fullscreen windows show more rows. The Watchlist tab has no max width (a centered cap would stop columns from ever being added).
  - Every virtualized row must be exactly the height the row model says: no wrapping text, no borders (separators are inset shadows), and the list element carries `[overflow-anchor:none]`. Otherwise Chromium scroll anchoring and the re-measure in `useScrollViewport` feed each other and the page locks up. As a safety net, `useScrollViewport` stops re-measuring synchronously after 8 changes before the next frame (it measures again on the frame) and logs `[virtual] viewport keeps changing…` once with the values: that line means a row model / DOM mismatch to fix.
  - Table mode uses `table-fixed` with a `<colgroup>` from `useTableColumns` (`tableColumns.ts`): column widths never depend on the mounted rows. Title takes the remaining width and can't be hidden, so the columns after it are anchored to the right edge and the ones before it to the left: each header boundary is dragged by resizing the column on its side **away from the title** (`startResize(column, side)`, capped so the title keeps its minimum; double-click resets). Headers are dragged sideways (5 px threshold, `startColumnDrag`: window listeners, ghost + drop line, Esc cancels, the release click is swallowed) to reorder; a plain click sorts. Every column is sortable (`sortKey` in `SORT_OPTIONS`). Right-clicking the header shows or hides columns (`defaultHidden` columns start hidden). The header is sticky under the toolbar, so the table's wrapper is `overflow-clip` (never a scroll container) and scroll-into-view accounts for the `thead` height. The Season cell opens that season in the Seasons tab; the Score cell opens `ScoreDropdown` (the account's format, saved through `batchUpdate`). Order, widths and visibility overrides are per-device prefs (`tora.watchlist.columns`: `order` holds every id, columns missing from a stored order are inserted after their default predecessor), not `AppSettings`.
  - `VirtualWatchlist` virtualizes a row model (optional group header rows + rows of `cols` cards with prefix-sum offsets, `visibleRange` binary search for the first visible row); search results grouped by status go through the same path. Lists scrolling inside `<main>` measure with `useScrollViewport` (`src/hooks/virtual.ts`).
- **Search (`src/lib/fuzzy.ts`)**:
  - The watchlist search and the command palette both use `searchAnime` over the one `searchIndex` built in `useWatchlist` (`buildAnimeSearchIndex`, rebuilt only when `animeList` changes). Don't add another filter path: an anime picked in the palette must always appear in the watchlist results for the same text.
  - A non-empty watchlist search shows matches from every list grouped by status (`SEARCH_GROUP_ORDER` in `src/lib/status.ts`), best match first; it is computed from `useDeferredValue(searchQuery)`. The palette searches synchronously so Enter always acts on what was typed.
  - Never scan full titles per keystroke without the index: normalization happens once at index time and the character bitmask rejects most entries before scoring.
- **Cover Image Resolution (`getOptimizedCoverUrl`)**:
  - **Never** use AniList `/cover/extraLarge/` URLs (up to 6 MB RGBA per decoded bitmap) in lists, cards, or grids.
  - Use `getOptimizedCoverUrl(url, "medium")` (230x325, ~299 KB) for small thumbnails (`w-7` to `w-24`, table rows, compact cards, search selectors).
  - Use `getOptimizedCoverUrl(url, "large")` (460x650, ~1.19 MB) for poster cards and the detail drawer.

- **Dates and times**: WebView2's locale follows the Windows display language (wry sets it), not the regional format, and `<input type="date">` can't be told otherwise. So the app formats them itself: `AppSettings.date_locale` (empty = Auto, the Windows regional locale from `get_system_locale`) and `time_format` (`auto` | `24h` | `12h`), mirrored into `src/lib/dates.ts` from App's body. Pass `dateLocale()` to `toLocaleDateString`, use `formatTime` / `formatDateTime` for anything showing a time (`hourCycle`, because `hour12: false` shows midnight as 24:00 in en-US), `formatDate` for stored `YYYY-MM-DD` values, `todayIso()` for today, and `DateInput` for editing. No module-level constants holding formatted dates: App keys the tab content on these settings so a change redraws every label.

### 7b. Logging & Crash Reporting
- **Rust**: use the `log` macros with a short subsystem target (`log::warn!(target: "sync", …)`: `app`, `sync`, `anilist`, `playback`, `scrobble`, `library`, `matcher`, `torrents`, `relations`, `settings`, `discord`, `webview`), never `println!` / `eprintln!` (exception: `data_migration`, which runs before the logger exists, benchmark output in tests, and the match lab, a command-line tool). `logging::plugin` is registered right after single-instance in `run()`: a file in `%APPDATA%\Tora\logs` (`tora.log`, 5 MB, last 5 kept) plus stdout in debug builds; `Debug` level in debug builds, `Info` in release, dependencies at `Warn`. A panic hook logs panics with their location.
- **Frontend**: `log` from `src/lib/log.ts` writes to the same file (`@tauri-apps/plugin-log`, `log:default` capability) and to the console in dev; no bare `console.*`. `toraApi` logs every failed command (rate-limited per command); uncaught errors and unhandled rejections are logged from `main.tsx`; `ErrorBoundary` wraps the root and the tab content (keyed by tab) so a render error never leaves an empty window.
- **Levels**: `error` = a bug or lost work, `warn` = a failed operation that the user may notice (sync, network, file), `info` = one line per meaningful event (startup, pull summary, scan, session start/end, scrobble, downloads), `debug` = detail (each AniList request, watcher batches).
- **Never log** the AniList token, GraphQL variables, request bodies, notes or file contents; titles and paths are fine. Hot paths (the 2.5 s recognition poll, per-file matching, per-release evaluation) log only state changes, never every pass.
- Settings → Diagnostics → Logs shows the folder, opens it and copies the last 200 lines (`get_recent_logs`).

### 7c. Memory & CPU Profiling
- Tora is `tora.exe` (core) plus WebView2 browser / renderer / GPU / utility processes; Task Manager adds them up under "Tora". Always say which process grew. Compare **release** builds only (debug runs Vite, React dev mode and DevTools).
- `scripts/mem-snapshot.ps1` (outside the app: private working set = Task Manager's "Memory", committed, working set, CPU s / CPU % per process; `-Watch 5 -Count 12 -Csv mem.csv -Tag …`) and Settings → Diagnostics → Memory (`get_process_memory` in `memory.rs`: `ICoreWebView2Environment8::GetProcessInfos` on the main thread, `K32GetProcessMemoryInfo` off it; plus the JS heap and DOM node count) report the same numbers. Read on demand, never polled.
- **Regressions**: `scripts/bench/mem-compare.ps1 [-Ref <commit/tag>] [-Rounds N]` builds release exes with the `ToraBench` identifier (`--config`, `--no-bundle`, into `src-tauri\target\bench`; ref exes cached by commit hash, built in a temporary worktree), then `mem-tour.ps1` runs each on a fresh copy of `%APPDATA%\ToraBenchPristine` (`bench-data.py`: signed out, no torrent auto-download / refresh, no Discord, no update checks) with a cold WebView2 profile, drives Ctrl+1–8 + scrolling over the DevTools protocol and records each phase. Bench builds never read or write `%APPDATA%\Tora`.
- Renderer grew → DevTools on a release build: set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` before starting it, open `edge://inspect` (Memory heap snapshots, Performance monitor). GPU grew → composited layers (DevTools Layers, Rendering → Layer borders). `tora.exe` grew → VMMap, `wpr -start Heap` / WPA, `samply record` for CPU.
- While the window is minimized WebView2 runs at `COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW` (`memory::set_low_memory_target` from `on_window_event`: minimizing is a 0×0 resize), back to normal on restore.
- DO NOT RUN THIS WHEN BUILDING FEATURES. Only do it when the user specifically mentions a regression or when he specifically says he wants to check performance.

### 8. Tracker Sync Service (`src-tauri/src/sync/mod.rs`)
- **Single entry point**: Every user-state mutation (`update_anime_entry`, `batch_update_anime_entries`, `add_or_upsert_anime`, `delete_anime_entry` / `batch_delete_anime_entries`, scrobbling) and every pull (startup, manual "Sync from AniList" button, post-OAuth) goes through `TrackerSyncService`. **Never** call `TrackerPlugin::save_list_entry` / `delete_list_entry` / `fetch_user_list` or write user fields directly from commands.
- **`normalize_change`** (pure, unit-tested) owns validation and derivation: status enum, progress clamp to `episodes`, score 0–100, `YYYY-MM-DD` dates, PLANNING→CURRENT on progress ≥ 1, →COMPLETED at total, a Manual or Batch status change that leaves progress alone also moves it (entering REPEATING → 0, entering COMPLETED → the total when known), REPEATING→COMPLETED increments `user_repeats`, `user_started_at = today` on first watched episode (if empty), `user_completed_at = today` on transition into COMPLETED. Explicit dates in the same change win.
- **Push**: local write happens first with `sync_pending = 1`, then a background push. Success clears `sync_pending` (only if the row still equals what was pushed) and stores AniList's `updatedAt` and list-entry id. Failure keeps it pending and emits `tracker-sync-error`; `Unauthorized` also emits `tracker-auth-invalid`.
- **Delete**: local delete is immediate and writes a tombstone in `tracker_pending_deletions`; the AniList delete is retried until it succeeds, and tombstoned media are never re-added by a pull.
- **Pull**: serialized by `op_lock`; flushes tombstones and pending pushes first, then fetches the viewer's list with the light `MEDIA_LIST_FRAGMENT` and calls `Database::merge_remote_list` (newest `updated_at` wins per entry, pending entries keep local state, `custom_folder` preserved, remote-missing entries deleted locally unless pending — skipped on viewer mismatch or empty remote list). Emits `tracker-sync-started` / `tracker-list-synced` (`SyncSummary` delta: `changed` + `removed_ids`) / `tracker-sync-failed`. No background polling. Each pull logs one `[sync] pull(...)` timing line.
- **Pulls must stay diff-only and must never rematch the library**: `merge_remote_list` writes nothing for unchanged entries, uses targeted UPDATEs for changed ones, rewrites `normalized_titles_json` only when titles/synonyms change, and only touches `local_episodes.watched` for entries whose progress changed. Heavy metadata (`fetch_media_details`) is fetched only for new entries. Episode matching after a pull is limited to `rematch_ids` (new or retitled entries) via `match_unmatched_episodes_for_ids` (only files that are unmatched or matched by a weak rule, folder or fuzzy, and only when they now resolve to one of those entries) in a background task that emits `library-changed`. **Never** call `rematch_all_local_episodes()` from a pull.
- **Invariants**: every `anime_entries` row has an `anilist_id`; there is no seed data. A signed-in AniList OAuth token is required for any push/pull.
- **Account ownership**: the local list belongs to one AniList account, `Database::list_owner()` (an `app_settings` key kept out of `AppSettings` so frontend saves can't overwrite it). Edits and deletes are **always** queued (`sync_pending` / tombstones), signed in or not, and only sent while signed in, so signed-out changes reach AniList on the owner's next sign-in. Every sign-in goes through `TrackerSyncService::sign_in` (OAuth callback and `verify_tracker_account`): same owner keeps the list; a **different** account runs `Database::reset_for_account_switch` (wipes entries, queue, watch history and title aliases; keeps library folders, indexed files, settings, torrent rules and public caches), emits `tracker-account-switched` and imports fresh. `sign_out` flushes the queue before clearing the token and keeps the owner. Every pull resolves the token's account first (`TrackerPlugin::viewer_id`) and stops before flushing or merging if it differs from the owner or the stored user.
- **Seasons** (`TrackerSyncService::fetch_season`): public data, no token. All pages of `Page.media(season, seasonYear)` (50/page, `hasNextPage`) go through the shared rate limiter. Each media (`SeasonalAnime`: full metadata + popularity + `MediaMetadata` tags/studios with ids/rankings/mean score/favourites) is upserted into `media_metadata` (one row per AniList id); `seasonal_cache` stores only the season's ordered id list. Browsing never writes `anime_entries`; list status in the Seasons view comes from the local list by id. Cached past seasons are only refetched on demand; current/upcoming ones are flagged `stale` after 24h and refreshed in the background by the frontend. `MediaMetadata.prequels` (direct anime `PREQUEL` relations, for the extended view) is `None` only in payloads stored before the field existed: such a season is flagged `stale` once, past or not, so opening it upgrades it.
- **Seasons pruning** (frontend, `features/seasons/`): selection is local to `SeasonsView` (`useClickSelection`, cleared on season change) because cards are usually not list entries; a click selects and a double-click opens, while Search and Schedule cards still open on one click. ← / → move the selection, or switch seasons with nothing selected. P / W only add anime not on the list, so a key can't change an existing status. "Not interested" (`Database::not_interested_ids` / `set_not_interested`) is the `seasons_not_interested` `app_settings` key: local only, never pushed, backed up, cleared by `reset_for_account_switch`; an anime on the list never counts as hidden. Filters and the view mode are per-device prefs (`tora.seasons.prefs`). Extended cards have a fixed height (`EXTENDED_CARD_HEIGHT`) and the virtualization rules above apply.
- **Airing schedule** (`TrackerSyncService::fetch_airing_schedule`): public data, no token. All pages of `Page.airingSchedules(airingAt_greater, airingAt_lesser)` for one `[from, to)` range (a local Mon–Sun week computed by the frontend, ≤ 8 days) go through the shared rate limiter; media carry only the light `MEDIA_LIST_FRAGMENT` fields (adult media dropped) plus the item's `country` (`countryOfOrigin`). Opening or adding a non-list anime from the schedule first swaps the light media for `media_metadata` (`getMediaMetadata`). "No episode this week" breaks are inferred in the frontend (`detectBreaks`, from list entries' `next_airing_at`) and never stored. Each range is cached as one row in `airing_schedule_cache`; ranges that already ended are never stale, others are flagged `stale` after 6h and refreshed in the background by the frontend. Browsing **never** writes `anime_entries` or `media_metadata`; list state comes from the local list by id.
- **Media metadata** (`TrackerSyncService::media_metadata`, used by the Now Playing hero): served from `media_metadata`. Only a media with no row is fetched (once, `fetch_media_metadata`, through the rate limiter); playback **never** refreshes it — season fetches are the only refresh path. `MediaMetadata.relations` holds every AniList relation (light node fields: format, status, episodes, year, small cover) for the drawer's Related panel; a stored row without it (`None`, stored before the field existed) is fetched once more on its next read, the stored copy serving if that fails. Related anime are never fetched until opened (no crawl).
- **Airing dates**: `start_date` / `end_date` (fuzzy `YYYY[-MM[-DD]]`) are part of the light `MEDIA_LIST_FRAGMENT` and compared in `merge_remote_list`, so pulls keep them current without extra requests.
- **Score format** (AniList `mediaListOptions.scoreFormat`): scores are always stored, pulled (`score(format: POINT_100)`) and pushed (`scoreRaw`) on 0–100; the format only changes display and input. The pull reads it from the existing `MediaListCollection.user` and stores it under its own `app_settings` key (`Database::score_format` / `set_score_format`, `tracker_score_format`, default `POINT_100`; never in `AppSettings`, cleared by `reset_for_account_switch`); `SyncSummary.score_format` carries it and `get_score_format` loads it at startup. Frontend: `ScoreFormatContext` (`useScoreFormat`), and every user score goes through `src/lib/scores.ts` (`formatScore`, `formatMeanScore`, `toFormatValue` / `fromFormatValue`; POINT_3 saves 35 / 60 / 85 like AniList) — never show `user_score` raw. Edits use `ScoreInput` (drawer) or the format's presets (quick menu).
- **Custom lists** (AniList `customLists` / `hiddenFromStatusLists`): a side channel that never touches `AnimeEntry`, the search index or the matcher. Names live in `tracker_custom_lists` (user order); membership in `anime_custom_lists` (one row per entry, `ON DELETE CASCADE`, wiped by `reset_for_account_switch`). The pull reads both from the existing `MediaListCollection` query and `Database::merge_remote_custom_lists` merges them diff-only (never writes `anime_entries`, never rematches; skipped when the remote list is empty). Edits go through `TrackerSyncService::set_custom_lists` → `apply_custom_list_change`: the row is marked `dirty` and the entry `sync_pending`, so the normal push queue sends it; `SaveMediaListEntry` gets `customLists` / `hiddenFromStatusLists` **only** while the row is dirty, and `finish_push` clears `dirty` (and `sync_pending` only once no membership edit is still unsent). Dirty rows keep local membership through pulls. Creating and deleting a list go through `TrackerSyncService::create_custom_list` / `delete_custom_list` → `TrackerPlugin::create_custom_list` / `delete_custom_list`: immediate (never queued), signed-in owner only, they re-read the viewer's names from AniList before `UpdateUser(animeListOptions.customLists)` (AniList replaces the whole array, so a cached copy would delete lists made elsewhere) and store the returned names (`Database::set_custom_list_names`, which drops memberships of removed lists, unsent edits included, without queueing a push). Deleting a list never removes its anime from the list. Renaming lists stays on AniList. Frontend: `get_custom_lists` state in `useCustomListsState`, provided through `CustomListsContext`; a selected list replaces the status filter (`customListFilter`), hidden entries leave the status tabs and counts (still in All Anime and search), and the watchlist search is unchanged.
- **Watch history**: scrobbles log their own row. `Manual`, `Step` and `Batch` changes that raise progress log one row per newly watched episode (`player_name = "Manual"`, no file) via `Database::record_manual_progress`; a decrease logs one correction row (`progress_from` = old progress, `episode_number` = new). `Add` never logs. Anything counting watched episodes (`watch_history_totals`, `list_stats`) filters `progress_from IS NULL`. The drawer flushes a pending ± step save when it closes instead of dropping it.
- **Stats** (`get_stats` → `Database::list_stats`, reader only): list totals, backlog, ready-to-watch and the last 366 days of watched-episode events; the frontend buckets events by local day. Drive usage comes from `get_drive_summaries`. No AniList requests. Time left (planning / remaining minutes, and Now Playing's "to finish") goes through `remaining_minutes_per_episode` / `remainingMinutesPerEpisode` (`src/lib/anime.ts`, keep them equal): duration (24 when unknown), minus 3 min of opening + ending on episodes ≥ 20 min when `AppSettings.skip_op_ed` is on; minutes already watched always use the full duration. "Include AniList history" (per-device pref `tora.stats.prefs`, off by default) passes `include_anilist`, which adds AniList-only episodes (player "AniList"). Clicking a heatmap day or a month bar opens that period in History (`HistoryRequest` through `App`, handled once like `SeasonRequest`) with the source Stats counted: All when AniList is included, else Local.
- **AniList activity history** (opt-in, `AppSettings.anilist_history_enabled`, default off; `db/activity.rs`, `sync/history.rs`): the user's `ListActivity` feed, anime only. Only episode activities ("watched / rewatched episode", parsed `progress` range) are stored: raw in `anilist_activities`, expanded per episode in `anilist_activity_episodes` (capped at 2000 per activity), titles / cover in `anilist_activity_media`. **Local wins**: an imported episode counts only while no local non-correction `watch_history` row exists for the same anime + episode, and no local correction landed on that episode up to an hour after the activity (AniList rewrites its recent activity to the lowered progress, so that is Tora's own echo) (`ANILIST_ONLY`, used by `list_history`, `history_timeline` and Stats); never write imported activity into `watch_history`.
  - **Import** (`start_history_import`): newest → oldest, cursor = `createdAt` (`createdAt_lesser: cursor + 1`, rows deduplicated by id; AniList rejects a null `createdAt_*`, so only set bounds become arguments). Each page and the state that follows it (`anilist_history_import` key, not `AppSettings`) are written in one transaction, so the resume point never runs ahead of the rows. Pages go through the shared limiter plus `HISTORY_PAGE_INTERVAL` (2.1 s; AniList allows 30 requests / minute) and never take `op_lock`. Network errors retry 5 / 15 / 45 s, then pause with `last_error`; startup resumes an interrupted or error-paused import (`resume_history_import_if_interrupted`), never a user pause. The token's viewer must be the list owner.
  - **Refresh** (`refresh_history`, only when enabled and the import is done): activity after the newest stored one minus 48 h (AniList grows a merged range in place), upserted by id. `pull` spawns it after emitting `tracker-list-synced`, so the sync spinner never waits; it is one ~0.3 s request and logs `[sync] history refresh(reason): …`. The History tab's refresh button runs it on demand.
  - Events: `anilist-history-progress` (`AniListHistoryStatus`, after each page / state change), `anilist-history-updated` `{ added }`. `reset_for_account_switch` drops the tables and the state; Settings → Tracker deletes them on request.
  - History tab: `list_history` (`HistoryQuery { source: all | local | anilist, search, media_id, from, to, before }`) is a keyset-paginated `UNION ALL` of local rows and AniList-only activities (reduced to their remaining episodes); the title search is fuzzy (`src/lib/fuzzy.ts`) and runs in the frontend over `get_history_titles` (`titleSearch.ts`, adding the list entries' titles and synonyms); the backend filters by the result (`HistoryTitleFilter`, one JSON parameter read with `json_each`), so it covers rows not loaded yet. Rows stay newest first. The All / AniList / Local chips only show once the setting is on or something was imported.
  - Periods: the frontend turns a `HistoryPeriod` into local `[from, to)` unix bounds (`periodBounds`), so the timezone stays in TS. The picker's shading comes from `get_history_month_counts` (`history_month_counts`: same source / title filter / dedupe, corrections excluded), the one query that buckets in SQLite, with `strftime(…, 'localtime')` (the OS timezone, which the webview shares).

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
- **Board matching**: `board::match_titles` runs `title_candidates` for each distinct normalized title once (rayon), then each release does `resolve` (together = `match_episode`). Never call `match_episode` per release in `build_board`. Each build logs `[torrents] board: … in N ms`.
- **Feed URLs** are stored percent-encoded (`feed::normalize_url` on save encodes spaces, the `DISPLAY_DECODED` characters such as `|`, `[`, `]`, control characters and non-ASCII; `%` is untouched so `%title%` survives) and shown decoded like a browser (`displayUrl` in `src/lib/torrents.ts`, the same set). Feed order is the saved array order (chips, search dropdown; the first search feed is the default).
- **Searches** use `BoardOptions.search_feed_id` (the dropdown next to the search box; a deleted / unset choice = the first search feed, `config::resolve_search_feed`), filled by `feed::search_url` (`%title%`, any case → the URL-encoded query). The frontend saves the choice before reloading; it never sends a template.
- **Anime-level search everywhere**: callers pass `torrentSearchFor(anime)` (Romaji title without season/part suffix, plus the anime id whose card is pinned first). Never search per episode.
- **Hidden list statuses** (`BoardOptions.hidden_statuses`, key `torrent_board_options`, default Planning + Dropped): releases matched to an entry with one of these statuses are dropped before everything else (no card, never selected or auto-downloaded), except the anime a search was started from.
- **Selection pipeline** (`board.rs`): Discard filters → candidates (built-in: list status Watching/Rewatching, episode > progress, not on disk, not a batch, not sent this session; or a Select filter) → the anime's fansub override (strict: listed groups only, in order) or the global priority tiers (first tier with a matching release wins; `fallback_to_best` when none) → one release per (anime, episode range), ties by resolution closest to 1080p, then seeders, then newest. "Already downloaded" is the library (`available_episodes`) plus the session-only sent set; there is no download history table.
- **Query language** (`query.rs`, shared by filters and tiers): space = AND, `OR`/`|` = ANY (mixing is an error so the form editor stays equivalent), `-` negates, bare word / quoted phrase = title contains, `/regex/` on the raw title, `field:value` and `> >= < <=` for numeric fields. `QUERY_FIELDS` in `src/lib/torrents.ts` must list the same fields.
- **Downloads** (`download_releases`): save folder = existing `custom_folder` → the single folder of the anime's local episodes → `<torrent_download_folder>\<sanitized title_romaji>` (created; written to `custom_folder` only if empty, via `set_custom_folder_if_empty` — local-only, no AniList push) → the client default. The `.torrent` is downloaded to `app_data\torrents` (magnet fallback) and the app is launched with per-client flags by exe name (qBittorrent `--save-path= --category= --skip-dialog=true`, one process per folder with all its files; if qBittorrent wasn't running, wait for it before the next launch). No app found → the system default handler. No WebUI.
- Saving a new `torrent_download_folder` adds it as a library folder unless an enabled one already contains it, so downloaded files are watched and matched. The Settings field commits on blur / Browse, never per keystroke.
