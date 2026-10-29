import React from "react";
import { Keyboard, X } from "lucide-react";
import { SHORTCUT_GROUPS } from "./shortcuts";

interface ShortcutsModalProps {
  onClose: () => void;
}

/** Keyboard shortcuts sheet (? / sidebar keyboard button / palette). Esc is handled globally. */
export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ onClose }) => (
  <div
    className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    onClick={onClose}
  >
    <div
      className="bg-bg-secondary border border-border-subtle rounded-2xl max-w-3xl w-full max-h-[85vh] shadow-2xl flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border-subtle">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0">
            <Keyboard className="w-4 h-4" />
          </div>
          <h3 className="text-sm font-bold text-text-primary">Keyboard shortcuts</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition cursor-pointer"
          title="Close (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="space-y-2">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{group.title}</h4>
            <ul className="space-y-1.5">
              {group.items.map((item) => (
                <li key={`${item.keys.join()}-${item.label}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-text-secondary">{item.label}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {item.keys.map((combo, i) => (
                      <React.Fragment key={combo}>
                        {i > 0 && <span className="text-[10px] text-text-muted">/</span>}
                        {combo.split("+").map((key, j) => (
                          <React.Fragment key={key}>
                            {j > 0 && <span className="text-[10px] text-text-muted">+</span>}
                            <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-tertiary text-text-secondary border border-border-subtle">
                              {key}
                            </kbd>
                          </React.Fragment>
                        ))}
                      </React.Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  </div>
);
