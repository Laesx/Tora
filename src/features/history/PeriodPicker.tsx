import React, { useEffect, useMemo, useRef, useState } from "react";
import { HistorySource, MonthCount } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { log } from "@/lib/log";
import { SEASONS, seasonName } from "@/lib/seasons";
import { HistoryPeriod, MonthKey, monthId, monthIndex, monthRange, periodMonths } from "./period";

interface PeriodPickerProps {
  period: HistoryPeriod | null;
  /** The list's source and title search: the counts follow them */
  source: HistorySource;
  search: string;
  /** Changes when the counts may have changed */
  refreshKey: unknown;
  onSelect: (period: HistoryPeriod) => void;
  /** Back to all time */
  onClear: () => void;
  onClose: () => void;
}

const MONTHS = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString(undefined, { month: "short" }));
// Same steps as the Stats heatmap: accent opacity per quarter of the busiest month
const HEAT_OPACITY = [0, 0.3, 0.5, 0.75, 1];
const heatLevel = (count: number, max: number) => (count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4)));

/**
 * History period picker: one row per year (newest on top), its months shaded by episodes watched, and a
 * season strip under each quarter. A month, a season strip or a year label picks that period; shift-click
 * a second month for a range.
 */
export const PeriodPicker: React.FC<PeriodPickerProps> = ({
  period,
  source,
  search,
  refreshKey,
  onSelect,
  onClear,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [counts, setCounts] = useState<MonthCount[] | null>(null);
  const [anchor, setAnchor] = useState<MonthKey | null>(
    period?.unit === "month" ? period : period?.unit === "range" ? period.from : null
  );

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    toraApi
      .getHistoryMonthCounts(source, search || null)
      .then((c) => !cancelled && setCounts(c))
      .catch((e) => log.error("history", "Loading the month counts failed", e));
    return () => {
      cancelled = true;
    };
  }, [source, search, refreshKey]);

  const now = new Date();
  const thisMonth = monthIndex({ year: now.getFullYear(), month: now.getMonth() });
  const { byMonth, max, years } = useMemo(() => {
    const byMonth = new Map((counts ?? []).map((c) => [c.month, c.episodes]));
    const max = Math.max(1, ...byMonth.values());
    const first = counts?.length ? Number(counts[0].month.slice(0, 4)) : now.getFullYear();
    const years: number[] = [];
    for (let y = now.getFullYear(); y >= Math.min(first, now.getFullYear()); y--) years.push(y);
    return { byMonth, max, years };
  }, [counts]);

  const [selStart, selEnd] = period && period.unit !== "day" ? periodMonths(period) : [0, 0];
  const selected = (i: number) => i >= selStart && i < selEnd;

  const pickMonth = (k: MonthKey, shift: boolean) => {
    if (shift && anchor) {
      onSelect(monthRange(anchor, k));
      return;
    }
    setAnchor(k);
    onSelect({ unit: "month", ...k });
  };

  return (
    <div
      ref={ref}
      className="absolute z-40 top-full right-0 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] p-3 rounded-xl bg-bg-secondary border border-border-subtle shadow-2xl space-y-2"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-text-primary">Show a period</span>
        <button
          onClick={onClear}
          disabled={!period}
          className="px-2 py-0.5 rounded-lg text-[11px] font-semibold text-text-secondary hover:text-text-primary hover:bg-bg-tertiary disabled:opacity-40 disabled:hover:bg-transparent transition"
        >
          All time
        </button>
      </div>

      <div className="flex items-center gap-2 pl-24 text-[9px] font-mono text-text-muted">
        {SEASONS.map((s, q) => (
          <div key={s} className="flex-1 grid grid-cols-3 gap-0.5 text-center">
            {MONTHS.slice(q * 3, q * 3 + 3).map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
        ))}
      </div>

      <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
        {years.map((year) => {
          const total = Array.from({ length: 12 }, (_, m) => byMonth.get(monthId({ year, month: m })) ?? 0).reduce(
            (a, b) => a + b,
            0
          );
          const yearSelected = period?.unit === "year" && period.year === year;
          return (
            <div key={year} className="flex items-start gap-2">
              <button
                onClick={() => onSelect({ unit: "year", year })}
                title={`All of ${year}`}
                className={`w-12 shrink-0 py-1 rounded-lg text-xs font-bold font-mono transition ${
                  yearSelected ? "bg-accent text-white" : "text-text-primary hover:bg-bg-tertiary"
                }`}
              >
                {year}
              </button>
              <span className="w-8 shrink-0 pt-1.5 text-right text-[10px] font-mono text-text-muted">
                {counts ? total : ""}
              </span>
              {SEASONS.map((s, q) => {
                const seasonSelected = period?.unit === "season" && period.year === year && period.season === s;
                const seasonFuture = year * 12 + q * 3 > thisMonth;
                return (
                  <div key={s} className="flex-1 space-y-0.5">
                    <div className="grid grid-cols-3 gap-0.5">
                      {[0, 1, 2].map((offset) => {
                        const k = { year, month: q * 3 + offset };
                        const i = monthIndex(k);
                        const count = byMonth.get(monthId(k)) ?? 0;
                        const level = heatLevel(count, max);
                        const future = i > thisMonth;
                        return (
                          <button
                            key={offset}
                            disabled={future}
                            onClick={(e) => pickMonth(k, e.shiftKey)}
                            title={`${MONTHS[k.month]} ${year}: ${count} episode${count === 1 ? "" : "s"}`}
                            className={`relative h-6 rounded overflow-hidden text-[9px] font-mono transition disabled:opacity-30 disabled:cursor-default ${
                              selected(i) ? "ring-2 ring-text-primary" : i === thisMonth ? "ring-1 ring-accent/60" : ""
                            } ${level === 0 ? "bg-bg-tertiary text-text-muted" : "text-white"} enabled:hover:brightness-125`}
                          >
                            {level > 0 && (
                              <span className="absolute inset-0 bg-accent" style={{ opacity: HEAT_OPACITY[level] }} />
                            )}
                            <span className="relative">{count > 0 ? count : ""}</span>
                          </button>
                        );
                      })}
                    </div>
                    <button
                      disabled={seasonFuture}
                      onClick={() => onSelect({ unit: "season", year, season: s })}
                      title={`${seasonName(s)} ${year}`}
                      className={`w-full h-3.5 rounded text-[8px] font-semibold uppercase tracking-wide leading-none transition disabled:opacity-30 disabled:cursor-default ${
                        seasonSelected
                          ? "bg-accent text-white"
                          : "bg-bg-primary text-text-muted enabled:hover:text-text-primary enabled:hover:bg-bg-tertiary"
                      }`}
                    >
                      {seasonName(s)}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-text-muted border-t border-border-subtle pt-2">
        Click a month, a season or a year · Shift-click a second month for a range
      </p>
    </div>
  );
};
