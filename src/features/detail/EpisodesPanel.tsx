import React, { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Film,
  FolderOpen,
  FolderTree,
  Layers,
  Pin,
  PinOff,
  Play,
} from "lucide-react";
import { AnimeEntry, LocalEpisodeFile } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { formatBytes, plural } from "@/lib/format";
import { useToast } from "@/contexts/toast";
import {
  EXTRA_KIND_LABELS,
  EXTRA_KIND_ORDER,
  ExtraKind,
  Release,
  effectiveRelease,
  episodeFileMap,
  episodeOf,
  extraKindOf,
  groupReleases,
  releaseFile,
  setPinnedRelease,
  usePinnedRelease,
} from "@/lib/releases";

/** Dot / chip colors of releases, in release order (full class names for Tailwind). */
const RELEASE_COLORS = [
  { dot: "bg-sky-400", ring: "border-sky-400/60", text: "text-sky-300" },
  { dot: "bg-violet-400", ring: "border-violet-400/60", text: "text-violet-300" },
  { dot: "bg-amber-400", ring: "border-amber-400/60", text: "text-amber-300" },
  { dot: "bg-emerald-400", ring: "border-emerald-400/60", text: "text-emerald-300" },
  { dot: "bg-rose-400", ring: "border-rose-400/60", text: "text-rose-300" },
  { dot: "bg-teal-400", ring: "border-teal-400/60", text: "text-teal-300" },
];
const colorOf = (index: number) => RELEASE_COLORS[index % RELEASE_COLORS.length];

const EXTRA_BADGES: Record<ExtraKind, string> = {
  special: "SP",
  recap: "Recap",
  opening: "OP",
  ending: "ED",
  preview: "PV",
  other: "Extra",
};

/** Fixed row height of the file lists (they are windowed, so every row must be exactly this tall). */
const ROW_HEIGHT = 36;
const LIST_MAX_HEIGHT = 432;
const OVERSCAN = 6;

const releaseLabel = (r: Release) => (r.groups.length > 0 ? r.groups.map((g) => `[${g}]`).join(" ") : r.folderName);

interface FileRow {
  file: LocalEpisodeFile;
  /** First column: "Ep 5" on the first file of an episode, the extra's kind badge, or nothing */
  badge: string | null;
  releaseIndex: number;
}

