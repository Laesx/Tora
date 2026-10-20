import React, { useEffect, useMemo, useState } from "react";
import {
  HardDrive,
  FolderPlus,
  RefreshCw,
  Trash2,
  Play,
  FolderOpen,
  Link2,
  CheckCircle2,
  AlertCircle,
  Search,
  Sparkles,
  Database,
  Film,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AnimeEntry,
  DriveStorageSummary,
  LibraryFolder,
  LocalEpisodeFile,
  ScanSummary,
} from "../types";
import { formatBytes, toraApi } from "../api";

interface LibraryManagerViewProps {
  animeList: AnimeEntry[];
  onRefreshAnimeList: () => Promise<void>;
  onSelectAnime: (anime: AnimeEntry) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

export const LibraryManagerView: React.FC<LibraryManagerViewProps> = ({
  animeList,
  onRefreshAnimeList,
  onSelectAnime,
  showToast,
}) => {
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [drives, setDrives] = useState<DriveStorageSummary[]>([]);
  const [episodes, setEpisodes] = useState<LocalEpisodeFile[]>([]);
  const [newPath, setNewPath] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<ScanSummary | null>(null);

  // Filters for local episode browser
  const [searchQuery, setSearchQuery] = useState("");
  const [driveFilter, setDriveFilter] = useState("ALL");
  const [matchFilter, setMatchFilter] = useState<"ALL" | "MATCHED" | "UNMATCHED">("ALL");
  const [bindingFileId, setBindingFileId] = useState<number | null>(null);
  const [selectedBindAnimeId, setSelectedBindAnimeId] = useState<number>(
    animeList[0]?.id || 0
  );

  const loadLibraryState = async () => {
    try {
      const [f, d, eps] = await Promise.all([
        toraApi.getLibraryFolders(),
        toraApi.getDriveSummaries(),
        toraApi.getLocalEpisodes(null),
      ]);
      setFolders(f);
      setDrives(d);
      setEpisodes(eps);
    } catch (e: any) {
      showToast(`Error loading library: ${e}`, "error");
    }
  };

  useEffect(() => {
    loadLibraryState();
  }, []);

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Anime Library Root Folder",
      });
      if (selected && typeof selected === "string") {
        setNewPath(selected);
      }
    } catch {
      // Fallback if dialog cancelled
    }
  };

  const handleAddFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPath.trim()) return;
    setScanning(true);
    try {
      await toraApi.addLibraryFolder(
        newPath.trim(),
        newLabel.trim() || undefined
      );
      setNewPath("");
      setNewLabel("");
      await loadLibraryState();
      await onRefreshAnimeList();
      showToast("Added library folder and indexed video files!", "success");
    } catch (err: any) {
      showToast(String(err), "error");
    } finally {
      setScanning(false);
    }
  };

  const handleRemoveFolder = async (folderId: number) => {
    try {
      await toraApi.removeLibraryFolder(folderId);
      await loadLibraryState();
      await onRefreshAnimeList();
      showToast("Removed library folder", "info");
    } catch (err: any) {
      showToast(String(err), "error");
    }
  };

  const handleScanAll = async () => {
    setScanning(true);
    try {
      const summary = await toraApi.scanLibrary();
      setLastScan(summary);
      await loadLibraryState();
      await onRefreshAnimeList();
      showToast(
        `Scanned ${summary.folders_scanned} folders (${summary.total_files_indexed} files) in ${summary.elapsed_ms}ms`,
        "success"
      );
    } catch (err: any) {
      showToast(String(err), "error");
    } finally {
      setScanning(false);
    }
  };

  const handleCreateDemoLibrary = async () => {
    setScanning(true);
    try {
      const summary = await toraApi.createDemoLibraryFiles();
      setLastScan(summary);
      await loadLibraryState();
      await onRefreshAnimeList();
      showToast(
        `Created & indexed ${summary.total_files_indexed} demo anime files across 2 folders!`,
        "success"
      );
    } catch (err: any) {
      showToast(String(err), "error");
    } finally {
      setScanning(false);
    }
  };

  const handleBindAlias = async (normalizedTitle: string, animeId: number) => {
    try {
      const matchedCount = await toraApi.bindTitleAlias(
        normalizedTitle,
        animeId
      );
      setBindingFileId(null);
      await loadLibraryState();
      await onRefreshAnimeList();
      showToast(
        `Linked "${normalizedTitle}" — ${matchedCount} total files matched!`,
        "success"
      );
    } catch (err: any) {
      showToast(String(err), "error");
    }
  };

  const filteredEpisodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return episodes.filter((ep) => {
      if (driveFilter !== "ALL" && ep.drive_root !== driveFilter) return false;
      if (matchFilter === "MATCHED" && !ep.matched_anime_id) return false;
      if (matchFilter === "UNMATCHED" && ep.matched_anime_id) return false;
      if (q) {
        return (
          ep.file_name.toLowerCase().includes(q) ||
          ep.parsed_title.toLowerCase().includes(q) ||
          (ep.release_group && ep.release_group.toLowerCase().includes(q)) ||
          (ep.matched_anime_title &&
            ep.matched_anime_title.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [episodes, searchQuery, driveFilter, matchFilter]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header & Global Scan Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
            <HardDrive className="w-6 h-6 text-accent" />
            Multi-Drive Episode Library Manager
          </h1>
          <p className="text-xs text-text-secondary mt-0.5">
            Index tens of thousands of anime episodes across multiple hard drives with parallel Anitomy filename parsing.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleCreateDemoLibrary}
            disabled={scanning}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-primary text-xs font-medium border border-border-subtle transition"
            title="Create sample anime folders & MKV files to test multi-folder scanning"
          >
            <Sparkles className="w-4 h-4 text-amber-400" />
            Generate Demo Library
          </button>

          <button
            onClick={handleScanAll}
            disabled={scanning}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold shadow-sm transition"
          >
            <RefreshCw
              className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`}
            />
            {scanning ? "Scanning Drives..." : "Rescan All Drives"}
          </button>
        </div>
      </div>

      {/* Scan performance banner */}
      {lastScan && (
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              Parallel scan completed in{" "}
              <strong className="font-mono">{lastScan.elapsed_ms} ms</strong> across{" "}
              <strong>{lastScan.folders_scanned}</strong> root folders:{" "}
              <strong>{lastScan.total_files_indexed}</strong> video files indexed,{" "}
              <strong>{lastScan.matched_files}</strong> automatically linked to your watchlist.
            </span>
          </div>
        </div>
      )}

      {/* Multi-Drive Storage Cards */}
      {drives.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {drives.map((d) => {
            const usedBytes = Math.max(
              0,
              d.drive_total_bytes - d.drive_free_bytes
            );
            const usedPct =
              d.drive_total_bytes > 0
                ? Math.min(100, Math.round((usedBytes / d.drive_total_bytes) * 100))
                : 0;
            return (
              <div
                key={d.drive_root}
                className="p-4 rounded-xl bg-bg-secondary border border-border-subtle space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-accent/15 text-accent">
                      <HardDrive className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-text-primary font-mono">
                        Drive {d.drive_root}
                      </h3>
                      <p className="text-[11px] text-text-muted">
                        {d.folder_count} library{" "}
                        {d.folder_count === 1 ? "folder" : "folders"} •{" "}
                        {d.anime_file_count} episodes
                      </p>
                    </div>
                  </div>
                  <span className="px-2 py-1 rounded bg-bg-tertiary text-xs font-mono text-accent font-semibold">
                    {formatBytes(d.anime_bytes)} anime
                  </span>
                </div>

                {d.drive_total_bytes > 0 && (
                  <div className="space-y-1">
                    <div className="w-full h-2 rounded-full bg-bg-tertiary overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all"
                        style={{ width: `${usedPct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] text-text-muted font-mono">
                      <span>{formatBytes(d.drive_free_bytes)} free</span>
                      <span>
                        {usedPct}% of {formatBytes(d.drive_total_bytes)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Folder Form + Root Folders List */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
          <FolderPlus className="w-4 h-4 text-accent" />
          Root Library Folders (Across Any Hard Drive or NAS)
        </h2>

        <form
          onSubmit={handleAddFolder}
          className="grid grid-cols-1 md:grid-cols-12 gap-2.5"
        >
          <div className="md:col-span-6 flex gap-2">
            <input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="e.g. D:\Anime or E:\Seasonal Anime"
              className="flex-1 px-3.5 py-2 rounded-xl bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={handleBrowseFolder}
              className="px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-xs text-text-secondary hover:text-text-primary transition shrink-0"
            >
              Browse...
            </button>
          </div>
          <div className="md:col-span-4">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Optional label (e.g. NVMe Seasonal Drive)"
              className="w-full px-3.5 py-2 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
            />
          </div>
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={scanning || !newPath.trim()}
              className="w-full py-2 px-4 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-semibold transition"
            >
              Add Folder
            </button>
          </div>
        </form>

        {folders.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-border-subtle rounded-xl text-xs text-text-muted space-y-2">
            <p>
              No library folders configured yet. Add a folder path above or click{" "}
              <strong className="text-text-primary">Generate Demo Library</strong> to test multi-folder episode indexing immediately!
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle border border-border-subtle rounded-xl overflow-hidden">
            {folders.map((folder) => (
              <div
                key={folder.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-bg-primary/60 hover:bg-bg-tertiary/40 transition text-xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="px-2 py-1 rounded bg-accent/15 text-accent font-mono font-bold text-[11px]">
                    {folder.drive_root}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold text-text-primary flex items-center gap-2">
                      <span>{folder.label}</span>
                      <span className="text-[11px] font-mono text-text-muted">
                        ({folder.file_count} files • {formatBytes(folder.total_bytes)})
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-text-muted truncate">
                      {folder.path}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toraApi.revealInExplorer(folder.path)}
                    className="p-1.5 rounded-lg bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary transition"
                    title="Open folder in Explorer"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleRemoveFolder(folder.id)}
                    className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 transition"
                    title="Remove folder from library"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Indexed Local Episodes Browser */}
      <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Database className="w-4 h-4 text-accent" />
            Indexed Video Files ({filteredEpisodes.length} of {episodes.length})
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter files, groups, titles..."
                className="pl-8 pr-3 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent w-56"
              />
            </div>

            <select
              value={driveFilter}
              onChange={(e) => setDriveFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary"
            >
              <option value="ALL">All Drives</option>
              {drives.map((d) => (
                <option key={d.drive_root} value={d.drive_root}>
                  Drive {d.drive_root}
                </option>
              ))}
            </select>

            <select
              value={matchFilter}
              onChange={(e) => setMatchFilter(e.target.value as any)}
              className="px-2.5 py-1.5 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary"
            >
              <option value="ALL">All Files</option>
              <option value="MATCHED">Matched to Watchlist</option>
              <option value="UNMATCHED">Unmatched Files</option>
            </select>
          </div>
        </div>

        {filteredEpisodes.length === 0 ? (
          <div className="text-center py-10 text-xs text-text-muted">
            No indexed video files match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto border border-border-subtle rounded-xl max-h-[420px] overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-bg-tertiary text-text-muted uppercase text-[10px] sticky top-0 z-10">
                <tr>
                  <th className="py-2.5 px-3">Drive</th>
                  <th className="py-2.5 px-3">Parsed Title (Anitomy)</th>
                  <th className="py-2.5 px-3">Ep</th>
                  <th className="py-2.5 px-3">Metadata</th>
                  <th className="py-2.5 px-3">Linked Anime</th>
                  <th className="py-2.5 px-3 text-right">Size</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle bg-bg-primary/40">
                {filteredEpisodes.slice(0, 250).map((ep) => {
                  const linkedAnime = animeList.find(
                    (a) => a.id === ep.matched_anime_id
                  );
                  return (
                    <tr
                      key={ep.id}
                      className="hover:bg-bg-tertiary/50 transition"
                    >
                      <td className="py-2 px-3 font-mono text-[11px] text-text-secondary">
                        {ep.drive_root}
                      </td>
                      <td className="py-2 px-3">
                        <div className="font-medium text-text-primary">
                          {ep.parsed_title}
                        </div>
                        <div
                          className="text-[11px] text-text-muted truncate max-w-xs font-mono"
                          title={ep.file_path}
                        >
                          {ep.file_name}
                        </div>
                      </td>
                      <td className="py-2 px-3 font-mono font-bold text-accent">
                        {ep.episode_number ?? "-"}
                      </td>
                      <td className="py-2 px-3">
                        <div className="flex flex-wrap gap-1">
                          {ep.release_group && (
                            <span className="px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary text-[10px]">
                              {ep.release_group}
                            </span>
                          )}
                          {ep.resolution && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono text-[10px]">
                              {ep.resolution}
                            </span>
                          )}
                          {ep.video_terms.map((vt) => (
                            <span
                              key={vt}
                              className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-mono text-[10px]"
                            >
                              {vt}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 px-3">
                        {linkedAnime ? (
                          <button
                            onClick={() => onSelectAnime(linkedAnime)}
                            className="flex items-center gap-1.5 text-emerald-400 hover:underline font-medium"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate max-w-[180px]">
                              {linkedAnime.title_romaji}
                            </span>
                          </button>
                        ) : bindingFileId === ep.id ? (
                          <div className="flex items-center gap-1">
                            <select
                              value={selectedBindAnimeId}
                              onChange={(e) =>
                                setSelectedBindAnimeId(Number(e.target.value))
                              }
                              className="px-2 py-1 rounded bg-bg-primary border border-border-subtle text-[11px] text-text-primary max-w-[160px]"
                            >
                              {animeList.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.title_romaji}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() =>
                                handleBindAlias(
                                  ep.normalized_title,
                                  selectedBindAnimeId
                                )
                              }
                              className="px-2 py-1 rounded bg-accent text-white text-[10px] font-semibold"
                            >
                              Bind
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setBindingFileId(ep.id);
                              setSelectedBindAnimeId(animeList[0]?.id || 0);
                            }}
                            className="flex items-center gap-1 text-amber-400 hover:underline text-[11px]"
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            Bind to Anime
                          </button>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[11px] text-text-muted">
                        {formatBytes(ep.file_size)}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => toraApi.playEpisodeFile(ep.file_path)}
                            className="p-1.5 rounded bg-accent/15 hover:bg-accent text-accent hover:text-white transition"
                            title="Play Episode"
                          >
                            <Play className="w-3.5 h-3.5 fill-current" />
                          </button>
                          <button
                            onClick={() =>
                              toraApi.revealInExplorer(ep.file_path)
                            }
                            className="p-1.5 rounded bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary transition"
                            title="Reveal in Explorer"
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
