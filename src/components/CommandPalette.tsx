import React, {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Search,
  Globe,
  CornerDownLeft,
  History,
  X,
  ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimeEntry } from "../types";
import { getOptimizedCoverUrl } from "../api";
import {
  AnimeSearchIndex,
  buildSearchIndex,
  matchRanges,
  search,
  searchAnime,
} from "../fuzzy";
import { STATUS_OPTIONS } from "./AnimeQuickMenu";
import { AnimeAction } from "../animeActions";
import { AiringDot } from "./AiringDot";
import { altTitles, useAnimeTitle, useTitleLanguage } from "../titles";

export interface PaletteCommand {
  id: string;
  label: string;
  /** Extra words the command is found by */
  keywords?: string[];
  icon: LucideIcon;
  /** Global keyboard shortcut, shown as a hint */
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Kept by the parent so it survives closing the palette */
  query: string;
  onQueryChange: (query: string) => void;
  animeList: AnimeEntry[];
  searchIndex: AnimeSearchIndex;
  commands: PaletteCommand[];
  /** Enter on an anime: show it in the watchlist (with the query) and open its details */
  onOpenAnime: (anime: AnimeEntry) => void;
  onSearchAniList: (query: string) => void;
  /** Actions for one anime, shown with Right arrow (or right-click) on an anime row */
  getAnimeActions: (anime: AnimeEntry) => AnimeAction[];
}

type PaletteTab = "anime" | "commands";

type PaletteItem =
  | { kind: "anilist"; key: string }
  | { kind: "anime"; key: string; anime: AnimeEntry; recent: boolean }
  | { kind: "command"; key: string; command: PaletteCommand; recent: boolean };

/** Open action menu: the anime, the submenus entered (action ids) and the highlight per level */
interface ActionMenuState {
  animeId: number;
  path: string[];
  index: number[];
}

/** First enabled action at or after `from` (wrapping), or `from` when all are disabled. */
function nextEnabled(actions: AnimeAction[], from: number, step: 1 | -1): number {
  const n = actions.length;
  for (let k = 0; k < n; k++) {
    const i = (((from + k * step) % n) + n) % n;
    if (!actions[i].disabled) return i;
  }
  return Math.max(0, Math.min(n - 1, from));
}

interface PaletteSection {
  title: string | null;
  items: PaletteItem[];
}

const ANIME_RESULT_LIMIT = 50;
const RECENT_ANIME_LIMIT = 10;
const IDLE_ANIME_LIMIT = 20;
const RECENT_COMMAND_LIMIT = 5;
const RECENT_ANIME_KEY = "tora.palette.recentAnime";
const RECENT_COMMANDS_KEY = "tora.palette.recentCommands";

// Per-device conveniences: storage may be unavailable, so every access is guarded
function readRecent<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pushRecent<T>(key: string, value: T, limit: number) {
  try {
    const next = [value, ...readRecent<T>(key).filter((v) => v !== value)].slice(0, limit);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Not remembered; nothing else depends on it
  }
}

