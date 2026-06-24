import React, { useState, useEffect, useCallback } from "react";
import { storage } from "./storage";
import { supabase, isSupabaseConfigured } from "./supabaseClient";
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ClipboardList,
  PlusCircle,
  Settings,
  Star,
  Check,
  CheckCircle2,
  XCircle,
} from "lucide-react";

const LEAGUES = ["NFL", "NBA", "NHL", "MLB", "NCAAF", "NCAAB", "Golf", "Soccer", "Other"];

const NFL_TEAMS = [
  "Arizona Cardinals", "Atlanta Falcons", "Baltimore Ravens", "Buffalo Bills",
  "Carolina Panthers", "Chicago Bears", "Cincinnati Bengals", "Cleveland Browns",
  "Dallas Cowboys", "Denver Broncos", "Detroit Lions", "Green Bay Packers",
  "Houston Texans", "Indianapolis Colts", "Jacksonville Jaguars", "Kansas City Chiefs",
  "Las Vegas Raiders", "Los Angeles Chargers", "Los Angeles Rams", "Miami Dolphins",
  "Minnesota Vikings", "New England Patriots", "New Orleans Saints", "New York Giants",
  "New York Jets", "Philadelphia Eagles", "Pittsburgh Steelers", "San Francisco 49ers",
  "Seattle Seahawks", "Tampa Bay Buccaneers", "Tennessee Titans", "Washington Commanders",
];

const TIER_NAMES = { A: "Sharp", B: "Solid", C: "Long shot" };
const TIER_BADGE_CLASS = {
  A: "bg-[#bd93f9]/20 text-[#bd93f9] border border-[#bd93f9]/30",
  B: "bg-[#8be9fd]/10 text-[#8be9fd] border border-[#8be9fd]/30",
  C: "bg-[#44475a]/60 text-[#f8f8f2] border border-[#6272a4]/50",
};

// ---- Scoring ----
const TIER_WEIGHTS = { A: 60, B: 35, C: 15 };
const DECISIONS = [
  { key: "pass",     label: "Pass", units: 0,   textCls: "text-[#ff5555]",    bgCls: "bg-[#ff5555]/10 border-[#ff5555]/40" },
  { key: "small",    label: "0.5u", units: 0.5, textCls: "text-[#bd93f9]",   bgCls: "bg-[#bd93f9]/15 border-[#bd93f9]/40" },
  { key: "standard", label: "1u",   units: 1,   textCls: "text-[#50fa7b]", bgCls: "bg-[#50fa7b]/10 border-[#50fa7b]/40" },
  { key: "mid",      label: "1.5u", units: 1.5, textCls: "text-[#69ff94]", bgCls: "bg-[#50fa7b]/10 border-[#50fa7b]/35" },
  { key: "high",     label: "2u",   units: 2,   textCls: "text-[#69ff94]", bgCls: "bg-[#50fa7b]/10 border-[#50fa7b]/30" },
];
const DECISION = Object.fromEntries(DECISIONS.map((d) => [d.key, d]));

function scorePick(pick, sourcesMap, sport) {
  const pickSrcDetails = (pick.sources || []).map((ps) => sourcesMap[ps.sourceId]).filter(Boolean);
  const sourceScore = pickSrcDetails.reduce((s, src) => s + (TIER_WEIGHTS[getSourceTier(src, sport)] || 0), 0);
  const aCount = pickSrcDetails.filter((src) => getSourceTier(src, sport) === "A").length;
  const starBonus = pick.star ? 20 : 0;
  const total = Math.min(100, sourceScore + starBonus);
  return { total, sourceScore, starBonus, aCount };
}

function scoreToDecision(total, aCount = 0) {
  // 2u is only advisable when 2+ A-tier sources back the pick. Any other
  // composition (a B-tier, A+C, A+B, …) is capped at 1.5u even if its raw
  // score would otherwise clear the 2u bar.
  if (total >= 85) return aCount >= 2 ? DECISION.high : DECISION.mid;
  if (total >= 70) return DECISION.standard; // 1u
  if (total >= 55) return DECISION.small;     // 0.5u
  return DECISION.pass;
}

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function findNflTeam(input) {
  const norm = input.trim().toLowerCase();
  if (!norm) return null;
  let found = NFL_TEAMS.find((t) => t.toLowerCase() === norm);
  if (found) return found;
  found = NFL_TEAMS.find((t) => t.toLowerCase().endsWith(norm));
  if (found) return found;
  found = NFL_TEAMS.find((t) => t.toLowerCase().split(" ").pop() === norm);
  return found || null;
}

function pickDisplayLabel(pick, game) {
  // New picks store label directly
  if (pick.label) return pick.label;
  // Migrate old structured picks
  const hasLine = pick.line !== "" && pick.line !== null && pick.line !== undefined;
  const lineNum = hasLine ? Number(pick.line) : null;
  if (pick.market === "spread") {
    const team = game?.league === "NFL" ? (pick.side === "away" ? game.awayTeam : game.homeTeam) : pick.side;
    const lineStr = lineNum === null ? "" : lineNum > 0 ? ` +${lineNum}` : ` ${lineNum}`;
    return `${team}${lineStr}`;
  }
  if (pick.market === "moneyline") {
    const team = game?.league === "NFL" ? (pick.side === "away" ? game.awayTeam : game.homeTeam) : pick.side;
    return `${team} ML`;
  }
  if (pick.market === "total") {
    const dir = pick.side === "over" ? "Over" : "Under";
    return `${dir}${lineNum !== null ? " " + lineNum : ""}`;
  }
  if (pick.market === "prop") {
    const dir = pick.side === "over" ? "Over" : "Under";
    return `${pick.playerName} ${dir} ${lineNum !== null ? lineNum : ""} ${pick.statType}`.replace(/\s+/g, " ").trim();
  }
  return "Pick";
}

// Migrate old sources ({ tier }) to new shape ({ defaultTier, sportTiers })
function migrateSource(s) {
  if (s.defaultTier !== undefined) return s;
  return { ...s, defaultTier: s.tier || "B", sportTiers: {} };
}

function getSourceTier(source, sport) {
  if (!source) return null;
  if (sport && source.sportTiers?.[sport]) return source.sportTiers[sport];
  return source.defaultTier || source.tier || "C";
}

// Migrate old games — strip weekId, keep everything else
function migrateGame(g) {
  const { weekId, ...rest } = g;
  return rest;
}

// Migrate old picks — reconstruct label from structured fields
function migratePick(pick) {
  const migrated = pick.sources ? pick : {
    ...pick,
    sources: [{ sourceId: pick.sourceId, line: pick.line || "", dateAdded: pick.createdAt }],
  };
  if (migrated.label) return migrated;
  // Reconstruct label from old structured fields
  const hasLine = migrated.line !== "" && migrated.line !== null && migrated.line !== undefined;
  const lineNum = hasLine ? Number(migrated.line) : null;
  let label = "";
  if (migrated.market === "spread") {
    const lineStr = lineNum === null ? "" : lineNum > 0 ? ` +${lineNum}` : ` ${lineNum}`;
    label = `${migrated.side || ""}${lineStr}`;
  } else if (migrated.market === "moneyline") {
    label = `${migrated.side || ""} ML`;
  } else if (migrated.market === "total") {
    const dir = migrated.side === "over" ? "Over" : "Under";
    label = `${dir}${lineNum !== null ? " " + lineNum : ""}`;
  } else if (migrated.market === "prop") {
    const dir = migrated.side === "over" ? "Over" : "Under";
    label = `${migrated.playerName || ""} ${dir} ${lineNum !== null ? lineNum : ""} ${migrated.statType || ""}`.replace(/\s+/g, " ").trim();
  } else {
    label = migrated.side || "Pick";
  }
  return { ...migrated, label };
}

