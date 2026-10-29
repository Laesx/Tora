export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i >= 3 ? 2 : i >= 2 ? 1 : 0)} ${units[i]}`;
}

export function formatCountdown(airingUnix: number | null): string | null {
  if (!airingUnix) return null;
  const now = Math.floor(Date.now() / 1000);
  const diff = airingUnix - now;
  if (diff <= 0) return "Airing now";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// Unix timestamp (seconds or milliseconds) -> short relative label for the sync button tooltip
export function formatLastSynced(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h ago`;
  return new Date(ms).toLocaleString();
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Unix seconds -> "3 days ago" (`long`) or "3d ago" (`short`, for tight card footers).
 * Weeks cover anything under a month; months anything under a year.
 */
export function formatRelativeTime(unixSec: number, now: number, style: "short" | "long" = "long"): string {
  const diff = Math.max(0, now - unixSec);
  if (diff < MINUTE) return "just now";
  const [n, short, long] =
    diff < HOUR
      ? [Math.floor(diff / MINUTE), "m", "min"]
      : diff < DAY
        ? [Math.floor(diff / HOUR), "h", "hour"]
        : diff < WEEK
          ? [Math.floor(diff / DAY), "d", "day"]
          : diff < MONTH
            ? [Math.floor(diff / WEEK), "w", "week"]
            : diff < YEAR
              ? [Math.floor(diff / MONTH), "mo", "month"]
              : [Math.floor(diff / YEAR), "y", "year"];
  if (style === "short") return `${n}${short} ago`;
  if (long === "day" && n === 1) return "yesterday";
  return long === "min" ? `${n} min ago` : `${plural(n, long)} ago`;
}

/** Unix seconds -> full local date and time (tooltips) */
export function formatExactTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

/** "1 episode" / "3 episodes" */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
