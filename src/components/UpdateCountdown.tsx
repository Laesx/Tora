import React from "react";
import { DetectedMediaSession } from "@/lib/types";
import { useNow } from "@/hooks/useNow";

/**
 * Seconds until the auto update. The backend sends a deadline (`update_due_at`) that only moves when
 * the countdown starts, pauses or resumes, so this ticks from the local clock; paused, it shows the
 * frozen `update_remaining_seconds`.
 */
export const UpdateCountdown: React.FC<{ session: DetectedMediaSession; delaySeconds: number }> = ({
  session,
  delaySeconds,
}) => {
  // Re-renders only when the second changes
  const now = useNow(250);
  const left =
    session.update_due_at !== null
      ? session.update_due_at - now
      : (session.update_remaining_seconds ?? delaySeconds);
  return <>{Math.max(0, left)}</>;
};
