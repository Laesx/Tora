import React from "react";
import { FolderOpen, Save, Tag, Trash2 } from "lucide-react";
import { AnimeEntry } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { useToast } from "@/contexts/toast";
import { useAnimeTitle } from "@/contexts/titles";
import { EntryEditor } from "./useEntryEditor";

/** Notes, custom folder and the user's own recognition aliases (AniList synonyms are not shown). */
export const EntrySettings: React.FC<{
  anime: AnimeEntry;
  editor: EntryEditor;
  onDeleted: (animeId: number) => void;
}> = ({ anime, editor, onDeleted }) => {
  const showToast = useToast();
  const titleOf = useAnimeTitle();
  const {
    status,
    progress,
    score,
    repeats,
    notes,
    setNotes,
    customFolder,
    setCustomFolder,
    synonymsInput,
    setSynonymsInput,
    localFiles,
    saving,
    handleSave,
  } = editor;

  const hasFolder = Boolean(
    customFolder.trim() || anime.custom_folder?.trim() || localFiles.length > 0 || anime.local_episode_count > 0
  );

  const handleOpenFolder = async () => {
    try {
      const target = customFolder.trim() || anime.custom_folder?.trim();
      if (target) {
        await toraApi.revealInExplorer(target);
        return;
      }
      const files = localFiles.length > 0 ? localFiles : await toraApi.getLocalEpisodes(anime.id);
      if (files.length > 0) {
        await toraApi.revealInExplorer(files[0].file_path);
        return;
      }
      showToast(`No local folder linked for "${titleOf(anime)}"`, "error");
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  return (
    <div className="space-y-3 bg-bg-tertiary/30 p-4 rounded-xl border border-border-subtle">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-1.5">
        <Tag className="w-3.5 h-3.5 text-accent" />
        Settings
      </h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] text-text-muted mb-1">Custom Aliases (file & player recognition)</label>
          <input
            type="text"
            value={synonymsInput}
            onChange={(e) => setSynonymsInput(e.target.value)}
            placeholder="Separated by a coma: HnK, Houseki"
            className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
          />
        </div>

        <div>
          <label className="block text-[11px] text-text-muted mb-1">Anime Folder Path</label>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={customFolder}
              onChange={(e) => setCustomFolder(e.target.value)}
              placeholder="e.g. D:\Anime\Houseki no Kuni"
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={handleOpenFolder}
              disabled={!hasFolder}
              title={hasFolder ? "Open folder in Explorer" : "No folder available"}
              className="self-stretch px-2.5 flex items-center justify-center rounded-lg bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle hover:border-accent text-text-secondary hover:text-text-primary transition shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border-subtle disabled:hover:bg-bg-tertiary disabled:hover:text-text-secondary"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div>
        <label className="block text-[11px] text-text-muted mb-1">Personal Notes (synced with AniList)</label>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add personal thoughts, release group preferences, etc."
          className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
        />
      </div>

      <div className="flex items-center justify-between pt-1">
        <button
          onClick={async () => {
            await toraApi.deleteAnimeEntry(anime.id);
            onDeleted(anime.id);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-500/15 transition"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Remove from Library
        </button>

        <button
          onClick={() => handleSave(status, progress, score, repeats, true)}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? "Saving..." : "Save Details"}
        </button>
      </div>
    </div>
  );
};
