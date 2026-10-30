import React, { useState } from "react";
import { Download, History, RefreshCw, Trash2 } from "lucide-react";
import { AppSettings } from "@/lib/types";
import { importProgress, useAniListHistory } from "@/contexts/anilistHistory";
import { formatLastSynced } from "@/lib/format";

/** Settings → Tracker: the AniList activity history import (off until the user imports). */
export const AniListHistorySettings: React.FC<{ settings: AppSettings }> = ({ settings }) => {
  const history = useAniListHistory();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const s = history.status;
  const phase = s?.status ?? "idle";
  const signedIn = Boolean(settings.anilist_token?.trim());

  const statusLine =
    phase === "idle"
      ? "Not imported. Your History tab shows only what Tora logged."
      : phase === "done"
        ? `${(s?.episode_count ?? 0).toLocaleString()} episodes from ${(s?.activity_count ?? 0).toLocaleString()} activities${
            s?.last_refreshed_at ? ` · updated ${formatLastSynced(s.last_refreshed_at)}` : ""
          }`
        : `${phase === "paused" ? "Paused" : "Importing"} · ${Math.round(importProgress(s) * 100)}% · ${(s?.fetched ?? 0).toLocaleString()} activities read`;

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
      <div>
        <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
          <History className="w-5 h-5 text-accent" />
          AniList activity history
        </h2>
        <p className="text-xs text-text-secondary mt-0.5">
          Import every episode you marked as watched on AniList into History (and, if you choose, Stats).
        </p>
      </div>

      <p className="text-xs text-text-muted">{statusLine}</p>

      {phase === "done" && (
        <label className="flex items-start gap-2.5 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={history.enabled}
            onChange={(e) => history.setEnabled(e.target.checked)}
            className="rounded accent-accent w-4 h-4 mt-0.5 cursor-pointer"
          />
          <span>
            <span className="font-semibold text-text-primary">Keep it updated</span>
            <span className="block text-[11px] text-text-muted">
              Fetch new AniList activity after each sync. The History tab's refresh button works either way.
            </span>
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {phase !== "done" && (
          <button
            onClick={history.openImport}
            disabled={!signedIn && phase === "idle"}
            title={!signedIn ? "Sign in to AniList first" : undefined}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            {phase === "idle" ? "Import history…" : "Show progress"}
          </button>
        )}
        {phase === "done" && (
          <button
            onClick={async () => {
              setRefreshing(true);
              await history.refresh();
              setRefreshing(false);
            }}
            disabled={refreshing || !signedIn || s?.active}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-primary text-xs font-semibold border border-border-subtle transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Update now
          </button>
        )}
        {phase !== "idle" &&
          (confirmDelete ? (
            <>
              <span className="text-xs text-text-secondary">Delete the imported history?</span>
              <button
                onClick={async () => {
                  setConfirmDelete(false);
                  await history.clear();
                }}
                className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary text-xs font-semibold border border-border-subtle transition"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-rose-400 text-xs font-semibold border border-border-subtle transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete imported history
            </button>
          ))}
      </div>
    </div>
  );
};
