import React from "react";
import { AnimeEntry } from "../types";
import { formatCountdown } from "../api";
import { formatFuzzyDate } from "../nowPlaying";

type AiringFields = Pick<
  AnimeEntry,
  "airing_status" | "next_airing_episode" | "next_airing_at" | "start_date"
>;

function airingLabel(anime: AiringFields): string {
  if (anime.airing_status === "RELEASING") {
    const cd = formatCountdown(anime.next_airing_at);
    return anime.next_airing_episode && cd && cd !== "Airing now"
      ? `Airing · Ep ${anime.next_airing_episode} in ${cd}`
      : "Airing";
  }
  const start = formatFuzzyDate(anime.start_date);
  return start ? `Not yet aired · starts ${start}` : "Not yet aired";
}

/**
 * Marks an anime that is currently airing (filled dot) or not aired yet (hollow ring).
 * `onCover` adds a dark ring so it reads on top of cover art.
 */
export const AiringDot: React.FC<{
  anime: AiringFields;
  size?: "sm" | "md";
  onCover?: boolean;
  className?: string;
}> = ({ anime, size = "md", onCover = false, className = "" }) => {
  const airing = anime.airing_status === "RELEASING";
  if (!airing && anime.airing_status !== "NOT_YET_RELEASED") return null;
  const label = airingLabel(anime);
  const dim = size === "sm" ? "w-2 h-2" : "w-2.5 h-2.5";
  const fill = airing
    ? "bg-emerald-400"
    : `border-[1.5px] border-emerald-400 ${onCover ? "bg-black/60" : "bg-transparent"}`;
  return (
    <span
      title={label}
      aria-label={label}
      className={`block rounded-full shrink-0 ${dim} ${fill} ${onCover ? "ring-2 ring-black/60" : ""} ${className}`}
    />
  );
};
