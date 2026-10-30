import { createContext, useContext } from "react";
import { DEFAULT_SCORE_FORMAT, ScoreFormat } from "@/lib/scores";

// The list owner's AniList score format (from the last pull); App provides it.
export const ScoreFormatContext = createContext<ScoreFormat>(DEFAULT_SCORE_FORMAT);

export const useScoreFormat = () => useContext(ScoreFormatContext);
