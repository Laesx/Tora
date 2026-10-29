import { useEffect, useState } from "react";

/**
 * True while Ctrl is held on its own for `delayMs` (the sidebar then shows its Ctrl+1–9 badges).
 * Any other key or a click hides it, so Ctrl+K, Ctrl+A or Ctrl+click never flash the badges.
 */
export function useCtrlHint(delayMs = 400): boolean {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    const hide = () => {
      window.clearTimeout(timer);
      timer = undefined;
      setShow(false);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== "Control") return hide();
      if (e.repeat || e.shiftKey || e.altKey || e.metaKey) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShow(true), delayMs);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Control") hide();
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
  }, [delayMs]);

  return show;
}
