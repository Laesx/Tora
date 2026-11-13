import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { AnimeEntry, CustomListMember } from "@/lib/types";
import { buildAnimeSearchIndex, searchAnime } from "@/lib/fuzzy";
import { SEARCH_GROUP_ORDER, statusLabel, WATCHLIST_TABS } from "@/lib/status";
import type { StepSnapshot } from "@/app/useEpisodeStepper";
import { usePrefs } from "@/hooks/usePrefs";
import type { WatchlistGroup } from "./VirtualWatchlist";
import { defaultSortDir, isSortKey, SortDir, watchlistComparator, WatchlistSortKey } from "./sort";

interface WatchlistPrefs {
  sortKey: WatchlistSortKey;
  sortDir: SortDir;
  /** All Anime and custom lists show their anime grouped by status */
  groupByStatus: boolean;
}

const PREFS_KEY = "tora.watchlist.prefs";
const DEFAULT_PREFS: WatchlistPrefs = { sortKey: "updated", sortDir: "desc", groupByStatus: false };

interface WatchlistInputs {
  animeList: AnimeEntry[];
  /** Cards with a pending +1 / -1 sort and filter by these values until it is saved */
  stepSnapshots: Record<number, StepSnapshot>;
  customListMembers: Map<number, CustomListMember>;
  customListNames: string[];
  hiddenFromStatusIds: Set<number>;
  titleOf: (a: AnimeEntry) => string;
  /** `AppSettings.skip_op_ed` (the "Time left" sort) */
  skipOpEd: boolean;
}

/** Rewatching shows under the Watching tab */
const tabOf = (status: string) => (status === "REPEATING" ? "CURRENT" : status);

/** Entries (already in display order) bucketed by status, in `SEARCH_GROUP_ORDER` then any other status */
function groupByStatus(entries: AnimeEntry[], statusOf: (a: AnimeEntry) => string): WatchlistGroup[] {
  const byStatus = new Map<string, AnimeEntry[]>();
  for (const entry of entries) {
    const status = statusOf(entry);
    let bucket = byStatus.get(status);
    if (!bucket) byStatus.set(status, (bucket = []));
    bucket.push(entry);
  }
  const order = [
    ...SEARCH_GROUP_ORDER,
    ...Array.from(byStatus.keys()).filter((st) => !SEARCH_GROUP_ORDER.includes(st)),
  ];
  return order
    .filter((status) => byStatus.has(status))
    .map((status) => ({ status, label: statusLabel(status), items: byStatus.get(status)! }));
}

