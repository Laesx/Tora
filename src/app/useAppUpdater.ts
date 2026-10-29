import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, Update } from "@tauri-apps/plugin-updater";
import type { ToastType } from "@/contexts/toast";
import { toraApi } from "@/lib/api";

/** The version whose changelog the user last opened (a different running version = unseen changelog) */
const SEEN_CHANGELOG_KEY = "tora.update.seenChangelog";

function readSeenChangelog(): string | null {
  try {
    return localStorage.getItem(SEEN_CHANGELOG_KEY);
  } catch {
    return null;
  }
}

function writeSeenChangelog(version: string) {
  try {
    localStorage.setItem(SEEN_CHANGELOG_KEY, version);
  } catch {
    // per-device convenience only
  }
}

export interface UpdateProgress {
  downloaded: number;
  /** Bytes; null until the server reports it */
  total: number | null;
}

/**
 * App updates (GitHub releases via `tauri-plugin-updater`) and the changelog dot on the sidebar version.
 * `checkOnStartup` is null until settings load; the startup check (silent unless an update is found)
 * runs once. The dot shows while an update was postponed or this version's changelog is unseen.
 */
export function useAppUpdater(
  showToast: (msg: string, type?: ToastType) => void,
  checkOnStartup: boolean | null
) {
  const [version, setVersion] = useState("");
  const [available, setAvailable] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [unseenChangelog, setUnseenChangelog] = useState(false);
  /** Non-null while an update downloads / installs */
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const checkingRef = useRef(false);
  const startupChecked = useRef(false);

  useEffect(() => {
    getVersion()
      .then((v) => {
        setVersion(v);
        const seen = readSeenChangelog();
        // First run with the updater: nothing to announce yet.
        if (seen === null) writeSeenChangelog(v);
        else setUnseenChangelog(seen !== v);
      })
      .catch(console.error);
  }, []);

  /** Manual checks also refresh anime relations and report "up to date" / errors; silent ones only prompt. */
  const checkForUpdates = useCallback(
    async (manual: boolean) => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      setChecking(true);
      try {
        // A newer relations file announces itself through the `relations-updated` event.
        const relations = manual ? toraApi.checkRelationsUpdate().catch(console.error) : null;
        const update = await check();
        await relations;
        if (update) {
          setAvailable(update);
          setPromptOpen(true);
        } else if (manual) {
          const current = await getVersion();
          showToast(`Tora v${current} is up to date`, "success");
        }
      } catch (e) {
        console.error("Update check failed:", e);
        if (manual) showToast(`Couldn't check for updates: ${String(e)}`, "error");
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    if (checkOnStartup === null || startupChecked.current) return;
    startupChecked.current = true;
    if (checkOnStartup) void checkForUpdates(false);
  }, [checkOnStartup, checkForUpdates]);

  const openChangelog = useCallback(() => {
    setPromptOpen(false);
    setChangelogOpen(true);
    setUnseenChangelog(false);
    if (version) writeSeenChangelog(version);
  }, [version]);

  /** Download, install and restart. On Windows the installer closes the app itself. */
  const installUpdate = useCallback(async () => {
    if (!available || progress) return;
    setProgress({ downloaded: 0, total: null });
    try {
      await available.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          const chunk = event.data.chunkLength;
          setProgress((p) => ({ downloaded: (p?.downloaded ?? 0) + chunk, total: p?.total ?? null }));
        }
      });
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      setProgress(null);
      showToast(`Update failed: ${String(e)}`, "error");
    }
  }, [available, progress, showToast]);

  const showDot = unseenChangelog || (available !== null && !promptOpen);

  /** Sidebar version badge: the dot opens the changelog, otherwise it checks for updates. */
  const onVersionClick = useCallback(() => {
    if (showDot) openChangelog();
    else void checkForUpdates(true);
  }, [showDot, openChangelog, checkForUpdates]);

  return {
    version,
    available,
    checking,
    progress,
    showDot,
    promptOpen,
    changelogOpen,
    checkForUpdates,
    installUpdate,
    openChangelog,
    onVersionClick,
    /** Both stay open while an update installs */
    closePrompt: () => !progress && setPromptOpen(false),
    closeChangelog: () => !progress && setChangelogOpen(false),
  };
}
