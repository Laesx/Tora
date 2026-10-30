// User scores in the AniList account's score format. Scores are stored and synced on the 0–100
// scale (`user_score`, 0 = unscored); the format only changes how they are shown and entered.

export type ScoreFormat = "POINT_100" | "POINT_10_DECIMAL" | "POINT_10" | "POINT_5" | "POINT_3";

export const DEFAULT_SCORE_FORMAT: ScoreFormat = "POINT_100";

const FORMATS: ScoreFormat[] = ["POINT_100", "POINT_10_DECIMAL", "POINT_10", "POINT_5", "POINT_3"];

export function parseScoreFormat(raw: string | null | undefined): ScoreFormat {
  return FORMATS.includes(raw as ScoreFormat) ? (raw as ScoreFormat) : DEFAULT_SCORE_FORMAT;
}

interface ScoreScale {
  /** Highest value in the format's own unit */
  max: number;
  /** Input step (number formats) */
  step: number;
  /** "/100", "/10", "/5", or "" for smileys */
  suffix: string;
  /** Typed into a number field; otherwise picked from `choices` (stars, smileys) */
  numeric: boolean;
  /** Quick-pick values in the format's unit, best first */
  presets: number[];
}

export const SCORE_SCALES: Record<ScoreFormat, ScoreScale> = {
  POINT_100: { max: 100, step: 1, suffix: "/100", numeric: true, presets: [100, 90, 80, 70] },
  POINT_10_DECIMAL: { max: 10, step: 0.1, suffix: "/10", numeric: true, presets: [10, 9, 8, 7] },
  POINT_10: { max: 10, step: 1, suffix: "/10", numeric: true, presets: [10, 9, 8, 7] },
  POINT_5: { max: 5, step: 1, suffix: "/5", numeric: false, presets: [5, 4, 3, 2, 1] },
  POINT_3: { max: 3, step: 1, suffix: "", numeric: false, presets: [3, 2, 1] },
};

/** AniList's smileys, by POINT_3 value */
const SMILEYS = ["", "🙁", "😐", "🙂"];
/** What AniList stores for each POINT_3 value */
const POINT_3_TO_100 = [0, 35, 60, 85];

/** Stored 0–100 → the format's value (0 = unscored; a scored entry never rounds down to 0). */
export function toFormatValue(score: number, format: ScoreFormat): number {
  if (!(score > 0)) return 0;
  switch (format) {
    case "POINT_100":
      return Math.round(score);
    case "POINT_10_DECIMAL":
      return Math.max(0.1, Math.round(score) / 10);
    case "POINT_10":
      return Math.max(1, Math.round(score / 10));
    case "POINT_5":
      return Math.max(1, Math.round(score / 20));
    case "POINT_3":
      return score >= 61 ? 3 : score >= 36 ? 2 : 1;
  }
}

/** The format's value → stored 0–100 (clamped; 0 clears the score). */
export function fromFormatValue(value: number, format: ScoreFormat): number {
  const { max } = SCORE_SCALES[format];
  const v = Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
  switch (format) {
    case "POINT_100":
      return Math.round(v);
    case "POINT_10_DECIMAL":
      return Math.round(v * 10);
    case "POINT_10":
      return Math.round(v) * 10;
    case "POINT_5":
      return Math.round(v) * 20;
    case "POINT_3":
      return POINT_3_TO_100[Math.round(v)];
  }
}

/** A format value as text: "85", "7.5", "8", "4★", "🙂". */
export function formatValueLabel(value: number, format: ScoreFormat): string {
  if (!(value > 0)) return "";
  switch (format) {
    case "POINT_10_DECIMAL":
      return value.toFixed(1).replace(/\.0$/, "");
    case "POINT_5":
      return `${value}★`;
    case "POINT_3":
      return SMILEYS[value] ?? "";
    default:
      return String(value);
  }
}

/** A stored 0–100 score as the user's format shows it; "" when unscored. */
export function formatScore(score: number, format: ScoreFormat): string {
  return formatValueLabel(toFormatValue(score, format), format);
}

/** A mean of stored 0–100 scores in the format's unit, one decimal ("7.4", "3.8★"); smileys show the nearest one. */
export function formatMeanScore(mean: number, format: ScoreFormat): string {
  switch (format) {
    case "POINT_100":
      return mean.toFixed(1);
    case "POINT_10_DECIMAL":
    case "POINT_10":
      return (mean / 10).toFixed(1);
    case "POINT_5":
      return `${(mean / 20).toFixed(1)}★`;
    case "POINT_3":
      return formatScore(mean, format);
  }
}
