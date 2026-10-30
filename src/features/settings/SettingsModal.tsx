import React from "react";
import { Settings, X } from "lucide-react";
import { SettingsView } from "./SettingsView";

type SettingsModalProps = React.ComponentProps<typeof SettingsView> & {
  onClose: () => void;
};

/** Settings as a large centered modal (gear button, Ctrl+9, palette). Esc is handled globally. */
export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, ...viewProps }) => (
  <div
    className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    onClick={onClose}
  >
    <div
      className="bg-bg-primary border border-border-subtle rounded-2xl w-[min(1180px,94vw)] h-[88vh] shadow-2xl flex flex-col overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-border-subtle bg-bg-secondary">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0">
            <Settings className="w-4 h-4" />
          </div>
          <h3 className="text-sm font-bold text-text-primary">Settings</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition cursor-pointer"
          title="Close (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <SettingsView {...viewProps} />
      </div>
    </div>
  </div>
);
