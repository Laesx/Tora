import React, { useEffect, useRef, useState } from "react";
import { GripVertical, Plus, Rss, Save, Search, Trash2, Wand2 } from "lucide-react";
import { SearchFeed, TorrentFeed } from "@/lib/types";
import { displayUrl, hasTitlePlaceholder, move, NYAA_CATEGORIES, NYAA_FILTERS, nyaaUrl } from "@/lib/torrents";

interface FeedsPanelProps {
  feeds: TorrentFeed[];
  searchFeeds: SearchFeed[];
  onSave: (feeds: TorrentFeed[]) => Promise<void>;
  onSaveSearchFeeds: (feeds: SearchFeed[]) => Promise<void>;
  onOpenSettings: () => void;
}

const inputClass =
  "w-full px-2.5 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent";
const sectionClass = "bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4";
const isHttp = (url: string) => /^https?:\/\//i.test(url.trim());
// Drafts hold URLs as shown (decoded like a browser); the backend encodes them again on save.
const shown = <T extends { url: string },>(list: T[]) => list.map((f) => ({ ...f, url: displayUrl(f.url) }));

const SaveButton: React.FC<{ dirty: boolean; invalid: boolean; onClick: () => Promise<void> }> = ({ dirty, invalid, onClick }) => {
  const [saving, setSaving] = useState(false);
  return (
    <button
      onClick={async () => {
        setSaving(true);
        try {
          await onClick();
        } finally {
          setSaving(false);
        }
      }}
      disabled={!dirty || invalid || saving}
      className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5"
    >
      <Save className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save"}
    </button>
  );
};

/**
 * Drag-to-reorder rows by a grip handle, with pointer events (WebView2 doesn't deliver HTML5 drag events while
 * Tauri's native file drop is on). Arrow Up / Down on a focused handle moves the row too.
 */
function useRowDrag(onMove: (from: number, to: number) => void) {
  const rows = useRef<(HTMLElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const rowAt = (y: number) => {
    let to = 0;
    rows.current.forEach((el, i) => {
      if (el && y >= el.getBoundingClientRect().top) to = i;
    });
    return to;
  };

  const rowRef = (i: number) => (el: HTMLElement | null) => {
    rows.current[i] = el;
  };

  /** Drop-line on the row the dragged one would land on (below it when moving down, above when moving up) */
  const rowClass = (i: number) => {
    if (!drag) return "border-y-2 border-transparent";
    if (i === drag.from) return "border-y-2 border-transparent opacity-50";
    if (i !== drag.to) return "border-y-2 border-transparent";
    return drag.from < i ? "border-y-2 border-transparent border-b-accent" : "border-y-2 border-transparent border-t-accent";
  };

  const handleProps = (i: number, count: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ from: i, to: i });
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const to = rowAt(e.clientY);
      if (to !== d.to) setDrag({ from: d.from, to });
    },
    onPointerUp: () => {
      const d = dragRef.current;
      if (d && d.from !== d.to) onMove(d.from, d.to);
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp" && i > 0) onMove(i, i - 1);
      else if (e.key === "ArrowDown" && i < count - 1) onMove(i, i + 1);
      else return;
      e.preventDefault();
    },
    title: "Drag to reorder (or focus and use ↑ / ↓)",
    className: "p-1 rounded text-text-muted hover:text-text-primary cursor-grab active:cursor-grabbing touch-none",
  });

  return { rowRef, rowClass, handleProps };
}

