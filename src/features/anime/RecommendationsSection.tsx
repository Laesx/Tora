import React from "react";
import { ThumbsUp } from "lucide-react";
import { AnimeEntry, MediaDetails } from "@/lib/types";
import { MediaCardGrid } from "@/components/MediaCardGrid";
import { PageSection } from "./PageSection";

/** AniList users' recommendations (best rated first), as the same cards as related anime. */
export const RecommendationsSection: React.FC<{ details: MediaDetails; listById: Map<number, AnimeEntry> }> = ({
  details,
  listById,
}) => {
  const items = details.recommendations
    .filter((r) => r.media.media_type === "ANIME")
    .map((r) => ({
      key: String(r.media.id),
      media: r.media,
      label: r.rating > 0 ? `Recommended by ${r.rating}` : "Recommended",
    }));
  if (items.length === 0) return null;
  return (
    <PageSection
      title={
        <>
          <ThumbsUp className="w-4 h-4 text-accent" />
          Recommendations
        </>
      }
    >
      <MediaCardGrid items={items} listById={listById} />
    </PageSection>
  );
};