/** Watchlist filter state (status tab / custom list / search / sort) and the list it selects. */
export function useWatchlist({
  animeList,
  stepSnapshots,
  customListMembers,
  customListNames,
  hiddenFromStatusIds,
  titleOf,
  skipOpEd,
}: WatchlistInputs) {
  const [statusFilter, setStatusFilter] = useState("CURRENT");
  // Selected AniList custom list; replaces the status filter while set
  const [customListFilter, setCustomListFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Sort is a per-device view pref, like the Seasons sort
  const [prefs, updatePrefs] = usePrefs<WatchlistPrefs>(PREFS_KEY, DEFAULT_PREFS, (p) =>
    isSortKey(p.sortKey) && (p.sortDir === "asc" || p.sortDir === "desc") ? p : DEFAULT_PREFS
  );
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
      const tab = tabOf(a.user_status);
      counts[tab] = (counts[tab] || 0) + 1;
    }
    return counts;
  }, [animeList, hiddenFromStatusIds]);

  // Shared by the watchlist search and the command palette; rebuilt only when the list changes
  const searchIndex = useMemo(() => buildAnimeSearchIndex(animeList), [animeList]);
  // Typing stays responsive: filtering re-runs at lower priority than the input itself
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const isSearching = deferredSearchQuery.trim().length > 0;

  // A card with a pending +1 / -1 keeps its place: progress and updated time come from its snapshot
  const compareBySort = useMemo(
    () =>
      watchlistComparator(prefs.sortKey, prefs.sortDir, (a) => ({
        progress: stepSnapshots[a.id]?.initialProgress ?? a.user_progress,
        updatedAt: stepSnapshots[a.id]?.initialUpdatedAt ?? a.updated_at,
        title: titleOf(a),
        skipOpEd,
      })),
    [prefs.sortKey, prefs.sortDir, stepSnapshots, titleOf, skipOpEd]
  );

  // A card with a pending +1 / -1 stays in the group it started in
  const statusOf = useMemo(
    () => (a: AnimeEntry) => stepSnapshots[a.id]?.initialStatus ?? a.user_status,
    [stepSnapshots]
  );

  /** Pick a sort; a new key starts in its natural direction, the same key flips direction */
  const setSort = (key: WatchlistSortKey, dir?: SortDir) =>
    updatePrefs({
      sortKey: key,
      sortDir: dir ?? (key === prefs.sortKey ? (prefs.sortDir === "asc" ? "desc" : "asc") : defaultSortDir(key)),
    });

  // Without a search: the status tab or custom list, in sort order
  const listAnime = useMemo(() => {
    if (isSearching) return [];
    if (customListFilter !== null) {
      return animeList
        .filter((a) => customListMembers.get(a.id)?.lists.includes(customListFilter))
        .sort(compareBySort);
    }
    return animeList
      .filter((a) => {
        if (statusFilter === "ALL") return true;
        if (hiddenFromStatusIds.has(a.id)) return false;
        return tabOf(statusOf(a)) === statusFilter;
      })
      .sort(compareBySort);
  }, [isSearching, animeList, statusFilter, customListFilter, customListMembers, hiddenFromStatusIds, statusOf, compareBySort]);

  // Views that mix statuses (All Anime, a custom list) can be grouped by status
  const canGroup = !isSearching && (customListFilter !== null || statusFilter === "ALL");
  const grouped = canGroup && prefs.groupByStatus;

  // A search is always grouped: matches from every list, best match first and the sort dropdown as the tie-break
  const groups = useMemo((): WatchlistGroup[] | null => {
    if (isSearching) {
      const hits = searchAnime(searchIndex, deferredSearchQuery).sort(
        (a, b) => b.score - a.score || compareBySort(a.item, b.item)
      );
      return groupByStatus(hits.map((h) => h.item), statusOf);
    }
    return grouped ? groupByStatus(listAnime, statusOf) : null;
  }, [isSearching, searchIndex, deferredSearchQuery, compareBySort, grouped, listAnime, statusOf]);

  const filteredAnime = useMemo(() => (groups ? groups.flatMap((g) => g.items) : listAnime), [groups, listAnime]);

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
        WATCHLIST_TABS.some((t) => t.id === tabOf(entry.user_status)) && !hiddenFromStatusIds.has(entry.id)
          ? tabOf(entry.user_status)
          : "ALL"
      );
    }
    setFocusRequest((prev) => ({ id: entry.id, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  /** A renamed custom list stays selected under its new name */
  const followRenamedList = (old: string, name: string) =>
    setCustomListFilter((current) => (current === old ? name : current));

  /** Back: the status tab / custom list and search text the watchlist had */
  const restoreView = (status: string, customList: string | null, search: string) => {
    setStatusFilter(status);
    setCustomListFilter(customList);
    setSearchQuery(search);
  };

  return {
    statusFilter,
    customListFilter,
    searchQuery,
    setSearchQuery,
    deferredSearchQuery,
    isSearching,
    sortKey: prefs.sortKey,
    sortDir: prefs.sortDir,
    setSort,
    skipOpEd,
    focusRequest,
    clearFocusRequest: () => setFocusRequest(null),
    statusCounts,
    searchIndex,
    groups,
    canGroup,
    groupByStatus: prefs.groupByStatus,
    setGroupByStatus: (on: boolean) => updatePrefs({ groupByStatus: on }),
    filteredAnime,
    showStatus,
    showCustomList,
    focusAnime,
    followRenamedList,
    restoreView,
  };
}

export type WatchlistState = ReturnType<typeof useWatchlist>;
