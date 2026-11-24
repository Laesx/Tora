import React from "react";
import { Activity } from "lucide-react";
import { AnimeEntry, AppSettings, DetectedMediaSession } from "@/lib/types";
import { NowPlayingHero } from "./NowPlayingHero";
import { NowPlayingDashboard } from "./NowPlayingDashboard";
import type { EntryCallbacks } from "@/features/anime/AnimePage";

interface NowPlayingViewProps {
  activeSession: DetectedMediaSession | null;
  animeList: AnimeEntry[];
  listById: Map<number, AnimeEntry>;
  callbacks: EntryCallbacks;
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  onLinkDetectedEpisode: (animeId: number, aliasTitle: string) => Promise<void>;
  onConfirmUpdate: () => void;
  onOpenSeason: (season: string, year: number) => void;
}

/** The "Media detection" switch: a plain chip in the idle header, a dark pill on the playing hero. */
const DetectionToggle: React.FC<{
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  onHero?: boolean;
}> = ({ settings, onUpdateSettings, onHero }) => (
  <label
    className={
      onHero
        ? "flex items-center gap-2 pl-2.5 pr-3 py-1 rounded-full bg-black/45 text-white/90 text-xs font-medium shadow hover:bg-black/65 hover:text-white transition cursor-pointer"
        : "flex items-center gap-2 px-3.5 py-2 rounded-xl bg-bg-secondary border border-border-subtle text-xs font-medium cursor-pointer"
    }
  >
    <input
      type="checkbox"
      checked={settings.recognition_enabled}
      onChange={(e) => onUpdateSettings({ ...settings, recognition_enabled: e.target.checked })}
      className="rounded accent-accent"
    />
    <span>Media detection</span>
  </label>
);

/** Playing: a large hero for the detected anime. Idle: a dashboard of what to watch next. */
export const NowPlayingView: React.FC<NowPlayingViewProps> = ({
  activeSession,
  animeList,
  listById,
  callbacks,
  settings,
  onUpdateSettings,
  onLinkDetectedEpisode,
  onConfirmUpdate,
  onOpenSeason,
}) => {
  const entry = activeSession?.matched_anime_id ? listById.get(activeSession.matched_anime_id) : undefined;

  if (activeSession) {
    // The hero starts at the top; the detection switch sits on its banner (matched) or its card (unmatched)
    return (
      <div className="relative pb-6">
        <NowPlayingHero
          session={activeSession}
          entry={entry}
          animeList={animeList}
          listById={listById}
          callbacks={callbacks}
          settings={settings}
          onLinkDetectedEpisode={onLinkDetectedEpisode}
          onConfirmUpdate={onConfirmUpdate}
          onOpenSeason={onOpenSeason}
          detectionToggle={<DetectionToggle settings={settings} onUpdateSettings={onUpdateSettings} onHero />}
        />
      </div>
    );
  }

  return (
    <div className="pb-6">
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 pt-6">
        <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
          <Activity className="w-6 h-6 text-accent" />
          Now Playing
          <span className="text-xs font-medium text-text-muted flex items-center gap-1.5 ml-1">
            <span className="w-2 h-2 rounded-full bg-text-muted/60" />
            Nothing playing
          </span>
        </h1>
        <DetectionToggle settings={settings} onUpdateSettings={onUpdateSettings} />
      </div>

      <div className="px-6 pt-5 max-w-7xl mx-auto">
        <NowPlayingDashboard animeList={animeList} skipOpEd={settings.skip_op_ed} />
      </div>
    </div>
  );
};
