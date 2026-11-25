import React, { useEffect, useState } from "react";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import {
  Info,
  ExternalLink,
  FolderOpen,
  CalendarDays,
  MousePointerClick,
  Clock,
  Languages,
  Palette,
  Plug,
  Download,
  CheckCircle2,
  Tv,
  Cpu,
  HardDrive,
  FlaskConical,
  RefreshCw,
  ScrollText,
  Copy,
  Monitor,
  Type,
  Hourglass,
  ListChecks,
  Radar,
  Play,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Segmented, SettingGroup, SettingRow, SettingsCard, ToggleRow } from "./SettingRow";
import {
  AnimeEntry,
  AppInfo,
  AppSettings,
  ProcessMemory,
  RelationsInfo,
} from "@/lib/types";
import { ACCENT_SWATCHES, THEME_PRESETS, applyThemeToDocument } from "@/lib/theme";
import { formatBytes } from "@/lib/format";
import { toraApi } from "@/lib/api";
import { TITLE_LANGUAGES } from "@/contexts/titles";
import { DATE_LOCALE_OPTIONS, TIME_FORMATS, dateLocaleSample, systemDateLocale } from "@/lib/dates";
import { LibraryManagerView } from "./LibraryManagerView";
import { AnitomyParserPanel } from "./AnitomyParserPanel";
import { TorrentSettingsSection } from "@/features/torrents/TorrentSettings";
import { AniListHistorySettings } from "@/features/settings/AniListHistorySettings";
import { SettingsBackupsPanel } from "./SettingsBackups";
import { useToast } from "@/contexts/toast";
import { useTracker } from "@/contexts/tracker";
import { TrackerSettings } from "./TrackerSettings";
import { logError } from "@/lib/log";

export type SettingsSection =
  | "appearance"
  | "tracker"
  | "library"
  | "playback"
  | "torrents"
  | "system"
  | "diagnostics"
  | "about";

const SECTIONS: { id: SettingsSection; label: string; icon: React.ElementType }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "tracker", label: "Tracker", icon: Plug },
  { id: "library", label: "Library", icon: HardDrive },
  { id: "playback", label: "Playback & Detection", icon: Tv },
  { id: "torrents", label: "Torrents", icon: Download },
  { id: "system", label: "System", icon: Monitor },
  { id: "diagnostics", label: "Diagnostics", icon: FlaskConical },
  { id: "about", label: "About", icon: Info },
];

type SystemOptionKey =
  | "tray_icon_enabled"
  | "minimize_to_tray"
  | "close_to_tray"
  | "start_with_windows"
  | "start_hidden";

// Settings -> System: tray and startup (indented rows need every setting in `needs` on)
const SYSTEM_OPTIONS: { key: SystemOptionKey; label: string; needs: SystemOptionKey[] }[] = [
  { key: "tray_icon_enabled", label: "Show icon in the system tray", needs: [] },
  { key: "minimize_to_tray", label: "Minimize to tray", needs: ["tray_icon_enabled"] },
  { key: "close_to_tray", label: "Close to tray", needs: ["tray_icon_enabled"] },
  { key: "start_with_windows", label: "Start with Windows", needs: [] },
  { key: "start_hidden", label: "Start in the tray", needs: ["start_with_windows", "tray_icon_enabled"] },
];

// Settings -> Playback: automatic list update options (off in manual mode)
const UPDATE_OPTIONS: { key: "update_wait_for_close" | "update_require_focus"; label: string; hint?: string }[] = [
  {
    key: "update_wait_for_close",
    label: "Wait for the media player to close",
    hint: "Update when playback ends or switches files",
  },
  {
    key: "update_require_focus",
    label: "Media player must be in focus",
  },
];

// Settings -> Playback: "Open Now Playing when…"
const NOW_PLAYING_FOCUS_OPTIONS: {
  key: "now_playing_focus_matched" | "now_playing_focus_unmatched";
  label: string;
}[] = [
  { key: "now_playing_focus_matched", label: "An episode is recognized" },
  { key: "now_playing_focus_unmatched", label: "A file isn't recognized" },
];

