import React, { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  LayoutGrid,
  List,
  RefreshCw,
  Rows,
  Search,
  Shuffle,
  X,
} from "lucide-react";
import { AnimeEntry, AppSettings } from "@/lib/types";
import { formatLastSynced } from "@/lib/format";
import { WATCHLIST_TABS } from "@/lib/status";
import { useAnimeActions } from "@/contexts/animeActions";
import { CustomListsChip } from "./CustomListsChip";
import { VirtualWatchlist, WatchlistNav } from "./VirtualWatchlist";
import type { WatchlistState } from "./useWatchlist";
import { SORT_OPTIONS, WatchlistSortKey } from "./sort";

const SORT_GROUPS = Array.from(new Set(SORT_OPTIONS.map((o) => o.group)));

export type ViewMode = AppSettings["view_mode"];

const VIEW_MODES: { id: ViewMode; icon: LucideIcon; title: string }[] = [
  { id: "grid", icon: LayoutGrid, title: "Poster Grid View" },
  { id: "compact", icon: Rows, title: "Detailed Cards View" },
  { id: "table", icon: List, title: "Taiga Classic Dense Table View" },
];

interface WatchlistViewProps {
  watchlist: WatchlistState;
  animeList: AnimeEntry[];
  customListNames: string[];
  customListCounts: Map<string, number>;
  onCreateCustomList: (name: string) => Promise<void>;
  onDeleteCustomList: (name: string) => Promise<void>;
  viewMode: ViewMode;
  /** Undefined until settings are loaded (the switcher is hidden) */
  onViewModeChange?: (mode: ViewMode) => void;
  isSignedIn: boolean;
  isSyncing: boolean;
  lastSyncedAt: number | null;
  onSync: () => void;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  selectedAnimeIds: number[];
  onSetSelectedAnimeIds: React.Dispatch<React.SetStateAction<number[]>>;
  quickMenuAnimeId: number | null;
  onSetQuickMenuAnimeId: (id: number | null) => void;
  /** Owned by App so the global shortcuts can type into the box and move the selection */
  searchInputRef: React.MutableRefObject<HTMLInputElement | null>;
  navRef: React.Ref<WatchlistNav>;
}

