import React, { useState } from "react";
import { Check, X } from "lucide-react";
import { useScoreFormat } from "@/contexts/scoreFormat";
import { formatValueLabel, fromFormatValue, SCORE_SCALES, toFormatValue } from "@/lib/scores";
import type { ScoreFormat } from "@/lib/scores";

/** Values listed in the dropdown, best first, in the format's own unit */
function choicesOf(format: ScoreFormat): number[] {
  switch (format) {
    case "POINT_100":
      return [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
    case "POINT_10_DECIMAL":
    case "POINT_10":
      return [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    case "POINT_5":
      return [5, 4, 3, 2, 1];
    case "POINT_3":
      return [3, 2, 1];
  }
}

const ROW =
  "w-full flex items-center gap-2 px-3 py-1.5 text-left text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition";

/**
 * Score picker for the watchlist table's Score cell, in the AniList account's format: the format's
 * values (every one for stars / smileys / 10 point, steps of 10 for 100 point), a number field for
 * number formats and Clear. `onPick` gets the stored 0–100 score.
 */
export const ScoreDropdown: React.FC<{
  score: number;
  onPick: (score: number) => void;
}> = ({ score, onPick }) => {
  const format = useScoreFormat();
  const scale = SCORE_SCALES[format];
  const current = toFormatValue(score, format);
  const [typed, setTyped] = useState(current > 0 ? String(current) : "");

  const commitTyped = () => {
    const value = Number(typed);
    if (typed.trim() === "" || !Number.isFinite(value)) return;
    onPick(fromFormatValue(value, format));
  };

  return (
    <div className="w-44 rounded-xl bg-bg-secondary/95 backdrop-blur-md border border-accent/40 shadow-2xl py-1.5 text-xs select-none">
      <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">Your score</div>
      {scale.numeric && (
        <div className="px-3 py-1.5 flex items-center gap-1.5">
          <input
            type="number"
            autoFocus
            min={0}
            max={scale.max}
            step={scale.step}
            value={typed}
            placeholder={`0–${scale.max}`}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTyped();
              }
            }}
            className="min-w-0 flex-1 px-2 py-1 rounded-md bg-bg-primary border border-border-subtle font-mono text-text-primary focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={commitTyped}
            title="Save score"
            className="shrink-0 p-1 rounded-md bg-accent/15 text-accent hover:bg-accent hover:text-white transition"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      <div className="max-h-72 overflow-y-auto">
        {choicesOf(format).map((v) => {
          const picked = v === current;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onPick(fromFormatValue(v, format))}
              className={`${ROW} ${picked ? "text-accent font-semibold" : ""}`}
            >
              <span className="w-3.5 shrink-0">{picked && <Check className="w-3.5 h-3.5" />}</span>
              {format === "POINT_5" ? (
                <span className="tracking-widest">
                  <span className="text-amber-400">{"★".repeat(v)}</span>
                  <span className="text-text-muted/40">{"★".repeat(scale.max - v)}</span>
                </span>
              ) : (
                <span className={format === "POINT_3" ? "text-sm" : "font-mono"}>
                  {formatValueLabel(v, format)}
                  {scale.suffix && <span className="text-text-muted font-normal">{scale.suffix}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="my-1 border-t border-border-subtle" />
      <button type="button" disabled={current === 0} onClick={() => onPick(0)} className={`${ROW} disabled:opacity-50 disabled:pointer-events-none`}>
        <X className="w-3.5 h-3.5 shrink-0" />
        Clear score
      </button>
    </div>
  );
};
