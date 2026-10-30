import React from "react";
import { useScoreFormat } from "@/contexts/scoreFormat";
import { formatValueLabel, fromFormatValue, SCORE_SCALES, toFormatValue } from "@/lib/scores";

/**
 * Score editor in the AniList account's format: a number field (100 / 10 / 10.0 point), or star /
 * smiley buttons (5 point, 3 point; clicking the picked one clears it). Values are stored 0–100.
 * `onChange` follows typing; `onCommit` is when to save (blur, or a button pick).
 */
export const ScoreInput: React.FC<{
  score: number;
  onChange: (score: number) => void;
  onCommit: (score: number) => void;
}> = ({ score, onChange, onCommit }) => {
  const format = useScoreFormat();
  const scale = SCORE_SCALES[format];
  const value = toFormatValue(score, format);

  if (scale.numeric) {
    return (
      <input
        type="number"
        min={0}
        max={scale.max}
        step={scale.step}
        value={value}
        onChange={(e) => onChange(fromFormatValue(Number(e.target.value), format))}
        onBlur={() => onCommit(score)}
        className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
      />
    );
  }

  const pick = (v: number) => {
    const next = fromFormatValue(v === value ? 0 : v, format);
    onChange(next);
    onCommit(next);
  };
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: scale.max }, (_, i) => i + 1).map((v) => {
        // Stars fill up to the value; smileys highlight only the picked one
        const on = format === "POINT_5" ? v <= value : v === value;
        return (
          <button
            key={v}
            type="button"
            onClick={() => pick(v)}
            title={v === value ? "Clear score" : `Score ${formatValueLabel(v, format)}`}
            className={`flex-1 py-1.5 rounded-lg border text-sm transition ${on
              ? "bg-accent/15 border-accent text-amber-400"
              : "bg-bg-primary border-border-subtle text-text-muted hover:border-accent/60"
              } ${format === "POINT_3" && !on ? "grayscale opacity-60 hover:grayscale-0 hover:opacity-100" : ""}`}
          >
            {format === "POINT_5" ? "★" : formatValueLabel(v, format)}
          </button>
        );
      })}
    </div>
  );
};