/** Query / category / uploader filter → a Nyaa RSS URL (for a general feed, or a `%title%` search template). */
const NyaaBuilder: React.FC<{ search: boolean; onBuild: (url: string, name: string) => void; onClose: () => void }> = ({
  search,
  onBuild,
  onClose,
}) => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("1_2");
  const [filter, setFilter] = useState(0);
  const url = displayUrl(nyaaUrl(query, category, filter, search));
  const categoryLabel = NYAA_CATEGORIES.find((c) => c.value === category)?.label ?? category;
  return (
    <div className="rounded-xl border border-accent/40 bg-bg-primary/60 p-3.5 space-y-2.5">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-2.5">
        <div>
          <label className="block text-[11px] text-text-muted mb-1">
            {search ? "Extra words after the title (optional)" : "Search words (blank = latest uploads)"}
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={search ? "e.g. 1080p" : "e.g. Erai 1080p|Judas|Ironclad"}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-[11px] text-text-muted mb-1">Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
            {[{ value: "0_0", label: "All categories" }, ...NYAA_CATEGORIES].map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-text-muted mb-1">Uploader filter</label>
          <select value={filter} onChange={(e) => setFilter(Number(e.target.value))} className={inputClass}>
            {NYAA_FILTERS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <code className="block text-[10px] text-text-muted break-all">{url}</code>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            onBuild(url, query.trim() ? `Nyaa – ${query.trim()}` : `Nyaa – ${categoryLabel}`);
            onClose();
          }}
          className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold"
        >
          Add this feed
        </button>
        <button onClick={onClose} className="px-2 py-1.5 text-xs text-text-muted hover:text-text-primary">
          Cancel
        </button>
      </div>
    </div>
  );
};

