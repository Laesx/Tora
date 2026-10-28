import React, { useEffect, useState } from "react";
import { Terminal } from "lucide-react";
import { FilenameTestResult } from "../types";
import { toraApi } from "../api";

const SAMPLE_FILENAMES = [
  "[Judas] Kusuriya - S03E03.mkv",
  "[SubsPlease] Kusuriya no Hitorigoto - 51 (1080p) [ABCD1234].mkv",
  "[EMBER] Bocchi the Rock! - S02E12 [1080p] [HEVC WEBRip 10bit] [Dual-Audio].mkv",
  "[SubsPlease] Sousou no Frieren - 25 (1080p) [A12B3C4D].mkv",
  "[Erai-raws] Dandadan - 09v2 [1080p][HEVC 10bit][Multiple Subtitle][99AABBCC].mkv",
  "[SomeGroup] Unrecognized Mystery Anime - 04 [1080p].mkv",
];

export const AnitomyParserPanel: React.FC = () => {
  const [testInput, setTestInput] = useState(SAMPLE_FILENAMES[0]);
  const [testResult, setTestResult] = useState<FilenameTestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    toraApi.testParseFilename(testInput).then((res) => {
      if (!cancelled) setTestResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [testInput]);

  return (
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
  );
};
