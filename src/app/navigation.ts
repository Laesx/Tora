import { useEffect, useRef } from "react";
import type { AnimeEntry, HistoryRow, HistorySource } from "@/lib/types";
import type { TorrentSearchRequest } from "@/lib/torrents";
import type { SeasonName } from "@/lib/seasons";
import type { HistoryPeriod } from "@/features/history/period";
import type { TorrentsSubTab } from "@/features/torrents/TorrentsView";
import type { NavTab } from "./nav";

/**
 * What the user would call "the page" in one tab: small and serializable, so it can later back
 * deep links too. Each view turns its own entry back into state (through its `*Request` prop).
 */
export type NavView =
  | { tab: "watchlist"; status: string; customList: string | null; search: string }
  | {
    tab: "history";
    source: HistorySource;
    period: HistoryPeriod | null;
    search: string;
    /** The per-anime episode timeline is open */
    anime: { id: number; title: string } | null;
  }
  | { tab: "seasons"; season: SeasonName; year: number; filter: string }
  | { tab: "search"; query: string }
  | { tab: "torrents"; subTab: TorrentsSubTab; search: TorrentSearchRequest | null }
  | { tab: "schedule"; weekStart: number }
  | { tab: "nowplaying" }
  | { tab: "stats" };

/** Loaded data that makes going back instant; dropped from older entries (it is refetched instead) */
export type NavCache =
  | { tab: "history"; rows: HistoryRow[]; hasMore: boolean }
  | { tab: "search"; results: AnimeEntry[]; searched: string };

export interface NavLocation {
  view: NavView;
  /** The drawer that was open; reopened on back (a remote anime is kept as is) */
  drawer: AnimeEntry | null;
  drawerInList: boolean;
  scrollTop: number;
  cache?: NavCache;
}

export type NavCapture = { view: NavView; cache?: NavCache };

export const sameLocation = (a: NavLocation, b: NavLocation) =>
  (a.drawer?.id ?? null) === (b.drawer?.id ?? null) && JSON.stringify(a.view) === JSON.stringify(b.view);

// The mounted view of each tab registers how to read its current state
const captures = new Map<NavTab, () => NavCapture>();

/** Registers this view's current state for the back / forward history while it is mounted. */
export function useNavCapture(tab: NavTab, capture: () => NavCapture) {
  const ref = useRef(capture);
  ref.current = capture;
  useEffect(() => {
    const read = () => ref.current();
    captures.set(tab, read);
    return () => {
      if (captures.get(tab) === read) captures.delete(tab);
    };
  }, [tab]);
}

/** The mounted view's state, or null when the tab registers none (Stats, Now Playing) */
export const captureView = (tab: NavTab): NavCapture | null => captures.get(tab)?.() ?? null;
