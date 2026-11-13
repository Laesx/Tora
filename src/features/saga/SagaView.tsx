import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronUp,
  Crosshair,
  Info,
  Loader2,
  Maximize2,
  Minus,
  Network,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { AnimeEntry, SagaEdge, SagaLinkKind } from "@/lib/types";
import { formatEnum } from "@/lib/anime";
import { useAnimeTitle } from "@/contexts/titles";
import { usePrefs } from "@/hooks/usePrefs";
import { MediaCard } from "@/components/MediaCard";
import { SourceLinks, relationLabel } from "@/features/detail/RelationsPanel";
import { useSagaData } from "./useSagaData";
import { LayoutPath, MORE_TILE_H, SagaOrder, edgeKey, layoutSaga } from "./layout";

interface SagaPrefs {
  order: SagaOrder;
  /** AniList formats not shown (the anime it was opened from always is) */
  hiddenFormats: string[];
}
const DEFAULT_PREFS: SagaPrefs = { order: "story", hiddenFormats: [] };

const MIN_SCALE = 0.2;
const MAX_SCALE = 2;
/** Below this the board opens at 100% on the anime instead of fitting the window */
const FIT_THRESHOLD = 0.75;

/** What the other side of a link is, read from the side that didn't name it */
const INVERSE: Record<string, string> = {
  PREQUEL: "SEQUEL",
  SEQUEL: "PREQUEL",
  PARENT: "SIDE_STORY",
  SIDE_STORY: "PARENT",
  COMPILATION: "CONTAINS",
  CONTAINS: "COMPILATION",
  ALTERNATIVE: "ALTERNATIVE",
  CHARACTER: "CHARACTER",
  OTHER: "OTHER",
};
const KIND_LABEL: Record<SagaLinkKind, string> = {
  chain: "Prequel / sequel",
  parent: "Parent / side story",
  summary: "Summary / compilation",
  weak: "Spin-off / other",
  alternative: "Alternative version",
};

/** What the other anime is to `self` ("SEQUEL"), whichever side named the link */
function relationType(edge: SagaEdge, self: number): string | null {
  const said = self === edge.a ? edge.a_says : edge.b_says;
  if (said) return said;
  const back = self === edge.a ? edge.b_says : edge.a_says;
  return back ? INVERSE[back] ?? null : null;
}

/** What the other anime is to `self`, in words ("Sequel") */
function relationOf(edge: SagaEdge, self: number): string {
  const type = relationType(edge, self);
  return type ? relationLabel(type) : KIND_LABEL[edge.kind];
}

/** A line's heading: how its anime relates to the earlier line's ("Alternative version of") */
const LINE_HEADING: Record<string, string> = {
  ALTERNATIVE: "Alternative version of",
  SIDE_STORY: "Side story of",
  SPIN_OFF: "Spin-off of",
  SUMMARY: "Summary of",
  COMPILATION: "Compilation of",
  CONTAINS: "Part of",
  PARENT: "Parent story of",
  PREQUEL: "Prequel of",
  SEQUEL: "Sequel of",
  CHARACTER: "Shares characters with",
};

/** Stroke of each line kind (colors from the theme) */
function strokeOf(kind: LayoutPath["kind"]): { color: string; width: number; dash?: string } {
  switch (kind) {
    case "chain":
      return { color: "rgb(var(--accent-primary))", width: 2 };
    case "parent":
      return { color: "rgb(var(--text-secondary))", width: 1.5 };
    case "summary":
      return { color: "rgb(var(--text-secondary))", width: 1.5, dash: "6 4" };
    case "weak":
      return { color: "rgb(var(--text-muted))", width: 1.5, dash: "2 4" };
    case "alternative":
      return { color: "rgb(var(--text-secondary))", width: 1.5, dash: "10 3 2 3" };
    default:
      return { color: "rgb(var(--text-muted))", width: 2, dash: "1 6" };
  }
}

interface View {
  x: number;
  y: number;
  scale: number;
}

/**
 * An anime's franchise as a board: anime in story order (prequel → sequel, side stories under the anime
 * they hang off) or release order, in snake rows that fill the window. Your list status on every card;
 * the anime it was opened from is ringed and centered. A sheet over the main area like the anime page.
 */
