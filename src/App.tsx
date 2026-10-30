import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimeEntry, AppSettings, DetectedMediaSession, ScanSummary } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { applyThemeToDocument } from "@/lib/theme";
import { plural } from "@/lib/format";
import { SEASONS, SeasonName } from "@/lib/seasons";
import type { TorrentSearchRequest } from "@/lib/torrents";
import { animeTitle, setCurrentTitleLanguage, TitleLanguageContext } from "@/contexts/titles";
import { CustomListsContext } from "@/contexts/customLists";
import { ToastContext } from "@/contexts/toast";
import { AnimeActions, AnimeActionsContext } from "@/contexts/animeActions";
import { NavTab } from "@/app/nav";
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
import { useTrackerSync } from "@/app/useTrackerSync";
import { useMediaPoll } from "@/app/useMediaPoll";
import { useAppEvents } from "@/app/useAppEvents";
import { useGlobalShortcuts } from "@/app/useGlobalShortcuts";
import { useCtrlHint } from "@/app/useCtrlHint";
import { useBrowserGuards } from "@/app/useBrowserGuards";
import { buildPaletteCommands } from "@/app/paletteCommands";
import { useWatchlist } from "@/features/watchlist/useWatchlist";
import { ViewMode, WatchlistView } from "@/features/watchlist/WatchlistView";
import type { WatchlistNav } from "@/features/watchlist/VirtualWatchlist";
import { AnimeDetailModal } from "@/features/detail/AnimeDetailModal";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { CLOSE_MENUS_EVENT } from "@/components/FloatingQuickMenu";
import { TorrentsView } from "@/features/torrents/TorrentsView";
import { NowPlayingView } from "@/features/nowplaying/NowPlayingView";
import { HistoryView } from "@/features/history/HistoryView";
import { StatsView } from "@/features/stats/StatsView";
import { SeasonRequest, SeasonsView } from "@/features/seasons/SeasonsView";
import { ScheduleView } from "@/features/schedule/ScheduleView";
import { SearchView } from "@/features/search/SearchView";
import type { SettingsSection } from "@/features/settings/SettingsView";
import { SettingsModal } from "@/features/settings/SettingsModal";

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
  const watchlist = useWatchlist({
    animeList,
    stepSnapshots: stepper.snapshots,
    customListMembers: customLists.members,
    customListNames: customLists.names,
    hiddenFromStatusIds: customLists.hiddenFromStatusIds,
    titleOf,
  });

  // Hand-over requests to other tabs; `nonce` makes the same request apply again
  const [torrentSearch, setTorrentSearch] = useState<(TorrentSearchRequest & { nonce: number }) | null>(null);
  // Settings modal: open, at the requested section (null = Appearance)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState<{ section: SettingsSection; nonce: number } | null>(null);
  const [seasonRequest, setSeasonRequest] = useState<SeasonRequest | null>(null);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchRequest, setGlobalSearchRequest] = useState(0);

  const [cmdOpen, setCmdOpen] = useState(false);
  // Command palette text; kept across opens
  const [cmdQuery, setCmdQuery] = useState("");
  const [signOutModalOpen, setSignOutModalOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const showShortcutHints = useCtrlHint();
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
    // Focus Now Playing when a new playback session is detected
    onNewSession: () => setActiveTab("nowplaying"),
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
      console.error("Failed to initialize Tora:", e);
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
      list.clear();
      sync.clearLastSynced();
      customLists.clear();
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
    setGlobalSearchQuery(q);
    setGlobalSearchRequest((n) => n + 1);
    setActiveTab("search");
  };

  // Show one season in the Seasons tab (from the drawer / Now Playing); closes the drawer
  const openSeason = (season: string, year: number) => {
    if (!(SEASONS as readonly string[]).includes(season)) return;
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
    setActiveTab(tab);
  };

  const showInWatchlist = (show: () => void) => {
    setActiveTab("watchlist");
    show();
  };

  const setViewMode = (mode: ViewMode) => {
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

  const openAnime = (anime: AnimeEntry) => setSelectedAnime(animeList.find((a) => a.id === anime.id) ?? anime);

  const openRandomAnime = () => {
    const items = watchlist.filteredAnime;
    if (items.length === 0) return showToast("The current list is empty", "info");
    setActiveTab("watchlist");
    setSelectedAnime(items[Math.floor(Math.random() * items.length)]);
  };

  // Palette pick: show the anime in the watchlist (palette text in its search box, or its own
  // list when there is no text), scroll to and select it, and open its details
  const handleOpenAnimeFromPalette = (anime: AnimeEntry) => {
    const entry = animeList.find((a) => a.id === anime.id) ?? anime;
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
      setSelectedAnime(null);
      setTorrentSearch({ ...req, nonce: Date.now() });
      setActiveTab("torrents");
    },
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
    closeDrawer: () => setSelectedAnime(null),
    openAnime: setSelectedAnime,
    setSelectedAnimeIds: list.setSelectedAnimeIds,
    moveSelection: (dir) => watchlistNavRef.current?.move(dir) ?? false,
    enterList: () => watchlistNavRef.current?.enter() ?? false,
    navigate: navigateTo,
    openSettings: () => {
      closeTransientLayers();
      openSettings();
    },
    rescanLibrary: () => void handleRescanLibrary(),
  });

  const paletteCommands = buildPaletteCommands({
    navigate: setActiveTab,
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
          <AnimeActionsContext.Provider value={animeActions}>
            <div
              className="flex h-screen w-screen overflow-hidden bg-bg-primary text-text-primary select-none"
              onClick={() => list.setQuickMenuAnimeId(null)}
              onContextMenu={() => list.setQuickMenuAnimeId(null)}
            >
              <Sidebar
                activeTab={activeTab}
                onNavigate={setActiveTab}
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
                    onOpenNowPlaying={() => setActiveTab("nowplaying")}
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

                  {activeTab === "schedule" && <ScheduleView animeList={animeList} />}

                  {activeTab === "search" && (
                    <SearchView animeList={animeList} initialQuery={globalSearchQuery} searchRequestId={globalSearchRequest} />
                  )}

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

                  {activeTab === "history" && <HistoryView animeList={animeList} refreshKey={statsKey} />}

                  {activeTab === "stats" && (
                    <StatsView
                      animeList={animeList}
                      refreshKey={statsKey}
                      onOpenStatus={(status) => showInWatchlist(() => watchlist.showStatus(status))}
                    />
                  )}
                </main>
              </div>

              {selectedAnime && (
                <AnimeDetailModal
                  anime={selectedAnime}
                  onOpenSeason={openSeason}
                  inList={animeList.some((a) => a.id === selectedAnime.id)}
                  onAddToList={(status) => list.addAnime(selectedAnime, status)}
                  onClose={() => setSelectedAnime(null)}
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
          </AnimeActionsContext.Provider>
        </CustomListsContext.Provider>
      </ToastContext.Provider>
    </TitleLanguageContext.Provider>
  );
};
