import React, { useState } from "react";
import { BookOpen, HardDrive, Network, Plus } from "lucide-react";
import { AnimeEntry, MediaRelation } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { getOptimizedCoverUrl } from "@/lib/covers";
import { formatEnum, openExternal } from "@/lib/anime";
import { STATUS_INFO } from "@/lib/status";
import { useAnimeTitle } from "@/contexts/titles";
import { useToast } from "@/contexts/toast";
import { useAnimeActions } from "@/contexts/animeActions";

/** Card order; relation types not listed here come last. */
const RELATION_ORDER = [
  "PREQUEL",
  "SEQUEL",
  "PARENT",
  "SIDE_STORY",
  "SPIN_OFF",
  "ALTERNATIVE",
  "SUMMARY",
  "COMPILATION",
  "CONTAINS",
  "CHARACTER",
  "ADAPTATION",
  "SOURCE",
  "OTHER",
];

const RELATION_LABELS: Record<string, string> = {
  PREQUEL: "Prequel",
  SEQUEL: "Sequel",
  PARENT: "Parent story",
  SIDE_STORY: "Side story",
  SPIN_OFF: "Spin-off",
  ALTERNATIVE: "Alternative",
  SUMMARY: "Summary",
  COMPILATION: "Compilation",
  CONTAINS: "Contains",
  CHARACTER: "Same characters",
  ADAPTATION: "Adaptation",
  SOURCE: "Source",
  OTHER: "Other",
};

const relationLabel = (type: string) => RELATION_LABELS[type] ?? formatEnum(type);
const orderOf = (type: string) => {
  const i = RELATION_ORDER.indexOf(type);
  return i === -1 ? RELATION_ORDER.length : i;
};

/** Not anime: only what it was adapted from is shown. */
const isShownSource = (r: MediaRelation) =>
  r.media_type !== "ANIME" && (r.relation_type === "SOURCE" || r.relation_type === "ADAPTATION");

/** Whether `RelationsPanel` shows anything for these relations. */
export const hasVisibleRelations = (relations: MediaRelation[]) =>
  relations.some((r) => r.media_type === "ANIME" || isShownSource(r));

/** Fixed card height, so the grid never reflows while covers load. */
const CARD_HEIGHT = "h-[88px]";

/**
 * The anime's relations: anime as cards (list status, progress and files on disk for list entries; anime
 * not on the list are dimmed, with a quick add), the source manga / novel as chips. A click opens the
 * related anime in the drawer (back returns here); nothing is fetched until then.
 */
