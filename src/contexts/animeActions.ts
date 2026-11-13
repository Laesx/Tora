import { createContext, useContext } from "react";
import { AnimeEntry, BatchAnimeUpdatePatch } from "@/lib/types";
import type { TorrentSearchRequest } from "@/lib/torrents";

/** List mutations and navigation shared by every view; App owns the state behind them. */
export interface AnimeActions {
  /**
   * Opens an anime the way the user chose (`AppSettings.open_anime_with`: the anime page or quick edit).
   * Browsing views use it; views where the anime is a reference inside another task (Torrents, History,
   * Stats, Library) call `openQuickEdit`.
   */
  openAnime: (anime: AnimeEntry) => void;
  /** The other one of `openAnime` (Space, Ctrl+click) */
  openAnimeAlternate: (anime: AnimeEntry) => void;
  /** The quick edit drawer; an anime already in the list opens with its local entry */
  openQuickEdit: (anime: AnimeEntry) => void;
  /** Opens the full anime page in place of the tab content (closes the drawer) */
  openAnimePage: (anime: AnimeEntry) => void;
  /** Opens the saga view of this anime's franchise over the main area (closes the drawer and the page) */
  openSaga: (anime: AnimeEntry) => void;
  /** Opens this anime's episode timeline in the History tab */
  openAnimeHistory: (anime: AnimeEntry) => void;
  /**
   * An AniList id as something the open / add actions take: the list entry, else its full media
   * (stored, or fetched once from AniList). Null (with an error toast) when there is none.
   */
  resolveAnime: (id: number) => Promise<AnimeEntry | null>;
  /** Optimistic, debounced +1 / -1 */
  stepEpisode: (anime: AnimeEntry, delta: number) => void;
  batchUpdate: (patch: BatchAnimeUpdatePatch, summaryToast: string) => Promise<void>;
  /** Single-entry status change with a "Moved … to <label>" toast */
  changeStatus: (anime: AnimeEntry, status: string, label: string) => Promise<void>;
  /** Moves to Rewatching (the backend resets progress to 0), then tries to play episode 1 */
  startRewatch: (anime: AnimeEntry) => Promise<void>;
  batchDelete: (targets: AnimeEntry[]) => Promise<void>;
  deleteAnime: (anime: AnimeEntry) => Promise<void>;
  /** Adds a remote (Seasons / Search / Schedule) anime with an instant optimistic update */
  addAnime: (entry: AnimeEntry, status: "CURRENT" | "PLANNING") => Promise<void>;
  /** `addAnime` for a selection, with one summary toast */
  addAnimeBatch: (entries: AnimeEntry[], status: "CURRENT" | "PLANNING") => Promise<void>;
  /** Closes the drawer and opens the Torrents tab on this search */
  searchTorrents: (req: TorrentSearchRequest) => void;
  /** Closes the drawer and shows this season in the Seasons tab ("SUMMER", 2024) */
  openSeason: (season: string, year: number) => void;
}

const missing = () => {
  throw new Error("AnimeActionsContext is not provided");
};

// App provides a stable object whose functions always call its latest handlers
export const AnimeActionsContext = createContext<AnimeActions>({
  openAnime: missing,
  openAnimeAlternate: missing,
  openQuickEdit: missing,
  openAnimePage: missing,
  openSaga: missing,
  openAnimeHistory: missing,
  resolveAnime: missing,
  stepEpisode: missing,
  batchUpdate: missing,
  changeStatus: missing,
  startRewatch: missing,
  batchDelete: missing,
  deleteAnime: missing,
  addAnime: missing,
  addAnimeBatch: missing,
  searchTorrents: missing,
  openSeason: missing,
});

export const useAnimeActions = () => useContext(AnimeActionsContext);
