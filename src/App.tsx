import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimeEntry, AppSettings, DetectedMediaSession, ScanSummary } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { applyThemeToDocument } from "@/lib/theme";
import { plural } from "@/lib/format";
import { SEASONS, SeasonName } from "@/lib/seasons";
import { WATCHLIST_TABS } from "@/lib/status";
import { animeTitle, setCurrentTitleLanguage, TitleLanguageContext } from "@/contexts/titles";
import { CustomListsContext } from "@/contexts/customLists";
import { ToastContext } from "@/contexts/toast";
import { ScoreFormatContext } from "@/contexts/scoreFormat";
import { DEFAULT_SCORE_FORMAT, parseScoreFormat, ScoreFormat } from "@/lib/scores";
import { AnimeActions, AnimeActionsContext } from "@/contexts/animeActions";
import { NAV_ITEMS, NavTab } from "@/app/nav";
import { captureView, NavCapture, NavLocation, sameLocation } from "@/app/navigation";
import { useNavHistory } from "@/app/useNavHistory";
import { Navigation, NavigationContext } from "@/contexts/navigation";
import { Sidebar } from "@/app/Sidebar";
import { NowPlayingBanner } from "@/app/NowPlayingBanner";
import { SignOutModal } from "@/app/SignOutModal";
import { ShortcutsModal } from "@/app/ShortcutsModal";
import { ChangelogModal } from "@/app/ChangelogModal";
import { UpdatePromptModal } from "@/app/UpdatePromptModal";
import { useAppUpdater } from "@/app/useAppUpdater";
import { Toast, useToastState } from "@/app/Toast";
import { useAnimeList } from "@/app/useAnimeList";
import { useEpisodeStepper } from "@/app/useEpisodeStepper";
import { useCustomListsState } from "@/app/useCustomListsState";
import { useAniListHistoryState } from "@/app/useAniListHistory";
import { AniListHistoryContext } from "@/contexts/anilistHistory";
import { AniListImportModal } from "@/features/history/AniListImportModal";
import { useTrackerSync } from "@/app/useTrackerSync";
import { useMediaPoll } from "@/app/useMediaPoll";
import { useAppEvents } from "@/app/useAppEvents";
import { useGlobalShortcuts } from "@/app/useGlobalShortcuts";
import { useModifierHint } from "@/app/useModifierHint";
import { useBrowserGuards } from "@/app/useBrowserGuards";
import { buildPaletteCommands } from "@/app/paletteCommands";
import { useWatchlist } from "@/features/watchlist/useWatchlist";
import { ViewMode, WatchlistView } from "@/features/watchlist/WatchlistView";
import type { WatchlistNav } from "@/features/watchlist/VirtualWatchlist";
import { AnimeDetailModal } from "@/features/detail/AnimeDetailModal";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { CLOSE_MENUS_EVENT } from "@/components/FloatingQuickMenu";
import { TorrentsRequest, TorrentsView } from "@/features/torrents/TorrentsView";
import { NowPlayingView } from "@/features/nowplaying/NowPlayingView";
import { HistoryView } from "@/features/history/HistoryView";
import { StatsView } from "@/features/stats/StatsView";
import { SeasonRequest, SeasonsView } from "@/features/seasons/SeasonsView";
import type { HistoryRequest } from "@/features/history/period";
import { ScheduleRequest, ScheduleView } from "@/features/schedule/ScheduleView";
import { SearchRequest, SearchView } from "@/features/search/SearchView";
import type { SettingsSection } from "@/features/settings/SettingsView";
import { SettingsModal } from "@/features/settings/SettingsModal";
import { log } from "@/lib/log";
import { ErrorBoundary } from "@/app/ErrorBoundary";

