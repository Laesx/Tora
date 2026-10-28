import { invoke } from "@tauri-apps/api/core";
import {
  AiringScheduleResult,
  AnimeEntry,
  AppSettings,
  BatchAnimeUpdatePatch,
  CachedSeason,
  CustomListChange,
  CustomListsState,
  DetectedMediaSession,
  DriveStorageSummary,
  FilenameTestResult,
  LibraryFolder,
  LocalEpisodeFile,
  ScanSummary,
  SeasonalAnime,
  SeasonResult,
  SignOutOutcome,
  SyncStatus,
  SyncSummary,
  ThemePreset,
  TorrentItem,
  TorrentRule,
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

  /** Stored metadata (tags, studios, rankings…); fetched from AniList only if none is stored yet. */
  getMediaMetadata: (anilistId: number) =>
    invoke<SeasonalAnime | null>("get_media_metadata", { anilistId }),

  searchTorrents: (query: string, provider?: string) =>
    invoke<TorrentItem[]>("search_torrents_cmd", { query, provider }),

  getTorrentRules: () => invoke<TorrentRule[]>("get_torrent_rules"),

  saveTorrentRule: (rule: TorrentRule) =>
    invoke<TorrentRule[]>("save_torrent_rule", { rule }),

  deleteTorrentRule: (ruleId: number) =>
    invoke<TorrentRule[]>("delete_torrent_rule", { ruleId }),

  downloadTorrent: (
    magnetUrl: string,
    torrentUrl: string,
    animeId?: number | null
  ) =>
    invoke<string>("download_torrent_cmd", {
      magnetUrl,
      torrentUrl,
      animeId: animeId ?? null,
    }),

  testQbittorrent: (qbUrl: string, username: string, password: string) =>
    invoke<string>("test_qbittorrent_cmd", { qbUrl, username, password }),

  getAppSettings: () => invoke<AppSettings>("get_app_settings"),

  saveAppSettings: (settings: AppSettings) =>
    invoke<AppSettings>("save_app_settings", { settings }),

  startAnilistOauth: () => invoke<string>("start_anilist_oauth"),

  signOutTracker: () => invoke<SignOutOutcome>("sign_out_tracker"),

  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
};
