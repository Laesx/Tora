import React from "react";
import { Activity } from "lucide-react";
import { AnimeEntry, AppSettings, DetectedMediaSession } from "@/lib/types";
import { NowPlayingHero } from "./NowPlayingHero";
import { NowPlayingDashboard } from "./NowPlayingDashboard";

interface NowPlayingViewProps {
  activeSession: DetectedMediaSession | null;
  animeList: AnimeEntry[];
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  onLinkDetectedEpisode: (animeId: number, aliasTitle: string) => Promise<void>;
  onDismissSession: () => void;
  onOpenSeason: (season: string, year: number) => void;
}

/** Playing: a large hero for the detected anime. Idle: a dashboard of what to watch next. */
export const NowPlayingView: React.FC<NowPlayingViewProps> = ({
  activeSession,
  animeList,
  settings,
  onUpdateSettings,
  onLinkDetectedEpisode,
  onDismissSession,
  onOpenSeason,
}) => {
  const entry = activeSession?.matched_anime_id
    ? animeList.find((a) => a.id === activeSession.matched_anime_id)
    : undefined;

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
          <Activity className="w-6 h-6 text-accent" />
          Now Playing
          {!activeSession && (
            <span className="text-xs font-medium text-text-muted flex items-center gap-1.5 ml-1">
              <span className="w-2 h-2 rounded-full bg-text-muted/60" />
              Nothing playing
            </span>
          )}
        </h1>

        <div className="flex items-center gap-2">
          {activeSession && (
            <button
              onClick={onDismissSession}
              className="px-3 py-2 rounded-xl bg-bg-secondary border border-border-subtle hover:bg-bg-tertiary text-text-secondary text-xs font-medium transition"
            >
              Dismiss
            </button>
          )}
          <label className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-bg-secondary border border-border-subtle text-xs font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={settings.recognition_enabled}
              onChange={(e) => onUpdateSettings({ ...settings, recognition_enabled: e.target.checked })}
              className="rounded accent-accent"
            />
            <span>Media detection</span>
          </label>
        </div>
      </div>

      {activeSession ? (
        <NowPlayingHero
          session={activeSession}
          entry={entry}
          animeList={animeList}
          settings={settings}
          onLinkDetectedEpisode={onLinkDetectedEpisode}
          onOpenSeason={onOpenSeason}
        />
      ) : (
        <NowPlayingDashboard
          animeList={animeList}
        />
      )}
    </div>
  );
};
