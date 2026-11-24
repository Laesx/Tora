import { createContext, useContext, useMemo } from "react";
import { AccountInfo, AnimeEntry, TrackerDescriptor, TrackerFeature } from "@/lib/types";
import { featureSupport, trackerAnimeUrl, trackerLink, TrackerLinkKind } from "@/lib/trackers";

/** The active tracker (the signed-in account's, else the list owner's) and the signed-in account; App provides it. */
export interface TrackerContextValue {
  tracker: TrackerDescriptor | null;
  account: AccountInfo | null;
}

export const TrackerContext = createContext<TrackerContextValue>({ tracker: null, account: null });

/**
 * The active tracker for UI code: its name for messages ("Sync from AniList"), whether an account is signed
 * in, its links (null when it has no such page) and its features.
 */
export function useTracker() {
  const { tracker, account } = useContext(TrackerContext);
  return useMemo(
    () => ({
      tracker,
      account,
      /** "AniList"; "your tracker" before the state has loaded */
      name: tracker?.name ?? "your tracker",
      signedIn: account !== null,
      link: (kind: TrackerLinkKind, value: string | number) => trackerLink(tracker?.links, kind, value),
      animeUrl: (anime: AnimeEntry) => trackerAnimeUrl(tracker?.links, anime),
      /** Whether the tracker has `feature` (true until the state has loaded, so nothing flickers away) */
      supports: (feature: TrackerFeature) => trackerSupports(tracker, feature),
    }),
    [tracker, account]
  );
}

/** Whether `tracker` has `feature`; true while it is still unknown (null). */
export const trackerSupports = (tracker: TrackerDescriptor | null, feature: TrackerFeature) =>
  tracker === null || featureSupport(tracker, feature) !== null;
