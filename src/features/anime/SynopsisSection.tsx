import React, { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { PageSection } from "./PageSection";

/**
 * The synopsis, a few lines with the rest fading out under a "Read more" label; a click anywhere on it
 * expands or collapses it (not a click that selected text). A synopsis that already fits neither fades
 * nor toggles.
 */
export const SynopsisSection: React.FC<{ synopsis: string }> = ({ synopsis }) => {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1 || open);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [synopsis, open]);

  const toggle = () => {
    if (!overflows) return;
    if (window.getSelection()?.toString()) return;
    setOpen((v) => !v);
  };

  return (
    <PageSection title="Synopsis">
      <div
        onClick={toggle}
        title={overflows ? (open ? "Click to collapse" : "Click to read all") : undefined}
        className={`relative ${overflows ? "cursor-pointer" : ""}`}
      >
        <p
          ref={textRef}
          className={`text-xs leading-relaxed text-text-secondary whitespace-pre-line ${open ? "" : "max-h-24 overflow-hidden"}`}
        >
          {synopsis}
        </p>
        {overflows && !open && (
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg-secondary via-bg-secondary/85 to-transparent pointer-events-none" />
        )}
        {overflows && (
          <div
            className={`flex justify-center ${open ? "pt-2" : "absolute inset-x-0 bottom-0"} pointer-events-none`}
            aria-hidden
          >
            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-bg-tertiary border border-border-subtle text-[11px] font-semibold text-text-secondary">
              {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {open ? "Show less" : "Read more"}
            </span>
          </div>
        )}
      </div>
    </PageSection>
  );
};
