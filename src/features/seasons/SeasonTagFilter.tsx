import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { SeasonalAnime } from "@/lib/types";
import { tagChipClass } from "./SeasonExtendedCard";
import { TagFilterState, TagOption, tagOptions } from "./tagFilters";

/** Tags listed until a search narrows them (a season can have a few hundred) */
const MAX_LISTED_TAGS = 60;

interface SeasonTagFilterProps {
  items: SeasonalAnime[];
  tagState: (name: string) => TagFilterState;
  activeCount: number;
  onCycle: (name: string) => void;
  onClear: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Genres & tags" popover: each chip cycles show only → hide → off. */
export const SeasonTagFilter: React.FC<SeasonTagFilterProps> = ({
  items,
  tagState,
  activeCount,
  onCycle,
  onClear,
  open,
  onOpenChange,
}) => {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const options = useMemo(() => (open ? tagOptions(items) : null), [items, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpenChange]);

  const needle = query.trim().toLowerCase();
  const matching = (list: TagOption[]) => list.filter((o) => o.name.toLowerCase().includes(needle));

  const renderChips = (list: TagOption[]) => (
    <div className="flex flex-wrap gap-1">
      {list.map((o) => (
        <button
          key={o.name}
          onClick={() => onCycle(o.name)}
          className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition cursor-pointer ${tagChipClass(
            tagState(o.name),
            "bg-bg-primary text-text-secondary hover:text-text-primary"
          )}`}
        >
          {o.name} <span className="opacity-60">{o.count}</span>
        </button>
      ))}
    </div>
  );

  const genres = options ? matching(options.genres) : [];
  const tags = options ? matching(options.tags) : [];

  return (
    <div ref={ref} className="relative">
      <div
        className={`rounded-full text-[11px] font-semibold border transition flex items-center ${activeCount > 0
          ? "bg-accent/15 text-accent border-accent/40"
          : "bg-bg-primary text-text-muted border-border-subtle hover:text-text-secondary"
          }`}
      >
        <button
          onClick={() => onOpenChange(!open)}
          className={`py-1 pl-2.5 flex items-center gap-1 ${activeCount > 0 ? "pr-1" : "pr-2.5"}`}
        >
          Genres & tags
          {activeCount > 0 && <span className="opacity-70">{activeCount}</span>}
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {activeCount > 0 && (
          <button
            onClick={onClear}
            title="Clear genre and tag filters"
            aria-label="Clear genre and tag filters"
            className="py-1 pl-1 pr-2 hover:text-text-primary transition"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-40 top-full left-0 mt-2 w-96 p-3 rounded-xl bg-bg-secondary border border-border-subtle shadow-2xl space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a genre or tag..."
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
            />
          </div>

          <p className="text-[10px] text-text-muted">Click: show only → hide → off</p>

          <div className="max-h-72 overflow-y-auto space-y-3 pr-1">
            {genres.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Genres</h3>
                {renderChips(genres)}
              </div>
            )}
            {tags.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Tags</h3>
                {renderChips(needle ? tags : tags.slice(0, MAX_LISTED_TAGS))}
              </div>
            )}
            {genres.length === 0 && tags.length === 0 && (
              <p className="py-4 text-center text-xs text-text-muted">Nothing in this season matches.</p>
            )}
          </div>

          {activeCount > 0 && (
            <button
              onClick={onClear}
              className="flex items-center gap-1 text-[11px] font-semibold text-text-muted hover:text-text-primary transition"
            >
              <X className="w-3 h-3" />
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
};
