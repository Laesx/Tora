export interface AnitomyElements {
  file_name: string;
  file_extension: string | null;
  anime_title: string;
  normalized_title: string;
  anime_season: number | null;
  episode_number: number | null;
  episode_number_alt: number | null;
  episode_version: number | null;
  episode_title: string | null;
  release_group: string | null;
  video_resolution: string | null;
  video_term: string[];
  audio_term: string[];
  source: string | null;
  file_checksum: string | null;
  anime_type: string | null;
  volume_number: number | null;
  is_batch: boolean;
  subtitles: string | null;
}

export interface AnimeEntry {
  id: number;
  anilist_id: number | null;
  mal_id: number | null;
  title_romaji: string;
  title_english: string | null;
  title_native: string | null;
  /** Every matchable alternative title (AniList synonyms + `custom_synonyms`) */
  synonyms: string[];
  /** The user's own aliases (subset of `synonyms`); the only ones edited in the drawer */
  custom_synonyms: string[];
  format: string;
  airing_status: string;
  episodes: number | null;
  duration: number | null;
  season: string | null;
  season_year: number | null;
  average_score: number | null;
  cover_image: string;
  banner_image: string | null;
  cover_color: string | null;
  synopsis: string;
  genres: string[];
  studios: string[];
  next_airing_episode: number | null;
  next_airing_at: number | null;
  trailer_url: string | null;
  site_url: string | null;
  source_material: string | null;
  /** Airing start / end: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` */
  start_date: string | null;
  end_date: string | null;
  // User list state
  user_status: "CURRENT" | "PLANNING" | "COMPLETED" | "PAUSED" | "DROPPED" | "REPEATING" | string;
  user_progress: number;
  user_score: number;
  user_repeats: number;
  user_notes: string;
  user_started_at?: string | null;
  user_completed_at?: string | null;
  custom_folder: string | null;
  updated_at: number;
  // AniList sync state (true while a local change is queued for push / retry)
  sync_pending: boolean;
  anilist_list_entry_id: number | null;
  // Local library state
  local_episode_count: number;
  available_episodes: number[];
}

export interface MediaTag {
  name: string;
  /** Relevance 0–100 */
  rank: number | null;
  is_spoiler: boolean;
}

export interface StudioRef {
  id: number;
  name: string;
  is_main: boolean;
  is_animation_studio: boolean;
}

export interface MediaRanking {
  rank: number;
  kind: "RATED" | "POPULAR" | string;
  all_time: boolean;
  season: string | null;
  year: number | null;
  context: string;
}

/** Non-essential metadata; written by season fetches, fetched once for media without any. */
export interface MediaMetadata {
  mean_score: number | null;
  favourites: number | null;
  tags: MediaTag[];
  studios: StudioRef[];
  rankings: MediaRanking[];
}

/** One anime of a seasonal listing / of the media metadata store (never a list entry by itself). */
export type SeasonalAnime = AnimeEntry & {
  popularity: number | null;
  metadata: MediaMetadata;
};

export interface WatchStats {
  episodes_last_week: number;
  minutes_last_week: number;
  episodes_prev_week: number;
}

export interface SeasonResult {
  season: string;
  year: number;
  fetched_at: number;
  items: SeasonalAnime[];
  from_cache: boolean;
  /** Served from cache but due for a background refresh */
  stale: boolean;
}

/** One episode airing; `media` carries only the light list fields (never a list entry by itself). */
export interface AiringScheduleItem {
  episode: number;
  /** Unix seconds */
  airing_at: number;
  media: AnimeEntry;
  /** ISO country of origin (`JP`, `CN`, `KR`, …) */
  country: string | null;
}

export interface AiringScheduleResult {
  from: number;
  to: number;
  fetched_at: number;
  /** Sorted by `airing_at` */
  items: AiringScheduleItem[];
  from_cache: boolean;
  /** Served from cache but due for a background refresh */
  stale: boolean;
}

export interface CachedSeason {
  season: string;
  year: number;
  fetched_at: number;
}

export interface BatchAnimeUpdatePatch {
  anime_ids: number[];
  user_status?: string | null;
  user_progress?: number | null;
  progress_delta?: number | null;
  mark_completed_progress?: boolean | null;
  user_score?: number | null;
  user_repeats?: number | null;
  user_notes?: string | null;
  notes_mode?: "replace" | "append" | null;
  user_started_at?: string | null;
  user_completed_at?: string | null;
}

export interface LibraryFolder {
  id: number;
  path: string;
  label: string;
  drive_root: string;
  enabled: boolean;
  file_count: number;
  total_bytes: number;
  last_scanned_at: number | null;
  drive_total_bytes: number;
  drive_free_bytes: number;
}

