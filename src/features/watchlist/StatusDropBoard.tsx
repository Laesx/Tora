import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ListMinus } from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { STATUS_INFO } from "@/lib/status";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { useCustomLists } from "@/contexts/customLists";
import { dropKey, type StatusDragState } from "./useStatusDrag";

/** Board order: two rows of three */
const BOARD_STATUSES = ["CURRENT", "PLANNING", "COMPLETED", "REPEATING", "PAUSED", "DROPPED"];
/** Fanned covers in the ghost */
const GHOST_TILT = [-6, 0, 6];

interface StatusDropBoardProps {
  drag: StatusDragState;
  /** The dragged anime, in drag order */
  dragged: AnimeEntry[];
  /** The whole list, for the per-status and per-list counts */
  allAnime: AnimeEntry[];
  /** `dropKey` of the tile under the pointer */
  hoverTarget: string | null;
  ghostRef: (el: HTMLElement | null) => void;
  /** The custom list the watchlist shows: a "Remove from list" tile */
  viewingList: string | null;
}

/**
 * Shown while anime are dragged in the watchlist: the list area dims and a board of list statuses
 * floats over its center, with the custom lists below. The status every dragged anime already has,
 * and a list they are all in, can't take the drop. The board never outgrows the area: with many
 * custom lists, only their tiles scroll.
 */
