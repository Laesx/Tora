import React, { useLayoutEffect, useRef, useState } from "react";
import { PageSection } from "./PageSection";

/**
 * The synopsis, a few lines with the rest fading out; a click anywhere on it expands or collapses it
 * (not a click that selected text). A synopsis that already fits neither fades nor toggles.
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
          className={`text-xs leading-relaxed text-text-secondary whitespace-pre-line ${open ? "" : "max-h-20 overflow-hidden"}`}
        >
          {synopsis}
        </p>
        {overflows && !open && (
          <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-bg-secondary to-transparent pointer-events-none" />
        )}
      </div>
    </PageSection>
  );
};
