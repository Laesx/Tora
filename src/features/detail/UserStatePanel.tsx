import React from "react";
import { Minus, Plus } from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { playRewatchStart } from "@/lib/anime";
import { useToast } from "@/contexts/toast";
import { useScoreFormat } from "@/contexts/scoreFormat";
import { formatScore, SCORE_SCALES } from "@/lib/scores";
import { ScoreInput } from "@/components/ScoreInput";
import { DateInput } from "@/components/DateInput";
import { todayIso } from "@/lib/dates";
import { EntryEditor } from "./useEntryEditor";

const LABEL = "block text-[11px] font-medium text-text-muted uppercase mb-1";
const FIELD =
  "w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent";

/**
 * Status, progress, score, rewatches and dates of a list entry; `compact` stacks them for a side column.
 * `extra` is a last full-width row under a divider (the anime page: custom lists).
 */
export const UserStatePanel: React.FC<{
  anime: AnimeEntry;
  editor: EntryEditor;
  compact?: boolean;
  extra?: { label: React.ReactNode; content: React.ReactNode };
}> = ({
  anime,
  editor,
  compact = false,
  extra,
}) => {
  const showToast = useToast();
  const scoreFormat = useScoreFormat();
  const {
    status,
    setStatus,
    progress,
    setProgress,
    score,
    setScore,
    repeats,
    setRepeats,
    startedAt,
    setStartedAt,
    completedAt,
    setCompletedAt,
    handleSave,
    stepEpisode,
    stageDates,
    commitDates,
  } = editor;

  return (
    <div
      className={`grid gap-3 bg-bg-tertiary/40 p-4 rounded-xl border border-border-subtle ${
        compact ? "grid-cols-2" : "grid-cols-1 md:grid-cols-4"
      }`}
    >
      <div className={compact ? "col-span-2" : ""}>
        <label className={LABEL}>Watch Status</label>
        <select
          value={status}
          onChange={async (e) => {
            const nextSt = e.target.value;
            // Same rule as normalize_change: a rewatch restarts, completing fills the total
            let nextProg = progress;
            if (nextSt === "REPEATING") nextProg = 0;
            else if (nextSt === "COMPLETED" && anime.episodes) nextProg = anime.episodes;
            setStatus(nextSt);
            setProgress(nextProg);
            await handleSave(nextSt, nextProg, score, repeats, false);
            if (nextSt === "REPEATING") await playRewatchStart(anime, showToast);
          }}
          className="w-full px-2.5 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="CURRENT">Watching</option>
          <option value="PLANNING">Plan to Watch</option>
          <option value="COMPLETED">Completed</option>
          <option value="PAUSED">Paused / On Hold</option>
          <option value="DROPPED">Dropped</option>
          <option value="REPEATING">Rewatching</option>
        </select>
      </div>

      <div className={compact ? "col-span-2" : ""}>
        <label className={LABEL}>Episode Progress</label>
        <div className="flex items-center gap-1">
          <button
            onClick={() => stepEpisode(-1)}
            className="p-2 rounded-lg bg-bg-primary border border-border-subtle hover:border-accent text-text-secondary hover:text-text-primary"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <div className="flex-1 text-center font-mono text-xs font-semibold bg-bg-primary py-2 rounded-lg border border-border-subtle">
            {progress} / {anime.episodes ?? "?"}
          </div>
          <button
            onClick={() => stepEpisode(1)}
            className="p-2 rounded-lg bg-bg-primary border border-border-subtle hover:border-accent text-text-secondary hover:text-text-primary"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div>
        <label className={LABEL}>
          Your Score ({formatScore(score, scoreFormat) || "–"}
          {SCORE_SCALES[scoreFormat].suffix})
        </label>
        <ScoreInput
          score={score}
          onChange={setScore}
          onCommit={(next) => handleSave(status, progress, next, repeats, false)}
        />
      </div>

      <div>
        <label className={LABEL}>Rewatch Count</label>
        <input
          type="number"
          min={0}
          max={99}
          value={repeats}
          onChange={(e) => setRepeats(Number(e.target.value))}
          onBlur={() => handleSave(status, progress, score, repeats, false)}
          className={FIELD}
        />
      </div>

      <div className={compact ? "col-span-2" : "md:col-span-2"}>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-[11px] font-medium text-text-muted uppercase">Date Started</label>
          <button
            type="button"
            onClick={() => {
              const today = todayIso();
              setStartedAt(today);
              handleSave(status, progress, score, repeats, false, today, completedAt);
            }}
            className="text-[10px] font-semibold text-accent hover:underline"
          >
            Set Today
          </button>
        </div>
        <DateInput
          value={startedAt}
          onChange={(nextDate) => {
            setStartedAt(nextDate);
            stageDates(nextDate, completedAt);
          }}
          onCommit={(nextDate) => commitDates(nextDate, completedAt)}
          className={FIELD}
        />
      </div>

      <div className={compact ? "col-span-2" : "md:col-span-2"}>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-[11px] font-medium text-text-muted uppercase">Date Completed</label>
          <button
            type="button"
            onClick={() => {
              const today = todayIso();
              setCompletedAt(today);
              handleSave(status, progress, score, repeats, false, startedAt, today);
            }}
            className="text-[10px] font-semibold text-accent hover:underline"
          >
            Set Today
          </button>
        </div>
        <DateInput
          value={completedAt}
          onChange={(nextDate) => {
            setCompletedAt(nextDate);
            stageDates(startedAt, nextDate);
          }}
          onCommit={(nextDate) => commitDates(startedAt, nextDate)}
          className={FIELD}
        />
      </div>
      {extra && (
        <div className={`${compact ? "col-span-2" : "md:col-span-4"} pt-3 border-t border-border-subtle`}>
          <label className={LABEL}>{extra.label}</label>
          {extra.content}
        </div>
      )}
    </div>
  );
};
