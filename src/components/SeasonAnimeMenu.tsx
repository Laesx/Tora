import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CLOSE_MENUS_EVENT } from "./FloatingQuickMenu";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Info,
  Plus,
  Trash2,
  Tv,
} from "lucide-react";
import { AnimeEntry } from "../types";
import { toraApi } from "../api";
import { STATUS_OPTIONS } from "./AnimeQuickMenu";
import { LIST_STATUS_META } from "./AnimePosterCard";

interface SeasonAnimeMenuProps {
  /** The remote (season) anime that was right-clicked */
  anime: AnimeEntry;
  /** The user's list entry, if the anime is in the list */
  listEntry?: AnimeEntry;
  /** Cursor position of the right-click */
  anchor: { x: number; y: number };
  onClose: () => void;
  onOpen: (anime: AnimeEntry) => void;
  onAdd: (anime: AnimeEntry, status: "CURRENT" | "PLANNING") => void;
  onChangeStatus: (anime: AnimeEntry, status: string, label: string) => void;
  onRemove: (anime: AnimeEntry) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
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
  onChangeStatus,
  onRemove,
  showToast,
}) => {
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
      await navigator.clipboard.writeText(anime.title_romaji);
      showToast(`Copied "${anime.title_romaji}"`, "info");
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

  const status = listEntry ? LIST_STATUS_META[listEntry.user_status] : null;

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
        <div className="font-bold text-text-primary truncate" title={anime.title_romaji}>
          {anime.title_romaji}
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted font-mono mt-0.5">
          <span>
            {anime.format.replace(/_/g, " ")} • {anime.episodes ?? "?"} eps
          </span>
          {status && listEntry ? (
            <span className={`px-1.5 py-px rounded font-sans font-bold ${status.badge}`}>
              {status.label}
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
                {STATUS_OPTIONS.map((st) => {
                  const Icon = st.icon;
                  const isCurrent = listEntry.user_status === st.id;
                  return (
                    <button
                      key={st.id}
                      disabled={isCurrent}
                      onClick={run(() => onChangeStatus(listEntry, st.id, st.label))}
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
          </>
        )}
      </div>

      <div className="border-t border-border-subtle my-0.5" />

      {/* Details, AniList, Copy & Remove */}
      <div className="py-1">
        <button onClick={run(() => onOpen(anime))} className={itemClass}>
          <span className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-accent" />
            <span>View Details</span>
          </span>
        </button>

        <button onClick={handleOpenAniList} className={itemClass}>
          <span className="flex items-center gap-2">
            <ExternalLink className="w-3.5 h-3.5 text-text-muted" />
            <span>Open on AniList</span>
          </span>
        </button>

        <button onClick={handleCopyTitle} className={itemClass}>
          <span className="flex items-center gap-2">
            <Copy className="w-3.5 h-3.5 text-text-muted" />
            <span>Copy Title</span>
          </span>
        </button>

        {listEntry && (
          <button
            onClick={run(() => onRemove(listEntry))}
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
