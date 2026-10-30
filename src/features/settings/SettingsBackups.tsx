import React, { useEffect, useState } from "react";
import { ArchiveRestore, History, Save } from "lucide-react";
import { AppSettings, SettingsBackupInfo } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { useToast } from "@/contexts/toast";
import { logError } from "@/lib/log";

/** Settings → About: rolling settings snapshots in `app_data\backups` with restore. */
export const SettingsBackupsPanel: React.FC<{
  onRestored: (settings: AppSettings) => Promise<void> | void;
}> = ({ onRestored }) => {
  const showToast = useToast();
  const [backups, setBackups] = useState<SettingsBackupInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    toraApi.listSettingsBackups().then(setBackups).catch(logError("settings", "Loading settings backups failed"));
  }, []);

  const backupNow = async () => {
    setBusy("now");
    try {
      setBackups(await toraApi.backupSettingsNow());
      showToast("Settings backed up", "success");
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const restore = async (name: string) => {
    setBusy(name);
    try {
      const restored = await toraApi.restoreSettingsBackup(name);
      await onRestored(restored);
      setBackups(await toraApi.listSettingsBackups());
      showToast("Settings restored (your AniList sign-in was kept)", "success");
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <History className="w-4 h-4 text-accent" />
          Settings backups
        </h2>
        <button
          onClick={() => void backupNow()}
          disabled={busy !== null}
          className="px-3 py-1.5 rounded-lg bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold flex items-center gap-1.5"
        >
          <Save className="w-3.5 h-3.5" /> Back up now
        </button>
      </div>
      <p className="text-[11px] text-text-muted">
        Tora snapshots your settings and torrent feeds, filters, priority and fansubs at startup and at most once an
        hour while they change, keeping the last 20. Restoring keeps your current AniList sign-in and snapshots the
        current state first, so it can be undone.
      </p>
      {backups.length === 0 ? (
        <div className="text-xs text-text-muted">No backups yet.</div>
      ) : (
        <div className="divide-y divide-border-subtle/60 max-h-80 overflow-y-auto">
          {backups.map((b) => (
            <div key={b.file_name} className="flex items-center gap-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-text-primary">{new Date(b.created_at * 1000).toLocaleString()}</div>
                <div className="text-[11px] text-text-muted truncate">{b.summary}</div>
              </div>
              {confirm === b.file_name ? (
                <>
                  <button
                    onClick={() => void restore(b.file_name)}
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold"
                  >
                    {busy === b.file_name ? "Restoring…" : "Confirm restore"}
                  </button>
                  <button onClick={() => setConfirm(null)} className="px-2 py-1.5 text-text-muted hover:text-text-primary">
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirm(b.file_name)}
                  disabled={busy !== null}
                  className="px-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle hover:bg-bg-tertiary text-text-primary text-xs flex items-center gap-1.5"
                >
                  <ArchiveRestore className="w-3.5 h-3.5" /> Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