/** A windowed list of file rows: only the visible ones (+ overscan) are mounted. */
const FileRows: React.FC<{ rows: FileRow[]; releases: Release[] }> = ({ rows, releases }) => {
  const showToast = useToast();
  const [scrollTop, setScrollTop] = useState(0);
  const height = Math.min(rows.length * ROW_HEIGHT, LIST_MAX_HEIGHT);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const play = (f: LocalEpisodeFile) => toraApi.playEpisodeFile(f.file_path).catch((e) => showToast(String(e), "error"));

  return (
    <div
      className="overflow-y-auto rounded-xl bg-bg-primary/60 border border-border-subtle [overflow-anchor:none]"
      style={{ height }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
        {rows.slice(first, last).map((row, i) => {
          const f = row.file;
          const color = colorOf(row.releaseIndex);
          const release = releases[row.releaseIndex];
          const weak = f.match_kind === "folder" || f.match_kind === "fuzzy";
          return (
            <div
              key={f.id}
              className={`absolute inset-x-0 flex items-center gap-2 px-3 text-xs hover:bg-bg-tertiary/60 shadow-[inset_0_-1px_0_0_rgb(var(--border-subtle))] ${
                f.watched ? "opacity-60" : ""
              }`}
              style={{ top: (first + i) * ROW_HEIGHT, height: ROW_HEIGHT }}
            >
              <span className="w-14 shrink-0 font-mono text-[11px] font-semibold text-accent truncate">
                {row.badge ?? ""}
              </span>
              {releases.length > 1 && (
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${color.dot}`}
                  title={release ? `${releaseLabel(release)} · ${release.folder}` : undefined}
                />
              )}
              {f.release_group && (
                <span className="px-1.5 py-0.5 rounded bg-bg-elevated text-text-secondary text-[10px] shrink-0 max-w-[9rem] truncate">
                  [{f.release_group}]
                </span>
              )}
              {f.resolution && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-mono shrink-0">
                  {f.resolution}
                </span>
              )}
              <span className="flex-1 min-w-0 truncate text-text-primary" title={f.file_path}>
                {f.file_name}
              </span>
              {weak && (
                <span
                  className="shrink-0 text-text-muted"
                  title={
                    f.match_kind === "folder"
                      ? "Matched by its folder: the name doesn't say which anime it is"
                      : "Matched by a similar title: a guess"
                  }
                >
                  {f.match_kind === "folder" ? <FolderTree className="w-3.5 h-3.5" /> : <CircleHelp className="w-3.5 h-3.5" />}
                </span>
              )}
              <span className="w-16 shrink-0 text-right text-[10px] font-mono text-text-muted">{formatBytes(f.file_size)}</span>
              <button
                onClick={() => play(f)}
                className="p-1.5 rounded bg-accent/20 hover:bg-accent text-accent hover:text-white transition shrink-0"
                title="Play file"
              >
                <Play className="w-3 h-3 fill-current" />
              </button>
              <button
                onClick={() => toraApi.revealInExplorer(f.file_path).catch((e) => showToast(String(e), "error"))}
                className="p-1.5 rounded bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary transition shrink-0"
                title="Reveal in Windows Explorer"
              >
                <FolderOpen className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Episodes on disk: release chips (filter, pin the release that plays), the episode grid, every file
 * grouped by episode, and the extras (specials, recaps, openings…) in their own collapsed list.
 */
export const EpisodesPanel: React.FC<{
  anime: AnimeEntry;
  files: LocalEpisodeFile[];
  progress: number;
  /** The episode a player has open (Now Playing), ringed in the grid */
  playingEpisode?: number | null;
  /** An episode with no file: look for it */
  onMissingEpisode: () => void;
}> = ({ anime, files, progress, playingEpisode = null, onMissingEpisode }) => {
  const showToast = useToast();
  const total = anime.episodes;
  const pinned = usePinnedRelease(anime.id);
  const [filterKey, setFilterKey] = useState<string | null>(null);
  const [extrasOpen, setExtrasOpen] = useState(false);

  useEffect(() => {
    setFilterKey(null);
    setExtrasOpen(false);
  }, [anime.id]);

  const releases = useMemo(() => groupReleases(files, total), [files, total]);
  const playing = effectiveRelease(releases, pinned);
  const filtered = releases.find((r) => r.key === filterKey) ?? null;
  const releaseIndex = useMemo(() => new Map(releases.map((r, i) => [r.key, i])), [releases]);
  const fileByEpisode = useMemo(() => episodeFileMap(files, total, pinned), [files, total, pinned]);
  const releasesPerEpisode = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of releases) for (const ep of r.episodes) counts.set(ep, (counts.get(ep) ?? 0) + 1);
    return counts;
  }, [releases]);

  const shown = useMemo(() => (filtered ? [filtered] : releases), [filtered, releases]);
  const onDisk = filtered ? filtered.episodes : new Set(fileByEpisode.keys());

  const { episodeRows, extraRows } = useMemo(() => {
    const episodeFiles: { file: LocalEpisodeFile; ep: number; index: number }[] = [];
    const extras: { file: LocalEpisodeFile; kind: ExtraKind; index: number }[] = [];
    for (const r of shown) {
      const index = releaseIndex.get(r.key) ?? 0;
      for (const f of r.files) {
        const ep = episodeOf(f, total);
        if (ep === null) extras.push({ file: f, kind: extraKindOf(f), index });
        else episodeFiles.push({ file: f, ep, index });
      }
    }
    episodeFiles.sort((a, b) => a.ep - b.ep || a.index - b.index || a.file.file_name.localeCompare(b.file.file_name));
    extras.sort(
      (a, b) =>
        EXTRA_KIND_ORDER.indexOf(a.kind) - EXTRA_KIND_ORDER.indexOf(b.kind) ||
        a.file.file_name.localeCompare(b.file.file_name)
    );
    const episodeRows: FileRow[] = episodeFiles.map((e, i) => ({
      file: e.file,
      badge: i === 0 || episodeFiles[i - 1].ep !== e.ep ? `Ep ${e.ep}` : null,
      releaseIndex: e.index,
    }));
    const extraRows: FileRow[] = extras.map((e) => ({
      file: e.file,
      badge: EXTRA_BADGES[e.kind],
      releaseIndex: e.index,
    }));
    return { episodeRows, extraRows };
  }, [shown, releaseIndex, total]);

  const extraCounts = useMemo(() => {
    const counts = new Map<ExtraKind, number>();
    for (const row of extraRows) {
      const kind = extraKindOf(row.file);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return EXTRA_KIND_ORDER.filter((k) => counts.has(k)).map((k) => `${EXTRA_KIND_LABELS[k]}: ${counts.get(k)}`);
  }, [extraRows]);

  // The known total (more only when progress or files go past it); 12 cells while the total is unknown
  const gridCount = Math.max(total || 12, progress, ...anime.available_episodes, ...onDisk);

  const playEpisode = async (ep: number) => {
    const file = filtered ? releaseFile(filtered, ep, total) : fileByEpisode.get(ep);
    if (!file) {
      onMissingEpisode();
      return;
    }
    try {
      await toraApi.playEpisodeFile(file.file_path);
      showToast(`Playing Episode ${ep}: ${file.file_name}`, "info");
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  const togglePin = (r: Release) => {
    const next = pinned === r.key ? null : r.key;
    setPinnedRelease(anime.id, next).catch((e) => showToast(String(e), "error"));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
          <Film className="w-4 h-4 text-accent" />
          Episodes
          <span className="normal-case tracking-normal font-normal text-text-muted">
            {plural(onDisk.size, "episode")} on disk
            {releases.length > 1 && ` · ${plural(releases.length, "release")}`}
          </span>
        </h3>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" />
            Unwatched on disk
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/80 inline-block" />
            Watched on disk
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-accent/30 inline-block" />
            Watched
          </span>
        </div>
      </div>

      {/* Releases: click filters, the pin chooses what plays (the oldest release when none is pinned) */}
      {releases.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFilterKey(null)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-medium transition ${
              filtered === null
                ? "bg-accent/15 border-accent/60 text-text-primary"
                : "bg-bg-primary border-border-subtle text-text-secondary hover:border-text-secondary"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            All
          </button>
          {releases.map((r, i) => {
            const color = colorOf(i);
            const active = filtered?.key === r.key;
            const isPlaying = playing?.key === r.key;
            const isPinned = pinned !== null && isPlaying;
            return (
              <div
                key={r.key}
                className={`flex items-center rounded-lg border text-[11px] transition ${
                  active ? `bg-bg-tertiary ${color.ring}` : "bg-bg-primary border-border-subtle hover:border-text-secondary"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setFilterKey(active ? null : r.key)}
                  title={`${r.folder}\n${plural(r.files.length, "file")} · ${formatBytes(r.totalBytes)}`}
                  className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 min-w-0"
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${color.dot}`} />
                  <span className={`font-medium max-w-[12rem] truncate ${active ? "text-text-primary" : "text-text-secondary"}`}>
                    {releaseLabel(r)}
                  </span>
                  {r.resolution && <span className="font-mono text-text-muted">{r.resolution}</span>}
                  <span className="text-text-muted">· {plural(r.episodes.size, "ep")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => togglePin(r)}
                  title={
                    isPinned
                      ? "Plays first (pinned). Click to unpin: the oldest release plays again"
                      : isPlaying
                        ? "Plays first (the oldest release). Click to pin it"
                        : "Play this release first"
                  }
                  className={`pr-2 pl-1 py-1.5 transition ${
                    isPinned ? "text-accent" : isPlaying ? "text-text-secondary" : "text-text-muted/50 hover:text-text-secondary"
                  }`}
                >
                  {isPinned ? <Pin className="w-3.5 h-3.5 fill-current" /> : isPlaying ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Episode grid (follows the release filter; a small number = episodes held by several releases) */}
      <div className="grid grid-cols-8 sm:grid-cols-12 gap-1.5 p-3 rounded-xl bg-bg-primary/60 border border-border-subtle max-h-64 overflow-y-auto">
        {Array.from({ length: gridCount }, (_, idx) => idx + 1).map((epNum) => {
          const hasLocal = onDisk.has(epNum);
          const isWatched = epNum <= progress;
          const copies = filtered ? 0 : releasesPerEpisode.get(epNum) ?? 0;
          let btnClass = "bg-bg-tertiary text-text-muted border-border-subtle hover:border-text-secondary";
          if (hasLocal && !isWatched) {
            btnClass =
              "bg-amber-500/20 text-amber-300 border-amber-500/60 font-bold hover:bg-amber-500 hover:text-black shadow-sm";
          } else if (hasLocal && isWatched) {
            btnClass = "bg-emerald-500/20 text-emerald-300 border-emerald-500/50 hover:bg-emerald-500 hover:text-black";
          } else if (isWatched) {
            btnClass = "bg-accent/15 text-accent border-accent/30 hover:bg-accent/30";
          }
          return (
            <button
              key={epNum}
              onClick={() => playEpisode(epNum)}
              title={
                hasLocal
                  ? `Episode ${epNum} on disk${copies > 1 ? ` (${copies} releases)` : ""}. Click to play`
                  : `Episode ${epNum}. Click to search torrents for this anime`
              }
              className={`relative py-1.5 rounded-md text-xs font-mono border transition flex items-center justify-center ${btnClass} ${
                epNum === playingEpisode ? "ring-2 ring-accent ring-offset-1 ring-offset-bg-primary" : ""
              }`}
            >
              {epNum}
              {copies > 1 && (
                <span className="absolute top-0 right-0.5 text-[8px] leading-none font-sans font-bold opacity-80">
                  {copies}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {episodeRows.length > 0 && <FileRows rows={episodeRows} releases={releases} />}

      {extraRows.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setExtrasOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary transition"
          >
            {extrasOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Extras ({extraRows.length})
            <span className="normal-case tracking-normal font-normal text-text-muted">{extraCounts.join(" · ")}</span>
          </button>
          {extrasOpen && <FileRows rows={extraRows} releases={releases} />}
        </div>
      )}
    </div>
  );
};
