import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CLOSE_MENUS_EVENT } from "./FloatingQuickMenu";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Play,
  Plus,
  Trash2,
  Tv,
  Pencil,
} from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { openExternal } from "@/lib/anime";
import { LIST_STATUSES } from "@/lib/status";
import { STATUS_INFO } from "@/lib/status";
import { useAnimeTitle } from "@/contexts/titles";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";

interface SeasonAnimeMenuProps {
  /** The remote (season) anime that was right-clicked */
  anime: AnimeEntry;
  /** The user's list entry, if the anime is in the list */
  listEntry?: AnimeEntry;
  /** Cursor position of the right-click */
  anchor: { x: number; y: number };
  onClose: () => void;
  /** The anime page or quick edit (the menu offers both) */
  onOpen: (anime: AnimeEntry, how: "page" | "quick_edit") => void;
  onAdd: (anime: AnimeEntry, status: "CURRENT" | "PLANNING") => void;
  /** Seasons: with 2+ anime here the menu acts on all of them */
  selection?: AnimeEntry[];
  /** Seasons: list entries by id, to split a selection into list / not on list */
  listById?: Map<number, AnimeEntry>;
  onClearSelection?: () => void;
  /** Seasons: "Not interested" rows */
  isNotInterested?: (id: number) => boolean;
  onSetNotInterested?: (targets: AnimeEntry[], hidden: boolean) => void;
}

const itemClass =
  "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/90 disabled:opacity-40 disabled:pointer-events-none transition cursor-pointer";

