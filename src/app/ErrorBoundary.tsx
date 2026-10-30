import React from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { errorText, log } from "@/lib/log";

interface ErrorBoundaryProps {
  /** Log scope ("root", "tab:watchlist"…) */
  scope: string;
  /** Fill the window (root) instead of the tab area */
  fullScreen?: boolean;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * A render error shows what broke (and is logged with the component stack) instead of React
 * unmounting everything into an empty window. "Try again" re-mounts the children.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    log.error(this.props.scope, `Render error${info.componentStack ? `\n${info.componentStack.trim()}` : ""}`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className={`flex items-center justify-center p-6 ${this.props.fullScreen ? "h-screen w-screen bg-bg-primary" : "min-h-[50vh]"}`}
      >
        <div className="max-w-xl w-full bg-bg-secondary border border-red-500/40 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-bold text-text-primary">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            Something went wrong
          </div>
          <p className="text-xs text-text-secondary">
            This part of Tora crashed. The error was written to the log (Settings → Diagnostics → Logs).
          </p>
          <pre className="text-[11px] font-mono text-red-300 bg-bg-primary rounded-xl p-3 max-h-48 overflow-auto whitespace-pre-wrap break-all">
            {errorText(error)}
          </pre>
          <div className="flex items-center gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-bg-tertiary hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-semibold transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
