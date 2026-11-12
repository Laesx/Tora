import React from "react";

/** A card of the anime page: title on the left, optional controls on the right. */
export const PageSection: React.FC<{
  title?: React.ReactNode;
  /** Controls next to the title (pickers, Show all, refresh) */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, aside, className = "", children }) => (
  <section className={`bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-3 min-w-0 ${className}`}>
    {(title || aside) && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title && <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">{title}</h3>}
        {aside && <div className="flex items-center gap-2">{aside}</div>}
      </div>
    )}
    {children}
  </section>
);
