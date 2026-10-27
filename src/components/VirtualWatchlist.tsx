import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  HardDrive,
  Clock,
  Plus,
  Minus,
  Star,
} from "lucide-react";
import { AnimeEntry, BatchAnimeUpdatePatch } from "../types";
import { formatCountdown, getOptimizedCoverUrl } from "../api";
import { AnimeQuickMenu } from "./AnimeQuickMenu";

interface VirtualWatchlistProps {
  items: AnimeEntry[];
  allAnime: AnimeEntry[];
  viewMode: string;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  selectedAnimeIds: number[];
  onSetSelectedAnimeIds: React.Dispatch<React.SetStateAction<number[]>>;
  quickMenuAnimeId: number | null;
  onSetQuickMenuAnimeId: (id: number | null) => void;
  onOpenAnimeModal: (anime: AnimeEntry) => void;
  onStepEpisode: (anime: AnimeEntry, delta: number) => void;
  onBatchUpdate: (
    patch: BatchAnimeUpdatePatch,
    summaryToast: string
  ) => Promise<void>;
  onBatchDelete: (animeList: AnimeEntry[]) => Promise<void>;
  onSearchTorrents: (query: string) => void;
  onDeleteAnime: (anime: AnimeEntry) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

export const VirtualWatchlist: React.FC<VirtualWatchlistProps> = ({
  items,
  allAnime,
  viewMode,
  scrollContainerRef,
  selectedAnimeIds,
  onSetSelectedAnimeIds,
  quickMenuAnimeId,
  onSetQuickMenuAnimeId,
  onOpenAnimeModal,
  onStepEpisode,
  onBatchUpdate,
  onBatchDelete,
  onSearchTorrents,
  onDeleteAnime,
  showToast,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuWrapperRef = useRef<HTMLDivElement | null>(null);
  const lastClickedIdRef = useRef<number | null>(null);

  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(
    null
  );
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(1080);
  const [viewportHeight, setViewportHeight] = useState<number>(800);
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [listOffsetTop, setListOffsetTop] = useState<number>(0);

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
      onOpenAnimeModal(anime);
    },
    [onOpenAnimeModal, onSetQuickMenuAnimeId]
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

  // Measure container width & scroll viewport height via ResizeObserver
  useLayoutEffect(() => {
    const containerEl = containerRef.current;
    const scrollEl = scrollContainerRef.current;
    if (!containerEl || !scrollEl) return;

    const updateMeasurements = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.clientWidth || 1080);
        setListOffsetTop(containerRef.current.offsetTop || 0);
      }
      if (scrollContainerRef.current) {
        setViewportHeight(scrollContainerRef.current.clientHeight || 800);
        setScrollTop(scrollContainerRef.current.scrollTop || 0);
      }
    };

    updateMeasurements();

    const ro = new ResizeObserver(updateMeasurements);
    ro.observe(containerEl);
    ro.observe(scrollEl);