const UPDATE_MODES: { id: AppSettings["update_mode"]; label: string }[] = [
  { id: "auto", label: "Automatic" },
  { id: "manual", label: "Manual" },
];

const OPEN_ANIME_OPTIONS: { id: AppSettings["open_anime_with"]; label: string }[] = [
  { id: "page", label: "Anime page" },
  { id: "quick_edit", label: "Quick edit" },
];

// Settings -> About: what Tora is built on (links open in the browser)
const CREDITS: { name: string; role: string; license?: string; url: string }[] = [
  { name: "Taiga", role: "The anime tracker Tora is inspired by", url: "https://taiga.moe" },
  { name: "Anitomy", role: "Anime filename parsing", license: "MPL-2.0", url: "https://github.com/erengy/anitomy" },
  { name: "Anisthesia", role: "Media player detection", license: "MIT", url: "https://github.com/erengy/anisthesia" },
  { name: "anime-relations", role: "Sequel episode redirection", license: "CC0-1.0", url: "https://github.com/erengy/anime-relations" },
  { name: "AniList", role: "List sync, metadata, seasons & schedule", url: "https://anilist.co" },
  { name: "MyAnimeList", role: "List sync, metadata & seasons", url: "https://myanimelist.net" },
  { name: "Jikan", role: "MyAnimeList characters, staff & source manga", license: "MIT", url: "https://jikan.moe" },
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
  /** About → Updates: manual app + anime-relations check (same as clicking the sidebar version) */
  onCheckForUpdates: () => void;
  updateChecking: boolean;
  onOpenChangelog: () => void;
  /** Settings → Tracker: the account in use (the same confirmation / tracker page as the sidebar menu) */
  onSignOut: () => void;
  onOpenProfile: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onUpdateSettings,
  animeList,
  libraryRefreshTick,
  onRefreshAnimeList,
  sectionRequest,
  onCheckForUpdates,
  updateChecking,
  onOpenChangelog,
  onSignOut,
  onOpenProfile,
}) => {
  const { supports } = useTracker();
  const [section, setSection] = useState<SettingsSection>(sectionRequest?.section ?? "appearance");

  useEffect(() => {
    if (sectionRequest) setSection(sectionRequest.section);
  }, [sectionRequest]);

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

  const isManualUpdate = settings.update_mode === "manual";

  const handleSetAllPlayers = async (enabled: boolean) => {
    await onUpdateSettings({ ...settings, players: settings.players.map((p) => ({ ...p, enabled })) });
  };

  const browseMediaPlayer = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Select your media player",
      filters: [{ name: "Applications", extensions: ["exe"] }],
    });
    if (picked && typeof picked === "string") await onUpdateSettings({ ...settings, custom_media_player_path: picked });
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Section Navigation */}
      <nav className="w-52 shrink-0 p-4 space-y-1 border-r border-border-subtle overflow-y-auto">
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

      {/* Active Section (keyed so switching sections starts at the top) */}
      <div key={section} className="flex-1 min-w-0 overflow-y-auto [scrollbar-gutter:stable] p-6 space-y-6">
        {section === "appearance" && (
          <>
            <SettingsCard icon={Palette} title="Theme">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 py-3">
                {THEME_PRESETS.map((preset) => {
                  const active = settings.theme === preset.id;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => handleSelectTheme(preset.id, preset.defaultAccent)}
                      className={`text-left px-3 py-2.5 rounded-xl border transition flex items-center gap-3 ${active
                        ? "border-accent bg-accent/10 shadow-sm"
                        : "border-border-subtle bg-bg-primary hover:border-text-muted"
                        }`}
                    >
                      <div
                        className="w-8 h-8 rounded-lg border border-white/15 shrink-0 flex items-center justify-center shadow-inner"
                        style={{ backgroundColor: preset.previewBg }}
                      >
                        <div className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: preset.defaultAccent }} />
                      </div>
                      <span className="min-w-0 flex-1 truncate text-xs font-bold text-text-primary">{preset.name}</span>
                      {active && <CheckCircle2 className="w-3.5 h-3.5 text-accent shrink-0" />}
                    </button>
                  );
                })}
              </div>

              <SettingRow label="Accent color">
                <div className="flex flex-wrap items-center gap-2">
                  {ACCENT_SWATCHES.map((sw) => {
                    const active = settings.accent_color.toLowerCase() === sw.hex.toLowerCase();
                    return (
                      <button
                        key={sw.hex}
                        onClick={() => handleSelectAccent(sw.hex)}
                        title={sw.name}
                        aria-label={sw.name}
                        aria-pressed={active}
                        className={`w-6 h-6 rounded-full transition ring-offset-2 ring-offset-bg-secondary ${active ? "ring-2 ring-text-primary" : "hover:scale-110"
                          }`}
                        style={{ backgroundColor: sw.hex }}
                      />
                    );
                  })}
                  <span className="w-px h-5 bg-border-subtle mx-1" />
                  <input
                    type="color"
                    title="Custom color"
                    aria-label="Custom color"
                    value={settings.accent_color}
                    onChange={(e) => handleSelectAccent(e.target.value)}
                    className={`w-7 h-7 rounded-md cursor-pointer bg-transparent border-0 p-0 ring-offset-2 ring-offset-bg-secondary ${ACCENT_SWATCHES.some((sw) => sw.hex.toLowerCase() === settings.accent_color.toLowerCase())
                      ? ""
                      : "ring-2 ring-text-primary"
                      }`}
                  />
                </div>
              </SettingRow>
            </SettingsCard>

            <SettingsCard icon={Type} title="Display">
              <SettingRow icon={Languages} label="Title language" hint="Falls back to Romaji; torrent searches always use Romaji.">
                <Segmented
                  value={settings.title_language ?? "romaji"}
                  options={TITLE_LANGUAGES}
                  onChange={(id) => onUpdateSettings({ ...settings, title_language: id })}
                />
              </SettingRow>

              <SettingRow
                icon={CalendarDays}
                label="Date format"
                hint={`Auto uses your Windows region${systemDateLocale() ? ` (${systemDateLocale()})` : ""}.`}
              >
                <select
                  value={settings.date_locale ?? ""}
                  onChange={(e) => onUpdateSettings({ ...settings, date_locale: e.target.value })}
                  className="px-3 py-1.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
                >
                  {DATE_LOCALE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label} ({dateLocaleSample(o.id)})
                    </option>
                  ))}
                </select>
              </SettingRow>

              <SettingRow icon={Clock} label="Clock">
                <Segmented
                  value={settings.time_format ?? "auto"}
                  options={TIME_FORMATS}
                  onChange={(id) => onUpdateSettings({ ...settings, time_format: id })}
                />
              </SettingRow>

              <ToggleRow
                icon={Hourglass}
                label="Skip openings and endings in time left"
                hint="Subtracts 3 min per full-length episode"
                checked={settings.skip_op_ed}
                onChange={(checked) => onUpdateSettings({ ...settings, skip_op_ed: checked })}
              />
            </SettingsCard>

            <SettingsCard icon={MousePointerClick} title="Behavior">
              <SettingRow label="Double-click and Enter open" hint="Space or Ctrl+click opens the other view.">
                <Segmented
                  value={settings.open_anime_with ?? "page"}
                  options={OPEN_ANIME_OPTIONS}
                  onChange={(id) => onUpdateSettings({ ...settings, open_anime_with: id })}
                />
              </SettingRow>
            </SettingsCard>
          </>
        )}

        {section === "tracker" && (
          <>
            <TrackerSettings onSignOut={onSignOut} onOpenProfile={onOpenProfile} />

            {supports("activity_history") && <AniListHistorySettings settings={settings} />}
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
            <SettingsCard icon={ListChecks} title="List updates">
              <SettingRow label="Update mode" hint="Manual: confirm in Now Playing">
                <Segmented
                  value={settings.update_mode}
                  options={UPDATE_MODES}
                  onChange={(id) => onUpdateSettings({ ...settings, update_mode: id })}
                />
              </SettingRow>

              <SettingRow label="Update after" indent disabled={isManualUpdate}>
                <input
                  type="number"
                  min={2}
                  max={600}
                  disabled={isManualUpdate}
                  value={settings.recognition_delay_seconds}
                  onChange={(e) =>
                    onUpdateSettings({
                      ...settings,
                      recognition_delay_seconds: Math.max(2, Number(e.target.value)),
                    })
                  }
                  className="w-20 px-2.5 py-1.5 rounded-xl bg-bg-primary border border-border-subtle font-mono text-xs text-text-primary text-right focus:outline-none focus:border-accent disabled:cursor-not-allowed"
                />
                <span className="text-xs text-text-secondary">seconds</span>
              </SettingRow>

              {UPDATE_OPTIONS.map(({ key, label, hint }) => (
                <ToggleRow
                  key={key}
                  label={label}
                  hint={hint}
                  indent
                  disabled={isManualUpdate}
                  checked={settings[key]}
                  onChange={(checked) => onUpdateSettings({ ...settings, [key]: checked })}
                />
              ))}
            </SettingsCard>

            <SettingsCard icon={Radar} title="Detection">
              <ToggleRow
                label="Detect media players"
                checked={settings.recognition_enabled}
                onChange={(checked) => onUpdateSettings({ ...settings, recognition_enabled: checked })}
              />
              <ToggleRow
                label="Only detect files in my library"
                hint="Ignore streams and videos outside library folders"
                indent
                disabled={!settings.recognition_enabled}
                checked={settings.recognition_library_only}
                onChange={(checked) => onUpdateSettings({ ...settings, recognition_library_only: checked })}
              />
              <SettingGroup label="Open Now Playing when…" indent disabled={!settings.recognition_enabled}>
                {NOW_PLAYING_FOCUS_OPTIONS.map(({ key, label }) => (
                  <ToggleRow
                    key={key}
                    label={label}
                    compact
                    disabled={!settings.recognition_enabled}
                    checked={settings[key]}
                    onChange={(checked) => onUpdateSettings({ ...settings, [key]: checked })}
                  />
                ))}
              </SettingGroup>
            </SettingsCard>

            <SettingsCard icon={Play} title="While playing">
              <ToggleRow
                label="Discord Rich Presence"
                checked={settings.discord_presence_enabled}
                onChange={(checked) => onUpdateSettings({ ...settings, discord_presence_enabled: checked })}
              />
              <SettingRow label="Open episodes with" stacked>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={settings.custom_media_player_path}
                    onChange={(e) => onUpdateSettings({ ...settings, custom_media_player_path: e.target.value })}
                    placeholder="System default"
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle font-mono text-xs text-text-primary focus:outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => void browseMediaPlayer()}
                    className="px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold flex items-center gap-1.5 shrink-0"
                  >
                    <FolderOpen className="w-3.5 h-3.5" /> Browse…
                  </button>
                </div>
              </SettingRow>
            </SettingsCard>

            {/* Anisthesia Media Players Registry */}
            <SettingsCard
              icon={Cpu}
              title={`Supported Media Players (${settings.players.filter((p) => p.enabled).length}/${settings.players.length})`}
              actions={
                <>
                  <button
                    onClick={() => handleSetAllPlayers(true)}
                    disabled={settings.players.every((p) => p.enabled)}
                    className="px-2.5 py-1 rounded-lg bg-bg-tertiary hover:bg-bg-primary border border-border-subtle text-[11px] font-semibold text-text-secondary hover:text-text-primary transition disabled:opacity-40 disabled:cursor-default"
                  >
                    Select all
                  </button>
                  <button
                    onClick={() => handleSetAllPlayers(false)}
                    disabled={settings.players.every((p) => !p.enabled)}
                    className="px-2.5 py-1 rounded-lg bg-bg-tertiary hover:bg-bg-primary border border-border-subtle text-[11px] font-semibold text-text-secondary hover:text-text-primary transition disabled:opacity-40 disabled:cursor-default"
                  >
                    Deselect all
                  </button>
                </>
              }
            >
              <div className="divide-y divide-border-subtle max-h-96 overflow-y-auto pr-1 mb-2">
                {settings.players.map((player) => (
                  <ToggleRow
                    key={player.id}
                    label={player.name}
                    hint={<span className="font-mono">{player.executables.join(", ")}</span>}
                    checked={player.enabled}
                    onChange={() => handleTogglePlayer(player.id)}
                  />
                ))}
              </div>
            </SettingsCard>
          </>
        )}

        {section === "torrents" && (
          <TorrentSettingsSection settings={settings} onUpdateSettings={onUpdateSettings} />
        )}

        {section === "system" && (
          <SettingsCard icon={Monitor} title="Tray & Startup">
            {SYSTEM_OPTIONS.map(({ key, label, needs }) => (
              <ToggleRow
                key={key}
                label={label}
                indent={needs.length > 0}
                disabled={needs.some((k) => !settings[k])}
                checked={settings[key]}
                onChange={(checked) => onUpdateSettings({ ...settings, [key]: checked })}
              />
            ))}
          </SettingsCard>
        )}

        {section === "diagnostics" && (
          <>
            <MemoryPanel />
            <LogsPanel />
            <AnitomyParserPanel />
          </>
        )}

        {section === "about" && (
          <AboutSection
            settings={settings}
            onUpdateSettings={onUpdateSettings}
            onCheckForUpdates={onCheckForUpdates}
            updateChecking={updateChecking}
            onOpenChangelog={onOpenChangelog}
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

const MEMORY_GROUPS: [ProcessMemory["kind"], string][] = [
  ["core", "Core"],
  ["renderer", "Renderer"],
  ["gpu", "GPU"],
  ["browser", "WebView browser"],
  ["utility", "Utility"],
  ["other", "Other"],
];

/** Chromium's non-standard JS heap counters (WebView2 has them) */
type PerformanceWithMemory = Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } };

