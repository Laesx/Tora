import React, { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type { ToastType } from "@/contexts/toast";

interface ToastMessage {
  msg: string;
  type: ToastType;
}

const TOAST_MS = 4000;

/** The current toast and a stable `showToast` (each call replaces the previous toast). */
export function useToastState() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const showToast = useCallback((msg: string, type: ToastType = "info") => setToast({ msg, type }), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  return [toast, showToast] as const;
}

const TOAST_CLASS: Record<ToastType, string> = {
  error: "bg-red-950/95 border-red-500 text-red-200",
  success: "bg-emerald-950/95 border-emerald-500 text-emerald-200",
  info: "bg-bg-elevated border-accent text-text-primary",
};

export const Toast: React.FC<{ toast: ToastMessage }> = ({ toast }) => (
  <div
    className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-2xl border text-xs font-semibold flex items-center gap-2.5 transition-all ${TOAST_CLASS[toast.type]}`}
  >
    <Sparkles className="w-4 h-4 text-accent shrink-0" />
    <span>{toast.msg}</span>
  </div>
);
