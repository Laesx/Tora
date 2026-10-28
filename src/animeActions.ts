import type { LucideIcon } from "lucide-react";
import {
  Play,
  History,
  FolderOpen,
  Plus,
  Minus,
  Search,
  Tv,
  Pencil,
  ExternalLink,
  Copy,
  Trash2,
} from "lucide-react";
import { AnimeEntry, BatchAnimeUpdatePatch } from "./types";
import {
  anilistAnimeUrl,
  openAnimeFolder,
  openExternal,
  playLocalEpisode,
} from "./nowPlaying";
import { STATUS_OPTIONS } from "./components/AnimeQuickMenu";

type ShowToast = (msg: string, type?: "success" | "info" | "error") => void;

/** One entry of a keyboard-navigable action menu (command palette → anime actions). */
export interface AnimeAction {
  id: string;
  label: string;
  icon: LucideIcon;
  iconClass?: string;
  /** Short text on the right (episode number, current value) */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Needs a second Enter before running */
  confirm?: boolean;
  /** Keep the menu open after running (e.g. +1 so it can be pressed repeatedly) */
  keepOpen?: boolean;
  run?: () => void;
  /** Submenu, opened with Right / Enter */
  children?: AnimeAction[];
}

export interface AnimeActionHandlers {
  onStepEpisode: (anime: AnimeEntry, delta: number) => void;
  onBatchUpdate: (patch: BatchAnimeUpdatePatch, summaryToast: string) => Promise<void>;
  onOpenDetails: (anime: AnimeEntry) => void;
  onSearchTorrents: (query: string) => void;
  onDeleteAnime: (anime: AnimeEntry) => void;
  showToast: ShowToast;
}

export async function copyAnimeTitle(anime: AnimeEntry, showToast: ShowToast) {
  try {
    await navigator.clipboard.writeText(anime.title_romaji);
    showToast(`Copied "${anime.title_romaji}"`, "info");
  } catch {
    showToast("Failed to copy title", "error");
  }
}

/** Torrent search query for the next episode, e.g. "Sousou no Frieren 05". */
export const nextEpisodeTorrentQuery = (anime: AnimeEntry) =>
  `${anime.title_romaji} ${String(anime.user_progress + 1).padStart(2, "0")}`;

/** Single-anime actions, mirroring the right-click quick menu (inline editors go to the details drawer). */
export function buildAnimeActions(
  anime: AnimeEntry,
  h: AnimeActionHandlers
): AnimeAction[] {
  const nextEp = anime.user_progress + 1;
  const lastEp = anime.user_progress;
  const canStepForward = !anime.episodes || anime.user_progress < anime.episodes;
  const hasFolderOrFiles =
    Boolean(anime.custom_folder?.trim()) || anime.local_episode_count > 0;
  const progress = `Ep ${anime.user_progress}/${anime.episodes ?? "?"}`;

  return [
    {
      id: "play-next",
      label: "Play Next Episode",
      icon: Play,
      iconClass: "text-accent",
      hint: `Ep ${nextEp}${anime.available_episodes.includes(nextEp) ? " • on disk" : ""}`,
      disabled: !canStepForward,
      run: () => void playLocalEpisode(anime, nextEp, h.showToast),
    },
    {
      id: "play-last",
      label: "Play Last Episode",
      icon: History,
      hint: lastEp > 0 ? `Ep ${lastEp}` : undefined,
      disabled: lastEp <= 0,
      run: () => void playLocalEpisode(anime, lastEp, h.showToast),
    },
    {
      id: "open-anilist",
      label: "Open on AniList",
      icon: ExternalLink,
      run: () => void openExternal(anilistAnimeUrl(anime), h.showToast),
    },
    {
      id: "open-folder",
      label: "Open Folder",
      icon: FolderOpen,
      iconClass: "text-amber-400",
      disabled: !hasFolderOrFiles,
      run: () => void openAnimeFolder(anime, h.showToast),
    },
    {
      id: "step-up",
      label: "Increment Episode (+1)",
      icon: Plus,
      iconClass: "text-emerald-400",
      hint: progress,
      disabled: !canStepForward,
      keepOpen: true,
      run: () => h.onStepEpisode(anime, 1),
    },
    {
      id: "step-down",
      label: "Decrement Episode (−1)",
      icon: Minus,
      hint: progress,
      disabled: anime.user_progress <= 0,
      keepOpen: true,
      run: () => h.onStepEpisode(anime, -1),
    },
    {
      id: "search-torrents",
      label: "Search Torrents",
      icon: Search,
      iconClass: "text-accent",
      hint: `#${String(nextEp).padStart(2, "0")}`,
      run: () => h.onSearchTorrents(nextEpisodeTorrentQuery(anime)),
    },
    {
      id: "move-to-list",
      label: "Move to List",
      icon: Tv,
      iconClass: "text-accent",
      hint: STATUS_OPTIONS.find((s) => s.id === anime.user_status)?.label,
      children: STATUS_OPTIONS.map((st) => ({
        id: `status-${st.id}`,
        label: st.label,
        icon: st.icon,
        iconClass: st.color,
        hint: anime.user_status === st.id ? "Current" : undefined,
        disabled: anime.user_status === st.id,
        run: () =>
          void h.onBatchUpdate(
            { anime_ids: [anime.id], user_status: st.id },
            `Moved "${anime.title_romaji}" to ${st.label}`
          ),
      })),
    },
    {
      id: "edit-details",
      label: "Edit Details...",
      icon: Pencil,
      iconClass: "text-accent",
      hint: "score, notes, dates",
      run: () => h.onOpenDetails(anime),
    },
    {
      id: "copy-title",
      label: "Copy Title",
      icon: Copy,
      run: () => void copyAnimeTitle(anime, h.showToast),
    },
    {
      id: "delete",
      label: "Delete from List",
      icon: Trash2,
      danger: true,
      confirm: true,
      run: () => h.onDeleteAnime(anime),
    },
  ];
}
