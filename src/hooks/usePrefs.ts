import { useCallback, useState } from "react";

/**
 * Per-device view preferences kept in localStorage as JSON, laid over `defaults` so new fields get
 * their default. Storage may be unavailable: reads fall back to the defaults and writes are skipped.
 * `migrate` fixes values stored by older versions.
 */
export function usePrefs<T extends object>(key: string, defaults: T, migrate?: (prefs: T) => T) {
  const [prefs, setPrefs] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const stored: T = { ...defaults, ...JSON.parse(raw) };
        return migrate ? migrate(stored) : stored;
      }
    } catch {
      // storage unavailable or corrupt: defaults
    }
    return defaults;
  });

  const updatePrefs = useCallback(
    (patch: Partial<T>) =>
      setPrefs((prev) => {
        const next = { ...prev, ...patch };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // per-viewer convenience only
        }
        return next;
      }),
    [key]
  );

  return [prefs, updatePrefs] as const;
}
