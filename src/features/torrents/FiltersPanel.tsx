import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, EyeOff, Layers, ListFilter, Pin, Plus, Save, Trash2, X } from "lucide-react";
import { AnimeEntry, BoardOptions, FansubOverride, PriorityConfig, PriorityTier, TorrentFilter } from "@/lib/types";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { useAnimeTitle } from "@/contexts/titles";
import { groupQuery, move } from "@/lib/torrents";
import { FilterEditor } from "./FilterEditor";
import { AnimePicker } from "./AnimePicker";
import { LIST_STATUSES } from "@/lib/status";

interface FiltersPanelProps {
  animeList: AnimeEntry[];
  priority: PriorityConfig;
  filters: TorrentFilter[];
  fansubs: FansubOverride[];
  boardOptions: BoardOptions;
  onSaveBoardOptions: (o: BoardOptions) => Promise<void>;
  /** Release groups seen in the current board (suggestions) */
  groups: string[];
  onSavePriority: (p: PriorityConfig) => Promise<void>;
  onSaveFilters: (f: TorrentFilter[]) => Promise<void>;
  onSetFansubs: (animeId: number, groups: string[]) => Promise<void>;
  /** A filter prefilled from a release ("Create filter from this release…") */
  pendingFilter: TorrentFilter | null;
  onPendingConsumed: () => void;
}

const inputClass =
  "px-2.5 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent";
const sectionClass = "bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4";

const SaveButton: React.FC<{ dirty: boolean; disabled?: boolean; onClick: () => Promise<void> }> = ({ dirty, disabled, onClick }) => {
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
      disabled={!dirty || disabled || saving}
      className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5"
    >
      <Save className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save"}
    </button>
  );
};

const GroupInput: React.FC<{ groups: string[]; onAdd: (g: string) => void; placeholder: string }> = ({ groups, onAdd, placeholder }) => {
  const [v, setV] = useState("");
  const listId = useRef(`tora-grp-${Math.random().toString(36).slice(2)}`).current;
  const add = () => {
    if (v.trim()) onAdd(v.trim());
    setV("");
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={v}
        list={listId}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
        placeholder={placeholder}
        className={`${inputClass} w-44`}
      />
      <button onClick={add} className="p-1.5 rounded-lg text-accent hover:bg-accent/10" title="Add">
        <Plus className="w-4 h-4" />
      </button>
      <datalist id={listId}>
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
    </div>
  );
};

