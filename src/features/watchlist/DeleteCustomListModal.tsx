import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";

interface DeleteCustomListModalProps {
  name: string;
  /** Anime currently in the list */
  count: number;
  /** Deletes the list on AniList; a rejection is shown in the modal */
  onDelete: () => Promise<void>;
  onClose: () => void;
}

/** Confirmation before deleting an AniList custom list (Lists chip → trash button / Delete key). */
export const DeleteCustomListModal: React.FC<DeleteCustomListModalProps> = ({ name, count, onDelete, onClose }) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  // Portal: the toolbar may create a containing block for fixed elements
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => !busy && onClose()}
      onKeyDown={(e) => {
        // Keep Esc / Enter away from the global shortcuts
        e.stopPropagation();
        if (e.key === "Escape" && !busy) onClose();
      }}
    >
      <div
        className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 max-w-sm w-full shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
            <Trash2 className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-text-primary">Delete custom list?</h3>
            <p className="text-[11px] text-text-muted truncate">{name}</p>
          </div>
        </div>

        <p className="text-xs text-text-secondary leading-relaxed">
          This removes the list from your AniList account right away.{" "}
          {count > 0
            ? `The ${count} anime in it stay on your list; only their membership in "${name}" is removed.`
            : "It has no anime in it."}
        </p>
        {error && <p className="text-[11px] text-rose-400">{error}</p>}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            // Focused so a stray Enter cancels instead of deleting
            autoFocus
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold border border-border-subtle transition cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void confirm()}
            disabled={busy}
            className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow-sm cursor-pointer disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete list"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
