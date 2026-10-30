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
  RelationsInfo,
  ReleaseNote,
  ScanSummary,
  SeasonalAnime,
  SeasonResult,
  SignOutOutcome,
  SyncStatus,
  SyncSummary,
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

export const toraApi = {
  getAnimeList: () => invoke<AnimeEntry[]>("get_anime_list"),

  /** Only these entries (missing ids are skipped) */
  getAnimeEntries: (ids: number[]) => invoke<AnimeEntry[]>("get_anime_entries", { ids }),

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

  // Create a custom list on AniList right away (signed in only, not queued)
  createCustomList: (name: string) => invoke<CustomListsState>("create_custom_list", { name }),

  // Delete a custom list on AniList right away; its anime stay on the list (signed in only, not queued)
  deleteCustomList: (name: string) => invoke<CustomListsState>("delete_custom_list", { name }),

  batchDeleteAnimeEntries: (animeIds: number[]) =>
    invoke<void>("batch_delete_anime_entries", { animeIds }),

  addOrUpsertAnime: (entry: AnimeEntry) =>
    invoke<AnimeEntry>("add_or_upsert_anime", { entry }),

  deleteAnimeEntry: (animeId: number) =>
    invoke<void>("delete_anime_entry", { animeId }),

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

  /** Manual update mode: update the list to the detected episode */
  confirmPlaybackUpdate: () => invoke<DetectedMediaSession | null>("confirm_playback_update"),

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

  /** Download anime-relations from GitHub; the new `last_modified` when it was newer (also emits `relations-updated`). */
  checkRelationsUpdate: () => invoke<string | null>("check_relations_update"),

  getRelationsInfo: () => invoke<RelationsInfo>("get_relations_info"),

  /** Published Tora releases from GitHub, newest first. */
  getChangelog: () => invoke<ReleaseNote[]>("get_changelog"),

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