    return () => ro.disconnect();
  }, [scrollContainerRef, viewMode]);

  // Passive rAF-throttled scroll listener on `<main>`
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl) return;

    let rafId: number | null = null;
    const onScroll = () => {
      if (quickMenuAnimeId !== null) {
        onSetQuickMenuAnimeId(null);
      }
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (scrollContainerRef.current) {
          setScrollTop(scrollContainerRef.current.scrollTop);
        }
        if (containerRef.current) {
          setListOffsetTop(containerRef.current.offsetTop);
        }
      });
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
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
      const cardHeight = imageHeight + 64; // 4px progress bar + 60px footer
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

  const { startRow, endRow, totalRows, visibleItems } = useMemo(() => {
    const total = Math.ceil(items.length / layout.cols);
    if (total === 0) {
      return { startRow: 0, endRow: 0, totalRows: 0, visibleItems: [] };
    }
    const relScroll = Math.max(0, scrollTop - listOffsetTop);
    const overscan = 3;
    const sRow = Math.max(0, Math.floor(relScroll / layout.rowHeight) - overscan);
    const eRow = Math.min(
      total,
      Math.ceil((relScroll + viewportHeight) / layout.rowHeight) + overscan
    );
    const startIdx = sRow * layout.cols;
    const endIdx = Math.min(items.length, eRow * layout.cols);
    return {
      startRow: sRow,
      endRow: eRow,
      totalRows: total,
      visibleItems: items.slice(startIdx, endIdx),
    };
  }, [items, layout, scrollTop, listOffsetTop, viewportHeight]);

  const topSpacerHeight = startRow * layout.rowHeight;
  const bottomSpacerHeight = Math.max(0, (totalRows - endRow) * layout.rowHeight);

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
          onOpenFullModal={(a) => onOpenAnimeModal(a)}
          onStepEpisode={onStepEpisode}
          onBatchUpdate={onBatchUpdate}
          onBatchDelete={onBatchDelete}
          onClearSelection={() => onSetSelectedAnimeIds([])}
          onSearchTorrents={onSearchTorrents}
          onDeleteAnime={onDeleteAnime}
          showToast={showToast}
        />
      </div>,
      document.body
    );

  if (items.length === 0) {
    return (
      <div
        ref={containerRef}
        className="py-16 text-center bg-bg-secondary border border-border-subtle rounded-2xl space-y-3"
      >
        <p className="text-sm font-semibold text-text-primary">
          No anime in this list view
        </p>
        <p className="text-xs text-text-muted">
          Use the Discover tab to add shows or sync your AniList account in Settings.
        </p>
      </div>
    );
  }

  if (viewMode === "grid") {
    return (
      <div ref={containerRef} className="w-full">
        {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          }}
        >
          {visibleItems.map((anime) => {
            const pct = anime.episodes
              ? Math.min(
                100,
                Math.round((anime.user_progress / anime.episodes) * 100)
              )
              : 50;
            const cd = formatCountdown(anime.next_airing_at);
            const isSelected = selectedSet.has(anime.id);

            return (
              <div
                key={anime.id}
                style={{ height: layout.cardHeight }}
                onClick={(e) => handleItemClick(e, anime)}
                onDoubleClick={(e) => handleItemDoubleClick(e, anime)}
                onContextMenu={(e) => handleContextMenu(e, anime)}
                title="Click to select • Ctrl+Click to multi-select • Double-click to open details"
                className={`group relative rounded-2xl overflow-visible flex flex-col cursor-pointer transition-[color,background-color,border-color,box-shadow] shadow-sm hover:shadow-xl ${isSelected
                  ? "bg-accent/10 border border-accent ring-2 ring-accent/40 shadow-lg shadow-accent/10"
                  : "bg-bg-secondary border border-border-subtle hover:border-accent/70"
                  }`}
              >
                <div className="relative flex-1 w-full rounded-t-2xl overflow-hidden bg-bg-tertiary">
                  <img
                    src={getOptimizedCoverUrl(anime.cover_image, "large")}
                    alt={anime.title_romaji}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />

                  {/* Top Left Badges: Disk Episodes & Airing Countdown */}
                  <div className="absolute top-2.5 left-2.5 flex flex-col gap-1 max-w-[calc(100%-20px)]">
                    {anime.local_episode_count > 0 && (
                      <span className="px-2 py-0.5 rounded-md bg-emerald-500/90 text-black text-[10px] font-bold flex items-center gap-1 shadow truncate">
                        <HardDrive className="w-3 h-3 shrink-0" />
                        <span className="truncate">
                          {formatEpisodeRanges(anime.available_episodes)} on disk
                        </span>
                      </span>
                    )}
                    {cd && anime.next_airing_episode && (
                      <span className="px-2 py-0.5 rounded-md bg-black/85 text-emerald-400 text-[10px] font-mono font-semibold flex items-center gap-1 truncate">
                        <Clock className="w-2.5 h-2.5 shrink-0" />
                        <span className="truncate">
                          Ep {anime.next_airing_episode} in {cd}
                        </span>
                      </span>
                    )}
                  </div>

                  {/* Bottom Overlay: Progress & Stepper (-1 / +1) */}
                  <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-white">
                    <span className="text-xs font-mono font-bold">
                      Ep {anime.user_progress} / {anime.episodes ?? "?"}
                    </span>
                    <div
                      className="flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => onStepEpisode(anime, -1)}
                        disabled={anime.user_progress <= 0}
                        className="p-1 rounded-lg bg-black/75 hover:bg-white/20 disabled:opacity-40 disabled:pointer-events-none text-white border border-white/15 transition shadow"
                        title="Decrement Episode (-1)"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onStepEpisode(anime, 1)}
                        className="px-2 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white text-[11px] font-bold flex items-center gap-0.5 shadow transition"
                        title="Increment Episode (+1)"
                      >
                        <Plus className="w-3 h-3" />1
                      </button>
                    </div>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="w-full h-1 bg-bg-tertiary overflow-hidden shrink-0">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {/* Card Footer (fixed 60px height) */}
                <div className="p-3 h-[60px] shrink-0 flex flex-col justify-between">
                  <h3
                    className={`text-xs font-bold line-clamp-1 transition-colors ${isSelected
                      ? "text-accent"
                      : "text-text-primary group-hover:text-accent"
                      }`}
                    title={anime.title_romaji}
                  >
                    {anime.title_romaji}
                  </h3>
                  <div className="flex items-center justify-between text-[11px] text-text-muted">
                    <span className="truncate">
                      {anime.studios[0] || anime.format}
                    </span>
                    {anime.user_score > 0 && (
                      <span className="flex items-center gap-0.5 text-amber-400 font-mono font-semibold shrink-0">
                        <Star className="w-3 h-3 fill-amber-400" />
                        {anime.user_score}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} />}
        {contextMenuPortal}
      </div>
    );
  }

  if (viewMode === "compact") {
    return (
      <div ref={containerRef} className="w-full">
        {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          }}
        >
          {visibleItems.map((anime) => {
            const isSelected = selectedSet.has(anime.id);
            return (
              <div
                key={anime.id}
                style={{ height: layout.cardHeight }}
                onClick={(e) => handleItemClick(e, anime)}
                onDoubleClick={(e) => handleItemDoubleClick(e, anime)}
                onContextMenu={(e) => handleContextMenu(e, anime)}
                title="Click to select • Ctrl+Click to multi-select • Double-click to open details"
                className={`group flex gap-4 p-3.5 rounded-2xl cursor-pointer transition-[color,background-color,border-color,box-shadow] ${isSelected
                  ? "bg-accent/10 border border-accent ring-2 ring-accent/30 shadow-md"
                  : "bg-bg-secondary border border-border-subtle hover:border-accent/60"
                  }`}
              >
                <div className="relative w-20 h-28 shrink-0">
                  <img
                    src={getOptimizedCoverUrl(anime.cover_image, "medium")}
                    alt={anime.title_romaji}
                    loading="lazy"
                    decoding="async"
                    className="w-20 h-28 object-cover rounded-xl"
                  />
                </div>

                <div className="flex-1 min-w-0 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3
                        className={`text-sm font-bold truncate ${isSelected ? "text-accent" : "text-text-primary"
                          }`}
                      >
                        {anime.title_romaji}
                      </h3>
                      <span className="px-2 py-0.5 rounded bg-bg-tertiary text-[10px] font-mono text-text-secondary shrink-0">
                        {anime.format}
                      </span>
                    </div>
                    <p className="text-[11px] text-text-muted line-clamp-2 mt-1">
                      {anime.synopsis}
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-subtle text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-accent">
                        Ep {anime.user_progress} / {anime.episodes ?? "?"}
                      </span>
                      {anime.local_episode_count > 0 && (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-mono">
                          {formatEpisodeRanges(anime.available_episodes)} on disk
                        </span>
                      )}
                    </div>

                    <div
                      className="flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => onStepEpisode(anime, -1)}
                        className="p-1.5 rounded-lg bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onStepEpisode(anime, 1)}
                        className="px-2.5 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold text-xs flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" />1
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
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
            <th className="py-2.5 pl-4 pr-3">Anime Title</th>
            <th className="py-2.5 px-3">Type</th>
            <th className="py-2.5 px-3">Progress</th>
            <th className="py-2.5 px-3">On Disk</th>
            <th className="py-2.5 px-3">Score</th>
            <th className="py-2.5 px-3">Season</th>
            <th className="py-2.5 px-4 text-right">Quick Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {topSpacerHeight > 0 && (
            <tr style={{ height: topSpacerHeight }} aria-hidden="true">
              <td colSpan={7} className="p-0 border-0" />
            </tr>
          )}
          {visibleItems.map((anime) => {
            const pct = anime.episodes
              ? Math.min(
                100,
                Math.round((anime.user_progress / anime.episodes) * 100)
              )
              : 50;
            const isSelected = selectedSet.has(anime.id);

            return (
              <tr
                key={anime.id}
                style={{ height: layout.rowHeight }}
                onClick={(e) => handleItemClick(e, anime)}
                onDoubleClick={(e) => handleItemDoubleClick(e, anime)}
                onContextMenu={(e) => handleContextMenu(e, anime)}
                title="Click to select • Ctrl+Click to multi-select • Double-click to open details"
                className={`cursor-pointer transition-colors ${isSelected
                  ? "bg-accent/15 hover:bg-accent/20 shadow-[inset_3px_0_0_0_rgb(var(--accent-primary))]"
                  : "hover:bg-bg-tertiary/60"
                  }`}
              >
                <td className="py-2 pl-4 pr-3 flex items-center gap-3">
                  <img
                    src={getOptimizedCoverUrl(anime.cover_image, "medium")}
                    alt={anime.title_romaji}
                    loading="lazy"
                    decoding="async"
                    className="w-7 h-10 object-cover rounded shrink-0"
                  />
                  <div className="min-w-0">
                    <div
                      className={`font-semibold truncate max-w-md ${isSelected ? "text-accent" : "text-text-primary"
                        }`}
                    >
                      {anime.title_romaji}
                    </div>
                    <div className="text-[10px] text-text-muted truncate max-w-md">
                      {anime.studios.join(", ")}
                      {anime.user_started_at
                        ? ` • Started ${anime.user_started_at}`
                        : ""}
                    </div>
                  </div>
                </td>
                <td className="py-2 px-3 font-mono text-[11px] text-text-secondary">
                  {anime.format}
                </td>
                <td className="py-2 px-3 w-44">
                  <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                    <span>
                      {anime.user_progress} / {anime.episodes ?? "?"}
                    </span>
                    <span className="text-text-muted">{pct}%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </td>
                <td className="py-2 px-3 font-mono text-[11px]">
                  {anime.local_episode_count > 0 ? (
                    <span className="text-emerald-400 font-semibold">
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
                <td
                  className="py-2 px-4 text-right"
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => onStepEpisode(anime, -1)}
                      className="p-1.5 rounded bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => onStepEpisode(anime, 1)}
                      className="px-2 py-1 rounded bg-accent hover:bg-accent-hover text-white font-mono font-bold text-[11px]"
                    >
                      +1
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {bottomSpacerHeight > 0 && (
            <tr style={{ height: bottomSpacerHeight }} aria-hidden="true">
              <td colSpan={7} className="p-0 border-0" />
            </tr>
          )}
        </tbody>
      </table>
      {contextMenuPortal}
    </div>
  );
};

/**
 * Formats an array of episode numbers into compact ranges (e.g., [1, 2, 3, 5, 8] -> "Ep 1–3, 5, 8").
 */
function formatEpisodeRanges(episodes: number[]): string {
  if (!episodes || episodes.length === 0) return "";
  const sorted = Array.from(
    new Set(episodes.filter((n) => typeof n === "number" && n > 0))
  ).sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr === prev + 1) {
      prev = curr;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = curr;
      prev = curr;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
  return `Ep ${ranges.join(", ")}`;
}

