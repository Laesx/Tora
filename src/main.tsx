import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/App";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { installGlobalErrorLogging } from "@/lib/log";
import "@/styles/index.css";

installGlobalErrorLogging();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="root" fullScreen>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
