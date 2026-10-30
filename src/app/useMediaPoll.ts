import { useCallback, useEffect, useRef, useState } from "react";
import { DetectedMediaSession } from "@/lib/types";
import { toraApi } from "@/lib/api";

const POLL_MS = 2500;

const sameSession = (a: DetectedMediaSession, b: DetectedMediaSession) =>
  a.cleaned_media_title === b.cleaned_media_title && a.player_name === b.player_name;

/**
 * Polls Anisthesia player recognition every 2.5 s (never overlapping). `onNewSession` runs when a
 * different file starts playing, `onScrobbled` when the backend auto-synced the episode.
 */
export function useMediaPoll(handlers: {
  onNewSession: () => void;
  onScrobbled: (session: DetectedMediaSession) => void;
}) {
  const [activeSession, setActiveSession] = useState<DetectedMediaSession | null>(null);
  const sessionRef = useRef<DetectedMediaSession | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const setSession = useCallback((session: DetectedMediaSession | null) => {
    sessionRef.current = session;
    setActiveSession(session);
  }, []);

  useEffect(() => {
    let inFlight = false;
    const interval = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const session = await toraApi.pollMediaRecognition();
        const prev = sessionRef.current;
        if (!prev && !session) return;
        if (session && (!prev || !sameSession(prev, session))) handlersRef.current.onNewSession();
        if (session?.matched_anime_id && session.auto_synced && !prev?.auto_synced) {
          handlersRef.current.onScrobbled(session);
        }
        // Skip re-renders while nothing visible changed (the countdown ticks from its deadline)
        const unchanged =
          prev &&
          session &&
          sameSession(prev, session) &&
          prev.matched_anime_id === session.matched_anime_id &&
          prev.matched_current_progress === session.matched_current_progress &&
          prev.auto_synced === session.auto_synced &&
          prev.awaiting_confirmation === session.awaiting_confirmation &&
          prev.waiting_for_close === session.waiting_for_close &&
          prev.player_closed === session.player_closed &&
          prev.update_due_at === session.update_due_at &&
          prev.update_remaining_seconds === session.update_remaining_seconds;
        if (!unchanged) setSession(session);
      } catch {
        // Ignore transient poll errors
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [setSession]);

  return [activeSession, setSession] as const;
}
