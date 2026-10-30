import { useEffect } from "react";

const isEditable = (el: EventTarget | null) => {
  const target = el as HTMLElement | null;
  if (!target || !target.tagName) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(type);
};

/** Ctrl+<key> browser features (downloads, find, print, reload, source, history, save, find next) */
const BLOCKED_CTRL_KEYS = new Set(["j", "f", "p", "r", "u", "h", "s", "g"]);

/**
 * Keeps the webview from acting like a browser: no native right-click menu (except in text fields,
 * for cut / copy / paste), no Ctrl+J / Ctrl+F / Ctrl+P… panels, no Alt+← / → or mouse back / forward
 * navigation. Release builds also turn off WebView2's accelerator keys natively (`lib.rs` setup);
 * this covers dev builds and anything WebView2 lets JS cancel. App menus use their own
 * `onContextMenu` handlers, which still run.
 */
export function useBrowserGuards() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (!isEditable(e.target)) e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.altKey && BLOCKED_CTRL_KEYS.has(e.key.toLowerCase())) e.preventDefault();
      else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) e.preventDefault();
      else if (e.key === "F3" || e.key === "F7" || e.key === "BrowserBack" || e.key === "BrowserForward") e.preventDefault();
    };
    // Mouse buttons 4 / 5 (back / forward)
    const onMouseNav = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mouseup", onMouseNav, true);
    window.addEventListener("mousedown", onMouseNav, true);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mouseup", onMouseNav, true);
      window.removeEventListener("mousedown", onMouseNav, true);
    };
  }, []);
}
