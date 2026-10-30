import React from "react";
import { ExternalLink, Keyboard, LogIn, LogOut, Search, Settings, User } from "lucide-react";
import { AppSettings } from "@/lib/types";
import toraMark from "@/assets/tora-mark.svg";
import { NAV_ITEMS, NavTab, SETTINGS_SHORTCUT_DIGIT } from "./nav";

interface SidebarProps {
  activeTab: NavTab;
  onNavigate: (tab: NavTab) => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  /** Ctrl is held: show each tab's Ctrl+N badge */
  showShortcutHints: boolean;
  /** A player session is active (pulsing dot on Now Playing) */
  isPlaying: boolean;
  listCount: number;
  settings: AppSettings | null;
  isSignedIn: boolean;
  isAuthorizing: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onOpenProfile: () => void;
  /** Running app version (empty until known) */
  version: string;
  /** Unseen changelog or a postponed update: the version badge shows a dot and opens the changelog */
  updateDot: boolean;
  updateChecking: boolean;
  onVersionClick: () => void;
}

const navClass = (active: boolean) =>
  `w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${active ? "bg-accent text-white shadow-sm" : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
  }`;

/** Square icon buttons next to the brand (keyboard shortcuts, settings) */
const iconButtonClass = (active: boolean) =>
  `p-2 rounded-xl border transition shrink-0 cursor-pointer ${active
    ? "bg-accent border-accent text-white shadow-sm"
    : "bg-bg-primary border-border-subtle hover:border-accent/50 text-text-muted hover:text-accent"
  }`;

/**
 * Ctrl+N badge (N = the tab's position in NAV_ITEMS, or the Settings digit on the gear). Always mounted and
 * absolutely positioned so showing it never changes the row's size; it fades in while Ctrl is held.
 */
const TabHint: React.FC<{ digit: number; visible: boolean; className?: string }> = ({ digit, visible, className = "" }) => (
  <kbd
    aria-hidden={!visible}
    className={`absolute pointer-events-none px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-primary text-text-primary border border-border-subtle shadow-sm whitespace-nowrap transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"} ${className}`}
  >
    {digit}
  </kbd>
);