/** Simplified right-click menu for posters in the Seasons tab (styled like the watchlist's AnimeQuickMenu). */
export const SeasonAnimeMenu: React.FC<SeasonAnimeMenuProps> = ({
  anime,
  listEntry,
  anchor,
  onClose,
  onOpen,
  onAdd,
  selection,
  listById,
  onClearSelection,
  isNotInterested,
  onSetNotInterested,
}) => {
  const { addAnimeBatch, batchDelete, batchUpdate, changeStatus, deleteAnime } = useAnimeActions();
  const showToast = useToast();
  const titleOf = useAnimeTitle();
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ top: anchor.y, left: anchor.x });
  const [statusOpen, setStatusOpen] = useState(false);

  // Keep the menu inside the viewport, also when the status list expands
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - rect.width - 8, anchor.x)),
        top: Math.max(8, Math.min(window.innerHeight - rect.height - 8, anchor.y)),
      });
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor.x, anchor.y]);

  // Close on outside click, Escape, scroll or resize
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = (e: Event) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener(CLOSE_MENUS_EVENT, onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener(CLOSE_MENUS_EVENT, onClose);
    };
  }, [onClose]);

  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  const handleCopyTitle = async () => {
    onClose();
    try {
      await navigator.clipboard.writeText(titleOf(anime));
      showToast(`Copied "${titleOf(anime)}"`, "info");
    } catch {
      showToast("Failed to copy title", "error");
    }
  };

  const handleOpenAniList = async () => {
    onClose();
    try {
      await toraApi.openExternalUrl(anime.site_url || `https://anilist.co/anime/${anime.id}`);
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  const status = listEntry ? STATUS_INFO[listEntry.user_status] : null;
  const hidden = isNotInterested?.(anime.id) ?? false;

  if (selection && selection.length > 1) {
    const inList = selection.flatMap((a) => listById?.get(a.id) ?? []);
    const notInList = selection.filter((a) => !listById?.has(a.id));
    // Undo is offered only when there is nothing left to hide
    const allHidden = notInList.length > 0 && notInList.every((a) => isNotInterested?.(a.id));
    const runBatch = (action: () => void) => () => {
      onClose();
      onClearSelection?.();
      action();
    };

    return createPortal(
      <div
        ref={ref}
        style={{ position: "fixed", top: position.top, left: position.left, zIndex: 100 }}
        className="w-60 rounded-xl bg-bg-secondary/95 backdrop-blur-md border border-border-subtle shadow-2xl py-1.5 text-xs select-none max-h-[calc(100vh-24px)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="px-3 py-1.5 border-b border-border-subtle">
          <div className="font-bold text-text-primary">{selection.length} anime selected</div>
          <div className="text-[10px] text-text-muted font-mono mt-0.5">
            {inList.length} on list • {notInList.length} not on list
          </div>
        </div>

        <div className="py-1">
          {notInList.length > 0 && (
            <>
              <button onClick={runBatch(() => addAnimeBatch(notInList, "CURRENT"))} className={itemClass}>
                <span className="flex items-center gap-2">
                  <Plus className="w-3.5 h-3.5 text-accent" />
                  <span>Add {notInList.length} to Watching</span>
                </span>
              </button>
              <button onClick={runBatch(() => addAnimeBatch(notInList, "PLANNING"))} className={itemClass}>
                <span className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-sky-400" />
                  <span>Add {notInList.length} to Planning</span>
                </span>
              </button>
              {onSetNotInterested && (
                <button onClick={runBatch(() => onSetNotInterested(notInList, !allHidden))} className={itemClass}>
                  <span className="flex items-center gap-2">
                    {allHidden ? (
                      <Eye className="w-3.5 h-3.5 text-text-muted" />
                    ) : (
                      <EyeOff className="w-3.5 h-3.5 text-text-muted" />
                    )}
                    <span>{allHidden ? `Undo not interested (${notInList.length})` : `Not interested (${notInList.length})`}</span>
                  </span>
                </button>
              )}
            </>
          )}

          {inList.length > 0 && (
            <>
              <button onClick={() => setStatusOpen((o) => !o)} className={itemClass}>
                <span className="flex items-center gap-2">
                  <Tv className="w-3.5 h-3.5 text-accent" />
                  <span>Move {inList.length} to List...</span>
                </span>
                {statusOpen ? (
                  <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
                )}
              </button>
              {statusOpen && (
                <div className="mx-2 my-1 p-1.5 rounded-lg bg-bg-primary border border-border-subtle grid grid-cols-2 gap-1">
                  {LIST_STATUSES.map((st) => {
                    const Icon = st.icon;
                    return (
                      <button
                        key={st.id}
                        onClick={runBatch(() =>
                          batchUpdate(
                            { anime_ids: inList.map((a) => a.id), user_status: st.id },
                            `Moved ${inList.length} anime to ${st.label}`
                          )
                        )}
                        className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-left text-text-secondary hover:bg-bg-secondary hover:text-text-primary transition cursor-pointer"
                      >
                        <Icon className={`w-3 h-3 shrink-0 ${st.color}`} />
                        <span className="truncate">{st.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                onClick={runBatch(() => batchDelete(inList))}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-red-500/15 transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Remove {inList.length} from List</span>
              </button>
            </>
          )}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: position.top, left: position.left, zIndex: 100 }}
      className="w-60 rounded-xl bg-bg-secondary/95 backdrop-blur-md border border-border-subtle shadow-2xl py-1.5 text-xs select-none max-h-[calc(100vh-24px)] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Compact Header */}
      <div className="px-3 py-1.5 border-b border-border-subtle">
        <div className="font-bold text-text-primary truncate" title={titleOf(anime)}>
          {titleOf(anime)}
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted font-mono mt-0.5">
          <span>
            {anime.format.replace(/_/g, " ")} • {anime.episodes ?? "?"} eps
          </span>
          {status && listEntry ? (
            <span className={`px-1.5 py-px rounded font-sans font-bold ${status.badge}`}>
              {status.shortLabel}
              {listEntry.user_status !== "PLANNING" &&
                ` ${listEntry.user_progress}/${listEntry.episodes ?? "?"}`}
            </span>
          ) : (
            <span>Not on list</span>
          )}
        </div>
      </div>

      {/* List actions */}
      <div className="py-1">
        {listEntry ? (
          <>
            <button onClick={() => setStatusOpen((o) => !o)} className={itemClass}>
              <span className="flex items-center gap-2">
                <Tv className="w-3.5 h-3.5 text-accent" />
                <span>Move to List...</span>
              </span>
              {statusOpen ? (
                <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
              )}
            </button>

            {statusOpen && (
              <div className="mx-2 my-1 p-1.5 rounded-lg bg-bg-primary border border-border-subtle grid grid-cols-2 gap-1">
                {LIST_STATUSES.map((st) => {
                  const Icon = st.icon;
                  const isCurrent = listEntry.user_status === st.id;
                  return (
                    <button
                      key={st.id}
                      disabled={isCurrent}
                      onClick={run(() => changeStatus(listEntry, st.id, st.label))}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-left transition cursor-pointer ${isCurrent
                        ? "bg-accent/20 text-accent font-bold cursor-default"
                        : "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
                        }`}
                    >
                      <Icon className={`w-3 h-3 shrink-0 ${st.color}`} />
                      <span className="truncate">{st.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            <button onClick={run(() => onAdd(anime, "CURRENT"))} className={itemClass}>
              <span className="flex items-center gap-2">
                <Plus className="w-3.5 h-3.5 text-accent" />
                <span>Add to Watching</span>
              </span>
            </button>
            <button onClick={run(() => onAdd(anime, "PLANNING"))} className={itemClass}>
              <span className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-sky-400" />
                <span>Add to Planning</span>
              </span>
            </button>
            {onSetNotInterested && (
              <button onClick={run(() => onSetNotInterested([anime], !hidden))} className={itemClass}>
                <span className="flex items-center gap-2">
                  {hidden ? (
                    <Eye className="w-3.5 h-3.5 text-text-muted" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5 text-text-muted" />
                  )}
                  <span>{hidden ? "Undo not interested" : "Not interested"}</span>
                </span>
              </button>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border-subtle my-0.5" />

      {/* Details, AniList, Copy & Remove */}
      <div className="py-1">
        <button onClick={run(() => onOpen(anime, "page"))} className={itemClass}>
          <span className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-accent" />
            <span>Open Page</span>
          </span>
        </button>
        <button onClick={run(() => onOpen(anime, "quick_edit"))} className={itemClass}>
          <span className="flex items-center gap-2">
            <Pencil className="w-3.5 h-3.5 text-accent" />
            <span>Quick Edit...</span>
          </span>
        </button>

        <button onClick={handleOpenAniList} className={itemClass}>
          <span className="flex items-center gap-2">
            <ExternalLink className="w-3.5 h-3.5 text-text-muted" />
            <span>Open on AniList</span>
          </span>
        </button>

        {onSetNotInterested && anime.trailer_url && (
          <button
            onClick={run(() => void openExternal(anime.trailer_url!, showToast))}
            className={itemClass}
          >
            <span className="flex items-center gap-2">
              <Play className="w-3.5 h-3.5 text-text-muted" />
              <span>Watch Trailer</span>
            </span>
          </button>
        )}

        <button onClick={handleCopyTitle} className={itemClass}>
          <span className="flex items-center gap-2">
            <Copy className="w-3.5 h-3.5 text-text-muted" />
            <span>Copy Title</span>
          </span>
        </button>

        {listEntry && (
          <button
            onClick={run(() => deleteAnime(listEntry))}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 hover:bg-red-500/15 transition cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Remove from List</span>
          </button>
        )}
      </div>
    </div>,
    document.body
  );
};