export const App: React.FC = () => {
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const watchlistSearchRef = useRef<HTMLInputElement | null>(null);
  const watchlistNavRef = useRef<WatchlistNav | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>("watchlist");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const titleLanguage = settings?.title_language ?? "romaji";
  setCurrentTitleLanguage(titleLanguage);
  const titleOf = useCallback((a: AnimeEntry) => animeTitle(a, titleLanguage), [titleLanguage]);

  /* useBrowserGuards(); */ // Disabled for now since it has to be checked
  const [toast, showToast] = useToastState();
  const updater = useAppUpdater(showToast, settings ? settings.check_updates_on_startup !== false : null);
  const list = useAnimeList(showToast, titleOf);
  const { animeList, selectedAnime, setSelectedAnime } = list;
  const stepper = useEpisodeStepper(list.replaceEntries, showToast, titleOf);
  const customLists = useCustomListsState(animeList);
  const anilistHistory = useAniListHistoryState(settings, (next) => handleUpdateSettings(next), showToast);
  const watchlist = useWatchlist({
    animeList,
    stepSnapshots: stepper.snapshots,
    customListMembers: customLists.members,
    customListNames: customLists.names,
    hiddenFromStatusIds: customLists.hiddenFromStatusIds,
    titleOf,
  });

  // Hand-over requests to other tabs; `nonce` makes the same request apply again
  const [torrentSearch, setTorrentSearch] = useState<TorrentsRequest | null>(null);
  // Settings modal: open, at the requested section (null = Appearance)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState<{ section: SettingsSection; nonce: number } | null>(null);
  const [seasonRequest, setSeasonRequest] = useState<SeasonRequest | null>(null);
  const [historyRequest, setHistoryRequest] = useState<HistoryRequest | null>(null);
  const [scheduleRequest, setScheduleRequest] = useState<ScheduleRequest | null>(null);
  const [scoreFormat, setScoreFormat] = useState<ScoreFormat>(DEFAULT_SCORE_FORMAT);
  // Kept after it is handled: the Search tab searches it again when it mounts
  const [globalSearch, setGlobalSearch] = useState<SearchRequest | null>(null);

  // Back / forward: every jump between pages (tab, drawer, a view's own page) pushes where it left
  const nav = useNavHistory();
  const [scrollRestore, setScrollRestore] = useState<{ top: number; nonce: number } | null>(null);

  // Where the user is now: the tab's own state (registered by its view), the drawer and the scroll
  const currentLocation = (): NavLocation => {
    const captured: NavCapture =
      activeTab === "watchlist"
        ? {
          view: {
            tab: "watchlist",
            status: watchlist.statusFilter,
            customList: watchlist.customListFilter,
            search: watchlist.searchQuery,
          },
        }
        : captureView(activeTab) ?? { view: { tab: activeTab } as NavLocation["view"] };
    return {
      ...captured,
      drawer: selectedAnime,
      drawerInList: selectedAnime !== null && animeList.some((a) => a.id === selectedAnime.id),
      scrollTop: mainScrollRef.current?.scrollTop ?? 0,
    };
  };
  const currentLocationRef = useRef(currentLocation);
  currentLocationRef.current = currentLocation;
  // Before every jump; stable, so views can call it from the navigation context
  const remember = useCallback(() => nav.push(currentLocationRef.current()), [nav.push]);
  const navigation = useMemo<Navigation>(() => ({ remember }), [remember]);

  // Back / forward: each view takes its state back through its own request
  const applyLocation = (loc: NavLocation) => {
    closeTransientLayers();
    const { view, cache } = loc;
    const nonce = Date.now();
    // A view that registered nothing (it failed to render) only gets its tab back
    if (Object.keys(view).length > 1) {
      switch (view.tab) {
        case "watchlist":
          watchlist.restoreView(view.status, view.customList, view.search);
          break;
        case "history":
          setHistoryRequest({
            period: view.period,
            source: view.source,
            search: view.search,
            anime: view.anime,
            cache: cache?.tab === "history" ? { rows: cache.rows, hasMore: cache.hasMore } : undefined,
            nonce,
          });
          break;
        case "seasons":
          setSeasonRequest({ season: view.season, year: view.year, filter: view.filter, nonce });
          break;
        case "search":
          setGlobalSearch({
            query: view.query,
            cache: cache?.tab === "search" ? { results: cache.results, searched: cache.searched } : undefined,
            nonce,
          });
          break;
        case "torrents":
          setTorrentSearch({ search: view.search, subTab: view.subTab, nonce });
          break;
        case "schedule":
          setScheduleRequest({ weekStart: view.weekStart, nonce });
          break;
      }
    }
    setActiveTab(view.tab);
    // The entry's current copy; a list entry removed since then stays closed, a remote anime opens as it was
    const fresh = loc.drawer && animeList.find((a) => a.id === loc.drawer!.id);
    setSelectedAnime(fresh || (loc.drawer && !loc.drawerInList ? loc.drawer : null));
    setScrollRestore({ top: loc.scrollTop, nonce });
  };

  const stepNav = (dir: "back" | "forward") => {
    const target = nav.step(dir, currentLocation());
    if (target) applyLocation(target);
  };

  // Scroll back once the restored view is tall enough (it may still be loading or measuring);
  // any scroll input from the user stops it
  useEffect(() => {
    const el = mainScrollRef.current;
    if (!scrollRestore || !el) return;
    const { top } = scrollRestore;
    let frames = 0;
    let settled = 0;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const type of ["wheel", "mousedown", "keydown", "touchstart"]) el.removeEventListener(type, stop);
    };
    const tick = () => {
      el.scrollTop = top;
      settled = Math.abs(el.scrollTop - top) < 1 ? settled + 1 : 0;
      if (settled >= 3 || ++frames > 90) return stop();
      raf = requestAnimationFrame(tick);
    };
    for (const type of ["wheel", "mousedown", "keydown", "touchstart"]) el.addEventListener(type, stop, { passive: true });
    raf = requestAnimationFrame(tick);
    return stop;
  }, [scrollRestore]);

  // Tooltip of the Back / Forward buttons
  const locationLabel = (loc: NavLocation | undefined) => {
    if (!loc) return null;
    const tab = NAV_ITEMS.find((t) => t.id === loc.view.tab)?.label ?? loc.view.tab;
    const anime = loc.view.tab === "history" && loc.view.anime ? loc.view.anime.title : null;
    const drawer = loc.drawer ? titleOf(loc.drawer) : null;
    return [tab, anime, drawer].filter(Boolean).join(" · ");
  };
  const backLabel = locationLabel(nav.back[nav.back.length - 1]);
  const forwardLabel = locationLabel(nav.forward[nav.forward.length - 1]);

  const [cmdOpen, setCmdOpen] = useState(false);
  // Command palette text; kept across opens
  const [cmdQuery, setCmdQuery] = useState("");
  const [signOutModalOpen, setSignOutModalOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const showShortcutHints = useModifierHint("Control");
  const showWatchlistKeyHints = useModifierHint("Alt");
  const [isAuthorizingAnilist, setIsAuthorizingAnilist] = useState(false);
  const [libraryRefreshTick, setLibraryRefreshTick] = useState(0);
  // Sync requires an OAuth token; a bare username no longer counts as signed in
  const isSignedIn = Boolean(settings?.anilist_token?.trim());
  // Stats / History reload only when what they show can change (not on sync flags or metadata)
  const statsKey = useMemo(
    () =>
      animeList
        .map((a) => `${a.id}:${a.user_status}:${a.user_progress}:${a.user_score}:${a.local_episode_count}`)
        .join("|"),
    [animeList]
  );

  // Opening the palette closes any right-click menu (they render above it)
  useEffect(() => {
    if (!cmdOpen) return;
    list.setQuickMenuAnimeId(null);
    window.dispatchEvent(new Event(CLOSE_MENUS_EVENT));
  }, [cmdOpen]);

  // A scan or watcher batch: refetch only the entries it touched; the Library table reloads
  const applyScan = async (summary: ScanSummary) => {
    await list.refreshEntries(summary.changed_anime_ids);
    setLibraryRefreshTick((t) => t + 1);
  };

  // A pull's delta; entries with an in-flight +1 / -1 are left alone (their debounced save pushes again)
  const sync = useTrackerSync(
    (summary) => {
      stepper.cancel(summary.removed_ids);
      list.applyDelta(
        summary.changed.filter((e) => !stepper.isPending(e.id)),
        summary.removed_ids
      );
      if (summary.custom_lists_changed) customLists.refresh();
      if (summary.score_format) setScoreFormat(parseScoreFormat(summary.score_format));
    },
    showToast,
    animeList.length
  );

  // The list was updated from playback (countdown, Update button, or once the player closed)
  const handleScrobbled = (session: DetectedMediaSession) => {
    void list.refreshEntries([session.matched_anime_id!]);
    showToast(
      `Updated: ${session.matched_anime_title || session.parsed.anime_title} Episode ${session.parsed.episode_number ?? ""}!`,
      "success"
    );
  };

  const [activeSession, setActiveSession] = useMediaPoll({
    // Focus Now Playing when a new playback session is detected (Back returns to what was open)
    onNewSession: () => {
      if (activeTab !== "nowplaying") remember();
      setActiveTab("nowplaying");
    },
    onScrobbled: handleScrobbled,
  });

  const loadInitialData = async () => {
    try {
      const [s, entries] = await Promise.all([toraApi.getAppSettings(), toraApi.getAnimeList()]);
      setSettings(s);
      applyThemeToDocument(s.theme, s.accent_color);
      list.setList(entries);
      if (s.settings_recovered) {
        showToast("Your settings couldn't be read, so defaults are in use. Restore a backup in Settings → About.", "error");
      }
      customLists.refresh();
      anilistHistory.load();
      toraApi
        .getScoreFormat()
        .then((f) => setScoreFormat(parseScoreFormat(f)))
        .catch(() => { });
      sync.loadStatus();

      // Hydrate the AniList avatar / username in the background if signed in without them
      if (s.anilist_token && (!s.anilist_avatar || !s.anilist_username)) {
        toraApi
          .verifyTrackerAccount(s.active_tracker_plugin || "anilist", s.anilist_username || "", s.anilist_token || null)
          .then(async () => setSettings(await toraApi.getAppSettings()))
          .catch(() => { });
      }

      // Fast delta startup scan in the background, without blocking the first render
      toraApi
        .quickScanLibrary()
        .then(async (summary) => {
          if (summary.newly_parsed > 0 || (summary.removed_files ?? 0) > 0) await applyScan(summary);
        })
        .catch(() => { });
    } catch (e) {
      log.error("app", "Failed to initialize Tora", e);
    }
  };

  useAppEvents({
    ready: loadInitialData,
    // Folder watcher: episodes downloaded or removed
    libraryChanged: async (summary) => {
      await applyScan(summary);
      if (summary.newly_parsed > 0) {
        showToast(`Detected ${plural(summary.newly_parsed, "new episode")} in library folders`, "success");
      }
    },
    torrentAutoDownloaded: async ({ count, failed, bound_anime_ids }) => {
      if (count > 0) showToast(`Auto-downloaded ${plural(count, "new episode")}`, "success");
      if (failed.length) showToast(`Auto-download failed: ${failed.join(" · ")}`, "error");
      if (bound_anime_ids?.length) await list.refreshEntries(bound_anime_ids);
    },
    authUpdated: (next) => {
      setSettings(next);
      setIsAuthorizingAnilist(false);
      if (next.anilist_username) showToast(`Signed in to AniList as @${next.anilist_username}!`, "success");
    },
    syncStarted: sync.onStarted,
    listSynced: sync.onSynced,
    syncFailed: sync.onFailed,
    // A background push/delete failed; the entry stays queued and retries on next sync
    syncError: ({ operation, title, message }) =>
      showToast(`AniList ${operation} failed for "${title}": ${message} — will retry on next sync`, "error"),
    authInvalid: () => {
      showToast("AniList session expired or was revoked — please sign in again", "error");
      // Pick up any token the backend cleared
      toraApi.getAppSettings().then(setSettings).catch(() => { });
    },
    // A different AniList account signed in: the previous account's list was wiped and the new
    // account's list is imported next (it arrives through tracker-list-synced)
    accountSwitched: ({ username, discarded_changes }) => {
      stepper.cancel();
      nav.clear();
      list.clear();
      sync.clearLastSynced();
      customLists.clear();
      anilistHistory.load();
      setScoreFormat(DEFAULT_SCORE_FORMAT);
      showToast(
        discarded_changes > 0
          ? `Switched to @${username}. ${plural(discarded_changes, "unsent change")} from the previous account ${discarded_changes === 1 ? "was" : "were"} discarded.`
          : `Switched to @${username}. Importing their AniList list…`,
        discarded_changes > 0 ? "error" : "info"
      );
    },
    // A background push succeeded: replace the entry (clears sync_pending), unless a +1 / -1 is in flight
    entrySynced: ({ entry }) => {
      if (!stepper.isPending(entry.id)) list.replaceEntries([entry]);
    },
    relationsUpdated: ({ last_modified }) => showToast(`Anime relations updated (${last_modified})`, "success"),
    playbackScrobbled: handleScrobbled,
    historyProgress: anilistHistory.onProgress,
    historyUpdated: anilistHistory.onUpdated,
  });

  const handleUpdateSettings = async (next: AppSettings) => {
    setSettings(next);
    setSettings(await toraApi.saveAppSettings(next));
  };

  const openSettings = (section?: SettingsSection) => {
    setSettingsRequest(section ? { section, nonce: Date.now() } : null);
    setSettingsOpen(true);
  };

  const openGlobalSearch = (q: string) => {
    remember();
    setGlobalSearch({ query: q, nonce: Date.now() });
    setActiveTab("search");
  };

  // Show one season in the Seasons tab (from the drawer / Now Playing); closes the drawer
  const openSeason = (season: string, year: number) => {
    if (!(SEASONS as readonly string[]).includes(season)) return;
    remember();
    setSelectedAnime(null);
    setSeasonRequest({ season: season as SeasonName, year, nonce: Date.now() });
    setActiveTab("seasons");
  };

  // Ctrl+1–8 / Ctrl+9 close the palette and any open menu first (the drawer isn't tab-bound)
  const closeTransientLayers = () => {
    setCmdOpen(false);
    setShortcutsOpen(false);
    list.setQuickMenuAnimeId(null);
    window.dispatchEvent(new Event(CLOSE_MENUS_EVENT));
  };

  const navigateTo = (tab: NavTab) => {
    closeTransientLayers();
    setSettingsOpen(false);
    if (tab !== activeTab) remember();
    setActiveTab(tab);
  };

  const showInWatchlist = (show: () => void) => {
    remember();
    setActiveTab("watchlist");
    show();
  };

  const setViewMode = (mode: ViewMode) => {
    if (activeTab !== "watchlist") remember();
    setActiveTab("watchlist");
    if (settings && settings.view_mode !== mode) void handleUpdateSettings({ ...settings, view_mode: mode });
  };

  const rescanInFlightRef = useRef(false);
  const handleRescanLibrary = async () => {
    if (rescanInFlightRef.current) return;
    rescanInFlightRef.current = true;
    showToast("Rescanning library folders…", "info");
    try {
      const sum = await toraApi.scanLibrary();
      await applyScan(sum);
      showToast(`Scanned ${sum.total_files_indexed} files in ${sum.elapsed_ms}ms`, "success");
    } catch (err) {
      showToast(String(err), "error");
    } finally {
      rescanInFlightRef.current = false;
    }
  };

  const handleSyncFromAnilist = () => {
    if (!isSignedIn) showToast("Sign in to AniList in Settings to sync", "info");
    else void sync.syncNow();
  };

  const handleStartAnilistLogin = async () => {
    try {
      setIsAuthorizingAnilist(true);
      await toraApi.startAnilistOauth();
      showToast("Opened AniList in your browser — click Authorize to sign in", "info");
    } catch (err) {
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
          ? `Signed out of AniList. ${plural(unsent, "change")} couldn't be sent; ${unsent === 1 ? "it" : "they"} will be sent next time this account signs in.`
          : "Signed out of AniList",
        unsent > 0 ? "error" : "info"
      );
    } catch (err) {
      showToast(String(err), "error");
    }
  };

  const handleOpenAnilistProfile = () => {
    if (!settings?.anilist_username) return;
    const url = `https://anilist.co/user/${encodeURIComponent(settings.anilist_username.trim())}`;
    toraApi.openExternalUrl(url).catch((err) => showToast(String(err), "error"));
  };

  const dismissSession = async () => {
    await toraApi.dismissPlaybackSession();
    setActiveSession(null);
  };

  const confirmPlaybackUpdate = async () => {
    try {
      const session = await toraApi.confirmPlaybackUpdate();
      setActiveSession(session);
      if (session?.auto_synced) handleScrobbled(session);
    } catch (err) {
      showToast(String(err), "error");
    }
  };

  const openAnime = (anime: AnimeEntry) => {
    if (selectedAnime?.id !== anime.id) remember();
    setSelectedAnime(animeList.find((a) => a.id === anime.id) ?? anime);
  };

  // Closing the drawer drops the history entry its opening added (closing isn't a page of its own)
  const closeDrawer = () => {
    const top = nav.back[nav.back.length - 1];
    if (top && sameLocation(top, { ...currentLocation(), drawer: null })) nav.dropTop();
    setSelectedAnime(null);
  };

  const openRandomAnime = () => {
    const items = watchlist.filteredAnime;
    if (items.length === 0) return showToast("The current list is empty", "info");
    remember();
    setActiveTab("watchlist");
    setSelectedAnime(items[Math.floor(Math.random() * items.length)]);
  };

  // Palette pick: show the anime in the watchlist (palette text in its search box, or its own
  // list when there is no text), scroll to and select it, and open its details
  const handleOpenAnimeFromPalette = (anime: AnimeEntry) => {
    const entry = animeList.find((a) => a.id === anime.id) ?? anime;
    remember();
    setActiveTab("watchlist");
    watchlist.focusAnime(entry, cmdQuery.trim());
    setSelectedAnime(entry);
  };

  // One stable context object whose functions call this render's handlers
  const latestActions = useRef<AnimeActions | null>(null);
  latestActions.current = {
    openAnime,
    stepEpisode: stepper.stepEpisode,
    batchUpdate: list.batchUpdate,
    changeStatus: (anime, status, label) =>
      list.batchUpdate({ anime_ids: [anime.id], user_status: status }, `Moved "${titleOf(anime)}" to ${label}`),
    batchDelete: list.batchDelete,
    deleteAnime: list.deleteAnime,
    addAnime: list.addAnime,
    searchTorrents: (req) => {
      remember();
      setSelectedAnime(null);
      setTorrentSearch({ search: req, nonce: Date.now() });
      setActiveTab("torrents");
    },
    openSeason,
  };
  const animeActions = useMemo<AnimeActions>(() => {
    const latest = () => latestActions.current!;
    return {
      openAnime: (a) => latest().openAnime(a),
      stepEpisode: (a, delta) => latest().stepEpisode(a, delta),
      batchUpdate: (patch, msg) => latest().batchUpdate(patch, msg),
      changeStatus: (a, status, label) => latest().changeStatus(a, status, label),
      batchDelete: (targets) => latest().batchDelete(targets),
      deleteAnime: (a) => latest().deleteAnime(a),
      addAnime: (entry, status) => latest().addAnime(entry, status),
      searchTorrents: (req) => latest().searchTorrents(req),
      openSeason: (season, year) => latest().openSeason(season, year),
    };
  }, []);

  useGlobalShortcuts({
    onWatchlist: activeTab === "watchlist",
    drawerOpen: selectedAnime !== null,
    paletteOpen: cmdOpen,
    signOutOpen: signOutModalOpen,
    shortcutsOpen,
    settingsOpen,
    updateModalOpen: updater.promptOpen || updater.changelogOpen,
    quickMenuOpen: list.quickMenuAnimeId !== null,
    selectedAnimeIds: list.selectedAnimeIds,
    visibleAnime: watchlist.filteredAnime,
    animeList,
    getSearchInput: () => watchlistSearchRef.current,
    searchQuery: watchlist.searchQuery,
    searchSettled: watchlist.deferredSearchQuery === watchlist.searchQuery,
    setSearchQuery: watchlist.setSearchQuery,
    togglePalette: () => setCmdOpen((prev) => !prev),
    closePalette: () => setCmdOpen(false),
    closeSignOut: () => setSignOutModalOpen(false),
    closeUpdateModal: () => (updater.promptOpen ? updater.closePrompt() : updater.closeChangelog()),
    openShortcuts: () => setShortcutsOpen(true),
    closeShortcuts: () => setShortcutsOpen(false),
    closeSettings: () => setSettingsOpen(false),
    closeQuickMenu: () => list.setQuickMenuAnimeId(null),
    closeDrawer,
    openAnime,
    goBack: () => stepNav("back"),
    goForward: () => stepNav("forward"),
    setSelectedAnimeIds: list.setSelectedAnimeIds,
    moveSelection: (dir) => watchlistNavRef.current?.move(dir) ?? false,
    enterList: () => watchlistNavRef.current?.enter() ?? false,
    navigate: navigateTo,
    setViewMode: (mode) => {
      if (settings) setViewMode(mode);
    },
    showStatusTab: (index) => {
      const tab = WATCHLIST_TABS[index];
      if (tab) watchlist.showStatus(tab.id);
    },
    openSettings: () => {
      closeTransientLayers();
      openSettings();
    },
    rescanLibrary: () => void handleRescanLibrary(),
  });

  const paletteCommands = buildPaletteCommands({
    navigate: navigateTo,
    goBack: backLabel ? () => stepNav("back") : null,
    goForward: forwardLabel ? () => stepNav("forward") : null,
    openSettings: () => openSettings(),
    openTorrentSettings: () => openSettings("torrents"),
    rescanLibrary: () => void handleRescanLibrary(),
    syncFromAnilist: handleSyncFromAnilist,
    openRandomAnime,
    openShortcuts: () => setShortcutsOpen(true),
    checkForUpdates: () => void updater.checkForUpdates(true),
    openChangelog: updater.openChangelog,
    customListNames: customLists.names,
    openCustomList: (name) => showInWatchlist(() => watchlist.showCustomList(name)),
    setViewMode,
    setTheme: (theme, accent) => {
      if (!settings) return;
      applyThemeToDocument(theme, accent);
      void handleUpdateSettings({ ...settings, theme, accent_color: accent });
    },
  });

  return (
    <TitleLanguageContext.Provider value={titleLanguage}>
      <ToastContext.Provider value={showToast}>
        <CustomListsContext.Provider value={customLists.api}>
          <AniListHistoryContext.Provider value={anilistHistory.api}>
            <AnimeActionsContext.Provider value={animeActions}>
              <NavigationContext.Provider value={navigation}>
                <ScoreFormatContext.Provider value={scoreFormat}>
                  <div
                    className="flex h-screen w-screen overflow-hidden bg-bg-primary text-text-primary select-none"
                    onClick={() => list.setQuickMenuAnimeId(null)}
                    onContextMenu={() => list.setQuickMenuAnimeId(null)}
                  >
                    <Sidebar
                      activeTab={activeTab}
                      onNavigate={navigateTo}
                      backLabel={backLabel}
                      forwardLabel={forwardLabel}
                      onBack={() => stepNav("back")}
                      onForward={() => stepNav("forward")}
                      onOpenSettings={() => openSettings()}
                      settingsOpen={settingsOpen}
                      onOpenPalette={() => setCmdOpen(true)}
                      onOpenShortcuts={() => setShortcutsOpen(true)}
                      showShortcutHints={showShortcutHints}
                      isPlaying={activeSession !== null}
                      listCount={animeList.length}
                      settings={settings}
                      isSignedIn={isSignedIn}
                      isAuthorizing={isAuthorizingAnilist}
                      onSignIn={handleStartAnilistLogin}
                      onSignOut={() => setSignOutModalOpen(true)}
                      onOpenProfile={handleOpenAnilistProfile}
                      version={updater.version}
                      updateDot={updater.showDot}
                      updateChecking={updater.checking}
                      onVersionClick={updater.onVersionClick}
                    />

                    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
                      {activeSession && activeTab !== "nowplaying" && (
                        <NowPlayingBanner
                          session={activeSession}
                          recognitionDelaySeconds={settings?.recognition_delay_seconds || 120}
                          onOpenNowPlaying={() => navigateTo("nowplaying")}
                          onConfirmUpdate={() => void confirmPlaybackUpdate()}
                          onDismiss={dismissSession}
                        />
                      )}

                      <main
                        ref={mainScrollRef}
                        // Reserve the scrollbar's space so content doesn't shift sideways when it appears/disappears
                        className="flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                        onClick={() => {
                          if (list.selectedAnimeIds.length > 0) list.setSelectedAnimeIds([]);
                        }}
                      >
                        {/* One crashing tab shows its error; the sidebar and other tabs keep working */}
                        <ErrorBoundary key={activeTab} scope={`tab:${activeTab}`}>
                          {activeTab === "watchlist" && (
                            <WatchlistView
                              watchlist={watchlist}
                              animeList={animeList}
                              customListNames={customLists.names}
                              customListCounts={customLists.counts}
                              onCreateCustomList={customLists.create}
                              onDeleteCustomList={customLists.remove}
                              viewMode={settings?.view_mode || "grid"}
                              onViewModeChange={settings ? setViewMode : undefined}
                              isSignedIn={isSignedIn}
                              isSyncing={sync.isSyncing}
                              lastSyncedAt={sync.lastSyncedAt}
                              onSync={handleSyncFromAnilist}
                              scrollContainerRef={mainScrollRef}
                              selectedAnimeIds={list.selectedAnimeIds}
                              onSetSelectedAnimeIds={list.setSelectedAnimeIds}
                              quickMenuAnimeId={list.quickMenuAnimeId}
                              onSetQuickMenuAnimeId={list.setQuickMenuAnimeId}
                              searchInputRef={watchlistSearchRef}
                              navRef={watchlistNavRef}
                              showKeyHints={showWatchlistKeyHints}
                            />
                          )}

                          {activeTab === "torrents" && (
                            <TorrentsView
                              animeList={animeList}
                              searchRequest={torrentSearch}
                              onRefreshAnimeList={list.refresh}
                              onOpenSettings={() => openSettings("torrents")}
                            />
                          )}

                          {activeTab === "seasons" && (
                            <SeasonsView
                              animeList={animeList}
                              scrollContainerRef={mainScrollRef}
                              keyboardEnabled={!selectedAnime && !cmdOpen && !signOutModalOpen && !shortcutsOpen && !settingsOpen}
                              onGlobalSearch={openGlobalSearch}
                              seasonRequest={seasonRequest}
                              onSeasonRequestHandled={() => setSeasonRequest(null)}
                            />
                          )}

                          {activeTab === "schedule" && (
                            <ScheduleView
                              animeList={animeList}
                              request={scheduleRequest}
                              onRequestHandled={() => setScheduleRequest(null)}
                            />
                          )}

                          {activeTab === "search" && <SearchView animeList={animeList} request={globalSearch} />}

                          {activeTab === "nowplaying" && settings && (
                            <NowPlayingView
                              activeSession={activeSession}
                              animeList={animeList}
                              settings={settings}
                              onUpdateSettings={handleUpdateSettings}
                              onLinkDetectedEpisode={async (animeId, aliasTitle) => {
                                const updated = await toraApi.linkDetectedEpisodeToAnime(animeId, aliasTitle);
                                if (updated) setActiveSession(updated);
                                await list.refresh();
                              }}
                              onConfirmUpdate={() => void confirmPlaybackUpdate()}
                              onDismissSession={dismissSession}
                              onOpenSeason={openSeason}
                            />
                          )}

                          {activeTab === "history" && (
                            <HistoryView
                              animeList={animeList}
                              refreshKey={statsKey}
                              request={historyRequest}
                              onRequestHandled={() => setHistoryRequest(null)}
                            />
                          )}

                          {activeTab === "stats" && (
                            <StatsView
                              animeList={animeList}
                              refreshKey={statsKey}
                              onOpenStatus={(status) => showInWatchlist(() => watchlist.showStatus(status))}
                              onOpenHistory={(period, source) => {
                                remember();
                                setHistoryRequest({ period, source, nonce: Date.now() });
                                setActiveTab("history");
                              }}
                            />
                          )}
                        </ErrorBoundary>
                      </main>
                    </div>

                    {selectedAnime && (
                      <AnimeDetailModal
                        anime={selectedAnime}
                        onOpenSeason={openSeason}
                        inList={animeList.some((a) => a.id === selectedAnime.id)}
                        onAddToList={(status) => list.addAnime(selectedAnime, status)}
                        onClose={closeDrawer}
                        onUpdated={(updated) => {
                          list.replaceEntries([updated]);
                          setSelectedAnime(updated);
                        }}
                        onSavedInBackground={(updated) => list.setAnimeList((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))}
                        onDeleted={(deletedId) => {
                          list.applyDelta([], [deletedId]);
                          showToast("Removed anime from library", "info");
                        }}
                      />
                    )}

                    {settingsOpen && settings && (
                      <SettingsModal
                        onClose={() => setSettingsOpen(false)}
                        settings={settings}
                        onUpdateSettings={handleUpdateSettings}
                        animeList={animeList}
                        libraryRefreshTick={libraryRefreshTick}
                        onRefreshAnimeList={list.refresh}
                        sectionRequest={settingsRequest}
                        onCheckForUpdates={() => void updater.checkForUpdates(true)}
                        updateChecking={updater.checking}
                        onOpenChangelog={updater.openChangelog}
                      />
                    )}

                    <CommandPalette
                      open={cmdOpen}
                      onClose={() => setCmdOpen(false)}
                      query={cmdQuery}
                      onQueryChange={setCmdQuery}
                      animeList={animeList}
                      searchIndex={watchlist.searchIndex}
                      commands={paletteCommands}
                      onOpenAnime={handleOpenAnimeFromPalette}
                      onSearchAniList={openGlobalSearch}
                    />

                    {signOutModalOpen && (
                      <SignOutModal
                        username={settings?.anilist_username}
                        onCancel={() => setSignOutModalOpen(false)}
                        onConfirm={handleConfirmSignOut}
                      />
                    )}

                    {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}

                    {anilistHistory.modalOpen && <AniListImportModal onClose={anilistHistory.closeModal} />}

                    {updater.promptOpen && updater.available && (
                      <UpdatePromptModal
                        currentVersion={updater.version}
                        newVersion={updater.available.version}
                        manifestNotes={updater.available.body}
                        progress={updater.progress}
                        onInstall={() => void updater.installUpdate()}
                        onViewChangelog={updater.openChangelog}
                        onLater={updater.closePrompt}
                      />
                    )}

                    {updater.changelogOpen && (
                      <ChangelogModal
                        version={updater.version}
                        availableVersion={updater.available?.version ?? null}
                        progress={updater.progress}
                        onInstall={() => void updater.installUpdate()}
                        onClose={updater.closeChangelog}
                      />
                    )}

                    {toast && <Toast toast={toast} />}
                  </div>
                </ScoreFormatContext.Provider>
              </NavigationContext.Provider>
            </AnimeActionsContext.Provider>
          </AniListHistoryContext.Provider>
        </CustomListsContext.Provider>
      </ToastContext.Provider>
    </TitleLanguageContext.Provider>
  );
};
