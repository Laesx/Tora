import React from "react";
import { BookOpen, Network } from "lucide-react";
import { AnimeEntry, MediaRelation } from "@/lib/types";
import { formatEnum, openExternal } from "@/lib/anime";
import { useAnimeTitle } from "@/contexts/titles";
import { useToast } from "@/contexts/toast";
import { MediaCardGrid } from "@/components/MediaCardGrid";

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

/**
 * The anime's relations: anime as cards (`MediaCardGrid`: list state, quick add, click = drawer,
 * Ctrl+click = full page), the source manga / novel as chips.
 */
export const RelationsPanel: React.FC<{
  relations: MediaRelation[];
  listById: Map<number, AnimeEntry>;
}> = ({ relations, listById }) => {
  const showToast = useToast();
  const titleOf = useAnimeTitle();

  const anime = relations
    .filter((r) => r.media_type === "ANIME")
    .sort((a, b) => orderOf(a.relation_type) - orderOf(b.relation_type) || (a.year ?? 9999) - (b.year ?? 9999));
  const sources = relations.filter(isShownSource);
  if (anime.length === 0 && sources.length === 0) return null;

  return (
    <div className="space-y-2.5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
        <Network className="w-4 h-4 text-accent" />
        Related
      </h3>

      {anime.length > 0 && (
        <MediaCardGrid
          items={anime.map((r) => ({ key: `${r.relation_type}-${r.id}`, media: r, label: relationLabel(r.relation_type) }))}
          listById={listById}
        />
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
