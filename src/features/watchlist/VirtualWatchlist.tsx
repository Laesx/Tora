import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Plus,
  Minus,
  Star,
  User,
} from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { formatCountdown, formatExactTime, formatRelativeTime } from "@/lib/format";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { AnimeQuickMenu } from "@/components/AnimeQuickMenu";
import { LIST_STATUSES } from "@/lib/status";
import { displayTitle, useAnimeTitle } from "@/contexts/titles";
import { playLocalEpisode } from "@/lib/anime";
import { episodeBar, episodeTotalLabel, formatEpisodeRanges } from "@/lib/episodes";
import { EpisodeProgressBar, ReadyBadge } from "@/components/EpisodeProgressBar";
import { AiringDot } from "@/components/AiringDot";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { useScrollViewport, visibleRange } from "@/hooks/virtual";
import { useNow } from "@/hooks/useNow";
import type { SortDir, WatchlistSortKey } from "./sort";

/** A titled section of the list (search results grouped by status) */
export interface WatchlistGroup {
  status: string;
  label: string;
  items: AnimeEntry[];
}

const GROUP_HEADER_HEIGHT = 40;

export type NavDirection = "left" | "right" | "up" | "down";

/**
 * Keyboard navigation over the rendered cards (driven by the global shortcuts). The selected card
 * also takes keyboard focus, so the search box is left and arrows / Enter / Esc act on the list.
 */
export interface WatchlistNav {
  /** Move the selection; false when there is no card in that direction */
  move(dir: NavDirection): boolean;
  /** Focus the selected card (or select the first one); false when the list is empty */
  enter(): boolean;
}

/** One virtualized row: a group header, or up to `cols` cards starting at `start` in its group */
type ListRow =
  | { kind: "header"; group: WatchlistGroup; top: number; height: number }
  | {
    kind: "items";
    group: WatchlistGroup;
    start: number;
    top: number;
    height: number;
  };

interface VirtualWatchlistProps {
  /** Every rendered anime in display order (groups flattened); used for range selection */
  items: AnimeEntry[];
  /** When set, `items` is rendered in these sections, each under a header */
  groups?: WatchlistGroup[] | null;
  /** Active search text, for the empty state */
  searchQuery?: string;
  /** Scroll this anime into view and select it (re-applied whenever the nonce changes) */
  focusRequest?: { id: number; nonce: number } | null;
  onFocusHandled?: () => void;
  allAnime: AnimeEntry[];
  viewMode: string;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  selectedAnimeIds: number[];
  onSetSelectedAnimeIds: React.Dispatch<React.SetStateAction<number[]>>;
  quickMenuAnimeId: number | null;
  onSetQuickMenuAnimeId: (id: number | null) => void;
  navRef?: React.Ref<WatchlistNav>;
  /** Height of the sticky toolbar over the scroll container; scrolled-to cards stay below it */
  stickyOffset?: number;
  /** Table mode: column headers sort the list */
  sortKey?: WatchlistSortKey;
  sortDir?: SortDir;
  onSort?: (key: WatchlistSortKey) => void;
}

/** Table columns that sort, by header label */
const TABLE_SORT_COLUMNS: { label: string; key: WatchlistSortKey | null; className: string }[] = [
  { label: "Anime Title", key: "title", className: "py-2.5 pl-4 pr-3" },
  { label: "Type", key: "format", className: "py-2.5 px-3" },
  { label: "Progress", key: "progress", className: "py-2.5 px-3" },
  { label: "On Disk", key: "ready", className: "py-2.5 px-3" },
  { label: "Score", key: "score", className: "py-2.5 px-3" },
  { label: "Season", key: "season", className: "py-2.5 px-3" },
  { label: "Updated", key: "updated", className: "py-2.5 px-3" },
  { label: "Quick Actions", key: null, className: "py-2.5 px-4 text-right" },
];

