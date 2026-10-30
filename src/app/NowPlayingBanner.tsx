import React from "react";
import { AlertTriangle, CheckCircle2, Play } from "lucide-react";
import { DetectedMediaSession } from "@/lib/types";
import { UpdateCountdown } from "@/components/UpdateCountdown";

interface NowPlayingBannerProps {
  session: DetectedMediaSession;
  recognitionDelaySeconds: number;
  onOpenNowPlaying: () => void;
  /** Manual update mode's "Update" button */
  onConfirmUpdate: () => void;
  onDismiss: () => void;
}

/** Live playback strip above every tab except Now Playing (which shows its own hero). */
export const NowPlayingBanner: React.FC<NowPlayingBannerProps> = ({
  session,
  recognitionDelaySeconds,
  onOpenNowPlaying,
  onConfirmUpdate,
  onDismiss,
}) => {
  const ep = session.parsed.episode_number;
  // Already-seen episodes never count down
  const alreadySeen = ep !== null && session.matched_current_progress !== null && ep <= session.matched_current_progress;

  return (
    <div className="bg-gradient-to-r from-accent/20 via-bg-secondary to-bg-secondary border-b border-accent/40 px-6 py-2.5 flex items-center justify-between gap-4 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent text-white text-[11px] font-bold shrink-0">
          <Play className="w-3 h-3 fill-current" />
          {session.player_closed ? "PLAYER CLOSED" : "NOW PLAYING"} ({session.player_name})
        </span>
        <span className="text-xs font-bold text-text-primary truncate">
          {session.matched_anime_title || session.parsed.anime_title} — Episode {ep ?? "?"}
        </span>
        {session.parsed.video_resolution && (
          <span className="px-1.5 py-0.5 rounded bg-bg-tertiary text-emerald-400 font-mono text-[10px]">
            {session.parsed.video_resolution}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0 text-xs">
        {session.matched_anime_id ? (
          session.auto_synced ? (
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4" />
              Progress Scrobbled!
            </span>
          ) : alreadySeen ? null : session.awaiting_confirmation ? (
            <button
              onClick={onConfirmUpdate}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold transition text-[11px]"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Update to episode {ep}
            </button>
          ) : session.waiting_for_close ? (
            <span className="text-amber-300 text-[11px] font-semibold">Updates when the player closes</span>
          ) : (
            <span className="text-amber-300 font-mono text-[11px]">
              Auto-updating in <UpdateCountdown session={session} delaySeconds={recognitionDelaySeconds} />s...
            </span>
          )
        ) : (
          <button
            onClick={onOpenNowPlaying}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 font-semibold hover:bg-amber-500/30 transition text-[11px]"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Unmatched — Select Anime
          </button>
        )}
        <button
          onClick={onDismiss}
          className="px-2 py-1 rounded bg-bg-tertiary hover:bg-bg-elevated text-text-secondary text-[11px]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
};
