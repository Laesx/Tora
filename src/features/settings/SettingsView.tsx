import React, { useEffect, useState } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import {
  Info,
  ExternalLink,
  FolderOpen,
  Languages,
  Palette,
  Plug,
  Download,
  CheckCircle2,
  Tv,
  Cpu,
  HardDrive,
  FlaskConical,
} from "lucide-react";
import {
  AnimeEntry,
  AppInfo,
  AppSettings,
  TrackerPluginDescriptor,
} from "@/lib/types";
import { ACCENT_SWATCHES, THEME_PRESETS, applyThemeToDocument } from "@/lib/theme";
import { formatBytes } from "@/lib/format";
import { toraApi } from "@/lib/api";
import { TITLE_LANGUAGES } from "@/contexts/titles";
import { LibraryManagerView } from "./LibraryManagerView";
import { AnitomyParserPanel } from "./AnitomyParserPanel";
import { TorrentSettingsSection } from "@/features/torrents/TorrentSettings";
import { SettingsBackupsPanel } from "./SettingsBackups";
import { useToast } from "@/contexts/toast";

export type SettingsSection =
  | "appearance"
  | "tracker"
  | "library"
  | "playback"
  | "torrents"
  | "diagnostics"
  | "about";

const SECTIONS: { id: SettingsSection; label: string; icon: React.ElementType }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "tracker", label: "Tracker", icon: Plug },
  { id: "library", label: "Library", icon: HardDrive },
  { id: "playback", label: "Playback & Detection", icon: Tv },
  { id: "torrents", label: "Torrents", icon: Download },
  { id: "diagnostics", label: "Diagnostics", icon: FlaskConical },
  { id: "about", label: "About", icon: Info },
];

// Settings -> About: what Tora is built on (links open in the browser)
const CREDITS: { name: string; role: string; license?: string; url: string }[] = [
  { name: "Taiga", role: "The anime tracker Tora is inspired by", url: "https://taiga.moe" },
  { name: "Anitomy", role: "Anime filename parsing", license: "MPL-2.0", url: "https://github.com/erengy/anitomy" },
  { name: "Anisthesia", role: "Media player detection", license: "MIT", url: "https://github.com/erengy/anisthesia" },
  { name: "anime-relations", role: "Sequel episode redirection", license: "CC0-1.0", url: "https://github.com/erengy/anime-relations" },
  { name: "AniList", role: "List sync, metadata, seasons & schedule", url: "https://anilist.co" },
  { name: "Nyaa, SubsPlease & other RSS feeds", role: "Torrent feeds and search", url: "https://nyaa.si" },
  { name: "Tauri", role: "Desktop app framework", license: "MIT / Apache-2.0", url: "https://tauri.app" },
  { name: "React & Tailwind CSS", role: "User interface", license: "MIT", url: "https://react.dev" },
];

