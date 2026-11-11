import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimeEntry } from "@/lib/types";
import { STATUS_INFO } from "@/lib/status";
import { getOptimizedCoverUrl } from "@/lib/covers";
import type { StatusDragState } from "./useStatusDrag";

/** Board order: two rows of three */
const BOARD_STATUSES = ["CURRENT", "PLANNING", "COMPLETED", "REPEATING", "PAUSED", "DROPPED"];
/** Fanned covers in the ghost */
const GHOST_TILT = [-6, 0, 6];

interface StatusDropBoardProps {
  drag: StatusDragState;
  /** The dragged anime, in drag order */
  dragged: AnimeEntry[];
  /** The whole list, for the per-status counts */
  allAnime: AnimeEntry[];
  hoverStatus: string | null;
  ghostRef: (el: HTMLElement | null) => void;
}

/**
 * Shown while anime are dragged in the watchlist: the list area dims and a board of list statuses
 * floats over its center. The status every dragged anime already has can't take the drop.
 */
export const StatusDropBoard: React.FC<StatusDropBoardProps> = ({ drag, dragged, allAnime, hoverStatus, ghostRef }) => {
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

  const sharedStatus =
    dragged.length > 0 && dragged.every((a) => a.user_status === dragged[0].user_status)
      ? dragged[0].user_status
      : null;
  const count = drag.ids.length;
  const { area } = drag;

  return createPortal(
    <>
      <div
        className={`fixed z-[90] flex items-center justify-center bg-bg-primary/60 transition-opacity duration-150 ${shown ? "opacity-100" : "opacity-0"}`}
        style={{ top: area.top, left: area.left, width: area.width, height: area.height }}
      >
        <div
          className={`bg-bg-secondary border border-border-subtle rounded-3xl shadow-2xl p-4 transition-transform duration-150 ease-out ${shown ? "scale-100" : "scale-95"}`}
        >
          <div className="px-1 pb-3 text-xs font-semibold text-text-secondary">
            Move {count === 1 ? "1 anime" : `${count} anime`} to…
          </div>
          <div className="grid grid-cols-3 gap-3">
            {BOARD_STATUSES.map((id) => {
              const info = STATUS_INFO[id];
              const Icon = info.icon;
              const current = id === sharedStatus;
              const hovered = id === hoverStatus;
              return (
                <div
                  key={id}
                  data-drop-status={id}
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
          <div className="pt-3 text-center text-[11px] text-text-muted">Drop on a list · Esc to cancel</div>
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
