import React from "react";
import { EpisodeBarModel } from "@/lib/episodes";

/**
 * Taiga-style progress bar: a thick accent watched fill, and a 3px strip along the bottom edge
 * with every episode on disk (the theme's contrasting strip colour, `--progress-strip`) and
 * aired episodes past the progress that are missing (dim). Nothing is drawn where episodes
 * haven't aired yet.
 */
export const EpisodeProgressBar: React.FC<{
  bar: EpisodeBarModel;
  className?: string;
}> = ({ bar, className = "h-2.5 rounded-full" }) => (
  <div className={`relative overflow-hidden bg-bg-tertiary ${className}`} title={bar.tooltip}>
    <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${bar.watchedPct}%` }} />
    {bar.strip.map((r) => (
      <div
        key={`${r.kind}-${r.from}`}
        className={`absolute bottom-0 h-[3px] ${r.kind === "disk" ? "bg-progress-disk" : "bg-text-muted/45"}`}
        style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%`, minWidth: 2 }}
      />
    ))}
  </div>
);
