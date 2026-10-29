import { invoke } from "@tauri-apps/api/core";
import {
  AiringScheduleResult,
  AnimeEntry,
  AppInfo,
  AppSettings,
  BatchAnimeUpdatePatch,
  CachedSeason,
  CustomListChange,
  CustomListsState,
  DetectedMediaSession,
  DriveStorageSummary,
  FilenameTestResult,
  LibraryFolder,
  ListStats,
  LocalEpisodeFile,
  ScanSummary,
  SeasonalAnime,
  SeasonResult,
  SignOutOutcome,
  SyncStatus,
  SyncSummary,
  ThemePreset,
  BoardOptions,
  BoardSource,
  DetectedTorrentApp,
  DownloadRequest,
  DownloadSummary,
  FansubOverride,
  ParsedQuery,
  PriorityConfig,
  SearchFeed,
  SettingsBackupInfo,
  TorrentBoard,
  TorrentFeed,
  TorrentFilter,
  TrackerPluginDescriptor,
  TrackerUserProfile,
  WatchHistoryEntry,
  WatchStats,
} from "./types";

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "tora-midnight",
    name: "Tora Midnight",
    isDark: true,
    previewBg: "#0c0e14",
    previewCard: "#1a1e2b",
    defaultAccent: "#f59e0b",
    description: "Deep obsidian dark mode with signature Tiger Amber highlights.",
  },
  {
    id: "taiga-classic",
    name: "Taiga Classic",
    isDark: false,
    previewBg: "#f8fafc",
    previewCard: "#ffffff",
    defaultAccent: "#2563eb",
    description: "Crisp daylight desktop theme inspired by classic Taiga.",
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    isDark: true,
    previewBg: "#181825",
    previewCard: "#313244",
    defaultAccent: "#cba6f7",
    description: "Soothing pastel dark mocha with lavender & mauve tones.",
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    isDark: true,
    previewBg: "#16161e",
    previewCard: "#24283b",
    defaultAccent: "#7aa2f7",
    description: "Clean neon night palette inspired by downtown Tokyo lights.",
  },
  {
    id: "cyber-sakura",
    name: "Cyber Sakura (OLED)",
    isDark: true,
    previewBg: "#08070c",
    previewCard: "#1a1426",
    defaultAccent: "#ec4899",
    description: "High-contrast AMOLED black with electric sakura pink.",
  },
  {
    id: "nordic-frost",
    name: "Nordic Frost",
    isDark: true,
    previewBg: "#242933",
    previewCard: "#3b4252",
    defaultAccent: "#88c0d0",
    description: "Arctic slate blues and cool frost cyan.",
  },
];

export const ACCENT_SWATCHES = [
  { name: "Tiger Amber", hex: "#f59e0b" },
  { name: "Taiga Blue", hex: "#3b82f6" },
  { name: "Sakura Pink", hex: "#ec4899" },
  { name: "Emerald Jade", hex: "#10b981" },
  { name: "Violet Pulse", hex: "#8b5cf6" },
  { name: "Crimson Flame", hex: "#ef4444" },
  { name: "Arctic Cyan", hex: "#06b6d4" },
];

export function hexToRgbTriplet(hex: string): string | null {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return `${r} ${g} ${b}`;
}

export function applyThemeToDocument(themeId: string, accentHex: string) {
  const root = document.documentElement;
  root.setAttribute("data-theme", themeId);
  const preset = THEME_PRESETS.find((t) => t.id === themeId);
  if (preset && !preset.isDark) {
    root.classList.remove("dark");
  } else {
    root.classList.add("dark");
  }
  const rgb = hexToRgbTriplet(accentHex);
  if (rgb) {
    root.style.setProperty("--accent-primary", rgb);
    root.style.setProperty("--accent-hover", rgb);
  }

  const style = getComputedStyle(root);
  const accent = parseTriplet(rgb ?? style.getPropertyValue("--accent-primary"));
  const track = parseTriplet(style.getPropertyValue("--bg-tertiary"));
  if (accent && track) {
    root.style.setProperty("--progress-strip", progressStripColor(accent, track).join(" "));
  }
}

type Rgb = [number, number, number];

function parseTriplet(value: string): Rgb | null {
  const parts = value.trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? (parts as Rgb) : null;
}

/** WCAG relative luminance */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255)) as Rgb;
}

function hueOf([r, g, b]: Rgb): { hue: number; sat: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  const sat = d / (1 - Math.abs(max + min - 1));
  let hue = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  hue *= 60;
  return { hue: hue < 0 ? hue + 360 : hue, sat };
}

const STRIP_GREEN_DARK: Rgb = [52, 211, 153]; // emerald-400
const STRIP_GREEN_LIGHT: Rgb = [5, 150, 105]; // emerald-600
const STRIP_HUE = 145;
const STRIP_SAT = 0.75;

/**
 * On-disk strip colour for progress bars: emerald green on every theme. Only a green / teal accent
 * too close to it (the strip runs over the watched fill) moves the green to the lightness that
 * contrasts best with both the fill and the empty track.
 */