export const SagaView: React.FC<{
  root: AnimeEntry;
  listById: Map<number, AnimeEntry>;
  /** Where Back goes ("Bakemonogatari"), null when there is no history */
  backLabel: string | null;
  onBack: () => void;
  onClose: () => void;
}> = ({ root, listById, backLabel, onBack, onClose }) => {
  const rootId = root.anilist_id ?? root.id;
  const titleOf = useAnimeTitle();
  const { graph, loading, error, refresh, expand, loadMore } = useSagaData(rootId);
  const [prefs, setPrefs] = usePrefs<SagaPrefs>("tora.saga.prefs", DEFAULT_PREFS);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hovered, setHovered] = useState<number | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);

  const nodes = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.media.id, n])), [graph]);
  const hidden = useMemo(() => new Set(prefs.hiddenFormats), [prefs.hiddenFormats]);
  const formats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph?.nodes ?? []) {
      const f = n.media.format ?? "UNKNOWN";
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [graph]);

  // Viewport size → layout (the board's shape follows the window's)
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () =>
      graph
        ? layoutSaga({
          graph,
          order: prefs.order,
          isVisible: (n) => !hidden.has(n.media.format ?? "UNKNOWN"),
          aspect: size.w / Math.max(1, size.h),
          expanded,
        })
        : null,
    [graph, prefs.order, hidden, size.w, size.h, expanded]
  );

  // Pan / zoom
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitView = (): View | null => {
    if (!layout) return null;
    const scale = Math.max(MIN_SCALE, Math.min(1, size.w / layout.width, size.h / layout.height));
    return {
      scale,
      x: (size.w - layout.width * scale) / 2,
      y: Math.max(0, (size.h - layout.height * scale) / 2),
    };
  };
  const centerOn = (id: number, scale = 1): View | null => {
    const card = layout?.cards.find((c) => c.id === id);
    if (!card) return fitView();
    return {
      scale,
      x: size.w / 2 - (card.x + card.w / 2) * scale,
      y: size.h / 2 - (card.y + card.h / 2) * scale,
    };
  };

  // Placed again when what's on the board or the window changes (not when a column expands)
  const placedFor = useRef("");
  const graphRoot = graph?.root;
  useEffect(() => {
    if (!layout || graphRoot === undefined) return;
    const key = [graphRoot, graph?.nodes.length, prefs.order, prefs.hiddenFormats.join(), size.w, size.h].join("|");
    if (placedFor.current === key) return;
    placedFor.current = key;
    const fit = fitView();
    const next = fit && fit.scale >= FIT_THRESHOLD ? fit : centerOn(graphRoot);
    if (next) setView(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, graphRoot]);

  const zoomAt = (factor: number, cx = size.w / 2, cy = size.h / 2) =>
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  // The wheel zooms at the pointer; Shift+wheel (or a sideways trackpad swipe) pans sideways
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const sideways = e.shiftKey ? e.deltaY || e.deltaX : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      if (sideways) {
        setView((v) => ({ ...v, x: v.x - sideways }));
        return;
      }
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);

  // Dragging the background pans
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-saga-card], button")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  // Hover: the card's links stand out, the rest fades
  const linkedTo = useMemo(() => {
    const m = new Map<number, SagaEdge[]>();
    for (const e of graph?.edges ?? []) {
      m.set(e.a, [...(m.get(e.a) ?? []), e]);
      m.set(e.b, [...(m.get(e.b) ?? []), e]);
    }
    return m;
  }, [graph]);
  const related = useMemo(() => {
    if (hovered === null) return null;
    const ids = new Set([hovered]);
    for (const e of linkedTo.get(hovered) ?? []) ids.add(e.a === hovered ? e.b : e.a);
    return ids;
  }, [hovered, linkedTo]);
  const edges = useMemo(() => new Map((graph?.edges ?? []).map((e) => [edgeKey(e.a, e.b), e])), [graph]);

  const toggleFormat = (format: string) =>
    setPrefs({
      hiddenFormats: hidden.has(format) ? prefs.hiddenFormats.filter((f) => f !== format) : [...prefs.hiddenFormats, format],
    });
  const toggleColumn = (head: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });

  const titleNode = graph ? nodes.get(graph.title_id) : undefined;
  const onList = graph?.nodes.filter((n) => listById.has(n.media.id)) ?? [];
  const completed = onList.filter((n) => listById.get(n.media.id)?.user_status === "COMPLETED").length;
  const hoveredNode = hovered !== null ? nodes.get(hovered) : undefined;

  return (
    <div
      role="dialog"
      aria-label={`Saga of ${titleOf(root)}`}
      className="absolute inset-0 z-30 flex flex-col bg-bg-primary shadow-[0_-8px_32px_rgba(0,0,0,0.35)] animate-sheet-in"
    >
      {/* Toolbar */}
      <div className="shrink-0 border-b border-border-subtle bg-bg-secondary/80 px-4 py-2.5 space-y-2">
        <div className="flex items-center gap-3 min-w-0">
          {backLabel && (
            <button
              onClick={onBack}
              title={`Back to ${backLabel} (Alt+←)`}
              className="shrink-0 flex items-center gap-1 pl-1.5 pr-3 py-1 rounded-full bg-bg-tertiary text-text-secondary text-xs font-medium hover:text-text-primary transition max-w-[220px]"
            >
              <ChevronLeft className="w-4 h-4 shrink-0" />
              <span className="truncate">{backLabel}</span>
            </button>
          )}
          <Network className="w-5 h-5 text-accent shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-text-primary truncate">
              {titleNode ? titleOf(titleNode.media) : titleOf(root)}
              <span className="font-normal text-text-muted"> · Saga</span>
            </h2>
            {graph && (
              <p className="text-[11px] text-text-muted truncate">
                {graph.nodes.length} anime · {onList.length} on your list · {completed} completed
              </p>
            )}
          </div>
          {graph && graph.sources.length > 0 && (
            <div className="hidden xl:flex items-center gap-2 text-[11px] text-text-muted min-w-0 max-w-[320px]">
              <span className="shrink-0">Based on</span>
              <SourceLinks sources={graph.sources.slice(0, 2)} />
            </div>
          )}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <div className="flex rounded-lg bg-bg-tertiary p-0.5 text-xs font-medium">
              {(["story", "release"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => setPrefs({ order: o })}
                  title={o === "story" ? "Prequel → sequel, side stories under their anime" : "The same lines by air date, side stories still under their anime"}
                  className={`px-2.5 py-1 rounded-md transition ${
                    prefs.order === o ? "bg-bg-primary text-text-primary shadow" : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  {o === "story" ? "Story order" : "Release order"}
                </button>
              ))}
            </div>
            <ToolButton title="Refresh from AniList" onClick={refresh} disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </ToolButton>
            <ToolButton title="Close (Esc)" onClick={onClose}>
              <X className="w-4 h-4" />
            </ToolButton>
          </div>
        </div>
        {formats.length > 1 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {formats.map(([format, count]) => {
              const off = hidden.has(format);
              return (
                <button
                  key={format}
                  onClick={() => toggleFormat(format)}
                  title={off ? `Show ${formatEnum(format)}` : `Hide ${formatEnum(format)}`}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-medium border transition ${
                    off
                      ? "border-border-subtle text-text-muted line-through opacity-60 hover:opacity-100"
                      : "border-accent/40 bg-accent-soft text-accent hover:border-accent"
                  }`}
                >
                  {format === "UNKNOWN" ? "Unknown" : formatEnum(format)} <span className="opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Board */}
      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`relative flex-1 overflow-hidden select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{
          backgroundImage: "radial-gradient(rgb(var(--border-subtle)) 1px, transparent 1px)",
          backgroundSize: `${22 * view.scale}px ${22 * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        {layout && graph && (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <svg width={layout.width} height={layout.height} className="absolute inset-0 overflow-visible pointer-events-none">
              <defs>
                <marker id="saga-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,1 L9,5 L0,9 z" fill="rgb(var(--accent-primary))" />
                </marker>
                <marker id="saga-arrow-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,1 L9,5 L0,9 z" fill="rgb(var(--text-muted))" />
                </marker>
              </defs>
              {layout.paths.map((p, i) => {
                const s = strokeOf(p.kind);
                const touches = related !== null && related.has(p.ids[0]) && related.has(p.ids[1]) && p.ids.includes(hovered!);
                const base = p.role === "link" ? 0.4 : 1;
                const opacity = related === null ? base : touches ? 1 : 0.1;
                return (
                  <path
                    key={i}
                    d={p.d}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={touches ? s.width + 1 : s.width}
                    strokeDasharray={s.dash}
                    strokeLinecap="round"
                    opacity={opacity}
                    markerEnd={p.arrow ? `url(#${p.kind === "chain" ? "saga-arrow" : "saga-arrow-muted"})` : undefined}
                    style={{ transition: "opacity 120ms" }}
                  />
                );
              })}
            </svg>

            {layout.blocks
              .filter((b) => b.index > 0)
              .map((b) => {
                const link = graph.lines[b.index]?.link;
                const edge = link ? edges.get(edgeKey(link.from, link.to)) : undefined;
                const to = link ? nodes.get(link.to) : undefined;
                const type = link && edge ? relationType(edge, link.to) : null;
                return (
                  <div
                    key={b.index}
                    className="absolute left-12 right-12 truncate text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                    style={{ top: b.y }}
                  >
                    {to ? `${(type && LINE_HEADING[type]) ?? "Linked to"} ${titleOf(to.media)}` : "Also in this saga"}
                  </div>
                );
              })}

            {layout.years.map((y, i) => (
              <div key={i} className="absolute text-[11px] font-bold text-text-muted" style={{ left: y.x + 2, top: y.y }}>
                {y.year}
              </div>
            ))}

            {layout.cards.map((c) => {
              const node = nodes.get(c.id);
              if (!node) return null;
              const isRoot = c.id === graph.root;
              const edge = c.satellite ? edges.get(edgeKey(c.head, c.id)) : undefined;
              const label = c.satellite ? (edge ? relationOf(edge, c.head) : "Related") : undefined;
              const dim = related !== null && !related.has(c.id);
              return (
                <div
                  key={c.id}
                  data-saga-card
                  className={`absolute rounded-xl transition-opacity ${isRoot ? "ring-2 ring-accent ring-offset-2 ring-offset-bg-primary" : ""}`}
                  style={{ left: c.x, top: c.y, width: c.w, height: c.h, opacity: dim ? 0.3 : 1 }}
                  onMouseEnter={() => setHovered(c.id)}
                  onMouseLeave={() => setHovered((h) => (h === c.id ? null : h))}
                >
                  <MediaCard
                    media={node.media}
                    entry={listById.get(c.id)}
                    label={label}
                    undimmed={isRoot}
                    className="w-full h-full bg-bg-secondary"
                  />
                  {c.badge !== undefined && (
                    <span
                      title={prefs.order === "story" ? `Number ${c.badge} of this line in story order` : `Number ${c.badge} of this line by release date`}
                      className="absolute -top-2 -left-2 min-w-[20px] h-5 px-1 rounded-full bg-accent text-white text-[10px] font-bold flex items-center justify-center shadow"
                    >
                      {c.badge}
                    </span>
                  )}
                  {isRoot && (
                    <span className="absolute -top-2.5 right-3 px-1.5 py-px rounded-full bg-accent text-white text-[9px] font-bold uppercase tracking-wider shadow">
                      You are here
                    </span>
                  )}
                  {!node.walked && (
                    <button
                      type="button"
                      onClick={() => expand(c.id)}
                      title="Also show what this anime links to"
                      className="absolute -bottom-2 right-3 flex items-center gap-0.5 px-1.5 py-px rounded-full border border-border-subtle bg-bg-tertiary text-[10px] font-semibold text-text-secondary hover:border-accent hover:text-accent transition"
                    >
                      <Plus className="w-3 h-3" />
                      Links
                    </button>
                  )}
                </div>
              );
            })}

            {layout.more.map((m) => (
              <button
                key={m.head}
                type="button"
                onClick={() => toggleColumn(m.head)}
                className="absolute flex items-center justify-center gap-1 rounded-lg border border-dashed border-border-subtle text-[11px] font-semibold text-text-secondary hover:border-accent hover:text-accent transition"
                style={{ left: m.x, top: m.y, width: m.w, height: MORE_TILE_H }}
              >
                {m.expanded ? (
                  <>
                    <ChevronUp className="w-3.5 h-3.5" />
                    Show fewer
                  </>
                ) : (
                  `+${m.count} more`
                )}
              </button>
            ))}
          </div>
        )}

        {!graph && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-text-muted">
            {loading ? (
              <>
                <Loader2 className="w-6 h-6 animate-spin text-accent" />
                Building the saga…
              </>
            ) : (
              <>
                <AlertTriangle className="w-6 h-6 text-amber-400" />
                <span>{error ?? "The saga could not be loaded."}</span>
                <button onClick={refresh} className="text-xs font-semibold text-accent hover:underline">
                  Try again
                </button>
              </>
            )}
          </div>
        )}

        {/* Notices */}
        {graph && (graph.error || graph.more || graph.unwalked > 0 || error) && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-bg-secondary border border-border-subtle shadow text-[11px] text-text-secondary">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            {graph.error || error ? (
              <>
                AniList couldn't be reached: showing what's stored.
                <button onClick={refresh} className="font-semibold text-accent hover:underline">
                  Retry
                </button>
              </>
            ) : graph.more ? (
              <>
                Part of this saga isn't loaded yet.
                <button onClick={loadMore} disabled={loading} className="font-semibold text-accent hover:underline disabled:opacity-50">
                  Load more
                </button>
              </>
            ) : (
              <>This saga is large: {graph.unwalked} more linked anime left unexplored.</>
            )}
          </div>
        )}

        {/* Hovered anime: its links in words */}
        {hoveredNode && (
          <div className="absolute bottom-3 left-3 max-w-[340px] rounded-xl bg-bg-secondary/95 border border-border-subtle shadow-lg px-3 py-2 pointer-events-none">
            <p className="text-xs font-semibold text-text-primary truncate">{titleOf(hoveredNode.media)}</p>
            <ul className="mt-1 space-y-0.5">
              {(linkedTo.get(hoveredNode.media.id) ?? []).slice(0, 8).map((e) => {
                const other = nodes.get(e.a === hoveredNode.media.id ? e.b : e.a);
                return (
                  other && (
                    <li key={edgeKey(e.a, e.b)} className="text-[11px] text-text-muted truncate">
                      <span className="text-text-secondary">{relationOf(e, hoveredNode.media.id)}:</span> {titleOf(other.media)}
                    </li>
                  )
                );
              })}
            </ul>
          </div>
        )}

        {/* Zoom, legend */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl bg-bg-secondary/95 border border-border-subtle shadow p-1">
          <ToolButton title="Zoom out (wheel)" onClick={() => zoomAt(1 / 1.2)}>
            <Minus className="w-4 h-4" />
          </ToolButton>
          <span className="w-10 text-center text-[11px] tabular-nums text-text-muted">{Math.round(view.scale * 100)}%</span>
          <ToolButton title="Zoom in (wheel)" onClick={() => zoomAt(1.2)}>
            <Plus className="w-4 h-4" />
          </ToolButton>
          <ToolButton title="Fit to window" onClick={() => setView((v) => fitView() ?? v)}>
            <Maximize2 className="w-4 h-4" />
          </ToolButton>
          {graph && (
            <ToolButton title={`Center on ${titleOf(root)}`} onClick={() => setView((v) => centerOn(graph.root, v.scale) ?? v)}>
              <Crosshair className="w-4 h-4" />
            </ToolButton>
          )}
          <div className="relative">
            <ToolButton title="Legend" onClick={() => setLegendOpen((o) => !o)} active={legendOpen}>
              <Info className="w-4 h-4" />
            </ToolButton>
            {legendOpen && <Legend />}
          </div>
        </div>
      </div>
    </div>
  );
};