export const RelationsPanel: React.FC<{
  relations: MediaRelation[];
  listById: Map<number, AnimeEntry>;
}> = ({ relations, listById }) => {
  const showToast = useToast();
  const titleOf = useAnimeTitle();
  const { openAnime, openAnimePage, addAnime } = useAnimeActions();
  const [busyId, setBusyId] = useState<number | null>(null);

  const anime = relations
    .filter((r) => r.media_type === "ANIME")
    .sort((a, b) => orderOf(a.relation_type) - orderOf(b.relation_type) || (a.year ?? 9999) - (b.year ?? 9999));
  const sources = relations.filter(isShownSource);
  if (anime.length === 0 && sources.length === 0) return null;

  /** The full media of an anime not on the list (stored, or fetched once from AniList). */
  const remoteMedia = async (id: number): Promise<AnimeEntry | null> => {
    setBusyId(id);
    try {
      const media = await toraApi.getMediaMetadata(id);
      if (!media) showToast("AniList has no data for this anime", "error");
      return media;
    } catch (e) {
      showToast(String(e), "error");
      return null;
    } finally {
      setBusyId(null);
    }
  };

  /** Click: the drawer; Ctrl+click: the full page. */
  const open = async (r: MediaRelation, fullPage: boolean) => {
    const target = listById.get(r.id) ?? (await remoteMedia(r.id));
    if (!target) return;
    if (fullPage) openAnimePage(target);
    else openAnime(target);
  };

  const addToPlanning = async (r: MediaRelation) => {
    const media = await remoteMedia(r.id);
    if (media) await addAnime(media, "PLANNING");
  };

  return (
    <div className="space-y-2.5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
        <Network className="w-4 h-4 text-accent" />
        Related
      </h3>

      {anime.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {anime.map((r) => {
            const entry = listById.get(r.id);
            const status = entry ? STATUS_INFO[entry.user_status] : undefined;
            const cover = entry?.cover_image ?? r.cover_image;
            const facts = [
              r.format ? formatEnum(r.format) : null,
              r.year ? String(r.year) : null,
              r.episodes && r.format !== "MOVIE" ? `${r.episodes} eps` : null,
            ].filter(Boolean);
            return (
              <div
                key={`${r.relation_type}-${r.id}`}
                className={`group relative flex gap-2.5 p-2 rounded-xl border border-border-subtle bg-bg-primary/60 hover:border-accent/60 transition overflow-hidden ${CARD_HEIGHT} ${
                  entry ? "" : "opacity-75 hover:opacity-100"
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => open(r, e.ctrlKey || e.metaKey)}
                  disabled={busyId === r.id}
                  title={`${titleOf(entry ?? r)}${entry ? "" : " (not in your list)"}\nCtrl+click: full page`}
                  className="flex gap-2.5 min-w-0 flex-1 text-left disabled:cursor-wait"
                >
                  <div className="w-12 h-full shrink-0 rounded-md overflow-hidden bg-bg-tertiary">
                    {cover && (
                      <img
                        src={getOptimizedCoverUrl(cover, "medium")}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 flex flex-col">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-accent truncate">
                      {relationLabel(r.relation_type)}
                    </span>
                    <span className="text-xs font-medium text-text-primary line-clamp-2 leading-snug">
                      {titleOf(entry ?? r)}
                    </span>
                    <span className="mt-auto flex items-center gap-1.5 text-[10px] text-text-muted min-w-0">
                      {status ? (
                        <span className={`px-1.5 py-px rounded font-semibold shrink-0 ${status.badge}`}>
                          {status.shortLabel}
                          {entry && entry.user_progress > 0 && entry.user_status !== "COMPLETED"
                            ? ` ${entry.user_progress}/${entry.episodes ?? "?"}`
                            : ""}
                        </span>
                      ) : (
                        <span className="shrink-0 italic">Not in list</span>
                      )}
                      {entry && entry.local_episode_count > 0 && (
                        <span title={`${entry.available_episodes.length} episodes on disk`} className="shrink-0">
                          <HardDrive className="w-3 h-3 text-emerald-400" />
                        </span>
                      )}
                      <span className="truncate">{facts.join(" · ")}</span>
                    </span>
                  </div>
                </button>
                {!entry && (
                  <button
                    type="button"
                    onClick={() => addToPlanning(r)}
                    disabled={busyId === r.id}
                    title="Add to Plan to Watch"
                    className="absolute top-1.5 right-1.5 p-1 rounded-md bg-bg-tertiary text-text-secondary hover:bg-accent hover:text-white opacity-0 group-hover:opacity-100 transition disabled:cursor-wait"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sources.map((r) => (
            <button
              key={`${r.relation_type}-${r.id}`}
              type="button"
              onClick={() => openExternal(`https://anilist.co/manga/${r.id}`, showToast)}
              title={`${titleOf(r)}: open on AniList`}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-bg-tertiary text-text-secondary border border-border-subtle hover:border-accent hover:text-text-primary transition max-w-full"
            >
              <BookOpen className="w-3 h-3 shrink-0 text-accent" />
              <span className="shrink-0">
                {relationLabel(r.relation_type)}: {formatEnum(r.format)}
              </span>
              <span className="truncate text-text-muted">{titleOf(r)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
