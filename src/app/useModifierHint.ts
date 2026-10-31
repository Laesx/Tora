import { useEffect, useState } from "react";

/**
 * True while `modifier` is held on its own for `delayMs`: Ctrl → the sidebar's Ctrl+1–9 badges, Alt →
 * the watchlist's Alt+1–6 / Q W E badges. Any other key or a click hides it, so Ctrl+S, Ctrl+A,
 * Alt+Q or Ctrl+click never flash the badges.
 */
export function useModifierHint(modifier: "Control" | "Alt", delayMs = 400): boolean {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    const hide = () => {
      window.clearTimeout(timer);
      timer = undefined;
      setShow(false);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== modifier) return hide();
      const others = e.shiftKey || e.metaKey || (modifier === "Control" ? e.altKey : e.ctrlKey);
      if (e.repeat || others) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShow(true), delayMs);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === modifier) hide();
    };
    // Capture phase: inputs that stop propagation (palette, popovers) must still hide it
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("mousedown", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("mousedown", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [modifier, delayMs]);

  return show;
}