const ToolButton: React.FC<{
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, active, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={`p-1.5 rounded-lg transition disabled:opacity-50 ${
      active ? "bg-accent-soft text-accent" : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
    }`}
  >
    {children}
  </button>
);

const LEGEND: { kind: LayoutPath["kind"]; label: string }[] = [
  { kind: "chain", label: "Prequel → sequel" },
  { kind: "parent", label: "Parent story / side story" },
  { kind: "summary", label: "Summary / compilation" },
  { kind: "alternative", label: "Alternative version" },
  { kind: "weak", label: "Spin-off, other, same characters" },
  { kind: "then", label: "Next in order (no direct link)" },
];

const Legend: React.FC = () => (
  <div className="absolute bottom-full right-0 mb-2 w-64 rounded-xl bg-bg-secondary border border-border-subtle shadow-lg p-3 space-y-1.5">
    {LEGEND.map(({ kind, label }) => {
      const s = strokeOf(kind);
      return (
        <div key={kind} className="flex items-center gap-2 text-[11px] text-text-secondary">
          <svg width="36" height="8" className="shrink-0">
            <line x1="2" y1="4" x2="34" y2="4" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} strokeLinecap="round" />
          </svg>
          {label}
        </div>
      );
    })}
    <p className="pt-1 text-[10px] text-text-muted leading-snug">
      Anime with a “Links” button are only linked loosely (shared characters, other links, a spin-off’s own
      side branches): it shows what they link to.
      Each prequel / sequel chain is a line; alternative versions and other series get lines of their own
      below the main one. Drag to move, wheel to zoom, Shift+wheel to move sideways.
    </p>
  </div>
);

