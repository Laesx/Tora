import React from "react";
import { Clock, Plus, Star } from "lucide-react";
import { AnimeEntry } from "../types";
import { formatCountdown, getOptimizedCoverUrl } from "../api";

export const LIST_STATUS_META: Record<string, { label: string; badge: string }> = {
  CURRENT: { label: "Watching", badge: "bg-accent text-white" },
  REPEATING: { label: "Rewatching", badge: "bg-violet-500 text-white" },
  PLANNING: { label: "Planning", badge: "bg-sky-500 text-white" },
  COMPLETED: { label: "Completed", badge: "bg-emerald-500 text-white" },
  PAUSED: { label: "Paused", badge: "bg-amber-500 text-black" },
  DROPPED: { label: "Dropped", badge: "bg-rose-500 text-white" },
};

/** Fixed footer height so virtualized grids can compute exact row heights. */
export const POSTER_CARD_FOOTER_HEIGHT = 92;

interface AnimePosterCardProps {
  anime: AnimeEntry;
  /** The user's list entry for this anime, if it is in the list */
  listEntry?: AnimeEntry;
  /** Cover image height in px (width comes from the grid cell) */
  imageHeight?: number;
  onOpen: (anime: AnimeEntry) => void;
  onAdd: (anime: AnimeEntry, status: "CURRENT" | "PLANNING") => void;
}

/** Poster card for remote anime (Seasons / Search): whole card opens the drawer, quick-add when not in the list. */
export const AnimePosterCard: React.FC<AnimePosterCardProps> = ({
  anime,
  listEntry,
  imageHeight,
  onOpen,
  onAdd,
}) => {
  const status = listEntry ? LIST_STATUS_META[listEntry.user_status] : null;
  const countdown = formatCountdown(anime.next_airing_at);

  return (
    <div
      onClick={() => onOpen(anime)}
      className="group bg-bg-primary border border-border-subtle rounded-xl overflow-hidden flex flex-col hover:border-accent/60 transition shadow-sm cursor-pointer"
    >
      <div
        className={`relative w-full bg-bg-tertiary overflow-hidden ${imageHeight ? "" : "aspect-[3/4]"}`}
        style={imageHeight ? { height: imageHeight } : undefined}
      >
        <img
          src={getOptimizedCoverUrl(anime.cover_image, "large")}
          alt={anime.title_romaji}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
        />
        <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/75 text-white text-[10px] font-semibold">
          {anime.format.replace(/_/g, " ")} • {anime.episodes ?? "?"} eps
        </span>
        {anime.average_score ? (
          <span className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-black/75 text-amber-400 text-[11px] font-bold flex items-center gap-1">
            <Star className="w-3 h-3 fill-amber-400" />
            {anime.average_score}%
          </span>
        ) : null}
        <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-end gap-1">
          {status && listEntry && (
            <span
              className={`px-2 py-0.5 rounded-md text-[10px] font-bold shadow ${status.badge}`}
            >
              {status.label}
              {listEntry.user_status !== "PLANNING" &&
                ` • ${listEntry.user_progress}/${listEntry.episodes ?? "?"}`}
            </span>
          )}
          {countdown && anime.next_airing_episode && (
            <span className="px-2 py-0.5 rounded-md bg-black/75 text-emerald-400 text-[10px] font-mono font-semibold flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Ep {anime.next_airing_episode} in {countdown}
            </span>
          )}
        </div>
      </div>

      <div
        className="p-2.5 flex flex-col justify-between gap-1.5 overflow-hidden"
        style={{ height: POSTER_CARD_FOOTER_HEIGHT }}
      >
        <div className="min-w-0">
          <h3
            className="text-xs font-bold text-text-primary line-clamp-2 leading-snug"
            title={anime.title_romaji}
          >
            {anime.title_romaji}
          </h3>
          <p className="text-[10px] text-text-muted mt-0.5 truncate">
            {anime.studios.join(", ") || anime.genres.slice(0, 2).join(", ")}
          </p>
        </div>

        {!listEntry && (
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAdd(anime, "CURRENT");
              }}
              className="py-1 rounded-lg bg-accent hover:bg-accent-hover text-white text-[10px] font-semibold flex items-center justify-center gap-1 transition"
            >
              <Plus className="w-3 h-3" />
              Watching
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAdd(anime, "PLANNING");
              }}
              className="py-1 rounded-lg bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-[10px] font-medium transition"
            >
              + Plan
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
