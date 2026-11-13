import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { setSectionCollapsed, useSectionCollapsed } from "./sectionPrefs";

/**
 * A card of the anime page: title on the left, optional controls on the right. With an `id` the title
 * collapses it (remembered per device, for every anime); a collapsed section renders none of its content.
 */
export const PageSection: React.FC<{
  title?: React.ReactNode;
  /** Makes the section collapsible; the key of its remembered state */
  id?: string;
  /** Controls next to the title (pickers, Show all, refresh); hidden while collapsed */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, id, aside, className = "", children }) => {
  const collapsed = useSectionCollapsed(id);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section
      className={`bg-bg-secondary border border-border-subtle rounded-2xl p-5 min-w-0 ${collapsed ? "" : "space-y-3"} ${className}`}
    >
      {(title || aside) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title &&
            (id ? (
              <button
                type="button"
                onClick={() => setSectionCollapsed(id, !collapsed)}
                aria-expanded={!collapsed}
                title={collapsed ? "Show" : "Collapse"}
                className="text-sm font-bold text-text-primary flex items-center gap-2 hover:text-accent transition"
              >
                {title}
                <Chevron className="w-4 h-4 text-text-muted" />
              </button>
            ) : (
              <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">{title}</h3>
            ))}
          {aside && !collapsed && <div className="flex items-center gap-2">{aside}</div>}
        </div>
      )}
      {!collapsed && children}
    </section>
  );
};
