import React, { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Clock, Download, FolderOpen, RotateCcw, Zap } from "lucide-react";
import { AppSettings, DetectedTorrentApp } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { useToast } from "@/contexts/toast";
import { ToggleRow } from "@/features/settings/SettingRow";

interface TorrentSettingsProps {
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
}

const REFRESH_OPTIONS = [
  { value: 0, label: "Manual only" },
  { value: 15, label: "Every 15 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Every hour" },
  { value: 180, label: "Every 3 hours" },
  { value: 360, label: "Every 6 hours" },
];

const SOURCE_LABEL: Record<DetectedTorrentApp["source"], string> = {
  custom: "chosen by you",
  association: "default app for .torrent files",
  registry: "qBittorrent install",
  program_files: "found in Program Files",
  none: "no torrent app found",
};

const cardClass = "bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4";
const inputClass =
  "w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent";

export const TorrentSettingsSection: React.FC<TorrentSettingsProps> = ({ settings, onUpdateSettings }) => {
  const showToast = useToast();
  const [app, setApp] = useState<DetectedTorrentApp | null>(null);
  // The folder is committed on blur / Enter / Browse: saving adds it to the library, so never per keystroke
  const [folder, setFolder] = useState(settings.torrent_download_folder);
  useEffect(() => setFolder(settings.torrent_download_folder), [settings.torrent_download_folder]);

  useEffect(() => {
    toraApi.detectTorrentApp(settings.torrent_app_path).then(setApp).catch(() => setApp(null));
  }, [settings.torrent_app_path]);

  const update = (patch: Partial<AppSettings>) => onUpdateSettings({ ...settings, ...patch });

  const commitFolder = async (value: string) => {
    const v = value.trim();
    if (v === settings.torrent_download_folder.trim()) return;
    await update({ torrent_download_folder: v });
    if (v) showToast("Download folder saved and added to library", "success");
  };

  const browseApp = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Select your torrent application",
      filters: [{ name: "Applications", extensions: ["exe"] }],
    });
    if (picked && typeof picked === "string") await update({ torrent_app_path: picked });
  };

  const browseFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Select the default download folder" });
    if (picked && typeof picked === "string") {
      setFolder(picked);
      await commitFolder(picked);
    }
  };

  return (
    <>
      <div className={cardClass}>
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <Download className="w-4 h-4 text-accent" />
          Torrent application
        </h2>
        <p className="text-[11px] text-text-muted">
          Supported clients (qBittorrent, µTorrent, Deluge, PicoTorrent, aria2, Transmission) receive the save folder
          automatically.
        </p>
        <div className="flex items-center gap-3 rounded-xl bg-bg-primary border border-border-subtle px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-text-primary">{app?.label ?? "Detecting…"}</div>
            <div className="text-[11px] text-text-muted font-mono truncate" title={app?.path}>
              {app?.path || "Torrents will open with the system's default handler"}
            </div>
            {app && <div className="text-[10px] text-text-muted mt-0.5">{SOURCE_LABEL[app.source]}</div>}
          </div>
          <button
            onClick={() => void browseApp()}
            className="px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold flex items-center gap-1.5 shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5" /> Choose…
          </button>
          {settings.torrent_app_path && (
            <button
              onClick={() => void update({ torrent_app_path: "" })}
              className="px-3 py-2 rounded-xl text-text-secondary hover:text-text-primary text-xs flex items-center gap-1.5 shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Auto-detect
            </button>
          )}
        </div>
        <div className="max-w-xs">
          <label className="block text-[11px] text-text-muted mb-1">qBittorrent category (optional)</label>
          <input
            value={settings.torrent_category}
            onChange={(e) => void update({ torrent_category: e.target.value })}
            placeholder="anime"
            className={inputClass}
          />
        </div>
      </div>

      <div className={cardClass}>
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-accent" />
          Download folder
        </h2>
        <p className="text-[11px] text-text-muted">
          Default folder for anime without a linked folder. Automatically watched as a library folder.
        </p>
        <div className="flex items-center gap-2">
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onBlur={() => void commitFolder(folder)}
            onKeyDown={(e) => e.key === "Enter" && void commitFolder(folder)}
            placeholder="D:\Anime"
            className={`${inputClass} font-mono`}
          />
          <button
            onClick={() => void browseFolder()}
            className="px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold flex items-center gap-1.5 shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5" /> Browse…
          </button>
        </div>
        <ToggleRow
          flush
          label="Create a subfolder per anime"
          checked={settings.torrent_create_subfolder}
          onChange={(checked) => void update({ torrent_create_subfolder: checked })}
        />
      </div>

      <div className={cardClass}>
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <Clock className="w-4 h-4 text-accent" />
          Feed refresh
        </h2>
        <div className="max-w-xs">
          <select
            value={settings.torrent_refresh_minutes}
            onChange={(e) => void update({ torrent_refresh_minutes: Number(e.target.value) })}
            className={inputClass}
          >
            {REFRESH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <ToggleRow
          flush
          icon={Zap}
          label="Download auto-selected releases after each refresh"
          disabled={settings.torrent_refresh_minutes === 0}
          checked={settings.torrent_auto_download}
          onChange={(checked) => void update({ torrent_auto_download: checked })}
        />
      </div>
    </>
  );
};
