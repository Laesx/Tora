import { createContext, useContext } from "react";
import { AnimeEntry, BatchAnimeUpdatePatch } from "@/lib/types";
import type { TorrentSearchRequest } from "@/lib/torrents";

/** List mutations and navigation shared by every view; App owns the state behind them. */
export interface AnimeActions {
  /** Opens the drawer; an anime already in the list opens with its local entry */
  openAnime: (anime: AnimeEntry) => void;
  /** Optimistic, debounced +1 / -1 */
  stepEpisode: (anime: AnimeEntry, delta: number) => void;
  batchUpdate: (patch: BatchAnimeUpdatePatch, summaryToast: string) => Promise<void>;
  /** Single-entry status change with a "Moved … to <label>" toast */
  changeStatus: (anime: AnimeEntry, status: string, label: string) => Promise<void>;
  batchDelete: (targets: AnimeEntry[]) => Promise<void>;
  deleteAnime: (anime: AnimeEntry) => Promise<void>;
  /** Adds a remote (Seasons / Search / Schedule) anime with an instant optimistic update */
  addAnime: (entry: AnimeEntry, status: "CURRENT" | "PLANNING") => Promise<void>;
  /** Closes the drawer and opens the Torrents tab on this search */
  searchTorrents: (req: TorrentSearchRequest) => void;
}

const missing = () => {
  throw new Error("AnimeActionsContext is not provided");
};

// App provides a stable object whose functions always call its latest handlers
export const AnimeActionsContext = createContext<AnimeActions>({
  openAnime: missing,
  stepEpisode: missing,
  batchUpdate: missing,
  changeStatus: missing,
  batchDelete: missing,
  deleteAnime: missing,
  addAnime: missing,
  searchTorrents: missing,
});

export const useAnimeActions = () => useContext(AnimeActionsContext);
