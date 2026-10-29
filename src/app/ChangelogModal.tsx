import React, { useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, ScrollText, X } from "lucide-react";
import { toraApi } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { ReleaseNote } from "@/lib/types";
import type { UpdateProgress } from "./useAppUpdater";

/** Numeric dotted-version comparison ("0.10.0" > "0.9.2"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const formatReleaseDate = (iso: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";

/** GitHub-rendered (sanitized) release notes; links open in the browser instead of the webview. */
export const ReleaseNotesHtml: React.FC<{ html: string }> = ({ html }) => (
  <div
    className="release-notes"
    onClick={(e) => {
      const link = (e.target as HTMLElement).closest("a");
      if (!link) return;
      e.preventDefault();
      if (link.href.startsWith("http")) void toraApi.openExternalUrl(link.href);
    }}
    dangerouslySetInnerHTML={{ __html: html }}
  />
);

/** "Update & restart" with download progress while installing. */
export const InstallUpdateButton: React.FC<{
  version: string;
  progress: UpdateProgress | null;
  onInstall: () => void;
  label?: string;
}> = ({ version, progress, onInstall, label = "Update & restart" }) => {
  if (!progress) {
    return (
      <button
        onClick={onInstall}
        className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition shadow-sm cursor-pointer flex items-center gap-1.5"
        title={`Download and install Tora v${version}, then restart`}
      >
        <Download className="w-3.5 h-3.5" />
        {label}
      </button>
    );
  }
  const pct = progress.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
  return (
    <div className="min-w-[180px] space-y-1">
      <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted">
        <span className="flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin text-accent" />
          {pct === 100 ? "Installing…" : "Downloading…"}
        </span>
        <span className="font-mono">
          {formatBytes(progress.downloaded)}
          {progress.total ? ` / ${formatBytes(progress.total)}` : ""}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className={`h-full bg-accent transition-all ${pct === null ? "w-1/3 animate-pulse" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
};

/** Load the published releases once per mount. */
export function useChangelog() {
  const [releases, setReleases] = useState<ReleaseNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    toraApi
      .getChangelog()
      .then((r) => !cancelled && setReleases(r))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  return { releases, error };
}

interface ChangelogModalProps {
  /** Running version */
  version: string;
  /** Version of an available update, if any */
  availableVersion: string | null;
  progress: UpdateProgress | null;
  onInstall: () => void;
  onClose: () => void;
}

/** What's new: every published release, newest first (sidebar version dot). Esc is handled globally. */
export const ChangelogModal: React.FC<ChangelogModalProps> = ({
  version,
  availableVersion,
  progress,
  onInstall,
  onClose,
}) => {
  const { releases, error } = useChangelog();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={progress ? undefined : onClose}
    >
      <div
        className="bg-bg-secondary border border-border-subtle rounded-2xl max-w-2xl w-full max-h-[85vh] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0">
              <ScrollText className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-text-primary">What's new in Tora</h3>
              <p className="text-[11px] text-text-muted">
                {availableVersion ? `v${version} installed · v${availableVersion} available` : `v${version} installed`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {availableVersion && (
              <InstallUpdateButton
                version={availableVersion}
                progress={progress}
                onInstall={onInstall}
                label={`Update to v${availableVersion}`}
              />
            )}
            <button
              onClick={onClose}
              disabled={!!progress}
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition cursor-pointer disabled:opacity-40 disabled:cursor-default"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-5 space-y-6">
          {error ? (
            <p className="text-xs text-rose-400">{error}</p>
          ) : !releases ? (
            <p className="text-xs text-text-muted flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
              Loading releases from GitHub…
            </p>
          ) : releases.length === 0 ? (
            <p className="text-xs text-text-muted">No releases have been published yet.</p>
          ) : (
            releases.map((r) => {
              const cmp = version ? compareVersions(r.version, version) : -1;
              return (
                <section key={r.version} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <h4 className="text-xs font-bold text-text-primary truncate">{r.name}</h4>
                      {cmp > 0 && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent/15 text-accent shrink-0">New</span>
                      )}
                      {cmp === 0 && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 shrink-0">
                          Installed
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-[10px] text-text-muted">
                      <span>{formatReleaseDate(r.published_at)}</span>
                      <button
                        onClick={() => void toraApi.openExternalUrl(r.html_url)}
                        className="p-1 rounded hover:text-accent hover:bg-bg-tertiary transition cursor-pointer"
                        title="View on GitHub"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {r.body_html.trim() ? (
                    <ReleaseNotesHtml html={r.body_html} />
                  ) : (
                    <p className="text-xs text-text-muted">No release notes.</p>
                  )}
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
