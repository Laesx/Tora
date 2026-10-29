import React from "react";
import { LogOut } from "lucide-react";

interface SignOutModalProps {
  username: string | null | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}

export const SignOutModal: React.FC<SignOutModalProps> = ({ username, onCancel, onConfirm }) => (
  <div
    className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    onClick={onCancel}
  >
    <div
      className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 max-w-sm w-full shadow-2xl space-y-4"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
          <LogOut className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-text-primary">Sign out of AniList?</h3>
          <p className="text-[11px] text-text-muted">@{username || "AniList Account"}</p>
        </div>
      </div>

      <p className="text-xs text-text-secondary leading-relaxed">
        Are you sure you want to sign out? Your local anime library and settings will remain intact, but automatic AniList synchronization will stop until you sign in again.
      </p>

      <div className="flex items-center justify-end gap-2.5 pt-1">
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold border border-border-subtle transition cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow-sm cursor-pointer"
        >
          Sign Out
        </button>
      </div>
    </div>
  </div>
);
