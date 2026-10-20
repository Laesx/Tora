import React, { useEffect, useState } from "react";
import {
  Activity,
  Cpu,
  Play,
  Square,
  CheckCircle2,
  Clock,
  Sparkles,
  Tv,
  History,
  Terminal,
} from "lucide-react";
import {
  AppSettings,
  DetectedMediaSession,
  FilenameTestResult,
  WatchHistoryEntry,
} from "../types";
import { toraApi } from "../api";

interface RecognitionViewProps {
  activeSession: DetectedMediaSession | null;
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  onSimulate: (playerName: string | null, windowTitle: string | null) => Promise<void>;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

const SAMPLE_FILENAMES = [
  "[SubsPlease] Sousou no Frieren - 25 (1080p) [A12B3C4D].mkv",
  "[Erai-raws] Dandadan - 09v2 [1080p][HEVC 10bit][Multiple Subtitle][99AABBCC].mkv",
  "[EMBER] Bocchi the Rock! - S01E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
  "[Trigger] Dungeon Meshi - 19 [1080p][AV1 10-bit][FLAC].mkv",
  "[Coalgirls] Toradora! - 25 (1920x1080 Blu-ray FLAC) [ABCD1234].mkv",
];

export const RecognitionView: React.FC<RecognitionViewProps> = ({
  activeSession,
  settings,
  onUpdateSettings,
  onSimulate,
  showToast,
}) => {
  const [testInput, setTestInput] = useState(SAMPLE_FILENAMES[0]);
  const [testResult, setTestResult] = useState<FilenameTestResult | null>(null);
  const [simPlayer, setSimPlayer] = useState("mpv");
  const [history, setHistory] = useState<WatchHistoryEntry[]>([]);

  const loadHistory = async () => {
    try {
      const h = await toraApi.getWatchHistory();
      setHistory(h);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadHistory();
  }, [activeSession?.auto_synced]);

  useEffect(() => {
    let cancelled = false;
    toraApi.testParseFilename(testInput).then((res) => {
      if (!cancelled) setTestResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [testInput]);

  const handleTogglePlayer = async (playerId: string) => {
    const updatedPlayers = settings.players.map((p) =>
      p.id === playerId ? { ...p, enabled: !p.enabled } : p
    );
    await onUpdateSettings({ ...settings, players: updatedPlayers });
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
            <Activity className="w-6 h-6 text-accent" />
            Episode Recognition Engine (Anisthesia + Anitomy)
          </h1>
          <p className="text-xs text-text-secondary mt-0.5">
            Real-time Win32 media player window inspection & Anitomy filename tokenization with automatic progress scrobbling.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-bg-secondary border border-border-subtle text-xs font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={settings.recognition_enabled}
              onChange={(e) =>
                onUpdateSettings({
                  ...settings,
                  recognition_enabled: e.target.checked,
                })
              }
              className="rounded accent-accent"
            />
            <span>Live Win32 Player Detection</span>
          </label>
        </div>
      </div>

      {/* Live Active Session Status Card */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Tv className="w-4 h-4 text-accent" />
            Active Media Player Session
          </h2>
          {activeSession ? (
            <button
              onClick={() => onSimulate(null, null)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-400 text-xs font-semibold transition"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              Stop Simulated Session
            </button>
          ) : (
            <span className="text-xs text-text-muted flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Polling Windows media players every 2s...
            </span>
          )}
        </div>

        {activeSession ? (
          <div className="flex flex-wrap items-center gap-5 p-4 rounded-xl bg-bg-primary border border-accent/40">
            {activeSession.matched_cover_image && (
              <img
                src={activeSession.matched_cover_image}
                alt={activeSession.matched_anime_title || ""}
                className="w-16 h-24 object-cover rounded-lg border border-border-subtle shrink-0"
              />
            )}
            <div className="flex-1 min-w-[240px] space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-accent text-white text-[11px] font-bold">
                  {activeSession.player_name} (PID {activeSession.process_id})
                </span>
                {activeSession.auto_synced ? (
                  <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[11px] font-semibold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Progress Updated!
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[11px] font-mono flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    Updating in{" "}
                    {Math.max(
                      0,
                      settings.recognition_delay_seconds -
                        activeSession.elapsed_seconds
                    )}
                    s
                  </span>
                )}
              </div>

              <div className="text-base font-bold text-text-primary">
                {activeSession.matched_anime_title ||
                  activeSession.parsed.anime_title}{" "}
                — Episode {activeSession.parsed.episode_number ?? "?"}
              </div>

              <div className="text-xs font-mono text-text-muted truncate">
                Window Title: {activeSession.raw_window_title}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-xl bg-bg-primary/60 border border-border-subtle flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="text-text-secondary">
              Open any video file in{" "}
              <strong className="text-text-primary">
                mpv, VLC, MPC-HC, MPC-BE, or PotPlayer
              </strong>{" "}
              to detect automatically, or test recognition right now with the simulator:
            </div>
            <div className="flex items-center gap-2">
              <select
                value={simPlayer}
                onChange={(e) => setSimPlayer(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg bg-bg-secondary border border-border-subtle text-text-primary"
              >
                <option value="mpv">mpv</option>
                <option value="MPC-HC">MPC-HC</option>
                <option value="VLC media player">VLC media player</option>
                <option value="Daum PotPlayer">Daum PotPlayer</option>
              </select>
              <button
                onClick={() => {
                  onSimulate(simPlayer, testInput);
                  showToast(
                    `Simulating playback in ${simPlayer}: ${testInput}`,
                    "info"
                  );
                }}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold transition"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Simulate Selected Filename
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Interactive Anitomy Filename Parser Sandbox */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <Terminal className="w-4 h-4 text-accent" />
          Interactive Anitomy Filename & Window Title Parser
        </h2>

        <div className="space-y-2">
          <input
            type="text"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="Paste any anime filename or window title to inspect Anitomy tokens..."
            className="w-full px-4 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
          />

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-text-muted mr-1">Presets:</span>
            {SAMPLE_FILENAMES.map((sample) => (
              <button
                key={sample}
                onClick={() => setTestInput(sample)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition truncate max-w-[240px] ${
                  testInput === sample
                    ? "bg-accent/20 border-accent text-accent"
                    : "bg-bg-primary border-border-subtle text-text-secondary hover:text-text-primary"
                }`}
              >
                {sample}
              </button>
            ))}
          </div>
        </div>

        {testResult && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5 pt-2 text-xs">
            <div className="p-3 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] uppercase text-text-muted">
                Anime Title
              </div>
              <div className="font-bold text-text-primary mt-0.5 truncate">
                {testResult.parsed.anime_title || "-"}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] uppercase text-text-muted">
                Episode / Ver
              </div>
              <div className="font-bold font-mono text-accent mt-0.5">
                Ep {testResult.parsed.episode_number ?? "-"}
                {testResult.parsed.episode_version
                  ? ` (v${testResult.parsed.episode_version})`
                  : ""}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] uppercase text-text-muted">
                Release Group
              </div>
              <div className="font-semibold font-mono text-text-primary mt-0.5">
                {testResult.parsed.release_group || "-"}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] uppercase text-text-muted">
                Resolution & Source
              </div>
              <div className="font-semibold font-mono text-emerald-400 mt-0.5">
                {testResult.parsed.video_resolution || "-"}{" "}
                {testResult.parsed.source ? `(${testResult.parsed.source})` : ""}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] uppercase text-text-muted">
                Video / Audio Codec
              </div>
              <div className="font-mono text-blue-400 mt-0.5 truncate">
                {[
                  ...testResult.parsed.video_term,
                  ...testResult.parsed.audio_term,
                ].join(", ") || "-"}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] uppercase text-text-muted">
                Library Match
              </div>
              <div className="font-bold text-emerald-400 mt-0.5 truncate">
                {testResult.matched_anime_title || "Unmatched"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Two-Column Bottom: Anisthesia Player Registry & Watch History */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Anisthesia Media Players */}
        <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Cpu className="w-4 h-4 text-accent" />
            Anisthesia Supported Windows Media Players ({settings.players.length})
          </h2>

          <div className="divide-y divide-border-subtle max-h-80 overflow-y-auto pr-1">
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

        {/* Scrobble & Watch History */}
        <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <History className="w-4 h-4 text-accent" />
            Recent Recognition & Scrobble History
          </h2>

          {history.length === 0 ? (
            <div className="py-12 text-center text-xs text-text-muted">
              No episodes scrobbled yet. Play an episode or click "Simulate Selected Filename" above!
            </div>
          ) : (
            <div className="divide-y divide-border-subtle max-h-80 overflow-y-auto pr-1">
              {history.map((h) => (
                <div
                  key={h.id}
                  className="py-2.5 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-text-primary truncate">
                      {h.anime_title}{" "}
                      <span className="text-accent font-mono">
                        Ep {h.episode_number}
                      </span>
                    </div>
                    <div className="text-[11px] text-text-muted font-mono truncate">
                      {h.player_name} • {h.file_name}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-[10px] font-mono text-text-muted block">
                      {new Date(h.timestamp_unix * 1000).toLocaleTimeString()}
                    </span>
                    {h.scrobbled_to_tracker && (
                      <span className="text-[10px] text-emerald-400 font-semibold">
                        Synced
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
