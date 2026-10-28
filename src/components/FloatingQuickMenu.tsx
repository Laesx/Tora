import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Window event that closes every open right-click menu (e.g. when the command palette opens). */
export const CLOSE_MENUS_EVENT = "tora:close-menus";

/** Portal that keeps a context menu inside the viewport and closes it on outside click / Escape / scroll. */
export const FloatingQuickMenu: React.FC<{
  anchor: { x: number; y: number };
  onClose: () => void;
  children: React.ReactNode;
}> = ({ anchor, onClose, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ top: anchor.y, left: anchor.x });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - rect.width - 8, anchor.x)),
        top: Math.max(8, Math.min(window.innerHeight - rect.height - 8, anchor.y)),
      });
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = (e: Event) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener(CLOSE_MENUS_EVENT, onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener(CLOSE_MENUS_EVENT, onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: position.top, left: position.left, zIndex: 100 }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
};