export const VirtualWatchlist: React.FC<VirtualWatchlistProps> = ({
  items,
  groups,
  searchQuery,
  focusRequest,
  onFocusHandled,
  allAnime,
  viewMode,
  scrollContainerRef,
  selectedAnimeIds,
  onSetSelectedAnimeIds,
  quickMenuAnimeId,
  onSetQuickMenuAnimeId,
  navRef,
  stickyOffset = 0,
  sortKey,
  sortDir,
  onSort,
}) => {
  const showToast = useToast();
  const { openAnime, stepEpisode } = useAnimeActions();
  const titleOf = useAnimeTitle();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuWrapperRef = useRef<HTMLDivElement | null>(null);
  const lastClickedIdRef = useRef<number | null>(null);
  // One shared tick for every "last updated" label
  const now = useNow(60_000);

  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(
    null
  );
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const {
    width: containerWidth,
    top: listOffsetTop,
    scrollTop,
    viewportHeight,
  } = useScrollViewport(containerRef, scrollContainerRef);

  const selectedSet = useMemo(
    () => new Set(selectedAnimeIds),
    [selectedAnimeIds]
  );

  const selectedAnimeEntries = useMemo(() => {
    if (selectedAnimeIds.length === 0) return [];
    const byId = new Map<number, AnimeEntry>();
    for (const a of allAnime) {
      byId.set(a.id, a);
    }
    return selectedAnimeIds
      .map((id) => byId.get(id))
      .filter((a): a is AnimeEntry => Boolean(a));
  }, [allAnime, selectedAnimeIds]);

  const handleItemClick = useCallback(
    (e: React.MouseEvent, anime: AnimeEntry) => {
      e.stopPropagation();
      if (quickMenuAnimeId !== null) {
        onSetQuickMenuAnimeId(null);
      }

      const isCtrlOrCmd = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;

      if (isShift && lastClickedIdRef.current !== null) {
        const startIdx = items.findIndex(
          (a) => a.id === lastClickedIdRef.current
        );
        const endIdx = items.findIndex((a) => a.id === anime.id);
        if (startIdx !== -1 && endIdx !== -1) {
          const low = Math.min(startIdx, endIdx);
          const high = Math.max(startIdx, endIdx);
          const rangeIds = items.slice(low, high + 1).map((a) => a.id);
          onSetSelectedAnimeIds((prev) => {
            if (isCtrlOrCmd) {
              return Array.from(new Set([...prev, ...rangeIds]));
            }
            return rangeIds;
          });
          return;
        }
      }

      if (isCtrlOrCmd) {
        onSetSelectedAnimeIds((prev) =>
          prev.includes(anime.id)
            ? prev.filter((id) => id !== anime.id)
            : [...prev, anime.id]
        );
        lastClickedIdRef.current = anime.id;
        return;
      }

      // First single click selects the item
      onSetSelectedAnimeIds([anime.id]);
      lastClickedIdRef.current = anime.id;
    },
    [items, quickMenuAnimeId, onSetQuickMenuAnimeId, onSetSelectedAnimeIds]
  );

  const handleItemDoubleClick = useCallback(
    (e: React.MouseEvent, anime: AnimeEntry) => {
      e.stopPropagation();
      onSetQuickMenuAnimeId(null);
      openAnime(anime);
    },
    [openAnime, onSetQuickMenuAnimeId]
  );

  // Middle click plays the next episode from disk (mousedown is cancelled so WebView2 doesn't start autoscroll)
  const handleMiddleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  }, []);

  const handleAuxClick = useCallback(
    (e: React.MouseEvent, anime: AnimeEntry) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (anime.episodes && anime.user_progress >= anime.episodes) {
        showToast(`All episodes of "${displayTitle(anime)}" are watched`, "info");
        return;
      }
      void playLocalEpisode(anime, anime.user_progress + 1, showToast);
    },
    [showToast]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, anime: AnimeEntry) => {
      e.preventDefault();
      e.stopPropagation();

      // If right-clicked item is not part of the current selection, select only it.
      // If it is already selected, preserve the multi-selection so batch context menu opens.
      if (!selectedSet.has(anime.id)) {
        onSetSelectedAnimeIds([anime.id]);
        lastClickedIdRef.current = anime.id;
      }

      const menuWidth = 256;
      const menuApproxHeight = 360;
      const left = Math.max(
        8,
        Math.min(window.innerWidth - menuWidth - 8, e.clientX)
      );
      const top = Math.max(
        8,
        Math.min(window.innerHeight - menuApproxHeight - 8, e.clientY)
      );
      setMenuAnchor({ x: e.clientX, y: e.clientY });
      setMenuPosition({ top, left });
      onSetQuickMenuAnimeId(anime.id);
    },
    [selectedSet, onSetSelectedAnimeIds, onSetQuickMenuAnimeId]
  );

  useEffect(() => {
    if (!quickMenuAnimeId) {
      setMenuPosition(null);
      setMenuAnchor(null);
    }
  }, [quickMenuAnimeId]);

  // Keep context menu clamped inside viewport even when inline panels expand
  useLayoutEffect(() => {
    const el = menuWrapperRef.current;
    if (!el || !menuAnchor) return;

    const clampToViewport = () => {
      const rect = el.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(window.innerWidth - rect.width - 8, menuAnchor.x)
      );
      const top = Math.max(
        8,
        Math.min(window.innerHeight - rect.height - 8, menuAnchor.y)
      );
      setMenuPosition((prev) => {
        if (prev && Math.abs(prev.top - top) < 1 && Math.abs(prev.left - left) < 1) {
          return prev;
        }
        return { top, left };
      });
    };

    clampToViewport();
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(el);
    return () => ro.disconnect();
  }, [menuAnchor, quickMenuAnimeId]);

  // Scrolling closes the quick menu (it is positioned at the cursor, not attached to the card)
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl || quickMenuAnimeId === null) return;
    const onScroll = () => onSetQuickMenuAnimeId(null);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef, quickMenuAnimeId, onSetQuickMenuAnimeId]);

  // Compute grid columns & exact row heights based on viewMode and containerWidth
  const layout = useMemo(() => {
    if (viewMode === "grid") {
      const cols =
        containerWidth >= 960
          ? 5
          : containerWidth >= 720
            ? 4
            : containerWidth >= 480
              ? 3
              : 2;
      const gap = 16;
      const cardWidth = Math.max(140, (containerWidth - (cols - 1) * gap) / cols);
      const imageHeight = Math.round(cardWidth * (4 / 3));
      const cardHeight = imageHeight + 70; // 10px progress bar + 60px footer
      const rowHeight = cardHeight + gap;
      return { cols, gap, cardHeight, rowHeight };
    }
    if (viewMode === "compact") {
      const cols = containerWidth >= 760 ? 2 : 1;
      const gap = 16;
      const cardHeight = 144;
      const rowHeight = cardHeight + gap;
      return { cols, gap, cardHeight, rowHeight };
    }
    // "table" mode
    return { cols: 1, gap: 0, cardHeight: 56, rowHeight: 56 };
  }, [viewMode, containerWidth]);

  // Row model: group headers + rows of `cols` cards, each with its pixel offset (prefix sums)
  const { rows, totalHeight } = useMemo(() => {
    const sections = groups ?? [{ status: "", label: "", items }];
    const out: ListRow[] = [];
    let top = 0;
    for (const group of sections) {
      if (groups) {
        out.push({ kind: "header", group, top, height: GROUP_HEADER_HEIGHT });
        top += GROUP_HEADER_HEIGHT;
      }
      for (let start = 0; start < group.items.length; start += layout.cols) {
        out.push({ kind: "items", group, start, top, height: layout.rowHeight });
        top += layout.rowHeight;
      }
    }
    return { rows: out, totalHeight: top };
  }, [items, groups, layout]);

  const { startRow, endRow } = useMemo(() => {
    if (rows.length === 0) return { startRow: 0, endRow: 0 };
    const relScroll = Math.max(0, scrollTop - listOffsetTop);
    const overscanPx = 3 * layout.rowHeight;
    const [start, end] = visibleRange(rows, relScroll - overscanPx, relScroll + viewportHeight + overscanPx);
    return { startRow: start, endRow: end };
  }, [rows, layout.rowHeight, scrollTop, listOffsetTop, viewportHeight]);

  const visibleRows = rows.slice(startRow, endRow);
  const lastVisible = visibleRows[visibleRows.length - 1];
  const topSpacerHeight = visibleRows.length > 0 ? visibleRows[0].top : totalHeight;
  const bottomSpacerHeight = lastVisible
    ? Math.max(0, totalHeight - (lastVisible.top + lastVisible.height))
    : 0;
  const rowItems = (row: ListRow & { kind: "items" }) =>
    row.group.items.slice(row.start, row.start + layout.cols);
  const rowKey = (row: ListRow) =>
    row.kind === "header" ? `h-${row.group.status}` : `${row.group.status}-${row.start}`;

  // Scroll a requested anime to the middle of the viewport and select it. Waits until the
  // anime is part of the rendered rows (the list may still be catching up with a new search).
  const handledFocusNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focusRequest || handledFocusNonceRef.current === focusRequest.nonce) return;
    const containerEl = containerRef.current;
    const scrollEl = scrollContainerRef.current;
    if (!containerEl || !scrollEl) return;
    // Right after mount the rows use a default width; wait for the measured layout
    if (Math.abs((containerEl.clientWidth || 1080) - containerWidth) > 1) return;
    const row = rows.find(
      (r) =>
        r.kind === "items" &&
        rowItems(r).some((a) => a.id === focusRequest.id)
    );
    if (!row) return;
    handledFocusNonceRef.current = focusRequest.nonce;
    // Table rows start below the column headers
    const rowsEl = containerEl.querySelector("tbody") ?? containerEl;
    const listTop =
      rowsEl.getBoundingClientRect().top -
      scrollEl.getBoundingClientRect().top +
      scrollEl.scrollTop;
    // Centered in the part of the viewport below the sticky toolbar
    scrollEl.scrollTop = Math.max(
      0,
      listTop + row.top - stickyOffset - (scrollEl.clientHeight - stickyOffset - row.height) / 2
    );
    onSetSelectedAnimeIds([focusRequest.id]);
    lastClickedIdRef.current = focusRequest.id;
    onFocusHandled?.();
  }, [focusRequest, rows, containerWidth]);

  // Card to focus once it is rendered (it may scroll into the virtualized window first)
  const pendingFocusIdRef = useRef<number | null>(null);
  const focusPendingCard = () => {
    const id = pendingFocusIdRef.current;
    if (id === null) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-anime-id="${id}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      pendingFocusIdRef.current = null;
    }
  };
  useEffect(() => {
    // Deselected before it rendered (Esc, a click elsewhere): never steal focus later
    if (pendingFocusIdRef.current !== null && !selectedSet.has(pendingFocusIdRef.current)) {
      pendingFocusIdRef.current = null;
    }
    focusPendingCard();
  });

  const rowIndexOf = (id: number) =>
    rows.findIndex((r) => r.kind === "items" && rowItems(r).some((a) => a.id === id));
  const selectionAnchor = () =>
    lastClickedIdRef.current !== null && selectedSet.has(lastClickedIdRef.current)
      ? lastClickedIdRef.current
      : selectedAnimeIds[selectedAnimeIds.length - 1] ?? null;

  /** Select one card, scroll it just into view (below the sticky toolbar) and focus it */
  const selectAndFocus = (targetId: number) => {
    onSetSelectedAnimeIds([targetId]);
    lastClickedIdRef.current = targetId;
    pendingFocusIdRef.current = targetId;

    const containerEl = containerRef.current;
    const scrollEl = scrollContainerRef.current;
    const idx = rowIndexOf(targetId);
    if (containerEl && scrollEl && idx !== -1) {
      const row = rows[idx];
      // Moving into the first row of a search group also reveals its header
      const prev = rows[idx - 1];
      const rowTop = prev?.kind === "header" ? prev.top : row.top;
      // Table rows start below the column headers
      const rowsEl = containerEl.querySelector("tbody") ?? containerEl;
      const listTop =
        rowsEl.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop;
      const margin = 8;
      // The sticky toolbar covers the top of the viewport
      const top = listTop + rowTop - margin - stickyOffset;
      const bottom = listTop + row.top + row.height + margin;
      if (top < scrollEl.scrollTop) scrollEl.scrollTop = Math.max(0, top);
      else if (bottom > scrollEl.scrollTop + scrollEl.clientHeight)
        scrollEl.scrollTop = bottom - scrollEl.clientHeight;
    }
    focusPendingCard();
  };

  // Arrow keys: ←/→ one card in display order, ↑/↓ one row (group headers are skipped)
  useImperativeHandle(navRef, () => ({
    enter() {
      if (items.length === 0) return false;
      const anchorId = selectionAnchor();
      selectAndFocus(anchorId !== null && rowIndexOf(anchorId) !== -1 ? anchorId : items[0].id);
      return true;
    },
    move(dir) {
      if (items.length === 0) return false;
      const anchorId = selectionAnchor();
      const rowIndex = rowIndexOf;

      let targetId: number | null = null;
      if (anchorId === null || rowIndex(anchorId) === -1) {
        targetId = items[0].id;
      } else if (dir === "left" || dir === "right") {
        const idx = items.findIndex((a) => a.id === anchorId);
        targetId = items[Math.max(0, Math.min(items.length - 1, idx + (dir === "right" ? 1 : -1)))].id;
      } else {
        const from = rowIndex(anchorId);
        const col = rowItems(rows[from] as ListRow & { kind: "items" }).findIndex((a) => a.id === anchorId);
        const step = dir === "down" ? 1 : -1;
        for (let i = from + step; i >= 0 && i < rows.length; i += step) {
          const r = rows[i];
          if (r.kind !== "items") continue;
          const cards = rowItems(r);
          targetId = cards[Math.min(col, cards.length - 1)].id;
          break;
        }
      }
      if (targetId === null) return false;
      selectAndFocus(targetId);
      return true;
    },
  }));

  const activeQuickMenuAnime =
    quickMenuAnimeId !== null
      ? items.find((a) => a.id === quickMenuAnimeId) ??
      allAnime.find((a) => a.id === quickMenuAnimeId) ??
      null
      : null;

  const contextMenuPortal =
    activeQuickMenuAnime &&
    menuPosition &&
    createPortal(
      <div
        ref={menuWrapperRef}
        style={{
          position: "fixed",
          top: menuPosition.top,
          left: menuPosition.left,
          zIndex: 100,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <AnimeQuickMenu
          anime={activeQuickMenuAnime}
          selectedAnime={
            selectedSet.has(activeQuickMenuAnime.id)
              ? selectedAnimeEntries
              : [activeQuickMenuAnime]
          }
          onClose={() => onSetQuickMenuAnimeId(null)}
          onOpenFullModal={(a) => openAnime(a)}
          onClearSelection={() => onSetSelectedAnimeIds([])}
        />
      </div>,
      document.body
    );

  if (items.length === 0) {
    const q = searchQuery?.trim();
    return (
      <div
        ref={containerRef}
        className="py-16 text-center bg-bg-secondary border border-border-subtle rounded-2xl space-y-3"
      >
        <p className="text-sm font-semibold text-text-primary">
          {q ? `No anime in your list match "${q}"` : "No anime in this list view"}
        </p>
        <p className="text-xs text-text-muted">
          {q
            ? "Try fewer letters, or look it up on AniList from the Search tab."
            : "Use the Seasons or Search tab to add shows or sync your AniList account in Settings."}
        </p>
      </div>
    );
  }

  const renderGridCard = (anime: AnimeEntry) => {
    const bar = episodeBar(anime);
    const cd = formatCountdown(anime.next_airing_at);
    const isSelected = selectedSet.has(anime.id);

    return (
      <div
        key={anime.id}
        data-anime-id={anime.id}
        tabIndex={-1}
        style={{ height: layout.cardHeight }}
        onClick={(e) => handleItemClick(e, anime)}
        onDoubleClick={(e) => handleItemDoubleClick(e, anime)}
        onMouseDown={handleMiddleMouseDown}
        onAuxClick={(e) => handleAuxClick(e, anime)}
        onContextMenu={(e) => handleContextMenu(e, anime)}
        className={`group relative rounded-2xl overflow-visible outline-none flex flex-col cursor-pointer transition-[color,background-color,border-color,box-shadow] shadow-sm hover:shadow-xl ${isSelected
          ? "bg-accent/10 border border-accent ring-2 ring-accent/40 shadow-lg shadow-accent/10"
          : "bg-bg-secondary border border-border-subtle hover:border-accent/70"
          }`}
      >
        <div className="relative flex-1 w-full rounded-t-2xl overflow-hidden bg-bg-tertiary">
          <img
            src={getOptimizedCoverUrl(anime.cover_image, "large")}
            alt={titleOf(anime)}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />

          <div className="absolute top-2.5 left-2.5 right-2.5 flex items-start justify-between gap-1.5">
            {/* Top Left: Airing Marker & Countdown (truncates before the scores do) */}
            <div className="flex items-center gap-1.5 min-w-0 h-5">
              <AiringDot anime={anime} onCover />
              {cd && anime.next_airing_episode && (
                <span className="px-2 py-0.5 rounded-md bg-black/85 text-emerald-400 text-[10px] font-mono font-semibold flex items-center gap-1 truncate">
                  <Clock className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">
                    Ep {anime.next_airing_episode} in {cd}
                  </span>
                </span>
              )}
            </div>

            {/* Top Right: pending-sync dot, AniList average above the user's own score */}
            <div className="flex items-start gap-1.5 shrink-0">
              {anime.sync_pending && (
                <PendingSyncDot className="mt-1.5 ring-2 ring-black/60" />
              )}
              {(anime.average_score || anime.user_score > 0) && (
                <div className="flex flex-col items-end gap-1">
                  {anime.average_score ? (
                    <span
                      title="AniList average score"
                      className="px-1.5 py-0.5 rounded-md bg-black/75 text-amber-400 text-[10px] font-mono font-bold flex items-center gap-1"
                    >
                      <Star className="w-2.5 h-2.5 fill-amber-400" />
                      {anime.average_score}%
                    </span>
                  ) : null}
                  {anime.user_score > 0 && (
                    <span
                      title="Your score"
                      className="px-1.5 py-0.5 rounded-md bg-accent/90 text-white text-[10px] font-mono font-bold flex items-center gap-1 shadow"
                    >
                      <User className="w-2.5 h-2.5" />
                      {anime.user_score}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Bottom Overlay: Progress, On-Disk Count & Stepper (-1 / +1) */}
          <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between gap-1.5 text-white">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-mono font-bold truncate">
                Ep {anime.user_progress} / {episodeTotalLabel(anime)}
              </span>
              <ReadyBadge bar={bar} progress={anime.user_progress} tone="overlay" />
            </span>
            <div
              className="flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => stepEpisode(anime, -1)}
                disabled={anime.user_progress <= 0}
                className="p-1 rounded-lg bg-black/75 hover:bg-white/20 disabled:opacity-40 disabled:pointer-events-none text-white border border-white/15 transition shadow"
                title="Decrement Episode (-1)"
              >
                <Minus className="w-3 h-3" />
              </button>
              <button
                onClick={() => stepEpisode(anime, 1)}
                className="px-2 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white text-[11px] font-bold flex items-center gap-0.5 shadow transition"
                title="Increment Episode (+1)"
              >
                <Plus className="w-3 h-3" />1
              </button>
            </div>
          </div>
        </div>

        {/* Progress Bar (watched + episodes on disk) */}
        <EpisodeProgressBar bar={bar} className="w-full h-2.5 shrink-0" />

        {/* Card Footer (fixed 60px height) */}
        <div className="p-3 h-[60px] shrink-0 flex flex-col justify-between">
          <h3
            className={`text-xs font-bold line-clamp-1 transition-colors ${isSelected
              ? "text-accent"
              : "text-text-primary group-hover:text-accent"
              }`}
            title={titleOf(anime)}
          >
            {titleOf(anime)}
          </h3>
          <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
            <span className="truncate">{anime.studios[0] || anime.format}</span>
            {anime.updated_at > 0 && (
              <UpdatedLabel updatedAt={anime.updated_at} now={now} style="short" />
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderCompactCard = (anime: AnimeEntry) => {
    const isSelected = selectedSet.has(anime.id);
    const bar = episodeBar(anime);
    return (
      <div
        key={anime.id}
        data-anime-id={anime.id}
        tabIndex={-1}
        style={{ height: layout.cardHeight }}
        onClick={(e) => handleItemClick(e, anime)}
        onDoubleClick={(e) => handleItemDoubleClick(e, anime)}
        onMouseDown={handleMiddleMouseDown}
        onAuxClick={(e) => handleAuxClick(e, anime)}
        onContextMenu={(e) => handleContextMenu(e, anime)}
        className={`group flex gap-4 p-3.5 rounded-2xl outline-none cursor-pointer transition-[color,background-color,border-color,box-shadow] ${isSelected
          ? "bg-accent/10 border border-accent ring-2 ring-accent/30 shadow-md"
          : "bg-bg-secondary border border-border-subtle hover:border-accent/60"
          }`}
      >
        <div className="relative w-20 h-28 shrink-0">
          <img
            src={getOptimizedCoverUrl(anime.cover_image, "medium")}
            alt={titleOf(anime)}
            loading="lazy"
            decoding="async"
            className="w-20 h-28 object-cover rounded-xl"
          />
          <AiringDot anime={anime} onCover className="absolute top-1.5 left-1.5" />
          {anime.sync_pending && (
            <PendingSyncDot className="absolute top-1.5 right-1.5 ring-2 ring-black/60" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h3
                className={`text-sm font-bold truncate ${isSelected ? "text-accent" : "text-text-primary"
                  }`}
              >
                {titleOf(anime)}
              </h3>
              <span className="px-2 py-0.5 rounded bg-bg-tertiary text-[10px] font-mono text-text-secondary shrink-0">
                {anime.format}
              </span>
            </div>
            {(anime.studios[0] || anime.updated_at > 0) && (
              <div className="flex items-center gap-1 min-w-0 mt-0.5 text-[11px] text-text-muted">
                {anime.studios[0] && <span className="truncate">{anime.studios[0]}</span>}
                {anime.studios[0] && anime.updated_at > 0 && <span aria-hidden="true">·</span>}
                {anime.updated_at > 0 && (
                  <UpdatedLabel updatedAt={anime.updated_at} now={now} icon />
                )}
              </div>
            )}
            <p className="text-[11px] text-text-muted line-clamp-1 mt-1">
              {anime.synopsis}
            </p>
          </div>

          <div>
            <EpisodeProgressBar bar={bar} className="w-full h-2.5 rounded-full" />
            <div className="flex items-center justify-between gap-2 pt-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-accent">
                  Ep {anime.user_progress} / {episodeTotalLabel(anime)}
                </span>
                <ReadyBadge bar={bar} progress={anime.user_progress} />
              </div>

              <div
                className="flex items-center gap-1"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => stepEpisode(anime, -1)}
                  className="p-1.5 rounded-lg bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <button
                  onClick={() => stepEpisode(anime, 1)}
                  className="px-2.5 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold text-xs flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />1
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderTableRow = (anime: AnimeEntry) => {
    const bar = episodeBar(anime);
    const isSelected = selectedSet.has(anime.id);

    return (
      <tr
        key={anime.id}
        data-anime-id={anime.id}
        tabIndex={-1}
        style={{ height: layout.rowHeight }}
        onClick={(e) => handleItemClick(e, anime)}
        onDoubleClick={(e) => handleItemDoubleClick(e, anime)}
        onMouseDown={handleMiddleMouseDown}
        onAuxClick={(e) => handleAuxClick(e, anime)}
        onContextMenu={(e) => handleContextMenu(e, anime)}
        className={`cursor-pointer transition-colors outline-none ${isSelected
          ? "bg-accent/15 hover:bg-accent/20 shadow-[inset_3px_0_0_0_rgb(var(--accent-primary))]"
          : "hover:bg-bg-tertiary/60"
          }`}
      >
        <td className="py-2 pl-4 pr-3 flex items-center gap-3">
          <span className="relative shrink-0">
            <img
              src={getOptimizedCoverUrl(anime.cover_image, "medium")}
              alt={titleOf(anime)}
              loading="lazy"
              decoding="async"
              className="w-7 h-10 object-cover rounded"
            />
            <AiringDot anime={anime} size="sm" onCover className="absolute -top-0.5 -left-0.5" />
          </span>
          <div className="min-w-0">
            <div
              className={`font-semibold truncate max-w-md ${isSelected ? "text-accent" : "text-text-primary"
                }`}
            >
              {anime.sync_pending && (
                <PendingSyncDot className="inline-block mr-1.5 align-middle" />
              )}
              {titleOf(anime)}
            </div>
            <div className="text-[10px] text-text-muted truncate max-w-md">
              {anime.studios.join(", ")}
              {anime.user_started_at ? ` • Started ${anime.user_started_at}` : ""}
            </div>
          </div>
        </td>
        <td className="py-2 px-3 font-mono text-[11px] text-text-secondary">
          {anime.format}
        </td>
        <td className="py-2 px-3 w-44">
          <div className="flex items-center justify-between gap-2 text-[11px] font-mono mb-1">
            <span>
              {anime.user_progress} / {episodeTotalLabel(anime)}
            </span>
            <ReadyBadge bar={bar} progress={anime.user_progress} className="py-0" />
          </div>
          <EpisodeProgressBar bar={bar} className="w-full h-2.5 rounded-full" />
        </td>
        <td className="py-2 px-3 font-mono text-[11px]">
          {anime.local_episode_count > 0 ? (
            <span className="text-text-secondary font-semibold">
              {formatEpisodeRanges(anime.available_episodes)} on disk
            </span>
          ) : (
            <span className="text-text-muted">-</span>
          )}
        </td>
        <td className="py-2 px-3 font-mono font-bold text-amber-400">
          {anime.user_score > 0 ? anime.user_score : "-"}
        </td>
        <td className="py-2 px-3 text-[11px] text-text-secondary">
          {anime.season || ""} {anime.season_year || ""}
        </td>
        <td className="py-2 px-3 text-[11px] text-text-secondary whitespace-nowrap">
          {anime.updated_at > 0 ? (
            <UpdatedLabel updatedAt={anime.updated_at} now={now} />
          ) : (
            <span className="text-text-muted">-</span>
          )}
        </td>
        <td
          className="py-2 px-4 text-right"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={() => stepEpisode(anime, -1)}
              className="p-1.5 rounded bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary"
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              onClick={() => stepEpisode(anime, 1)}
              className="px-2 py-1 rounded bg-accent hover:bg-accent-hover text-white font-mono font-bold text-[11px]"
            >
              +1
            </button>
          </div>
        </td>
      </tr>
    );
  };

  if (viewMode === "grid" || viewMode === "compact") {
    const renderCard = viewMode === "grid" ? renderGridCard : renderCompactCard;
    return (
      <div ref={containerRef} className="w-full">
        {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}
        {visibleRows.map((row) =>
          row.kind === "header" ? (
            <div
              key={rowKey(row)}
              style={{ height: row.height }}
              className="flex items-end pb-2.5 px-1"
            >
              <GroupHeading group={row.group} />
            </div>
          ) : (
            <div
              key={rowKey(row)}
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                columnGap: layout.gap,
                height: layout.cardHeight,
                marginBottom: layout.gap,
              }}
            >
              {rowItems(row).map(renderCard)}
            </div>
          )
        )}
        {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} />}
        {contextMenuPortal}
      </div>
    );
  }

  // "table" mode (Taiga Classic Dense Table View)
  return (
    <div
      ref={containerRef}
      className="bg-bg-secondary border border-border-subtle rounded-2xl overflow-hidden"
    >
      <table className="w-full text-left border-collapse text-xs">
        <thead className="bg-bg-tertiary text-text-muted uppercase text-[10px]">
          <tr>
            {TABLE_SORT_COLUMNS.map(({ label, key, className }) => {
              const active = key !== null && key === sortKey;
              const SortIcon = sortDir === "asc" ? ArrowUp : ArrowDown;
              return (
                <th key={label} className={className} aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
                  {key && onSort ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSort(key);
                      }}
                      className={`inline-flex items-center gap-1 uppercase transition hover:text-text-primary ${active ? "text-accent" : ""}`}
                      title={active ? "Click to reverse the order" : `Sort by ${label.toLowerCase()}`}
                    >
                      {label}
                      {active && <SortIcon className="w-3 h-3" />}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {topSpacerHeight > 0 && (
            <tr style={{ height: topSpacerHeight }} aria-hidden="true">
              <td colSpan={8} className="p-0 border-0" />
            </tr>
          )}
          {visibleRows.map((row) =>
            row.kind === "header" ? (
              <tr key={rowKey(row)} style={{ height: row.height }} className="bg-bg-primary/40">
                <td colSpan={8} className="px-4 pb-2 align-bottom">
                  <GroupHeading group={row.group} />
                </td>
              </tr>
            ) : (
              rowItems(row).map(renderTableRow)
            )
          )}
          {bottomSpacerHeight > 0 && (
            <tr style={{ height: bottomSpacerHeight }} aria-hidden="true">
              <td colSpan={8} className="p-0 border-0" />
            </tr>
          )}
        </tbody>
      </table>
      {contextMenuPortal}
    </div>
  );
};

/** Status label, icon and count above a group of search results. */
function GroupHeading({ group }: { group: WatchlistGroup }) {
  const option = LIST_STATUSES.find((o) => o.id === group.status);
  const Icon = option?.icon;
  return (
    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-secondary">
      {Icon && <Icon className={`w-3.5 h-3.5 ${option.color}`} />}
      <span>{group.label}</span>
      <span className="px-1.5 py-0.5 rounded-full bg-bg-tertiary text-[10px] font-mono text-text-muted normal-case tracking-normal">
        {group.items.length}
      </span>
    </div>
  );
}

/**
 * Tiny amber dot marking an entry with a local change still queued for AniList.
 */
function PendingSyncDot({ className = "" }: { className?: string }) {
  return (
    <span
      title="Waiting to sync to AniList"
      aria-label="Waiting to sync to AniList"
      className={`w-2 h-2 rounded-full bg-amber-400 shrink-0 ${className}`}
    />
  );
}

/**
 * "3 days ago" for the list entry's last change, exact date and time on hover.
 */
function UpdatedLabel({
  updatedAt,
  now,
  style = "long",
  icon = false,
}: {
  updatedAt: number;
  now: number;
  style?: "short" | "long";
  icon?: boolean;
}) {
  return (
    <span
      title={`Last updated ${formatExactTime(updatedAt)}`}
      className="shrink-0 inline-flex items-center gap-1 whitespace-nowrap"
    >
      {icon && <Clock className="w-3 h-3" />}
      {formatRelativeTime(updatedAt, now, style)}
    </span>
  );
}