interface SettingsViewProps {
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  animeList: AnimeEntry[];
  libraryRefreshTick?: number;
  onRefreshAnimeList: () => Promise<void>;
  /** Section to open (e.g. the Torrents tab's settings button); a new `nonce` opens it again */
  sectionRequest?: { section: SettingsSection; nonce: number } | null;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onUpdateSettings,
  animeList,
  libraryRefreshTick,
  onRefreshAnimeList,
  sectionRequest,
}) => {
  const [plugins, setPlugins] = useState<TrackerPluginDescriptor[]>([]);
  const [section, setSection] = useState<SettingsSection>(sectionRequest?.section ?? "appearance");

  useEffect(() => {
    if (sectionRequest) setSection(sectionRequest.section);
  }, [sectionRequest]);

  useEffect(() => {
    toraApi.getTrackerPlugins().then(setPlugins).catch(console.error);
  }, []);

  const handleSelectTheme = async (themeId: string, defaultAccent?: string) => {
    const nextAccent = defaultAccent || settings.accent_color;
    applyThemeToDocument(themeId, nextAccent);
    await onUpdateSettings({
      ...settings,
      theme: themeId,
      accent_color: nextAccent,
    });
  };

  const handleSelectAccent = async (accentHex: string) => {
    applyThemeToDocument(settings.theme, accentHex);
    await onUpdateSettings({
      ...settings,
      accent_color: accentHex,
    });
  };

  const handleTogglePlayer = async (playerId: string) => {
    const updatedPlayers = settings.players.map((p) =>
      p.id === playerId ? { ...p, enabled: !p.enabled } : p
    );
    await onUpdateSettings({ ...settings, players: updatedPlayers });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto flex gap-6 items-start">
      {/* Section Navigation */}
      <nav className="w-48 shrink-0 sticky top-6 space-y-1">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition ${section === id
              ? "bg-accent text-white shadow-sm"
              : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </nav>

      {/* Active Section */}
      <div className="flex-1 min-w-0 space-y-6">
        {section === "appearance" && (
          <>
            {/* Theme & Aesthetic Section */}
            <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-5">
              <div>
                <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
                  <Palette className="w-5 h-5 text-accent" />
                  Appearance
                </h2>
              </div>

              {/* Theme Presets Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {THEME_PRESETS.map((preset) => {
                  const active = settings.theme === preset.id;
                  return (
                    <button
                      key={preset.id}
                      onClick={() =>
                        handleSelectTheme(preset.id, preset.defaultAccent)
                      }
                      className={`text-left p-3.5 rounded-xl border transition flex items-start gap-3 ${active
                        ? "border-accent bg-accent/10 shadow-sm"
                        : "border-border-subtle bg-bg-primary hover:border-text-muted"
                        }`}
                    >
                      <div
                        className="w-10 h-10 rounded-lg border border-white/15 shrink-0 flex items-center justify-center shadow-inner"
                        style={{ backgroundColor: preset.previewBg }}
                      >
                        <div
                          className="w-4 h-4 rounded-full"
                          style={{ backgroundColor: preset.defaultAccent }}
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-text-primary flex items-center gap-1.5">
                          <span>{preset.name}</span>
                          {active && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-accent" />
                          )}
                        </div>
                        <p className="text-[11px] text-text-muted line-clamp-2 mt-0.5">
                          {preset.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Title Language */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border-subtle">
                <div>
                  <div className="text-xs font-semibold text-text-secondary flex items-center gap-1.5">
                    <Languages className="w-3.5 h-3.5 text-accent" />
                    Title language
                  </div>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    Used everywhere in Tora. Anime without an English or Native title show Romaji; torrent searches always use Romaji.
                  </p>
                </div>
                <div className="flex items-center bg-bg-primary p-1 rounded-xl border border-border-subtle">
                  {TITLE_LANGUAGES.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => onUpdateSettings({ ...settings, title_language: l.id })}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${(settings.title_language ?? "romaji") === l.id
                          ? "bg-accent text-white"
                          : "text-text-secondary hover:text-text-primary"
                        }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Accent Swatches */}
              <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-border-subtle">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-text-secondary mr-2">
                    Accent Color:
                  </span>
                  {ACCENT_SWATCHES.map((sw) => (
                    <button
                      key={sw.hex}
                      onClick={() => handleSelectAccent(sw.hex)}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition ${settings.accent_color.toLowerCase() === sw.hex.toLowerCase()
                        ? "border-text-primary bg-bg-tertiary font-semibold text-text-primary"
                        : "border-border-subtle bg-bg-primary text-text-secondary"
                        }`}
                    >
                      <span
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: sw.hex }}
                      />
                      {sw.name}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">Custom:</span>
                  <input
                    type="color"
                    value={settings.accent_color}
                    onChange={(e) => handleSelectAccent(e.target.value)}
                    className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {section === "tracker" && (
          <>
            {/* Internal Tracker Plugin System (AniList Primary + Extensible Slots) */}
            <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-5">
              <div>
                <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
                  <Plug className="w-5 h-5 text-accent" />
                  Tracker
                </h2>
                <p className="text-xs text-text-secondary mt-0.5">
                  Select the tracker used for synchronization and metadata discovery.
                </p>
              </div>

              {/* Plugin Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {plugins.map((plug) => {
                  const isSelected = settings.active_tracker_plugin === plug.id;
                  const isDisabled = plug.status !== "active";
                  return (
                    <div
                      key={plug.id}
                      onClick={() => {
                        if (isDisabled) return;
                        onUpdateSettings({
                          ...settings,
                          active_tracker_plugin: plug.id,
                        });
                      }}
                      className={`p-4 rounded-xl border transition space-y-2 ${isDisabled
                        ? "opacity-50 cursor-not-allowed border-border-subtle bg-bg-primary select-none"
                        : isSelected
                          ? "border-accent bg-accent/10 cursor-pointer"
                          : "border-border-subtle bg-bg-primary hover:border-text-muted cursor-pointer"
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-text-primary">
                          {plug.name}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${plug.status === "active"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-bg-tertiary text-text-muted"
                            }`}
                        >
                          {plug.status === "active" ? "active" : "coming soon"}
                        </span>
                      </div>
                      <p className="text-[11px] text-text-muted leading-relaxed">
                        {plug.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {section === "library" && (
          <>
            <LibraryManagerView
              animeList={animeList}
              refreshTick={libraryRefreshTick}
              onRefreshAnimeList={onRefreshAnimeList}
            />
          </>
        )}

        {section === "playback" && (
          <>
            {/* Playback & Recognition Timing */}
            <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
              <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
                <Tv className="w-4 h-4 text-accent" />
                Playback & Recognition Preferences
              </h2>

              <div className="space-y-3 text-xs">
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">
                    Delay Before Updating Progress (Seconds)
                  </label>
                  <input
                    type="number"
                    min={2}
                    max={600}
                    value={settings.recognition_delay_seconds}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        recognition_delay_seconds: Math.max(
                          2,
                          Number(e.target.value)
                        ),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle font-mono text-text-primary"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-text-muted mb-1">
                    Custom Media Player Executable (Blank = System Default)
                  </label>
                  <input
                    type="text"
                    value={settings.custom_media_player_path}
                    onChange={(e) =>
                      onUpdateSettings({
                        ...settings,
                        custom_media_player_path: e.target.value,
                      })
                    }
                    placeholder="e.g. C:\Program Files\mpv\mpv.exe"
                    className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle font-mono text-text-primary"
                  />
                </div>
              </div>
            </div>

            {/* Anisthesia Media Players Registry */}
            <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
              <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
                <Cpu className="w-4 h-4 text-accent" />
                Supported Media Players ({settings.players.length})
              </h2>

              <div className="divide-y divide-border-subtle max-h-96 overflow-y-auto pr-1">
                {settings.players.map((player) => (
                  <div
                    key={player.id}
                    className="py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-text-primary">
                        {player.name}
                      </div>
                      <div className="font-mono text-[11px] text-text-muted">
                        {player.executables.join(", ")}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={player.enabled}
                      onChange={() => handleTogglePlayer(player.id)}
                      className="rounded accent-accent w-4 h-4 cursor-pointer"
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {section === "torrents" && (
          <TorrentSettingsSection settings={settings} onUpdateSettings={onUpdateSettings} />
        )}

        {section === "diagnostics" && (
          <>
            <AnitomyParserPanel />
          </>
        )}

        {section === "about" && (
          <AboutSection
            onRestored={async (restored) => {
              applyThemeToDocument(restored.theme, restored.accent_color);
              await onUpdateSettings(restored);
            }}
          />
        )}
      </div>
    </div>
  );
};

const AboutSection: React.FC<{
  onRestored: (settings: AppSettings) => Promise<void>;
}> = ({ onRestored }) => {
  const showToast = useToast();
  const [version, setVersion] = useState<string | null>(null);
  const [tauriVersion, setTauriVersion] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(console.error);
    getTauriVersion().then(setTauriVersion).catch(console.error);
    toraApi.getAppInfo().then(setInfo).catch(console.error);
  }, []);

  const openUrl = (url: string) => toraApi.openExternalUrl(url).catch((e) => showToast(String(e), "error"));

  return (
    <>
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-accent/15 border border-accent/30 flex items-center justify-center text-3xl font-black text-accent shrink-0">
          虎
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-text-primary">
            Tora <span className="text-sm font-mono font-semibold text-text-muted">v{version ?? "..."}</span>
          </h2>
          <p className="text-xs text-text-secondary mt-0.5">
            A fast anime library manager and episode tracker for Windows.
          </p>
          {tauriVersion && <p className="text-[11px] text-text-muted mt-1">Tauri {tauriVersion}</p>}
        </div>
      </div>

      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
        <h3 className="text-sm font-bold text-text-primary">Data</h3>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-text-muted">Data folder</div>
            <div className="text-xs font-mono text-text-primary break-all">{info?.data_dir ?? "..."}</div>
            {info && (
              <div className="text-[11px] text-text-muted mt-1">
                Database {formatBytes(info.db_size_bytes)}
              </div>
            )}
          </div>
          <button
            onClick={() =>
              info && toraApi.revealInExplorer(info.data_dir).catch((e) => showToast(String(e), "error"))
            }
            disabled={!info}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold transition disabled:opacity-50 shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open data folder
          </button>
        </div>
      </div>

      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
        <h3 className="text-sm font-bold text-text-primary">Credits & licenses</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {CREDITS.map((c) => (
            <button
              key={c.name}
              onClick={() => openUrl(c.url)}
              className="group text-left p-3 rounded-xl bg-bg-primary border border-border-subtle hover:border-accent/60 transition"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-text-primary">{c.name}</span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {c.license && <span className="text-[10px] font-mono text-text-muted">{c.license}</span>}
                  <ExternalLink className="w-3 h-3 text-text-muted group-hover:text-accent" />
                </span>
              </div>
              <div className="text-[11px] text-text-secondary mt-0.5">{c.role}</div>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-text-muted">
          Tora is not affiliated with AniList, Taiga or any torrent site.
        </p>
      </div>

      <SettingsBackupsPanel onRestored={onRestored} />
    </>
  );
};

