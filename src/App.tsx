import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Tv,
  Magnet,
  Compass,
  Activity,
  Settings,
  Search,
  LayoutGrid,
  List,
  Rows,
  Play,
  Sparkles,
  CheckCircle2,
  Shuffle,
  AlertTriangle,
  LogOut,
  LogIn,
  ExternalLink,
  User,
  RefreshCw,
  CalendarDays,
  CalendarClock,
  History,
  X,
  HardDrive,
  Palette,
  ListChecks,
  BarChart3,
} from "lucide-react";
import {
  AnimeEntry,
  AppSettings,
  BatchAnimeUpdatePatch,
  CustomListChange,
  CustomListMember,
  CustomListsState,
  DetectedMediaSession,
  ScanSummary,
  SyncSummary,
  TrackerAccountSwitchedEvent,
  TrackerEntrySyncedEvent,
  TrackerSyncErrorEvent,
  TrackerSyncFailedEvent,
  TrackerSyncStartedEvent,
} from "./types";
import {
  applyThemeToDocument,
  THEME_PRESETS,
  toraApi,
} from "./api";
import { AnimeDetailModal } from "./components/AnimeDetailModal";
import {
  VirtualWatchlist,
  WatchlistGroup,
} from "./components/VirtualWatchlist";
import { buildAnimeSearchIndex, searchAnime } from "./fuzzy";
import { buildAnimeActions } from "./animeActions";
import { TorrentsView } from "./components/TorrentsView";
import { NowPlayingView } from "./components/NowPlayingView";
import { HistoryView } from "./components/HistoryView";
import { StatsView } from "./components/StatsView";
import { animeTitle, setCurrentTitleLanguage, TitleLanguageContext } from "./titles";
import { SeasonsView } from "./components/SeasonsView";
import { ScheduleView } from "./components/ScheduleView";
import { SearchView } from "./components/SearchView";
import { SettingsView } from "./components/SettingsView";
import { CommandPalette, PaletteCommand } from "./components/CommandPalette";
import { CLOSE_MENUS_EVENT } from "./components/FloatingQuickMenu";
import { CustomListsChip } from "./components/CustomListsChip";
import {
  applyCustomListChangeLocally,
  CustomListsApi,
  CustomListsContext,
  EMPTY_CUSTOM_LISTS,
} from "./customLists";

type NavTab =
  | "watchlist"
  | "torrents"
  | "seasons"
  | "schedule"
  | "search"
  | "nowplaying"
  | "history"
  | "stats"
  | "settings";

