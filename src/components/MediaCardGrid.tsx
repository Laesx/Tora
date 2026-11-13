import React, { useLayoutEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { AnimeEntry, MediaRelation } from "@/lib/types";
import { MediaCard } from "./MediaCard";

export interface MediaCardItem {
  key: string;
  media: MediaRelation;
  /** Small accent line above the title ("Sequel", "+42") */
  label: string;
}

/** Fixed card height, so the grid never reflows while covers load. */
const CARD_HEIGHT = "h-[88px]";
/** Narrowest card and the gap between cards (px): the grid fits as many as these allow. */
const CARD_MIN_WIDTH = 230;
const CARD_GAP = 8;

/** A grid of `MediaCard`s for anime the page points to (relations, recommendations). */
export const MediaCardGrid: React.FC<{
  items: MediaCardItem[];
  listById: Map<number, AnimeEntry>;
  /** Show only this many rows (the last slot a "+N more" tile) until expanded; all when unset */
  maxRows?: number;
}> = ({ items, listById, maxRows }) => {
  const [expanded, setExpanded] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [perRow, setPerRow] = useState(4);

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el || !maxRows) return;
    const measure = () => setPerRow(Math.max(1, Math.floor((el.clientWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxRows]);

  // Limited: the last slot of the last row becomes a "+N" tile, so the grid keeps its height
  const overflows = maxRows !== undefined && items.length > perRow * maxRows;
  const shown = overflows && !expanded ? items.slice(0, perRow * maxRows - 1) : items;

  return (
    <div>
      <div
        ref={gridRef}
        className="grid"
        style={{ gap: CARD_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))` }}
      >
        {shown.map(({ key, media: m, label }) => (
          <MediaCard key={key} media={m} entry={listById.get(m.id)} label={label} className={CARD_HEIGHT} />
        ))}
        {overflows && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Show one row" : `Show all ${items.length}`}
            className={`flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border-subtle text-xs font-semibold text-text-secondary hover:border-accent hover:text-accent transition ${CARD_HEIGHT}`}
          >
            {expanded ? (
              <>
                <ChevronUp className="w-4 h-4" />
                Show fewer
              </>
            ) : (
              `+${items.length - shown.length} more`
            )}
          </button>
        )}
      </div>
    </div>
  );
};
