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
  // User list state
  user_status: "CURRENT" | "PLANNING" | "COMPLETED" | "PAUSED" | "DROPPED" | "REPEATING" | string;
  user_progress: number;
  user_score: number;
  user_repeats: number;
  user_notes: string;
  custom_folder: string | null;
  updated_at: number;
  // Local library state
  local_episode_count: number;
  available_episodes: number[];
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
  auto_sync_tracker: boolean;
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

export interface ThemePreset {
  id: string;
  name: string;
  isDark: boolean;
  previewBg: string;
  previewCard: string;
  defaultAccent: string;
  description: string;
}
