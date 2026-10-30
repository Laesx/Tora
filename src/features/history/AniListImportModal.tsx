import React from "react";
import { AlertTriangle, CheckCircle2, Download, Pause, Play } from "lucide-react";
import { importProgress, useAniListHistory } from "@/contexts/anilistHistory";

interface AniListImportModalProps {
  onClose: () => void;
}

function monthYear(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * Explains the AniList activity import, starts it, and shows its progress (newest → oldest, so the bar
 * is the share of the account's activity time range already walked). Closing never stops the import.
 */
export const AniListImportModal: React.FC<AniListImportModalProps> = ({ onClose }) => {
  const history = useAniListHistory();
  const s = history.status;
  const phase = s?.status ?? "idle";
  const pct = Math.round(importProgress(s) * 100);
  const running = phase === "running" && Boolean(s?.active);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 max-w-md w-full shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0">
            {phase === "done" ? <CheckCircle2 className="w-5 h-5" /> : <Download className="w-5 h-5" />}
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-primary">
              {phase === "done" ? "AniList history imported" : "Import your AniList history"}
            </h3>
            <p className="text-[11px] text-text-muted">Every episode you've marked as watched on AniList</p>
          </div>
        </div>

        {phase === "idle" ? (
          <div className="space-y-2 text-xs text-text-secondary leading-relaxed">
            <p className="font-semibold text-text-primary">Downloading all your activity will take a while.</p>
            <p>
              It keeps going in the background even if you close this window, and it picks up where it left off if stopped. Episodes Tora already logged
              aren't duplicated.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${phase === "paused" ? "bg-amber-500" : phase === "done" ? "bg-emerald-500" : "bg-accent"
                  }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-text-muted">
              <span>
                {(s?.fetched ?? 0).toLocaleString()} activities read
                {s?.cursor && phase !== "done" ? ` · back to ${monthYear(s.cursor)}` : ""}
              </span>
              <span>{pct}%</span>
            </div>
            <p className="text-xs text-text-secondary">
              {phase === "done"
                ? `${(s?.episode_count ?? 0).toLocaleString()} watched episodes stored. New activity is fetched after each sync.`
                : phase === "paused"
                  ? s?.last_error
                    ? "Paused because of an error. It resumes on its own the next time Tora starts."
                    : "Paused. It resumes from here when you continue."
                  : running
                    ? "Importing… you can close this window, it keeps going in the background."
                    : "Waiting to continue…"}
            </p>
            {phase === "paused" && s?.last_error && (
              <p className="flex items-start gap-1.5 text-[11px] text-rose-400">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                {s.last_error}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold border border-border-subtle transition cursor-pointer"
          >
            {phase === "idle" ? "Cancel" : "Close"}
          </button>
          {phase === "idle" && (
            <button
              onClick={() => void history.start()}
              className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm cursor-pointer"
            >
              Start import
            </button>
          )}
          {running && (
            <button
              onClick={() => void history.pause()}
              className="px-4 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-primary text-xs font-semibold border border-border-subtle transition cursor-pointer flex items-center gap-1.5"
            >
              <Pause className="w-3.5 h-3.5" />
              Pause
            </button>
          )}
          {(phase === "paused" || (phase === "running" && !s?.active)) && (
            <button
              onClick={() => void history.start()}
              className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm cursor-pointer flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5" />
              Resume
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
