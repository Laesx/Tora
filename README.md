# Tora (虎) — Fast, Modern Anime Library Manager & Tracker

**Tora** is a fast, lightweight desktop anime manager inspired by **Taiga**, built with **Tauri v2 (Rust)** and **React + TypeScript + Tailwind CSS**.

---

## Core Features

1. **Episode Detection (Anisthesia + Anitomy)**
   - **Anisthesia Win32 Media Player Detection** (`src-tauri/src/detection/anisthesia.rs`): Monitors 15+ Windows media players (`mpv`, `mpv.net`, `MPC-HC`, `MPC-BE`, `VLC`, `PotPlayer`, `KMPlayer`, `SMPlayer`, `GOM`, `Kodi`, `Windows Media Player`, `Haruna`, etc.) via native Win32 APIs (`EnumWindows`, `GetWindowTextW`, `QueryFullProcessImageNameW`).
   - **Anitomy Filename Parser** (`src-tauri/src/detection/anitomy.rs`): Tokenizes anime filenames and window titles into Anime Title, Normalized Title, Episode Number, Episode Version (`v2`), Season, Release Group, Video Resolution (`1080p`, `2160p`), Video/Audio Terms (`HEVC`, `10-bit`, `AV1`, `FLAC`, `Dual Audio`), Source (`BluRay`, `WEB-DL`), and CRC32 Checksum.
   - **Automatic Progress Scrobbling**: Configurable recognition delay timer (like Taiga's *"Wait before updating list"*) that automatically increments your progress and logs to your Watch History.

2. **Multi-Drive Anime Episode Library Management** (`src-tauri/src/library/scanner.rs`)
   - **Multiple Root Folders Across Any Hard Drive**: Index video files across `C:\`, `D:\`, `E:\`, or network shares.
   - **High-Speed Parallel Indexing**: Uses `walkdir` + `rayon` with incremental `mtime` & file-size caching in SQLite (`WAL` mode) to scan tens of thousands of files in milliseconds.
   - **Per-Drive Disk Space Analytics**: Uses native Win32 `GetDiskFreeSpaceExW` to display drive capacity, free space, and anime storage footprint.
   - **Automatic & Manual Title Alias Binding**: Automatically links episodes to your watchlist via normalized titles, synonyms, or parent folder names, with 1-click manual binding for custom folder names.

3. **Internal Tracker Plugin System (AniList Primary)** (`src-tauri/src/plugins/`)
   - Built around the extensible `TrackerPlugin` trait and `PluginManager` (`src-tauri/src/plugins/mod.rs`).
   - **AniList GraphQL v2 Plugin** (`src-tauri/src/plugins/anilist.rs`):
     - Public username sync (import any AniList user's anime list immediately without needing a token).
     - OAuth Bearer token support for automatic 2-way progress, status, score, repeat, and notes synchronization.
     - Seasonal anime browser (`Winter`, `Spring`, `Summer`, `Fall`) & live Airing Countdown schedule.

4. **Torrent Search, Smart RSS Rules & qBittorrent Integration** (`src-tauri/src/torrents/mod.rs`)
   - Search **Nyaa.si** and **AnimeTosho** RSS feeds with automatic Anitomy tag extraction on every result.
   - **Taiga-style Smart Filter Rules**: Highlight, auto-download, or discard torrents by anime title, release group (`SubsPlease`, `Erai-raws`), resolution (`1080p`, `2160p`), excluded keywords, and unwatched episode numbers.
   - **Download Integration**: Send directly to **qBittorrent WebUI API** (with custom category & per-anime save folder) or launch Magnet links in your system's default torrent client.

5. **Rich Anime Detail Menus, Popovers & Theme Engine**
   - **Quick Info Popover Menu (`•••`)** on every anime card plus a full **Anime Detail Drawer** with an interactive Episode Availability Grid (`1..N`), direct local episode playback, Explorer file reveal, and custom folder/alias configuration.
   - **6 Curated Themes + Custom Accent Colors**: *Tora Midnight (Dark)*, *Taiga Classic (Light)*, *Catppuccin Mocha*, *Tokyo Night*, *Cyber Sakura (OLED)*, and *Nordic Frost*, plus 3 list view modes (*Poster Grid*, *Detailed Cards*, and *Taiga Classic Dense Table*) and a `Ctrl+K` Command Palette.

---

## Development & Running

```bash
# Install frontend dependencies
pnpm install

# Run in Tauri v2 development mode
pnpm tauri dev

# Build production desktop bundle
pnpm tauri build
```
