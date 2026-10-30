import { debug, error, info, warn } from "@tauri-apps/plugin-log";

/**
 * Frontend logging into the app log file (`%APPDATA%\Tora\logs\tora.log`, next to the Rust lines;
 * `@tauri-apps/plugin-log`), and the devtools console in dev builds. `scope` names the area
 * ("api", "updater", "watchlist"…). Never log tokens, notes or other user text beyond titles.
 */
type Level = "error" | "warn" | "info" | "debug";

const SINKS: Record<Level, (message: string) => Promise<void>> = { error, warn, info, debug };

/** Readable text for anything thrown or rejected (Tauri commands reject with plain strings) */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function write(level: Level, scope: string, message: string, cause?: unknown) {
  const text = `[${scope}] ${message}${cause === undefined ? "" : `: ${errorText(cause)}`}`;
  if (import.meta.env.DEV) {
    // The original object in devtools (expandable), the flattened text in the file
    if (cause === undefined) console[level](`[${scope}] ${message}`);
    else console[level](`[${scope}] ${message}:`, cause);
  }
  try {
    // Outside Tauri (or before the plugin is ready) the call rejects or throws: the console has it
    SINKS[level](text).catch(() => {});
  } catch {
    // ignore
  }
}

export const log = {
  error: (scope: string, message: string, cause?: unknown) => write("error", scope, message, cause),
  warn: (scope: string, message: string, cause?: unknown) => write("warn", scope, message, cause),
  info: (scope: string, message: string, cause?: unknown) => write("info", scope, message, cause),
  debug: (scope: string, message: string, cause?: unknown) => write("debug", scope, message, cause),
};

/** `.catch(logError("settings", "Loading plugins failed"))` */
export const logError = (scope: string, message: string) => (e: unknown) => log.error(scope, message, e);

/** Uncaught errors and unhandled promise rejections anywhere in the webview */
export function installGlobalErrorLogging() {
  window.addEventListener("error", (e) => {
    log.error("window", `Uncaught ${e.message} (${e.filename}:${e.lineno}:${e.colno})`, e.error ?? undefined);
  });
  window.addEventListener("unhandledrejection", (e) => {
    log.error("window", "Unhandled promise rejection", e.reason);
  });
}
