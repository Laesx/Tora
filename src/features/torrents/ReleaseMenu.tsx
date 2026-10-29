import React from "react";
import {
  ArrowUpToLine,
  Ban,
  Copy,
  Download,
  ExternalLink,
  Filter,
  Info,
  Magnet,
  Pin,
  PinOff,
  Plus,
  X,
} from "lucide-react";
import { AnimeReleaseCard, BoardRelease } from "@/lib/types";

export type ReleaseMenuAction =
  | { kind: "download" }
  | { kind: "copy-magnet" }
  | { kind: "copy-title" }
  | { kind: "open-page" }
  | { kind: "only-group"; group: string }
  | { kind: "add-group"; group: string }
  | { kind: "remove-group"; group: string }
  | { kind: "clear-override" }
  | { kind: "top-priority"; group: string }
  | { kind: "discard-group"; group: string }
  | { kind: "create-filter" }
  | { kind: "open-anime" };

interface ReleaseMenuProps {
  release: BoardRelease;
  card: AnimeReleaseCard;
  /** Index of this group's `group:` tier in the global priority (null = not a tier) */
  groupTierIndex: number | null;
  onAction: (action: ReleaseMenuAction) => void;
}

const itemClass =
  "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/90 disabled:opacity-40 disabled:pointer-events-none transition cursor-pointer";

const Divider = () => <div className="my-1 border-t border-border-subtle" />;

export const ReleaseMenu: React.FC<ReleaseMenuProps> = ({ release, card, groupTierIndex, onAction }) => {
  const group = release.group;
  const override = card.fansub_override;
  const inOverride = !!group && !!override?.some((g) => g.toLowerCase() === group.toLowerCase());
  const item = (action: ReleaseMenuAction, Icon: React.ElementType, label: React.ReactNode, iconClass = "", disabled = false) => (
    <button className={itemClass} disabled={disabled} onClick={() => onAction(action)}>
      <Icon className={`w-3.5 h-3.5 shrink-0 ${iconClass}`} />
      <span className="truncate">{label}</span>
    </button>
  );
  const g = (text: string) => <span className="font-semibold text-text-primary">[{text}]</span>;

  return (
    <div
      className="w-72 rounded-xl bg-bg-secondary/95 backdrop-blur-md border border-border-subtle shadow-2xl py-1.5 text-xs select-none max-h-[calc(100vh-24px)] overflow-y-auto"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="px-3 pb-1.5 text-[10px] text-text-muted truncate" title={release.title}>
        {release.title}
      </div>
      {item({ kind: "download" }, Download, "Download now", "text-accent")}
      {item({ kind: "copy-magnet" }, Magnet, "Copy magnet link", "", !release.magnet_url)}
      {item({ kind: "copy-title" }, Copy, "Copy release name")}
      {item({ kind: "open-page" }, ExternalLink, "Open release page", "", !release.view_url)}

      {group && card.anime_id != null && (
        <>
          <Divider />
          {item({ kind: "only-group", group }, Pin, <>Use only {g(group)} for this anime</>, "text-accent")}
          {override && !inOverride && item({ kind: "add-group", group }, Plus, <>Add {g(group)} as a fallback</>)}
          {inOverride && item({ kind: "remove-group", group }, X, <>Remove {g(group)} from this anime</>)}
          {override && item({ kind: "clear-override" }, PinOff, "Clear this anime's fansub override")}
        </>
      )}

      {group && (
        <>
          <Divider />
          {item(
            { kind: "top-priority", group },
            ArrowUpToLine,
            groupTierIndex === 0 ? <>{g(group)} is the top priority</> : <>Make {g(group)} the top priority</>,
            "",
            groupTierIndex === 0
          )}
          {item({ kind: "discard-group", group }, Ban, <>Hide {g(group)} everywhere</>, "text-red-400")}
        </>
      )}

      <Divider />
      {item({ kind: "create-filter" }, Filter, "Create filter from this release…")}
      {card.anime_id != null && item({ kind: "open-anime" }, Info, "Open anime details")}
    </div>
  );
};
