import React, { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, LogIn, Plug, User } from "lucide-react";
import { StoredAccount, TrackerDescriptor } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { logError } from "@/lib/log";
import { useToast } from "@/contexts/toast";
import { useTracker } from "@/contexts/tracker";
import { TrackerSupportTable } from "./TrackerSupportTable";

/**
 * Settings → Tracker: the trackers (sign in / switch), the accounts with a list on this computer (switch with
 * their stored sign-in, no new sign-in), and what each tracker supports.
 */
export const TrackerSettings: React.FC = () => {
  const { tracker: activeTracker, account } = useTracker();
  const showToast = useToast();
  const [trackers, setTrackers] = useState<TrackerDescriptor[]>([]);
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    toraApi.getTrackers().then(setTrackers).catch(logError("settings", "Loading trackers failed"));
  }, []);
  const loadAccounts = useCallback(() => {
    toraApi.getStoredAccounts().then(setAccounts).catch(logError("settings", "Loading accounts failed"));
  }, []);
  // Again after every sign-in, sign-out or switch
  useEffect(loadAccounts, [loadAccounts, account?.tracker, account?.user_id]);

  const trackerName = (id: string) => trackers.find((t) => t.id === id)?.name ?? id;

  const signIn = async (t: TrackerDescriptor) => {
    try {
      setBusy(true);
      await toraApi.startTrackerSignIn(t.id);
      showToast(`Opened ${t.name} in your browser — approve Tora there to sign in`, "info");
    } catch (err) {
      showToast(String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  // The app reloads the list on `tracker-account-switched` and says so
  const switchTo = async (a: StoredAccount) => {
    try {
      setBusy(true);
      await toraApi.switchTrackerAccount(a.tracker, a.user_id);
    } catch (err) {
      showToast(String(err), "error");
    } finally {
      setBusy(false);
      loadAccounts();
    }
  };

  /** A tracker card's button: the stored account of that tracker when there is one, else a new sign-in */
  const openTracker = (t: TrackerDescriptor) => {
    const stored = accounts.find((a) => a.tracker === t.id && a.signed_in && !a.active);
    return stored ? switchTo(stored) : signIn(t);
  };

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-5">
      <div>
        <h2 className="text-base font-bold text-text-primary flex items-center gap-2">
          <Plug className="w-5 h-5 text-accent" />
          Tracker
        </h2>
        <p className="text-xs text-text-secondary mt-0.5">
          The service your list syncs with. Switching to another tracker or account loads its list; each
          account's list, history and settings stay on this computer for when you switch back.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {trackers.map((t) => {
          const isActive = activeTracker?.id === t.id;
          return (
            <div
              key={t.id}
              className={`p-4 rounded-xl border space-y-2 ${isActive ? "border-accent bg-accent/10" : "border-border-subtle bg-bg-primary"}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-text-primary">{t.name}</span>
                {isActive && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-emerald-500/20 text-emerald-400">
                    active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-text-muted leading-relaxed">
                {isActive && account ? `Signed in as @${account.username}` : isActive ? "Signed out" : "Not in use"}
              </p>
              {!(isActive && account) && (
                <button
                  onClick={() => void openTracker(t)}
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-accent text-white hover:opacity-90 disabled:opacity-50 transition cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  {isActive ? `Sign in to ${t.name}` : `Switch to ${t.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {accounts.length > 0 && (
        <div className="space-y-2">
          <div>
            <h3 className="text-xs font-bold text-text-primary">Accounts on this computer</h3>
            <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">
              Switching uses the account's saved sign-in. Signing out of an account forgets it, so that one needs
              a new sign-in.
            </p>
          </div>
          <div className="rounded-xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
            {accounts.map((a) => (
              <div
                key={`${a.tracker}-${a.user_id}`}
                className={`flex items-center gap-3 px-3 py-2 ${a.active ? "bg-accent/5" : "bg-bg-primary"}`}
              >
                {a.avatar_url ? (
                  <img src={a.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
                ) : (
                  <span className="w-7 h-7 rounded-full bg-bg-tertiary flex items-center justify-center shrink-0">
                    <User className="w-3.5 h-3.5 text-text-muted" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-text-primary truncate">
                    {a.username ? `@${a.username}` : `Account ${a.user_id}`}
                  </div>
                  <div className="text-[11px] text-text-muted">
                    {trackerName(a.tracker)} · {a.entries.toLocaleString()} anime
                    {!a.signed_in && " · signed out"}
                  </div>
                </div>
                {a.active ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-emerald-500/20 text-emerald-400">
                    in use
                  </span>
                ) : a.signed_in ? (
                  <button
                    onClick={() => void switchTo(a)}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-bg-tertiary text-text-primary hover:bg-accent hover:text-white disabled:opacity-50 transition cursor-pointer"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5" />
                    Switch
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      const t = trackers.find((x) => x.id === a.tracker);
                      if (t) void signIn(t);
                    }}
                    disabled={busy}
                    title="Sign in to this account again (the browser asks which account)"
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-bg-tertiary text-text-primary hover:bg-accent hover:text-white disabled:opacity-50 transition cursor-pointer"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    Sign in
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <TrackerSupportTable trackers={trackers} activeId={activeTracker?.id ?? null} />
    </div>
  );
};
