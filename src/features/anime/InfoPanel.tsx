import React, { useMemo } from "react";
import { Star } from "lucide-react";
import { AnimeEntry, SeasonalAnime } from "@/lib/types";
import { seasonName } from "@/lib/seasons";
import { anilistStudioUrl, formatEnum, formatFuzzyDate, formatRanking, openExternal } from "@/lib/anime";
import { useToast } from "@/contexts/toast";
import { PageSection } from "./PageSection";

/** Facts about the anime (season → Seasons tab, studios → AniList) and its best rankings. */
export const InfoPanel: React.FC<{
  anime: AnimeEntry;
  media: SeasonalAnime | null;
  onOpenSeason: (season: string, year: number) => void;
}> = ({ anime, media, onOpenSeason }) => {
  const showToast = useToast();
  const meta = media?.metadata;
  const studios = meta?.studios.filter((s) => s.is_animation_studio) ?? [];
  const producers = meta?.studios.filter((s) => !s.is_animation_studio) ?? [];
  const rankings = useMemo(
    () =>
      (meta?.rankings ?? [])
        .slice()
        .sort((a, b) => Number(a.all_time) - Number(b.all_time) || a.rank - b.rank)
        .slice(0, 4),
    [meta]
  );

  const studioLinks = (list: typeof studios, className: string) => (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {list.map((s) => (
        <button key={s.id} onClick={() => openExternal(anilistStudioUrl(s.id), showToast)} className={className}>
          {s.name}
        </button>
      ))}
    </span>
  );

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Type", value: formatEnum(anime.format) },
    { label: "Episodes", value: anime.episodes ?? "?" },
    { label: "Duration", value: anime.duration ? `${anime.duration} min` : null },
    { label: "Status", value: formatEnum(anime.airing_status) },
    {
      label: "Season",
      value:
        anime.season && anime.season_year ? (
          <button
            onClick={() => onOpenSeason(anime.season!, anime.season_year!)}
            title="Open this season"
            className="text-accent hover:underline"
          >
            {seasonName(anime.season)} {anime.season_year}
          </button>
        ) : null,
    },
    {
      label: "Aired",
      value: anime.start_date ? `${formatFuzzyDate(anime.start_date)} – ${formatFuzzyDate(anime.end_date) ?? "?"}` : null,
    },
    { label: "Source", value: anime.source_material ? formatEnum(anime.source_material) : null },
    {
      label: "Studios",
      value:
        studios.length > 0
          ? studioLinks(studios, "text-accent hover:underline")
          : anime.studios.length > 0
            ? anime.studios.join(", ")
            : null,
    },
    {
      label: "Producers",
      value: producers.length > 0 ? studioLinks(producers, "text-text-secondary hover:text-accent hover:underline") : null,
    },
    { label: "Average score", value: anime.average_score ? `${anime.average_score}%` : null },
    { label: "Mean score", value: meta?.mean_score ? `${meta.mean_score}%` : null },
    { label: "Popularity", value: media?.popularity?.toLocaleString() ?? null },
    { label: "Favourites", value: meta?.favourites?.toLocaleString() ?? null },
  ].filter((r) => r.value !== null && r.value !== undefined && r.value !== "");

  return (
    <PageSection title="Information">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {rows.map((r) => (
          <React.Fragment key={r.label}>
            <dt className="text-text-muted">{r.label}</dt>
            <dd className="text-text-primary min-w-0">{r.value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {rankings.length > 0 && (
        <div className="pt-2 border-t border-border-subtle space-y-1">
          {rankings.map((r, i) => (
            <div key={i} className="text-[11px] text-text-secondary flex items-center gap-1.5">
              <Star className="w-3 h-3 text-amber-400" />
              {formatRanking(r)}
            </div>
          ))}
        </div>
      )}
    </PageSection>
  );
};
