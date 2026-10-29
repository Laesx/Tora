import React, { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, HardDrive, Pin, ShieldCheck } from "lucide-react";
import { AnimeEntry, AnimeReleaseCard, BoardRelease } from "../../types";
import { getOptimizedCoverUrl } from "../../api";
import { useAnimeTitle } from "../../titles";
import { STATUS_OPTIONS } from "../AnimeQuickMenu";
import { AiringDot } from "../AiringDot";
import { ageLabel, episodeLabel, tierLabel } from "../../torrents";

interface ReleaseCardProps {
  card: AnimeReleaseCard;
  entry?: AnimeEntry;
  tierLabels: string[];
  showDiscarded: boolean;
  isChecked: (r: BoardRelease) => boolean;
  onToggle: (keys: string[], checked: boolean) => void;
  onContextMenu: (e: React.MouseEvent, release: BoardRelease, card: AnimeReleaseCard) => void;
  onOpenAnime: (anime: AnimeEntry) => void;
}

const CODEC_LABEL: Record<string, string> = { hevc: "HEVC", avc: "AVC", av1: "AV1" };
const SOURCE_LABEL: Record<string, string> = { web: "WEB", bd: "BD", dvd: "DVD", tv: "TV" };

const Badge: React.FC<{ className: string; children: React.ReactNode; title?: string }> = ({
  className,
  children,
  title,
}) => (
  <span title={title} className={`px-1.5 py-0.5 rounded font-mono text-[10px] leading-none whitespace-nowrap ${className}`}>
    {children}
  </span>
);

function stateChip(r: BoardRelease, card: AnimeReleaseCard) {
  if (r.discarded_by) return <Badge className="bg-red-500/15 text-red-300" title={`Hidden by filter "${r.discarded_by}"`}>Hidden</Badge>;
  if (r.sent) return <Badge className="bg-sky-500/15 text-sky-300">Sent</Badge>;
  if (r.on_disk) return <Badge className="bg-emerald-500/15 text-emerald-300">On disk</Badge>;
  if (r.watched) return <Badge className="bg-bg-tertiary text-text-muted">Watched</Badge>;
  if (card.anime_id != null && r.episode != null) return <Badge className="bg-accent/20 text-accent">New</Badge>;
  return null;
}

