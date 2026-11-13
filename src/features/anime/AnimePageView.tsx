import React from "react";
import { ChevronLeft, X } from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { useAnimeTitle } from "@/contexts/titles";
import { AnimePage, EntryCallbacks } from "./AnimePage";

/**
 * The full anime page as a sheet over the main area (App's sheet layer slides it in): the tab underneath stays mounted (its scroll,
 * filters and selection wait there), the sidebar stays usable. Esc, the back pill or the X on the banner
 * closes it.
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
      className="absolute inset-0 flex flex-col bg-bg-primary"
    >
      {/* Keyed: another anime opened here starts at the top */}
      <div key={anime.id} className="relative flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {/* On the banner, scrolling away with it (Esc closes from anywhere) */}
        <div className="absolute top-3 inset-x-4 z-10 flex items-center justify-between gap-2 pointer-events-none">
          <button
            onClick={onClose}
            title={`Back to ${fromLabel} (Esc)`}
            className="pointer-events-auto flex items-center gap-1 pl-1.5 pr-3 py-1 rounded-full bg-black/45 text-white/90 text-xs font-medium shadow hover:bg-black/65 hover:text-white transition"
          >
            <ChevronLeft className="w-4 h-4" />
            {fromLabel}
          </button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="pointer-events-auto p-1.5 rounded-full bg-black/45 text-white/90 shadow hover:bg-black/65 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
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
