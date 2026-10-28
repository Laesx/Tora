import React, { useEffect, useMemo, useState } from "react";
import {
  Download,
  Search,
  Filter,
  Sparkles,
  CheckCircle2,
  ShieldCheck,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  SlidersHorizontal,
  Magnet,
  RefreshCw,
} from "lucide-react";
import { AnimeEntry, TorrentItem, TorrentRule } from "../types";
import { toraApi } from "../api";

interface TorrentsViewProps {
  animeList: AnimeEntry[];
  initialQuery: string;
  onSelectAnime: (anime: AnimeEntry) => void;
  showToast: (msg: string, type?: "success" | "info" | "error") => void;
}

export const TorrentsView: React.FC<TorrentsViewProps> = ({
  animeList,
  initialQuery,
  onSelectAnime,
  showToast,
}) => {
  const [subTab, setSubTab] = useState<"search" | "rules">("search");
  const [query, setQuery] = useState(initialQuery || "");
  const [provider, setProvider] = useState("nyaa");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<TorrentItem[]>([]);
  const [rules, setRules] = useState<TorrentRule[]>([]);
  const [onlyHighlighted, setOnlyHighlighted] = useState(false);
  const [resolutionFilter, setResolutionFilter] = useState("ALL");

  // New rule state
  const [ruleName, setRuleName] = useState("");
  const [ruleTitleFilter, setRuleTitleFilter] = useState("");
  const [ruleGroup, setRuleGroup] = useState("SubsPlease");
  const [ruleRes, setRuleRes] = useState("1080p");
  const [ruleExclude, setRuleExclude] = useState("480p, Dub, Batch");
  const [ruleAction, setRuleAction] = useState("highlight");
  const [ruleOnlyUnwatched, setRuleOnlyUnwatched] = useState(true);

  const watchingAnime = useMemo(
    () => animeList.filter((a) => a.user_status === "CURRENT"),
    [animeList]
  );

  const loadRules = async () => {
    try {
      const r = await toraApi.getTorrentRules();
      setRules(r);
    } catch (e) {
      console.error(e);
    }
  };

  const runSearch = async (searchText = query, prov = provider) => {
    setLoading(true);
    try {
      const res = await toraApi.searchTorrents(searchText, prov);
      setItems(res);
    } catch (err: any) {
      showToast(String(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRules();
    runSearch(initialQuery || "", provider);
  }, []);

  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      setSubTab("search");
      runSearch(initialQuery, provider);
    }
  }, [initialQuery]);

  const handleDownload = async (item: TorrentItem) => {
    try {
      const msg = await toraApi.downloadTorrent(
        item.magnet_url,
        item.torrent_url,
        item.matched_anime_id
      );
      showToast(msg, "success");
    } catch (err: any) {
      showToast(String(err), "error");
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleName.trim()) return;
    try {
      const updated = await toraApi.saveTorrentRule({
        id: 0,
        name: ruleName.trim(),
        enabled: true,
        anime_title_filter: ruleTitleFilter.trim(),
        anime_id: null,
        release_group: ruleGroup.trim(),
        resolution: ruleRes,
        exclude_keywords: ruleExclude.trim(),
        action: ruleAction,
        only_unwatched: ruleOnlyUnwatched,
      });
      setRules(updated);
      setRuleName("");
      setRuleTitleFilter("");
      showToast("Saved Taiga RSS filter rule!", "success");
    } catch (err: any) {
      showToast(String(err), "error");
    }
  };

  const handleToggleRule = async (rule: TorrentRule) => {
    const updated = await toraApi.saveTorrentRule({
      ...rule,
      enabled: !rule.enabled,
    });
    setRules(updated);
  };

  const handleDeleteRule = async (ruleId: number) => {
    const updated = await toraApi.deleteTorrentRule(ruleId);
    setRules(updated);
    showToast("Deleted filter rule", "info");
  };

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (item.matched_rule_action === "discard") return false;
      if (onlyHighlighted && !item.matched_rule_action && !item.matched_anime_id) {
        return false;
      }
      if (
        resolutionFilter !== "ALL" &&
        item.parsed.video_resolution !== resolutionFilter
      ) {
        return false;
      }
      return true;
    });
  }, [items, onlyHighlighted, resolutionFilter]);

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      {/* Header & Sub-navigation */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2.5">
            <Magnet className="w-6 h-6 text-accent" />
            Torrent Search
          </h1>
        </div>

        <div className="flex items-center gap-1.5 bg-bg-secondary p-1 rounded-xl border border-border-subtle">
          <button
            onClick={() => setSubTab("search")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${subTab === "search"
                ? "bg-accent text-white"
                : "text-text-secondary hover:text-text-primary"
              }`}
          >
            <Search className="w-3.5 h-3.5" />
            Torrent Feed & Search
          </button>
          <button
            onClick={() => setSubTab("rules")}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${subTab === "rules"
                ? "bg-accent text-white"
                : "text-text-secondary hover:text-text-primary"
              }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Smart Filter Rules ({rules.length})
          </button>
        </div>
      </div>

      {subTab === "search" ? (
        <>
          {/* Search Bar & Watching Quick Chips */}
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-4 space-y-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                runSearch(query, provider);
              }}
              className="flex flex-wrap items-center gap-2.5"
            >
              <div className="relative flex-1 min-w-[240px]">
                <Search className="w-4 h-4 text-text-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search anime title, release group, episode (or leave blank for latest RSS feed)..."
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary focus:outline-none focus:border-accent"
                />
              </div>

              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  runSearch(query, e.target.value);
                }}
                className="px-3 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary"
              >
                <option value="nyaa">Nyaa.si (Anime Eng-Translated)</option>
                <option value="animetosho">AnimeTosho RSS2</option>
              </select>

              <select
                value={resolutionFilter}
                onChange={(e) => setResolutionFilter(e.target.value)}
                className="px-3 py-2.5 rounded-xl bg-bg-primary border border-border-subtle text-xs text-text-primary"
              >
                <option value="ALL">All Resolutions</option>
                <option value="2160p">2160p (4K)</option>
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
              </select>

              <button
                type="button"
                onClick={() => setOnlyHighlighted(!onlyHighlighted)}
                className={`px-3 py-2.5 rounded-xl text-xs font-medium border transition flex items-center gap-1.5 ${onlyHighlighted
                    ? "bg-amber-500/20 border-amber-500 text-amber-300"
                    : "bg-bg-primary border-border-subtle text-text-secondary hover:text-text-primary"
                  }`}
              >
                <Filter className="w-3.5 h-3.5" />
                Watchlist / Rules Only
              </button>

              <button
                type="submit"
                disabled={loading}
                className="px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition flex items-center gap-1.5"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
                />
                {loading ? "Fetching..." : "Search"}
              </button>
            </form>

            {/* Quick Search Chips for Currently Watching Shows */}
            {watchingAnime.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[11px] text-text-muted mr-1">
                  Quick Next Ep Search:
                </span>
                {watchingAnime.map((a) => {
                  const nextEp = String(a.user_progress + 1).padStart(2, "0");
                  const chipQuery = `${a.title_romaji} ${nextEp}`;
                  return (
                    <button
                      key={a.id}
                      onClick={() => {
                        setQuery(chipQuery);
                        runSearch(chipQuery, provider);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-bg-tertiary hover:bg-accent/20 hover:text-accent text-text-secondary text-[11px] border border-border-subtle transition"
                    >
                      {a.title_romaji}{" "}
                      <span className="font-mono font-bold text-accent">
                        #{nextEp}
                      </span>
                    </button>
                  );
                })}
                <button
                  onClick={() => {
                    setQuery("");
                    runSearch("", provider);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-bg-primary hover:bg-bg-tertiary text-text-muted text-[11px] border border-border-subtle transition"
                >
                  Latest Feed
                </button>
              </div>
            )}
          </div>

          {/* Torrent Results List */}
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl overflow-hidden">
            {loading ? (
              <div className="py-16 text-center text-xs text-text-muted flex flex-col items-center gap-2">
                <RefreshCw className="w-6 h-6 text-accent animate-spin" />
                <span>Querying {provider.toUpperCase()} RSS feed & parsing with Anitomy...</span>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="py-14 text-center text-xs text-text-muted">
                No torrents matched your search or filter criteria.
              </div>
            ) : (
              <div className="divide-y divide-border-subtle">
                {filteredItems.map((item, idx) => {
                  const isAuto = item.matched_rule_action === "auto_download";
                  const isHighlight = item.matched_rule_action === "highlight";
                  const linkedAnime = animeList.find(
                    (a) => a.id === item.matched_anime_id
                  );

                  return (
                    <div
                      key={`${item.info_hash || idx}-${idx}`}
                      className={`p-3.5 flex flex-wrap items-center justify-between gap-3 transition text-xs ${isAuto
                          ? "bg-emerald-500/10 hover:bg-emerald-500/15"
                          : isHighlight
                            ? "bg-amber-500/10 hover:bg-amber-500/15"
                            : "hover:bg-bg-tertiary/40"
                        }`}
                    >
                      <div className="flex-1 min-w-[280px] space-y-1.5">
                        {/* Anitomy Badges Row */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.matched_rule_name && (
                            <span
                              className={`px-2 py-0.5 rounded font-semibold text-[10px] flex items-center gap-1 ${isAuto
                                  ? "bg-emerald-500 text-black"
                                  : "bg-amber-500 text-black"
                                }`}
                            >
                              <Sparkles className="w-3 h-3" />
                              Rule: {item.matched_rule_name}
                            </span>
                          )}

                          {linkedAnime && (
                            <button
                              onClick={() => onSelectAnime(linkedAnime)}
                              className="px-2 py-0.5 rounded bg-accent/20 text-accent font-semibold text-[10px] hover:underline flex items-center gap-1"
                            >
                              <CheckCircle2 className="w-3 h-3" />
                              In Library: {linkedAnime.title_romaji}
                            </button>
                          )}

                          {item.parsed.release_group && (
                            <span className="px-1.5 py-0.5 rounded bg-bg-tertiary border border-border-subtle text-text-secondary font-mono text-[10px]">
                              [{item.parsed.release_group}]
                            </span>
                          )}

                          {item.parsed.episode_number !== null && (
                            <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono font-bold text-[10px]">
                              Ep {item.parsed.episode_number}
                            </span>
                          )}

                          {item.parsed.video_resolution && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono text-[10px]">
                              {item.parsed.video_resolution}
                            </span>
                          )}

                          {item.parsed.video_term.map((vt) => (
                            <span
                              key={vt}
                              className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-mono text-[10px]"
                            >
                              {vt}
                            </span>
                          ))}

                          {item.is_trusted && (
                            <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[10px] flex items-center gap-0.5">
                              <ShieldCheck className="w-3 h-3" />
                              Trusted
                            </span>
                          )}
                        </div>

                        {/* Full Raw Torrent Title */}
                        <div className="font-medium text-text-primary break-all">
                          {item.title}
                        </div>
                      </div>

                      {/* Stats & Download Action */}
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-right font-mono text-[11px] space-y-0.5">
                          <div className="text-text-secondary font-semibold">
                            {item.size}
                          </div>
                          <div className="flex items-center gap-2 text-[10px]">
                            <span className="text-emerald-400 flex items-center">
                              <ArrowUp className="w-3 h-3" />
                              {item.seeders}
                            </span>
                            <span className="text-red-400 flex items-center">
                              <ArrowDown className="w-3 h-3" />
                              {item.leechers}
                            </span>
                          </div>
                        </div>

                        <button
                          onClick={() => handleDownload(item)}
                          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold shadow-sm transition"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : (
        /* Smart RSS Rules Tab */
        <div className="space-y-5">
          <form
            onSubmit={handleCreateRule}
            className="bg-bg-secondary border border-border-subtle rounded-2xl p-5 space-y-4"
          >
            <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Plus className="w-4 h-4 text-accent" />
              Create Taiga-Style Smart RSS Filter Rule
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div>
                <label className="block text-[11px] text-text-muted mb-1">
                  Rule Name
                </label>
                <input
                  type="text"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="e.g. SubsPlease 1080p Seasonal"
                  className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-text-primary"
                />
              </div>

              <div>
                <label className="block text-[11px] text-text-muted mb-1">
                  Anime Title Filter (blank = any anime in Watchlist)
                </label>
                <input
                  type="text"
                  value={ruleTitleFilter}
                  onChange={(e) => setRuleTitleFilter(e.target.value)}
                  placeholder="e.g. Sousou no Frieren"
                  className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-text-primary"
                />
              </div>

              <div>
                <label className="block text-[11px] text-text-muted mb-1">
                  Preferred Release Group
                </label>
                <input
                  type="text"
                  value={ruleGroup}
                  onChange={(e) => setRuleGroup(e.target.value)}
                  placeholder="e.g. SubsPlease, Erai-raws"
                  className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-text-primary"
                />
              </div>

              <div>
                <label className="block text-[11px] text-text-muted mb-1">
                  Resolution
                </label>
                <select
                  value={ruleRes}
                  onChange={(e) => setRuleRes(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-text-primary"
                >
                  <option value="1080p">1080p</option>
                  <option value="2160p">2160p (4K)</option>
                  <option value="720p">720p</option>
                  <option value="any">Any Resolution</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-text-muted mb-1">
                  Exclude Keywords (comma-separated)
                </label>
                <input
                  type="text"
                  value={ruleExclude}
                  onChange={(e) => setRuleExclude(e.target.value)}
                  placeholder="e.g. 480p, Dub, CAM"
                  className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-text-primary"
                />
              </div>

              <div>
                <label className="block text-[11px] text-text-muted mb-1">
                  Rule Action
                </label>
                <select
                  value={ruleAction}
                  onChange={(e) => setRuleAction(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-bg-primary border border-border-subtle text-text-primary"
                >
                  <option value="highlight">Highlight in Feed</option>
                  <option value="auto_download">Mark for Auto-Download</option>
                  <option value="discard">Hide / Discard Matching Items</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={ruleOnlyUnwatched}
                  onChange={(e) => setRuleOnlyUnwatched(e.target.checked)}
                  className="rounded accent-accent"
                />
                Only match episodes greater than my current watched progress
              </label>

              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-xs font-semibold transition"
              >
                Save Filter Rule
              </button>
            </div>
          </form>

          {/* Existing Rules List */}
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl divide-y divide-border-subtle overflow-hidden">
            {rules.map((r) => (
              <div
                key={r.id}
                className="p-4 flex items-center justify-between gap-4 text-xs"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => handleToggleRule(r)}
                      className="rounded accent-accent"
                    />
                    <span className="font-bold text-text-primary">{r.name}</span>
                    <span className="px-2 py-0.5 rounded bg-accent/15 text-accent font-mono text-[10px] uppercase">
                      {r.action}
                    </span>
                  </div>
                  <div className="text-text-muted flex flex-wrap gap-3 font-mono text-[11px]">
                    <span>
                      Title: {r.anime_title_filter || "(Any Watchlist Anime)"}
                    </span>
                    <span>Group: {r.release_group || "Any"}</span>
                    <span>Res: {r.resolution}</span>
                    {r.exclude_keywords && (
                      <span>Exclude: {r.exclude_keywords}</span>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => handleDeleteRule(r.id)}
                  className="p-2 rounded-lg text-red-400 hover:bg-red-500/15 transition"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
