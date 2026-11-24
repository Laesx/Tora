import React, { useState } from "react";
import { Check, ChevronRight, CircleAlert, Minus } from "lucide-react";
import { TrackerDescriptor } from "@/lib/types";
import { featureSupport, TRACKER_FEATURES } from "@/lib/trackers";

/**
 * Settings → Tracker: what each tracker supports beyond the basics. The app hides or turns off what the active
 * tracker lacks; nothing is filled in from another tracker.
 */
export const TrackerSupportTable: React.FC<{ trackers: TrackerDescriptor[]; activeId: string | null }> = ({
  trackers,
  activeId,
}) => {
  // Reference, not something to act on: collapsed until asked for
  const [open, setOpen] = useState(false);
  if (trackers.length === 0) return null;
  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-bold text-text-primary hover:text-accent transition cursor-pointer"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        What each tracker supports
      </button>
      {open && (
      <>
      <div>
        <p className="text-[11px] text-text-muted leading-relaxed">
          Every tracker syncs your list, searches anime, browses seasons and shows related anime. While a tracker is
          active, what it doesn't support is hidden or turned off.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-bg-primary text-text-secondary">
              <th className="text-left font-semibold px-3 py-2">Feature</th>
              {trackers.map((t) => (
                <th
                  key={t.id}
                  className={`font-semibold px-3 py-2 text-center whitespace-nowrap ${t.id === activeId ? "text-accent" : ""}`}
                >
                  {t.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TRACKER_FEATURES.map((f) => (
              <tr key={f.id} className="border-t border-border-subtle">
                <td className="px-3 py-2">
                  <div className="text-text-primary font-medium">{f.label}</div>
                  <div className="text-text-muted">{f.where}</div>
                </td>
                {trackers.map((t) => {
                  const support = featureSupport(t, f.id);
                  return (
                    <td key={t.id} className={`px-3 py-2 text-center ${t.id === activeId ? "bg-accent/5" : ""}`}>
                      {support === null ? (
                        <Minus className="w-3.5 h-3.5 inline text-text-muted" aria-label="Not supported" />
                      ) : support.note ? (
                        <span className="inline-flex items-center gap-1 text-amber-400" title={support.note}>
                          <CircleAlert className="w-3.5 h-3.5" />
                          Partly
                        </span>
                      ) : (
                        <Check className="w-3.5 h-3.5 inline text-emerald-400" aria-label="Supported" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
};
