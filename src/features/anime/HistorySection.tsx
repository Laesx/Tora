import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, History } from "lucide-react";
import { AnimeEntry, TimelineEpisode } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { log } from "@/lib/log";
import { dateLocale } from "@/lib/dates";
import { useAnimeActions } from "@/contexts/animeActions";
import { episodesLabel, splitWatchThroughs, watchThroughLabel } from "@/features/history/timeline";
import { PageSection } from "./PageSection";

const shortDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });

/** The anime's watch-throughs (newest first: dates and episodes) and a way into its History timeline. */
export const HistorySection: React.FC<{ anime: AnimeEntry }> = ({ anime }) => {
  const { openAnimeHistory } = useAnimeActions();
  const [episodes, setEpisodes] = useState<TimelineEpisode[] | null>(null);
  const mediaId = anime.anilist_id ?? anime.id;

  useEffect(() => {
    let cancelled = false;
    setEpisodes(null);
    toraApi
      .getHistoryTimeline(mediaId)
      .then((eps) => !cancelled && setEpisodes(eps))
      .catch((e) => log.warn("anime", "Failed to load the history timeline", e));
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  const passes = useMemo(() => (episodes ? splitWatchThroughs(episodes).reverse() : []), [episodes]);
  if (passes.length === 0) return null;

  return (
    <PageSection
      title={
        <>
          <History className="w-4 h-4 text-accent" />
          Your history
        </>
      }
      aside={
        <button
          onClick={() => openAnimeHistory(anime)}
          className="flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
        >
          Open in History
          <ArrowRight className="w-3 h-3" />
        </button>
      }
    >
      <div className="space-y-2">
        {passes.map((p) => {
          const first = p.episodes[0];
          const last = p.episodes[p.episodes.length - 1];
          return (
            <div key={p.index} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-text-primary">{watchThroughLabel(p.index)}</span>
                <span className="text-[11px] text-text-muted shrink-0">
                  {shortDate(first.timestamp_unix)}
                  {last !== first && shortDate(last.timestamp_unix) !== shortDate(first.timestamp_unix)
                    ? ` – ${shortDate(last.timestamp_unix)}`
                    : ""}
                </span>
              </div>
              <div className="text-[11px] text-text-secondary truncate">{episodesLabel(p.episodes)}</div>
            </div>
          );
        })}
      </div>
    </PageSection>
  );
};