export const FiltersPanel: React.FC<FiltersPanelProps> = ({
  animeList,
  priority,
  filters,
  fansubs,
  boardOptions,
  onSaveBoardOptions,
  groups,
  onSavePriority,
  onSaveFilters,
  onSetFansubs,
  pendingFilter,
  onPendingConsumed,
}) => {
  const titleOf = useAnimeTitle();
  const byId = useMemo(() => new Map(animeList.map((a) => [a.id, a])), [animeList]);

  const [tiers, setTiers] = useState<PriorityConfig>(priority);
  useEffect(() => setTiers(priority), [priority]);
  const tiersDirty = JSON.stringify(tiers) !== JSON.stringify(priority);

  const [draftFilters, setDraftFilters] = useState<TorrentFilter[]>(filters);
  const [filterErrors, setFilterErrors] = useState<Record<number, string | null>>({});
  useEffect(() => setDraftFilters(filters), [filters]);
  const filtersDirty = JSON.stringify(draftFilters) !== JSON.stringify(filters);
  const filtersInvalid = Object.values(filterErrors).some(Boolean);

  // Anime picked for a new fansub override that has no groups yet
  const [pendingFansubIds, setPendingFansubIds] = useState<number[]>([]);
  const filtersRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pendingFilter) return;
    setDraftFilters((d) => [...d, pendingFilter]);
    onPendingConsumed();
    setTimeout(() => filtersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, [pendingFilter, onPendingConsumed]);

  const setTier = (i: number, patch: Partial<PriorityTier>) =>
    setTiers((t) => ({ ...t, tiers: t.tiers.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const setFilter = (i: number, patch: Partial<TorrentFilter>) =>
    setDraftFilters((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const overrideRows: FansubOverride[] = [
    ...fansubs,
    ...pendingFansubIds.filter((id) => !fansubs.some((f) => f.anime_id === id)).map((id) => ({ anime_id: id, groups: [] })),
  ];

  return (
    <div className="space-y-5">
      {/* Hidden list statuses */}
      <section className={sectionClass}>
        <div>
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <EyeOff className="w-4 h-4 text-accent" /> Hide anime by list status
          </h2>
          <p className="text-[11px] text-text-muted mt-1 max-w-2xl">
            Anime with these statuses get no card on the Releases tab, and their releases are never selected or
            auto-downloaded. Searching an anime from its details still shows it.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {LIST_STATUSES.map((st) => {
            const hidden = boardOptions.hidden_statuses.includes(st.id);
            const Icon = st.icon;
            return (
              <button
                key={st.id}
                onClick={() =>
                  void onSaveBoardOptions({
                    ...boardOptions,
                    hidden_statuses: hidden
                      ? boardOptions.hidden_statuses.filter((s) => s !== st.id)
                      : [...boardOptions.hidden_statuses, st.id],
                  })
                }
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition flex items-center gap-1.5 ${hidden
                  ? "bg-red-500/10 border-red-500/50 text-red-300"
                  : "bg-bg-primary border-border-subtle text-text-secondary hover:text-text-primary"
                  }`}
                title={hidden ? "Hidden: click to show" : "Shown: click to hide"}
              >
                {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Icon className={`w-3.5 h-3.5 ${st.color}`} />}
                {st.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* Release priority */}
      <section className={sectionClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Layers className="w-4 h-4 text-accent" /> Release priority
            </h2>
            <p className="text-[11px] text-text-muted mt-1 max-w-2xl">
              For each new episode, the first tier with a matching release wins and only its releases are picked
              (ties go to the resolution closest to 1080p, then seeders). Anime with a fansub override below ignore
              these tiers.
            </p>
          </div>
          <SaveButton dirty={tiersDirty} onClick={() => onSavePriority(tiers)} />
        </div>
        <div className="space-y-1.5">
          {tiers.tiers.map((t, i) => (
            <div key={t.id || `new-${i}`} className="flex items-center gap-1.5">
              <span className="w-6 text-right font-mono text-[11px] text-text-muted">{i + 1}.</span>
              <input
                type="checkbox"
                checked={t.enabled}
                onChange={(e) => setTier(i, { enabled: e.target.checked })}
                className="rounded accent-accent"
              />
              <input
                value={t.query}
                onChange={(e) => setTier(i, { query: e.target.value })}
                spellCheck={false}
                className={`${inputClass} flex-1 font-mono`}
              />
              <button onClick={() => setTiers((x) => ({ ...x, tiers: move(x.tiers, i, i - 1) }))} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary" title="Move up">
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setTiers((x) => ({ ...x, tiers: move(x.tiers, i, i + 1) }))} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary" title="Move down">
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setTiers((x) => ({ ...x, tiers: x.tiers.filter((_, j) => j !== i) }))} className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/15" title="Remove tier">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <GroupInput
            groups={groups}
            placeholder="Add a release group…"
            onAdd={(g) => setTiers((x) => ({ ...x, tiers: [...x.tiers, { id: 0, query: groupQuery(g), enabled: true }] }))}
          />
          <button
            onClick={() => setTiers((x) => ({ ...x, tiers: [...x.tiers, { id: 0, query: "group:Name res:1080p", enabled: true }] }))}
            className="text-[11px] text-accent hover:underline flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Add a custom tier
          </button>
          <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer ml-auto">
            <input
              type="checkbox"
              checked={tiers.fallback_to_best}
              onChange={(e) => setTiers((x) => ({ ...x, fallback_to_best: e.target.checked }))}
              className="rounded accent-accent"
            />
            When no tier matches, pick the best other release
          </label>
        </div>
      </section>

      {/* Fansub overrides */}
      <section className={sectionClass}>
        <div>
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Pin className="w-4 h-4 text-accent" /> Fansubs per anime
          </h2>
          <p className="text-[11px] text-text-muted mt-1 max-w-2xl">
            Only these groups are picked for the anime, in this order, with no fallback to others (e.g. Kusuriya S3 →
            Judas). Other groups' releases stay visible under “Other releases”. Right-click a release to set this quickly.
          </p>
        </div>
        <div className="divide-y divide-border-subtle/60">
          {overrideRows.map((o) => {
            const a = byId.get(o.anime_id);
            const setGroups = (next: string[]) => {
              if (next.length === 0) setPendingFansubIds((p) => p.filter((id) => id !== o.anime_id));
              void onSetFansubs(o.anime_id, next);
            };
            return (
              <div key={o.anime_id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="flex items-center gap-2 w-72 min-w-0">
                  {a && <img src={getOptimizedCoverUrl(a.cover_image, "medium")} alt="" className="w-7 h-10 rounded object-cover shrink-0" />}
                  <span className="text-xs font-semibold text-text-primary truncate">{a ? titleOf(a) : `Anime #${o.anime_id}`}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 flex-1">
                  {o.groups.map((g, i) => (
                    <span key={g} className="flex items-center gap-0.5 pl-2 pr-1 py-0.5 rounded-lg bg-accent/15 text-accent text-[11px] font-semibold">
                      <span className="font-mono text-[10px] opacity-60 mr-1">{i + 1}</span>
                      {g}
                      <button disabled={i === 0} onClick={() => setGroups(move(o.groups, i, i - 1))} className="p-0.5 disabled:opacity-30" title="Earlier">
                        <ChevronLeft className="w-3 h-3" />
                      </button>
                      <button disabled={i === o.groups.length - 1} onClick={() => setGroups(move(o.groups, i, i + 1))} className="p-0.5 disabled:opacity-30" title="Later">
                        <ChevronRight className="w-3 h-3" />
                      </button>
                      <button onClick={() => setGroups(o.groups.filter((x) => x !== g))} className="p-0.5 hover:text-red-400" title="Remove">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  <GroupInput groups={groups} placeholder={o.groups.length ? "Fallback group…" : "Release group…"} onAdd={(g) => setGroups([...o.groups, g])} />
                </div>
                <button
                  onClick={() => setGroups([])}
                  className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/15"
                  title="Remove override"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="max-w-sm">
          <AnimePicker
            animeList={animeList}
            exclude={overrideRows.map((o) => o.anime_id)}
            placeholder="Add an anime…"
            onPick={(a) => setPendingFansubIds((p) => [...p, a.id])}
          />
        </div>
      </section>

      {/* Filters */}
      <section className={sectionClass} ref={filtersRef}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <ListFilter className="w-4 h-4 text-accent" /> Filters
            </h2>
            <p className="text-[11px] text-text-muted mt-1 max-w-2xl">
              <b>Hide</b> filters remove matching releases (never selected). <b>Select</b> filters also pick releases
              the built-in rule skips (new episodes of anime you're watching, not on disk, no batches), e.g.{" "}
              <code className="font-mono">batch:yes status:completed</code>. Write conditions as rows or as text:{" "}
              <code className="font-mono">group:Judas res&gt;=1080p -dub codec:hevc seeds&gt;5</code>.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() =>
                setDraftFilters((d) => [...d, { id: 0, name: "", enabled: true, action: "discard", query: "", anime_ids: [] }])
              }
              className="px-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary hover:bg-bg-tertiary flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Add filter
            </button>
            <SaveButton dirty={filtersDirty} disabled={filtersInvalid} onClick={() => onSaveFilters(draftFilters)} />
          </div>
        </div>
        {draftFilters.length === 0 && <div className="text-xs text-text-muted">No filters yet.</div>}
        {draftFilters.map((f, i) => (
          <div key={f.id || `new-${i}`} className="border border-border-subtle rounded-xl p-3.5 space-y-3 bg-bg-primary/40">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="checkbox"
                checked={f.enabled}
                onChange={(e) => setFilter(i, { enabled: e.target.checked })}
                className="rounded accent-accent"
              />
              <input
                value={f.name}
                onChange={(e) => setFilter(i, { name: e.target.value })}
                placeholder="Filter name"
                className={`${inputClass} font-semibold flex-1 min-w-[160px]`}
              />
              <select
                value={f.action}
                onChange={(e) => setFilter(i, { action: e.target.value as TorrentFilter["action"] })}
                className={inputClass}
              >
                <option value="discard">Hide matching releases</option>
                <option value="select">Select matching releases</option>
              </select>
              <button
                onClick={() => {
                  setDraftFilters((d) => d.filter((_, j) => j !== i));
                  setFilterErrors({});
                }}
                className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/15"
                title="Remove filter"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <FilterEditor
              value={f.query}
              groups={groups}
              onChange={(q) => setFilter(i, { query: q })}
              onValidity={(err) => setFilterErrors((e) => ({ ...e, [i]: err }))}
            />
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
              <span>Applies to:</span>
              {f.anime_ids.length === 0 && <span className="text-text-secondary">every release</span>}
              {f.anime_ids.map((id) => {
                const a = byId.get(id);
                return (
                  <span key={id} className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-lg bg-bg-tertiary text-text-secondary">
                    {a ? titleOf(a) : `#${id}`}
                    <button onClick={() => setFilter(i, { anime_ids: f.anime_ids.filter((x) => x !== id) })} className="hover:text-red-400">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                );
              })}
              <div className="w-56">
                <AnimePicker
                  animeList={animeList}
                  exclude={f.anime_ids}
                  placeholder="Limit to an anime…"
                  onPick={(a) => setFilter(i, { anime_ids: [...f.anime_ids, a.id] })}
                />
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
};
