import React from "react";
import { ArrowLeft } from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { useAnimeTitle } from "@/contexts/titles";
import { AnimePage, EntryCallbacks } from "./AnimePage";

/** The full anime page in place of the tab content; Back returns to where it was opened from. */
export const AnimePageView: React.FC<{
  anime: AnimeEntry;
  inList: boolean;
  listById: Map<number, AnimeEntry>;
  callbacks: EntryCallbacks;
  onOpenSeason: (season: string, year: number) => void;
  onBack: () => void;
}> = ({ anime, inList, listById, callbacks, onOpenSeason, onBack }) => {
  const titleOf = useAnimeTitle();
  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onBack}
          title="Back (Alt+Left)"
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-secondary border border-border-subtle hover:bg-bg-tertiary text-text-secondary hover:text-text-primary text-xs font-medium transition shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </button>
        <span className="text-xs text-text-muted truncate">{titleOf(anime)}</span>
      </div>
      <AnimePage
        key={anime.id}
        anime={anime}
        inList={inList}
        listById={listById}
        onOpenSeason={onOpenSeason}
        callbacks={callbacks}
      />
    </div>
  );
};
