import React, { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { AnimeEntry } from "../../types";
import { getOptimizedCoverUrl } from "../../api";
import { buildAnimeSearchIndex, searchAnime } from "../../fuzzy";
import { useAnimeTitle } from "../../titles";

/** Search box that picks one list entry (same fuzzy index as the watchlist search). */
export const AnimePicker: React.FC<{
  animeList: AnimeEntry[];
  onPick: (anime: AnimeEntry) => void;
  exclude?: number[];
  placeholder?: string;
}> = ({ animeList, onPick, exclude = [], placeholder = "Add anime…" }) => {
  const titleOf = useAnimeTitle();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const index = useMemo(() => buildAnimeSearchIndex(animeList), [animeList]);
  const hits = useMemo(
    () =>
      q.trim()
        ? searchAnime(index, q)
            .map((h) => h.item)
            .filter((a) => !exclude.includes(a.id))
            .slice(0, 8)
        : [],
    [index, q, exclude]
  );

  return (
    <div className="relative">
      <Search className="w-3.5 h-3.5 text-text-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            onPick(hits[0]);
            setQ("");
          }
        }}
        placeholder={placeholder}
        className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
      />
      {open && hits.length > 0 && (
        <div className="absolute z-30 mt-1 w-full rounded-xl bg-bg-secondary border border-border-subtle shadow-2xl py-1 max-h-72 overflow-y-auto">
          {hits.map((a) => (
            <button
              key={a.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(a);
                setQ("");
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            >
              <img src={getOptimizedCoverUrl(a.cover_image, "medium")} alt="" className="w-6 h-8 rounded object-cover shrink-0" />
              <span className="truncate">{titleOf(a)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
