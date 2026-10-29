import React, { useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { LayoutGrid, List, RefreshCw, Rows, Search, Shuffle, X } from "lucide-react";
import { AnimeEntry, AppSettings } from "@/lib/types";
import { formatLastSynced } from "@/lib/format";
import { WATCHLIST_TABS } from "@/lib/status";
import { useAnimeActions } from "@/contexts/animeActions";
import { CustomListsChip } from "./CustomListsChip";
import { VirtualWatchlist } from "./VirtualWatchlist";
import type { WatchlistState } from "./useWatchlist";

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
}

/** Anime Watchlist tab: status tabs / custom lists, search, sort, sync, view mode, virtualized list. */
export const WatchlistView: React.FC<WatchlistViewProps> = ({
  watchlist: w,
  animeList,
  customListNames,
  customListCounts,
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
}) => {
  const { openAnime } = useAnimeActions();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const openRandom = () => {
    if (w.filteredAnime.length === 0) return;
    openAnime(w.filteredAnime[Math.floor(Math.random() * w.filteredAnime.length)]);
  };

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      {/* Filter & view mode toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4" onClick={(e) => e.stopPropagation()}>
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
          {customListNames.length > 0 && (
            <CustomListsChip
              names={customListNames}
              counts={customListCounts}
              active={w.isSearching ? null : w.customListFilter}
              onSelect={w.showCustomList}
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
              onChange={(e) => w.setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Esc clears; on an empty box it leaves the box. Never reaches the global handler.
                e.stopPropagation();
                if (w.searchQuery) w.setSearchQuery("");
                else e.currentTarget.blur();
              }}
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

          <select
            value={w.sortBy}
            onChange={(e) => w.setSortBy(e.target.value as typeof w.sortBy)}
            className="px-2.5 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary"
          >
            <option value="updated">Sort: Last Updated</option>
            <option value="title">Sort: Title (A-Z)</option>
            <option value="score">Sort: My Score</option>
            <option value="progress">Sort: Progress</option>
          </select>

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
      />
    </div>
  );
};
