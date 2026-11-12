# Changelog

## v0.7.0

> [!WARNING]
> **Restart Tora once after the first launch.** This version rebuilds how your library files are matched to your anime. The first launch re-matches every file on its own (a few seconds), but some anime may not show their new episodes and progress strips until Tora is restarted. Close it (from the tray too, if you use it) and open it again.

This release also includes an **emergency fix for library matching**. Episodes could end up on the wrong anime, for example *Unlimited Blade Works* episodes showing under *Fate/stay night*, or a sequel's episodes under its first season, and a rescan could not fix them.

### Library matching (hotfix)
- Each file is matched by what its own name says first. A file named after a sequel goes to the sequel even when it sits in the first season's folder.
- **Linked folders** work by whole folder names, use the nearest linked folder, and can be shared by several anime (two seasons in one folder). A folder link only decides for files whose names match no title.
- Folders are only linked automatically from files that name the anime, never from a folder name that only looks similar (no more tool or extras folders linked to random anime).
- Sequel numbering (episode 13 → season 2 episode 1) is only applied when the number doesn't exist in the anime the file names. A valid episode is never moved.
- Names that fit several different anime about equally (*"Fate"*) stay unmatched instead of picking one, and a file is never put on another season of the same show.
- **Specials, openings, endings and extras** stay attached to their anime but no longer count as episodes.
- **Rescan (F5)** now matches every file again, so it repairs wrong matches.
- Now Playing uses the same match as the Library for files in your library folders.
- Better file name reading: "Title 13 - Episode title", accents (*Traumend* = *Träumend*), a year in the name picking the right remake, and a few names that were misread before.
- The Library's episode table shows what decided each match when you hover it.
- A few files that were matched before may now be unmatched (for example `S03E01` names when no list title says season 3). Link them once from Now Playing and they stay linked.

### Tray and startup
- **System tray** icon with the anime playing now, Show, a playback detection toggle and Quit.
- **Minimize or close to the tray**, and **start with Windows** (optionally straight into the tray). Settings → System.
- Opening Tora a second time brings back the running window instead of starting another copy.
- The window remembers its size, position and maximized state.

### Watchlist
- **Drag anime onto a status** to move them: drag a card or row (or your selection) and drop it on the status board. Esc cancels.
- New **table columns**: Score (pick a score right in the cell), Average, Started, Completed, Next episode, On disk, Time left and Notes. Score and Average are shown by default; the rest are in the header's right-click menu. Every column sorts.
- **Drag headers to reorder** the table columns.
- The poster grid adds columns on wide or fullscreen windows instead of growing the posters, and the Watchlist uses the whole window width.

### Now Playing and Stats
- **Skip openings and endings in time left** (Settings → Playback & Detection): time-left estimates leave out about 3 minutes per episode.
- **Continue Watching** can be filtered by a custom list.
- History and Stats use more of the window width.

### Fixes
- Fixed an error when right-clicking near the right edge of the watchlist table.
- Right-clicking the rounded corner of a menu no longer opens the browser's menu.

## v0.5.0

### History
- **AniList activity import** (opt-in, Settings → Tracker): bring in your AniList episode history, newest first, paced for AniList's rate limit. It pauses on errors, resumes on its own at startup, and stays up to date after each sync. Tora's own history always wins when both know an episode.
- History has **All / AniList / Local** sections, title search (with a clear button) and loads as you scroll.
- **Period picker**: jump to a day, month, season or year, or shift-click a range. Months are shaded by episodes watched.
- Per-anime **episode timeline**: one compact row per day, split into watch-throughs, so rewatches are easy to tell apart.
- **Stats** can include AniList-only episodes, and clicking a heatmap day or month bar opens that period in History.

### Navigation
- **Back / forward** like a browser: sidebar arrows, **Alt+←/→**, mouse back/forward buttons, or Quick Jump. Each step restores the tab's state, the open anime panel and your scroll position.
- Reworked sidebar header: version under the name, Back / Forward and Settings beside it, Quick Jump as a full-width bar.
- Quick Jump now opens with **Ctrl+S**.

### Watchlist and details list
- Fixed the **black screen when scrolling the table**; rows are now a fixed height.
- Table columns keep their widths: resize them by dragging a header edge (double-click resets), hide them with a right-click on the header. Saved per device.
- The table header stays pinned, and the Season cell opens that season in Seasons.
- **−/+ buttons** next to the progress bar in the table and detailed cards (on hover in the poster grid).
- Detailed cards show the next airing and genres instead of the synopsis.
- **Alt+1–6** switch status tabs and **Alt+Q/W/E** switch views (hold Alt to see the keys).
- Scores are shown and edited in your **AniList score format** (100, 10, 5 stars, smileys…).

### Stability and diagnostics
- A crash in one tab shows a message with *Try again* / *Reload* instead of a blank window.
- Log file in `%APPDATA%\Tora\logs`; Settings → Diagnostics → Logs opens it.
- Settings → Diagnostics → **Memory** shows what Tora and each WebView2 process use.
- Lower memory while the window is minimized.
- Tora's data folder is now `%APPDATA%\Tora`; existing data is moved automatically.


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