export function progressStripColor(accent: Rgb, track: Rgb): Rgb {
  const base = luminance(track) < 0.2 ? STRIP_GREEN_DARK : STRIP_GREEN_LIGHT;
  const { hue, sat } = hueOf(accent);
  const greenish = sat > 0.2 && hue >= 90 && hue <= 200;
  if (!greenish || contrastRatio(base, accent) >= 1.5) return base;

  let best = base;
  let bestScore = -1;
  // Lightness stays in a range where the hue still reads (no near-white / near-black)
  for (let l = 0.3; l <= 0.8001; l += 0.025) {
    const c = hslToRgb(STRIP_HUE, STRIP_SAT, l);
    const score = Math.min(contrastRatio(c, accent), contrastRatio(c, track));
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${units[i]}`;
}

export function formatCountdown(airingUnix: number | null): string | null {
  if (!airingUnix) return null;
  const now = Math.floor(Date.now() / 1000);
  const diff = airingUnix - now;
  if (diff <= 0) return "Airing now";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Downscale AniList CDN cover URLs to keep WebView2 decoded RGBA image bitmap memory low:
 * - "medium" (230x325, ~299 KB RGBA) for small thumbnails (table rows, compact cards, command palette, selectors)
 * - "large" (460x650, ~1.19 MB RGBA) for poster grid cards & detail drawer instead of "extraLarge" (1000x1500, ~6 MB RGBA)
 */
export function getOptimizedCoverUrl(
  url: string | null | undefined,
  size: "medium" | "large" = "medium"
): string {
  if (!url) return "";
  if (url.includes("/media/anime/cover/")) {
    if (size === "medium") {
      return url
        .replace("/media/anime/cover/extraLarge/", "/media/anime/cover/medium/")
        .replace("/media/anime/cover/large/", "/media/anime/cover/medium/");
    }
    return url.replace(
      "/media/anime/cover/extraLarge/",
      "/media/anime/cover/large/"
    );
  }
  return url;
}

export const toraApi = {
  getAnimeList: () => invoke<AnimeEntry[]>("get_anime_list"),

  updateAnimeEntry: (params: {
    animeId: number;
    userStatus: string;
    userProgress: number;
    userScore: number;
    userRepeats: number;
    userNotes: string;
    customFolder?: string | null;
    /** Replaces the user's custom aliases (AniList synonyms are kept) */
    synonyms?: string[] | null;
    userStartedAt?: string | null;
    userCompletedAt?: string | null;
  }) => invoke<AnimeEntry>("update_anime_entry", params),

  batchUpdateAnimeEntries: (patch: BatchAnimeUpdatePatch) =>
    invoke<AnimeEntry[]>("batch_update_anime_entries", { patch }),

  getCustomLists: () => invoke<CustomListsState>("get_custom_lists"),

  // Add to / remove from custom lists or toggle "hidden from status lists"; queued and pushed like any edit
  setAnimeCustomLists: (change: CustomListChange) =>
    invoke<CustomListsState>("set_anime_custom_lists", { change }),

  batchDeleteAnimeEntries: (animeIds: number[]) =>
    invoke<AnimeEntry[]>("batch_delete_anime_entries", { animeIds }),

  addOrUpsertAnime: (entry: AnimeEntry) =>
    invoke<AnimeEntry[]>("add_or_upsert_anime", { entry }),

  deleteAnimeEntry: (animeId: number) =>
    invoke<AnimeEntry[]>("delete_anime_entry", { animeId }),

  getTrackerPlugins: () =>
    invoke<TrackerPluginDescriptor[]>("get_tracker_plugins"),

  verifyTrackerAccount: (
    pluginId: string,
    username: string,
    token?: string | null
  ) =>
    invoke<TrackerUserProfile>("verify_tracker_account", {
      pluginId,
      username,
      token: token || null,
    }),

  // Flushes queued pushes/deletes, then pulls the signed-in user's AniList list
  syncTrackerList: () => invoke<SyncSummary>("sync_tracker_list"),

  getSyncStatus: () => invoke<SyncStatus>("get_sync_status"),

  searchRemoteAnime: (params: {
    query: string;
    season?: string | null;
    year?: number | null;
  }) => invoke<AnimeEntry[]>("search_remote_anime", params),

  // Every anime of a season; cached in SQLite, refetched only when forced (or stale, by the caller)
  getSeason: (params: { season: string; year: number; forceRefresh?: boolean }) =>
    invoke<SeasonResult>("get_season", {
      season: params.season,
      year: params.year,
      forceRefresh: params.forceRefresh ?? false,
    }),

  listCachedSeasons: () => invoke<CachedSeason[]>("list_cached_seasons"),

  // Every episode airing in [from, to) (unix seconds); cached per range, refetched when forced (or stale, by the caller)
  getAiringSchedule: (params: { from: number; to: number; forceRefresh?: boolean }) =>
    invoke<AiringScheduleResult>("get_airing_schedule", {
      from: params.from,
      to: params.to,
      forceRefresh: params.forceRefresh ?? false,
    }),

  getLibraryFolders: () => invoke<LibraryFolder[]>("get_library_folders"),

  addLibraryFolder: (path: string, label?: string) =>
    invoke<LibraryFolder[]>("add_library_folder", { path, label }),

  removeLibraryFolder: (folderId: number) =>
    invoke<LibraryFolder[]>("remove_library_folder", { folderId }),

  getDriveSummaries: () => invoke<DriveStorageSummary[]>("get_drive_summaries"),

  scanLibrary: () => invoke<ScanSummary>("scan_library"),

  quickScanLibrary: () => invoke<ScanSummary>("quick_scan_library"),

  getLocalEpisodes: (animeId?: number | null) =>
    invoke<LocalEpisodeFile[]>("get_local_episodes", {
      animeId: animeId ?? null,
    }),

  bindTitleAlias: (normalizedAlias: string, animeId: number) =>
    invoke<number>("bind_title_alias", { normalizedAlias, animeId }),

  playEpisodeFile: (filePath: string) =>
    invoke<string>("play_episode_file", { filePath }),

  revealInExplorer: (filePath: string) =>
    invoke<void>("reveal_in_explorer", { filePath }),

  createDemoLibraryFiles: () =>
    invoke<ScanSummary>("create_demo_library_files"),

  testParseFilename: (input: string) =>
    invoke<FilenameTestResult>("test_parse_filename", { input }),

  dismissPlaybackSession: () => invoke<void>("dismiss_playback_session"),

  pollMediaRecognition: () =>
    invoke<DetectedMediaSession | null>("poll_media_recognition"),

  linkDetectedEpisodeToAnime: (animeId: number, aliasTitle: string) =>
    invoke<DetectedMediaSession | null>("link_detected_episode_to_anime", {
      animeId,
      aliasTitle,
    }),

  getWatchHistory: (limit = 100, offset = 0) =>
    invoke<WatchHistoryEntry[]>("get_watch_history", { limit, offset }),

  getWatchStats: () => invoke<WatchStats>("get_watch_stats"),

  getStats: () => invoke<ListStats>("get_stats"),

  getAppInfo: () => invoke<AppInfo>("get_app_info"),

  /** Stored metadata (tags, studios, rankings…); fetched from AniList only if none is stored yet. */
  getMediaMetadata: (anilistId: number) =>
    invoke<SeasonalAnime | null>("get_media_metadata", { anilistId }),

  /** Torrents board from the RAM cache; feeds are fetched only when uncached or with `force`. */
  getTorrentBoard: (source: BoardSource, force = false) =>
    invoke<TorrentBoard>("get_torrent_board", { source, force }),

  downloadReleases: (releases: DownloadRequest[]) =>
    invoke<DownloadSummary>("download_releases", { releases }),

  getTorrentFeeds: () => invoke<TorrentFeed[]>("get_torrent_feeds"),

  saveTorrentFeeds: (feeds: TorrentFeed[]) =>
    invoke<TorrentFeed[]>("save_torrent_feeds", { feeds }),

  getTorrentSearchFeeds: () => invoke<SearchFeed[]>("get_torrent_search_feeds"),

  saveTorrentSearchFeeds: (feeds: SearchFeed[]) =>
    invoke<SearchFeed[]>("save_torrent_search_feeds", { feeds }),

  getTorrentFilters: () => invoke<TorrentFilter[]>("get_torrent_filters"),

  saveTorrentFilters: (filters: TorrentFilter[]) =>
    invoke<TorrentFilter[]>("save_torrent_filters", { filters }),

  getTorrentPriority: () => invoke<PriorityConfig>("get_torrent_priority"),

  saveTorrentPriority: (priority: PriorityConfig) =>
    invoke<PriorityConfig>("save_torrent_priority", { priority }),

  getTorrentFansubs: () => invoke<FansubOverride[]>("get_torrent_fansubs"),

  /** Replaces one anime's fansub list; an empty list removes the override. */
  setAnimeFansubs: (animeId: number, groups: string[]) =>
    invoke<FansubOverride[]>("set_anime_fansubs", { animeId, groups }),

  getTorrentBoardOptions: () => invoke<BoardOptions>("get_torrent_board_options"),

  saveTorrentBoardOptions: (options: BoardOptions) =>
    invoke<BoardOptions>("save_torrent_board_options", { options }),

  parseTorrentQuery: (query: string) =>
    invoke<ParsedQuery>("parse_torrent_query", { query }),

  detectTorrentApp: (customPath?: string) =>
    invoke<DetectedTorrentApp>("detect_torrent_app", { customPath: customPath ?? null }),

  listSettingsBackups: () => invoke<SettingsBackupInfo[]>("list_settings_backups"),

  backupSettingsNow: () => invoke<SettingsBackupInfo[]>("backup_settings_now"),

  restoreSettingsBackup: (fileName: string) =>
    invoke<AppSettings>("restore_settings_backup", { fileName }),

  getAppSettings: () => invoke<AppSettings>("get_app_settings"),

  saveAppSettings: (settings: AppSettings) =>
    invoke<AppSettings>("save_app_settings", { settings }),

  startAnilistOauth: () => invoke<string>("start_anilist_oauth"),

  signOutTracker: () => invoke<SignOutOutcome>("sign_out_tracker"),

  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
};