export interface DriveStorageSummary {
  drive_root: string;
  drive_total_bytes: number;
  drive_free_bytes: number;
  anime_bytes: number;
  anime_file_count: number;
  folder_count: number;
}

export interface ScanSummary {
  folders_scanned: number;
  total_files_indexed: number;
  newly_parsed: number;
  removed_files?: number;
  matched_files: number;
  elapsed_ms: number;
  /** Entries whose local files or folder changed (refetch only these) */
  changed_anime_ids: number[];
}

export interface LocalEpisodeFile {
  id: number;
  folder_id: number;
  file_path: string;
  file_name: string;
  drive_root: string;
  file_size: number;
  modified_unix: number;
  parsed_title: string;
  normalized_title: string;
  episode_number: number | null;
  anime_season: number | null;
  release_group: string | null;
  resolution: string | null;
  video_terms: string[];
  audio_terms: string[];
  checksum: string | null;
  matched_anime_id: number | null;
  matched_anime_title: string | null;
  watched: boolean;
}

export interface PlayerDefinition {
  id: string;
  name: string;
  executables: string[];
  window_classes: string[];
  title_prefixes: string[];
  title_suffixes: string[];
  enabled: boolean;
}

export interface DetectedMediaSession {
  player_id: string;
  player_name: string;
  process_id: number;
  executable_path: string;
  raw_window_title: string;
  cleaned_media_title: string;
  parsed: AnitomyElements;
  matched_anime_id: number | null;
  matched_anime_title: string | null;
  matched_cover_image: string | null;
  matched_current_progress: number | null;
  matched_total_episodes: number | null;
  detected_at_unix: number;
  auto_synced: boolean;
  /** Auto mode: unix second the list update fires (only while the countdown runs) */
  update_due_at: number | null;
  /** Seconds left while the countdown is paused (player not focused); null = not started */
  update_remaining_seconds: number | null;
  /** Manual update mode: the episode can be updated with the "Update" button */
  awaiting_confirmation: boolean;
  /** Auto mode, waiting for the player to close: the countdown finished, the update is held */
  waiting_for_close: boolean;
}

export interface FilenameTestResult {
  parsed: AnitomyElements;
  matched_anime_id: number | null;
  matched_anime_title: string | null;
  matched_cover_image: string | null;
}

/** A general feed: any RSS 2.0 torrent feed (Nyaa, SubsPlease, …). */
export interface TorrentFeed {
  id: number;
  name: string;
  enabled: boolean;
  url: string;
}

/** A search feed: a URL template where `%title%` becomes the searched anime's title. */
export interface SearchFeed {
  id: number;
  name: string;
  url: string;
}

export type TorrentFilterAction = "discard" | "select";

export interface TorrentFilter {
  id: number;
  name: string;
  enabled: boolean;
  action: TorrentFilterAction;
  /** Text query (see QUERY_FIELDS); the form editor edits the same string */
  query: string;
  /** Empty = every release */
  anime_ids: number[];
}

export interface PriorityTier {
  id: number;
  query: string;
  enabled: boolean;
}

export interface PriorityConfig {
  tiers: PriorityTier[];
  /** When no tier matches: pick the best other release (true) or nothing */
  fallback_to_best: boolean;
}

export interface BoardOptions {
  /** List statuses (`PLANNING`, `DROPPED`, …) whose anime get no card; a searched-for anime is still shown */
  hidden_statuses: string[];
  /** Search feed chosen in the dropdown next to the search box; null / deleted = the first one */
  search_feed_id: number | null;
}

/** Ordered release groups for one anime; replaces the global tiers, no fallback */
export interface FansubOverride {
  anime_id: number;
  groups: string[];
}

export type QueryOp = "is" | "gt" | "ge" | "lt" | "le";

export interface QueryRow {
  /** Field name, or `text` / `regex` for bare terms */
  field: string;
  op: QueryOp;
  value: string;
  negate: boolean;
}

export interface ParsedQuery {
  text: string;
  any: boolean;
  rows: QueryRow[];
}

export interface ReleaseTraits {
  codec: "hevc" | "avc" | "av1" | null;
  bit_depth: number | null;
  audio: string[];
  dual_audio: boolean;
  source: "web" | "bd" | "dvd" | "tv" | null;
  resolution: number | null;
  batch: boolean;
  episode: number | null;
  episode_end: number | null;
}

