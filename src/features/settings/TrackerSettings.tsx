import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, ExternalLink, Loader2, LogIn, LogOut, Plug, Plus, Trash2, TriangleAlert } from "lucide-react";
import { StoredAccount } from "@/lib/types";
import { plural } from "@/lib/format";
import { useTracker } from "@/contexts/tracker";
import { AccountAvatar } from "@/app/AccountMenu";
import { accountKey, useStoredAccounts } from "@/app/useStoredAccounts";
import { TrackerSupportTable } from "./TrackerSupportTable";

const accountLabel = (a: StoredAccount) => (a.username ? `@${a.username}` : `Account ${a.user_id}`);

const rowButton =
  "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-bg-tertiary text-text-primary hover:bg-accent hover:text-white disabled:opacity-50 disabled:pointer-events-none transition cursor-pointer";

/**
 * Settings → Tracker: one list of the accounts on this computer. The one in use comes first (profile, sign
 * out); the others switch with their saved sign-in, sign in again, or are removed from this computer. Below:
 * adding an account per tracker, and what each tracker supports (collapsed).
 */
export const TrackerSettings: React.FC<{ onSignOut: () => void; onOpenProfile: () => void }> = ({
  onSignOut,
  onOpenProfile,
}) => {
  const { tracker: activeTracker, account } = useTracker();
  const { trackers, accounts, busy, trackerName, signIn, switchTo, remove } = useStoredAccounts();
  const [removing, setRemoving] = useState<StoredAccount | null>(null);
  const current = accounts.find((a) => a.active);
  const others = accounts.filter((a) => !a.active);

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-5">
      <div>
        <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
          <Plug className="w-5 h-5 text-accent" />
          Accounts
        </h2>
        <p className="text-xs text-text-secondary mt-0.5">
          Each account keeps its own local list and history on this computer.
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
        {/* The account in use, signed in or not; nothing before the first sign-in */}
        {current ? (
          <div className="flex items-center gap-3 px-3 py-2.5 bg-accent/5">
            <AccountAvatar avatarUrl={current.avatar_url} name={current.username} tracker={current.tracker} />
            <div className="min-w-0 flex-1 pl-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-text-primary truncate">{accountLabel(current)}</span>
                <span className="px-1.5 py-px rounded text-[9px] font-semibold uppercase bg-emerald-500/20 text-emerald-400">
                  in use
                </span>
              </div>
              <div className="text-[11px] text-text-muted truncate">
                {trackerName(current.tracker)} · {current.entries.toLocaleString()} anime
                {!account && " · signed out"}
              </div>
            </div>
            {account ? (
              <>
                <button onClick={onOpenProfile} className={rowButton} title={`Open your ${trackerName(current.tracker)} profile`}>
                  <ExternalLink className="w-3.5 h-3.5" />
                  Profile
                </button>
                <button onClick={onSignOut} className={`${rowButton} hover:!bg-rose-600`}>
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              </>
            ) : (
              <button onClick={() => void signIn(current.tracker)} disabled={busy !== null} className={rowButton}>
                <LogIn className="w-3.5 h-3.5" />
                Sign in
              </button>
            )}
          </div>
        ) : (
          <div className="px-3 py-3 bg-bg-primary text-[11px] text-text-muted">
            No accounts connected.
          </div>
        )}

        {others.map((a) => {
          const key = accountKey(a);
          return (
            <div key={key} className="flex items-center gap-3 px-3 py-2.5 bg-bg-primary">
              <span className={a.signed_in ? "" : "opacity-50"}>
                <AccountAvatar avatarUrl={a.avatar_url} name={a.username} tracker={a.tracker} />
              </span>
              <div className="min-w-0 flex-1 pl-1">
                <div className="text-xs font-semibold text-text-primary truncate">{accountLabel(a)}</div>
                <div className="text-[11px] text-text-muted truncate">
                  {trackerName(a.tracker)} · {a.entries.toLocaleString()} anime
                  {!a.signed_in && " · signed out"}
                </div>
              </div>
              {busy === key && <Loader2 className="w-3.5 h-3.5 animate-spin text-accent shrink-0" />}
              {a.signed_in ? (
                <button onClick={() => void switchTo(a)} disabled={busy !== null} className={rowButton}>
                  <ArrowRightLeft className="w-3.5 h-3.5" />
                  Switch
                </button>
              ) : (
                <button
                  onClick={() => void signIn(a.tracker)}
                  disabled={busy !== null}
                  className={rowButton}
                >
                  <LogIn className="w-3.5 h-3.5" />
                  Sign in
                </button>
              )}
              <button
                onClick={() => setRemoving(a)}
                disabled={busy !== null}
                title="Remove from this computer"
                aria-label={`Remove ${accountLabel(a)} from this computer`}
                className="p-1.5 rounded-lg text-text-muted hover:text-rose-400 hover:bg-rose-500/10 disabled:opacity-50 disabled:pointer-events-none transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-2">
          {trackers.map((t) => (
            <button
              key={t.id}
              onClick={() => void signIn(t.id)}
              disabled={busy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border border-border-subtle bg-bg-primary text-text-secondary hover:border-accent/50 hover:text-text-primary disabled:opacity-50 transition cursor-pointer"
            >
              {busy === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Add {t.name} account
            </button>
          ))}
        </div>
        <p className="text-[11px] text-text-muted leading-relaxed">
          Uses your active browser session - log out in your browser first to add another account.
        </p>
      </div>

      <TrackerSupportTable trackers={trackers} activeId={activeTracker?.id ?? null} />

      {removing && (
        <RemoveAccountModal
          account={removing}
          trackerName={trackerName(removing.tracker)}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const a = removing;
            setRemoving(null);
            void remove(a);
          }}
        />
      )}
    </div>
  );
};

/** Confirmation before deleting an account's database: what goes, and the unsent changes lost with it. */
const RemoveAccountModal: React.FC<{
  account: StoredAccount;
  trackerName: string;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ account, trackerName, onCancel, onConfirm }) => {
  // Esc closes this, not Settings underneath (the app's handler listens on window, bubbling)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 max-w-sm w-full shadow-2xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
            <Trash2 className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-text-primary">Remove from this computer?</h3>
            <p className="text-[11px] text-text-muted truncate">
              {accountLabel(account)} · {trackerName}
            </p>
          </div>
        </div>

        <p className="text-xs text-text-secondary leading-relaxed">
          Removes this account's local list, history, and settings from this computer. Your {trackerName} list is not
          affected.
        </p>

        {account.unsent > 0 && (
          <p className="flex gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2 leading-relaxed">
            <TriangleAlert className="w-4 h-4 shrink-0 mt-px" />
            {plural(account.unsent, "unsent change")} will be lost. {account.signed_in ? "Switch to" : "Sign in to"} this
            account first to sync.
          </p>
        )}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <button
            onClick={onCancel}
            autoFocus
            className="px-4 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold border border-border-subtle transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition shadow-sm cursor-pointer"
          >
            Remove
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
