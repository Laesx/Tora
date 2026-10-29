import React, { useState } from "react";
import { createPortal } from "react-dom";
import { ListPlus } from "lucide-react";

interface NewCustomListModalProps {
  existingNames: string[];
  /** Creates the list on AniList; a rejection is shown in the modal */
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}

/** Name prompt for a new AniList custom list (Lists chip → "New list…"). */
export const NewCustomListModal: React.FC<NewCustomListModalProps> = ({ existingNames, onCreate, onClose }) => {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const duplicate = existingNames.some((n) => n.trim().toLowerCase() === trimmed.toLowerCase());
  const validation = !trimmed ? null : duplicate ? `A list named "${trimmed}" already exists` : null;

  const submit = async () => {
    if (!trimmed || duplicate || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed);
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
      <form
        className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 max-w-sm w-full shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0">
            <ListPlus className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-primary">New custom list</h3>
            <p className="text-[11px] text-text-muted">Created on your AniList account</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={100}
            placeholder="List name"
            className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
          />
          {(validation || error) && <p className="text-[11px] text-rose-400">{validation ?? error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold border border-border-subtle transition cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!trimmed || duplicate || busy}
            className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
};
