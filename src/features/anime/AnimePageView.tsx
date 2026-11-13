import React from "react";
import { ChevronRight, X } from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { useAnimeTitle } from "@/contexts/titles";
import { AnimePage, EntryCallbacks } from "./AnimePage";

/**
 * The full anime page as a sheet over the main area: the tab underneath stays mounted (its scroll,
 * filters and selection wait there), the sidebar stays usable. Esc or the X closes it.
 */
export const AnimePageView: React.FC<{
  anime: AnimeEntry;
  inList: boolean;
  listById: Map<number, AnimeEntry>;
  callbacks: EntryCallbacks;
  /** Label of the tab underneath ("Watchlist") */
  fromLabel: string;
  onOpenSeason: (season: string, year: number) => void;
  onClose: () => void;
}> = ({ anime, inList, listById, callbacks, fromLabel, onOpenSeason, onClose }) => {
  const titleOf = useAnimeTitle();
  return (
    <div
      role="dialog"
      aria-label={titleOf(anime)}
      className="absolute inset-0 z-30 flex flex-col bg-bg-primary shadow-[0_-8px_32px_rgba(0,0,0,0.35)] animate-sheet-in"
    >
      <div className="flex items-center gap-2 px-4 h-11 shrink-0 border-b border-border-subtle bg-bg-secondary/80 backdrop-blur-sm min-w-0">
        <button
          onClick={onClose}
          title={`Back to ${fromLabel} (Esc)`}
          className="text-xs font-medium text-text-secondary hover:text-accent transition shrink-0"
        >
          {fromLabel}
        </button>
        <ChevronRight className="w-3.5 h-3.5 text-text-muted shrink-0" />
        <span className="text-xs font-semibold text-text-primary truncate flex-1">{titleOf(anime)}</span>
        <button
          onClick={onClose}
          title="Close (Esc)"
          className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {/* Keyed: another anime opened here starts at the top */}
      <div key={anime.id} className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <AnimePage
          anime={anime}
          inList={inList}
          listById={listById}
          onOpenSeason={onOpenSeason}
          callbacks={callbacks}
        />
      </div>
    </div>
  );
};
