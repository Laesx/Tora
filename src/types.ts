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
  synonyms: string[];
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
  elapsed_seconds: number;
  auto_synced: boolean;
}

export interface FilenameTestResult {
  parsed: AnitomyElements;
  matched_anime_id: number | null;
  matched_anime_title: string | null;
  matched_cover_image: string | null;
}

export interface TorrentItem {
  title: string;
  torrent_url: string;
  magnet_url: string;
  info_hash: string | null;
  size: string;
  seeders: number;
  leechers: number;
  downloads: number;
  pub_date: string;
  is_trusted: boolean;
  provider: string;
  parsed: AnitomyElements;
  matched_anime_id: number | null;
  matched_anime_title: string | null;
  matched_rule_name: string | null;
  matched_rule_action: "highlight" | "auto_download" | "discard" | string | null;
}

export interface TorrentRule {
  id: number;
  name: string;
  enabled: boolean;
  anime_title_filter: string;
  anime_id: number | null;
  release_group: string;
  resolution: string;
  exclude_keywords: string;
  action: "highlight" | "auto_download" | "discard" | string;
  only_unwatched: boolean;
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
  custom_media_player_path: string;
  torrent_provider: string;
  qbittorrent_enabled: boolean;
  qbittorrent_url: string;
  qbittorrent_username: string;
  qbittorrent_password: string;
  qbittorrent_category: string;
  qbittorrent_save_path: string;
  players: PlayerDefinition[];
}

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
