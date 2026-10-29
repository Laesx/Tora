import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { AnimeEntry, CustomListMember } from "@/lib/types";
import { buildAnimeSearchIndex, searchAnime } from "@/lib/fuzzy";
import { SEARCH_GROUP_ORDER, statusLabel, WATCHLIST_TABS } from "@/lib/status";
import type { StepSnapshot } from "@/app/useEpisodeStepper";
import type { WatchlistGroup } from "./VirtualWatchlist";

export type WatchlistSort = "updated" | "title" | "score" | "progress";

interface WatchlistInputs {
  animeList: AnimeEntry[];
  /** Cards with a pending +1 / -1 sort and filter by these values until it is saved */
  stepSnapshots: Record<number, StepSnapshot>;
  customListMembers: Map<number, CustomListMember>;
  customListNames: string[];
  hiddenFromStatusIds: Set<number>;
  titleOf: (a: AnimeEntry) => string;
}

/** Watchlist filter state (status tab / custom list / search / sort) and the list it selects. */
export function useWatchlist({
  animeList,
  stepSnapshots,
  customListMembers,
  customListNames,
  hiddenFromStatusIds,
  titleOf,
}: WatchlistInputs) {
  const [statusFilter, setStatusFilter] = useState("CURRENT");
  // Selected AniList custom list; replaces the status filter while set
  const [customListFilter, setCustomListFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<WatchlistSort>("updated");
  // Scroll-to-and-select request (e.g. an anime picked in the command palette)
  const [focusRequest, setFocusRequest] = useState<{ id: number; nonce: number } | null>(null);

  // The selected list was deleted on AniList: fall back to Watching
  useEffect(() => {
    if (customListFilter !== null && !customListNames.includes(customListFilter)) {
      setCustomListFilter(null);
      setStatusFilter("CURRENT");
    }
  }, [customListNames, customListFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: animeList.length };
    for (const a of animeList) {
      if (hiddenFromStatusIds.has(a.id)) continue;
      counts[a.user_status] = (counts[a.user_status] || 0) + 1;
    }
    return counts;
  }, [animeList, hiddenFromStatusIds]);

  // Shared by the watchlist search and the command palette; rebuilt only when the list changes
  const searchIndex = useMemo(() => buildAnimeSearchIndex(animeList), [animeList]);
  // Typing stays responsive: filtering re-runs at lower priority than the input itself
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const isSearching = deferredSearchQuery.trim().length > 0;

  const compareBySort = useMemo(() => {
    return (a: AnimeEntry, b: AnimeEntry) => {
      if (sortBy === "title") return titleOf(a).localeCompare(titleOf(b));
      if (sortBy === "score") return b.user_score - a.user_score;
      if (sortBy === "progress") {
        const progA = stepSnapshots[a.id]?.initialProgress ?? a.user_progress;
        const progB = stepSnapshots[b.id]?.initialProgress ?? b.user_progress;
        return progB - progA;
      }
      const updA = stepSnapshots[a.id]?.initialUpdatedAt ?? a.updated_at;
      const updB = stepSnapshots[b.id]?.initialUpdatedAt ?? b.updated_at;
      return updB - updA;
    };
  }, [sortBy, stepSnapshots, titleOf]);

  // With a search: matches from every list, grouped by status (stepping keeps a card in its
  // original group), best match first and the sort dropdown as the tie-break
  const searchGroups = useMemo((): WatchlistGroup[] | null => {
    if (!isSearching) return null;
    const byStatus = new Map<string, { entry: AnimeEntry; score: number }[]>();
    for (const { item, score } of searchAnime(searchIndex, deferredSearchQuery)) {
      const status = stepSnapshots[item.id]?.initialStatus ?? item.user_status;
      let bucket = byStatus.get(status);
      if (!bucket) byStatus.set(status, (bucket = []));
      bucket.push({ entry: item, score });
    }
    const order = [
      ...SEARCH_GROUP_ORDER,
      ...Array.from(byStatus.keys()).filter((st) => !SEARCH_GROUP_ORDER.includes(st)),
    ];
    return order
      .filter((status) => byStatus.has(status))
      .map((status) => ({
        status,
        label: statusLabel(status),
        items: byStatus
          .get(status)!
          .sort((a, b) => b.score - a.score || compareBySort(a.entry, b.entry))
          .map((h) => h.entry),
      }));
  }, [isSearching, searchIndex, deferredSearchQuery, stepSnapshots, compareBySort]);

  const filteredAnime = useMemo(() => {
    if (searchGroups) return searchGroups.flatMap((g) => g.items);
    if (customListFilter !== null) {
      return animeList
        .filter((a) => customListMembers.get(a.id)?.lists.includes(customListFilter))
        .sort(compareBySort);
    }
    return animeList
      .filter((a) => {
        if (statusFilter === "ALL") return true;
        if (hiddenFromStatusIds.has(a.id)) return false;
        return (stepSnapshots[a.id]?.initialStatus ?? a.user_status) === statusFilter;
      })
      .sort(compareBySort);
  }, [
    animeList,
    statusFilter,
    customListFilter,
    customListMembers,
    hiddenFromStatusIds,
    searchGroups,
    stepSnapshots,
    compareBySort,
  ]);

  /** One status tab, search cleared */
  const showStatus = (status: string) => {
    setSearchQuery("");
    setCustomListFilter(null);
    setStatusFilter(status);
  };

  /** One custom list, search cleared */
  const showCustomList = (name: string) => {
    setSearchQuery("");
    setCustomListFilter(name);
  };

  /**
   * Shows an anime and scrolls to it: within the results for `query`, or (no query) in its own
   * status list (All Anime when it is hidden from status lists or has no tab).
   */
  const focusAnime = (entry: AnimeEntry, query: string) => {
    setSearchQuery(query);
    if (!query) {
      setCustomListFilter(null);
      setStatusFilter(
        WATCHLIST_TABS.some((t) => t.id === entry.user_status) && !hiddenFromStatusIds.has(entry.id)
          ? entry.user_status
          : "ALL"
      );
    }
    setFocusRequest((prev) => ({ id: entry.id, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  return {
    statusFilter,
    customListFilter,
    searchQuery,
    setSearchQuery,
    deferredSearchQuery,
    isSearching,
    sortBy,
    setSortBy,
    focusRequest,
    clearFocusRequest: () => setFocusRequest(null),
    statusCounts,
    searchIndex,
    searchGroups,
    filteredAnime,
    showStatus,
    showCustomList,
    focusAnime,
  };
}

export type WatchlistState = ReturnType<typeof useWatchlist>;