function samePickIdentity(pick, gameId, market, side, playerName, statType) {
  if (pick.gameId !== gameId || pick.market !== market || pick.side !== side) return false;
  if (market === "prop") {
    return (
      pick.playerName?.toLowerCase() === playerName?.toLowerCase() &&
      pick.statType?.toLowerCase() === statType?.toLowerCase()
    );
  }
  return true;
}

function lineWithinTolerance(line1, line2, market) {
  if (!line1 || !line2) return true;
  const tol = market === "prop" ? 3 : 1.5;
  return Math.abs(Number(line1) - Number(line2)) <= tol;
}

function PickCard({ pick, sport, games = [], sources, sourcesMap, expandedPickId, setExpandedPickId, toggleStar, togglePlaced, deletePick, updatePickSources, movePickToGame }) {
  const expanded = expandedPickId === pick.id;
  const score = scorePick(pick, sourcesMap, sport);
  const decision = scoreToDecision(score.total, score.aCount);
  const pickSources = (pick.sources || []).map((ps) => sourcesMap[ps.sourceId]).filter(Boolean);
  const [srcSearch, setSrcSearch] = useState("");
  const [srcDropOpen, setSrcDropOpen] = useState(false);

  const assignedGame = games.find((g) => g.id === pick.gameId) || null;

  function openDrop() {
    setSrcDropOpen(true);
  }

  function sizeReason() {
    const srcPart = pickSources.length === 0 ? "no sources"
      : pickSources.length === 1 ? `${pickSources[0].name} (${TIER_NAMES[getSourceTier(pickSources[0], sport)]})`
      : `${pickSources.length} sources agree`;
    const starPart = pick.star ? ", personal star" : "";
    const reason = srcPart + starPart;
    if (decision.key === "pass") return `Pass — not enough signal (${reason})`;
    if (decision.key === "small") return `Small (0.5u) — light signal (${reason})`;
    if (decision.key === "standard") return `Standard (1u) — solid signal (${reason})`;
    if (decision.key === "mid") return `1.5u — strong, but 2u needs 2+ A-tier sources (${reason})`;
    return `High conviction (2u) — two or more A-tier sources agree (${reason})`;
  }

  return (
    <div className="px-3 py-2.5">
      {/* Row 1: tap target for expand */}
      <button onClick={() => setExpandedPickId(expanded ? null : pick.id)}
        className="w-full flex items-center justify-between gap-2 text-left">
        <div className="flex items-center gap-1.5 min-w-0">
          {pickSources.length > 1 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#50fa7b]/15 text-[#50fa7b] border border-[#50fa7b]/30 flex-shrink-0">
              {pickSources.length}×
            </span>
          )}
          <span className={`text-sm truncate ${pick.placed ? "line-through text-[#6272a4]" : "text-[#f8f8f2]"}`}>{pickDisplayLabel(pick, null)}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${decision.bgCls} ${decision.textCls}`}>
            {score.total} · {decision.label}
          </span>
          {expanded ? <ChevronUp size={16} className="text-[#6272a4]" /> : <ChevronDown size={16} className="text-[#6272a4]" />}
        </div>
      </button>

      {/* Row 2: controls — padded to ~44px tap targets */}
      <div className="flex items-center mt-0.5 -mb-1">
        <button onClick={() => toggleStar(pick.id)} aria-label={pick.star ? "Unstar pick" : "Star pick"}
          className={`flex-shrink-0 p-2 -ml-2 rounded-lg active:bg-[#282a36] ${pick.star ? "text-[#bd93f9]" : "text-[#6272a4]"}`}>
          <Star size={17} fill={pick.star ? "currentColor" : "none"} />
        </button>
        <button onClick={() => togglePlaced(pick.id)} aria-label={pick.placed ? "Mark as not placed" : "Mark as placed"}
          aria-pressed={!!pick.placed}
          className={`flex-shrink-0 p-2 rounded-lg active:bg-[#282a36] ${pick.placed ? "text-[#50fa7b]" : "text-[#6272a4]"}`}>
          <Check size={17} strokeWidth={pick.placed ? 3 : 2} />
        </button>
        <button onClick={() => deletePick(pick.id)} aria-label="Delete pick"
          className="ml-auto p-2 -mr-2 rounded-lg text-[#6272a4] active:bg-[#282a36] active:text-[#ff5555] flex-shrink-0">
          <Trash2 size={17} />
        </button>
      </div>

      {/* Inline score expansion */}
      {expanded && (
        <div className="mt-3 bg-[#282a36] rounded-lg p-3 space-y-3 border border-[#44475a]">
          {/* Recommendation */}
          <div className={`text-sm font-medium ${decision.textCls}`}>{sizeReason()}</div>

          {/* Score breakdown */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Score breakdown</div>
            {[
              ["Sources", score.sourceScore, 80],
              ["Personal star", score.starBonus, 20],
            ].map(([label, val, max]) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-xs text-[#6272a4] w-28 flex-shrink-0">{label}</span>
                <div className="flex-1 bg-[#21222c] rounded-full h-1.5 overflow-hidden">
                  <div className="h-full bg-[#bd93f9]/60 rounded-full" style={{ width: max > 0 ? `${Math.min(100, (val / max) * 100)}%` : "0%" }} />
                </div>
                <span className="text-xs text-[#6272a4] w-12 text-right flex-shrink-0">{val}</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-1 border-t border-[#44475a]">
              <span className="text-xs text-[#6272a4]">Total</span>
              <span className={`text-sm font-bold ${decision.textCls}`}>{score.total}/100</span>
            </div>
          </div>

          {/* Game assignment */}
          {movePickToGame && (
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Game assignment</div>
              {games.length > 0 ? (
                <select
                  value={pick.gameId || ""}
                  onChange={(e) => movePickToGame(pick.id, e.target.value || null)}
                  className="w-full bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 text-sm text-[#f8f8f2]"
                >
                  <option value="">No game assigned</option>
                  {games.map((game) => (
                    <option key={game.id} value={game.id}>{game.label}{game.gameTime ? ` · ${game.gameTime}` : ""}</option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-[#6272a4]">Add a game for this sport to assign the pick.</div>
              )}
            </div>
          )}

          {/* Sources — editable */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Sources</div>
            {pickSources.length === 0 && (
              <div className="text-xs text-[#6272a4]">No sources on this pick.</div>
            )}
            {pickSources.map((src) => {
              const tier = getSourceTier(src, sport);
              return (
                <div key={src.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-[#f8f8f2]">{src.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${TIER_BADGE_CLASS[tier]}`}>
                      {tier} · {TIER_NAMES[tier]}{src.sportTiers?.[sport] ? "" : " (default)"}
                    </span>
                  </div>
                  <button
                    onClick={() => updatePickSources(pick.id, (pick.sources || []).filter((ps) => ps.sourceId !== src.id))}
                    className="text-[#6272a4] active:text-[#ff5555] text-base leading-none px-2.5 py-2 -my-1.5 -mr-1.5"
                  >×</button>
                </div>
              );
            })}

            {/* Add source inline */}
            <div className="relative pt-1">
              <div
                onClick={openDrop}
                className="flex items-center gap-2 px-2.5 py-2 bg-[#343746] border border-dashed border-[#6272a4] rounded-lg cursor-text"
              >
                <Plus size={12} className="text-[#6272a4] flex-shrink-0" />
                <input
                  type="text"
                  value={srcSearch}
                  onChange={(e) => { setSrcSearch(e.target.value); openDrop(); }}
                  onFocus={openDrop}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                  placeholder="Add a source…"
                  className="flex-1 bg-transparent text-xs text-[#f8f8f2] placeholder-[#44475a] outline-none"
                />
              </div>
              {srcDropOpen && (
                <>
                  <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-[#343746] border border-[#6272a4] rounded-lg shadow-xl overflow-y-auto max-h-56">
                    {sources
                      .filter((s) => {
                        const alreadyOn = (pick.sources || []).some((ps) => ps.sourceId === s.id);
                        return !alreadyOn && s.name.toLowerCase().includes(srcSearch.toLowerCase());
                      })
                      .sort((a, b) => (TIER_WEIGHTS[getSourceTier(b, sport)] || 0) - (TIER_WEIGHTS[getSourceTier(a, sport)] || 0))
                      .map((s) => {
                        const tier = getSourceTier(s, sport);
                        return (
                          <button key={s.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              updatePickSources(pick.id, [
                                ...(pick.sources || []),
                                { sourceId: s.id, dateAdded: new Date().toISOString() },
                              ]);
                              setSrcSearch("");
                              setSrcDropOpen(false);
                            }}
                            className="w-full flex items-center justify-between px-3 py-2 text-xs text-left border-b border-[#44475a] last:border-0 text-[#f8f8f2] hover:bg-[#21222c]"
                          >
                            <span>{s.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${TIER_BADGE_CLASS[tier]}`}>{tier}</span>
                          </button>
                        );
                      })}
                    {sources.filter((s) => !(pick.sources || []).some((ps) => ps.sourceId === s.id) && s.name.toLowerCase().includes(srcSearch.toLowerCase())).length === 0 && (
                      <div className="px-3 py-2 text-xs text-[#6272a4]">
                        {srcSearch ? `No match for "${srcSearch}"` : "All sources already added"}
                      </div>
                    )}
                  </div>
                  <div className="fixed inset-0 z-10" onClick={() => { setSrcDropOpen(false); setSrcSearch(""); }} />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BetBoard() {
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("board");

  // settings (sources carried over from the existing setup)
  const [sources, setSources] = useState([]);
  const [unitValue, setUnitValue] = useState("");

  // board data
  const [games, setGames] = useState([]);
  const [picks, setPicks] = useState([]);

  // setup state
  const [newSourceName, setNewSourceName] = useState("");
  const [bulkPasteText, setBulkPasteText] = useState("");
  const [bulkDefaultTier, setBulkDefaultTier] = useState("B");
  const [expandedSourceId, setExpandedSourceId] = useState(null);
  const [exportJson, setExportJson] = useState("");
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState("");
  const [sourceExportOpen, setSourceExportOpen] = useState(false);

  // add flow state
  const [selectedSport, setSelectedSport] = useState(null);
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [newGameLabel, setNewGameLabel] = useState(null);
  const [newGameTime, setNewGameTime] = useState("");
  const [editingGameId, setEditingGameId] = useState(null);
  const [editingGameLabel, setEditingGameLabel] = useState("");
  const [editingGameTime, setEditingGameTime] = useState("");
  const [pickLabel, setPickLabel] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState(new Set());
  const [addMultiple, setAddMultiple] = useState(false);
  const [savedFlash, setSavedFlash] = useState(null);
  const [expandedPickId, setExpandedPickId] = useState(null);
  const [collapsedSports, setCollapsedSports] = useState(new Set());
  const [collapsedGames, setCollapsedGames] = useState(new Set());
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [toast, setToast] = useState(null); // { message, type: "success"|"remove" }
  const [userEmail, setUserEmail] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null); // { message, confirmLabel, onConfirm }

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null));
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      let loadedSources = [];
      let loadedUnit = "";
      let loadedBoard = { games: [], picks: [] };
      try {
        const s = await storage.get("settings");
        if (s && s.value) {
          const parsed = JSON.parse(s.value);
          loadedSources = (parsed.sources || []).map(migrateSource);
          loadedUnit = parsed.unitValue || "";
        }
      } catch (e) {}
      try {
        const b = await storage.get("board");
        if (b && b.value) {
          const parsed = JSON.parse(b.value);
          loadedBoard = {
            games: (parsed.games || []).map(migrateGame),
            picks: (parsed.picks || []).map(migratePick),
          };
        }
      } catch (e) {}
      if (mounted) {
        setSources(loadedSources);
        setUnitValue(loadedUnit);
        setGames(loadedBoard.games);
        setPicks(loadedBoard.picks);
        setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    updateExportJson(sources);
  }, [sources]);

  const persistSettings = useCallback(async (nextSources, nextUnit) => {
    try {
      await storage.set("settings", JSON.stringify({ sources: nextSources, unitValue: nextUnit }));
    } catch (e) {
      console.error("Failed to save settings", e);
    }
  }, []);

  const persistBoard = useCallback(async (nextGames, nextPicks) => {
    try {
      await storage.set("board", JSON.stringify({ games: nextGames, picks: nextPicks }));
    } catch (e) {
      console.error("Failed to save board", e);
    }
  }, []);

  // ----- sources -----
  function addSource() {
    const name = newSourceName.trim();
    if (!name) return;
    const next = [...sources, { id: uid(), name, defaultTier: "B", sportTiers: {} }];
    setSources(next); persistSettings(next, unitValue);
    setNewSourceName("");
  }

  function addSourcesBulk() {
    const names = bulkPasteText.split("\n").map((n) => n.trim()).filter(Boolean);
    if (!names.length) return;
    const newSources = names.map((name) => ({ id: uid(), name, defaultTier: bulkDefaultTier, sportTiers: {} }));
    const next = [...sources, ...newSources];
    setSources(next); persistSettings(next, unitValue);
    setBulkPasteText("");
  }

  function getSourceExportData(source) {
    return {
      name: source.name,
      rating: source.defaultTier || source.tier || "B",
      sportRatings: source.sportTiers || {},
    };
  }

  function updateExportJson(nextSources) {
    setExportJson(JSON.stringify(nextSources.map(getSourceExportData), null, 2));
  }

  function addImportedSources(items) {
    const existingNames = new Set(sources.map((s) => s.name.toLowerCase()));
    const newSources = items
      .map((item) => {
        if (!item || typeof item.name !== "string" || !item.name.trim()) return null;
        const name = item.name.trim();
        if (existingNames.has(name.toLowerCase())) return null;
        const defaultTier = item.rating || item.defaultTier || item.tier || "B";
        const sportTiers = item.sportRatings || item.sportTiers || {};
        existingNames.add(name.toLowerCase());
        return { id: uid(), name, defaultTier, sportTiers };
      })
      .filter(Boolean);
    if (!newSources.length) return [];
    const next = [...sources, ...newSources];
    setSources(next);
    persistSettings(next, unitValue);
    return newSources;
  }

  async function copyExportToClipboard() {
    try {
      await navigator.clipboard.writeText(exportJson);
      showToast("Source export copied", "success");
    } catch (e) {
      console.error(e);
      showToast("Copy failed; use the export text manually", "remove");
    }
  }

  function importSources() {
    setImportError("");
    let parsed;
    try {
      parsed = JSON.parse(importJson);
    } catch (e) {
      setImportError("Invalid JSON. Paste the export output exactly.");
      return;
    }
    if (!Array.isArray(parsed)) {
      setImportError("Import data must be an array of sources.");
      return;
    }
    const added = addImportedSources(parsed);
    if (added.length === 0) {
      setImportError("No new sources were imported. Remove duplicates or add missing names.");
      return;
    }
    setImportJson("");
    showToast(`Imported ${added.length} source${added.length === 1 ? "" : "s"}`);
  }

  function updateSourceDefaultTier(id, tier) {
    const next = sources.map((s) => s.id === id ? { ...s, defaultTier: tier } : s);
    setSources(next); persistSettings(next, unitValue);
  }

  function updateSourceSportTier(id, sport, tier) {
    const next = sources.map((s) => {
      if (s.id !== id) return s;
      const sportTiers = { ...(s.sportTiers || {}) };
      if (tier) sportTiers[sport] = tier;
      else delete sportTiers[sport];
      return { ...s, sportTiers };
    });
    setSources(next); persistSettings(next, unitValue);
  }

  function deleteSource(id) {
    const next = sources.filter((s) => s.id !== id);
    setSources(next); persistSettings(next, unitValue);
    if (expandedSourceId === id) setExpandedSourceId(null);
  }

  // ----- games (flat list for any sport) -----
  function addGame() {
    if (!newGameLabel) return;
    const label = newGameLabel.trim();
    if (!label) return;
    const game = { id: uid(), label, sport: selectedSport, gameTime: newGameTime.trim(), createdAt: new Date().toISOString() };
    const nextGames = [...games, game];
    setGames(nextGames);
    persistBoard(nextGames, picks);
    setSelectedGameId(game.id);
    setNewGameLabel(null);
    setNewGameTime("");
  }

  function deleteGame(id) {
    const game = games.find((g) => g.id === id);
    const n = picks.filter((p) => p.gameId === id).length;
    const msg = n > 0
      ? `Delete "${game?.label || "this game"}" and its ${n} pick${n === 1 ? "" : "s"}? This can't be undone.`
      : `Delete "${game?.label || "this game"}"?`;
    requestConfirm(msg, () => {
      const nextGames = games.filter((g) => g.id !== id);
      const nextPicks = picks.filter((p) => p.gameId !== id);
      setGames(nextGames);
      setPicks(nextPicks);
      persistBoard(nextGames, nextPicks);
      if (selectedGameId === id) setSelectedGameId(null);
      if (editingGameId === id) setEditingGameId(null);
      showToast(`${game?.label || "Game"} deleted`, "remove");
    });
  }

  function updateGame(id, label, gameTime) {
    const nextGames = games.map((g) => g.id === id ? { ...g, label, gameTime } : g);
    setGames(nextGames);
    persistBoard(nextGames, picks);
    setEditingGameId(null);
    setEditingGameLabel("");
    setEditingGameTime("");
    showToast("Game updated");
  }

  // Delete an entire sport section: all its picks (and all games, for NFL).
  function deleteSport(sport) {
    const pickCount = picks.filter((p) => p.sport === sport).length;
    const gameCount = games.filter((g) => g.sport === sport).length;
    if (pickCount === 0 && gameCount === 0) return;
    const parts = [];
    if (pickCount) parts.push(`${pickCount} pick${pickCount === 1 ? "" : "s"}`);
    if (gameCount) parts.push(`${gameCount} game${gameCount === 1 ? "" : "s"}`);
    requestConfirm(`Delete all of ${sport}? This removes ${parts.join(" and ")}. This can't be undone.`, () => {
      const nextPicks = picks.filter((p) => p.sport !== sport);
      const nextGames = games.filter((g) => g.sport !== sport);
      setPicks(nextPicks);
      setGames(nextGames);
      if (selectedGameId && games.find((g) => g.id === selectedGameId && g.sport === sport)) {
        setSelectedGameId(null);
      }
      persistBoard(nextGames, nextPicks);
      showToast(`${sport} cleared`, "remove");
    }, `Delete ${sport}`);
  }

  // ----- picks -----
  function resetPickForm() {
    setPickLabel("");
    setSelectedSourceIds(new Set());
    // sport stays if addMultiple, game stays if addMultiple
    if (!addMultiple) {
      setSelectedGameId(null);
      setSelectedSport(null);
    }
  }

  function canSubmitPick() {
    if (!pickLabel.trim() || !selectedSport || selectedSourceIds.size === 0) return false;
    return true;
  }

  function showToast(message, type = "success") {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2500);
  }

  function requestConfirm(message, onConfirm, confirmLabel = "Delete") {
    setConfirmDialog({ message, onConfirm, confirmLabel });
  }

  // Dismiss the confirm dialog on Escape (desktop / hardware keyboards).
  useEffect(() => {
    if (!confirmDialog) return;
    const onKey = (e) => { if (e.key === "Escape") setConfirmDialog(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDialog]);

  async function signOut() {
    await supabase.auth.signOut();
    window.location.reload();
  }

  function addPick() {
    if (!canSubmitPick()) return;
    const entries = [...selectedSourceIds].map((sid) => ({ sourceId: sid, dateAdded: new Date().toISOString() }));
    const pick = {
      id: uid(),
      gameId: selectedGameId || null,
      label: pickLabel.trim(),
      sport: selectedSport,
      sources: entries,
      star: false,
      placed: false,
      lineMoveStatus: null,
      createdAt: new Date().toISOString(),
    };
    const nextPicks = [...picks, pick];
    setPicks(nextPicks);
    persistBoard(games, nextPicks);
    resetPickForm();
    showToast("Pick added");
  }

  function deletePick(id) {
    const nextPicks = picks.filter((p) => p.id !== id);
    setPicks(nextPicks);
    persistBoard(games, nextPicks);
    showToast("Pick removed", "remove");
  }

  function movePickToGame(id, gameId) {
    const next = picks.map((p) => p.id === id ? { ...p, gameId: gameId || null } : p);
    setPicks(next);
    persistBoard(games, next);
  }

  function updatePickSources(id, nextSources) {
    const next = picks.map((p) => p.id === id ? { ...p, sources: nextSources } : p);
    setPicks(next);
    persistBoard(games, next);
  }

  function toggleStar(id) {
    const next = picks.map((p) => p.id === id ? { ...p, star: !p.star } : p);
    setPicks(next);
    persistBoard(games, next);
  }

  function togglePlaced(id) {
    const next = picks.map((p) => p.id === id ? { ...p, placed: !p.placed } : p);
    setPicks(next);
    persistBoard(games, next);
  }

  function toggleSportCollapsed(sport) {
    setCollapsedSports((prev) => {
      const n = new Set(prev);
      n.has(sport) ? n.delete(sport) : n.add(sport);
      return n;
    });
  }

  function toggleGameCollapsed(id) {
    setCollapsedGames((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function updateLineMoveStatus(id, val) {
    const next = picks.map((p) => p.id === id
      ? { ...p, lineMoveStatus: p.lineMoveStatus === val ? null : val }
      : p);
    setPicks(next);
    persistBoard(games, next);
  }

  const sourcesMap = Object.fromEntries(sources.map((s) => [s.id, s]));

  function sourceLabel(sourceId) {
    const s = sources.find((s) => s.id === sourceId);
    return s ? s.name : "Unknown source";
  }
  function sourceTier(sourceId) {
    const s = sources.find((s) => s.id === sourceId);
    return s ? s.tier : null;
  }

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-[#282a36] flex items-center justify-center">
        <div className="text-[#6272a4] text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[#282a36] text-[#f8f8f2] pb-[calc(6rem+env(safe-area-inset-bottom))]">
      <div className="px-4 pt-[max(0.875rem,env(safe-area-inset-top))] pb-3 border-b border-[#44475a] max-w-md mx-auto flex items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold tracking-tight text-[#f8f8f2]">Bet Board</h1>
        <p className="text-xs text-[#6272a4] flex-shrink-0">Every pick, one place.</p>
      </div>

      <div className="max-w-md mx-auto px-4 pt-4">
        {activeTab === "board" && (
          <div className="space-y-4">
            {picks.length === 0 && games.length === 0 ? (
              <div className="text-sm text-[#6272a4] bg-[#343746] border border-[#44475a] rounded-lg px-3 py-8 text-center">
                No picks yet.{" "}
                <button onClick={() => setActiveTab("add")} className="text-[#bd93f9] underline">Add your first pick</button>
              </div>
            ) : (
              <>
                {/* ── NFL section ── */}
                {((games.filter((g) => g.sport === "NFL").length > 0) || picks.some((p) => p.sport === "NFL")) && (() => {
                  const nflCollapsed = collapsedSports.has("NFL");
                  const nflCount = picks.filter((p) => p.sport === "NFL").length;
                  return (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <button onClick={() => toggleSportCollapsed("NFL")} aria-expanded={!nflCollapsed}
                        className="flex items-center gap-1.5 -ml-1 p-1 rounded-lg active:bg-[#343746]">
                        {nflCollapsed ? <ChevronRight size={15} className="text-[#6272a4]" /> : <ChevronDown size={15} className="text-[#6272a4]" />}
                        <span className="text-xs uppercase tracking-wide text-[#6272a4] font-semibold">NFL</span>
                        {nflCollapsed && <span className="text-[10px] text-[#6272a4]">({nflCount})</span>}
                      </button>
                      <button onClick={() => deleteSport("NFL")} aria-label="Delete all NFL"
                        className="text-[#6272a4] active:text-[#ff5555] active:bg-[#343746] p-1.5 -m-1 rounded-lg">
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {!nflCollapsed && (
                    <div className="space-y-2">
                      {games.filter((g) => g.sport === "NFL")
                        .sort((a, b) => (a.gameTime || "zzz").localeCompare(b.gameTime || "zzz"))
                        .map((game) => {
                          const gamePicks = picks
                            .filter((p) => p.gameId === game.id)
                            .sort((a, b) => scorePick(b, sourcesMap, "NFL").total - scorePick(a, sourcesMap, "NFL").total);
                          const gameCollapsed = collapsedGames.has(game.id);
                          return (
                            <div key={game.id} className="bg-[#343746] border border-[#44475a] rounded-lg">
                              <div className={`flex items-center justify-between px-3 py-2.5 ${gameCollapsed ? "" : "border-b border-[#44475a]"}`}>
                                <button onClick={() => toggleGameCollapsed(game.id)} aria-expanded={!gameCollapsed}
                                  className="flex items-center gap-1.5 min-w-0 text-left -ml-1 p-1 rounded-lg active:bg-[#282a36]">
                                  {gameCollapsed ? <ChevronRight size={15} className="text-[#6272a4] flex-shrink-0" /> : <ChevronDown size={15} className="text-[#6272a4] flex-shrink-0" />}
                                  <span className="text-sm font-semibold text-[#f8f8f2] truncate">{game.label}</span>
                                  {game.gameTime && <span className="text-xs text-[#6272a4] flex-shrink-0">{game.gameTime}</span>}
                                  {gameCollapsed && gamePicks.length > 0 && <span className="text-[10px] text-[#6272a4] flex-shrink-0">({gamePicks.length})</span>}
                                </button>
                                <div className="flex items-center gap-2">
                                  <button onClick={() => {
                                      setEditingGameId(game.id);
                                      setEditingGameLabel(game.label);
                                      setEditingGameTime(game.gameTime || "");
                                    }}
                                    className="text-[#6272a4] px-2 py-1 rounded-lg border border-[#44475a] active:bg-[#282a36] text-xs">
                                    Edit
                                  </button>
                                  <button onClick={() => deleteGame(game.id)} aria-label="Delete game"
                                    className="text-[#6272a4] active:text-[#ff5555] p-2 -m-1 rounded-lg active:bg-[#282a36] flex-shrink-0">
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </div>
                              {editingGameId === game.id && (
                                <div className="px-3 py-3 border-t border-[#44475a] bg-[#2d2f3b] rounded-b-lg space-y-2">
                                  <input value={editingGameLabel} onChange={(e) => setEditingGameLabel(e.target.value)}
                                    className="w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-sm text-[#f8f8f2]"
                                    placeholder="Game label" />
                                  <input value={editingGameTime} onChange={(e) => setEditingGameTime(e.target.value)}
                                    className="w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-sm text-[#f8f8f2]"
                                    placeholder="Game time (optional)" />
                                  <div className="flex gap-2">
                                    <button onClick={() => updateGame(game.id, editingGameLabel.trim() || game.label, editingGameTime.trim())}
                                      className="flex-1 bg-[#bd93f9] text-[#282a36] rounded-lg py-2 text-sm font-semibold">
                                      Save
                                    </button>
                                    <button onClick={() => setEditingGameId(null)}
                                      className="flex-1 bg-[#21222c] border border-[#44475a] rounded-lg py-2 text-sm text-[#6272a4]">
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              )}
                              {!gameCollapsed && (gamePicks.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-[#6272a4]">No picks for this game yet.</div>
                              ) : (
                                <div className="divide-y divide-[#44475a]">
                                  {gamePicks.map((pick) => (
                                    <PickCard key={pick.id} pick={pick} sport="NFL" games={games.filter((g) => g.sport === "NFL")}
                                      sources={sources} sourcesMap={sourcesMap}
                                      expandedPickId={expandedPickId} setExpandedPickId={setExpandedPickId}
                                      toggleStar={toggleStar} togglePlaced={togglePlaced} deletePick={deletePick} updatePickSources={updatePickSources} movePickToGame={movePickToGame} />
                                  ))}
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      {/* Orphan NFL picks (no game assigned) */}
                      {picks.filter((p) => p.sport === "NFL" && !p.gameId).length > 0 && (
                        <div className="bg-[#343746] border border-[#44475a] rounded-lg">
                          <div className="px-3 py-2 border-b border-[#44475a] text-xs text-[#6272a4]">No game assigned</div>
                          <div className="divide-y divide-[#44475a]">
                            {picks.filter((p) => p.sport === "NFL" && !p.gameId)
                              .sort((a, b) => scorePick(b, sourcesMap, "NFL").total - scorePick(a, sourcesMap, "NFL").total)
                              .map((pick) => (
                                <PickCard key={pick.id} pick={pick} sport="NFL" games={games.filter((g) => g.sport === "NFL")}
                                  sources={sources} sourcesMap={sourcesMap}
                                  expandedPickId={expandedPickId} setExpandedPickId={setExpandedPickId}
                                  toggleStar={toggleStar} togglePlaced={togglePlaced} deletePick={deletePick} updatePickSources={updatePickSources} movePickToGame={movePickToGame} />
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                    )}
                  </div>
                  );
                })()}

                {/* ── Non-NFL sections grouped by sport ── */}
                {LEAGUES.filter((l) => l !== "NFL").map((sport) => {
                  const sportGames = games.filter((g) => g.sport === sport);
                  const sportPicks = picks
                    .filter((p) => p.sport === sport && !p.gameId)
                    .sort((a, b) => scorePick(b, sourcesMap, sport).total - scorePick(a, sourcesMap, sport).total);
                  const hasSportContent = sportGames.length > 0 || sportPicks.length > 0;
                  if (!hasSportContent) return null;
                  const sportCollapsed = collapsedSports.has(sport);
                  return (
                    <div key={sport}>
                      <div className="flex items-center justify-between mb-2">
                        <button onClick={() => toggleSportCollapsed(sport)} aria-expanded={!sportCollapsed}
                          className="flex items-center gap-1.5 -ml-1 p-1 rounded-lg active:bg-[#343746]">
                          {sportCollapsed ? <ChevronRight size={15} className="text-[#6272a4]" /> : <ChevronDown size={15} className="text-[#6272a4]" />}
                          <span className="text-xs uppercase tracking-wide text-[#6272a4] font-semibold">{sport}</span>
                          {sportCollapsed && <span className="text-[10px] text-[#6272a4]">({sportGames.length + sportPicks.length})</span>}
                        </button>
                        <button onClick={() => deleteSport(sport)} aria-label={`Delete all ${sport}`}
                          className="text-[#6272a4] active:text-[#ff5555] active:bg-[#343746] p-1.5 -m-1 rounded-lg">
                          <Trash2 size={15} />
                        </button>
                      </div>
                      {!sportCollapsed && (
                      <div className="space-y-3">
                        {sportGames.map((game) => {
                          const gamePicks = picks
                            .filter((p) => p.gameId === game.id)
                            .sort((a, b) => scorePick(b, sourcesMap, sport).total - scorePick(a, sourcesMap, sport).total);
                          const gameCollapsed = collapsedGames.has(game.id);
                          return (
                            <div key={game.id} className="bg-[#343746] border border-[#44475a] rounded-lg">
                              <div className={`flex items-center justify-between px-3 py-2.5 ${gameCollapsed ? "" : "border-b border-[#44475a]"}`}>
                                <button onClick={() => toggleGameCollapsed(game.id)} aria-expanded={!gameCollapsed}
                                  className="flex items-center gap-1.5 min-w-0 text-left -ml-1 p-1 rounded-lg active:bg-[#282a36]">
                                  {gameCollapsed ? <ChevronRight size={15} className="text-[#6272a4] flex-shrink-0" /> : <ChevronDown size={15} className="text-[#6272a4] flex-shrink-0" />}
                                  <span className="text-sm font-semibold text-[#f8f8f2] truncate">{game.label}</span>
                                  {game.gameTime && <span className="text-xs text-[#6272a4] flex-shrink-0">{game.gameTime}</span>}
                                  {gameCollapsed && gamePicks.length > 0 && <span className="text-[10px] text-[#6272a4] flex-shrink-0">({gamePicks.length})</span>}
                                </button>
                                <div className="flex items-center gap-2">
                                  <button onClick={() => {
                                      setEditingGameId(game.id);
                                      setEditingGameLabel(game.label);
                                      setEditingGameTime(game.gameTime || "");
                                    }}
                                    className="text-[#6272a4] px-2 py-1 rounded-lg border border-[#44475a] active:bg-[#282a36] text-xs">
                                    Edit
                                  </button>
                                  <button onClick={() => deleteGame(game.id)} aria-label="Delete game"
                                    className="text-[#6272a4] active:text-[#ff5555] p-2 -m-1 rounded-lg active:bg-[#282a36] flex-shrink-0">
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </div>
                              {editingGameId === game.id && (
                                <div className="px-3 py-3 border-t border-[#44475a] bg-[#2d2f3b] rounded-b-lg space-y-2">
                                  <input value={editingGameLabel} onChange={(e) => setEditingGameLabel(e.target.value)}
                                    className="w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-sm text-[#f8f8f2]"
                                    placeholder="Game label" />
                                  <input value={editingGameTime} onChange={(e) => setEditingGameTime(e.target.value)}
                                    className="w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-sm text-[#f8f8f2]"
                                    placeholder="Game time (optional)" />
                                  <div className="flex gap-2">
                                    <button onClick={() => updateGame(game.id, editingGameLabel.trim() || game.label, editingGameTime.trim())}
                                      className="flex-1 bg-[#bd93f9] text-[#282a36] rounded-lg py-2 text-sm font-semibold">
                                      Save
                                    </button>
                                    <button onClick={() => setEditingGameId(null)}
                                      className="flex-1 bg-[#21222c] border border-[#44475a] rounded-lg py-2 text-sm text-[#6272a4]">
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              )}
                              {!gameCollapsed && (gamePicks.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-[#6272a4]">No picks for this game yet.</div>
                              ) : (
                                <div className="divide-y divide-[#44475a]">
                                  {gamePicks.map((pick) => (
                                    <PickCard key={pick.id} pick={pick} sport={sport}
                                      games={sportGames}
                                      sources={sources} sourcesMap={sourcesMap}
                                      expandedPickId={expandedPickId} setExpandedPickId={setExpandedPickId}
                                      toggleStar={toggleStar} togglePlaced={togglePlaced} deletePick={deletePick} updatePickSources={updatePickSources}
                                      movePickToGame={movePickToGame} />
                                  ))}
                                </div>
                              ))}
                            </div>
                          );
                        })}
                        {sportPicks.length > 0 && (
                          <div className="bg-[#343746] border border-[#44475a] rounded-lg">
                            <div className="px-3 py-2 border-b border-[#44475a] text-xs text-[#6272a4]">No game assigned</div>
                            <div className="divide-y divide-[#44475a]">
                              {sportPicks.map((pick) => (
                                <PickCard key={pick.id} pick={pick} sport={sport}
                                  games={sportGames}
                                  sources={sources} sourcesMap={sourcesMap}
                                  expandedPickId={expandedPickId} setExpandedPickId={setExpandedPickId}
                                  toggleStar={toggleStar} togglePlaced={togglePlaced} deletePick={deletePick} updatePickSources={updatePickSources}
                                  movePickToGame={movePickToGame} />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {activeTab === "add" && (
          <div className="space-y-4">

            {/* Sport */}
            <div>
              <label className="text-xs uppercase tracking-wide text-[#6272a4]">Sport</label>
              <div className="mt-1 flex flex-wrap gap-2">
                {LEAGUES.map((l) => (
                  <button key={l} onClick={() => { setSelectedSport(l); setSelectedGameId(null); }}
                    className={`px-3.5 py-2 rounded-lg text-sm border active:scale-95 transition-transform ${
                      selectedSport === l
                        ? "bg-[#bd93f9]/15 border-[#bd93f9]/60 text-[#bd93f9]"
                        : "bg-[#343746] border-[#44475a] text-[#6272a4]"
                    }`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Game picker */}
            {selectedSport && (
              <div>
                <label className="text-xs uppercase tracking-wide text-[#6272a4]">Game</label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {[...games].filter((g) => g.sport === selectedSport)
                    .sort((a, b) => (a.gameTime || "").localeCompare(b.gameTime || ""))
                    .map((g) => (
                      <button key={g.id}
                        onClick={() => setSelectedGameId(selectedGameId === g.id ? null : g.id)}
                        className={`px-3.5 py-2 rounded-lg text-sm border active:scale-95 transition-transform ${
                          selectedGameId === g.id
                            ? "bg-[#bd93f9]/15 border-[#bd93f9]/60 text-[#bd93f9]"
                            : "bg-[#343746] border-[#44475a] text-[#6272a4]"
                        }`}>
                        {g.label}{g.gameTime ? ` · ${g.gameTime}` : ""}
                      </button>
                    ))}
                  <button
                    onClick={() => setNewGameLabel(newGameLabel === null ? "" : null)}
                    className="px-3.5 py-2 rounded-lg text-sm border border-dashed border-[#6272a4] text-[#6272a4] active:scale-95 transition-transform">
                    + Game
                  </button>
                </div>

                {newGameLabel !== null && (
                  <div className="mt-2 bg-[#343746] border border-[#44475a] rounded-lg p-3 space-y-2">
                    <input type="text" value={newGameLabel} onChange={(e) => setNewGameLabel(e.target.value)}
                      autoCorrect="off" spellCheck={false} autoComplete="off"
                      placeholder="e.g. Broncos @ Lions"
                      className="w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#44475a]"
                      autoFocus />
                    <input type="text" value={newGameTime} onChange={(e) => setNewGameTime(e.target.value)}
                      placeholder="Kickoff time, e.g. 1:00 PM ET (optional)"
                      className="w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#44475a]" />
                    <div className="flex gap-2">
                      <button onClick={() => { addGame(); setNewGameLabel(null); }}
                        disabled={!newGameLabel?.trim()}
                        className="flex-1 bg-[#bd93f9] text-[#282a36] rounded-lg py-2 text-sm font-semibold disabled:bg-[#21222c] disabled:text-[#44475a]">
                        Add game
                      </button>
                      <button onClick={() => { setNewGameLabel(null); setNewGameTime(""); }}
                        className="px-4 py-2 rounded-lg text-sm bg-[#21222c] text-[#6272a4]">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Add Multiple toggle — NFL only */}
                <label className="mt-3 flex items-center gap-2.5 cursor-pointer">
                  <div onClick={() => setAddMultiple(!addMultiple)}
                    className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 ${addMultiple ? "bg-[#bd93f9]" : "bg-[#44475a]"}`}>
                    <div className={`w-4 h-4 bg-white rounded-full mt-0.5 transition-transform ${addMultiple ? "translate-x-4 ml-0.5" : "translate-x-0.5"}`} />
                  </div>
                  <span className="text-sm text-[#6272a4]">Add multiple picks for same game</span>
                </label>
              </div>
            )}

            {/* Pick text */}
            {selectedSport && (
              <div>
                <label className="text-xs uppercase tracking-wide text-[#6272a4]">Pick</label>
                <input type="text" value={pickLabel} onChange={(e) => setPickLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canSubmitPick() && addPick()}
                  autoCorrect="off" spellCheck={false} autoComplete="off" enterKeyHint="done"
                  placeholder="e.g. Broncos -3.5, Over 47.5, Nix 300+ yds"
                  className="mt-1 w-full bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2.5 text-sm placeholder-[#44475a]" />
              </div>
            )}

            {/* Sources — searchable multi-select dropdown */}
            {selectedSport && (
              <div>
                <label className="text-xs uppercase tracking-wide text-[#6272a4]">Sources</label>
                {sources.length === 0 ? (
                  <div className="mt-1 text-sm text-[#6272a4] bg-[#343746] border border-[#44475a] rounded-lg px-3 py-3">
                    No sources yet.{" "}
                    <button onClick={() => setActiveTab("setup")} className="text-[#bd93f9] underline">Add in Setup</button>
                  </div>
                ) : (
                  <div className="mt-1 relative">
                    {/* Selected pills + search input */}
                    <div
                      onClick={() => setSourceDropdownOpen(true)}
                      className="min-h-[42px] w-full bg-[#343746] border border-[#44475a] rounded-lg px-2.5 py-1.5 flex flex-wrap gap-1.5 items-center cursor-text"
                    >
                      {[...selectedSourceIds].map((id) => {
                        const src = sources.find((s) => s.id === id);
                        if (!src) return null;
                        const tier = getSourceTier(src, selectedSport);
                        return (
                          <span key={id} className="flex items-center gap-1 bg-[#50fa7b]/10 border border-[#50fa7b]/40 text-[#50fa7b] text-xs px-2 py-0.5 rounded-full">
                            {src.name}
                            <span className={`text-[10px] px-1 py-px rounded ${TIER_BADGE_CLASS[tier]}`}>{tier}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); setSelectedSourceIds((prev) => { const n = new Set(prev); n.delete(id); return n; }); }}
                              className="text-[#50fa7b] hover:text-[#69ff94] leading-none text-sm px-1.5 py-1 -my-1 -mr-1.5"
                              aria-label={`Remove ${src.name}`}
                            >×</button>
                          </span>
                        );
                      })}
                      <input
                        type="text"
                        value={sourceSearch}
                        onChange={(e) => { setSourceSearch(e.target.value); setSourceDropdownOpen(true); }}
                        onFocus={() => setSourceDropdownOpen(true)}
                        autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                        placeholder={selectedSourceIds.size === 0 ? "Search sources…" : ""}
                        className="flex-1 min-w-[100px] bg-transparent text-sm text-[#f8f8f2] placeholder-[#44475a] outline-none py-0.5"
                      />
                    </div>

                    {/* Dropdown list */}
                    {sourceDropdownOpen && (
                      <div className="absolute z-20 mt-1 w-full bg-[#343746] border border-[#6272a4] rounded-lg shadow-xl overflow-hidden max-h-52 overflow-y-auto">
                        {sources
                          .filter((s) => s.name.toLowerCase().includes(sourceSearch.toLowerCase()))
                          .sort((a, b) => {
                            const ta = TIER_WEIGHTS[getSourceTier(a, selectedSport)] || 0;
                            const tb = TIER_WEIGHTS[getSourceTier(b, selectedSport)] || 0;
                            return tb - ta;
                          })
                          .map((s) => {
                            const active = selectedSourceIds.has(s.id);
                            const tier = getSourceTier(s, selectedSport);
                            return (
                              <button
                                key={s.id}
                                onMouseDown={(e) => {
                                  e.preventDefault(); // prevent input blur closing dropdown first
                                  setSelectedSourceIds((prev) => {
                                    const next = new Set(prev);
                                    active ? next.delete(s.id) : next.add(s.id);
                                    return next;
                                  });
                                  setSourceSearch("");
                                  setSourceDropdownOpen(false);
                                }}
                                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm text-left border-b border-[#44475a] last:border-0 transition-colors ${
                                  active ? "bg-[#50fa7b]/10 text-[#50fa7b]" : "text-[#f8f8f2] hover:bg-[#21222c]"
                                }`}
                              >
                                <span>{s.name}</span>
                                <div className="flex items-center gap-2">
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${TIER_BADGE_CLASS[tier]}`}>{tier}</span>
                                  {active && <span className="text-[#50fa7b] text-xs">✓</span>}
                                </div>
                              </button>
                            );
                          })}
                        {sources.filter((s) => s.name.toLowerCase().includes(sourceSearch.toLowerCase())).length === 0 && (
                          <div className="px-3 py-3 text-sm text-[#6272a4]">No sources match "{sourceSearch}"</div>
                        )}
                      </div>
                    )}

                    {/* Click-outside close */}
                    {sourceDropdownOpen && (
                      <div className="fixed inset-0 z-10" onClick={() => { setSourceDropdownOpen(false); setSourceSearch(""); }} />
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Submit */}
            {selectedSport && (
              <>
                <button onClick={addPick} disabled={!canSubmitPick()}
                  className={`w-full py-3.5 rounded-lg font-semibold transition-transform ${
                    canSubmitPick() ? "bg-[#bd93f9] text-[#282a36] active:scale-[0.98]" : "bg-[#21222c] text-[#44475a] cursor-not-allowed"
                  }`}>
                  Add pick
                </button>
              </>
            )}
          </div>
        )}

        {activeTab === "setup" && (
          <div className="space-y-5">
            {isSupabaseConfigured && (
              <div className="bg-[#343746] border border-[#44475a] rounded-lg p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Signed in as</div>
                  <div className="text-sm text-[#8be9fd] truncate">{userEmail || "…"}</div>
                  <div className="text-[10px] text-[#6272a4] mt-0.5">Your board syncs automatically on any device you sign in to.</div>
                </div>
                <button onClick={signOut}
                  className="flex-shrink-0 rounded-lg px-3 py-2 text-sm font-medium bg-[#44475a] text-[#f8f8f2]">
                  Sign out
                </button>
              </div>
            )}

            <div>
              <label className="text-xs uppercase tracking-wide text-[#6272a4]">Unit value (optional)</label>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[#6272a4]">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={unitValue}
                  onChange={(e) => setUnitValue(e.target.value)}
                  onBlur={() => persistSettings(sources, unitValue)}
                  placeholder="e.g. 25"
                  className="flex-1 bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#44475a]"
                />
                <span className="text-sm text-[#6272a4]">per unit</span>
              </div>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wide text-[#6272a4]">Add sources</label>
              <div className="mt-1 flex gap-2">
                <input type="text" value={newSourceName} onChange={(e) => setNewSourceName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addSource()}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                  placeholder="One name or handle"
                  className="flex-1 bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#44475a]" />
                <button onClick={addSource} className="bg-[#bd93f9] text-[#282a36] rounded-lg px-3 py-2">
                  <Plus size={18} />
                </button>
              </div>
              <div className="mt-2 space-y-2">
                <textarea value={bulkPasteText} onChange={(e) => setBulkPasteText(e.target.value)}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  placeholder={"Or paste many at once, one per line:\n@CapperA\n@CapperB\nBestBets.com"}
                  rows={4}
                  className="w-full bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#44475a]" />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#6272a4] flex-shrink-0">Default tier:</span>
                  {["A","B","C"].map((t) => (
                    <button key={t} onClick={() => setBulkDefaultTier(t)}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold border ${bulkDefaultTier === t ? TIER_BADGE_CLASS[t] : "bg-[#343746] border-[#44475a] text-[#6272a4]"}`}>
                      {t}
                    </button>
                  ))}
                  <button onClick={addSourcesBulk} disabled={!bulkPasteText.trim()}
                    className="ml-auto px-3 py-1.5 rounded-lg text-sm font-medium bg-[#bd93f9] text-[#282a36] disabled:bg-[#21222c] disabled:text-[#44475a]">
                    Add all
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              {sources.length === 0 ? (
                <div className="text-sm text-[#6272a4] bg-[#343746] border border-[#44475a] rounded-lg px-3 py-4 text-center">
                  No sources added yet.
                </div>
              ) : (
                sources.map((s) => {
                  const expanded = expandedSourceId === s.id;
                  const defaultTier = s.defaultTier || s.tier || "B";
                  return (
                    <div key={s.id} className="bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <button onClick={() => setExpandedSourceId(expanded ? null : s.id)}
                          className="flex-1 text-left text-sm text-[#f8f8f2] truncate flex items-center gap-1.5">
                          <span className="truncate">{s.name}</span>
                          {expanded ? <ChevronUp size={15} className="text-[#6272a4] flex-shrink-0" /> : <ChevronDown size={15} className="text-[#6272a4] flex-shrink-0" />}
                        </button>
                        <button onClick={() => deleteSource(s.id)} aria-label="Delete source"
                          className="text-[#6272a4] active:text-[#ff5555] active:bg-[#282a36] p-2 -mr-1 rounded-lg flex-shrink-0">
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-[10px] uppercase tracking-wide text-[#6272a4] flex-shrink-0">Default tier</span>
                        <div className="flex gap-1.5 ml-auto">
                          {["A","B","C"].map((t) => (
                            <button key={t} onClick={() => updateSourceDefaultTier(s.id, t)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-bold border active:scale-95 transition-transform ${defaultTier === t ? TIER_BADGE_CLASS[t] : "bg-[#282a36] border-[#44475a] text-[#6272a4]"}`}>
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                      {expanded && (
                        <div className="border-t border-[#44475a] -mx-3 px-3 mt-2.5 pt-2.5 space-y-2">
                          <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Per-sport overrides</div>
                          <div className="grid grid-cols-1 gap-1.5">
                            {LEAGUES.map((league) => {
                              const sportTier = s.sportTiers?.[league] || null;
                              return (
                                <div key={league} className="flex items-center gap-2">
                                  <span className="text-xs text-[#6272a4] w-20 flex-shrink-0">{league}</span>
                                  <div className="flex gap-1.5">
                                    {["A","B","C"].map((t) => (
                                      <button key={t} onClick={() => updateSourceSportTier(s.id, league, sportTier === t ? null : t)}
                                        className={`px-2.5 py-1 rounded-lg text-xs font-bold border active:scale-95 transition-transform ${sportTier === t ? TIER_BADGE_CLASS[t] : "bg-[#282a36] border-[#44475a] text-[#6272a4]"}`}>
                                        {t}
                                      </button>
                                    ))}
                                    {sportTier && (
                                      <span className="text-[10px] text-[#6272a4] ml-1 self-center">override</span>
                                    )}
                                    {!sportTier && (
                                      <span className="text-[10px] text-[#6272a4] ml-1 self-center">→ {defaultTier}</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="bg-[#343746] border border-[#44475a] rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setSourceExportOpen((open) => !open)}
                className="w-full flex items-center justify-between px-3 py-3 text-sm font-semibold text-[#f8f8f2] hover:bg-[#2a2d44]"
              >
                <span>Source import/export</span>
                <span className="text-[#6272a4]">{sourceExportOpen ? "Hide" : "Show"}</span>
              </button>
              {sourceExportOpen && (
                <div className="border-t border-[#44475a] p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Export</div>
                      <p className="text-xs text-[#6272a4]">Copy a compact JSON export of your sources.</p>
                    </div>
                    <button onClick={copyExportToClipboard}
                      className="rounded-lg px-3 py-2 text-xs font-semibold bg-[#bd93f9] text-[#282a36]">
                      Copy export
                    </button>
                  </div>
                  <textarea readOnly value={exportJson} rows={4}
                    className="w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-xs text-[#f8f8f2]" />
                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Import</div>
                    <textarea value={importJson} onChange={(e) => setImportJson(e.target.value)}
                      autoCapitalize="off" autoCorrect="off" spellCheck={false}
                      placeholder="Paste export JSON here"
                      rows={4}
                      className="w-full bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 text-xs placeholder-[#6272a4] text-[#f8f8f2]" />
                    {importError && <p className="text-xs text-[#ff5555]">{importError}</p>}
                    <button onClick={importSources} disabled={!importJson.trim()}
                      className="w-full rounded-lg px-3 py-2 text-sm font-medium bg-[#bd93f9] text-[#282a36] disabled:bg-[#21222c] disabled:text-[#44475a]">
                      Import sources
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Confirm dialog */}
      {confirmDialog && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/60"
          onClick={() => setConfirmDialog(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-xs bg-[#343746] border border-[#44475a] rounded-2xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-[#f8f8f2] leading-relaxed">{confirmDialog.message}</p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirmDialog(null)}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-[#282a36] text-[#f8f8f2] border border-[#44475a] active:scale-[0.98] transition-transform"
              >
                Cancel
              </button>
              <button
                onClick={() => { confirmDialog.onConfirm?.(); setConfirmDialog(null); }}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-[#ff5555] text-[#282a36] active:scale-[0.98] transition-transform"
              >
                {confirmDialog.confirmLabel || "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium transition-all ${
          toast.type === "remove"
            ? "bg-[#ff5555]/15 border border-[#ff5555]/40 text-[#ff5555]"
            : "bg-[#50fa7b]/15 border border-[#50fa7b]/40 text-[#50fa7b]"
        }`}>
          {toast.type === "remove"
            ? <XCircle size={15} />
            : <CheckCircle2 size={15} />}
          {toast.message}
        </div>
      )}

      <div className="fixed bottom-0 inset-x-0 bg-[#343746] border-t border-[#44475a] pb-safe">
        <div className="max-w-md mx-auto flex">
          {[
            { key: "board", label: "Board", Icon: ClipboardList },
            { key: "add", label: "Add", Icon: PlusCircle },
            { key: "setup", label: "Setup", Icon: Settings },
          ].map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex-1 min-h-[56px] py-3 flex flex-col items-center justify-center gap-1 text-xs font-medium transition-colors active:bg-[#282a36] ${
                activeTab === key ? "text-[#bd93f9]" : "text-[#6272a4]"
              }`}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
