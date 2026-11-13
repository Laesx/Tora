import { useSyncExternalStore } from "react";

/**
 * Which anime page sections are collapsed: one per-device store shared by every section (and every
 * anime), so toggling one never overwrites another's state. Only the user's own choices are stored, so
 * a section given a new default (Recommendations) gets it unless the user already chose.
 */
const KEY = "tora.anime.sections";
/** Collapsed until opened: Staff (long, rarely needed), Recommendations (only fetched once opened). */
const DEFAULT_COLLAPSED = ["staff", "recommendations"];

type Choices = Record<string, boolean>;

function read(): Choices {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.choices && typeof parsed.choices === "object") {
        return Object.fromEntries(
          Object.entries(parsed.choices).filter((e): e is [string, boolean] => typeof e[1] === "boolean")
        );
      }
      // First format: the full list of collapsed sections, where only Staff could have been opened
      if (Array.isArray(parsed?.collapsed)) {
        const list: string[] = parsed.collapsed.filter((x: unknown) => typeof x === "string");
        return { ...Object.fromEntries(list.map((id) => [id, true])), staff: list.includes("staff") };
      }
    }
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return {};
}

let choices: Choices = read();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const isCollapsed = (id: string) => choices[id] ?? DEFAULT_COLLAPSED.includes(id);

export function setSectionCollapsed(id: string, value: boolean) {
  choices = { ...choices, [id]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify({ choices }));
  } catch {
    // per-device convenience only
  }
  listeners.forEach((l) => l());
}

/** Whether the section is collapsed, re-rendering when it changes. */
export function useSectionCollapsed(id: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (id ? isCollapsed(id) : false));
}
