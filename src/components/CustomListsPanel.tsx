import React from "react";
import { Check, EyeOff, Minus } from "lucide-react";
import { listCoverage, useCustomLists } from "../customLists";

interface CustomListsPanelProps {
  animeIds: number[];
  // "menu": checkbox rows inside a quick menu; "chips": toggle chips in the details drawer
  variant: "menu" | "chips";
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

/** Membership toggles for the user's AniList custom lists (one entry or a selection). */
export const CustomListsPanel: React.FC<CustomListsPanelProps> = ({
  animeIds,
  variant,
  showToast,
}) => {
  const customLists = useCustomLists();
  const { names } = customLists;
  if (names.length === 0 || animeIds.length === 0) return null;

  const plural = animeIds.length > 1 ? `${animeIds.length} anime` : null;
  // Hiding only applies to entries that are in a custom list (AniList shows them nowhere else)
  const allInSomeList = animeIds.every((id) => (customLists.membership(id)?.lists.length ?? 0) > 0);
  const hiddenCount = animeIds.filter((id) => customLists.membership(id)?.hidden_from_status_lists).length;
  const allHidden = hiddenCount === animeIds.length;

  const run = (change: Parameters<typeof customLists.apply>[0], msg: string) => {
    customLists
      .apply(change)
      .then(() => {
        if (plural) showToast(msg, "success");
      })
      .catch((err) => showToast(`Couldn't update custom lists: ${String(err)}`, "error"));
  };

  const toggleList = (name: string) => {
    const enabled = listCoverage(customLists, animeIds, name) !== "all";
    run(
      { anime_ids: animeIds, toggles: [{ name, enabled }] },
      enabled ? `Added ${plural} to "${name}"` : `Removed ${plural} from "${name}"`
    );
  };

  const toggleHidden = () => {
    run(
      { anime_ids: animeIds, toggles: [], hidden_from_status_lists: !allHidden },
      !allHidden ? `Hid ${plural} from status lists` : `Showing ${plural} in status lists`
    );
  };

  if (variant === "chips") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {names.map((name) => {
            const on = listCoverage(customLists, animeIds, name) === "all";
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleList(name)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition flex items-center gap-1 ${on
                  ? "bg-accent/15 border-accent/60 text-text-primary"
                  : "bg-bg-primary border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent/40"
                  }`}
                title={on ? `Remove from "${name}"` : `Add to "${name}"`}
              >
                {on && <Check className="w-3 h-3 text-accent" />}
                {name}
              </button>
            );
          })}
        </div>
        {allInSomeList && (
          <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              checked={allHidden}
              onChange={toggleHidden}
              style={{ accentColor: "rgb(var(--accent-primary))" }}
            />
            Hide from status lists (only shown in its custom lists and All Anime)
          </label>
        )}
      </div>
    );
  }

  const rowClass =
    "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/90 transition cursor-pointer";
  return (
    <div className="mx-2 my-1 py-1 rounded-lg bg-bg-primary border border-border-subtle max-h-56 overflow-y-auto">
      {names.map((name) => {
        const coverage = listCoverage(customLists, animeIds, name);
        return (
          <button key={name} onClick={() => toggleList(name)} className={rowClass}>
            <span
              className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${coverage === "none" ? "border-border-subtle" : "border-accent bg-accent text-white"
                }`}
            >
              {coverage === "all" && <Check className="w-2.5 h-2.5" />}
              {coverage === "some" && <Minus className="w-2.5 h-2.5" />}
            </span>
            <span className="truncate">{name}</span>
          </button>
        );
      })}
      {allInSomeList && (
        <>
          <div className="border-t border-border-subtle my-1" />
          <button onClick={toggleHidden} className={rowClass}>
            <EyeOff className={`w-3.5 h-3.5 shrink-0 ${allHidden ? "text-accent" : "text-text-muted"}`} />
            <span className="truncate">
              {allHidden ? "Show in Status Lists" : "Hide from Status Lists"}
            </span>
          </button>
        </>
      )}
    </div>
  );
};
