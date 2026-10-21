import React, { useEffect, useState } from "react";
import {
  Cpu,
  Play,
  Square,
  Terminal,
  FlaskConical,
} from "lucide-react";
import {
  AppSettings,
  DetectedMediaSession,
  FilenameTestResult,
} from "../types";
import { toraApi } from "../api";

interface TestingViewProps {
  activeSession: DetectedMediaSession | null;
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => Promise<void>;
  onSimulate: (playerName: string | null, windowTitle: string | null) => Promise<void>;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

const SAMPLE_FILENAMES = [
  "[Judas] Kusuriya - S03E03.mkv",
  "[SubsPlease] Kusuriya no Hitorigoto - 51 (1080p) [ABCD1234].mkv",
  "[EMBER] Bocchi the Rock! - S02E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
  "[SubsPlease] Sousou no Frieren - 25 (1080p) [A12B3C4D].mkv",
  "[Erai-raws] Dandadan - 09v2 [1080p][HEVC 10bit][Multiple Subtitle][99AABBCC].mkv",
  "[SomeGroup] Unrecognized Mystery Anime - 04 [1080p].mkv",
];

export const TestingView: React.FC<TestingViewProps> = ({
  activeSession,
  settings,
  onUpdateSettings,
  onSimulate,
  showToast,
}) => {
  const [testInput, setTestInput] = useState(SAMPLE_FILENAMES[0]);
  const [testResult, setTestResult] = useState<FilenameTestResult | null>(null);
  const [simPlayer, setSimPlayer] = useState("mpv");

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
            <FlaskConical className="w-6 h-6 text-accent" />
            Testing & Diagnostics Sandbox
          </h1>
          <p className="text-xs text-text-secondary mt-0.5">
            Interactive Anitomy C++ parser sandbox, playback session simulator, and Anisthesia media player registry.
          </p>
        </div>
      </div>

      {/* Playback Simulator Card */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Play className="w-4 h-4 text-accent" />
              Media Playback Simulator
            </h2>
            <p className="text-xs text-text-secondary mt-0.5">
              Simulate a live media player window using the filename selected below. Starting playback automatically focuses the Episode Detection tab.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              value={simPlayer}
              onChange={(e) => setSimPlayer(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-text-primary"
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

            {activeSession && (
              <button
                onClick={() => onSimulate(null, null)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-400 font-semibold transition"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                Stop Session
              </button>
            )}
          </div>
        </div>
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
                className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition truncate max-w-[260px] ${
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
              <div className="font-bold text-text-primary mt-0.5 truncate" title={testResult.parsed.anime_title}>
                {testResult.parsed.anime_title || "-"}
              </div>
            </div>

            <div className="p-3 rounded-xl bg-bg-primary border border-border-subtle">
              <div className="text-[10px] uppercase text-text-muted">
                Season / Episode
              </div>
              <div className="font-bold font-mono text-accent mt-0.5">
                {testResult.parsed.anime_season
                  ? `S${String(testResult.parsed.anime_season).padStart(2, "0")} · `
                  : ""}
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
              <div
                className={`font-bold mt-0.5 truncate ${
                  testResult.matched_anime_title
                    ? "text-emerald-400"
                    : "text-amber-400"
                }`}
                title={testResult.matched_anime_title || "Unmatched"}
              >
                {testResult.matched_anime_title || "Unmatched"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Anisthesia Media Players Registry */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3">
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <Cpu className="w-4 h-4 text-accent" />
          Anisthesia Supported Windows Media Players ({settings.players.length})
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
    </div>
  );
};
