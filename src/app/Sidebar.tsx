import React from "react";
import { ExternalLink, LogIn, LogOut, Search, Settings, User } from "lucide-react";
import { AppSettings } from "@/lib/types";
import { NAV_ITEMS, NavTab } from "./nav";

interface SidebarProps {
  activeTab: NavTab;
  onNavigate: (tab: NavTab) => void;
  onOpenPalette: () => void;
  /** A player session is active (pulsing dot on Now Playing) */
  isPlaying: boolean;
  listCount: number;
  settings: AppSettings | null;
  isSignedIn: boolean;
  isAuthorizing: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onOpenProfile: () => void;
}

const navClass = (active: boolean) =>
  `w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition ${active ? "bg-accent text-white shadow-sm" : "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
  }`;

/** Brand, Ctrl+K button, tab navigation and the AniList account card. */
export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onNavigate,
  onOpenPalette,
  isPlaying,
  listCount,
  settings,
  isSignedIn,
  isAuthorizing,
  onSignIn,
  onSignOut,
  onOpenProfile,
}) => (
  <aside className="w-60 bg-bg-secondary border-r border-border-subtle flex flex-col justify-between shrink-0">
    <div className="p-4 space-y-5">
      {/* Brand */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white font-black text-lg shadow-md">
            虎
          </div>
          <div>
            <div className="font-extrabold text-sm tracking-tight text-text-primary flex items-center gap-1.5">
              TORA
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-accent/15 text-accent">v0.1</span>
            </div>
            <div className="text-[10px] text-text-muted">Anime Library & Tracker</div>
          </div>
        </div>

        <button
          onClick={() => onNavigate("settings")}
          className={`p-2 rounded-lg transition shrink-0 cursor-pointer ${activeTab === "settings"
            ? "bg-accent text-white shadow-sm"
            : "bg-bg-tertiary hover:bg-bg-elevated text-text-secondary hover:text-accent"
            }`}
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
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
        {NAV_ITEMS.filter((item) => item.id !== "settings").map(({ id, label, icon: Icon }) => (
          <React.Fragment key={id}>
            <button onClick={() => onNavigate(id)} className={navClass(activeTab === id)}>
              <span className="flex items-center gap-2.5">
                <Icon className="w-4 h-4" />
                {label}
              </span>
              {id === "nowplaying" && isPlaying && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              )}
              {id === "watchlist" && <span className="text-[11px] font-mono opacity-80">{listCount}</span>}
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
