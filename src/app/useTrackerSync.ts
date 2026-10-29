import { useRef, useState } from "react";
import { SyncSummary, TrackerSyncFailedEvent, TrackerSyncStartedEvent } from "@/lib/types";
import { toraApi } from "@/lib/api";
import type { ShowToast } from "@/contexts/toast";

// Short human-readable AniList sync summary for the toast (null when nothing changed)
function describeSyncSummary(summary: SyncSummary): string | null {
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`${summary.added} added`);
  if (summary.updated_from_remote > 0) parts.push(`${summary.updated_from_remote} updated`);
  if (summary.deleted > 0) parts.push(`${summary.deleted} removed`);
  if (summary.pushed > 0) parts.push(`${summary.pushed} pushed`);
  if (summary.remote_deleted > 0) parts.push(`${summary.remote_deleted} deleted on AniList`);
  if (summary.push_failed > 0) parts.push(`${summary.push_failed} failed to push (will retry)`);
  if (summary.deletion_skipped_reason) parts.push(`removals skipped: ${summary.deletion_skipped_reason}`);
  return parts.length > 0 ? `AniList sync: ${parts.join(", ")}` : null;
}

/**
 * AniList pull state (spinner, last synced) driven by the tracker-sync-* events and the manual
 * Sync button. `applySummary` merges a pull's delta into the list; it is idempotent.
 */
export function useTrackerSync(
  applySummary: (summary: SyncSummary) => void,
  showToast: ShowToast,
  listSize: number
) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // Bumped by every sync lifecycle event so a stale get_sync_status response can't override it
  const eventSeqRef = useRef(0);
  // Bumped by tracker-sync-failed so the manual sync button doesn't double-toast the same failure
  const failureSeqRef = useRef(0);
  const reasonRef = useRef<string>("startup");
  const now = () => Math.floor(Date.now() / 1000);

  /** Seeds the spinner in case the backend startup pull is already running */
  const loadStatus = () => {
    const seq = eventSeqRef.current;
    toraApi
      .getSyncStatus()
      .then((status) => {
        if (eventSeqRef.current !== seq) return;
        setIsSyncing(status.in_progress);
        setLastSyncedAt(status.last_synced_at);
      })
      .catch(() => {});
  };

  const onStarted = (event: TrackerSyncStartedEvent) => {
    eventSeqRef.current += 1;
    reasonRef.current = event.reason;
    setIsSyncing(true);
  };

  const onSynced = (summary: SyncSummary) => {
    eventSeqRef.current += 1;
    setIsSyncing(false);
    setLastSyncedAt(now());
    applySummary(summary);
    // Stay quiet at startup when nothing changed; manual / post-auth syncs always confirm
    const msg = describeSyncSummary(summary);
    if (msg) showToast(msg, summary.push_failed > 0 ? "error" : "success");
    else if (reasonRef.current !== "startup") showToast(`AniList sync: up to date (${listSize} entries)`, "info");
  };

  const onFailed = (event: TrackerSyncFailedEvent) => {
    eventSeqRef.current += 1;
    failureSeqRef.current += 1;
    setIsSyncing(false);
    showToast(`AniList sync failed: ${event.message}`, "error");
  };

  /** Manual pull; the tracker-list-synced event owns the summary toast */
  const syncNow = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    const failureSeq = failureSeqRef.current;
    try {
      // Applying the delta again after the event is harmless
      applySummary(await toraApi.syncTrackerList());
      setLastSyncedAt(now());
    } catch (err) {
      if (failureSeqRef.current === failureSeq) showToast(`AniList sync failed: ${String(err)}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  return {
    isSyncing,
    lastSyncedAt,
    loadStatus,
    syncNow,
    onStarted,
    onSynced,
    onFailed,
    clearLastSynced: () => setLastSyncedAt(null),
  };
}
