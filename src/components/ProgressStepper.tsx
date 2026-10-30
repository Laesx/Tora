import React from "react";
import { Minus, Plus } from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { EpisodeBarModel } from "@/lib/episodes";
import { useAnimeActions } from "@/contexts/animeActions";
import { EpisodeProgressBar } from "./EpisodeProgressBar";

const QUIET =
  "rounded-md text-text-muted hover:text-accent hover:bg-bg-tertiary disabled:opacity-30 disabled:pointer-events-none";

/**
 * −1 / +1 episode button (optimistic, debounced `stepEpisode`). Clicks never reach the row or card
 * underneath, which would select it or open the drawer. Disabled at 0 and at the known total.
 */
export const StepButton: React.FC<{
  anime: AnimeEntry;
  delta: -1 | 1;
  /** Replaces the quiet default look (size and shape stay) */
  className?: string;
}> = ({ anime, delta, className = QUIET }) => {
  const { stepEpisode } = useAnimeActions();
  const disabled =
    delta < 0 ? anime.user_progress <= 0 : !!anime.episodes && anime.user_progress >= anime.episodes;
  const Icon = delta < 0 ? Minus : Plus;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        stepEpisode(anime, delta);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={`w-5 h-5 shrink-0 flex items-center justify-center transition ${className}`}
      title={delta < 0 ? "Previous episode (−1)" : "Next episode (+1)"}
      aria-label={delta < 0 ? "Decrease progress" : "Increase progress"}
    >
      <Icon className="w-3 h-3" />
    </button>
  );
};

/** The episode progress bar with −1 / +1 buttons on either side. */
export const ProgressStepper: React.FC<{
  anime: AnimeEntry;
  bar: EpisodeBarModel;
  barClassName?: string;
  className?: string;
}> = ({ anime, bar, barClassName = "h-2.5 rounded-full", className = "" }) => (
  <div className={`flex items-center gap-1 ${className}`}>
    <StepButton anime={anime} delta={-1} />
    <EpisodeProgressBar bar={bar} className={`flex-1 min-w-0 ${barClassName}`} />
    <StepButton anime={anime} delta={1} />
  </div>
);
