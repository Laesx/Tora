import { useCallback, useMemo, useRef, useState } from "react";
import { AniListHistoryStatus, AppSettings } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { AniListHistoryApi } from "@/contexts/anilistHistory";
import { ShowToast } from "@/contexts/toast";
import { errorText, log } from "@/lib/log";

/**
 * AniList activity import state (fed by `anilist-history-*` events) and its actions. `api` is what
 * AniListHistoryContext provides; the modal's open state lives here too.
 */
export function useAniListHistoryState(
  settings: AppSettings | null,
  updateSettings: (next: AppSettings) => Promise<void>,
  showToast: ShowToast
) {
  const [status, setStatusState] = useState<AniListHistoryStatus | null>(null);
  const statusRef = useRef<AniListHistoryStatus | null>(null);
  const setStatus = useCallback((next: AniListHistoryStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);
  const [version, setVersion] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const enabled = Boolean(settings?.anilist_history_enabled);

  const load = useCallback(() => {
    toraApi
      .getAniListHistoryStatus()
      .then(setStatus)
      .catch((e) => log.error("history", "Loading the AniList history state failed", e));
  }, [setStatus]);

  // Each progress event means a page was stored (or the state changed): History reloads on `version`
  const onProgress = useCallback(
    (next: AniListHistoryStatus) => {
      const prev = statusRef.current;
      if (prev && prev.status !== "done" && next.status === "done") {
        showToast(`AniList history imported: ${next.episode_count.toLocaleString()} episodes`, "success");
      }
      setStatus(next);
      setVersion((v) => v + 1);
    },
    [setStatus, showToast]
  );

  const onUpdated = useCallback(() => setVersion((v) => v + 1), []);

  const setEnabled = useCallback(
    (on: boolean) => {
      if (settings && settings.anilist_history_enabled !== on) {
        void updateSettings({ ...settings, anilist_history_enabled: on });
      }
    },
    [settings, updateSettings]
  );

  const api = useMemo<AniListHistoryApi>(
    () => ({
      status,
      enabled,
      hasData: (status?.activity_count ?? 0) > 0,
      version,
      openImport: () => setModalOpen(true),
      start: async () => {
        setEnabled(true);
        try {
          setStatus(await toraApi.startAniListHistoryImport());
        } catch (e) {
          showToast(`Couldn't start the AniList import: ${errorText(e)}`, "error");
        }
      },
      pause: async () => {
        await toraApi.pauseAniListHistoryImport().catch(() => {});
      },
      refresh: async () => {
        try {
          const added = await toraApi.refreshAniListHistory();
          showToast(
            added > 0 ? `AniList history: ${added.toLocaleString()} new activities` : "AniList history is up to date",
            "success"
          );
        } catch (e) {
          showToast(`AniList history update failed: ${errorText(e)}`, "error");
        }
      },
      clear: async () => {
        try {
          await toraApi.clearAniListHistory();
          setEnabled(false);
          setVersion((v) => v + 1);
          showToast("Imported AniList history deleted", "info");
        } catch (e) {
          showToast(`Couldn't delete the imported history: ${errorText(e)}`, "error");
        }
      },
      setEnabled,
    }),
    [status, enabled, version, setEnabled, setStatus, showToast]
  );

  return {
    api,
    load,
    onProgress,
    onUpdated,
    modalOpen,
    closeModal: () => setModalOpen(false),
  };
}
