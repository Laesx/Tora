import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AppSettings,
  DetectedMediaSession,
  RelationsUpdatedEvent,
  ScanSummary,
  SyncSummary,
  TorrentAutoDownloadedEvent,
  TrackerAccountSwitchedEvent,
  TrackerEntrySyncedEvent,
  TrackerSyncErrorEvent,
  TrackerSyncFailedEvent,
  TrackerSyncStartedEvent,
} from "@/lib/types";

/** Handlers for every backend event; always called with the latest render's closures */
export interface AppEventHandlers {
  libraryChanged: (summary: ScanSummary) => void;
  torrentAutoDownloaded: (event: TorrentAutoDownloadedEvent) => void;
  authUpdated: (settings: AppSettings) => void;
  syncStarted: (event: TrackerSyncStartedEvent) => void;
  listSynced: (summary: SyncSummary) => void;
  syncFailed: (event: TrackerSyncFailedEvent) => void;
  syncError: (event: TrackerSyncErrorEvent) => void;
  authInvalid: () => void;
  accountSwitched: (event: TrackerAccountSwitchedEvent) => void;
  entrySynced: (event: TrackerEntrySyncedEvent) => void;
  relationsUpdated: (event: RelationsUpdatedEvent) => void;
  /** An update held until the player closed was applied (the session is already gone) */
  playbackScrobbled: (session: DetectedMediaSession) => void;
  /** Runs once, after every listener is registered */
  ready: () => void;
}

const EVENTS: [string, Exclude<keyof AppEventHandlers, "ready">][] = [
  ["library-changed", "libraryChanged"],
  ["torrent-auto-downloaded", "torrentAutoDownloaded"],
  ["tracker-auth-updated", "authUpdated"],
  ["tracker-sync-started", "syncStarted"],
  ["tracker-list-synced", "listSynced"],
  ["tracker-sync-failed", "syncFailed"],
  ["tracker-sync-error", "syncError"],
  ["tracker-auth-invalid", "authInvalid"],
  ["tracker-account-switched", "accountSwitched"],
  ["tracker-entry-synced", "entrySynced"],
  ["relations-updated", "relationsUpdated"],
  ["playback-scrobbled", "playbackScrobbled"],
];

/**
 * Registers every Tauri listener BEFORE `ready` (initial data load) so a backend startup sync that
 * finishes early is never missed. Handles unmount before the listen promises resolve.
 */
export function useAppEvents(handlers: AppEventHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const registrations = EVENTS.map(([event, key]) =>
      listen<never>(event, (e) => (ref.current[key] as (payload: unknown) => void)(e.payload))
    );
    Promise.allSettled(registrations).then((results) => {
      for (const r of results) {
        if (r.status === "fulfilled") {
          if (disposed) r.value();
          else unlisteners.push(r.value);
        } else {
          console.error("Failed to register Tauri listener:", r.reason);
        }
      }
      if (!disposed) ref.current.ready();
    });
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);
}
