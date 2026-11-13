import React, { useLayoutEffect, useRef, useState } from "react";
import { ChevronUp, HardDrive, Plus } from "lucide-react";
import { AnimeEntry, MediaRelation } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { formatEnum } from "@/lib/anime";
import { STATUS_INFO } from "@/lib/status";
import { useAnimeTitle } from "@/contexts/titles";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";

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

/**
 * Small cards for anime the page points to (relations, recommendations): list status, progress and
 * files on disk for list entries; anime not on the list are dimmed, with a quick add to Planning.
 * Click opens the way the user chose (page or quick edit), Ctrl+click the other; nothing is fetched until then.
 */
export const MediaCardGrid: React.FC<{
  items: MediaCardItem[];
  listById: Map<number, AnimeEntry>;
  /** Show only this many rows (the last slot a "+N more" tile) until expanded; all when unset */
  maxRows?: number;
}> = ({ items, listById, maxRows }) => {
  const showToast = useToast();
  const titleOf = useAnimeTitle();
  const { openAnime, openAnimeAlternate, addAnime } = useAnimeActions();
  const [busyId, setBusyId] = useState<number | null>(null);
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

  /** The full media of an anime not on the list (stored, or fetched once from AniList). */
  const remoteMedia = async (id: number): Promise<AnimeEntry | null> => {
    setBusyId(id);
    try {
      const media = await toraApi.getMediaMetadata(id);
      if (!media) showToast("AniList has no data for this anime", "error");
      return media;
    } catch (e) {
      showToast(String(e), "error");
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const open = async (m: MediaRelation, alternate: boolean) => {
    const target = listById.get(m.id) ?? (await remoteMedia(m.id));
    if (!target) return;
    if (alternate) openAnimeAlternate(target);
    else openAnime(target);
  };

  const addToPlanning = async (m: MediaRelation) => {
    const media = await remoteMedia(m.id);
    if (media) await addAnime(media, "PLANNING");
  };

  return (
    <div>
      <div
        ref={gridRef}
        className="grid"
        style={{ gap: CARD_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))` }}
      >
        {shown.map(({ key, media: m, label }) => {
          const entry = listById.get(m.id);
          const status = entry ? STATUS_INFO[entry.user_status] : undefined;
          const cover = entry?.cover_image ?? m.cover_image;
          const facts = [
            m.format ? formatEnum(m.format) : null,
            m.year ? String(m.year) : null,
            m.episodes && m.format !== "MOVIE" ? `${m.episodes} eps` : null,
          ].filter(Boolean);
          return (
            <div
              key={key}
              className={`group relative flex gap-2.5 p-2 rounded-xl border border-border-subtle bg-bg-primary/60 hover:border-accent/60 transition overflow-hidden ${CARD_HEIGHT} ${
                entry ? "" : "opacity-75 hover:opacity-100"
              }`}
            >
              <button
                type="button"
                onClick={(e) => open(m, e.ctrlKey || e.metaKey)}
                disabled={busyId === m.id}
                title={`${titleOf(entry ?? m)}${entry ? "" : " (not in your list)"}\nCtrl+click: the other view`}
                className="flex gap-2.5 min-w-0 flex-1 text-left disabled:cursor-wait"
              >
                <div className="w-12 h-full shrink-0 rounded-md overflow-hidden bg-bg-tertiary">
                  {cover && (
                    <img
                      src={getOptimizedCoverUrl(cover, "medium")}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1 flex flex-col">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-accent truncate">{label}</span>
                  <span className="text-xs font-medium text-text-primary line-clamp-2 leading-snug">{titleOf(entry ?? m)}</span>
                  <span className="mt-auto flex items-center gap-1.5 text-[10px] text-text-muted min-w-0">
                    {status ? (
                      <span className={`px-1.5 py-px rounded font-semibold shrink-0 ${status.badge}`}>
                        {status.shortLabel}
                        {entry && entry.user_progress > 0 && entry.user_status !== "COMPLETED"
                          ? ` ${entry.user_progress}/${entry.episodes ?? "?"}`
                          : ""}
                      </span>
                    ) : (
                      <span className="shrink-0 italic">Not in list</span>
                    )}
                    {entry && entry.local_episode_count > 0 && (
                      <span title={`${entry.available_episodes.length} episodes on disk`} className="shrink-0">
                        <HardDrive className="w-3 h-3 text-emerald-400" />
                      </span>
                    )}
                    <span className="truncate">{facts.join(" · ")}</span>
                  </span>
                </div>
              </button>
              {!entry && (
                <button
                  type="button"
                  onClick={() => addToPlanning(m)}
                  disabled={busyId === m.id}
                  title="Add to Plan to Watch"
                  className="absolute top-1.5 right-1.5 p-1 rounded-md bg-bg-tertiary text-text-secondary hover:bg-accent hover:text-white opacity-0 group-hover:opacity-100 transition disabled:cursor-wait"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
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
