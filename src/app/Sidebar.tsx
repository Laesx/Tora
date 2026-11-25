import React, { useCallback, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronsUpDown, ExternalLink, Keyboard, LogIn, Search, Settings } from "lucide-react";
import { useTracker } from "@/contexts/tracker";
import { AccountAvatar, AccountMenu } from "./AccountMenu";
import { useStoredAccounts } from "./useStoredAccounts";
import toraMark from "@/assets/tora-mark.svg";
import { KeyHint } from "@/components/KeyHint";
import { NAV_ITEMS, NavTab, SETTINGS_SHORTCUT_DIGIT } from "./nav";

interface SidebarProps {
  activeTab: NavTab;
  onNavigate: (tab: NavTab) => void;
  /** Where Back / Forward lead (tooltips); null = nowhere, the button is disabled */
  backLabel: string | null;
  forwardLabel: string | null;
  onBack: () => void;
  onForward: () => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  /** Ctrl is held: show each tab's Ctrl+N badge */
  showShortcutHints: boolean;
  listCount: number;
  isAuthorizing: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onOpenProfile: () => void;
  /** Settings → Tracker (the account menu's "Manage accounts…") */
  onManageAccounts: () => void;
  /** Running app version (empty until known) */
  version: string;
  /** Unseen changelog or a postponed update: the version badge shows a dot and opens the changelog */
  updateDot: boolean;
  updateChecking: boolean;
  onVersionClick: () => void;
}

const navClass = (active: boolean) =>
  `w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed ${active ? "bg-accent text-white shadow-sm" : "text-text-secondary enabled:hover:bg-bg-tertiary enabled:hover:text-text-primary"
  }`;

/** Square icon button next to the brand (settings) */
const iconButtonClass = (active: boolean) =>
  `p-2 rounded-xl border transition shrink-0 cursor-pointer ${active
    ? "bg-accent border-accent text-white shadow-sm"
    : "bg-bg-primary border-border-subtle hover:border-accent/50 text-text-muted hover:text-accent"
  }`;

/** Back / Forward halves of the pill next to the brand */
const navArrowClass =
  "p-1.5 text-text-muted hover:text-accent hover:bg-bg-tertiary transition cursor-pointer disabled:opacity-40 disabled:pointer-events-none";

/** Brand, Back / Forward, Ctrl+S button, tab navigation, keyboard shortcuts and the tracker account card. */
export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onNavigate,
  backLabel,
  forwardLabel,
  onBack,
  onForward,
  onOpenSettings,
  settingsOpen,
  onOpenPalette,
  onOpenShortcuts,
  showShortcutHints,
  listCount,
  isAuthorizing,
  onSignIn,
  onSignOut,
  onOpenProfile,
  onManageAccounts,
  version,
  updateDot,
  updateChecking,
  onVersionClick,
}) => (
  <aside className="w-60 bg-bg-secondary border-r border-border-subtle flex flex-col justify-between shrink-0">
    <div className="p-4 space-y-4">
      {/* Brand + version, Back / Forward, Settings */}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <img src={toraMark} alt="" className="w-9 h-9 shrink-0" draggable={false} />
          <div className="flex flex-col items-start gap-0.5 min-w-0">
            <span className="font-extrabold text-sm leading-none tracking-tight text-text-primary">TORA</span>
            <button
              onClick={onVersionClick}
              disabled={updateChecking}
              className={`relative text-[10px] leading-4 font-mono px-1.5 rounded bg-accent/15 text-accent hover:bg-accent/25 transition cursor-pointer disabled:cursor-default ${updateChecking ? "animate-pulse" : ""}`}
              title={updateDot ? "What's new" : updateChecking ? "Checking for updates…" : "Check for updates"}
            >
              v{version || "…"}
              {updateDot && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent ring-2 ring-bg-secondary" />
              )}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center rounded-xl border border-border-subtle bg-bg-primary overflow-hidden">
            <button
              onClick={onBack}
              disabled={!backLabel}
              className={navArrowClass}
              title={backLabel ? `Back to ${backLabel} (Alt+←)` : "Back (Alt+←)"}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <span className="w-px self-stretch bg-border-subtle" />
            <button
              onClick={onForward}
              disabled={!forwardLabel}
              className={navArrowClass}
              title={forwardLabel ? `Forward to ${forwardLabel} (Alt+→)` : "Forward (Alt+→)"}
            >
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={onOpenSettings}
            className={`relative ${iconButtonClass(settingsOpen)}`}
            title={`Settings (Ctrl+${SETTINGS_SHORTCUT_DIGIT})`}
          >
            <Settings className="w-4 h-4" />
            <KeyHint label={String(SETTINGS_SHORTCUT_DIGIT)} visible={showShortcutHints} className="top-full mt-1 right-0 z-10" />
          </button>
        </div>
      </div>

      {/* Ctrl+S: the main way around the app */}
      <button
        onClick={onOpenPalette}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-bg-primary border border-border-subtle hover:border-accent/50 text-[13px] text-text-secondary hover:text-text-primary transition cursor-pointer"
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <Search className="w-4 h-4 text-accent shrink-0" />
          <span className="truncate font-medium">Quick Jump</span>
        </span>
        <kbd className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-tertiary text-text-secondary">Ctrl+S</kbd>
      </button>

      <NavList activeTab={activeTab} onNavigate={onNavigate} showShortcutHints={showShortcutHints} listCount={listCount} />
    </div>

    <div className="p-3 space-y-2">
      <button
        onClick={onOpenShortcuts}
        className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition cursor-pointer"
      >
        <span className="flex items-center gap-2.5">
          <Keyboard className="w-4 h-4" />
          Shortcuts
        </span>
        <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-bg-tertiary text-text-secondary">?</kbd>
      </button>

      <AccountCard
        isAuthorizing={isAuthorizing}
        onSignIn={onSignIn}
        onSignOut={onSignOut}
        onOpenProfile={onOpenProfile}
        onManageAccounts={onManageAccounts}
      />
    </div>
  </aside>
);

