import React, { useMemo, useState } from "react";
import { Calendar, ChevronDown, Clock } from "lucide-react";
import { AnimeEntry } from "../types";
import { formatCountdown, getOptimizedCoverUrl } from "../api";

interface AiringCountdownProps {
  animeList: AnimeEntry[];
  onOpenAnime: (anime: AnimeEntry) => void;
}

const COLLAPSED_KEY = "tora.nowplaying.countdownCollapsed";

/** Next-episode countdown for every airing anime in the user's list, soonest first. */
export const AiringCountdown: React.FC<AiringCountdownProps> = ({ animeList, onOpenAnime }) => {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const airing = useMemo(
    () =>
      animeList
        .filter((a) => a.next_airing_at && a.next_airing_episode && a.user_status !== "DROPPED")
        .sort((a, b) => (a.next_airing_at || 0) - (b.next_airing_at || 0)),
    [animeList]
  );

  if (airing.length === 0) return null;

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-4 space-y-3">
      <button
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          try {
            localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
          } catch {
            // per-viewer convenience only
          }
        }}
        className="w-full flex items-center gap-2 text-sm font-bold text-text-primary"
      >
        <Calendar className="w-4 h-4 text-accent" />
        Airing Countdown
        <span className="text-[11px] font-medium text-text-muted">{airing.length}</span>
        <ChevronDown
          className={`w-4 h-4 ml-auto text-text-muted transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>

      {!collapsed && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {airing.map((a) => {
            const cd = formatCountdown(a.next_airing_at);
            const behind = Math.max(0, (a.next_airing_episode || 1) - 1 - a.user_progress);
            return (
              <div
                key={a.id}
                onClick={() => onOpenAnime(a)}
                className="flex items-center gap-3 p-3 rounded-xl bg-bg-primary border border-border-subtle hover:border-accent/60 cursor-pointer transition"
              >
                <img
                  src={getOptimizedCoverUrl(a.cover_image, "medium")}
                  alt={a.title_romaji}
                  loading="lazy"
                  decoding="async"
                  className="w-12 h-16 object-cover rounded-lg shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-text-primary truncate">{a.title_romaji}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[11px] font-mono font-semibold flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Ep {a.next_airing_episode} in {cd}
                    </span>
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">
                    Progress: {a.user_progress} / {a.episodes ?? "?"}
                    {behind > 0 ? ` (${behind} ep behind)` : " (Caught up!)"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
