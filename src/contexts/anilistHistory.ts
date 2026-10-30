import { createContext, useContext } from "react";
import { AniListHistoryStatus } from "@/lib/types";

/** The AniList activity import, shared by History, Stats, Settings and the import modal. */
export interface AniListHistoryApi {
  status: AniListHistoryStatus | null;
  /** `AppSettings.anilist_history_enabled` */
  enabled: boolean;
  /** Imported activity exists (shown even after the setting was turned off) */
  hasData: boolean;
  /** Bumps whenever stored AniList activity changed, so History / Stats reload */
  version: number;
  openImport: () => void;
  /** Start or resume the import (also turns the setting on) */
  start: () => Promise<void>;
  pause: () => Promise<void>;
  /** Fetch activity newer than what's stored */
  refresh: () => Promise<void>;
  /** Delete every imported activity and the resume point */
  clear: () => Promise<void>;
  setEnabled: (on: boolean) => void;
}

const noop = async () => {};

export const AniListHistoryContext = createContext<AniListHistoryApi>({
  status: null,
  enabled: false,
  hasData: false,
  version: 0,
  openImport: () => {},
  start: noop,
  pause: noop,
  refresh: noop,
  clear: noop,
  setEnabled: () => {},
});

export const useAniListHistory = () => useContext(AniListHistoryContext);

/** Share of the time range already walked (the import goes newest → oldest), 0–1. */
export function importProgress(s: AniListHistoryStatus | null): number {
  if (!s) return 0;
  if (s.status === "done") return 1;
  if (s.newest_at === null || s.earliest_at === null || s.cursor === null) return 0;
  const span = s.newest_at - s.earliest_at;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (s.newest_at - s.cursor) / span));
}
