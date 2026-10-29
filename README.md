# Tora (虎)

A fast desktop anime manager inspired by [Taiga](https://github.com/erengy/taiga).
It is heavier, but it comes with some QoL upgrades.

> [!WARNING]
> Tora is under heavy development. Expect bugs and breaking changes.
> Only AniList is supported for now, and only on Windows.

<!-- ![Tora](docs/screenshots/overview.png) -->

## Features

### Episode detection

- **Automatic media player detection.** We use [Anisthesia](https://github.com/erengy/anisthesia), the same detection engine Taiga uses.
- **Battle-tested filename parsing.** We also use [Anitomy](https://github.com/erengy/anitomy), Taiga's filename parser, with some extra fuzzy matching on top.
- **Sequel episode numbering.** Continuous episode numbers (e.g. `Kusuriya no Hitorigoto - 51`) are redirected to the right season using [anime-relations](https://github.com/erengy/anime-relations).

<!-- ![Now Playing](docs/screenshots/now-playing.png) -->

### Library

- **Fast indexing.** A 7 TB library (12,000 episodes) is read and processed in only 0.6 seconds.
- **Live folder watching.** New, renamed and deleted files show up instantly, with no polling.
- **Folder and alias linking.** Episodes are matched by title, synonyms or folder name. Anything it can't match can be linked by hand once, and the rest of the episodes follow.

<!-- ![Library](docs/screenshots/library.png) -->

### AniList

- Two-way sync of progress, status, score, dates, rewatches, notes and custom lists.
- Changes made offline are queued and sent on the next sign-in.

<!-- ![Anime list](docs/screenshots/anime-list.png) -->
<!-- ![Anime details](docs/screenshots/anime-details.png) -->

### Seasons and schedule

- Seasonal browser with sorting, grouping and format filters.
- Weekly airing schedule with countdowns, filtered to your list or all anime.

<!-- ![Seasons](docs/screenshots/seasons.png) -->
<!-- ![Schedule](docs/screenshots/schedule.png) -->

### Torrents

- Check several RSS feeds at once: [Nyaa](https://nyaa.si) or any other RSS feed, plus title searches.
- One card per anime, with the best release picked automatically from your priority tiers, preferred fansubs and filters.
- Downloads are sent to your torrent client like Taiga does (qBittorrent gets a per-anime save folder and category).

<!-- ![Torrents](docs/screenshots/torrents.png) -->

### Everything else

- History and stats (activity heatmap, streaks, backlog).
- Grid, compact and table list views.
- `Ctrl+K` command palette.
- 6 themes plus custom accent colors.

<!-- ![History](docs/screenshots/history.png) -->
<!-- ![Stats](docs/screenshots/stats.png) -->

## Building

Requires Windows 10/11, [Rust](https://rustup.rs), Node.js with [pnpm](https://pnpm.io), and Visual Studio 2022 Build Tools (C++).

```bash
pnpm install
pnpm tauri dev     # development
pnpm tauri build   # installer
```

## Credits

- [Taiga](https://github.com/erengy/taiga), [Anisthesia](https://github.com/erengy/anisthesia), [Anitomy](https://github.com/erengy/anitomy) and [anime-relations](https://github.com/erengy/anime-relations) by erengy.
- Built with [Tauri](https://tauri.app) and React.