export interface BoardRelease {
  key: string;
  title: string;
  torrent_url: string;
  view_url: string;
  magnet_url: string;
  size_label: string;
  size_bytes: number | null;
  seeders: number;
  leechers: number;
  /** The feed reports seeders / leechers (SubsPlease and most non-Nyaa feeds don't) */
  peers_known: boolean;
  downloads: number;
  pub_unix: number | null;
  trusted: boolean;
  remake: boolean;
  group: string | null;
  parsed_title: string;
  episode: number | null;
  episode_end: number | null;
  traits: ReleaseTraits;
  feeds: string[];
  on_disk: boolean;
  watched: boolean;
  /** Already sent to the torrent app this session */
  sent: boolean;
  discarded_by: string | null;
  selected_by: string | null;
  selected: boolean;
  tier: number | null;
  /** A better tier (or the fansub override) covers this episode */
  outside_tier: boolean;
}

export interface AnimeReleaseCard {
  key: string;
  anime_id: number | null;
  title: string;
  cover: string;
  status: string | null;
  progress: number;
  episodes: number | null;
  on_disk_count: number;
  fansub_override: string[] | null;
  releases: BoardRelease[];
}

export interface TorrentBoard {
  cards: AnimeReleaseCard[];
  tier_labels: string[];
  fetched_at: number | null;
  errors: string[];
  groups: string[];
  /** Selected feeds never fetched yet (the board waits for Refresh) */
  unfetched: string[];
}

export interface BoardSource {
  feed_ids?: number[] | null;
  search?: string | null;
  anime_id?: number | null;
}

export interface DownloadRequest {
  key: string;
  title: string;
  torrent_url: string;
  magnet_url: string;
  anime_id: number | null;
  parsed_title: string;
}

export type TorrentClientKind =
  | "qbittorrent"
  | "utorrent"
  | "deluge_console"
  | "picotorrent"
  | "aria2"
  | "transmission_remote"
  | "generic";

export interface DetectedTorrentApp {
  /** Empty: no app found, the system default handler is used */
  path: string;
  kind: TorrentClientKind;
  label: string;
  source: "custom" | "association" | "registry" | "program_files" | "none";
}

export interface DownloadSummary {
  results: { key: string; ok: boolean; message: string; folder: string | null }[];
  app: DetectedTorrentApp;
  bound_anime_ids: number[];
}

export interface SettingsBackupInfo {
  file_name: string;
  created_at: number;
  size_bytes: number;
  summary: string;
}

/** `player_name` of history rows logged from manual progress changes */
export const MANUAL_HISTORY_PLAYER = "Manual";

export interface WatchHistoryEntry {
  id: number;
  anime_id: number | null;
  anime_title: string;
  episode_number: number;
  player_name: string;
  file_name: string;
  scrobbled_to_tracker: boolean;
  timestamp_unix: number;
  /** Correction rows only (a manual progress decrease): progress before; `episode_number` is the new one */
  progress_from: number | null;
}

/** One watched-episode history row (corrections excluded) */
export interface WatchEvent {
  t: number;
  minutes: number;
  player: string;
}

export interface ReadyToWatch {
  anime_id: number;
  unwatched_on_disk: number;
  /** Episode `progress + 1` is on disk */
  next_episode_on_disk: boolean;
}

/** `get_stats`: list totals, backlog and the last 366 days of watch events (rewatches included) */
export interface ListStats {
  total_entries: number;
  status_counts: Record<string, number>;
  episodes_watched: number;
  minutes_watched: number;
  mean_score: number | null;
  scored_count: number;
  planning_episodes: number;
  planning_minutes: number;
  watching_remaining_episodes: number;
  watching_remaining_minutes: number;
  ready_to_watch: ReadyToWatch[];
  logged_episodes: number;
  first_logged_at: number | null;
  watch_events: WatchEvent[];
}

/** One published Tora release from GitHub (`get_changelog`) */
export interface ReleaseNote {
  /** Version without the leading "v" */
  version: string;
  name: string;
  /** ISO 8601 */
  published_at: string;
  html_url: string;
  /** GitHub-rendered (sanitized) release notes */
  body_html: string;
}

/** The anime-relations data in use */
export interface RelationsInfo {
  /** `last_modified` from the file's meta section (YYYY-MM-DD) */
  last_modified: string;
  rule_count: number;
  source: "embedded" | "downloaded";
}

export interface RelationsUpdatedEvent {
  last_modified: string;
}

export interface AppInfo {
  data_dir: string;
  db_path: string;
  db_size_bytes: number;
}

export interface TrackerPluginDescriptor {
  id: string;
  name: string;
  description: string;
  website_url: string;
  oauth_authorize_url: string;
  supports_public_username_sync: boolean;
  supports_oauth_token: boolean;
  supports_seasonal_browse: boolean;
  status: string;
}

