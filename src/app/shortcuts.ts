/**
 * Every keyboard / mouse shortcut, as shown in the shortcuts sheet (`ShortcutsModal`, opened with
 * ? or the sidebar keyboard button). Add an entry here whenever a handler gains a shortcut.
 */
export interface Shortcut {
  /** Alternatives; each is a combo whose keys are joined with "+" (e.g. "Ctrl+K") */
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    items: [
      { keys: ["Ctrl+K"], label: "Quick Jump (command palette)" },
      { keys: ["Ctrl+1–8"], label: "Go to a sidebar tab (hold Ctrl to see the numbers)" },
      { keys: ["Ctrl+9"], label: "Open Settings" },
      { keys: ["F5"], label: "Rescan library folders" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
      { keys: ["Esc"], label: "Close the topmost window, menu or drawer" },
    ],
  },
  {
    title: "Anime Watchlist",
    items: [
      { keys: ["A–Z"], label: "Start typing to search every list" },
      { keys: ["↓"], label: "In the search box: move to the results" },
      { keys: ["Enter"], label: "In the search box: open the top result" },
      { keys: ["←", "→"], label: "Previous / next anime" },
      { keys: ["↑", "↓"], label: "Row above / below (↑ on the first row: back to the search box)" },
      { keys: ["Backspace"], label: "Back to the search box, deleting a character" },
      { keys: ["Enter"], label: "Open the selected anime" },
      { keys: ["Esc"], label: "During a search: back to the search box; else deselect" },
      { keys: ["Ctrl+A"], label: "Select every anime in the view" },
      { keys: ["Ctrl+Click"], label: "Add to / remove from the selection" },
      { keys: ["Shift+Click"], label: "Select a range" },
      { keys: ["Double-click"], label: "Open details" },
      { keys: ["Middle-click"], label: "Play the next episode from disk" },
      { keys: ["Right-click"], label: "Quick menu (applies to the whole selection)" },
      { keys: ["Del"], label: "In the Lists dropdown: delete the highlighted list" },
    ],
  },
  {
    title: "Quick Jump",
    items: [
      { keys: ["↑", "↓"], label: "Move through results" },
      { keys: ["PgUp", "PgDn"], label: "Jump 10 results" },
      { keys: ["Enter"], label: "Open / run" },
      { keys: ["Tab"], label: "Switch Anime / Commands" },
      { keys: ["→"], label: "Actions for the highlighted anime" },
      { keys: ["←"], label: "Back from actions" },
      { keys: ["Esc"], label: "Back / close" },
    ],
  },
  {
    title: "Seasons",
    items: [
      { keys: ["←", "→"], label: "Previous / next season" },
      { keys: ["Enter"], label: "In the filter box: search AniList for the text" },
    ],
  },
];
