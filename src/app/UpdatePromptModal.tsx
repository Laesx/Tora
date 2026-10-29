import React from "react";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { InstallUpdateButton, ReleaseNotesHtml, useChangelog } from "./ChangelogModal";
import type { UpdateProgress } from "./useAppUpdater";

interface UpdatePromptModalProps {
  currentVersion: string;
  newVersion: string;
  /** Notes from the update manifest (`latest.json`); used when GitHub's release notes can't be loaded */
  manifestNotes: string | undefined;
  progress: UpdateProgress | null;
  onInstall: () => void;
  onViewChangelog: () => void;
  /** "Later": the sidebar version keeps a dot that leads back to the update */
  onLater: () => void;
}

/** "Tora vX is available" after a check found an update. Esc = Later (handled globally). */
export const UpdatePromptModal: React.FC<UpdatePromptModalProps> = ({
  currentVersion,
  newVersion,
  manifestNotes,
  progress,
  onInstall,
  onViewChangelog,
  onLater,
}) => {
  const { releases, error } = useChangelog();
  const release = releases?.find((r) => r.version === newVersion);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={progress ? undefined : onLater}
    >
      <div
        className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 max-w-lg w-full max-h-[85vh] shadow-2xl flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-primary">A new version of Tora is available</h3>
            <p className="text-[11px] text-text-muted font-mono flex items-center gap-1.5">
              v{currentVersion}
              <ArrowRight className="w-3 h-3" />
              <span className="text-accent font-semibold">v{newVersion}</span>
            </p>
          </div>
        </div>

        <div className="overflow-y-auto min-h-0 rounded-xl bg-bg-primary border border-border-subtle p-3.5">
          {release?.body_html.trim() ? (
            <ReleaseNotesHtml html={release.body_html} />
          ) : !releases && !error ? (
            <p className="text-xs text-text-muted flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
              Loading release notes…
            </p>
          ) : manifestNotes?.trim() ? (
            <p className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">{manifestNotes}</p>
          ) : (
            <p className="text-xs text-text-muted">No release notes.</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2.5">
          <button
            onClick={onViewChangelog}
            disabled={!!progress}
            className="text-xs font-semibold text-text-muted hover:text-accent transition cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            Full changelog
          </button>
          <div className="flex items-center gap-2.5">
            {!progress && (
              <button
                onClick={onLater}
                className="px-4 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-text-primary text-xs font-semibold border border-border-subtle transition cursor-pointer"
              >
                Later
              </button>
            )}
            <InstallUpdateButton version={newVersion} progress={progress} onInstall={onInstall} />
          </div>
        </div>
      </div>
    </div>
  );
};