/** Anime Watchlist tab: status tabs / custom lists, search, sort, sync, view mode, virtualized list. */
export const WatchlistView: React.FC<WatchlistViewProps> = ({
  watchlist: w,
  animeList,
  customListNames,
  customListCounts,
  onCreateCustomList,
  onDeleteCustomList,
  viewMode,
  onViewModeChange,
  isSignedIn,
  isSyncing,
  lastSyncedAt,
  onSync,
  scrollContainerRef,
  selectedAnimeIds,
  onSetSelectedAnimeIds,
  quickMenuAnimeId,
  onSetQuickMenuAnimeId,
  searchInputRef,
  navRef,
}) => {
  const { openAnime } = useAnimeActions();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // Toolbar height (it wraps on narrow windows): scrolling to a card keeps it below the bar
  const [toolbarHeight, setToolbarHeight] = useState(0);
  // Scrolled: the bar gets its bottom border and shadow
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setToolbarHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) return;
    const onScroll = () => setStuck(scrollEl.scrollTop > 0);
    onScroll();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef]);

  const openRandom = () => {
    if (w.filteredAnime.length === 0) return;
    openAnime(w.filteredAnime[Math.floor(Math.random() * w.filteredAnime.length)]);
  };

  return (
    <div className="px-6 pb-6 max-w-7xl mx-auto">
      {/* Filter & view mode toolbar: stays at the top while the list scrolls */}
      <div
        ref={toolbarRef}
        className={`sticky top-0 z-30 -mx-6 px-6 pt-6 pb-4 mb-0 flex flex-wrap items-center justify-between gap-4 bg-bg-primary/90 backdrop-blur-md border-b transition-[border-color,box-shadow] ${stuck ? "border-border-subtle shadow-lg shadow-black/10" : "border-transparent"
          }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Status tabs */}
        <div className="flex flex-wrap items-center gap-1 bg-bg-secondary p-1 rounded-xl border border-border-subtle">
          {WATCHLIST_TABS.map((tab) => {
            const active = !w.isSearching && w.customListFilter === null && w.statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => w.showStatus(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${active ? "bg-accent text-white shadow-sm" : "text-text-secondary hover:text-text-primary"
                  }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${active ? "bg-black/25 text-white" : "bg-bg-tertiary text-text-muted"
                    }`}
                >
                  {w.statusCounts[tab.id] || 0}
                </span>
              </button>
            );
          })}
          {/* Signed in, the chip shows even with no lists so the first one can be created */}
          {(customListNames.length > 0 || isSignedIn) && (
            <CustomListsChip
              names={customListNames}
              counts={customListCounts}
              active={w.isSearching ? null : w.customListFilter}
              onSelect={w.showCustomList}
              onCreate={isSignedIn ? onCreateCustomList : undefined}
              onDelete={isSignedIn ? onDeleteCustomList : undefined}
            />
          )}
        </div>

        {/* Search, sort, random, sync & view switcher */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              ref={searchInputRef}
              type="text"
              value={w.searchQuery}
              // Esc / ↓ / Enter are handled by the global shortcuts (useGlobalShortcuts)
              onChange={(e) => w.setSearchQuery(e.target.value)}
              placeholder="Search all lists..."
              title="Searches every list; results are grouped by status (Esc clears)"
              className="pl-8 pr-7 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent w-56"
            />
            {w.searchQuery && (
              <button
                onClick={() => {
                  w.setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-text-primary"
                title="Clear search (Esc)"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1">
            <select
              value={w.sortKey}
              onChange={(e) => w.setSort(e.target.value as WatchlistSortKey)}
              className="px-2.5 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary"
              title="Sort (with a search: best match first, then this)"
            >
              {SORT_GROUPS.map((group) => (
                <optgroup key={group} label={group}>
                  {SORT_OPTIONS.filter((o) => o.group === group).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              onClick={() => w.setSort(w.sortKey, w.sortDir === "asc" ? "desc" : "asc")}
              className="p-2 rounded-xl bg-bg-secondary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition"
              title={w.sortDir === "asc" ? "Ascending (click for descending)" : "Descending (click for ascending)"}
            >
              {w.sortDir === "asc" ? (
                <ArrowUpNarrowWide className="w-3.5 h-3.5" />
              ) : (
                <ArrowDownWideNarrow className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          <button
            onClick={openRandom}
            className="p-2 rounded-xl bg-bg-secondary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition"
            title="Pick Random Anime from Current List"
          >
            <Shuffle className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onSync}
            disabled={isSyncing || !isSignedIn}
            className="p-2 rounded-xl bg-bg-secondary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              !isSignedIn
                ? "Sign in to AniList to sync your list"
                : isSyncing
                  ? "Syncing with AniList…"
                  : `Sync from AniList${lastSyncedAt ? ` • Last synced ${formatLastSynced(lastSyncedAt)}` : ""}`
            }
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} />
          </button>

          {onViewModeChange && (
            <div className="flex items-center bg-bg-secondary p-1 rounded-xl border border-border-subtle">
              {VIEW_MODES.map(({ id, icon: Icon, title }) => (
                <button
                  key={id}
                  onClick={() => onViewModeChange(id)}
                  className={`p-1.5 rounded-lg transition ${viewMode === id ? "bg-accent text-white" : "text-text-muted hover:text-text-primary"
                    }`}
                  title={title}
                >
                  <Icon className="w-3.5 h-3.5" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <VirtualWatchlist
        items={w.filteredAnime}
        groups={w.searchGroups}
        searchQuery={w.deferredSearchQuery}
        // Applied once the deferred search has caught up, so it scrolls within the new results
        focusRequest={w.deferredSearchQuery === w.searchQuery ? w.focusRequest : null}
        onFocusHandled={w.clearFocusRequest}
        allAnime={animeList}
        viewMode={viewMode}
        scrollContainerRef={scrollContainerRef}
        selectedAnimeIds={selectedAnimeIds}
        onSetSelectedAnimeIds={onSetSelectedAnimeIds}
        quickMenuAnimeId={quickMenuAnimeId}
        onSetQuickMenuAnimeId={onSetQuickMenuAnimeId}
        navRef={navRef}
        stickyOffset={toolbarHeight}
        sortKey={w.sortKey}
        sortDir={w.sortDir}
        onSort={w.setSort}
      />
    </div>
  );
};
