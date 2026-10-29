import React from "react";
import { Play } from "lucide-react";
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

/**
 * "▶ +3": unwatched episodes on disk. Dimmed when the next episode itself is missing.
 * `overlay` is for text on top of a cover image.
 */
export const ReadyBadge: React.FC<{
  bar: EpisodeBarModel;
  progress: number;
  tone?: "overlay" | "surface";
  className?: string;
}> = ({ bar, progress, tone = "surface", className = "" }) => {
  if (bar.ready === 0) return null;
  const colors =
    tone === "overlay"
      ? bar.nextReady
        ? "bg-white/20 text-white"
        : "bg-black/50 text-white/55"
      : bar.nextReady
        ? "bg-text-primary/10 text-text-primary"
        : "bg-bg-tertiary text-text-muted";
  const missing = bar.missingText ?? `Ep ${progress + 1}`;
  const title = bar.nextReady
    ? `${bar.readyText} ready${bar.missingText ? ` · Missing: ${bar.missingText}` : ""}`
    : `Missing: ${missing} · ${bar.ready} later episode${bar.ready === 1 ? "" : "s"} on disk`;
  return (
    <span
      title={title}
      className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono font-bold flex items-center gap-0.5 shrink-0 ${colors} ${className}`}
    >
      <Play className="w-2.5 h-2.5 fill-current" />+{bar.ready}
    </span>
  );
};
