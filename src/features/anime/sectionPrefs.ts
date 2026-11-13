import { useSyncExternalStore } from "react";

/**
 * Which anime page sections are collapsed: one per-device list shared by every section (and every
 * anime), so toggling one never overwrites another's state. Staff starts collapsed.
 */
const KEY = "tora.anime.sections";
const DEFAULT_COLLAPSED = ["staff"];

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.collapsed)) return parsed.collapsed.filter((x: unknown) => typeof x === "string");
    }
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return DEFAULT_COLLAPSED;
}

let collapsed: string[] = read();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function setSectionCollapsed(id: string, value: boolean) {
  collapsed = value ? [...collapsed.filter((x) => x !== id), id] : collapsed.filter((x) => x !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify({ collapsed }));
  } catch {
    // per-device convenience only
  }
  listeners.forEach((l) => l());
}

/** Whether the section is collapsed, re-rendering when it changes. */
export function useSectionCollapsed(id: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (id ? collapsed.includes(id) : false));
}
