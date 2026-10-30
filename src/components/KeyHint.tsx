import React from "react";

/**
 * Key badge shown while a modifier is held (`useModifierHint`): Ctrl digits on the sidebar, Alt keys
 * on the watchlist toolbar. Position it with `className` (it is absolutely positioned).
 */
export const KeyHint: React.FC<{ label: string; visible: boolean; className?: string }> = ({
  label,
  visible,
  className = "",
}) => (
  <kbd
    aria-hidden={!visible}
    className={`absolute pointer-events-none px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-primary text-text-primary border border-border-subtle shadow-sm whitespace-nowrap transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"} ${className}`}
  >
    {label}
  </kbd>
);
