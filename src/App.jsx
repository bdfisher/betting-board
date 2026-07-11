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
  Pencil,
  HelpCircle,
  Tag,
  RefreshCw,
} from "lucide-react";
import AddPickAutofill from "./AddPick";
import sportsApi, { parseEspnEvent } from "./services/sportsApi";

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

// ---- Scoring (hybrid edge model) ----
// Each source contributes an "edge" by tier. Multiple sources on the same play
// give diminishing returns (each additional agreeing capper counts less than the
// last), so a consensus of solid (B) cappers can build toward a bet without ever
// running away, while sharp (A) sources drive the top end. All tunable here.
const TIER_EDGE = { A: 10, B: 4.5, C: 1.5 };
const STAR_EDGE = 4;        // flat bump for your own conviction
const SOURCE_DECAY = 0.6;   // each additional agreeing source counts 60% of the previous
// Ladder rungs are one correlated thesis: the anchor rung gets a normal edge-based
// size, and each step up the ladder is scaled down (each rung 55% of the previous)
// since it's progressively less likely to hit.
const LADDER_RUNG_DECAY = 0.55;
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
  // Sort source edges strongest-first, then sum with diminishing returns so each
  // additional agreeing capper contributes SOURCE_DECAY^n of its tier edge.
  const sortedEdges = pickSrcDetails
    .map((src) => TIER_EDGE[getSourceTier(src, sport)] || 0)
    .sort((a, b) => b - a);
  const sourceEdge = sortedEdges.reduce((sum, e, i) => sum + e * Math.pow(SOURCE_DECAY, i), 0);
  const aCount = pickSrcDetails.filter((src) => getSourceTier(src, sport) === "A").length;
  const starEdge = pick.star ? STAR_EDGE : 0;
  const edge = sourceEdge + starEdge;
  return { edge, sourceEdge, starEdge, aCount, srcCount: pickSrcDetails.length };
}

function scoreRung(rung, sourcesMap, sport) {
  const srcDetails = (rung.sources || []).map((ps) => sourcesMap[ps.sourceId]).filter(Boolean);
  const sortedEdges = srcDetails
    .map((src) => TIER_EDGE[getSourceTier(src, sport)] || 0)
    .sort((a, b) => b - a);
  const sourceEdge = sortedEdges.reduce((sum, e, i) => sum + e * Math.pow(SOURCE_DECAY, i), 0);
  return sourceEdge + (rung.star ? STAR_EDGE : 0);
}

function scoreToDecision(edge) {
  // Diminishing-returns edge ladder. A consensus of B-tier cappers asymptotes
  // around ~11 (so it can reach 1u but never higher); sharp (A) consensus and a
  // personal star are what push into 1.5u–2u territory.
  if (edge >= 18) return DECISION.high;     // 2u
  if (edge >= 14) return DECISION.mid;       // 1.5u
  if (edge >= 10) return DECISION.standard;  // 1u
  if (edge >= 7.5) return DECISION.small;    // 0.5u
  return DECISION.pass;
}

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Chip palette for books (Dracula accents). New books cycle through these.
const CHIP_COLORS = ["#bd93f9", "#8be9fd", "#50fa7b", "#ff79c6", "#ffb86c", "#f1fa8c", "#ff5555", "#6272a4"];
const bookColor = (book) => book?.color || "#bd93f9";
// Translucent fill + border derived from the book's hex color, applied via inline style.
const chipStyle = (hex) => ({ color: hex, backgroundColor: `${hex}22`, borderColor: `${hex}66` });

// Sports we show the spread for (favorite only); everything else shows both moneylines.
const SPREAD_SPORTS = new Set(["NFL", "NCAAF"]);
const fmtSpread = (n) => (n === 0 ? "PK" : n > 0 ? `+${n}` : `${n}`);