/**
 * Settings → Diagnostics: memory of each of Tora's processes, like Task Manager's "Memory" column
 * but split (Task Manager adds them up under "Tora"). Read on demand, never polled.
 */
const MemoryPanel: React.FC = () => {
  const showToast = useToast();
  const [processes, setProcesses] = useState<ProcessMemory[] | null>(null);
  const [page, setPage] = useState<{ heapUsed: number; heapTotal: number; domNodes: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setProcesses(await toraApi.getProcessMemory());
      const heap = (performance as PerformanceWithMemory).memory;
      setPage({
        heapUsed: heap?.usedJSHeapSize ?? 0,
        heapTotal: heap?.totalJSHeapSize ?? 0,
        domNodes: document.getElementsByTagName("*").length,
      });
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const sum = (list: ProcessMemory[], key: "private_working_set" | "private_bytes") =>
    list.reduce((n, p) => n + p[key], 0);
  const groups = MEMORY_GROUPS.map(([kind, label]) => {
    const list = processes?.filter((p) => p.kind === kind) ?? [];
    return { kind, label: list.length > 1 ? `${label} (${list.length})` : label, list };
  }).filter((g) => g.list.length > 0);

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-text-primary">Memory</h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
      {processes && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[11px] text-text-muted text-left">
              <th className="font-semibold pb-1.5">Process</th>
              <th className="font-semibold pb-1.5 text-right">Memory</th>
              <th className="font-semibold pb-1.5 text-right">Committed</th>
            </tr>
          </thead>
          <tbody className="text-text-primary">
            {groups.map((g) => (
              <tr key={g.kind} title={`PID ${g.list.map((p) => p.pid).join(", ")}`}>
                <td className="py-1">{g.label}</td>
                <td className="py-1 text-right font-mono">{formatBytes(sum(g.list, "private_working_set"))}</td>
                <td className="py-1 text-right font-mono text-text-secondary">
                  {formatBytes(sum(g.list, "private_bytes"))}
                </td>
              </tr>
            ))}
            <tr className="font-bold [&>td]:border-t [&>td]:border-border-subtle">
              <td className="pt-2">Total</td>
              <td className="pt-2 text-right font-mono">{formatBytes(sum(processes, "private_working_set"))}</td>
              <td className="pt-2 text-right font-mono text-text-secondary">
                {formatBytes(sum(processes, "private_bytes"))}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {page && (
        <div className="text-[11px] text-text-muted">
          Page: JS heap {formatBytes(page.heapUsed)} used of {formatBytes(page.heapTotal)} ·{" "}
          {page.domNodes.toLocaleString()} DOM nodes
        </div>
      )}
    </div>
  );
};

/** Settings → Diagnostics: where the log file is, open it, copy its end for a bug report. */
const LogsPanel: React.FC = () => {
  const showToast = useToast();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    toraApi.getAppInfo().then(setInfo).catch(logError("settings", "Loading app info failed"));
  }, []);

  const copyRecent = async () => {
    try {
      const text = await toraApi.getRecentLogs(200);
      await navigator.clipboard.writeText(text);
      showToast("Copied the last 200 log lines", "success");
    } catch (e) {
      showToast(String(e), "error");
    }
  };

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
      <h3 className="text-sm font-bold text-text-primary">Logs</h3>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] text-text-muted">Log folder</div>
          <div className="text-xs font-mono text-text-primary break-all">{info?.log_dir ?? "..."}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={copyRecent}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold transition"
          >
            <Copy className="w-3.5 h-3.5" />
            Copy recent log
          </button>
          <button
            onClick={() =>
              info && toraApi.revealInExplorer(info.log_dir).catch((e) => showToast(String(e), "error"))
            }
            disabled={!info}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold transition disabled:opacity-50"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open log folder
          </button>
        </div>
      </div>
    </div>
  );
};