/** The tabs; one the active tracker can't back is disabled, its tooltip saying why. */
const NavList: React.FC<{
  activeTab: NavTab;
  onNavigate: (tab: NavTab) => void;
  showShortcutHints: boolean;
  listCount: number;
}> = ({ activeTab, onNavigate, showShortcutHints, listCount }) => {
  const tracker = useTracker();
  return (
    <nav className="space-y-1">
      {NAV_ITEMS.map(({ id, label, icon: Icon, needs }, i) => {
        const off = needs !== undefined && !tracker.supports(needs.feature);
        return (
          <React.Fragment key={id}>
            <button
              onClick={() => onNavigate(id)}
              disabled={off}
              title={off ? `${tracker.name} ${needs!.missing}` : undefined}
              className={navClass(activeTab === id)}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="w-4 h-4" />
                {label}
              </span>
              {/* The count fades out under the Ctrl badge */}
              <span className="relative flex items-center">
                <span className={`flex items-center transition-opacity duration-200 ${showShortcutHints ? "opacity-0" : "opacity-100"}`}>
                  {id === "watchlist" && <span className="text-[11px] font-mono opacity-80">{listCount}</span>}
                </span>
                {!off && <KeyHint label={String(i + 1)} visible={showShortcutHints} className="right-0 top-1/2 -translate-y-1/2" />}
              </span>
            </button>
            {id === "nowplaying" && (
              <div className="py-1.5 px-1">
                <div className="border-t border-border-subtle" />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
};

/** The signed-in account (avatar → profile, the rest → account menu), or the sign-in button for the active tracker. */
const AccountCard: React.FC<{
  isAuthorizing: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onOpenProfile: () => void;
  onManageAccounts: () => void;
}> = ({ isAuthorizing, onSignIn, onSignOut, onOpenProfile, onManageAccounts }) => {
  const { account, name } = useTracker();
  // Loaded here, not in the menu: the menu then opens at its full size at once
  const stored = useStoredAccounts();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const toggleMenu = () => {
    const rect = cardRef.current?.getBoundingClientRect();
    // List sizes may have changed since the last load: refreshed in the background, the rows stay put
    if (!menuAt) stored.reload();
    setMenuAt((open) => (open || !rect ? null : { x: rect.left, y: rect.top - 6 }));
  };
  const closeMenu = useCallback(() => setMenuAt(null), []);
  if (account) {
    // The avatar opens the profile on the tracker's site; the rest of the card (left or right click) the switcher
    return (
      <>
        <div
          ref={cardRef}
          className={`w-full flex items-center rounded-xl bg-bg-primary border transition ${menuAt ? "border-accent" : "border-border-subtle hover:border-accent/50"}`}
        >
          <button
            onClick={onOpenProfile}
            title={`View profile on ${name}`}
            className="shrink-0 p-2 pr-1 rounded-l-xl cursor-pointer group/avatar"
          >
            <AccountAvatar avatarUrl={account.avatar_url} name={account.username} tracker={account.tracker}>
              <span className="absolute inset-0 rounded-full bg-black/35 opacity-0 group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100 transition flex items-center justify-center text-white">
                <ExternalLink className="w-3.5 h-3.5 drop-shadow" />
              </span>
            </AccountAvatar>
          </button>
          <button
            onClick={toggleMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              toggleMenu();
            }}
            // The menu closes on any press outside it: this one toggles it instead of reopening at once
            onMouseDown={(e) => menuAt && e.stopPropagation()}
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            title="Switch account"
            className="min-w-0 flex-1 flex items-center gap-2.5 p-2 pl-2.5 rounded-r-xl text-left group cursor-pointer"
          >
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-text-primary group-hover:text-accent transition truncate">
                {account.username || `${name} user`}
              </div>
              <div className="text-[10px] text-text-muted truncate">{name}</div>
            </div>
            <ChevronsUpDown className="w-4 h-4 text-text-muted group-hover:text-accent transition shrink-0" />
          </button>
        </div>
        {menuAt && (
          <AccountMenu
            anchor={menuAt}
            stored={stored}
            onClose={closeMenu}
            onOpenProfile={onOpenProfile}
            onManageAccounts={onManageAccounts}
            onSignOut={onSignOut}
          />
        )}
      </>
    );
  }
  return (
      <button
        onClick={onSignIn}
        className="w-full flex items-center gap-3 p-3 rounded-xl bg-gradient-to-r from-accent/15 via-bg-primary to-bg-primary border border-accent/40 hover:border-accent hover:from-accent/25 transition text-left group cursor-pointer shadow-sm"
      >
        <div className="w-9 h-9 rounded-xl bg-accent text-white flex items-center justify-center shrink-0 shadow-sm group-hover:scale-105 transition">
          <LogIn className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold text-text-primary group-hover:text-accent transition">
            {isAuthorizing ? `Waiting for ${name}...` : `Sign in with ${name}`}
          </div>
          {isAuthorizing && (
            <div className="text-[10px] text-text-muted truncate">Continue in browser, or click to retry</div>
          )}
        </div>
      </button>
  );
};
