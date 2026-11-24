import { useCallback, useEffect, useState } from "react";
import { StoredAccount, TrackerDescriptor } from "@/lib/types";
import { toraApi } from "@/lib/api";
import { errorText, logError } from "@/lib/log";
import { useToast } from "@/contexts/toast";
import { useTracker } from "@/contexts/tracker";

/** `tracker-userId`: which account a pending switch is for. */
export const accountKey = (a: { tracker: string; user_id: number }) => `${a.tracker}-${a.user_id}`;

/**
 * The trackers and the accounts with a list on this computer, and the two ways to change account: switch to a
 * saved one (its stored sign-in, no browser) or sign in through the browser. Shared by the sidebar account menu
 * and Settings → Tracker. The app reloads everything on `tracker-account-switched` and says so.
 */
export function useStoredAccounts() {
  const { account } = useTracker();
  const showToast = useToast();
  const [trackers, setTrackers] = useState<TrackerDescriptor[]>([]);
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  /** The account being switched to (`accountKey`), or a tracker id being signed in to */
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    toraApi.getTrackers().then(setTrackers).catch(logError("accounts", "Loading trackers failed"));
  }, []);
  const reload = useCallback(() => {
    toraApi.getStoredAccounts().then(setAccounts).catch(logError("accounts", "Loading accounts failed"));
  }, []);
  // Again after every sign-in, sign-out or switch
  useEffect(reload, [reload, account?.tracker, account?.user_id]);

  const trackerName = useCallback((id: string) => trackers.find((t) => t.id === id)?.name ?? id, [trackers]);

  const signIn = useCallback(
    async (trackerId: string) => {
      const name = trackers.find((t) => t.id === trackerId)?.name ?? trackerId;
      try {
        setBusy(trackerId);
        await toraApi.startTrackerSignIn(trackerId);
        showToast(`Opened ${name} in your browser — approve Tora there to sign in`, "info");
      } catch (err) {
        showToast(errorText(err), "error");
      } finally {
        setBusy(null);
      }
    },
    [trackers, showToast]
  );

  /** Resolves once the other account's list is the active one (its sync then runs in the background). */
  const switchTo = useCallback(
    async (a: StoredAccount) => {
      try {
        setBusy(accountKey(a));
        await toraApi.switchTrackerAccount(a.tracker, a.user_id);
        return true;
      } catch (err) {
        showToast(errorText(err), "error");
        return false;
      } finally {
        setBusy(null);
        reload();
      }
    },
    [showToast, reload]
  );

  /** Delete another account's database from this computer (its list on the tracker stays) */
  const remove = useCallback(
    async (a: StoredAccount) => {
      try {
        setBusy(accountKey(a));
        await toraApi.removeStoredAccount(a.tracker, a.user_id);
        showToast(`Removed ${a.username ? `@${a.username}` : "the account"} from this computer`, "info");
      } catch (err) {
        showToast(errorText(err), "error");
      } finally {
        setBusy(null);
        reload();
      }
    },
    [showToast, reload]
  );

  return { trackers, accounts, busy, reload, trackerName, signIn, switchTo, remove };
}

export type StoredAccounts = ReturnType<typeof useStoredAccounts>;