const AboutSection: React.FC<{
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  onCheckForUpdates: () => void;
  updateChecking: boolean;
  onOpenChangelog: () => void;
  onRestored: (settings: AppSettings) => Promise<void>;
}> = ({ settings, onUpdateSettings, onCheckForUpdates, updateChecking, onOpenChangelog, onRestored }) => {
  const showToast = useToast();
  const [version, setVersion] = useState<string | null>(null);
  const [tauriVersion, setTauriVersion] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [relations, setRelations] = useState<RelationsInfo | null>(null);

  const loadRelations = () =>
    toraApi.getRelationsInfo().then(setRelations).catch(logError("settings", "Loading relations info failed"));

  useEffect(() => {
    getVersion().then(setVersion).catch(logError("settings", "Reading the app version failed"));
    getTauriVersion().then(setTauriVersion).catch(logError("settings", "Reading the Tauri version failed"));
    toraApi.getAppInfo().then(setInfo).catch(logError("settings", "Loading app info failed"));
    void loadRelations();
  }, []);

  // A manual check also downloads newer anime relations; show the new date once it finishes.
  useEffect(() => {
    if (!updateChecking) void loadRelations();
  }, [updateChecking]);

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
            Anime library manager and episode tracker
          </p>
          {tauriVersion && <p className="text-[11px] text-text-muted mt-1">Tauri {tauriVersion}</p>}
        </div>
      </div>

      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
        <h3 className="text-sm font-bold text-text-primary">Updates</h3>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="text-xs text-text-primary">
              Anime relations{" "}
              <span className="font-mono">{relations?.last_modified || "..."}</span>
              {relations && (
                <span className="text-[11px] text-text-muted">
                  {" "}
                  · {relations.rule_count} rules
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onOpenChangelog}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold transition"
            >
              <ScrollText className="w-3.5 h-3.5" />
              Changelog
            </button>
            <button
              onClick={onCheckForUpdates}
              disabled={updateChecking}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${updateChecking ? "animate-spin" : ""}`} />
              {updateChecking ? "Checking…" : "Check for updates"}
            </button>
          </div>
        </div>
        <div className="border-t border-border-subtle pt-3">
          <ToggleRow
            flush
            label="Check for updates on startup"
            checked={settings.check_updates_on_startup}
            onChange={(checked) => void onUpdateSettings({ ...settings, check_updates_on_startup: checked })}
          />
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
          Tora is not affiliated with AniList, MyAnimeList, Taiga or any torrent site.
        </p>
      </div>

      <SettingsBackupsPanel onRestored={onRestored} />
    </>
  );
};

