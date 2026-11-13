import { useSyncExternalStore } from "react";

/**
 * AniList users pinned in the Following section, on this device only: listed first on every anime,
 * and fetched even when they aren't among the 50 most recently updated followed users.
 */
const KEY = "tora.anime.followingPins";

function read(): number[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed.filter((x): x is number => Number.isInteger(x));
  } catch {
    // storage unavailable or corrupt: none
  }
  return [];
}

let pins: number[] = read();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The pinned user ids, in the order they were pinned. */
export const pinnedUsers = () => pins;

export function togglePinnedUser(userId: number) {
  pins = pins.includes(userId) ? pins.filter((id) => id !== userId) : [...pins, userId];
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // per-device convenience only
  }
  listeners.forEach((l) => l());
}

export function usePinnedUsers(): number[] {
  return useSyncExternalStore(subscribe, pinnedUsers);
}
