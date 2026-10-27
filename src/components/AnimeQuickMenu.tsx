import React from "react";
import {
  Play,
  Plus,
  Minus,
  Search,
  HardDrive,
  Star,
  ExternalLink,
  Info,
  Sparkles,
} from "lucide-react";
import { AnimeEntry } from "../types";
import { formatCountdown, getOptimizedCoverUrl } from "../api";

interface AnimeQuickMenuProps {
  anime: AnimeEntry;
  onClose: () => void;
  onOpenFullModal: (anime: AnimeEntry) => void;
  onStepEpisode: (anime: AnimeEntry, delta: number) => void;
  onSearchTorrents: (query: string) => void;
  onSimulatePlayback: (filename: string) => void;
}

export const AnimeQuickMenu: React.FC<AnimeQuickMenuProps> = ({
  anime,
  onClose,
  onOpenFullModal,
  onStepEpisode,
  onSearchTorrents,
  onSimulatePlayback,
}) => {
  const nextEp = anime.user_progress + 1;
  const countdown = formatCountdown(anime.next_airing_at);

  return (
    <div
      className="w-80 rounded-2xl bg-bg-secondary border border-border-subtle shadow-2xl p-4 space-y-3 text-xs z-[100]"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header with Mini Cover & Info */}
      <div className="flex items-start gap-3">
        <img
          src={getOptimizedCoverUrl(anime.cover_image, "medium")}
          alt={anime.title_romaji}
          decoding="async"
          className="w-14 h-20 object-cover rounded-lg border border-border-subtle shrink-0"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-bold text-text-primary line-clamp-2 leading-snug">
            {anime.title_romaji}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="px-1.5 py-0.5 rounded bg-accent/20 text-accent font-semibold">
              {anime.format}
            </span>
            {anime.average_score && (
              <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-semibold flex items-center gap-0.5">
                <Star className="w-2.5 h-2.5 fill-amber-400" />
                {anime.average_score}%
              </span>
            )}
            <span className="text-text-muted">
              {anime.studios[0] || anime.airing_status}
            </span>
          </div>
          {countdown && anime.next_airing_episode && (
            <div className="text-[10px] text-emerald-400 font-mono">
              Ep {anime.next_airing_episode} airs in {countdown}
            </div>
          )}
        </div>
      </div>

      {/* Mini Synopsis */}
      <p className="text-[11px] text-text-secondary line-clamp-3 leading-relaxed bg-bg-primary/60 p-2.5 rounded-xl border border-border-subtle">
        {anime.synopsis || "No synopsis available."}
      </p>

      {/* Genre & Disk Availability Pills */}
      <div className="flex flex-wrap items-center gap-1">
        {anime.local_episode_count > 0 && (
          <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 font-mono text-[10px] flex items-center gap-1">
            <HardDrive className="w-3 h-3" />
            {anime.local_episode_count} eps on disk
          </span>
        )}
        {anime.genres.slice(0, 3).map((g) => (
          <span
            key={g}
            className="px-2 py-0.5 rounded-md bg-bg-tertiary text-text-muted text-[10px]"
          >
            {g}
          </span>
        ))}
      </div>

      {/* Quick Action Buttons */}
      <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-border-subtle">
        <button
          onClick={() => {
            onStepEpisode(anime, 1);
            onClose();
          }}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold transition"
        >
          <Plus className="w-3.5 h-3.5" />
          Watch Ep {nextEp}
        </button>

        <button
          onClick={() => {
            onOpenFullModal(anime);
            onClose();
          }}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg bg-bg-tertiary hover:bg-bg-elevated text-text-primary font-medium transition"
        >
          <Info className="w-3.5 h-3.5 text-accent" />
          Full Menu & Files
        </button>

        <button
          onClick={() => {
            onSearchTorrents(
              `${anime.title_romaji} ${String(nextEp).padStart(2, "0")}`
            );
            onClose();
          }}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition"
        >
          <Search className="w-3 h-3 text-accent" />
          Torrents #{String(nextEp).padStart(2, "0")}
        </button>

        <button
          onClick={() => {
            onSimulatePlayback(
              `[SubsPlease] ${anime.title_romaji} - ${String(nextEp).padStart(
                2,
                "0"
              )} (1080p).mkv`
            );
            onClose();
          }}
          className="flex items-center justify-center gap-1.5 py-1.5 px-2.5 rounded-lg bg-bg-primary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition"
        >
          <Sparkles className="w-3 h-3 text-amber-400" />
          Test Scrobble
        </button>
      </div>
    </div>
  );
};
