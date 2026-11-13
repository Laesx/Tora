import React from "react";
import { ThumbsUp } from "lucide-react";
import { AnimeEntry, MediaDetails } from "@/lib/types";
import { MediaCardGrid } from "@/components/MediaCardGrid";
import { PageSection } from "./PageSection";

/**
 * AniList users' recommendations (best rated first), as the same cards as related anime. Collapsed by
 * default: they are only fetched once the section is opened (then stored with the other details).
 */
export const RecommendationsSection: React.FC<{
  details: MediaDetails | null;
  loading: boolean;
  listById: Map<number, AnimeEntry>;
}> = ({ details, loading, listById }) => {
  const fetched = details?.recommendations_fetched || (details?.recommendations.length ?? 0) > 0;
  const items = (details?.recommendations ?? [])
    .filter((r) => r.media.media_type === "ANIME")
    .map((r) => ({
      key: String(r.media.id),
      media: r.media,
      label: r.rating > 0 ? `Recommended by ${r.rating}` : "Recommended",
    }));
  return (
    <PageSection
      id="recommendations"
      title={
        <>
          <ThumbsUp className="w-4 h-4 text-accent" />
          Recommendations
        </>
      }
    >
      {items.length > 0 ? (
        <MediaCardGrid items={items} listById={listById} />
      ) : (
        <p className="text-xs text-text-muted">
          {!fetched && loading ? "Loading recommendations…" : fetched ? "No recommendations yet." : ""}
        </p>
      )}
    </PageSection>
  );
};
