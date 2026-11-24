import React, { useEffect, useRef } from "react";
import { ExternalLink, Loader2, LogIn, LogOut, Plus, Settings, User } from "lucide-react";
import { StoredAccount } from "@/lib/types";
import { trackerShortName } from "@/lib/trackers";
import { useTracker } from "@/contexts/tracker";
import { FloatingQuickMenu } from "@/components/FloatingQuickMenu";
import { accountKey, StoredAccounts } from "./useStoredAccounts";

/** An account's avatar (or its initial) with its tracker's short name in the corner ("AL", "MAL"). */
export const AccountAvatar: React.FC<{
  avatarUrl: string | null;
  name: string | null;
  tracker: string;
  size?: "sm" | "md";
}> = ({ avatarUrl, name, tracker, size = "md" }) => {
  const box = size === "md" ? "w-9 h-9" : "w-7 h-7";
  return (
    <span className={`relative shrink-0 ${box}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className={`${box} rounded-full object-cover border border-border-subtle bg-bg-tertiary`} />
      ) : (
        <span
          className={`${box} rounded-full bg-accent/15 border border-accent/30 flex items-center justify-center text-accent font-bold text-xs`}
        >
          {name ? name.charAt(0).toUpperCase() : <User className="w-3.5 h-3.5" />}
        </span>
      )}
      <span className="absolute -bottom-1 -right-1.5 px-1 rounded bg-bg-tertiary border border-border-subtle text-[8px] leading-[12px] font-bold text-text-secondary">
        {trackerShortName(tracker)}
      </span>
    </span>
  );
};

const itemClass =
  "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:bg-bg-tertiary focus-visible:text-text-primary focus:outline-none disabled:opacity-50 disabled:pointer-events-none transition cursor-pointer";

const accountLabel = (a: StoredAccount) => (a.username ? `@${a.username}` : `Account ${a.user_id}`);

/**
 * The sidebar account card's menu: the account in use, the other accounts on this computer (switch with their
 * saved sign-in), adding an account per tracker, and the profile / Settings / sign-out actions. `stored` is loaded
 * by the always-mounted card, so the menu opens at its full size instead of growing as requests come back.
 */
export const AccountMenu: React.FC<{
  anchor: { x: number; y: number };
  stored: StoredAccounts;
  onClose: () => void;
  onOpenProfile: () => void;
  onManageAccounts: () => void;
  onSignOut: () => void;
}> = ({ anchor, stored, onClose, onOpenProfile, onManageAccounts, onSignOut }) => {
  const { account, name } = useTracker();
  const { trackers, accounts, busy, trackerName, signIn, switchTo } = stored;
  const listRef = useRef<HTMLDivElement | null>(null);
  const current = accounts.find((a) => a.active);
  const others = accounts.filter((a) => !a.active);

  // Keyboard: the first item has focus, ↑ / ↓ move (Esc closes in FloatingQuickMenu)
  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]:not(:disabled)") ?? []);
  useEffect(() => {
    items()[0]?.focus();
  }, [accounts.length]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = items();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next].focus();
  };

  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <FloatingQuickMenu anchor={anchor} onClose={onClose} above>
      <div
        ref={listRef}
        role="menu"
        onKeyDown={onKeyDown}
        className="w-72 p-1.5 rounded-xl bg-bg-secondary border border-border-subtle shadow-2xl space-y-1"
      >
        {account && (
          <div className="flex items-center gap-3 px-2.5 py-2">
            <AccountAvatar avatarUrl={account.avatar_url} name={account.username} tracker={account.tracker} />
            <div className="min-w-0 flex-1 pl-1">
              <div className="text-xs font-bold text-text-primary truncate">@{account.username}</div>
              <div className="text-[11px] text-text-muted truncate">
                {name}
                {current && ` · ${current.entries.toLocaleString()} anime`}
              </div>
            </div>
          </div>
        )}

        {others.length > 0 && (
          <div className="border-t border-border-subtle pt-1">
            <div className="px-2.5 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
              Switch account
            </div>
            {others.map((a) => {
              const switching = busy === accountKey(a);
              return (
                <button
                  key={accountKey(a)}
                  data-menu-item
                  role="menuitem"
                  disabled={busy !== null}
                  onClick={async () => {
                    if (!a.signed_in) {
                      onClose();
                      void signIn(a.tracker);
                    } else if (await switchTo(a)) {
                      onClose();
                    }
                  }}
                  title={
                    a.signed_in
                      ? `Switch to ${accountLabel(a)} on ${trackerName(a.tracker)}`
                      : `Signed out: sign in to ${trackerName(a.tracker)} again`
                  }
                  className={itemClass}
                >
                  <span className={`pl-0.5 ${a.signed_in ? "" : "opacity-50"}`}>
                    <AccountAvatar avatarUrl={a.avatar_url} name={a.username} tracker={a.tracker} size="sm" />
                  </span>
                  <span className={`min-w-0 flex-1 pl-1 ${a.signed_in ? "" : "opacity-60"}`}>
                    <span className="block font-semibold text-text-primary truncate">{accountLabel(a)}</span>
                    <span className="block text-[11px] text-text-muted truncate">
                      {trackerName(a.tracker)} · {a.entries.toLocaleString()} anime
                    </span>
                  </span>
                  {switching ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-accent shrink-0" />
                  ) : (
                    !a.signed_in && (
                      <span className="flex items-center gap-1 text-[10px] font-semibold text-accent shrink-0">
                        <LogIn className="w-3 h-3" />
                        Sign in
                      </span>
                    )
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="border-t border-border-subtle pt-1">
          {trackers.map((t) => (
            <button
              key={t.id}
              data-menu-item
              role="menuitem"
              disabled={busy !== null}
              onClick={run(() => void signIn(t.id))}
              className={itemClass}
            >
              {busy === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Add {t.name} account
            </button>
          ))}
          <p className="px-2.5 pb-1 text-[10px] text-text-muted leading-snug">
            Signs in whoever is logged in on the tracker's site in your browser: log out there first to add another
            account of the same tracker.
          </p>
        </div>

        <div className="border-t border-border-subtle pt-1">
          {account && (
            <button data-menu-item role="menuitem" onClick={run(onOpenProfile)} className={itemClass}>
              <ExternalLink className="w-3.5 h-3.5" />
              View profile on {name}
            </button>
          )}
          <button data-menu-item role="menuitem" onClick={run(onManageAccounts)} className={itemClass}>
            <Settings className="w-3.5 h-3.5" />
            Manage accounts…
          </button>
          {account && (
            <button
              data-menu-item
              role="menuitem"
              onClick={run(onSignOut)}
              className={`${itemClass} hover:!text-rose-400 focus-visible:!text-rose-400`}
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          )}
        </div>
      </div>
    </FloatingQuickMenu>
  );
};
