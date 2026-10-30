# Changelog

## v0.3.0

> [!WARNING]
> **Still on v0.1.0? Download this version manually.** v0.1.0 has no auto-update. Install the setup below, settings are kept. From v0.2.0 on, Tora updates itself.

Everything new since v0.1.0:

### Settings
- Settings opens as a window over the current tab instead of being its own tab: use the gear button, **Ctrl+9** or **Open Settings** in Quick Jump.
- **Select all / Deselect all** buttons for the supported media players.

### Playback and list updates
- **Update mode**: *Automatic* (as before: count down, then update your list) or *Manual* (Now Playing offers an **Update to episode N** button while the episode is playing).
- New Automatic options:
  - **Wait for the media player to close**: update once you close the player or move to another file.
  - **Media player must be in focus**: the countdown only runs while the player is the active window.
- The countdown now ticks down one second at a time.
- The default delay before updating is now **120 seconds**. If you already set your own, it's kept.

### Discord
- **Discord Rich Presence**: your profile shows *Watching \<anime\>* with the cover, the episode, the elapsed time and **View on AniList** / **Get Tora** buttons. On by default; turn it off in Settings → Playback & Detection.

### Updates
- **Automatic updates**: Tora checks GitHub on startup and offers new versions (release notes, Later, Update & restart). Click the version number in the sidebar to check by hand. A dot there means an update or unread release notes are waiting.
- **Changelog** window with every release's notes.
- **anime-relations** (sequel episode numbering) updates itself from GitHub when a newer copy is available.
- A startup-check toggle in Settings → About.

### Watchlist
- **Keyboard navigation**: start typing anywhere to search, **↓** moves into the results, arrows move between anime, **Enter** opens one, **Esc** steps back one layer at a time.
- **Ctrl+1–8** switch tabs (hold Ctrl to see the numbers), **?** shows every shortcut.
- **16 sort options** with a direction toggle, and sortable table headers.
- "Last updated" on every card and an Updated column in the table.
- Grid covers show AniList's average score with yours below it.
- Create and delete AniList **custom lists** from the Lists dropdown.
- The toolbar stays pinned while you scroll.
- Better fuzzy search in the watchlist and Quick Jump.

### General
- Tora's data now lives in `%APPDATA%\Tora` (it was `%APPDATA%\app.tora.anime`). The first launch moves everything over by itself.
- **F11** toggles fullscreen.
- The app no longer behaves like a web browser: no browser right-click menu (except in text fields), and no Ctrl+J downloads panel, Ctrl+F find, Ctrl+P print, reload or back/forward navigation.

### Fixes
- **Play Next** is hidden in the anime drawer once every episode is watched.
- Ctrl+ or Shift+double-clicking an anime to select and deselect it no longer opens its details.
- The default torrent search feeds are now called **Nyaa – English** and **Nyaa – All**.