// Game header as "Away (odds) @ Home (odds)". Falls back to the stored label for
// manual games or games without an odds snapshot.
function gameLabelNode(game) {
  const o = game.odds;
  if (!o || !game.home || !game.away) return game.label;
  const isSpread = SPREAD_SPORTS.has(game.sport);
  const awayOdds = isSpread ? (o.favorite === "away" && o.spread != null ? fmtSpread(o.spread) : null) : o.awayML;
  const homeOdds = isSpread ? (o.favorite === "home" && o.spread != null ? fmtSpread(o.spread) : null) : o.homeML;
  // Each side is nowrap so "Commanders (+150)" never splits; the line can only break
  // at the " @ " between them.
  return (
    <>
      <span className="whitespace-nowrap">{game.away}{awayOdds && <span className="text-[#8be9fd] font-normal"> ({awayOdds})</span>}</span>
      <span className="text-[#6272a4] font-normal"> @ </span>
      <span className="whitespace-nowrap">{game.home}{homeOdds && <span className="text-[#8be9fd] font-normal"> ({homeOdds})</span>}</span>
    </>
  );
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
  let migrated = pick.sources ? pick : {
    ...pick,
    sources: [{ sourceId: pick.sourceId, line: pick.line || "", dateAdded: pick.createdAt }],
  };
  if (!migrated.rungs) migrated = { ...migrated, rungs: [] };
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

function PickCard({ pick, sport, games = [], sources, sourcesMap, expandedPickId, setExpandedPickId, toggleStar, togglePlaced, deletePick, updatePickSources, movePickToGame, updatePickRungs, updatePickLabel }) {
  const expanded = expandedPickId === pick.id;
  const score = scorePick(pick, sourcesMap, sport);
  const decision = scoreToDecision(score.edge);
  const anchorUnits = decision.units;
  const pickSources = (pick.sources || []).map((ps) => sourcesMap[ps.sourceId]).filter(Boolean);
  const rungs = pick.rungs || [];
  // Returns { units, edge } for a rung.
  // If the rung has its own sources/star, score them and cap at the anchor-decay ceiling.
  // If the rung has no signal at all, fall back to pure anchor decay.
  function rungSize(rung, i) {
    const maxFromAnchor = anchorUnits * Math.pow(LADDER_RUNG_DECAY, i + 1);
    const hasSig = (rung.sources || []).length > 0 || rung.star;
    if (!hasSig) return { units: maxFromAnchor, edge: null };
    const edge = scoreRung(rung, sourcesMap, sport);
    return { units: Math.min(scoreToDecision(edge).units, maxFromAnchor), edge };
  }
  const [srcSearch, setSrcSearch] = useState("");
  const [srcDropOpen, setSrcDropOpen] = useState(false);
  // Rung editor modal: null, or { rungId|null, label, star, sourceIds:Set, search }
  const [rungModal, setRungModal] = useState(null);
  const [rungDropOpen, setRungDropOpen] = useState(false);
  const [editingLabel, setEditingLabel] = useState(null);

  function openRungDrop() {
    setRungDropOpen(true);
  }

  function openNewRung() {
    setRungDropOpen(false);
    setRungModal({ rungId: null, label: "", star: false, sourceIds: new Set(), search: "" });
  }
  function openEditRung(rung) {
    setRungDropOpen(false);
    setRungModal({
      rungId: rung.id,
      label: rung.label,
      star: !!rung.star,
      sourceIds: new Set((rung.sources || []).map((s) => s.sourceId)),
      search: "",
    });
  }
  function saveRung() {
    if (!rungModal || !rungModal.label.trim()) return;
    const rung = {
      id: rungModal.rungId || uid(),
      label: rungModal.label.trim(),
      sources: [...rungModal.sourceIds].map((id) => ({ sourceId: id })),
      star: rungModal.star,
    };
    const next = rungModal.rungId
      ? rungs.map((r) => (r.id === rung.id ? rung : r))
      : [...rungs, rung];
    updatePickRungs(pick.id, next);
    setRungModal(null);
  }
  function deleteRung() {
    if (!rungModal?.rungId) return;
    updatePickRungs(pick.id, rungs.filter((r) => r.id !== rungModal.rungId));
    setRungModal(null);
  }

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
    if (decision.key === "small") return `Small (0.5u) — building consensus (${reason})`;
    if (decision.key === "standard") return `Standard (1u) — solid signal (${reason})`;
    if (decision.key === "mid") return `1.5u — strong signal (${reason})`;
    return `High conviction (2u) — sharp consensus (${reason})`;
  }

  // Live sizing preview for the rung editor modal
  const _rungIdx = rungModal
    ? (rungModal.rungId ? rungs.findIndex((r) => r.id === rungModal.rungId) : rungs.length)
    : 0;
  const _maxFromAnchor = anchorUnits * Math.pow(LADDER_RUNG_DECAY, _rungIdx + 1);
  const _modalSrcDetails = rungModal
    ? [...rungModal.sourceIds].map((id) => sourcesMap[id]).filter(Boolean)
    : [];
  const _modalSortedEdges = _modalSrcDetails
    .map((src) => TIER_EDGE[getSourceTier(src, sport)] || 0)
    .sort((a, b) => b - a);
  const _modalSourceEdge = _modalSortedEdges.reduce((sum, e, i) => sum + e * Math.pow(SOURCE_DECAY, i), 0);
  const _modalStarEdge = rungModal?.star ? STAR_EDGE : 0;
  const _modalTotalEdge = _modalSourceEdge + _modalStarEdge;
  const _modalHasSig = !!(rungModal && (rungModal.sourceIds.size > 0 || rungModal.star));
  const _modalRawDecision = scoreToDecision(_modalHasSig ? _modalTotalEdge : 0);
  const _modalUnits = _modalHasSig
    ? Math.min(_modalRawDecision.units, _maxFromAnchor)
    : _maxFromAnchor;

  return (
    <div className="px-3 py-2.5">
      {/* Row 1: tap target for expand / rename */}
      {editingLabel !== null ? (
        <div className="w-full flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {pickSources.length > 1 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#50fa7b]/15 text-[#50fa7b] border border-[#50fa7b]/30 flex-shrink-0">
                {pickSources.length}×
              </span>
            )}
            <input
              autoFocus
              value={editingLabel}
              onChange={(e) => setEditingLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { if (editingLabel.trim()) updatePickLabel(pick.id, editingLabel.trim()); setEditingLabel(null); }
                if (e.key === "Escape") setEditingLabel(null);
              }}
              onBlur={() => { if (editingLabel.trim()) updatePickLabel(pick.id, editingLabel.trim()); setEditingLabel(null); }}
              autoCorrect="off" spellCheck={false} autoComplete="off"
              className="flex-1 bg-[#282a36] border border-[#bd93f9] rounded px-2 py-0.5 text-sm text-[#f8f8f2] outline-none min-w-0"
            />
          </div>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex-shrink-0 ${decision.bgCls} ${decision.textCls}`}>
            {score.edge.toFixed(1)} · {decision.label}
          </span>
        </div>
      ) : (
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
              {score.edge.toFixed(1)} · {decision.label}
            </span>
            {expanded ? <ChevronUp size={16} className="text-[#6272a4]" /> : <ChevronDown size={16} className="text-[#6272a4]" />}
          </div>
        </button>
      )}

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
        <button onClick={() => setEditingLabel(pickDisplayLabel(pick, null))} aria-label="Rename pick"
          className="flex-shrink-0 p-2 rounded-lg active:bg-[#282a36] text-[#6272a4]">
          <Pencil size={15} />
        </button>
        <button onClick={() => deletePick(pick.id)} aria-label="Delete pick"
          className="ml-auto p-2 -mr-2 rounded-lg text-[#6272a4] active:bg-[#282a36] active:text-[#ff5555] flex-shrink-0">
          <Trash2 size={17} />
        </button>
      </div>

      {/* Ladder rungs — attached to this pick. Tap a rung to edit sources/star. */}
      {rungs.length > 0 && (
        <div className="mt-1.5 ml-3 pl-3 border-l-2 border-[#8be9fd]/30 space-y-1">
          {rungs.map((rung, i) => {
            const rSources = (rung.sources || []).map((ps) => sourcesMap[ps.sourceId]).filter(Boolean);
            const { units: u, edge: rEdge } = rungSize(rung, i);
            return (
              <button key={rung.id} onClick={() => openEditRung(rung)}
                className="w-full flex items-center gap-2 text-left py-1 active:opacity-70">
                <span className="text-[10px] text-[#8be9fd]/70 flex-shrink-0">↳</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs truncate ${pick.placed ? "line-through text-[#6272a4]" : "text-[#f8f8f2]"}`}>{rung.label}</span>
                    {rung.star && <Star size={11} className="text-[#bd93f9] flex-shrink-0" fill="currentColor" />}
                  </div>
                  {rSources.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 mt-0.5">
                      {rSources.map((src) => {
                        const tier = getSourceTier(src, sport);
                        return <span key={src.id} className={`text-[9px] px-1 py-px rounded ${TIER_BADGE_CLASS[tier]}`}>{src.name} {tier}</span>;
                      })}
                    </div>
                  )}
                </div>
                <span className={`text-[10px] font-bold flex-shrink-0 ${u ? "text-[#50fa7b]" : "text-[#ff5555]"}`}>
                  {rEdge != null ? `${rEdge.toFixed(1)} · ` : ""}{fmtUnits(u)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Inline score expansion */}
      {expanded && (
        <div className="mt-3 bg-[#282a36] rounded-lg p-3 space-y-3 border border-[#44475a]">
          {/* Recommendation */}
          <div className={`text-sm font-medium ${decision.textCls}`}>{sizeReason()}</div>

          {/* Edge breakdown */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Edge breakdown</div>
            {[
              [score.srcCount > 1 ? `Sources (${score.srcCount} agree)` : "Sources", score.sourceEdge],
              ["Personal star", score.starEdge],
            ].map(([label, val]) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-xs text-[#6272a4] w-28 flex-shrink-0">{label}</span>
                <div className="flex-1 bg-[#21222c] rounded-full h-1.5 overflow-hidden">
                  <div className="h-full bg-[#bd93f9]/60 rounded-full" style={{ width: `${Math.min(100, (val / 18) * 100)}%` }} />
                </div>
                <span className="text-xs text-[#6272a4] w-12 text-right flex-shrink-0">{val.toFixed(1)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between pt-1 border-t border-[#44475a]">
              <span className="text-xs text-[#6272a4]">Effective edge</span>
              <span className={`text-sm font-bold ${decision.textCls}`}>{score.edge.toFixed(1)}</span>
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
                      .sort((a, b) => (TIER_EDGE[getSourceTier(b, sport)] || 0) - (TIER_EDGE[getSourceTier(a, sport)] || 0))
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

          {/* Ladder — rungs live on the pick; sizing scales off the anchor (this pick) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-[#6272a4]">
                Ladder{rungs.length > 0 ? ` · anchor ${fmtUnits(anchorUnits)}` : ""}
              </span>
              <button onClick={openNewRung}
                className="text-[10px] font-semibold text-[#8be9fd] border border-[#8be9fd]/40 bg-[#8be9fd]/10 rounded-lg px-2 py-1 active:scale-95">
                + {rungs.length > 0 ? "Rung" : "Ladder"}
              </button>
            </div>
            {rungs.length === 0 && (
              <p className="text-[10px] text-[#6272a4]">Add higher rungs of this pick. Each rung scales down from this pick's size; tap a rung to set its sources or star.</p>
            )}
          </div>
        </div>
      )}

      {/* Rung editor modal */}
      {rungModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3"
          onClick={() => setRungModal(null)}>
          <div className="w-full max-w-md bg-[#343746] border border-[#44475a] rounded-xl p-4 space-y-3 max-h-[85dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-[#f8f8f2]">{rungModal.rungId ? "Edit rung" : "Add rung"}</span>
              <span className="text-[10px] text-[#6272a4]">scales from anchor {fmtUnits(anchorUnits)}</span>
            </div>

            {/* Rung label */}
            <div>
              <label className="text-[10px] uppercase tracking-wide text-[#6272a4]">Rung</label>
              <input value={rungModal.label} autoFocus
                onChange={(e) => setRungModal({ ...rungModal, label: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") saveRung(); }}
                autoCorrect="off" spellCheck={false} autoComplete="off"
                placeholder="e.g. 300+ pass yds"
                className="mt-1 w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2.5 text-sm placeholder-[#44475a]" />
            </div>

            {/* Star */}
            <button onClick={() => setRungModal({ ...rungModal, star: !rungModal.star })}
              className="flex items-center gap-2 w-full">
              <Star size={18} className={rungModal.star ? "text-[#bd93f9]" : "text-[#6272a4]"} fill={rungModal.star ? "currentColor" : "none"} />
              <span className="text-sm text-[#f8f8f2]">Personal star</span>
            </button>

            {/* Sources */}
            <div>
              <label className="text-[10px] uppercase tracking-wide text-[#6272a4]">Sources</label>
              {sources.length === 0 ? (
                <div className="mt-1 text-xs text-[#6272a4]">No sources yet — add them in Setup.</div>
              ) : (
                <div className="mt-1">
                  {/* Chips + search input */}
                  <div
                    onClick={openRungDrop}
                    className="min-h-[42px] bg-[#282a36] border border-[#44475a] rounded-lg px-2.5 py-1.5 flex flex-wrap gap-1.5 items-center cursor-text"
                  >
                    {[...rungModal.sourceIds].map((id) => {
                      const src = sourcesMap[id];
                      if (!src) return null;
                      const tier = getSourceTier(src, sport);
                      return (
                        <span key={id} className="flex items-center gap-1 bg-[#50fa7b]/10 border border-[#50fa7b]/40 text-[#50fa7b] text-xs px-2 py-0.5 rounded-full">
                          {src.name}
                          <span className={`text-[10px] px-1 py-px rounded ${TIER_BADGE_CLASS[tier]}`}>{tier}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const next = new Set(rungModal.sourceIds);
                              next.delete(id);
                              setRungModal({ ...rungModal, sourceIds: next });
                            }}
                            className="text-[#50fa7b] leading-none text-sm px-1.5 py-1 -my-1 -mr-1.5"
                          >×</button>
                        </span>
                      );
                    })}
                    <input
                      type="text"
                      value={rungModal.search}
                      onChange={(e) => { setRungModal({ ...rungModal, search: e.target.value }); openRungDrop(); }}
                      onFocus={openRungDrop}
                      onBlur={() => setRungDropOpen(false)}
                      autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                      placeholder={rungModal.sourceIds.size === 0 ? "Search sources…" : ""}
                      className="flex-1 min-w-[80px] bg-transparent text-sm text-[#f8f8f2] placeholder-[#44475a] outline-none py-0.5"
                    />
                  </div>
                  {/* Inline dropdown — sits in normal flow directly under the input so it
                      stays attached even when the keyboard opens or the modal scrolls.
                      onMouseDown (not onClick) keeps the input focused so picks register
                      before the input's onBlur can close the list. */}
                  {rungDropOpen && (
                    <div className="mt-1 bg-[#21222c] border border-[#6272a4] rounded-lg shadow-xl overflow-y-auto max-h-52">
                      {sources
                        .filter((s) => s.name.toLowerCase().includes(rungModal.search.toLowerCase()))
                        .sort((a, b) => (TIER_EDGE[getSourceTier(b, sport)] || 0) - (TIER_EDGE[getSourceTier(a, sport)] || 0))
                        .map((s) => {
                          const active = rungModal.sourceIds.has(s.id);
                          const tier = getSourceTier(s, sport);
                          return (
                            <button key={s.id}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                const next = new Set(rungModal.sourceIds);
                                active ? next.delete(s.id) : next.add(s.id);
                                setRungModal({ ...rungModal, sourceIds: next, search: "" });
                              }}
                              className={`w-full flex items-center justify-between px-3 py-2.5 text-sm text-left border-b border-[#44475a] last:border-0 ${active ? "bg-[#50fa7b]/10 text-[#50fa7b]" : "text-[#f8f8f2] hover:bg-[#282a36]"}`}>
                              <span>{s.name}</span>
                              <div className="flex items-center gap-2">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${TIER_BADGE_CLASS[tier]}`}>{tier}</span>
                                {active && <span className="text-[#50fa7b] text-xs">✓</span>}
                              </div>
                            </button>
                          );
                        })}
                      {sources.filter((s) => s.name.toLowerCase().includes(rungModal.search.toLowerCase())).length === 0 && (
                        <div className="px-3 py-2 text-xs text-[#6272a4]">
                          {rungModal.search ? `No match for "${rungModal.search}"` : "All sources already added"}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Sizing preview */}
            <div className="bg-[#282a36] rounded-lg p-3 space-y-2 border border-[#44475a]">
              <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Sizing preview</div>
              <div className={`text-sm font-medium ${_modalUnits > 0 ? (_modalHasSig ? "text-[#50fa7b]" : "text-[#8be9fd]") : "text-[#ff5555]"}`}>
                {!_modalHasSig
                  ? `No rung signal — defaulting to anchor decay (${fmtUnits(_maxFromAnchor)})`
                  : _modalUnits === 0
                  ? "Pass — not enough signal on this rung"
                  : `${fmtUnits(_modalUnits)}${_modalRawDecision.units > _maxFromAnchor ? ` (signal supports ${fmtUnits(_modalRawDecision.units)}, capped by anchor)` : ""}`}
              </div>
              <div className="space-y-1.5">
                {[
                  [_modalSrcDetails.length > 1 ? `Sources (${_modalSrcDetails.length} agree)` : "Sources", _modalSourceEdge],
                  ["Personal star", _modalStarEdge],
                ].map(([label, val]) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="text-xs text-[#6272a4] w-28 flex-shrink-0">{label}</span>
                    <div className="flex-1 bg-[#21222c] rounded-full h-1.5 overflow-hidden">
                      <div className="h-full bg-[#bd93f9]/60 rounded-full" style={{ width: `${Math.min(100, (val / 18) * 100)}%` }} />
                    </div>
                    <span className="text-xs text-[#6272a4] w-12 text-right flex-shrink-0">{val.toFixed(1)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-1 border-t border-[#44475a]">
                  <span className="text-xs text-[#6272a4]">Rung edge</span>
                  <span className={`text-sm font-bold ${_modalHasSig ? (_modalUnits > 0 ? "text-[#50fa7b]" : "text-[#ff5555]") : "text-[#6272a4]"}`}>
                    {_modalHasSig ? _modalTotalEdge.toFixed(1) : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#6272a4]">Anchor ceiling</span>
                  <span className="text-xs text-[#8be9fd]">{fmtUnits(_maxFromAnchor)}</span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button onClick={saveRung} disabled={!rungModal.label.trim()}
                className={`flex-1 rounded-lg py-2.5 text-sm font-semibold ${rungModal.label.trim() ? "bg-[#8be9fd] text-[#282a36] active:scale-[0.98]" : "bg-[#21222c] text-[#44475a]"}`}>
                Save rung
              </button>
              {rungModal.rungId && (
                <button onClick={deleteRung} aria-label="Delete rung"
                  className="px-3 rounded-lg py-2.5 text-sm bg-[#21222c] border border-[#ff5555]/40 text-[#ff5555] active:bg-[#ff5555]/10">
                  <Trash2 size={16} />
                </button>
              )}
              <button onClick={() => setRungModal(null)}
                className="px-4 rounded-lg py-2.5 text-sm bg-[#21222c] text-[#6272a4]">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtUnits(n) {
  if (!n) return "Pass";
  return `${+n.toFixed(2)}u`;
}

function TicketCard({ ticket, sourcesMap, toggleTicketStar, toggleTicketPlaced, deleteTicket }) {
  const legs = ticket.legs || [];
  return (
    <div className="bg-[#343746] border border-[#44475a] rounded-lg">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#44475a]">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 bg-[#bd93f9]/15 text-[#bd93f9] border-[#bd93f9]/30">
            Parlay
          </span>
          <span className={`text-sm font-semibold truncate ${ticket.placed ? "line-through text-[#6272a4]" : "text-[#f8f8f2]"}`}>
            {ticket.name || `${legs.length}-leg parlay`}
          </span>
          <span className="text-[10px] text-[#6272a4] flex-shrink-0">{legs.length} legs</span>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button onClick={() => toggleTicketStar(ticket.id)} aria-label={ticket.star ? "Unstar" : "Star"}
            className={`p-2 -my-1 rounded-lg active:bg-[#282a36] ${ticket.star ? "text-[#bd93f9]" : "text-[#6272a4]"}`}>
            <Star size={16} fill={ticket.star ? "currentColor" : "none"} />
          </button>
          <button onClick={() => toggleTicketPlaced(ticket.id)} aria-label={ticket.placed ? "Mark not placed" : "Mark placed"}
            aria-pressed={!!ticket.placed}
            className={`p-2 -my-1 rounded-lg active:bg-[#282a36] ${ticket.placed ? "text-[#50fa7b]" : "text-[#6272a4]"}`}>
            <Check size={16} strokeWidth={ticket.placed ? 3 : 2} />
          </button>
          <button onClick={() => deleteTicket(ticket.id)} aria-label="Delete parlay"
            className="p-2 -my-1 -mr-1 rounded-lg text-[#6272a4] active:text-[#ff5555] active:bg-[#282a36]">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <ol className="divide-y divide-[#44475a]">
        {legs.map((leg, i) => {
          const legSources = (leg.sources || []).map((ps) => sourcesMap[ps.sourceId]).filter(Boolean);
          return (
            <li key={leg.id} className="px-3 py-2 flex items-start gap-2">
              <span className="text-[10px] text-[#6272a4] mt-1 w-4 flex-shrink-0 text-right">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <span className={`text-sm ${ticket.placed ? "line-through text-[#6272a4]" : "text-[#f8f8f2]"}`}>{leg.label}</span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                  <span className="text-[10px] text-[#6272a4]">{leg.sport}</span>
                  {legSources.map((src) => {
                    const tier = getSourceTier(src, leg.sport);
                    return (
                      <span key={src.id} className="text-[10px] text-[#6272a4] flex items-center gap-1">
                        {src.name}
                        <span className={`px-1 py-px rounded ${TIER_BADGE_CLASS[tier]}`}>{tier}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
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
  const [tickets, setTickets] = useState([]); // parlays & ladders (candidate staging)

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
  const [newGameHHMM, setNewGameHHMM] = useState("");
  const [newGameAmPm, setNewGameAmPm] = useState("PM");
  const [editingGameId, setEditingGameId] = useState(null);
  const [editingGameLabel, setEditingGameLabel] = useState("");
  const [editingGameTime, setEditingGameTime] = useState("");
  const [pickLabel, setPickLabel] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState(new Set());
  // parlay builder (ladders live on a pick — managed in PickCard via updatePickRungs)
  const [addMode, setAddMode] = useState("single"); // "single" | "parlay"
  const [ticketName, setTicketName] = useState("");
  const [draftLegs, setDraftLegs] = useState([]);
  const [savedFlash, setSavedFlash] = useState(null);
  const [expandedPickId, setExpandedPickId] = useState(null);
  const [collapsedSports, setCollapsedSports] = useState(new Set());
  const [collapsedGames, setCollapsedGames] = useState(new Set());
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [toast, setToast] = useState(null); // { message, type: "success"|"remove" }
  const [userEmail, setUserEmail] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null); // { message, confirmLabel, onConfirm }
  const [showHelp, setShowHelp] = useState(false);

  // promos & their config lists (books + types managed in Setup)
  const [books, setBooks] = useState([]);
  const [promoTypes, setPromoTypes] = useState([]);
  const [newBookName, setNewBookName] = useState("");
  const [newPromoTypeName, setNewPromoTypeName] = useState("");
  const [promos, setPromos] = useState([]);
  const [promoView, setPromoView] = useState("all"); // "all" | "byBook" | "byType"
  const [newPromoName, setNewPromoName] = useState("");
  const [newPromoBookId, setNewPromoBookId] = useState("");
  const [newPromoTypeId, setNewPromoTypeId] = useState("");
  const [editingPromoCell, setEditingPromoCell] = useState(null); // { promoId, field }
  const [editingPromoCellValue, setEditingPromoCellValue] = useState("");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [refreshingOdds, setRefreshingOdds] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    supabase.auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null));
  }, []);

  // iOS Safari mis-positions the fixed bottom bars in two cases: on first load the
  // fixed nav can paint off the real bottom until a scroll forces a repaint, and when
  // the soft keyboard opens it floats above the keyboard instead of the page bottom.
  // We watch the visual viewport: nudge a repaint on mount, and hide the bottom bars
  // while the keyboard is up (large gap between layout and visual viewport heights).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardOpen(gap > 120);
    };
    update();
    const raf = requestAnimationFrame(() => window.scrollBy(0, 0)); // force first-load reflow
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      let loadedSources = [];
      let loadedUnit = "";
      let loadedBooks = [];
      let loadedPromoTypes = [];
      let loadedBoard = { games: [], picks: [], tickets: [], promos: [] };
      try {
        const s = await storage.get("settings");
        if (s && s.value) {
          const parsed = JSON.parse(s.value);
          loadedSources = (parsed.sources || []).map(migrateSource);
          loadedUnit = parsed.unitValue || "";
          loadedBooks = parsed.books || [];
          loadedPromoTypes = parsed.promoTypes || [];
        }
      } catch (e) {}
      try {
        const b = await storage.get("board");
        if (b && b.value) {
          const parsed = JSON.parse(b.value);
          const allTickets = parsed.tickets || [];
          const ladderTickets = allTickets.filter((t) => t.type === "ladder");
          let pickList = (parsed.picks || []).map(migratePick);
          if (ladderTickets.length) {
            // Older ladders were standalone tickets anchored to a pick — fold their
            // rungs onto the anchor pick (ladders now live on the pick itself).
            pickList = pickList.map((p) => {
              const rungs = ladderTickets
                .filter((t) => t.anchorPickId === p.id)
                .flatMap((t) => (t.legs || []).map((l) => ({ id: l.id, label: l.label, sources: l.sources || [], star: !!l.star })));
              return rungs.length ? { ...p, rungs: [...(p.rungs || []), ...rungs] } : p;
            });
          }
          loadedBoard = {
            games: (parsed.games || []).map(migrateGame),
            picks: pickList,
            tickets: allTickets.filter((t) => t.type !== "ladder"),
            promos: parsed.promos || [],
          };
        }
      } catch (e) {}
      if (mounted) {
        setSources(loadedSources);
        setUnitValue(loadedUnit);
        setBooks(loadedBooks);
        setPromoTypes(loadedPromoTypes);
        setGames(loadedBoard.games);
        setPicks(loadedBoard.picks);
        setTickets(loadedBoard.tickets);
        setPromos(loadedBoard.promos);
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

  const persistSettings = useCallback(async (nextSources, nextUnit, nextBooks = books, nextPromoTypes = promoTypes) => {
    try {
      await storage.set("settings", JSON.stringify({ sources: nextSources, unitValue: nextUnit, books: nextBooks, promoTypes: nextPromoTypes }));
    } catch (e) {
      console.error("Failed to save settings", e);
    }
  }, [books, promoTypes]);

  const persistBoard = useCallback(async (nextGames, nextPicks, nextTickets = tickets, nextPromos = promos) => {
    try {
      await storage.set("board", JSON.stringify({ games: nextGames, picks: nextPicks, tickets: nextTickets, promos: nextPromos }));
    } catch (e) {
      console.error("Failed to save board", e);
    }
  }, [tickets, promos]);

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

  // ----- sportsbooks -----
  function addBook() {
    const name = newBookName.trim();
    if (!name) return;
    const color = CHIP_COLORS[books.length % CHIP_COLORS.length];
    const next = [...books, { id: uid(), name, color }];
    setBooks(next); persistSettings(sources, unitValue, next, promoTypes);
    setNewBookName("");
  }

  function updateBookColor(id, color) {
    const next = books.map((b) => b.id === id ? { ...b, color } : b);
    setBooks(next); persistSettings(sources, unitValue, next, promoTypes);
  }

  function deleteBook(id) {
    const next = books.filter((b) => b.id !== id);
    setBooks(next); persistSettings(sources, unitValue, next, promoTypes);
  }

  // ----- promo types -----
  function addPromoType() {
    const name = newPromoTypeName.trim();
    if (!name) return;
    const next = [...promoTypes, { id: uid(), name }];
    setPromoTypes(next); persistSettings(sources, unitValue, books, next);
    setNewPromoTypeName("");
  }

  function deletePromoType(id) {
    const next = promoTypes.filter((t) => t.id !== id);
    setPromoTypes(next); persistSettings(sources, unitValue, books, next);
  }

  // ----- promos -----
  // Commits the permanent bottom "add row". Name + book are required; type is optional.
  // Keeps the selected book so adding several promos to one book stays fast.
  function commitNewPromo() {
    const name = newPromoName.trim();
    if (!name || !newPromoBookId) return;
    const promo = {
      id: uid(),
      name,
      bookId: newPromoBookId,
      typeId: newPromoTypeId || null,
      used: false,
      createdAt: new Date().toISOString(),
    };
    const next = [...promos, promo];
    setPromos(next); persistBoard(games, picks, tickets, next);
    setNewPromoName(""); setNewPromoBookId(""); setNewPromoTypeId("");
    showToast("Promo added");
  }

  function deletePromo(id) {
    const next = promos.filter((p) => p.id !== id);
    setPromos(next); persistBoard(games, picks, tickets, next);
    showToast("Promo removed", "remove");
  }

  function clearAllPromos() {
    requestConfirm(`Delete all ${promos.length} promo${promos.length === 1 ? "" : "s"}? This can't be undone.`, () => {
      setPromos([]); persistBoard(games, picks, tickets, []);
      showToast("Promos cleared", "remove");
    });
  }

  function togglePromoUsed(id) {
    const next = promos.map((p) => p.id === id ? { ...p, used: !p.used } : p);
    setPromos(next); persistBoard(games, picks, tickets, next);
  }

  function updatePromoField(id, field, value) {
    const next = promos.map((p) => p.id === id ? { ...p, [field]: value } : p);
    setPromos(next); persistBoard(games, picks, tickets, next);
  }

  // ----- games (flat list for any sport) -----
  function addGame() {
    if (!newGameLabel) return;
    const label = newGameLabel.trim();
    if (!label) return;
    const gameTime = newGameHHMM.trim() ? `${newGameHHMM.trim()} ${newGameAmPm}` : "";
    const game = { id: uid(), label, sport: selectedSport, gameTime, createdAt: new Date().toISOString() };
    const nextGames = [...games, game];
    setGames(nextGames);
    persistBoard(nextGames, picks);
    setSelectedGameId(game.id);
    setNewGameLabel(null);
    setNewGameHHMM("");
    setNewGameAmPm("PM");
  }

  // Import games supplied by the autofill component (mapped to app game shape)
  function importGamesFromApi(newGames) {
    if (!Array.isArray(newGames) || newGames.length === 0) return;
    // avoid dupes by sport+label
    const existing = new Set(games.filter((g) => g.sport).map((g) => `${g.sport}::${g.label}`));
    const deduped = newGames.filter((ng) => !existing.has(`${ng.sport}::${ng.label}`));
    if (deduped.length === 0) {
      showToast("No new games to import", "remove");
      return;
    }
    const nextGames = [...games, ...deduped];
    setGames(nextGames);
    persistBoard(nextGames, picks);
    showToast(`Imported ${deduped.length} game${deduped.length === 1 ? "" : "s"}`);
  }

  // Manual "refresh lines" — re-fetch odds for autofilled games still in a pre-game
  // state. ESPN drops odds once a game is live/final, so those keep their last snapshot.
  async function refreshOdds() {
    const apiGames = games.filter((g) => g.raw?.idEvent && g.sport && g.date);
    if (apiGames.length === 0) {
      showToast("No autofilled games to refresh", "remove");
      return;
    }
    setRefreshingOdds(true);
    try {
      const keys = [...new Set(apiGames.map((g) => `${g.sport}__${g.date}`))];
      const oddsById = {};
      await Promise.all(keys.map(async (key) => {
        const [sport, date] = key.split("__");
        try {
          const events = await sportsApi.getEventsByDate(sport, date);
          events.forEach((ev) => {
            const parsed = parseEspnEvent(ev);
            if (parsed.odds) oddsById[parsed.id] = parsed.odds;
          });
        } catch { /* skip this group on failure */ }
      }));
      let updated = 0;
      const nextGames = games.map((g) => {
        const o = g.raw?.idEvent ? oddsById[g.raw.idEvent] : null;
        if (o) { updated++; return { ...g, odds: o, oddsAsOf: new Date().toISOString() }; }
        return g; // freeze existing snapshot (live/final or fetch failed)
      });
      setGames(nextGames);
      persistBoard(nextGames, picks);
      showToast(updated > 0 ? `Lines refreshed (${updated})` : "No open lines to update", updated > 0 ? "success" : "remove");
    } finally {
      setRefreshingOdds(false);
    }
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

  function updatePickLabel(id, label) {
    const next = picks.map((p) => p.id === id ? { ...p, label } : p);
    setPicks(next);
    persistBoard(games, next);
  }

  function updatePickSources(id, nextSources) {
    const next = picks.map((p) => p.id === id ? { ...p, sources: nextSources } : p);
    setPicks(next);
    persistBoard(games, next);
  }

  // Ladder rungs live on the pick: each rung is { id, label, sources, star }.
  // Sizing scales off the pick's own (anchor) recommendation — see PickCard.
  function updatePickRungs(id, nextRungs) {
    const next = picks.map((p) => p.id === id ? { ...p, rungs: nextRungs } : p);
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

  // ----- parlays & ladders (tickets) -----
  function canAddLeg() {
    return !!(pickLabel.trim() && selectedSport);
  }

  function addLegToDraft() {
    if (!canAddLeg()) return;
    const leg = {
      id: uid(),
      label: pickLabel.trim(),
      sport: selectedSport,
      gameId: selectedGameId || null,
      sources: [...selectedSourceIds].map((sid) => ({ sourceId: sid })),
    };
    setDraftLegs((prev) => [...prev, leg]);
    setPickLabel("");
    setSelectedSourceIds(new Set());
    showToast("Leg added");
  }

  function removeDraftLeg(id) {
    setDraftLegs((prev) => prev.filter((l) => l.id !== id));
  }

  function saveTicket() {
    if (draftLegs.length < 2) return;
    const ticket = {
      id: uid(),
      type: "parlay",
      name: ticketName.trim(),
      legs: draftLegs,
      star: false,
      placed: false,
      createdAt: new Date().toISOString(),
    };
    const nextTickets = [...tickets, ticket];
    setTickets(nextTickets);
    persistBoard(games, picks, nextTickets);
    setDraftLegs([]);
    setTicketName("");
    setPickLabel("");
    setSelectedSourceIds(new Set());
    showToast("Parlay saved");
  }

  function deleteTicket(id) {
    const nextTickets = tickets.filter((t) => t.id !== id);
    setTickets(nextTickets);
    persistBoard(games, picks, nextTickets);
    showToast("Removed", "remove");
  }

  function toggleTicketStar(id) {
    const next = tickets.map((t) => t.id === id ? { ...t, star: !t.star } : t);
    setTickets(next);
    persistBoard(games, picks, next);
  }

  function toggleTicketPlaced(id) {
    const next = tickets.map((t) => t.id === id ? { ...t, placed: !t.placed } : t);
    setTickets(next);
    persistBoard(games, picks, next);
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

  // A chip cell: a native <select> made invisible and laid over a chip <span> so the
  // chip hugs its own text (not the column) while a single tap still opens the picker.
  function renderChipSelect({ value, onChange, chipStyle, chipClass = "", text, children }) {
    return (
      <div className="relative inline-flex max-w-full align-middle">
        <span style={chipStyle}
          className={`inline-block h-6 leading-6 text-xs rounded px-1.5 truncate max-w-full border ${chipClass}`}>
          {text}
        </span>
        <select value={value} onChange={onChange}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer">
          {children}
        </select>
      </div>
    );
  }

  // ----- promo row helpers (defined here to close over state) -----
  // Uses <tr>/<td> so all rows share a single table-layout context and columns align.
  // Name is click-to-edit text; Book/Type are always-live chip dropdowns (edit in one
  // tap, Notion-style). Each cell wraps content in a fixed h-7 flex container so row
  // height never shifts. min-w-0 on the flex parents lets the Name column truncate.
  function renderPromoRow(p) {
    const isEditingName = editingPromoCell?.promoId === p.id && editingPromoCell.field === "name";
    const book = books.find((b) => b.id === p.bookId);
    const type = promoTypes.find((t) => t.id === p.typeId);
    return (
      <tr key={p.id} className={`border-b border-[#44475a] last:border-0 ${p.used ? "opacity-50" : ""}`}>
        <td className="pl-2 pr-1 py-1.5 w-7">
          <div className="h-7 flex items-center justify-center">
            <button onClick={() => togglePromoUsed(p.id)}
              className={`w-5 h-5 rounded border flex items-center justify-center ${p.used ? "bg-[#50fa7b]/20 border-[#50fa7b]/50" : "border-[#44475a]"}`}>
              {p.used && <Check size={12} className="text-[#50fa7b]" />}
            </button>
          </div>
        </td>
        <td className="px-2 py-1.5">
          <div className="h-7 flex items-center min-w-0">
            {isEditingName ? (
              <input autoFocus value={editingPromoCellValue}
                onChange={(e) => setEditingPromoCellValue(e.target.value)}
                onBlur={() => { updatePromoField(p.id, "name", editingPromoCellValue.trim() || p.name); setEditingPromoCell(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { updatePromoField(p.id, "name", editingPromoCellValue.trim() || p.name); setEditingPromoCell(null); }
                  if (e.key === "Escape") setEditingPromoCell(null);
                }}
                className="w-full h-7 bg-[#21222c] border border-[#bd93f9] rounded px-1.5 text-sm text-[#f8f8f2]" />
            ) : (
              <span onClick={() => { setEditingPromoCell({ promoId: p.id, field: "name" }); setEditingPromoCellValue(p.name); }}
                className={`block cursor-text text-sm truncate w-full ${p.used ? "line-through text-[#6272a4]" : "text-[#f8f8f2]"}`}>
                {p.name}
              </span>
            )}
          </div>
        </td>
        <td className="px-1.5 py-1.5 w-16">
          <div className="h-7 flex items-center min-w-0">
            {renderChipSelect({
              value: p.bookId || "",
              onChange: (e) => updatePromoField(p.id, "bookId", e.target.value),
              chipStyle: chipStyle(bookColor(book)),
              text: book?.name || "—",
              children: books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>),
            })}
          </div>
        </td>
        <td className="px-1.5 py-1.5 w-28">
          <div className="h-7 flex items-center min-w-0">
            {renderChipSelect({
              value: p.typeId || "",
              onChange: (e) => updatePromoField(p.id, "typeId", e.target.value || null),
              chipClass: p.typeId ? "text-[#8be9fd] bg-[#8be9fd]/10 border-[#8be9fd]/30" : "text-[#6272a4] bg-transparent border-[#44475a]",
              text: type?.name || "—",
              children: [<option key="__none" value="">—</option>, ...promoTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)],
            })}
          </div>
        </td>
        <td className="pl-1 pr-2 py-1.5 w-7">
          <div className="h-7 flex items-center justify-center">
            <button onClick={() => deletePromo(p.id)}
              className="text-[#6272a4] active:text-[#ff5555] p-1 rounded">
              <Trash2 size={15} />
            </button>
          </div>
        </td>
      </tr>
    );
  }

  // Permanent bottom "new row" — type a name, pick a book, Enter (or the ✓) commits.
  function renderAddPromoRow() {
    const canCommit = !!newPromoName.trim() && !!newPromoBookId;
    return (
      <tr className="border-t border-[#44475a] bg-[#21222c]/40">
        <td className="pl-2 pr-1 py-1.5 w-7">
          <div className="h-7 flex items-center justify-center text-[#6272a4]">
            <Plus size={16} />
          </div>
        </td>
        <td className="px-2 py-1.5">
          <div className="h-7 flex items-center min-w-0">
            <input value={newPromoName}
              onChange={(e) => setNewPromoName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitNewPromo(); }}
              placeholder="New promo…"
              className="w-full h-7 bg-transparent text-sm text-[#f8f8f2] placeholder-[#6272a4] focus:outline-none" />
          </div>
        </td>
        <td className="px-1.5 py-1.5 w-16">
          <div className="h-7 flex items-center min-w-0">
            {renderChipSelect({
              value: newPromoBookId,
              onChange: (e) => setNewPromoBookId(e.target.value),
              chipStyle: newPromoBookId ? chipStyle(bookColor(books.find((b) => b.id === newPromoBookId))) : undefined,
              chipClass: newPromoBookId ? "" : "text-[#6272a4] bg-transparent border-dashed border-[#44475a]",
              text: newPromoBookId ? (books.find((b) => b.id === newPromoBookId)?.name || "Book") : "Book",
              children: [<option key="__none" value="">Book</option>, ...books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)],
            })}
          </div>
        </td>
        <td className="px-1.5 py-1.5 w-28">
          <div className="h-7 flex items-center min-w-0">
            {renderChipSelect({
              value: newPromoTypeId,
              onChange: (e) => setNewPromoTypeId(e.target.value),
              chipClass: newPromoTypeId ? "text-[#8be9fd] bg-[#8be9fd]/10 border-[#8be9fd]/30" : "text-[#6272a4] bg-transparent border-dashed border-[#44475a]",
              text: newPromoTypeId ? (promoTypes.find((t) => t.id === newPromoTypeId)?.name || "Type") : "Type",
              children: [<option key="__none" value="">Type</option>, ...promoTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)],
            })}
          </div>
        </td>
        <td className="pl-1 pr-2 py-1.5 w-7">
          <div className="h-7 flex items-center justify-center">
            <button onClick={commitNewPromo} disabled={!canCommit}
              className={`p-1 rounded ${canCommit ? "text-[#50fa7b] active:scale-90 transition-transform" : "text-[#44475a]"}`}>
              <Check size={16} />
            </button>
          </div>
        </td>
      </tr>
    );
  }

  function renderPromosByGroup(promoList, groupKey, list) {
    const groups = [];
    list.forEach((item) => {
      const items = promoList.filter((p) => p[groupKey] === item.id);
      if (items.length > 0) groups.push({ id: item.id, name: item.name, items });
    });
    const untagged = promoList.filter((p) => !p[groupKey]);
    if (untagged.length > 0) groups.push({ id: null, name: "Untagged", items: untagged });
    return groups.map((g) => (
      <React.Fragment key={g.id || "__untagged__"}>
        <tr className="bg-[#282a36]">
          <td colSpan={5} className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-[#6272a4] border-b border-[#44475a]">
            {g.name} <span className="text-[#44475a]">({g.items.length})</span>
          </td>
        </tr>
        {g.items.map(renderPromoRow)}
      </React.Fragment>
    ));
  }

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-[#282a36] flex items-center justify-center">
        <div className="text-[#6272a4] text-sm">Loading...</div>
      </div>
    );
  }

  // The promos table wants more horizontal room than the mobile-width tabs; widen the
  // header + content when it's the active tab. The bottom nav stays fixed at max-w-md
  // so it doesn't visibly jump as you switch tabs.
  const shellWidth = activeTab === "promos" ? "max-w-2xl" : "max-w-md";

  return (
    <div className="min-h-[100dvh] bg-[#282a36] text-[#f8f8f2] pb-[calc(6rem+env(safe-area-inset-bottom))]">
      <div className={`px-4 pt-[max(0.875rem,env(safe-area-inset-top))] pb-3 border-b border-[#44475a] ${shellWidth} mx-auto flex items-baseline justify-between gap-2`}>
        <h1 className="text-xl font-bold tracking-tight text-[#f8f8f2]">The Notebook</h1>
        <button onClick={refreshOdds} disabled={refreshingOdds}
          className="flex items-center gap-1.5 text-xs text-[#6272a4] active:text-[#bd93f9] flex-shrink-0 disabled:opacity-50 self-center">
          <RefreshCw size={13} className={refreshingOdds ? "animate-spin" : ""} />
          {refreshingOdds ? "Refreshing…" : "Refresh lines"}
        </button>
      </div>

      <div className={`${shellWidth} mx-auto px-4 pt-4`}>
        {activeTab === "board" && (
          <div className="space-y-4">
            {picks.length === 0 && games.length === 0 && tickets.length === 0 ? (
              <div className="text-sm text-[#6272a4] bg-[#343746] border border-[#44475a] rounded-lg px-3 py-8 text-center">
                No picks yet.{" "}
                <button onClick={() => setActiveTab("add")} className="text-[#bd93f9] underline">Add your first pick</button>
              </div>
            ) : (
              <>
                {/* ── Parlays ── */}
                {tickets.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="text-xs uppercase tracking-wide text-[#6272a4] font-semibold">Parlays</span>
                      <span className="text-[10px] text-[#6272a4]">({tickets.length})</span>
                    </div>
                    <div className="space-y-2">
                      {tickets.map((t) => (
                        <TicketCard key={t.id} ticket={t} sourcesMap={sourcesMap}
                          toggleTicketStar={toggleTicketStar} toggleTicketPlaced={toggleTicketPlaced}
                          deleteTicket={deleteTicket} />
                      ))}
                    </div>
                  </div>
                )}

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
                            .sort((a, b) => scorePick(b, sourcesMap, "NFL").edge - scorePick(a, sourcesMap, "NFL").edge);
                          const gameCollapsed = collapsedGames.has(game.id);
                          return (
                            <div key={game.id} className="bg-[#343746] border border-[#44475a] rounded-lg">
                              <div className={`flex items-center justify-between px-3 py-2.5 ${gameCollapsed ? "" : "border-b border-[#44475a]"}`}>
                                <button onClick={() => toggleGameCollapsed(game.id)} aria-expanded={!gameCollapsed}
                                  className="flex items-start gap-1.5 min-w-0 flex-1 text-left -ml-1 p-1 rounded-lg active:bg-[#282a36]">
                                  {gameCollapsed ? <ChevronRight size={15} className="text-[#6272a4] flex-shrink-0 mt-0.5" /> : <ChevronDown size={15} className="text-[#6272a4] flex-shrink-0 mt-0.5" />}
                                  <div className="min-w-0 flex-1">
                                    <span className="text-sm font-semibold text-[#f8f8f2]">{gameLabelNode(game)}</span>
                                    {game.gameTime && <span className="text-xs text-[#6272a4] ml-1.5 whitespace-nowrap">· {game.gameTime}</span>}
                                    {gameCollapsed && gamePicks.length > 0 && <span className="text-[10px] text-[#6272a4] ml-1.5">({gamePicks.length})</span>}
                                  </div>
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
                                      toggleStar={toggleStar} togglePlaced={togglePlaced} deletePick={deletePick} updatePickSources={updatePickSources} movePickToGame={movePickToGame} updatePickRungs={updatePickRungs} updatePickLabel={updatePickLabel} />
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
                              .sort((a, b) => scorePick(b, sourcesMap, "NFL").edge - scorePick(a, sourcesMap, "NFL").edge)
                              .map((pick) => (
                                <PickCard key={pick.id} pick={pick} sport="NFL" games={games.filter((g) => g.sport === "NFL")}
                                  sources={sources} sourcesMap={sourcesMap}
                                  expandedPickId={expandedPickId} setExpandedPickId={setExpandedPickId}
                                  toggleStar={toggleStar} togglePlaced={togglePlaced} deletePick={deletePick} updatePickSources={updatePickSources} movePickToGame={movePickToGame} updatePickRungs={updatePickRungs} updatePickLabel={updatePickLabel} />
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
                    .sort((a, b) => scorePick(b, sourcesMap, sport).edge - scorePick(a, sourcesMap, sport).edge);
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
                            .sort((a, b) => scorePick(b, sourcesMap, sport).edge - scorePick(a, sourcesMap, sport).edge);
                          const gameCollapsed = collapsedGames.has(game.id);
                          return (
                            <div key={game.id} className="bg-[#343746] border border-[#44475a] rounded-lg">
                              <div className={`flex items-center justify-between px-3 py-2.5 ${gameCollapsed ? "" : "border-b border-[#44475a]"}`}>
                                <button onClick={() => toggleGameCollapsed(game.id)} aria-expanded={!gameCollapsed}
                                  className="flex items-start gap-1.5 min-w-0 flex-1 text-left -ml-1 p-1 rounded-lg active:bg-[#282a36]">
                                  {gameCollapsed ? <ChevronRight size={15} className="text-[#6272a4] flex-shrink-0 mt-0.5" /> : <ChevronDown size={15} className="text-[#6272a4] flex-shrink-0 mt-0.5" />}
                                  <div className="min-w-0 flex-1">
                                    <span className="text-sm font-semibold text-[#f8f8f2]">{gameLabelNode(game)}</span>
                                    {game.gameTime && <span className="text-xs text-[#6272a4] ml-1.5 whitespace-nowrap">· {game.gameTime}</span>}
                                    {gameCollapsed && gamePicks.length > 0 && <span className="text-[10px] text-[#6272a4] ml-1.5">({gamePicks.length})</span>}
                                  </div>
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
                                      movePickToGame={movePickToGame} updatePickRungs={updatePickRungs} updatePickLabel={updatePickLabel} />
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
                                  movePickToGame={movePickToGame} updatePickRungs={updatePickRungs} updatePickLabel={updatePickLabel} />
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

            {/* Mode: single pick vs parlay */}
            <div className="flex rounded-lg overflow-hidden border border-[#44475a]">
              {[["single", "Single pick"], ["parlay", "Parlay"]].map(([m, label]) => (
                <button key={m} onClick={() => setAddMode(m)}
                  className={`flex-1 py-2 text-sm transition-colors ${addMode === m ? "bg-[#bd93f9] text-[#282a36] font-semibold" : "bg-[#343746] text-[#6272a4]"}`}>
                  {label}
                </button>
              ))}
            </div>

            {/* Parlay name + hint */}
            {addMode === "parlay" && (
              <div className="space-y-2">
                <input type="text" value={ticketName} onChange={(e) => setTicketName(e.target.value)}
                  autoCorrect="off" spellCheck={false} autoComplete="off"
                  placeholder="Parlay name (optional)"
                  className="w-full bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2.5 text-sm placeholder-[#44475a]" />
                <p className="text-xs text-[#6272a4]">
                  Add each leg below, then save. Parlays are tracked only — no sizing. For a ladder, open a pick on the board and tap <span className="text-[#8be9fd]">+ Ladder</span>.
                </p>
              </div>
            )}

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

            {selectedSport && (
              <AddPickAutofill selectedSport={selectedSport} onImportGames={importGamesFromApi} />
            )}

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
                    <div className="flex gap-2">
                      <input type="text" value={newGameHHMM} onChange={(e) => setNewGameHHMM(e.target.value)}
                        placeholder="7:30"
                        className="flex-1 bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#44475a]" />
                      <div className="flex rounded-lg overflow-hidden border border-[#44475a] flex-shrink-0">
                        {["AM", "PM"].map((v) => (
                          <button key={v} type="button" onClick={() => setNewGameAmPm(v)}
                            className={`px-3 py-2 text-sm transition-colors ${newGameAmPm === v ? "bg-[#bd93f9] text-[#282a36] font-semibold" : "bg-[#282a36] text-[#6272a4]"}`}>
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => { addGame(); setNewGameLabel(null); }}
                        disabled={!newGameLabel?.trim()}
                        className="flex-1 bg-[#bd93f9] text-[#282a36] rounded-lg py-2 text-sm font-semibold disabled:bg-[#21222c] disabled:text-[#44475a]">
                        Add game
                      </button>
                      <button onClick={() => { setNewGameLabel(null); setNewGameHHMM(""); setNewGameAmPm("PM"); }}
                        className="px-4 py-2 rounded-lg text-sm bg-[#21222c] text-[#6272a4]">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

              </div>
            )}

            {/* Pick text */}
            {selectedSport && (
              <div>
                <label className="text-xs uppercase tracking-wide text-[#6272a4]">{addMode === "parlay" ? "Leg" : "Pick"}</label>
                <input type="text" value={pickLabel} onChange={(e) => setPickLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (addMode === "parlay") { if (canAddLeg()) addLegToDraft(); }
                    else if (canSubmitPick()) addPick();
                  }}
                  autoCorrect="off" spellCheck={false} autoComplete="off" enterKeyHint={addMode === "parlay" ? "next" : "done"}
                  placeholder={addMode === "parlay" ? "e.g. Broncos -3.5 (one leg)" : "e.g. Broncos -3.5, Over 47.5, Nix 300+ yds"}
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
                            const ta = TIER_EDGE[getSourceTier(a, selectedSport)] || 0;
                            const tb = TIER_EDGE[getSourceTier(b, selectedSport)] || 0;
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

            {/* Submit — single pick */}
            {selectedSport && addMode === "single" && (
              <button onClick={addPick} disabled={!canSubmitPick()}
                className={`w-full py-3.5 rounded-lg font-semibold transition-transform ${
                  canSubmitPick() ? "bg-[#bd93f9] text-[#282a36] active:scale-[0.98]" : "bg-[#21222c] text-[#44475a] cursor-not-allowed"
                }`}>
                Add pick
              </button>
            )}

            {/* Submit — parlay / ladder builder */}
            {addMode === "parlay" && (
              <div className="space-y-3">
                {draftLegs.length > 0 && (
                  <div className="bg-[#343746] border border-[#44475a] rounded-lg divide-y divide-[#44475a]">
                    {draftLegs.map((leg, i) => (
                      <div key={leg.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="text-[10px] text-[#6272a4] w-4 text-right flex-shrink-0">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-[#f8f8f2] truncate">{leg.label}</div>
                          <div className="text-[10px] text-[#6272a4]">
                            {leg.sport}{leg.sources.length ? ` · ${leg.sources.length} source${leg.sources.length === 1 ? "" : "s"}` : ""}
                          </div>
                        </div>
                        <button onClick={() => removeDraftLeg(leg.id)} aria-label="Remove leg"
                          className="text-[#6272a4] active:text-[#ff5555] text-base leading-none px-2.5 py-2 -my-1 -mr-1 flex-shrink-0">×</button>
                      </div>
                    ))}
                  </div>
                )}

                {selectedSport && (
                  <button onClick={addLegToDraft} disabled={!canAddLeg()}
                    className={`w-full py-3 rounded-lg font-semibold border transition-transform ${
                      canAddLeg() ? "border-[#bd93f9]/60 text-[#bd93f9] bg-[#bd93f9]/10 active:scale-[0.98]" : "border-[#44475a] text-[#44475a] cursor-not-allowed"
                    }`}>
                    + Add leg
                  </button>
                )}

                <button onClick={saveTicket} disabled={draftLegs.length < 2}
                  className={`w-full py-3.5 rounded-lg font-semibold transition-transform ${
                    draftLegs.length >= 2 ? "bg-[#bd93f9] text-[#282a36] active:scale-[0.98]" : "bg-[#21222c] text-[#44475a] cursor-not-allowed"
                  }`}>
                  Save parlay{draftLegs.length ? ` (${draftLegs.length} leg${draftLegs.length === 1 ? "" : "s"})` : ""}
                </button>
              </div>
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

            <div>
              <label className="text-xs uppercase tracking-wide text-[#6272a4]">Sportsbooks</label>
              <div className="mt-1 flex gap-2">
                <input type="text" value={newBookName} onChange={(e) => setNewBookName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addBook()}
                  autoCapitalize="words" autoCorrect="off" spellCheck={false}
                  placeholder="e.g. DraftKings"
                  className="flex-1 bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#44475a]" />
                <button onClick={addBook} className="bg-[#bd93f9] text-[#282a36] rounded-lg px-3 py-2">
                  <Plus size={18} />
                </button>
              </div>
              {books.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {books.map((b) => (
                    <div key={b.id} className="bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 flex items-center gap-2">
                      <span className="text-xs rounded px-1.5 py-0.5 border truncate max-w-[8rem]" style={chipStyle(bookColor(b))}>{b.name}</span>
                      <div className="flex-1 flex items-center gap-1 flex-wrap justify-end">
                        {CHIP_COLORS.map((c) => (
                          <button key={c} onClick={() => updateBookColor(b.id, c)} aria-label={`Set ${b.name} color`}
                            className={`w-5 h-5 rounded-full border-2 ${bookColor(b) === c ? "border-[#f8f8f2]" : "border-transparent"}`}
                            style={{ backgroundColor: c }} />
                        ))}
                      </div>
                      <button onClick={() => deleteBook(b.id)} aria-label="Delete book"
                        className="text-[#6272a4] active:text-[#ff5555] p-1.5 -mr-1 rounded-lg">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="text-xs uppercase tracking-wide text-[#6272a4]">Promo types</label>
              <div className="mt-1 flex gap-2">
                <input type="text" value={newPromoTypeName} onChange={(e) => setNewPromoTypeName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addPromoType()}
                  autoCapitalize="words" autoCorrect="off" spellCheck={false}
                  placeholder="e.g. Profit Boost"
                  className="flex-1 bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#44475a]" />
                <button onClick={addPromoType} className="bg-[#bd93f9] text-[#282a36] rounded-lg px-3 py-2">
                  <Plus size={18} />
                </button>
              </div>
              {promoTypes.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {promoTypes.map((t) => (
                    <div key={t.id} className="bg-[#343746] border border-[#44475a] rounded-lg px-3 py-2 flex items-center">
                      <span className="flex-1 text-sm text-[#f8f8f2]">{t.name}</span>
                      <button onClick={() => deletePromoType(t.id)} aria-label="Delete promo type"
                        className="text-[#6272a4] active:text-[#ff5555] p-1.5 -mr-1 rounded-lg">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
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

        {activeTab === "promos" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-[#44475a] text-xs overflow-hidden">
                {[["all", "All"], ["byBook", "By Book"], ["byType", "By Type"]].map(([v, l]) => (
                  <button key={v} onClick={() => setPromoView(v)}
                    className={`px-2.5 py-1.5 ${promoView === v ? "bg-[#bd93f9] text-[#282a36] font-semibold" : "bg-[#343746] text-[#6272a4]"}`}>
                    {l}
                  </button>
                ))}
              </div>
              {promos.length > 0 && (
                <button onClick={clearAllPromos}
                  className="ml-auto text-[#6272a4] active:text-[#ff5555] p-1.5 rounded-lg border border-[#44475a] active:scale-95 transition-transform">
                  <Trash2 size={16} />
                </button>
              )}
            </div>

            <div className="bg-[#343746] border border-[#44475a] rounded-lg overflow-hidden">
              <table className="w-full table-fixed border-collapse">
                <thead>
                  <tr className="bg-[#282a36] border-b border-[#44475a]">
                    <th className="w-7 py-1.5" />
                    <th className="text-left text-[10px] uppercase tracking-wide text-[#6272a4] py-1.5 px-2 font-normal">Name</th>
                    <th className="w-16 text-left text-[10px] uppercase tracking-wide text-[#6272a4] py-1.5 px-1.5 font-normal">Book</th>
                    <th className="w-28 text-left text-[10px] uppercase tracking-wide text-[#6272a4] py-1.5 px-1.5 font-normal">Type</th>
                    <th className="w-7 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {promoView === "all" && promos.map(renderPromoRow)}
                  {promoView === "byBook" && renderPromosByGroup(promos, "bookId", books)}
                  {promoView === "byType" && renderPromosByGroup(promos, "typeId", promoTypes)}
                  {renderAddPromoRow()}
                </tbody>
              </table>
            </div>
            {books.length === 0 && (
              <p className="text-xs text-[#ff5555] px-1">Add sportsbooks in Setup before creating promos.</p>
            )}
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

      {/* Help FAB */}
      <button
        onClick={() => setShowHelp(true)}
        className={`fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-4 z-40 w-12 h-12 rounded-full bg-[#343746] border border-[#6272a4] flex items-center justify-center text-[#6272a4] shadow-lg active:scale-95 transition-transform ${keyboardOpen ? "opacity-0 pointer-events-none" : ""}`}
        aria-label="How scoring works"
      >
        <HelpCircle size={22} />
      </button>

      {/* Scoring help modal */}
      {showHelp && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 p-3"
          onClick={() => setShowHelp(false)}>
          <div className="w-full max-w-md bg-[#343746] border border-[#44475a] rounded-xl p-4 space-y-4 max-h-[80dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-[#f8f8f2]">How scoring works</span>
              <button onClick={() => setShowHelp(false)} className="text-[#6272a4] px-2 py-1 text-xl leading-none">✕</button>
            </div>

            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Source tiers — base edge</div>
              <div className="space-y-1.5">
                {[["A — Sharp", 10, "#bd93f9"], ["B — Solid", 4.5, "#8be9fd"], ["C — Long shot", 1.5, "#6272a4"]].map(([label, edge, color]) => (
                  <div key={label} className="flex items-center gap-3">
                    <span className="text-xs text-[#f8f8f2] w-32 flex-shrink-0">{label}</span>
                    <div className="flex-1 bg-[#21222c] rounded-full h-1.5 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(edge / 10) * 100}%`, backgroundColor: color, opacity: 0.6 }} />
                    </div>
                    <span className="text-xs text-[#6272a4] w-8 text-right flex-shrink-0">+{edge}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Consensus (diminishing returns)</div>
              <p className="text-xs text-[#6272a4] leading-relaxed">Each additional agreeing source counts <span className="text-[#f8f8f2]">60%</span> of the previous. Two A-sources = 10 + 6 = 16 edge. Three = 10 + 6 + 3.6 = 19.6.</p>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Personal star</div>
              <p className="text-xs text-[#6272a4]">Adds <span className="text-[#f8f8f2]">+4</span> to edge — your own conviction layered on top of the sources.</p>
            </div>

            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Sizing thresholds</div>
              <div className="rounded-lg overflow-hidden border border-[#44475a]">
                {[
                  ["≥ 18 edge", "2u", DECISION.high.textCls],
                  ["≥ 14 edge", "1.5u", DECISION.mid.textCls],
                  ["≥ 10 edge", "1u", DECISION.standard.textCls],
                  ["≥ 7.5 edge", "0.5u", DECISION.small.textCls],
                  ["< 7.5 edge", "Pass", DECISION.pass.textCls],
                ].map(([threshold, label, cls]) => (
                  <div key={threshold} className="flex items-center justify-between px-3 py-2 border-b border-[#44475a] last:border-0 bg-[#282a36]">
                    <span className="text-xs text-[#6272a4]">{threshold}</span>
                    <span className={`text-xs font-bold ${cls}`}>{label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-[#6272a4]">Ladder rungs</div>
              <p className="text-xs text-[#6272a4] leading-relaxed">Rungs scale off the anchor pick's size. Each rung is capped at <span className="text-[#f8f8f2]">55%</span> of the one above. A 1u anchor → first rung max 0.55u → second rung max 0.30u.</p>
            </div>

            <button onClick={() => setShowHelp(false)}
              className="w-full py-2.5 rounded-lg text-sm font-semibold bg-[#21222c] text-[#6272a4] border border-[#44475a] active:scale-[0.98] transition-transform">
              Got it
            </button>
          </div>
        </div>
      )}

      <div className={`fixed bottom-0 inset-x-0 bg-[#343746] border-t border-[#44475a] pb-safe transition-transform duration-150 ${keyboardOpen ? "translate-y-full" : "translate-y-0"}`}>
        <div className="max-w-md mx-auto flex">
          {[
            { key: "board", label: "Board", Icon: ClipboardList },
            { key: "add", label: "Add", Icon: PlusCircle },
            { key: "promos", label: "Promos", Icon: Tag },
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