export interface TrackerUserProfile {
  user_id: number;
  username: string;
  avatar_url: string | null;
  anime_count: number;
  episodes_watched: number;
  authenticated: boolean;
}

export interface AppSettings {
  theme: string;
  accent_color: string;
  view_mode: "grid" | "compact" | "table";
  active_tracker_plugin: string;
  anilist_username: string;
  anilist_token: string;
  anilist_user_id: number | null;
  anilist_avatar: string | null;
  recognition_enabled: boolean;
  recognition_delay_seconds: number;
  /** "auto": count down, then update the list; "manual": Now Playing offers an Update button */
  update_mode: "auto" | "manual";
  /** Auto mode: hold the update until the media player closes */
  update_wait_for_close: boolean;
  /** Auto mode: the countdown only advances while the media player is focused */
  update_require_focus: boolean;
  /** Show the playing anime as Discord Rich Presence */
  discord_presence_enabled: boolean;
  custom_media_player_path: string;
  /** Torrent app exe; empty = auto-detect */
  torrent_app_path: string;
  /** qBittorrent --category */
  torrent_category: string;
  /** Default download location (per-anime subfolders are created inside) */
  torrent_download_folder: string;
  torrent_create_subfolder: boolean;
  /** Background feed refresh in minutes (0 = manual only) */
  torrent_refresh_minutes: number;
  /** Send auto-selected releases after a background refresh */
  torrent_auto_download: boolean;
  players: PlayerDefinition[];
  /** Which title the UI shows; missing English / Native titles fall back to Romaji */
  title_language: TitleLanguage;
  /** Check GitHub for a new Tora release and newer anime relations on startup */
  check_updates_on_startup: boolean;
  /** Stored settings were unreadable; defaults are in use until a backup is restored */
  settings_recovered?: boolean;
}

export type TitleLanguage = "romaji" | "english" | "native";

export interface SyncSummary {
  added: number;
  updated_from_remote: number;
  kept_local: number;
  deleted: number;
  pushed: number;
  push_failed: number;
  remote_deleted: number;
  deletion_skipped_reason: string | null;
  // Entries added or changed by this sync (full rows)
  changed: AnimeEntry[];
  // Local entry ids deleted by this sync (missing on AniList)
  removed_ids: number[];
  // Custom list names or memberships changed: refetch getCustomLists
  custom_lists_changed: boolean;
}

// AniList custom lists, kept apart from AnimeEntry so search and matching never see them
export interface CustomListMember {
  anime_id: number;
  // In the user's list order
  lists: string[];
  hidden_from_status_lists: boolean;
}

export interface CustomListsState {
  // List names in the user's AniList order
  names: string[];
  // Entries in at least one list or hidden from status lists
  members: CustomListMember[];
}

// One membership edit applied to every id
export interface CustomListChange {
  anime_ids: number[];
  toggles: { name: string; enabled: boolean }[];
  hidden_from_status_lists?: boolean | null;
}

export interface SyncStatus {
  in_progress: boolean;
  last_synced_at: number | null;
  pending_count: number;
  pending_deletions: number;
}

export interface TrackerSyncStartedEvent {
  reason: "startup" | "manual" | "post_auth" | string;
}

export interface TrackerSyncFailedEvent {
  reason: string;
  message: string;
}

export interface TrackerSyncErrorEvent {
  anime_id: number | null;
  media_id: number | null;
  title: string;
  kind: "network" | "rate_limited" | "unauthorized" | "not_found" | "api" | string;
  message: string;
  operation: "save" | "delete" | string;
}

export interface TrackerEntrySyncedEvent {
  entry: AnimeEntry;
}

/** The background refresh sent new episodes to the torrent app */
export interface TorrentAutoDownloadedEvent {
  count: number;
  failed: string[];
  /** Anime whose `custom_folder` was set to their new download folder */
  bound_anime_ids?: number[];
}

/** Result of `sign_out_tracker`: queued changes are sent one last time before the token is cleared. */
export interface SignOutOutcome {
  pushed: number;
  deleted: number;
  /** Changes still queued; they are sent when the same account signs in again. */
  unsent: number;
  settings: AppSettings;
}

/** A different AniList account signed in: the previous account's list data was wiped. */
export interface TrackerAccountSwitchedEvent {
  previous_user_id: number | null;
  user_id: number;
  username: string;
  /** Unsent changes of the previous account that were dropped. */
  discarded_changes: number;
}

export interface ThemePreset {
  id: string;
  name: string;
  isDark: boolean;
  previewBg: string;
  previewCard: string;
  defaultAccent: string;
  description: string;
}
