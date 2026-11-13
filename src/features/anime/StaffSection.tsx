import React, { useState } from "react";
import { ChevronUp, ExternalLink, Clapperboard } from "lucide-react";
import { AnimeEntry, MediaDetails } from "@/lib/types";
import { anilistAnimeUrl, openExternal } from "@/lib/anime";
import { useToast } from "@/contexts/toast";
import { PageSection } from "./PageSection";

const PREVIEW_COUNT = 9;

/** Staff and their roles: a few, "Show all" for the stored ones, AniList for the rest. */
export const StaffSection: React.FC<{ anime: AnimeEntry; details: MediaDetails }> = ({ anime, details }) => {
  const showToast = useToast();
  const [expanded, setExpanded] = useState(false);
  const staff = details.staff;
  if (staff.length === 0) return null;
  const shown = expanded ? staff : staff.slice(0, PREVIEW_COUNT);

  return (
    <PageSection
      title={
        <>
          <Clapperboard className="w-4 h-4 text-accent" />
          Staff
        </>
      }
    >
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
        {shown.map((s, i) => (
          <button
            key={`${s.id}-${i}`}
            type="button"
            onClick={() => openExternal(`https://anilist.co/staff/${s.id}`, showToast)}
            title={s.name_native ? `${s.name} (${s.name_native})` : s.name}
            className="flex items-center gap-2 p-1.5 h-14 rounded-xl border border-border-subtle bg-bg-primary/60 hover:border-accent/60 text-left transition overflow-hidden group"
          >
            <div className="w-9 h-full shrink-0 rounded-md overflow-hidden bg-bg-tertiary">
              {s.image && <img src={s.image} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />}
            </div>
            <span className="min-w-0 flex flex-col">
              <span className="text-xs font-semibold text-text-primary truncate group-hover:text-accent">{s.name}</span>
              <span className="text-[10px] text-text-muted truncate">{s.role}</span>
            </span>
          </button>
        ))}
      </div>
      {(staff.length > PREVIEW_COUNT || details.staff_has_more) && (
        <div className="flex items-center justify-end gap-4">
          {expanded && details.staff_has_more && (
            <button
              onClick={() => openExternal(`${anilistAnimeUrl(anime)}/staff`, showToast)}
              className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary hover:text-accent"
            >
              <ExternalLink className="w-3 h-3" />
              More on AniList
            </button>
          )}
          {staff.length > PREVIEW_COUNT && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
            >
              {expanded ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Show fewer
                </>
              ) : (
                "Show all"
              )}
            </button>
          )}
        </div>
      )}
    </PageSection>
  );
};
