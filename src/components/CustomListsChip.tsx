import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ListChecks, Search } from "lucide-react";

interface CustomListsChipProps {
  // List names in the user's AniList order
  names: string[];
  counts: Map<string, number>;
  // Selected custom list (null while a status tab is selected or searching)
  active: string | null;
  onSelect: (name: string) => void;
}

// Above this many lists the popover gets a filter box
const FILTER_THRESHOLD = 8;

/** One "Lists" chip for the status ribbon: same width for 1 or 50 custom lists. */
export const CustomListsChip: React.FC<CustomListsChipProps> = ({
  names,
  counts,
  active,
  onSelect,
}) => {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const showFilter = names.length > FILTER_THRESHOLD;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
  }, [names, filter]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    setHighlight(Math.max(0, active ? names.indexOf(active) : 0));
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) (showFilter ? filterRef.current : listRef.current)?.focus();
  }, [open, showFilter]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pick = (name: string) => {
    onSelect(name);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keep Escape / arrows away from the global watchlist handler
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(visible.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const name = visible[highlight];
      if (name) pick(name);
    }
  };

  const isActive = active !== null;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 max-w-52 ${isActive
          ? "bg-accent text-white shadow-sm"
          : "text-text-secondary hover:text-text-primary"
          }`}
        title="AniList custom lists"
      >
        <ListChecks className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{active ?? "Lists"}</span>
        <span
          className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${isActive ? "bg-black/25 text-white" : "bg-bg-tertiary text-text-muted"
            }`}
        >
          {active !== null ? counts.get(active) ?? 0 : names.length}
        </span>
        <ChevronDown className="w-3 h-3 shrink-0 opacity-70" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1.5 z-40 w-64 rounded-xl bg-bg-secondary/95 backdrop-blur-md border border-border-subtle shadow-2xl py-1.5 text-xs"
          onKeyDown={onKeyDown}
        >
          {showFilter && (
            <div className="relative px-2 pb-1.5 mb-1 border-b border-border-subtle">
              <Search className="w-3.5 h-3.5 text-text-muted absolute left-4 top-[9px]" />
              <input
                ref={filterRef}
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setHighlight(0);
                }}
                placeholder="Filter lists..."
                className="w-full pl-7 pr-2 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
              />
            </div>
          )}
          <div ref={listRef} tabIndex={-1} className="max-h-72 overflow-y-auto focus:outline-none">
            {visible.length === 0 && (
              <div className="px-3 py-2 text-text-muted">No lists match</div>
            )}
            {visible.map((name, i) => (
              <button
                key={name}
                data-index={i}
                onClick={() => pick(name)}
                onMouseEnter={() => setHighlight(i)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left transition ${i === highlight ? "bg-bg-tertiary text-text-primary" : "text-text-secondary"
                  } ${name === active ? "font-bold text-accent" : ""}`}
              >
                <span className="truncate">{name}</span>
                <span className="text-[10px] font-mono text-text-muted shrink-0">
                  {counts.get(name) ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