export const FeedsPanel: React.FC<FeedsPanelProps> = ({ feeds, searchFeeds, onSave, onSaveSearchFeeds, onOpenSettings }) => {
  const [draft, setDraft] = useState<TorrentFeed[]>(() => shown(feeds));
  const [searchDraft, setSearchDraft] = useState<SearchFeed[]>(() => shown(searchFeeds));
  const [builder, setBuilder] = useState<"general" | "search" | null>(null);
  useEffect(() => setDraft(shown(feeds)), [feeds]);
  useEffect(() => setSearchDraft(shown(searchFeeds)), [searchFeeds]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(shown(feeds));
  const searchDirty = JSON.stringify(searchDraft) !== JSON.stringify(shown(searchFeeds));
  const invalid = draft.some((f) => !isHttp(f.url));
  const searchInvalid = searchDraft.length === 0 || searchDraft.some((f) => !isHttp(f.url) || !hasTitlePlaceholder(f.url));

  const set = (i: number, patch: Partial<TorrentFeed>) => setDraft((d) => d.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const setSearch = (i: number, patch: Partial<SearchFeed>) =>
    setSearchDraft((d) => d.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const generalDrag = useRowDrag((from, to) => setDraft((d) => move(d, from, to)));
  const searchDrag = useRowDrag((from, to) => setSearchDraft((d) => move(d, from, to)));

  return (
    <div className="space-y-5">
      {/* General feeds */}
      <section className={sectionClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Rss className="w-4 h-4 text-accent" /> General feeds
            </h2>
            <p className="text-[11px] text-text-muted mt-1 max-w-2xl">
              Any RSS torrent feed: Nyaa (e.g. <code className="font-mono">…&amp;q=Erai+1080p|Judas|Ironclad</code>),
              SubsPlease (<code className="font-mono">https://subsplease.org/rss/?t&amp;r=1080</code>) and others. Tick
              several on the Releases tab to check them at once. They're fetched when you press Refresh, then kept in
              memory and refreshed on the{" "}
              <button onClick={onOpenSettings} className="text-accent hover:underline">
                refresh interval (Settings → Torrents)
              </button>
              . Drag the handles to change the order of the chips.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setBuilder(builder === "general" ? null : "general")}
              className="px-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary hover:bg-bg-tertiary flex items-center gap-1.5"
            >
              <Wand2 className="w-3.5 h-3.5" /> Build Nyaa URL…
            </button>
            <button
              onClick={() => setDraft((d) => [...d, { id: 0, name: "", enabled: true, url: "" }])}
              className="px-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary hover:bg-bg-tertiary flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Add feed
            </button>
            <SaveButton dirty={dirty} invalid={invalid} onClick={() => onSave(draft)} />
          </div>
        </div>
        {builder === "general" && (
          <NyaaBuilder
            search={false}
            onClose={() => setBuilder(null)}
            onBuild={(url, name) => setDraft((d) => [...d, { id: 0, name, enabled: true, url }])}
          />
        )}
        {draft.length === 0 && <div className="text-xs text-text-muted">No feeds yet.</div>}
        <div>
          {draft.map((f, i) => (
            <div
              key={f.id || `new-${i}`}
              ref={generalDrag.rowRef(i)}
              className={`flex flex-wrap items-center gap-2 py-1 ${generalDrag.rowClass(i)}`}
            >
              <button {...generalDrag.handleProps(i, draft.length)}>
                <GripVertical className="w-4 h-4" />
              </button>
              <input
                type="checkbox"
                checked={f.enabled}
                onChange={(e) => set(i, { enabled: e.target.checked })}
                className="rounded accent-accent"
                title="Include in “All feeds” and background refresh"
              />
              <input
                value={f.name}
                onChange={(e) => set(i, { name: e.target.value })}
                placeholder="Name (defaults to the site)"
                className={`${inputClass} font-semibold !w-56`}
              />
              <input
                value={f.url}
                onChange={(e) => set(i, { url: e.target.value })}
                placeholder="https://… RSS URL"
                spellCheck={false}
                className={`${inputClass} font-mono flex-1 min-w-[260px] ${f.url && !isHttp(f.url) ? "!border-red-500/60" : ""}`}
              />
              <button
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/15"
                title="Remove feed"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Search feeds */}
      <section className={sectionClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Search className="w-4 h-4 text-accent" /> Search feeds
            </h2>
            <p className="text-[11px] text-text-muted mt-1 max-w-2xl">
              Used by the search box and “Find torrents” for an anime. <code className="font-mono">%title%</code> is
              replaced by the anime's title, e.g.{" "}
              <code className="font-mono">https://nyaa.si/?page=rss&amp;c=0_0&amp;f=0&amp;q=%title%</code>. Pick which
              one to use from the dropdown next to the search box (the first one is used until you pick).
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setBuilder(builder === "search" ? null : "search")}
              className="px-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary hover:bg-bg-tertiary flex items-center gap-1.5"
            >
              <Wand2 className="w-3.5 h-3.5" /> Build Nyaa URL…
            </button>
            <button
              onClick={() => setSearchDraft((d) => [...d, { id: 0, name: "", url: "" }])}
              className="px-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary hover:bg-bg-tertiary flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Add search feed
            </button>
            <SaveButton dirty={searchDirty} invalid={searchInvalid} onClick={() => onSaveSearchFeeds(searchDraft)} />
          </div>
        </div>
        {builder === "search" && (
          <NyaaBuilder
            search
            onClose={() => setBuilder(null)}
            onBuild={(url, name) => setSearchDraft((d) => [...d, { id: 0, name, url }])}
          />
        )}
        <div>
          {searchDraft.map((f, i) => {
            const missing = f.url.trim() !== "" && !hasTitlePlaceholder(f.url);
            return (
              <div key={f.id || `new-${i}`} ref={searchDrag.rowRef(i)} className={`space-y-1 py-1 ${searchDrag.rowClass(i)}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <button {...searchDrag.handleProps(i, searchDraft.length)}>
                    <GripVertical className="w-4 h-4" />
                  </button>
                  <input
                    value={f.name}
                    onChange={(e) => setSearch(i, { name: e.target.value })}
                    placeholder="Name (defaults to the site)"
                    className={`${inputClass} font-semibold !w-56`}
                  />
                  <input
                    value={f.url}
                    onChange={(e) => setSearch(i, { url: e.target.value })}
                    placeholder="https://…&q=%title%"
                    spellCheck={false}
                    className={`${inputClass} font-mono flex-1 min-w-[260px] ${missing || (f.url && !isHttp(f.url)) ? "!border-red-500/60" : ""}`}
                  />
                  <button
                    onClick={() => setSearchDraft((d) => d.filter((_, j) => j !== i))}
                    disabled={searchDraft.length === 1}
                    className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/15 disabled:opacity-30"
                    title={searchDraft.length === 1 ? "Keep at least one search feed" : "Remove search feed"}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {missing && <div className="text-[11px] text-red-400 pl-7">Add %title% where the anime's title goes.</div>}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