export const StatusDropBoard: React.FC<StatusDropBoardProps> = ({
  drag,
  dragged,
  allAnime,
  hoverTarget,
  ghostRef,
  viewingList,
}) => {
  const customLists = useCustomLists();
  // Fade / scale in on the frame after mount
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of allAnime) out[a.user_status] = (out[a.user_status] || 0) + 1;
    return out;
  }, [allAnime]);
  const listCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const a of allAnime) {
      for (const name of customLists.membership(a.id)?.lists ?? []) out.set(name, (out.get(name) ?? 0) + 1);
    }
    return out;
  }, [allAnime, customLists]);
  /** How many dragged anime are already in each list */
  const draggedIn = useMemo(() => {
    const out = new Map<string, number>();
    for (const a of dragged) {
      for (const name of customLists.membership(a.id)?.lists ?? []) out.set(name, (out.get(name) ?? 0) + 1);
    }
    return out;
  }, [dragged, customLists]);

  const sharedStatus =
    dragged.length > 0 && dragged.every((a) => a.user_status === dragged[0].user_status)
      ? dragged[0].user_status
      : null;
  const count = drag.ids.length;
  const { area } = drag;
  const listNames = customLists.names;
  const showRemove = viewingList !== null && listNames.includes(viewingList);
  const removable = showRemove ? draggedIn.get(viewingList) ?? 0 : 0;
  const removeKey = showRemove ? dropKey({ kind: "unlist", name: viewingList }) : null;

  return createPortal(
    <>
      <div
        className={`fixed z-[90] flex items-center justify-center p-4 bg-bg-primary/60 transition-opacity duration-150 ${shown ? "opacity-100" : "opacity-0"}`}
        style={{ top: area.top, left: area.left, width: area.width, height: area.height }}
      >
        <div
          className={`max-h-full flex flex-col bg-bg-secondary border border-border-subtle rounded-3xl shadow-2xl p-4 transition-transform duration-150 ease-out ${shown ? "scale-100" : "scale-95"}`}
        >
          <div className="shrink-0 px-1 pb-3 text-xs font-semibold text-text-secondary">
            Move {count === 1 ? "1 anime" : `${count} anime`} to…
          </div>
          <div className="shrink-0 grid grid-cols-3 gap-3">
            {BOARD_STATUSES.map((id) => {
              const info = STATUS_INFO[id];
              const Icon = info.icon;
              const current = id === sharedStatus;
              const hovered = dropKey({ kind: "status", status: id }) === hoverTarget;
              return (
                <div
                  key={id}
                  data-drop={dropKey({ kind: "status", status: id })}
                  data-drop-disabled={current ? "true" : undefined}
                  className={`w-44 h-[116px] rounded-2xl border-2 flex flex-col items-center justify-center gap-1.5 transition-[transform,background-color,border-color] duration-100 ${current
                    ? "border-dashed border-border-subtle opacity-50"
                    : hovered
                      ? "scale-[1.04]"
                      : "border-border-subtle bg-bg-tertiary/50"
                    }`}
                  style={
                    hovered
                      ? {
                        borderColor: info.chart,
                        backgroundColor: `color-mix(in srgb, ${info.chart} 18%, transparent)`,
                      }
                      : undefined
                  }
                >
                  <Icon className={`w-6 h-6 transition-transform ${info.color} ${hovered ? "scale-110" : ""}`} />
                  <span className="text-sm font-bold text-text-primary">{info.label}</span>
                  <span className={`text-[11px] font-mono ${hovered ? "text-text-primary" : "text-text-muted"}`}>
                    {current
                      ? "Current"
                      : hovered
                        ? count === 1
                          ? "Move here"
                          : `Move ${count} here`
                        : `${counts[id] || 0} anime`}
                  </span>
                </div>
              );
            })}
          </div>

          {listNames.length > 0 && (
            <div className="min-h-0 flex flex-col mt-3 pt-3 border-t border-border-subtle">
              <div className="shrink-0 px-1 pb-3 text-xs font-semibold text-text-secondary">Custom lists</div>
              {/* Padding (cancelled by the margin) leaves room for a hovered tile's scale-up inside the scroll area */}
              <div className="min-h-0 overflow-y-auto overflow-x-hidden -m-1 p-1 grid grid-cols-3 gap-3">
                {removeKey && (
                  <div
                    data-drop={removeKey}
                    data-drop-disabled={removable === 0 ? "true" : undefined}
                    title={`Remove from "${viewingList}"`}
                    className={`w-44 h-12 px-3 rounded-2xl border-2 flex items-center gap-2 transition-[transform,background-color,border-color] duration-100 ${removable === 0
                      ? "border-dashed border-border-subtle opacity-50"
                      : hoverTarget === removeKey
                        ? "scale-[1.04] border-rose-400 bg-rose-500/15"
                        : "border-border-subtle bg-bg-tertiary/50"
                      }`}
                  >
                    <ListMinus className="w-4 h-4 shrink-0 text-rose-400" />
                    <span className="min-w-0 flex flex-col leading-tight">
                      <span className="text-xs font-bold text-text-primary truncate">Remove from list</span>
                      <span className="text-[10px] text-text-muted truncate">{viewingList}</span>
                    </span>
                  </div>
                )}
                {listNames.map((name) => {
                  const key = dropKey({ kind: "list", name });
                  const already = draggedIn.get(name) ?? 0;
                  const full = already === count;
                  const hovered = key === hoverTarget;
                  return (
                    <div
                      key={name}
                      data-drop={key}
                      data-drop-disabled={full ? "true" : undefined}
                      title={name}
                      className={`w-44 h-12 px-3 rounded-2xl border-2 flex flex-col justify-center leading-tight transition-[transform,background-color,border-color] duration-100 ${full
                        ? "border-dashed border-border-subtle opacity-50"
                        : hovered
                          ? "scale-[1.04] border-accent bg-accent/15"
                          : "border-border-subtle bg-bg-tertiary/50"
                        }`}
                    >
                      <span className="text-xs font-bold text-text-primary truncate">{name}</span>
                      <span className={`text-[10px] font-mono ${hovered ? "text-text-primary" : "text-text-muted"}`}>
                        {full
                          ? "Already in it"
                          : hovered
                            ? `Add ${count - already === 1 ? "here" : `${count - already} here`}`
                            : `${listCounts.get(name) ?? 0} anime`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="shrink-0 pt-3 text-center text-[11px] text-text-muted">Drop on a tile · Esc to cancel</div>
        </div>
      </div>

      {/* Ghost: moved by the drag hook through its ref (no React render per pointer move) */}
      <div ref={ghostRef} className="fixed top-0 left-0 z-[95] pointer-events-none will-change-transform">
        <div className="relative w-[72px] h-[88px]">
          {dragged.slice(0, 3).map((a, i, shownCovers) => (
            <img
              key={a.id}
              src={getOptimizedCoverUrl(a.cover_image, "medium")}
              alt=""
              draggable={false}
              className="absolute left-2 top-1 w-14 h-20 object-cover rounded-lg shadow-xl ring-1 ring-black/40"
              style={{ transform: `rotate(${shownCovers.length === 1 ? 0 : GHOST_TILT[i]}deg)` }}
            />
          ))}
          {count > 1 && (
            <span className="absolute -top-1 -right-1 min-w-6 h-6 px-1.5 rounded-full bg-accent text-white text-xs font-bold flex items-center justify-center shadow">
              {count}
            </span>
          )}
        </div>
      </div>
    </>,
    document.body
  );
};
