import React, { useState } from "react";
import { HardDrive, Plus } from "lucide-react";
import { AnimeEntry, MediaRelation } from "@/lib/types";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { formatEnum } from "@/lib/anime";
import { STATUS_INFO } from "@/lib/status";
import { useAnimeTitle } from "@/contexts/titles";
import { useAnimeActions } from "@/contexts/animeActions";

/**
 * A small card for an anime the page points to (relations, recommendations, saga): list status, progress
 * and files on disk for list entries; anime not on the list are dimmed, with a quick add to Planning.
 * Click opens the way the user chose (page or quick edit), Ctrl+click the other; nothing is fetched until
 * then (`resolveAnime`). Sized by `className`; `children` are extra overlays (badges, buttons).
 */
export const MediaCard: React.FC<{
  media: MediaRelation;
  /** The list entry, when the anime is on the list */
  entry?: AnimeEntry;
  /** Small accent line above the title ("Sequel", "+42") */
  label?: React.ReactNode;
  /** Not dimmed even when off the list (it is highlighted another way) */
  undimmed?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children?: React.ReactNode;
}> = ({ media: m, entry, label, undimmed, className = "", style, onMouseEnter, onMouseLeave, children }) => {
  const titleOf = useAnimeTitle();
  const { openAnime, openAnimeAlternate, addAnime, resolveAnime } = useAnimeActions();
  const [busy, setBusy] = useState(false);
  const status = entry ? STATUS_INFO[entry.user_status] : undefined;
  const cover = entry?.cover_image || m.cover_image;
  const facts = [
    m.format ? formatEnum(m.format) : null,
    m.year ? String(m.year) : null,
    m.episodes && m.format !== "MOVIE" ? `${m.episodes} eps` : null,
  ].filter(Boolean);

  /** The list entry or full media, with the card disabled while it is fetched */
  const resolve = async (): Promise<AnimeEntry | null> => {
    setBusy(true);
    try {
      return await resolveAnime(m.id);
    } finally {
      setBusy(false);
    }
  };

  const open = async (alternate: boolean) => {
    const target = await resolve();
    if (!target) return;
    if (alternate) openAnimeAlternate(target);
    else openAnime(target);
  };

  const addToPlanning = async () => {
    const media = await resolve();
    if (media) await addAnime(media, "PLANNING");
  };

  return (
    <div
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`group relative flex gap-2.5 p-2 rounded-xl border border-border-subtle bg-bg-primary/60 hover:border-accent/60 transition overflow-hidden ${
        entry || undimmed ? "" : "opacity-75 hover:opacity-100"
      } ${className}`}
    >
      <button
        type="button"
        onClick={(e) => open(e.ctrlKey || e.metaKey)}
        disabled={busy}
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
              draggable={false}
              className="w-full h-full object-cover"
            />
          )}
        </div>
        <div className="min-w-0 flex-1 flex flex-col">
          {label && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-accent truncate">{label}</span>
          )}
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
          onClick={addToPlanning}
          disabled={busy}
          title="Add to Plan to Watch"
          className="absolute top-1.5 right-1.5 p-1 rounded-md bg-bg-tertiary text-text-secondary hover:bg-accent hover:text-white opacity-0 group-hover:opacity-100 transition disabled:cursor-wait"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
      {children}
    </div>
  );
};