// Unix timestamp (seconds or milliseconds) -> short relative label for the sync button tooltip
const formatLastSynced = (ts: number) => {
  const ms = ts > 1e12 ? ts : ts * 1000;
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h ago`;
  return new Date(ms).toLocaleString();
};

// Short human-readable AniList sync summary for the toast (null when nothing changed)
const describeSyncSummary = (summary: SyncSummary) => {
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`${summary.added} added`);
  if (summary.updated_from_remote > 0)
    parts.push(`${summary.updated_from_remote} updated`);
  if (summary.deleted > 0) parts.push(`${summary.deleted} removed`);
  if (summary.pushed > 0) parts.push(`${summary.pushed} pushed`);
  if (summary.remote_deleted > 0)
    parts.push(`${summary.remote_deleted} deleted on AniList`);
  if (summary.push_failed > 0)
    parts.push(`${summary.push_failed} failed to push (will retry)`);
  if (summary.deletion_skipped_reason)
    parts.push(`removals skipped: ${summary.deletion_skipped_reason}`);
  return parts.length > 0 ? `AniList sync: ${parts.join(", ")}` : null;
};

const STATUS_TABS = [
  { id: "CURRENT", label: "Watching" },
  { id: "PLANNING", label: "Plan to Watch" },
  { id: "COMPLETED", label: "Completed" },
  { id: "PAUSED", label: "Paused" },
  { id: "DROPPED", label: "Dropped" },
  { id: "ALL", label: "All Anime" },
];

// Section order while the watchlist search groups matches from every list by status
const SEARCH_GROUPS = [
  { status: "CURRENT", label: "Watching" },
  { status: "REPEATING", label: "Rewatching" },
  { status: "PLANNING", label: "Plan to Watch" },
  { status: "COMPLETED", label: "Completed" },
  { status: "PAUSED", label: "Paused" },
  { status: "DROPPED", label: "Dropped" },
];

export const App: React.FC = () => {
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>("watchlist");
  const [statusFilter, setStatusFilter] = useState<string>("CURRENT");
  // Selected AniList custom list; replaces the status filter while set
  const [customListFilter, setCustomListFilter] = useState<string | null>(null);
  const [customListsState, setCustomListsState] =
    useState<CustomListsState>(EMPTY_CUSTOM_LISTS);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Scroll-to-and-select request for the watchlist (e.g. an anime picked in the command palette)
  const [focusRequest, setFocusRequest] = useState<{
    id: number;
    nonce: number;
  } | null>(null);
  const [sortBy, setSortBy] = useState<
    "updated" | "title" | "score" | "progress"
  >("updated");

  const [animeList, setAnimeList] = useState<AnimeEntry[]>([]);
  // Latest list for listeners registered once on mount (e.g. the sync "up to date" toast count)
  const animeListRef = useRef<AnimeEntry[]>(animeList);
  animeListRef.current = animeList;
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const titleLanguage = settings?.title_language ?? "romaji";
  setCurrentTitleLanguage(titleLanguage);
  const titleOf = useCallback((a: AnimeEntry) => animeTitle(a, titleLanguage), [titleLanguage]);
  const [selectedAnime, setSelectedAnime] = useState<AnimeEntry | null>(null);
  const [selectedAnimeIds, setSelectedAnimeIds] = useState<number[]>([]);
  const [quickMenuAnimeId, setQuickMenuAnimeId] = useState<number | null>(null);
  const [torrentSearchQuery, setTorrentSearchQuery] = useState("");
  // Query handed to the Search tab (e.g. Enter in the Seasons filter)
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  // Bumped with every hand-over so the same query searches again
  const [globalSearchRequest, setGlobalSearchRequest] = useState(0);
  // Command palette text; kept across opens
  const [cmdQuery, setCmdQuery] = useState("");
  const [activeSession, setActiveSession] =
    useState<DetectedMediaSession | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  // Opening the palette closes any right-click menu (they render above it)
  useEffect(() => {
    if (!cmdOpen) return;
    setQuickMenuAnimeId(null);
    window.dispatchEvent(new Event(CLOSE_MENUS_EVENT));
  }, [cmdOpen]);
  const [signOutModalOpen, setSignOutModalOpen] = useState(false);
  const [isAuthorizingAnilist, setIsAuthorizingAnilist] = useState(false);
  const [libraryRefreshTick, setLibraryRefreshTick] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // Bumped by every tracker sync lifecycle event so a stale get_sync_status response can't override it
  const syncEventSeqRef = useRef(0);
  // Bumped by tracker-sync-failed so the manual sync button doesn't double-toast the same failure
  const syncFailureSeqRef = useRef(0);
  const lastSyncReasonRef = useRef<string>("startup");
  const [toast, setToast] = useState<{
    msg: string;
    type: "success" | "info" | "error";
  } | null>(null);

  const showToast = (
    msg: string,
    type: "success" | "info" | "error" = "info"
  ) => {
    setToast({ msg, type });
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadInitialData = async () => {
    try {
      const [s, list] = await Promise.all([
        toraApi.getAppSettings(),
        toraApi.getAnimeList(),
      ]);
      setSettings(s);
      applyThemeToDocument(s.theme, s.accent_color);
      setAnimeList(list);
      refreshCustomLists();

      // Seed the sync spinner in case the backend startup pull is already running
      const statusSeq = syncEventSeqRef.current;
      toraApi
        .getSyncStatus()
        .then((status) => {
          if (syncEventSeqRef.current !== statusSeq) return;
          setIsSyncing(status.in_progress);
          setLastSyncedAt(status.last_synced_at);
        })
        .catch(() => { });

      // Hydrate AniList profile picture/username in background if signed in without cached avatar
      if (s.anilist_token && (!s.anilist_avatar || !s.anilist_username)) {
        toraApi
          .verifyTrackerAccount(
            s.active_tracker_plugin || "anilist",
            s.anilist_username || "",
            s.anilist_token || null
          )
          .then(async () => {
            const refreshed = await toraApi.getAppSettings();
            setSettings(refreshed);
          })
          .catch(() => { });
      }

      // Run fast delta startup scan in the background without blocking initial UI render
      toraApi
        .quickScanLibrary()
        .then(async (summary) => {
          if (summary.newly_parsed > 0 || (summary.removed_files ?? 0) > 0) {
            await refreshAnimeList();
            setLibraryRefreshTick((t) => t + 1);
          }
        })
        .catch(() => { });
    } catch (e) {
      console.error("Failed to initialize Tora:", e);
    }
  };

  // Only uses setters, so it is safe from the listeners registered once on mount
  const refreshCustomLists = () => {
    toraApi
      .getCustomLists()
      .then(setCustomListsState)
      .catch((e) => console.error("Failed to load custom lists:", e));
  };

  const refreshAnimeList = async (overrideList?: AnimeEntry[]) => {
    const list = overrideList ?? (await toraApi.getAnimeList());
    setAnimeList(list);
    setSelectedAnime((prev) =>
      prev ? list.find((a) => a.id === prev.id) ?? prev : null
    );
  };

  // Apply an AniList sync delta in place (idempotent, no full-list refetch).
  // Changed entries with an in-flight optimistic +1/-1 are left alone; their debounced save pushes again.
  const applySyncDelta = (summary: SyncSummary) => {
    const changed = summary.changed.filter(
      (entry) => !pendingStepRef.current[entry.id]
    );
    const removed = new Set(summary.removed_ids);
    if (changed.length === 0 && removed.size === 0) return;

    // A removed entry's pending step would save to a row that no longer exists
    if (removed.size > 0) {
      let droppedPending = false;
      for (const id of removed) {
        const pending = pendingStepRef.current[id];
        if (!pending) continue;
        clearTimeout(pending.timer);
        delete pendingStepRef.current[id];
        droppedPending = true;
      }
      if (droppedPending) {
        setPendingStepSnapshots((prev) => {
          const next = { ...prev };
          for (const id of removed) delete next[id];
          return next;
        });
      }
    }

    const changedById = new Map(changed.map((entry) => [entry.id, entry]));
    setAnimeList((prev) => {
      const seen = new Set<number>();
      const next: AnimeEntry[] = [];
      for (const a of prev) {
        if (removed.has(a.id)) continue;
        const replacement = changedById.get(a.id);
        if (replacement) seen.add(a.id);
        next.push(replacement ?? a);
      }
      for (const entry of changed) {
        if (!seen.has(entry.id) && !removed.has(entry.id)) next.push(entry);
      }
      return next;
    });
    setSelectedAnime((prev) => {
      if (!prev) return prev;
      if (removed.has(prev.id)) return null;
      return changedById.get(prev.id) ?? prev;
    });
    if (removed.size > 0) {
      setSelectedAnimeIds((prev) =>
        prev.some((id) => removed.has(id))
          ? prev.filter((id) => !removed.has(id))
          : prev
      );
      setQuickMenuAnimeId((prev) =>
        prev !== null && removed.has(prev) ? null : prev
      );
    }
  };

  useEffect(() => {
    // Register every Tauri listener BEFORE loading initial data so a backend startup sync
    // that finishes early is never missed. Handles unmount before the listen promises resolve.
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const registrations = [
      // Live folder watcher events when new episodes are downloaded or removed
      listen<ScanSummary>("library-changed", async (event) => {
        await refreshAnimeList();
        setLibraryRefreshTick((t) => t + 1);
        if (event.payload.newly_parsed > 0) {
          showToast(
            `Detected ${event.payload.newly_parsed} new episode${event.payload.newly_parsed === 1 ? "" : "s"
            } in library folders`,
            "success"
          );
        }
      }),

      listen<AppSettings>("tracker-auth-updated", (event) => {
        setSettings(event.payload);
        setIsAuthorizingAnilist(false);
        if (event.payload.anilist_username) {
          showToast(
            `Signed in to AniList as @${event.payload.anilist_username}!`,
            "success"
          );
        }
      }),

      listen<TrackerSyncStartedEvent>("tracker-sync-started", (event) => {
        syncEventSeqRef.current += 1;
        lastSyncReasonRef.current = event.payload.reason;
        setIsSyncing(true);
      }),

      listen<SyncSummary>("tracker-list-synced", async (event) => {
        syncEventSeqRef.current += 1;
        const summary = event.payload;
        setIsSyncing(false);
        setLastSyncedAt(Math.floor(Date.now() / 1000));
        applySyncDelta(summary);
        if (summary.custom_lists_changed) refreshCustomLists();

        // Stay quiet at startup when nothing changed; manual / post-auth syncs always confirm
        const msg = describeSyncSummary(summary);
        if (msg) {
          showToast(msg, summary.push_failed > 0 ? "error" : "success");
        } else if (lastSyncReasonRef.current !== "startup") {
          showToast(
            `AniList sync: up to date (${animeListRef.current.length} entries)`,
            "info"
          );
        }
      }),

      listen<TrackerSyncFailedEvent>("tracker-sync-failed", (event) => {
        syncEventSeqRef.current += 1;
        syncFailureSeqRef.current += 1;
        setIsSyncing(false);
        showToast(`AniList sync failed: ${event.payload.message}`, "error");
      }),

      // A background push/delete failed; the entry stays queued and retries on next sync
      listen<TrackerSyncErrorEvent>("tracker-sync-error", (event) => {
        const { operation, title, message } = event.payload;
        showToast(
          `AniList ${operation} failed for "${title}": ${message} — will retry on next sync`,
          "error"
        );
      }),

      listen<{ message: string }>("tracker-auth-invalid", () => {
        showToast(
          "AniList session expired or was revoked — please sign in again",
          "error"
        );
        // Pick up any token the backend cleared
        toraApi
          .getAppSettings()
          .then(setSettings)
          .catch(() => { });
      }),

      // A different AniList account signed in: the previous account's list was wiped and the new
      // account's list is imported next (it arrives through tracker-list-synced)
      listen<TrackerAccountSwitchedEvent>("tracker-account-switched", (event) => {
        for (const pending of Object.values(pendingStepRef.current)) {
          clearTimeout(pending.timer);
        }
        pendingStepRef.current = {};
        setPendingStepSnapshots({});
        setAnimeList([]);
        setSelectedAnime(null);
        setSelectedAnimeIds([]);
        setQuickMenuAnimeId(null);
        setLastSyncedAt(null);
        setCustomListsState(EMPTY_CUSTOM_LISTS);
        setCustomListFilter(null);
        const { username, discarded_changes } = event.payload;
        showToast(
          discarded_changes > 0
            ? `Switched to @${username}. ${discarded_changes} unsent change${discarded_changes === 1 ? "" : "s"} from the previous account ${discarded_changes === 1 ? "was" : "were"} discarded.`
            : `Switched to @${username}. Importing their AniList list…`,
          discarded_changes > 0 ? "error" : "info"
        );
      }),

      // A background push succeeded: replace the entry (clears sync_pending)
      listen<TrackerEntrySyncedEvent>("tracker-entry-synced", (event) => {
        const { entry } = event.payload;
        // Never clobber an in-flight optimistic +1/-1; its debounced save will push again
        if (pendingStepRef.current[entry.id]) return;
        setAnimeList((prev) =>
          prev.map((a) => (a.id === entry.id ? entry : a))
        );
        setSelectedAnime((prev) => (prev?.id === entry.id ? entry : prev));
      }),
    ];

    Promise.allSettled(registrations).then((results) => {
      for (const r of results) {
        if (r.status === "fulfilled") {
          if (disposed) r.value();
          else unlisteners.push(r.value);
        } else {
          console.error("Failed to register Tauri listener:", r.reason);
        }
      }
      if (!disposed) loadInitialData();
    });

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Poll Anisthesia Windows Media Player Recognition every 2.5 seconds without overlapping calls
  useEffect(() => {
    let inFlight = false;
    const interval = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const session = await toraApi.pollMediaRecognition();
        setActiveSession((prev) => {
          if (!prev && !session) return prev;
          // Auto-focus the Now Playing tab when a new media playback session is detected
          if (
            session &&
            (!prev ||
              prev.cleaned_media_title !== session.cleaned_media_title ||
              prev.player_name !== session.player_name)
          ) {
            setActiveTab("nowplaying");
          }
          // If auto_synced just flipped to true, refresh anime list and notify user
          if (
            session &&
            session.matched_anime_id &&
            session.auto_synced &&
            (!prev || !prev.auto_synced)
          ) {
            refreshAnimeList();
            showToast(
              `Scrobbled: ${session.matched_anime_title || session.parsed.anime_title
              } Episode ${session.parsed.episode_number ?? ""}!`,
              "success"
            );
          }
          // Avoid unnecessary React re-renders and object allocations when session state is unchanged
          if (
            prev &&
            session &&
            prev.cleaned_media_title === session.cleaned_media_title &&
            prev.player_name === session.player_name &&
            prev.matched_anime_id === session.matched_anime_id &&
            prev.matched_current_progress === session.matched_current_progress &&
            prev.auto_synced === session.auto_synced &&
            (session.auto_synced ||
              !session.matched_anime_id ||
              prev.elapsed_seconds === session.elapsed_seconds)
          ) {
            return prev;
          }
          return session;
        });
      } catch {
        // Ignore transient poll errors
      } finally {
        inFlight = false;
      }
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  // Track pending +1/-1 episode steps so rapid clicks update the counter in 0ms
  // without causing the anime card to jump or leave the current filter tab until the user finishes clicking
  const pendingStepRef = useRef<
    Record<
      number,
      {
        initialStatus: string;
        initialProgress: number;
        initialUpdatedAt: number;
        latestAnime: AnimeEntry;
        timer: ReturnType<typeof setTimeout>;
      }
    >
  >({});
  const [pendingStepSnapshots, setPendingStepSnapshots] = useState<
    Record<
      number,
      {
        initialStatus: string;
        initialProgress: number;
        initialUpdatedAt: number;
      }
    >
  >({});

  const handleUpdateSettings = async (next: AppSettings) => {
    setSettings(next);
    const saved = await toraApi.saveAppSettings(next);
    setSettings(saved);
  };

  const handleStepEpisode = (anime: AnimeEntry, delta: number) => {
    const existing = pendingStepRef.current[anime.id];
    const baseAnime = existing ? existing.latestAnime : anime;
    const maxEp = baseAnime.episodes || 9999;
    const nextProg = Math.max(
      0,
      Math.min(maxEp, baseAnime.user_progress + delta)
    );

    if (existing) {
      clearTimeout(existing.timer);
    }

    const initialStatus = existing ? existing.initialStatus : anime.user_status;
    const initialProgress = existing
      ? existing.initialProgress
      : anime.user_progress;
    const initialUpdatedAt = existing
      ? existing.initialUpdatedAt
      : anime.updated_at;

    // Instant 0ms optimistic UI update on the card's episode counter while preserving list position
    const optimisticEntry: AnimeEntry = {
      ...baseAnime,
      user_progress: nextProg,
      user_status: initialStatus,
      updated_at: initialUpdatedAt,
    };

    setAnimeList((prev) =>
      prev.map((a) => (a.id === anime.id ? optimisticEntry : a))
    );
    setSelectedAnime((prev) =>
      prev?.id === anime.id ? optimisticEntry : prev
    );

    if (!existing) {
      setPendingStepSnapshots((prev) => ({
        ...prev,
        [anime.id]: {
          initialStatus,
          initialProgress,
          initialUpdatedAt,
        },
      }));
    }

    const timer = setTimeout(async () => {
      const current = pendingStepRef.current[anime.id];
      delete pendingStepRef.current[anime.id];
      setPendingStepSnapshots((prev) => {
        const next = { ...prev };
        delete next[anime.id];
        return next;
      });

      if (!current) return;
      const finalAnime = current.latestAnime;
      const finalProg = finalAnime.user_progress;
      let nextStatus = current.initialStatus;
      if (finalAnime.episodes && finalProg >= finalAnime.episodes) {
        nextStatus = "COMPLETED";
      } else if (finalProg > 0 && current.initialStatus === "PLANNING") {
        nextStatus = "CURRENT";
      }

      showToast(
        `${titleOf(finalAnime)} → Episode ${finalProg}`,
        "success"
      );

      try {
        const updated = await toraApi.updateAnimeEntry({
          animeId: finalAnime.id,
          userStatus: nextStatus,
          userProgress: finalProg,
          userScore: finalAnime.user_score,
          userRepeats: finalAnime.user_repeats,
          userNotes: finalAnime.user_notes,
          customFolder: finalAnime.custom_folder,
        });
        setAnimeList((prev) =>
          prev.map((a) => (a.id === updated.id ? updated : a))
        );
        setSelectedAnime((prev) =>
          prev?.id === updated.id ? updated : prev
        );
      } catch (err: any) {
        showToast(String(err), "error");
      }
    }, 1400);

    pendingStepRef.current[anime.id] = {
      initialStatus,
      initialProgress,
      initialUpdatedAt,
      latestAnime: optimisticEntry,
      timer,
    };
  };

  const handleDismissSession = async () => {
    await toraApi.dismissPlaybackSession();
    setActiveSession(null);
  };

  const handleLinkDetectedEpisode = async (
    animeId: number,
    aliasTitle: string
  ) => {
    const updatedSession = await toraApi.linkDetectedEpisodeToAnime(
      animeId,
      aliasTitle
    );
    if (updatedSession) {
      setActiveSession(updatedSession);
    }
    await refreshAnimeList();
  };


  // Custom lists live beside the list (never in AnimeEntry, so search and matching don't see them)
  const customListMembers = useMemo(
    () => new Map<number, CustomListMember>(customListsState.members.map((m) => [m.anime_id, m])),
    [customListsState]
  );
  // Entries hidden from status lists only show in their custom lists, All Anime and search
  const hiddenFromStatusIds = useMemo(
    () =>
      new Set(
        customListsState.members
          .filter((m) => m.hidden_from_status_lists)
          .map((m) => m.anime_id)
      ),
    [customListsState]
  );
  const customListCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of animeList) {
      for (const name of customListMembers.get(a.id)?.lists ?? []) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return counts;
  }, [animeList, customListMembers]);

  // Optimistic membership edit; the backend queues and pushes it like any other edit
  const applyCustomListChange = async (change: CustomListChange) => {
    setCustomListsState((prev) => applyCustomListChangeLocally(prev, change));
    try {
      setCustomListsState(await toraApi.setAnimeCustomLists(change));
    } catch (err) {
      refreshCustomLists();
      throw err;
    }
  };
  const customListsApi = useMemo<CustomListsApi>(
    () => ({
      names: customListsState.names,
      membership: (id) => customListMembers.get(id),
      apply: applyCustomListChange,
    }),
    [customListsState, customListMembers]
  );

  // The selected list was deleted on AniList: fall back to Watching
  useEffect(() => {
    if (customListFilter !== null && !customListsState.names.includes(customListFilter)) {
      setCustomListFilter(null);
      setStatusFilter("CURRENT");
    }
  }, [customListsState, customListFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: animeList.length };
    for (const a of animeList) {
      if (hiddenFromStatusIds.has(a.id)) continue;
      counts[a.user_status] = (counts[a.user_status] || 0) + 1;
    }
    return counts;
  }, [animeList, hiddenFromStatusIds]);

  // Shared by the watchlist search and the command palette; rebuilt only when the list changes
  const searchIndex = useMemo(() => buildAnimeSearchIndex(animeList), [animeList]);
  // Typing stays responsive: filtering re-runs at lower priority than the input itself
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const isSearching = deferredSearchQuery.trim().length > 0;

  const compareBySort = useMemo(() => {
    return (a: AnimeEntry, b: AnimeEntry) => {
      if (sortBy === "title") return titleOf(a).localeCompare(titleOf(b));
      if (sortBy === "score") return b.user_score - a.user_score;
      if (sortBy === "progress") {
        const progA = pendingStepSnapshots[a.id]?.initialProgress ?? a.user_progress;
        const progB = pendingStepSnapshots[b.id]?.initialProgress ?? b.user_progress;
        return progB - progA;
      }
      const updA = pendingStepSnapshots[a.id]?.initialUpdatedAt ?? a.updated_at;
      const updB = pendingStepSnapshots[b.id]?.initialUpdatedAt ?? b.updated_at;
      return updB - updA;
    };
  }, [sortBy, pendingStepSnapshots, titleOf]);

  // With a search: matches from every list, grouped by status (stepping keeps a card in its
  // original group), best match first and the sort dropdown as the tie-break
  const searchGroups = useMemo((): WatchlistGroup[] | null => {
    if (!isSearching) return null;
    const hits = searchAnime(searchIndex, deferredSearchQuery);
    const byStatus = new Map<string, { entry: AnimeEntry; score: number }[]>();
    for (const { item, score } of hits) {
      const status = pendingStepSnapshots[item.id]?.initialStatus ?? item.user_status;
      let bucket = byStatus.get(status);
      if (!bucket) byStatus.set(status, (bucket = []));
      bucket.push({ entry: item, score });
    }
    const known = new Set(SEARCH_GROUPS.map((g) => g.status));
    const order = [
      ...SEARCH_GROUPS,
      ...Array.from(byStatus.keys())
        .filter((st) => !known.has(st))
        .map((st) => ({ status: st, label: st })),
    ];
    return order
      .filter((g) => byStatus.has(g.status))
      .map((g) => ({
        ...g,
        items: byStatus
          .get(g.status)!
          .sort((a, b) => b.score - a.score || compareBySort(a.entry, b.entry))
          .map((h) => h.entry),
      }));
  }, [isSearching, searchIndex, deferredSearchQuery, pendingStepSnapshots, compareBySort]);

  const filteredAnime = useMemo(() => {
    if (searchGroups) return searchGroups.flatMap((g) => g.items);
    if (customListFilter !== null) {
      return animeList
        .filter((a) => customListMembers.get(a.id)?.lists.includes(customListFilter))
        .sort(compareBySort);
    }
    return animeList
      .filter((a) => {
        if (statusFilter === "ALL") return true;
        if (hiddenFromStatusIds.has(a.id)) return false;
        const effectiveStatus =
          pendingStepSnapshots[a.id]?.initialStatus ?? a.user_status;
        return effectiveStatus === statusFilter;
      })
      .sort(compareBySort);
  }, [
    animeList,
    statusFilter,
    customListFilter,
    customListMembers,
    hiddenFromStatusIds,
    searchGroups,
    pendingStepSnapshots,
    compareBySort,
  ]);

  // Sync requires an OAuth token; a bare username no longer counts as signed in
  const isSignedIn = Boolean(settings?.anilist_token?.trim());

  const handleSyncFromAnilist = async () => {
    if (isSyncing || !isSignedIn) return;
    setIsSyncing(true);
    const failureSeq = syncFailureSeqRef.current;
    try {
      // The tracker-list-synced event owns the summary toast; just apply the delta here
      // (idempotent, so applying it again after the event is harmless)
      const summary = await toraApi.syncTrackerList();
      setLastSyncedAt(Math.floor(Date.now() / 1000));
      applySyncDelta(summary);
    } catch (err: any) {
      if (syncFailureSeqRef.current === failureSeq) {
        showToast(`AniList sync failed: ${String(err)}`, "error");
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const handleStartAnilistLogin = async () => {
    try {
      setIsAuthorizingAnilist(true);
      await toraApi.startAnilistOauth();
      showToast(
        "Opened AniList in your browser — click Authorize to sign in",
        "info"
      );
    } catch (err: any) {
      setIsAuthorizingAnilist(false);
      showToast(String(err), "error");
    }
  };

  const handleConfirmSignOut = async () => {
    try {
      const { settings: updated, unsent } = await toraApi.signOutTracker();
      setSettings(updated);
      setSignOutModalOpen(false);
      setIsAuthorizingAnilist(false);
      showToast(
        unsent > 0
          ? `Signed out of AniList. ${unsent} change${unsent === 1 ? "" : "s"} couldn't be sent; ${unsent === 1 ? "it" : "they"} will be sent next time this account signs in.`
          : "Signed out of AniList",
        unsent > 0 ? "error" : "info"
      );
    } catch (err: any) {
      showToast(String(err), "error");
    }
  };

  const handleOpenAnilistProfile = async () => {
    if (!settings?.anilist_username) return;
    const url = `https://anilist.co/user/${encodeURIComponent(
      settings.anilist_username.trim()
    )}`;
    try {
      await toraApi.openExternalUrl(url);
    } catch (err: any) {
      showToast(String(err), "error");
    }
  };

  const viewMode = settings?.view_mode || "grid";

  const openGlobalSearch = (q: string) => {
    setGlobalSearchQuery(q);
    setGlobalSearchRequest((n) => n + 1);
    setActiveTab("search");
  };

  const rescanInFlightRef = useRef(false);
  const handleRescanLibrary = async () => {
    if (rescanInFlightRef.current) return;
    rescanInFlightRef.current = true;
    showToast("Rescanning library folders…", "info");
    try {
      const sum = await toraApi.scanLibrary();
      await refreshAnimeList();
      setLibraryRefreshTick((t) => t + 1);
      showToast(
        `Scanned ${sum.total_files_indexed} files in ${sum.elapsed_ms}ms`,
        "success"
      );
    } catch (err: any) {
      showToast(String(err), "error");
    } finally {
      rescanInFlightRef.current = false;
    }
  };
  // The global key handler is registered with a fixed dependency list; read the latest handler
  const rescanRef = useRef(handleRescanLibrary);
  rescanRef.current = handleRescanLibrary;

  // Palette pick: show the anime in the watchlist (palette text in its search box, or its own
  // list when there is no text), scroll to and select it, and open its details
  const handleOpenAnimeFromPalette = (anime: AnimeEntry) => {
    const entry = animeList.find((a) => a.id === anime.id) ?? anime;
    setActiveTab("watchlist");
    setSearchQuery(cmdQuery.trim());
    if (!cmdQuery.trim()) {
      setCustomListFilter(null);
      setStatusFilter(
        STATUS_TABS.some((t) => t.id === entry.user_status) &&
          !hiddenFromStatusIds.has(entry.id)
          ? entry.user_status
          : "ALL"
      );
    }
    setFocusRequest((prev) => ({ id: entry.id, nonce: (prev?.nonce ?? 0) + 1 }));
    setSelectedAnime(entry);
  };

  // Stats → status bar: that status list in the watchlist
  const openStatusList = (status: string) => {
    setActiveTab("watchlist");
    setSearchQuery("");
    setCustomListFilter(null);
    setStatusFilter(status);
  };

  const openCustomList = (name: string) => {
    setActiveTab("watchlist");
    setSearchQuery("");
    setCustomListFilter(name);
  };

  const setViewMode = (mode: "grid" | "compact" | "table") => {
    setActiveTab("watchlist");
    if (settings && settings.view_mode !== mode) {
      handleUpdateSettings({ ...settings, view_mode: mode });
    }
  };

  const paletteCommands: PaletteCommand[] = [
    { id: "go-nowplaying", label: "Go to Now Playing", keywords: ["playing", "player", "dashboard"], icon: Activity, run: () => setActiveTab("nowplaying") },
    { id: "go-watchlist", label: "Go to Anime Watchlist", keywords: ["list", "library"], icon: Tv, run: () => setActiveTab("watchlist") },
    { id: "go-torrents", label: "Go to Torrents & RSS", keywords: ["nyaa", "download", "rss", "feed"], icon: Magnet, run: () => setActiveTab("torrents") },
    { id: "go-seasons", label: "Go to Seasons", keywords: ["seasonal", "browse"], icon: CalendarDays, run: () => setActiveTab("seasons") },
    { id: "go-schedule", label: "Go to Schedule", keywords: ["airing", "calendar", "timetable"], icon: CalendarClock, run: () => setActiveTab("schedule") },
    { id: "go-search", label: "Go to Search", keywords: ["anilist", "find"], icon: Compass, run: () => setActiveTab("search") },
    { id: "go-history", label: "Go to History", keywords: ["watched", "scrobbles"], icon: History, run: () => setActiveTab("history") },
    { id: "go-stats", label: "Go to Stats", keywords: ["statistics", "activity", "backlog"], icon: BarChart3, run: () => setActiveTab("stats") },
    { id: "go-settings", label: "Go to Settings", keywords: ["preferences", "options"], icon: Settings, run: () => setActiveTab("settings") },
    { id: "rescan-library", label: "Rescan All Library Folders", keywords: ["scan", "refresh", "files", "disk"], icon: HardDrive, shortcut: "F5", run: () => void handleRescanLibrary() },
    {
      id: "sync-anilist",
      label: "Sync from AniList",
      keywords: ["pull", "refresh", "tracker"],
      icon: RefreshCw,
      run: () => {
        if (!isSignedIn) showToast("Sign in to AniList in Settings to sync", "info");
        else void handleSyncFromAnilist();
      },
    },
    {
      id: "random-anime",
      label: "Open a Random Anime from the Current List",
      keywords: ["shuffle", "pick", "random"],
      icon: Shuffle,
      run: () => {
        if (filteredAnime.length === 0) return showToast("The current list is empty", "info");
        setActiveTab("watchlist");
        setSelectedAnime(filteredAnime[Math.floor(Math.random() * filteredAnime.length)]);
      },
    },
    ...customListsState.names.map((name) => ({
      id: `custom-list-${name}`,
      label: `Open List: ${name}`,
      keywords: ["custom list", "anilist list"],
      icon: ListChecks,
      run: () => openCustomList(name),
    })),
    { id: "view-grid", label: "View: Poster Grid", keywords: ["layout", "cards"], icon: LayoutGrid, run: () => setViewMode("grid") },
    { id: "view-compact", label: "View: Detailed Cards", keywords: ["layout", "compact"], icon: Rows, run: () => setViewMode("compact") },
    { id: "view-table", label: "View: Dense Table", keywords: ["layout", "list", "taiga"], icon: List, run: () => setViewMode("table") },
    ...THEME_PRESETS.map((t) => ({
      id: `theme-${t.id}`,
      label: `Theme: ${t.name}`,
      keywords: ["theme", "appearance", "color", t.isDark ? "dark" : "light"],
      icon: Palette,
      run: () => {
        if (!settings) return;
        applyThemeToDocument(t.id, t.defaultAccent);
        void handleUpdateSettings({ ...settings, theme: t.id, accent_color: t.defaultAccent });
      },
    })),
  ];

  // Keyboard shortcuts: Ctrl+K for Command Palette, Ctrl+A to select all in watchlist,
  // Enter to open selected anime modal, Escape to close modals/menus or clear selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (e.key === "F5") {
        // Always swallow F5 so the webview never reloads; rescan when nothing else has focus
        e.preventDefault();
        if (!isInputFocused && !selectedAnime && !cmdOpen && !signOutModalOpen) {
          void rescanRef.current();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "a" &&
        !isInputFocused &&
        activeTab === "watchlist" &&
        !selectedAnime &&
        !cmdOpen
      ) {
        e.preventDefault();
        setSelectedAnimeIds(filteredAnime.map((a) => a.id));
      } else if (
        e.key === "Enter" &&
        !isInputFocused &&
        activeTab === "watchlist" &&
        !selectedAnime &&
        !cmdOpen &&
        quickMenuAnimeId === null &&
        selectedAnimeIds.length === 1
      ) {
        const found = animeList.find((a) => a.id === selectedAnimeIds[0]);
        if (found) {
          e.preventDefault();
          setSelectedAnime(found);
        }
      } else if (e.key === "Escape") {
        if (signOutModalOpen) {
          setSignOutModalOpen(false);
        } else if (cmdOpen) {
          setCmdOpen(false);
        } else if (quickMenuAnimeId !== null) {
          setQuickMenuAnimeId(null);
        } else if (selectedAnime) {
          setSelectedAnime(null);
        } else if (selectedAnimeIds.length > 0) {
          setSelectedAnimeIds([]);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeTab,
    animeList,
    cmdOpen,
    filteredAnime,
    quickMenuAnimeId,
    selectedAnime,
    selectedAnimeIds,
    signOutModalOpen,
  ]);

  const handleDeleteAnime = async (anime: AnimeEntry) => {
    try {
      await toraApi.deleteAnimeEntry(anime.id);
      setAnimeList((prev) => prev.filter((a) => a.id !== anime.id));
      setSelectedAnime((prev) => (prev?.id === anime.id ? null : prev));
      setSelectedAnimeIds((prev) => prev.filter((id) => id !== anime.id));
      showToast(`Removed "${titleOf(anime)}" from list`, "info");
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  // Open the drawer; anime already in the list open with their local entry (user state included)
  const openAnime = (anime: AnimeEntry) => {
    setSelectedAnime(animeList.find((a) => a.id === anime.id) ?? anime);
  };

  // Add a remote (Seasons / Search) anime to the list with an instant optimistic update
  const handleAddRemoteAnime = async (
    entry: AnimeEntry,
    status: "CURRENT" | "PLANNING"
  ) => {
    const optimisticEntry: AnimeEntry = {
      ...entry,
      user_status: status,
      updated_at: Math.floor(Date.now() / 1000),
    };
    await refreshAnimeList([
      ...animeList.filter((a) => a.id !== entry.id),
      optimisticEntry,
    ]);
    showToast(
      `Added "${titleOf(entry)}" to ${status === "CURRENT" ? "Watching" : "Planning"}`,
      "success"
    );

    try {
      const updated = await toraApi.addOrUpsertAnime(optimisticEntry);
      await refreshAnimeList(updated);
    } catch (err: any) {
      setAnimeList((prev) => prev.filter((a) => a.id !== entry.id));
      showToast(String(err), "error");
    }
  };

  const handleBatchUpdate = async (
    patch: BatchAnimeUpdatePatch,
    summaryToast: string
  ) => {
    try {
      const updatedItems = await toraApi.batchUpdateAnimeEntries(patch);
      const updatedMap = new Map<number, AnimeEntry>();
      for (const u of updatedItems) {
        updatedMap.set(u.id, u);
      }
      setAnimeList((prev) =>
        prev.map((a) => updatedMap.get(a.id) ?? a)
      );
      setSelectedAnime((prev) =>
        prev ? updatedMap.get(prev.id) ?? prev : null
      );
      showToast(summaryToast, "success");
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  const handleBatchDelete = async (targets: AnimeEntry[]) => {
    if (targets.length === 0) return;
    const ids = targets.map((a) => a.id);
    const idSet = new Set(ids);
    try {
      const remaining = await toraApi.batchDeleteAnimeEntries(ids);
      setAnimeList(remaining);
      setSelectedAnime((prev) => (prev && idSet.has(prev.id) ? null : prev));
      setSelectedAnimeIds((prev) => prev.filter((id) => !idSet.has(id)));
      showToast(
        `Removed ${targets.length} anime from list`,
        "info"
      );
    } catch (e: any) {
      showToast(String(e), "error");
    }
  };

  return (
    <TitleLanguageContext.Provider value={titleLanguage}>
    <CustomListsContext.Provider value={customListsApi}>
    <div
      className="flex h-screen w-screen overflow-hidden bg-bg-primary text-text-primary select-none"
      onClick={() => setQuickMenuAnimeId(null)}
      onContextMenu={() => setQuickMenuAnimeId(null)}
    >
      {/* Left Sidebar Navigation */}
      <aside className="w-60 bg-bg-secondary border-r border-border-subtle flex flex-col justify-between shrink-0">
        <div className="p-4 space-y-5">
          {/* App Brand Header */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white font-black text-lg shadow-md">
                虎
              </div>
              <div>
                <div className="font-extrabold text-sm tracking-tight text-text-primary flex items-center gap-1.5">
                  TORA
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-accent/15 text-accent">
                    v0.1
                  </span>
                </div>
                <div className="text-[10px] text-text-muted">
                  Anime Library & Tracker
                </div>
              </div>
            </div>

            <button
              onClick={() => setActiveTab("settings")}
              className={`p-2 rounded-lg transition shrink-0 cursor-pointer ${activeTab === "settings"
                  ? "bg-accent text-white shadow-sm"
                  : "bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-accent"
                }`}
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>

          {/* Ctrl+K Quick Command Button */}
          <button
            onClick={() => setCmdOpen(true)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle hover:border-accent/50 text-xs text-text-muted hover:text-text-primary transition"
          >
            <span className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-accent" />
              Quick Jump...
            </span>
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-tertiary text-text-secondary">
              Ctrl+K
            </kbd>
          </button>

          {/* Primary Navigation Links */}
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab("nowplaying")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${activeTab === "nowplaying"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
            >
              <span className="flex items-center gap-2.5">
                <Activity className="w-4 h-4" />
                Now Playing
              </span>
              {activeSession && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              )}
            </button>

            <div className="py-1.5 px-1">
              <div className="border-t border-border-subtle" />
            </div>

            <button
              onClick={() => setActiveTab("watchlist")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${activeTab === "watchlist"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
            >
              <span className="flex items-center gap-2.5">
                <Tv className="w-4 h-4" />
                Anime Watchlist
              </span>
              <span className="text-[11px] font-mono opacity-80">
                {animeList.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab("torrents")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${activeTab === "torrents"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
            >
              <span className="flex items-center gap-2.5">
                <Magnet className="w-4 h-4" />
                Torrents & RSS
              </span>
            </button>

            <button
              onClick={() => setActiveTab("seasons")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${activeTab === "seasons"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
            >
              <span className="flex items-center gap-2.5">
                <CalendarDays className="w-4 h-4" />
                Seasons
              </span>
            </button>

            <button
              onClick={() => setActiveTab("schedule")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${activeTab === "schedule"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
            >
              <span className="flex items-center gap-2.5">
                <CalendarClock className="w-4 h-4" />
                Schedule
              </span>
            </button>

            <button
              onClick={() => setActiveTab("search")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${activeTab === "search"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
            >
              <span className="flex items-center gap-2.5">
                <Compass className="w-4 h-4" />
                Search
              </span>
            </button>

            <button
              onClick={() => setActiveTab("history")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${activeTab === "history"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
            >
              <span className="flex items-center gap-2.5">
                <History className="w-4 h-4" />
                History
              </span>
            </button>

            <button
              onClick={() => setActiveTab("stats")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${activeTab === "stats"
                ? "bg-accent text-white shadow-sm"
                : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                }`}
            >
              <span className="flex items-center gap-2.5">
                <BarChart3 className="w-4 h-4" />
                Stats
              </span>
            </button>

          </nav>
        </div>

        {/* Bottom Account & AniList Auth Section */}
        <div className="p-3">
          {isSignedIn && settings ? (
            <div className="flex items-center justify-between gap-2 p-2 rounded-xl bg-bg-primary border border-border-subtle">
              <button
                onClick={handleOpenAnilistProfile}
                className="flex items-center gap-2.5 min-w-0 flex-1 text-left group cursor-pointer"
                title={`Open @${settings.anilist_username} on AniList`}
              >
                {settings.anilist_avatar ? (
                  <img
                    src={settings.anilist_avatar}
                    alt={settings.anilist_username}
                    className="w-9 h-9 rounded-full object-cover border border-border-subtle group-hover:border-accent transition shrink-0 bg-bg-tertiary"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-accent/15 border border-accent/30 group-hover:border-accent flex items-center justify-center text-accent font-bold text-xs shrink-0 transition">
                    {settings.anilist_username ? (
                      settings.anilist_username.charAt(0).toUpperCase()
                    ) : (
                      <User className="w-4 h-4" />
                    )}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-text-primary group-hover:text-accent transition truncate flex items-center gap-1">
                    <span className="truncate">
                      {settings.anilist_username || "AniList User"}
                    </span>
                    <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition shrink-0 text-accent" />
                  </div>
                  <div className="text-[10px] text-text-muted truncate">
                    AniList Profile
                  </div>
                </div>
              </button>

              <button
                onClick={() => setSignOutModalOpen(true)}
                className="p-2 rounded-lg text-text-muted hover:text-rose-400 hover:bg-rose-500/10 transition shrink-0 cursor-pointer"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={handleStartAnilistLogin}
              className="w-full flex items-center gap-3 p-3 rounded-xl bg-gradient-to-r from-accent/15 via-bg-primary to-bg-primary border border-accent/40 hover:border-accent hover:from-accent/25 transition text-left group cursor-pointer shadow-sm"
            >
              <div className="w-9 h-9 rounded-xl bg-accent text-white flex items-center justify-center shrink-0 shadow-sm group-hover:scale-105 transition">
                <LogIn className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold text-text-primary group-hover:text-accent transition">
                  {isAuthorizingAnilist
                    ? "Waiting for AniList..."
                    : "Sign in with AniList"}
                </div>
                <div className="text-[10px] text-text-muted truncate">
                  {isAuthorizingAnilist
                    ? "Authorize in browser or click to retry"
                    : "Click to authorize & sync your list"}
                </div>
              </div>
            </button>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Live "Now Playing"  (the Now Playing tab shows its own hero) */}
        {activeSession && activeTab !== "nowplaying" && (
          <div className="bg-gradient-to-r from-accent/20 via-bg-secondary to-bg-secondary border-b border-accent/40 px-6 py-2.5 flex items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent text-white text-[11px] font-bold shrink-0">
                <Play className="w-3 h-3 fill-current" />
                NOW PLAYING ({activeSession.player_name})
              </span>
              <span className="text-xs font-bold text-text-primary truncate">
                {activeSession.matched_anime_title ||
                  activeSession.parsed.anime_title}{" "}
                — Episode {activeSession.parsed.episode_number ?? "?"}
              </span>
              {activeSession.parsed.video_resolution && (
                <span className="px-1.5 py-0.5 rounded bg-bg-tertiary text-emerald-400 font-mono text-[10px]">
                  {activeSession.parsed.video_resolution}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 shrink-0 text-xs">
              {activeSession.matched_anime_id ? (
                activeSession.auto_synced ? (
                  <span className="text-emerald-400 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" />
                    Progress Scrobbled!
                  </span>
                ) : activeSession.parsed.episode_number !== null &&
                  activeSession.matched_current_progress !== null &&
                  activeSession.parsed.episode_number <=
                  activeSession.matched_current_progress ? null : (
                  <span className="text-amber-300 font-mono text-[11px]">
                    Auto-updating in{" "}
                    {Math.max(
                      0,
                      (settings?.recognition_delay_seconds || 10) -
                      activeSession.elapsed_seconds
                    )}
                    s...
                  </span>
                )
              ) : (
                <button
                  onClick={() => setActiveTab("nowplaying")}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 font-semibold hover:bg-amber-500/30 transition text-[11px]"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Unmatched — Select Anime
                </button>
              )}
              <button
                onClick={handleDismissSession}
                className="px-2 py-1 rounded bg-bg-tertiary hover:bg-bg-elevated text-text-secondary text-[11px]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Active View Content */}
        <main
          ref={mainScrollRef}
          // Reserve the scrollbar's space so content doesn't shift sideways when it appears/disappears
          className="flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          onClick={() => {
            if (selectedAnimeIds.length > 0) {
              setSelectedAnimeIds([]);
            }
          }}
        >
          {activeTab === "watchlist" && (
            <div className="p-6 space-y-4 max-w-7xl mx-auto">
              {/* Top Watchlist Filter & View Mode Toolbar */}
              <div
                className="flex flex-wrap items-center justify-between gap-4"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Status Tabs */}
                <div className="flex flex-wrap items-center gap-1 bg-bg-secondary p-1 rounded-xl border border-border-subtle">
                  {STATUS_TABS.map((tab) => {
                    const active =
                      !isSearching && customListFilter === null && statusFilter === tab.id;
                    const count = statusCounts[tab.id] || 0;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => {
                          setSearchQuery("");
                          setCustomListFilter(null);
                          setStatusFilter(tab.id);
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${active
                          ? "bg-accent text-white shadow-sm"
                          : "text-text-secondary hover:text-text-primary"
                          }`}
                      >
                        <span>{tab.label}</span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${active
                            ? "bg-black/25 text-white"
                            : "bg-bg-tertiary text-text-muted"
                            }`}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                  {customListsState.names.length > 0 && (
                    <CustomListsChip
                      names={customListsState.names}
                      counts={customListCounts}
                      active={isSearching ? null : customListFilter}
                      onSelect={openCustomList}
                    />
                  )}
                </div>

                {/* Search, Sort, Random & View Switcher */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Escape") return;
                        // Esc clears; on an empty box it leaves the box. Never reaches the global handler.
                        e.stopPropagation();
                        if (searchQuery) setSearchQuery("");
                        else e.currentTarget.blur();
                      }}
                      placeholder="Search all lists..."
                      title="Searches every list; results are grouped by status (Esc clears)"
                      className="pl-8 pr-7 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent w-56"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => {
                          setSearchQuery("");
                          searchInputRef.current?.focus();
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-text-primary"
                        title="Clear search (Esc)"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="px-2.5 py-1.5 rounded-xl bg-bg-secondary border border-border-subtle text-xs text-text-primary"
                  >
                    <option value="updated">Sort: Last Updated</option>
                    <option value="title">Sort: Title (A-Z)</option>
                    <option value="score">Sort: My Score</option>
                    <option value="progress">Sort: Progress</option>
                  </select>

                  <button
                    onClick={() => {
                      if (filteredAnime.length > 0) {
                        const rand =
                          filteredAnime[
                          Math.floor(Math.random() * filteredAnime.length)
                          ];
                        setSelectedAnime(rand);
                      }
                    }}
                    className="p-2 rounded-xl bg-bg-secondary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition"
                    title="Pick Random Anime from Current List"
                  >
                    <Shuffle className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={handleSyncFromAnilist}
                    disabled={isSyncing || !isSignedIn}
                    className="p-2 rounded-xl bg-bg-secondary hover:bg-bg-tertiary border border-border-subtle text-text-secondary hover:text-text-primary transition disabled:opacity-50 disabled:cursor-not-allowed"
                    title={
                      !isSignedIn
                        ? "Sign in to AniList to sync your list"
                        : isSyncing
                          ? "Syncing with AniList…"
                          : `Sync from AniList${lastSyncedAt ? ` • Last synced ${formatLastSynced(lastSyncedAt)}` : ""
                          }`
                    }
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`}
                    />
                  </button>

                  {settings && (
                    <div className="flex items-center bg-bg-secondary p-1 rounded-xl border border-border-subtle">
                      <button
                        onClick={() =>
                          handleUpdateSettings({
                            ...settings,
                            view_mode: "grid",
                          })
                        }
                        className={`p-1.5 rounded-lg transition ${viewMode === "grid"
                          ? "bg-accent text-white"
                          : "text-text-muted hover:text-text-primary"
                          }`}
                        title="Poster Grid View"
                      >
                        <LayoutGrid className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          handleUpdateSettings({
                            ...settings,
                            view_mode: "compact",
                          })
                        }
                        className={`p-1.5 rounded-lg transition ${viewMode === "compact"
                          ? "bg-accent text-white"
                          : "text-text-muted hover:text-text-primary"
                          }`}
                        title="Detailed Cards View"
                      >
                        <Rows className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          handleUpdateSettings({
                            ...settings,
                            view_mode: "table",
                          })
                        }
                        className={`p-1.5 rounded-lg transition ${viewMode === "table"
                          ? "bg-accent text-white"
                          : "text-text-muted hover:text-text-primary"
                          }`}
                        title="Taiga Classic Dense Table View"
                      >
                        <List className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Virtualized Watchlist Rendering */}
              <VirtualWatchlist
                items={filteredAnime}
                groups={searchGroups}
                searchQuery={deferredSearchQuery}
                // Applied once the deferred search has caught up, so it scrolls within the new results
                focusRequest={deferredSearchQuery === searchQuery ? focusRequest : null}
                onFocusHandled={() => setFocusRequest(null)}
                allAnime={animeList}
                viewMode={viewMode}
                scrollContainerRef={mainScrollRef}
                selectedAnimeIds={selectedAnimeIds}
                onSetSelectedAnimeIds={setSelectedAnimeIds}
                quickMenuAnimeId={quickMenuAnimeId}
                onSetQuickMenuAnimeId={setQuickMenuAnimeId}
                onOpenAnimeModal={(a) => setSelectedAnime(a)}
                onStepEpisode={handleStepEpisode}
                onBatchUpdate={handleBatchUpdate}
                onBatchDelete={handleBatchDelete}
                onSearchTorrents={(q) => {
                  setTorrentSearchQuery(q);
                  setActiveTab("torrents");
                }}
                onDeleteAnime={handleDeleteAnime}
                showToast={showToast}
              />
            </div>
          )}

          {activeTab === "torrents" && (
            <TorrentsView
              animeList={animeList}
              initialQuery={torrentSearchQuery}
              onSelectAnime={(a) => setSelectedAnime(a)}
              showToast={showToast}
            />
          )}

          {activeTab === "seasons" && (
            <SeasonsView
              animeList={animeList}
              scrollContainerRef={mainScrollRef}
              keyboardEnabled={!selectedAnime && !cmdOpen && !signOutModalOpen}
              onOpenAnime={openAnime}
              onAddAnime={handleAddRemoteAnime}
              onGlobalSearch={openGlobalSearch}
              onChangeStatus={(anime, status, label) =>
                handleBatchUpdate(
                  { anime_ids: [anime.id], user_status: status },
                  `Moved "${titleOf(anime)}" to ${label}`
                )
              }
              onRemoveAnime={handleDeleteAnime}
              showToast={showToast}
            />
          )}

          {activeTab === "schedule" && (
            <ScheduleView
              animeList={animeList}
              onOpenAnime={openAnime}
              onAddAnime={handleAddRemoteAnime}
              onChangeStatus={(anime, status, label) =>
                handleBatchUpdate(
                  { anime_ids: [anime.id], user_status: status },
                  `Moved "${titleOf(anime)}" to ${label}`
                )
              }
              onRemoveAnime={handleDeleteAnime}
              onStepEpisode={handleStepEpisode}
              onBatchUpdate={handleBatchUpdate}
              onBatchDelete={handleBatchDelete}
              onSearchTorrents={(q) => {
                setTorrentSearchQuery(q);
                setActiveTab("torrents");
              }}
              onDeleteAnime={handleDeleteAnime}
              showToast={showToast}
            />
          )}

          {activeTab === "search" && (
            <SearchView
              animeList={animeList}
              initialQuery={globalSearchQuery}
              searchRequestId={globalSearchRequest}
              onOpenAnime={openAnime}
              onAddAnime={handleAddRemoteAnime}
              showToast={showToast}
            />
          )}

          {activeTab === "nowplaying" && settings && (
            <NowPlayingView
              activeSession={activeSession}
              animeList={animeList}
              settings={settings}
              onUpdateSettings={handleUpdateSettings}
              onLinkDetectedEpisode={handleLinkDetectedEpisode}
              onDismissSession={handleDismissSession}
              onOpenAnime={openAnime}
              onStepEpisode={handleStepEpisode}
              onBatchUpdate={handleBatchUpdate}
              onBatchDelete={handleBatchDelete}
              onSearchTorrents={(q) => {
                setTorrentSearchQuery(q);
                setActiveTab("torrents");
              }}
              onDeleteAnime={handleDeleteAnime}
              showToast={showToast}
            />
          )}

          {activeTab === "history" && (
            <HistoryView
              animeList={animeList}
              refreshKey={animeList}
              onOpenAnime={openAnime}
            />
          )}

          {activeTab === "stats" && (
            <StatsView
              animeList={animeList}
              refreshKey={animeList}
              onOpenAnime={openAnime}
              onOpenStatus={openStatusList}
            />
          )}

          {activeTab === "settings" && settings && (
            <SettingsView
              settings={settings}
              onUpdateSettings={handleUpdateSettings}
              animeList={animeList}
              libraryRefreshTick={libraryRefreshTick}
              onRefreshAnimeList={() => refreshAnimeList()}
              onSelectAnime={(a) => setSelectedAnime(a)}
              showToast={showToast}
            />
          )}
        </main>
      </div>

      {/* Rich Anime Detail Slide-over Modal */}
      {selectedAnime && (
        <AnimeDetailModal
          anime={selectedAnime}
          inList={animeList.some((a) => a.id === selectedAnime.id)}
          onAddToList={(status) => handleAddRemoteAnime(selectedAnime, status)}
          onClose={() => setSelectedAnime(null)}
          onUpdated={(updated) => {
            setAnimeList((prev) =>
              prev.map((a) => (a.id === updated.id ? updated : a))
            );
            setSelectedAnime(updated);
          }}
          onSavedInBackground={(updated) =>
            setAnimeList((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
          }
          onDeleted={(deletedId) => {
            setAnimeList((prev) => prev.filter((a) => a.id !== deletedId));
            setSelectedAnime(null);
            showToast("Removed anime from library", "info");
          }}
          onSearchTorrents={(q) => {
            setSelectedAnime(null);
            setTorrentSearchQuery(q);
            setActiveTab("torrents");
          }}
          showToast={showToast}
        />
      )}

      {/* Ctrl+K Command Palette */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        query={cmdQuery}
        onQueryChange={setCmdQuery}
        animeList={animeList}
        searchIndex={searchIndex}
        commands={paletteCommands}
        onOpenAnime={handleOpenAnimeFromPalette}
        onSearchAniList={openGlobalSearch}
        getAnimeActions={(anime) =>
          buildAnimeActions(anime, {
            onStepEpisode: handleStepEpisode,
            onBatchUpdate: handleBatchUpdate,
            onOpenDetails: openAnime,
            onSearchTorrents: (q) => {
              setTorrentSearchQuery(q);
              setActiveTab("torrents");
            },
            onDeleteAnime: handleDeleteAnime,
            showToast,
            customLists: customListsApi,
          })
        }
      />

      {/* Sign Out Confirmation Modal */}
      {signOutModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setSignOutModalOpen(false)}
        >
          <div
            className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 max-w-sm w-full shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <LogOut className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-text-primary">
                  Sign out of AniList?
                </h3>
                <p className="text-[11px] text-text-muted">
                  @{settings?.anilist_username || "AniList Account"}
                </p>
              </div>
            </div>

            <p className="text-xs text-text-secondary leading-relaxed">
              Are you sure you want to sign out? Your local anime library and settings will remain intact, but automatic AniList synchronization will stop until you sign in again.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                onClick={() => setSignOutModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold border border-border-subtle transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSignOut}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow-sm cursor-pointer"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-2xl border text-xs font-semibold flex items-center gap-2.5 transition-all ${toast.type === "error"
            ? "bg-red-950/95 border-red-500 text-red-200"
            : toast.type === "success"
              ? "bg-emerald-950/95 border-emerald-500 text-emerald-200"
              : "bg-bg-elevated border-accent text-text-primary"
            }`}
        >
          <Sparkles className="w-4 h-4 text-accent shrink-0" />
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
    </CustomListsContext.Provider>
    </TitleLanguageContext.Provider>
  );
};