const ReleaseRow: React.FC<{
  r: BoardRelease;
  card: AnimeReleaseCard;
  tierLabels: string[];
  checked: boolean;
  onToggle: (checked: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}> = ({ r, card, tierLabels, checked, onToggle, onContextMenu }) => {
  const t = r.traits;
  const tierName =
    r.tier == null
      ? null
      : card.fansub_override
        ? card.fansub_override[r.tier]
        : tierLabel(tierLabels[r.tier] ?? "");
  return (
    <div
      onClick={() => onToggle(!checked)}
      onContextMenu={onContextMenu}
      title={r.title}
      className={`grid grid-cols-[18px_58px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2 text-xs cursor-pointer select-none transition ${checked ? "bg-accent/10 hover:bg-accent/15" : "hover:bg-bg-tertiary/50"
        } ${r.discarded_by ? "opacity-50" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        onClick={(e) => e.stopPropagation()}
        className="rounded accent-accent cursor-pointer"
      />
      <span className="font-mono font-bold text-[11px] text-text-primary whitespace-nowrap">{episodeLabel(t)}</span>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1">
          {r.group && (
            <Badge
              className={tierName ? "bg-accent/15 text-accent font-semibold" : "bg-bg-tertiary border border-border-subtle text-text-secondary"}
              title={tierName ? `Priority: ${tierName}` : undefined}
            >
              {r.group}
            </Badge>
          )}
          {t.resolution && <Badge className="bg-emerald-500/15 text-emerald-400">{t.resolution}p</Badge>}
          {t.codec && <Badge className={t.codec === "av1" ? "bg-fuchsia-500/15 text-fuchsia-300" : "bg-blue-500/15 text-blue-400"}>{CODEC_LABEL[t.codec]}</Badge>}
          {t.bit_depth === 10 && <Badge className="bg-blue-500/10 text-blue-300">10bit</Badge>}
          {t.dual_audio && <Badge className="bg-amber-500/15 text-amber-300">Dual Audio</Badge>}
          {t.audio.filter((a) => a !== "aac").map((a) => (
            <Badge key={a} className="bg-bg-tertiary text-text-secondary">{a.toUpperCase()}</Badge>
          ))}
          {t.source && <Badge className="bg-bg-tertiary text-text-secondary">{SOURCE_LABEL[t.source]}</Badge>}
          {t.batch && <Badge className="bg-violet-500/15 text-violet-300">Batch</Badge>}
          {r.trusted && (
            <span className="text-purple-300" title="Trusted uploader">
              <ShieldCheck className="w-3 h-3" />
            </span>
          )}
          {r.remake && <Badge className="bg-red-500/10 text-red-300">Remake</Badge>}
          {r.selected_by && <Badge className="bg-emerald-500/15 text-emerald-300" title="Selected by filter">{r.selected_by}</Badge>}
        </div>
        <div className="truncate text-[11px] text-text-muted">{r.title}</div>
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px] shrink-0">
        <span className="text-text-secondary w-[72px] text-right">{r.size_label}</span>
        {r.peers_known ? (
          <>
            <span className="flex items-center text-emerald-400 w-10">
              <ArrowUp className="w-3 h-3" />
              {r.seeders}
            </span>
            <span className="flex items-center text-red-400 w-9">
              <ArrowDown className="w-3 h-3" />
              {r.leechers}
            </span>
          </>
        ) : (
          <span className="w-[88px] text-center text-text-muted" title="This feed doesn't report seeders / leechers">
            —
          </span>
        )}
        <span className="text-text-muted w-8 text-right">{ageLabel(r.pub_unix)}</span>
        <span className="w-14 flex justify-end">{stateChip(r, card)}</span>
      </div>
    </div>
  );
};

export const ReleaseCard: React.FC<ReleaseCardProps> = ({
  card,
  entry,
  tierLabels,
  showDiscarded,
  isChecked,
  onToggle,
  onContextMenu,
  onOpenAnime,
}) => {
  const titleOf = useAnimeTitle();
  const [showOthers, setShowOthers] = useState(false);
  const visible = card.releases.filter((r) => showDiscarded || !r.discarded_by);
  const primary = visible.filter((r) => !r.outside_tier);
  const others = visible.filter((r) => r.outside_tier);
  const checkedCount = visible.filter(isChecked).length;
  const status = STATUS_OPTIONS.find((s) => s.id === card.status);
  const cover = entry?.cover_image || card.cover;
  const progress = entry?.user_progress ?? card.progress;
  const total = entry?.episodes ?? card.episodes;
  const onDisk = entry?.available_episodes.length ?? card.on_disk_count;

  const renderRows = (rows: BoardRelease[]) =>
    rows.map((r) => (
      <ReleaseRow
        key={r.key}
        r={r}
        card={card}
        tierLabels={tierLabels}
        checked={isChecked(r)}
        onToggle={(c) => onToggle([r.key], c)}
        onContextMenu={(e) => onContextMenu(e, r, card)}
      />
    ));

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-border-subtle">
        {cover ? (
          <span className="relative shrink-0">
            <img
              src={getOptimizedCoverUrl(cover, "medium")}
              alt=""
              loading="lazy"
              className="w-9 h-12 rounded-md object-cover bg-bg-tertiary"
            />
            {entry && (
              <AiringDot anime={entry} size="sm" onCover className="absolute -top-0.5 -left-0.5" />
            )}
          </span>
        ) : (
          <div className="w-9 h-12 rounded-md bg-bg-tertiary shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          {entry ? (
            <button
              onClick={() => onOpenAnime(entry)}
              className="text-sm font-bold text-text-primary truncate hover:underline text-left max-w-full block"
            >
              {titleOf(entry)}
            </button>
          ) : (
            <div className="text-sm font-bold text-text-primary truncate">{card.title}</div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted mt-0.5">
            {status ? (
              <span className={`flex items-center gap-1 ${status.color}`}>
                <status.icon className="w-3 h-3" />
                {status.label}
              </span>
            ) : (
              <span>Not in your list</span>
            )}
            {card.anime_id != null && (
              <span className="font-mono">
                Ep {progress}/{total ?? "?"}
              </span>
            )}
            {onDisk > 0 && (
              <span className="flex items-center gap-1">
                <HardDrive className="w-3 h-3" />
                {onDisk} on disk
              </span>
            )}
            {card.fansub_override && (
              <span className="flex items-center gap-1 text-accent" title="Fansub override for this anime">
                <Pin className="w-3 h-3" />
                {card.fansub_override.join(" → ")}
              </span>
            )}
          </div>
        </div>
        {visible.length > 0 && (
          <label className="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={checkedCount > 0 && checkedCount === visible.length}
              ref={(el) => {
                if (el) el.indeterminate = checkedCount > 0 && checkedCount < visible.length;
              }}
              onChange={(e) => onToggle(visible.map((r) => r.key), e.target.checked)}
              className="rounded accent-accent"
            />
            {checkedCount > 0 ? `${checkedCount} selected` : `${visible.length} release${visible.length === 1 ? "" : "s"}`}
          </label>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="px-4 py-4 text-xs text-text-muted">No releases in this feed yet.</div>
      ) : (
        <div className="divide-y divide-border-subtle/60">
          {renderRows(primary)}
          {others.length > 0 && (
            <>
              <button
                onClick={() => setShowOthers((v) => !v)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-text-muted hover:text-text-primary hover:bg-bg-tertiary/40 transition"
              >
                {showOthers ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Other releases ({others.length})
              </button>
              {showOthers && renderRows(others)}
            </>
          )}
        </div>
      )}
    </div>
  );
};
