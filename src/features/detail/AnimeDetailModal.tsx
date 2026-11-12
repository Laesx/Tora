import React, { useEffect, useState } from "react";
import { Play, Search, Plus, ListChecks } from "lucide-react";
import { AnimeEntry, MediaRelation, StudioRef } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { useCustomLists } from "@/contexts/customLists";
import { CustomListsPanel } from "@/components/CustomListsPanel";
import { torrentSearchFor } from "@/lib/torrents";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";
import { log } from "@/lib/log";
import { pickEpisodeFile, usePinnedRelease } from "@/lib/releases";
import { useEntryEditor } from "./useEntryEditor";
import { DetailHero } from "./DetailHero";
import { UserStatePanel } from "./UserStatePanel";
import { EpisodesPanel } from "./EpisodesPanel";
import { EntrySettings } from "./EntrySettings";
import { RelationsPanel } from "./RelationsPanel";

interface AnimeDetailModalProps {
  anime: AnimeEntry;
  /** Show this season in the Seasons tab */
  onOpenSeason: (season: string, year: number) => void;
  /** false for anime opened from Seasons/Search that aren't in the user's list: tracking controls are hidden */
  inList: boolean;
  /** The user's list by id (relations show status, progress and files of list entries) */
  listById: Map<number, AnimeEntry>;
  onAddToList: (status: "CURRENT" | "PLANNING") => Promise<void>;
  onClose: () => void;
  onUpdated: (updated: AnimeEntry) => void;
  /** A debounced ± step saved after the drawer closed or switched anime: update the list only */
  onSavedInBackground?: (updated: AnimeEntry) => void;
  onDeleted: (animeId: number) => void;
}

export const AnimeDetailModal: React.FC<AnimeDetailModalProps> = ({
  anime,
  onOpenSeason,
  inList,
  listById,
  onAddToList,
  onClose,
  onUpdated,
  onSavedInBackground,
  onDeleted,
}) => {
  const { searchTorrents } = useAnimeActions();
  const showToast = useToast();
  const customListNames = useCustomLists().names;
  const editor = useEntryEditor({ anime, inList, onUpdated, onSavedInBackground });
  const { progress, localFiles } = editor;
  const pinned = usePinnedRelease(anime.id);
  // Animation studios with AniList ids (stored metadata; fetched once for media without any)
  const [studioRefs, setStudioRefs] = useState<StudioRef[] | null>(null);
  const [relations, setRelations] = useState<MediaRelation[]>([]);
  const [adding, setAdding] = useState(false);

  const mediaId = anime.anilist_id ?? anime.id;
  useEffect(() => {
    setStudioRefs(null);
    setRelations([]);
    let cancelled = false;
    toraApi
      .getMediaMetadata(mediaId)
      .then((m) => {
        if (cancelled) return;
        setStudioRefs(m?.metadata.studios.filter((s) => s.is_animation_studio) ?? []);
        setRelations(m?.metadata.relations ?? []);
      })
      .catch((e) => log.error("detail", "Failed to load media metadata", e));
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  const handleAddToList = async (nextStatus: "CURRENT" | "PLANNING") => {
    setAdding(true);
    try {
      await onAddToList(nextStatus);
    } finally {
      setAdding(false);
    }
  };

  const handlePlayNextUnwatched = async () => {
    const nextEp = progress + 1;
    const file = pickEpisodeFile(localFiles, nextEp, anime.episodes, pinned);
    if (!file) {
      showToast(`No local file for episode ${nextEp}`, "info");
      return;
    }
    try {
      await toraApi.playEpisodeFile(file.file_path);
      showToast(`Playing next episode (#${nextEp})`, "info");
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-end bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl h-full bg-bg-secondary border-l border-border-subtle flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <DetailHero anime={anime} studioRefs={studioRefs} onOpenSeason={onOpenSeason} onClose={onClose} />

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Quick Action Bar */}
          {inList && (
            <div className="flex flex-wrap items-center gap-2.5 bg-bg-tertiary/70 p-3 rounded-xl border border-border-subtle">
              {/* Nothing left to play once every episode is watched */}
              {!(anime.episodes && progress >= anime.episodes) && (
                <button
                  onClick={handlePlayNextUnwatched}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Play Next (Ep {progress + 1})
                </button>
              )}

              <button
                onClick={() => searchTorrents(torrentSearchFor(anime))}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-bg-elevated hover:bg-bg-primary text-text-primary text-xs font-medium border border-border-subtle transition"
              >
                <Search className="w-3.5 h-3.5 text-accent" />
                Find Torrents
              </button>
            </div>
          )}

          {!inList && (
            <div className="flex flex-wrap items-center justify-between gap-3 bg-bg-tertiary/40 p-4 rounded-xl border border-border-subtle">
              <div>
                <div className="text-xs font-semibold text-text-primary">Not in your list</div>
                <div className="text-[11px] text-text-muted mt-0.5">Add it to track progress, score and dates.</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleAddToList("PLANNING")}
                  disabled={adding}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-bg-elevated hover:bg-bg-primary text-text-primary text-xs font-medium border border-border-subtle transition disabled:opacity-60"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add to Planning
                </button>
                <button
                  onClick={() => handleAddToList("CURRENT")}
                  disabled={adding}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm disabled:opacity-60"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Add to Watching
                </button>
              </div>
            </div>
          )}

          {inList && (
            <>
              <UserStatePanel anime={anime} editor={editor} />

              {/* AniList custom lists (hidden when the user has none) */}
              {customListNames.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
                    <ListChecks className="w-4 h-4 text-accent" />
                    Custom Lists
                  </h3>
                  <CustomListsPanel animeIds={[anime.id]} variant="chips" />
                </div>
              )}

              <EpisodesPanel
                anime={anime}
                files={localFiles}
                progress={progress}
                onMissingEpisode={() => searchTorrents(torrentSearchFor(anime))}
              />
            </>
          )}

          <RelationsPanel relations={relations} listById={listById} />

          {/* Synopsis & Metadata */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Synopsis & Details</h3>
            <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-line bg-bg-primary/50 p-3.5 rounded-xl border border-border-subtle">
              {anime.synopsis || "No synopsis available."}
            </p>

            {anime.genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {anime.genres.map((g) => (
                  <span
                    key={g}
                    className="px-2.5 py-1 rounded-full text-[11px] bg-bg-tertiary text-text-secondary border border-border-subtle"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>

          {inList && <EntrySettings anime={anime} editor={editor} onDeleted={onDeleted} />}
        </div>
      </div>
    </div>
  );
};