const statusLabel = (status: string) =>
  STATUS_OPTIONS.find((o) => o.id === status)?.label ?? status;

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  query,
  onQueryChange,
  animeList,
  searchIndex,
  commands,
  onOpenAnime,
  onSearchAniList,
  getAnimeActions,
}) => {
  const titleOf = useAnimeTitle();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<PaletteTab>("anime");
  const [activeIndex, setActiveIndex] = useState(0);
  // Recent lists are read on open, so they reflect the latest choices
  const [recentAnimeIds, setRecentAnimeIds] = useState<number[]>([]);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  const [menu, setMenu] = useState<ActionMenuState | null>(null);
  // Action waiting for a second Enter (Delete)
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Not deferred: Enter must act on the results for exactly what was typed (search is ~2 ms)
  const trimmed = query.trim();

  // Each open: Anime tab, input focused with any previous text selected (type to replace it)
  useLayoutEffect(() => {
    if (!open) return;
    setTab("anime");
    setMenu(null);
    setConfirmId(null);
    setRecentAnimeIds(readRecent<number>(RECENT_ANIME_KEY));
    setRecentCommandIds(readRecent<string>(RECENT_COMMANDS_KEY));
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  const commandIndex = useMemo(
    () => buildSearchIndex(commands, (c) => [c.label], (c) => c.keywords ?? []),
    [commands]
  );

  const animeHits = useMemo(
    () => (trimmed ? searchAnime(searchIndex, trimmed) : []),
    [searchIndex, trimmed]
  );
  const commandHits = useMemo(
    () => (trimmed ? search(commandIndex, trimmed) : []),
    [commandIndex, trimmed]
  );

  const sections = useMemo((): PaletteSection[] => {
    if (tab === "anime") {
      if (trimmed) {
        return [
          { title: null, items: [{ kind: "anilist", key: "anilist" }] },
          {
            title: animeHits.length > 0 ? "Your list" : null,
            items: animeHits.slice(0, ANIME_RESULT_LIMIT).map(({ item }) => ({
              kind: "anime",
              key: `a-${item.id}`,
              anime: item,
              recent: false,
            })),
          },
        ];
      }
      const byId = new Map(animeList.map((a) => [a.id, a]));
      const recent = recentAnimeIds
        .map((id) => byId.get(id))
        .filter((a): a is AnimeEntry => Boolean(a))
        .slice(0, RECENT_ANIME_LIMIT);
      const recentSet = new Set(recent.map((a) => a.id));
      const updated = [...animeList]
        .filter((a) => !recentSet.has(a.id))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, Math.max(0, IDLE_ANIME_LIMIT - recent.length));
      return [
        {
          title: "Recent",
          items: recent.map((a) => ({ kind: "anime", key: `r-${a.id}`, anime: a, recent: true })),
        },
        {
          title: "Recently updated",
          items: updated.map((a) => ({ kind: "anime", key: `a-${a.id}`, anime: a, recent: false })),
        },
      ];
    }

    if (trimmed) {
      return [
        {
          title: null,
          items: commandHits.map(({ item }) => ({
            kind: "command",
            key: `c-${item.id}`,
            command: item,
            recent: false,
          })),
        },
      ];
    }
    const byId = new Map(commands.map((c) => [c.id, c]));
    const recent = recentCommandIds
      .map((id) => byId.get(id))
      .filter((c): c is PaletteCommand => Boolean(c))
      .slice(0, RECENT_COMMAND_LIMIT);
    const recentSet = new Set(recent.map((c) => c.id));
    return [
      {
        title: "Recent",
        items: recent.map((c) => ({ kind: "command", key: `r-${c.id}`, command: c, recent: true })),
      },
      {
        title: "All commands",
        items: commands
          .filter((c) => !recentSet.has(c.id))
          .map((c) => ({ kind: "command", key: `c-${c.id}`, command: c, recent: false })),
      },
    ];
  }, [tab, trimmed, animeHits, commandHits, animeList, commands, recentAnimeIds, recentCommandIds]);

  const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // New results: highlight the first one (the AniList row only when nothing in the list matches)
  useLayoutEffect(() => {
    setActiveIndex(tab === "anime" && trimmed && animeHits.length > 0 ? 1 : 0);
  }, [tab, trimmed, open]);

  const safeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));

  // Action menu levels, rebuilt from the latest entry so +1 / -1 hints stay current
  const menuAnime = menu ? animeList.find((a) => a.id === menu.animeId) : undefined;
  const menuLevels: AnimeAction[][] = [];
  if (menu && menuAnime) {
    let actions = getAnimeActions(menuAnime);
    menuLevels.push(actions);
    for (const id of menu.path) {
      const children = actions.find((a) => a.id === id)?.children;
      if (!children) break;
      actions = children;
      menuLevels.push(actions);
    }
  }
  const menuActions = menuLevels.length > 0 ? menuLevels[menuLevels.length - 1] : null;
  const menuIndex = menuActions
    ? Math.min(menu!.index[menuLevels.length - 1] ?? 0, Math.max(0, menuActions.length - 1))
    : 0;
  const menuTrail = menu
    ? menu.path
      .slice(0, menuLevels.length - 1)
      .map((id, level) => menuLevels[level].find((a) => a.id === id)?.label ?? id)
    : [];

  const listIndex = menuActions ? menuIndex : safeIndex;
  const listCount = menuActions ? menuActions.length : items.length;
  const listMode = menuActions ? `menu-${menuLevels.length}` : "results";

  // Keep the highlighted row fully visible with a margin around it. The first row scrolls all the
  // way up (its section heading stays visible) and the last one all the way down.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (listIndex === 0) {
      list.scrollTop = 0;
      return;
    }
    if (listIndex === listCount - 1) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    const row = list.querySelector<HTMLElement>(`[data-index="${listIndex}"]`);
    if (!row) return;
    const margin = 8;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top + margin) {
      list.scrollTop -= listRect.top + margin - rowRect.top;
    } else if (rowRect.bottom > listRect.bottom - margin) {
      list.scrollTop += rowRect.bottom - (listRect.bottom - margin);
    }
  }, [listIndex, listCount, listMode, items]);

  if (!open) return null;

  const activate = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.kind === "anilist") {
      const q = query.trim();
      if (!q) return;
      onClose();
      onSearchAniList(q);
    } else if (item.kind === "anime") {
      pushRecent(RECENT_ANIME_KEY, item.anime.id, RECENT_ANIME_LIMIT);
      onClose();
      onOpenAnime(item.anime);
    } else {
      pushRecent(RECENT_COMMANDS_KEY, item.command.id, RECENT_COMMAND_LIMIT);
      onClose();
      item.command.run();
    }
  };

  const openMenu = (anime: AnimeEntry) => {
    const root = getAnimeActions(anime);
    setConfirmId(null);
    setMenu({ animeId: anime.id, path: [], index: [nextEnabled(root, 0, 1)] });
  };

  const setMenuIndex = (i: number) => {
    setConfirmId(null);
    setMenu((m) => m && { ...m, index: [...m.index.slice(0, menuLevels.length - 1), i] });
  };

  const enterSubmenu = (action: AnimeAction) => {
    if (!action.children || action.disabled) return;
    const children = action.children;
    setConfirmId(null);
    setMenu((m) =>
      m && {
        ...m,
        path: [...m.path.slice(0, menuLevels.length - 1), action.id],
        index: [...m.index.slice(0, menuLevels.length), nextEnabled(children, 0, 1)],
      }
    );
  };

  // Left / Esc: up one level; from the top level back to the highlighted anime
  const leaveLevel = () => {
    setConfirmId(null);
    if (menuLevels.length <= 1) {
      setMenu(null);
      return;
    }
    setMenu((m) =>
      m && {
        ...m,
        path: m.path.slice(0, menuLevels.length - 2),
        index: m.index.slice(0, menuLevels.length - 1),
      }
    );
  };

  const runAction = (action: AnimeAction | undefined) => {
    if (!action || action.disabled || !menuAnime) return;
    if (action.children) {
      enterSubmenu(action);
      return;
    }
    if (action.confirm && confirmId !== action.id) {
      setConfirmId(action.id);
      return;
    }
    setConfirmId(null);
    pushRecent(RECENT_ANIME_KEY, menuAnime.id, RECENT_ANIME_LIMIT);
    if (!action.keepOpen) onClose();
    action.run?.();
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const actions = menuActions!;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        setMenuIndex(nextEnabled(actions, menuIndex + 1, 1));
        break;
      case "ArrowUp":
        setMenuIndex(nextEnabled(actions, menuIndex - 1, -1));
        break;
      case "Enter":
        runAction(actions[menuIndex]);
        break;
      case "ArrowRight":
        enterSubmenu(actions[menuIndex]);
        break;
      case "ArrowLeft":
      case "Escape":
        leaveLevel();
        break;
      case "Tab":
        break;
      default:
        handled = false;
        // Typing edits the query again: leave the menu and let the key through
        if (
          (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) ||
          e.key === "Backspace" ||
          e.key === "Delete"
        ) {
          setMenu(null);
          setConfirmId(null);
        }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const move = (delta: number, wrap: boolean) => {
    if (items.length === 0) return;
    const next = safeIndex + delta;
    setActiveIndex(
      wrap
        ? (next + items.length) % items.length
        : Math.max(0, Math.min(items.length - 1, next))
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (menuActions) {
      handleMenuKeyDown(e);
      return;
    }
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        move(1, true);
        break;
      case "ArrowUp":
        move(-1, true);
        break;
      case "PageDown":
        move(10, false);
        break;
      case "PageUp":
        move(-10, false);
        break;
      case "Enter":
        activate(items[safeIndex]);
        break;
      case "ArrowRight": {
        // Opens the anime's actions only with the cursor at the end, so Right still moves it
        const input = e.currentTarget;
        const item = items[safeIndex];
        if (item?.kind === "anime" && input.selectionEnd === input.value.length) {
          openMenu(item.anime);
        } else {
          handled = false;
        }
        break;
      }
      case "Tab":
        setTab((t) => (t === "anime" ? "commands" : "anime"));
        break;
      case "Escape":
        onClose();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const tabCount = (t: PaletteTab) =>
    trimmed ? (t === "anime" ? animeHits.length : commandHits.length) : null;

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-bg-secondary border border-border-subtle rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border-subtle">
          <Search className="w-4 h-4 text-accent shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setMenu(null);
              onQueryChange(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              tab === "anime" ? "Jump to an anime in your list..." : "Run a command..."
            }
            className="flex-1 bg-transparent text-xs text-text-primary focus:outline-none"
          />
          {query && (
            <button
              onClick={() => {
                onQueryChange("");
                inputRef.current?.focus();
              }}
              className="p-1 rounded text-text-muted hover:text-text-primary"
              title="Clear"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Tabs (Tab / Shift+Tab) */}
        <div className="flex items-center gap-1 px-3 pt-2 text-[11px] font-semibold">
          {(["anime", "commands"] as PaletteTab[]).map((t) => {
            const count = tabCount(t);
            return (
              <button
                key={t}
                onClick={() => {
                  setTab(t);
                  setMenu(null);
                  inputRef.current?.focus();
                }}
                className={`px-2.5 py-1 rounded-lg transition flex items-center gap-1.5 ${tab === t
                  ? "bg-accent/20 text-accent"
                  : "text-text-muted hover:text-text-primary"
                  }`}
              >
                {t === "anime" ? "Anime" : "Commands"}
                {count !== null && (
                  <span className="font-mono text-[10px] opacity-80">{count}</span>
                )}
              </button>
            );
          })}
        </div>

        <div ref={listRef} className="max-h-96 overflow-y-auto p-2 text-xs">
          {menuActions && menuAnime ? (
            <>
              {/* Breadcrumb: which anime (and submenu) these actions belong to */}
              <div className="flex items-center gap-2.5 px-2.5 pb-2 mb-1 border-b border-border-subtle">
                <img
                  src={getOptimizedCoverUrl(menuAnime.cover_image, "medium")}
                  alt=""
                  className="w-6 h-8 object-cover rounded shrink-0"
                />
                <div className="min-w-0 flex items-center gap-1 text-text-muted">
                  <span className="font-semibold text-text-primary truncate">
                    {titleOf(menuAnime)}
                  </span>
                  {menuTrail.map((label) => (
                    <span key={label} className="flex items-center gap-1 shrink-0">
                      <ChevronRight className="w-3 h-3" />
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              {menuActions.map((action, index) => (
                <ActionRow
                  key={action.id}
                  action={action}
                  index={index}
                  active={index === menuIndex}
                  confirming={confirmId === action.id}
                  onHover={() => {
                    if (index !== menuIndex && !action.disabled) setMenuIndex(index);
                  }}
                  onRun={() => runAction(action)}
                />
              ))}
            </>
          ) : (
            <>
          {items.length === 0 && (
            <div className="px-3 py-6 text-center text-text-muted">
              {tab === "commands" ? "No commands match" : "Your list is empty"}
            </div>
          )}
          {sections.map((section, si) =>
            section.items.length === 0 ? null : (
              <div key={si} className={si > 0 ? "pt-1.5" : ""}>
                {section.title && (
                  <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    {section.title}
                  </div>
                )}
                {section.items.map((item) => {
                  const index = flatIndex++;
                  const active = index === safeIndex;
                  return (
                    <div
                      key={item.key}
                      data-index={index}
                      onMouseMove={() => {
                        if (!active) setActiveIndex(index);
                      }}
                      onClick={() => activate(item)}
                      onContextMenu={(e) => {
                        if (item.kind !== "anime") return;
                        e.preventDefault();
                        setActiveIndex(index);
                        openMenu(item.anime);
                      }}
                      className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl cursor-pointer ${active
                        ? "bg-accent/15 ring-1 ring-accent/40"
                        : ""
                        }`}
                    >
                      <PaletteRow item={item} query={trimmed} rawQuery={query.trim()} />
                      {active && (
                        <span className="flex items-center gap-1.5 shrink-0 text-text-muted">
                          {item.kind === "anime" && (
                            <ChevronRight className="w-3.5 h-3.5" aria-label="Actions" />
                          )}
                          <CornerDownLeft className="w-3.5 h-3.5" />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
            </>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-t border-border-subtle bg-bg-primary/40 text-[10px] text-text-muted">
          <KeyHint keys={["↑", "↓"]} label="Navigate" />
          {menuActions ? (
            <>
              <KeyHint keys={["↵"]} label="Run" />
              <KeyHint keys={["→"]} label="Submenu" />
              <KeyHint keys={["←"]} label="Back" />
              <span className="flex-1" />
              <KeyHint keys={["Esc"]} label="Back" />
            </>
          ) : (
            <>
              <KeyHint keys={["↵"]} label="Open" />
              {tab === "anime" && <KeyHint keys={["→"]} label="Actions" />}
              <KeyHint keys={["Tab"]} label="Anime / Commands" />
              <span className="flex-1" />
              <KeyHint keys={["Esc"]} label="Close" />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

function ActionRow({
  action,
  index,
  active,
  confirming,
  onHover,
  onRun,
}: {
  action: AnimeAction;
  index: number;
  active: boolean;
  confirming: boolean;
  onHover: () => void;
  onRun: () => void;
}) {
  const Icon = action.icon;
  return (
    <div
      data-index={index}
      onMouseMove={onHover}
      onClick={onRun}
      className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl ${action.disabled ? "opacity-40 cursor-default" : "cursor-pointer"
        } ${active
          ? action.danger
            ? "bg-red-500/15 ring-1 ring-red-500/40"
            : "bg-accent/15 ring-1 ring-accent/40"
          : ""
        }`}
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <Icon
          className={`w-4 h-4 shrink-0 ${action.danger ? "text-red-400" : action.iconClass ?? "text-text-muted"}`}
        />
        <span className={`truncate ${action.danger ? "text-red-400" : "text-text-primary"}`}>
          {confirming ? "Press Enter again to delete" : action.label}
        </span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0 text-text-muted">
        {action.hint && <span className="font-mono text-[10px]">{action.hint}</span>}
        {action.children ? (
          <ChevronRight className="w-3.5 h-3.5" />
        ) : (
          active && !action.disabled && <CornerDownLeft className="w-3.5 h-3.5" />
        )}
      </span>
    </div>
  );
}

function PaletteRow({
  item,
  query,
  rawQuery,
}: {
  item: PaletteItem;
  query: string;
  rawQuery: string;
}) {
  const titleOf = useAnimeTitle();
  const titleLanguage = useTitleLanguage();
  if (item.kind === "anilist") {
    return (
      <div className="flex items-center gap-2.5 min-w-0">
        <Globe className="w-4 h-4 text-accent shrink-0" />
        <span className="truncate text-text-primary">
          Search AniList for <span className="font-semibold">"{rawQuery}"</span>
        </span>
      </div>
    );
  }

  if (item.kind === "command") {
    const Icon = item.command.icon;
    return (
      <div className="flex items-center justify-between gap-2.5 min-w-0 flex-1">
        <span className="flex items-center gap-2.5 min-w-0">
          {item.recent ? (
            <History className="w-4 h-4 text-text-muted shrink-0" />
          ) : (
            <Icon className="w-4 h-4 text-accent shrink-0" />
          )}
          <span className="truncate text-text-primary">
            <Highlight text={item.command.label} query={query} />
          </span>
        </span>
        {item.command.shortcut && (
          <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-tertiary text-text-secondary shrink-0">
            {item.command.shortcut}
          </kbd>
        )}
      </div>
    );
  }

  const a = item.anime;
  const altTitle = altTitles(a, titleLanguage)[0] ?? null;
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className="relative shrink-0">
        <img
          src={getOptimizedCoverUrl(a.cover_image, "medium")}
          alt=""
          loading="lazy"
          decoding="async"
          className="w-7 h-10 object-cover rounded"
        />
        <AiringDot anime={a} size="sm" onCover className="absolute -top-0.5 -left-0.5" />
        {item.recent && (
          <History className="absolute -bottom-1 -right-1 w-3 h-3 p-px rounded-full bg-bg-secondary text-text-muted" />
        )}
      </div>
      <div className="min-w-0">
        <div className="font-semibold text-text-primary truncate">
          <Highlight text={titleOf(a)} query={query} />
        </div>
        <div className="text-[10px] text-text-muted truncate">
          <span className="font-mono">
            {statusLabel(a.user_status)} • Ep {a.user_progress}/{a.episodes ?? "?"}
          </span>
          {altTitle && (
            <>
              {" • "}
              <Highlight text={altTitle} query={query} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Bolds the characters of `text` matched by `query`. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const ranges = matchRanges(query, text);
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const [start, end] of ranges) {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <b key={start} className="text-accent font-bold">
        {text.slice(start, end)}
      </b>
    );
    last = end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="min-w-[18px] text-center px-1 py-px font-mono rounded bg-bg-tertiary text-text-secondary"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}