/** Brand, Ctrl+K button, tab navigation and the AniList account card. */
export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onNavigate,
  onOpenSettings,
  settingsOpen,
  onOpenPalette,
  onOpenShortcuts,
  showShortcutHints,
  isPlaying,
  listCount,
  settings,
  isSignedIn,
  isAuthorizing,
  onSignIn,
  onSignOut,
  onOpenProfile,
  version,
  updateDot,
  updateChecking,
  onVersionClick,
}) => (
  <aside className="w-60 bg-bg-secondary border-r border-border-subtle flex flex-col justify-between shrink-0">
    <div className="p-4 space-y-5">
      {/* Brand, keyboard shortcuts & settings */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <img src={toraMark} alt="" className="w-9 h-9 shrink-0" draggable={false} />
          <div className="font-extrabold text-sm tracking-tight text-text-primary flex items-center gap-1.5">
            TORA
            <button
              onClick={onVersionClick}
              disabled={updateChecking}
              className={`relative text-[10px] font-mono px-1.5 py-0.2 rounded bg-accent/15 text-accent hover:bg-accent/25 transition cursor-pointer disabled:cursor-default ${updateChecking ? "animate-pulse" : ""}`}
              title={updateDot ? "What's new: open the changelog" : updateChecking ? "Checking for updates…" : "Check for updates"}
            >
              v{version || "…"}
              {updateDot && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent ring-2 ring-bg-secondary" />
              )}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={onOpenShortcuts}
            className={iconButtonClass(false)}
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="w-4 h-4" />
          </button>
          <button
            onClick={onOpenSettings}
            className={`relative ${iconButtonClass(settingsOpen)}`}
            title={`Settings (Ctrl+${SETTINGS_SHORTCUT_DIGIT})`}
          >
            <Settings className="w-4 h-4" />
            <TabHint digit={SETTINGS_SHORTCUT_DIGIT} visible={showShortcutHints} className="top-full mt-1 right-0 z-10" />
          </button>
        </div>
      </div>

      {/* Ctrl+K */}
      <button
        onClick={onOpenPalette}
        className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle hover:border-accent/50 text-xs text-text-muted hover:text-text-primary transition"
      >
        <span className="flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-accent" />
          Quick Jump...
        </span>
        <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-tertiary text-text-secondary">Ctrl+K</kbd>
      </button>

      <nav className="space-y-1">
        {NAV_ITEMS.map(({ id, label, icon: Icon }, i) => (
          <React.Fragment key={id}>
            <button onClick={() => onNavigate(id)} className={navClass(activeTab === id)}>
              <span className="flex items-center gap-2.5">
                <Icon className="w-4 h-4" />
                {label}
              </span>
              {/* The count / playing dot fades out under the Ctrl badge */}
              <span className="relative flex items-center">
                <span className={`flex items-center transition-opacity duration-200 ${showShortcutHints ? "opacity-0" : "opacity-100"}`}>
                  {id === "nowplaying" && isPlaying && (
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  )}
                  {id === "watchlist" && <span className="text-[11px] font-mono opacity-80">{listCount}</span>}
                </span>
                <TabHint digit={i + 1} visible={showShortcutHints} className="right-0 top-1/2 -translate-y-1/2" />
              </span>
            </button>
            {id === "nowplaying" && (
              <div className="py-1.5 px-1">
                <div className="border-t border-border-subtle" />
              </div>
            )}
          </React.Fragment>
        ))}
      </nav>
    </div>

    {/* AniList account */}
    <div className="p-3">
      {isSignedIn && settings ? (
        <div className="flex items-center justify-between gap-2 p-2 rounded-xl bg-bg-primary border border-border-subtle">
          <button
            onClick={onOpenProfile}
            className="flex items-center gap-2.5 min-w-0 flex-1 text-left group cursor-pointer"
            title={`Open @${settings.anilist_username} on AniList`}
          >
            {settings.anilist_avatar ? (
              <img
                src={settings.anilist_avatar}
                alt={settings.anilist_username}
                className="w-9 h-9 rounded-full object-cover border border-border-subtle group-hover:border-accent transition shrink-0 bg-bg-tertiary"
              />
            ) : (
              <div className="w-9 h-9 rounded-full bg-accent/15 border border-accent/30 group-hover:border-accent flex items-center justify-center text-accent font-bold text-xs shrink-0 transition">
                {settings.anilist_username ? (
                  settings.anilist_username.charAt(0).toUpperCase()
                ) : (
                  <User className="w-4 h-4" />
                )}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-text-primary group-hover:text-accent transition truncate flex items-center gap-1">
                <span className="truncate">{settings.anilist_username || "AniList User"}</span>
                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition shrink-0 text-accent" />
              </div>
              <div className="text-[10px] text-text-muted truncate">AniList Profile</div>
            </div>
          </button>

          <button
            onClick={onSignOut}
            className="p-2 rounded-lg text-text-muted hover:text-rose-400 hover:bg-rose-500/10 transition shrink-0 cursor-pointer"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          onClick={onSignIn}
          className="w-full flex items-center gap-3 p-3 rounded-xl bg-gradient-to-r from-accent/15 via-bg-primary to-bg-primary border border-accent/40 hover:border-accent hover:from-accent/25 transition text-left group cursor-pointer shadow-sm"
        >
          <div className="w-9 h-9 rounded-xl bg-accent text-white flex items-center justify-center shrink-0 shadow-sm group-hover:scale-105 transition">
            <LogIn className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-bold text-text-primary group-hover:text-accent transition">
              {isAuthorizing ? "Waiting for AniList..." : "Sign in with AniList"}
            </div>
            <div className="text-[10px] text-text-muted truncate">
              {isAuthorizing ? "Authorize in browser or click to retry" : "Click to authorize & sync your list"}
            </div>
          </div>
        </button>
      )}
    </div>
  </aside>
);
