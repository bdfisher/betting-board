import React, { useState } from "react";
import sportsApi, { parseEspnEvent } from "./services/sportsApi";

// Returns YYYY-MM-DD in America/Chicago for any Date
function getCentralDateISO(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(date);
}

function getTomorrowCentralISO() {
  const today = getCentralDateISO(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function formatCentralTime(utcISODate) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(utcISODate));
  } catch {
    return "";
  }
}

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mapEspnEventToGame(event, sport) {
  const parsed = parseEspnEvent(event);
  const home = parsed.home || "Home";
  const away = parsed.away || "Away";
  return {
    id:        uid(),
    home,
    away,
    label:     `${away} @ ${home}`,
    sport,
    date:      parsed.date ? getCentralDateISO(new Date(parsed.date)) : "",
    gameTime:  parsed.date ? formatCentralTime(parsed.date) : "",
    createdAt: new Date().toISOString(),
    raw:       { idEvent: parsed.id },
    odds:      parsed.odds || null,
    oddsAsOf:  parsed.odds ? new Date().toISOString() : null,
  };
}

// "-2.5" style; favorite spreads are negative, 0 is a pick'em.
function fmtSpread(n) {
  if (n === 0) return "PK";
  return n > 0 ? `+${n}` : `${n}`;
}

// Odds annotation for a game preview row: favorite's spread for NFL/NCAAF, both
// moneylines otherwise. Returns "" when the game has no odds snapshot.
function oddsPreview(g) {
  const o = g.odds;
  if (!o) return "";
  if (g.sport === "NFL" || g.sport === "NCAAF") {
    if (o.spread == null || !o.favorite) return "";
    const team = o.favorite === "home" ? g.home : g.away;
    return `${team} ${fmtSpread(o.spread)}`;
  }
  if (o.awayML && o.homeML) return `${o.awayML} / ${o.homeML}`;
  return "";
}

const LS_CACHE = "betboard:espn_cache:";

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(LS_CACHE + key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - new Date(data.fetchedAt).getTime() > 3_600_000) return null;
    return data;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(LS_CACHE + key, JSON.stringify(data));
  } catch {}
}

export default function AddPickAutofill({ selectedSport, onImportGames }) {
  const [loading,     setLoading]     = useState(false);
  const [games,       setGames]       = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [error,       setError]       = useState(null);
  const [fetchMode,   setFetchMode]   = useState(null);

  function loadGames(mapped) {
    setGames(mapped);
    setSelectedIds(new Set(mapped.map((g) => g.id)));
  }

  function toggleGame(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((prev) =>
      prev.size === games.length ? new Set() : new Set(games.map((g) => g.id))
    );
  }

  async function fetchForDate(mode, dateISO) {
    setError(null); setLoading(true); setFetchMode(mode);
    try {
      const cacheKey = `${selectedSport}:${dateISO}`;
      const cached = cacheGet(cacheKey);
      if (cached) { loadGames(cached.games); setLoading(false); return; }

      const raw    = await sportsApi.getEventsByDate(selectedSport, dateISO);
      const mapped = raw.map((e) => mapEspnEventToGame(e, selectedSport));
      loadGames(mapped);
      cacheSet(cacheKey, { fetchedAt: new Date().toISOString(), games: mapped });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function fetchNflWeek() {
    setError(null); setLoading(true); setFetchMode("week");
    try {
      const cacheKey = "NFL:currentWeek";
      const cached = cacheGet(cacheKey);
      if (cached) { loadGames(cached.games); setLoading(false); return; }

      const raw    = await sportsApi.getNflWeekEvents();
      const mapped = raw.map((e) => mapEspnEventToGame(e, "NFL"));
      loadGames(mapped);
      cacheSet(cacheKey, { fetchedAt: new Date().toISOString(), games: mapped });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  function fetchToday()    { return fetchForDate("today",    getCentralDateISO(new Date())); }
  function fetchTomorrow() { return fetchForDate("tomorrow", getTomorrowCentralISO()); }

  function importSelected() {
    const toImport = games.filter((g) => selectedIds.has(g.id));
    if (!toImport.length) return;
    onImportGames(toImport);
    setGames([]); setSelectedIds(new Set()); setFetchMode(null);
  }

  const selectedCount = games.filter((g) => selectedIds.has(g.id)).length;
  const allSelected   = games.length > 0 && selectedCount === games.length;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 flex-wrap">
        {selectedSport === "NFL" ? (
          <button onClick={fetchNflWeek} className="px-3 py-2 rounded-lg text-sm bg-[#44475a] text-[#f8f8f2]">
            {loading ? "Loading…" : "Autofill NFL week"}
          </button>
        ) : (
          <>
            <button onClick={fetchToday}    className="px-3 py-2 rounded-lg text-sm bg-[#44475a] text-[#f8f8f2]">{loading ? "Loading…" : "Today"}</button>
            <button onClick={fetchTomorrow} className="px-3 py-2 rounded-lg text-sm bg-[#44475a] text-[#f8f8f2]">{loading ? "Loading…" : "Tomorrow"}</button>
          </>
        )}
        <button
          onClick={() => { setGames([]); setSelectedIds(new Set()); setFetchMode(null); }}
          className="px-3 py-2 rounded-lg text-sm bg-[#21222c] text-[#6272a4]"
        >
          Clear
        </button>
        {games.length > 0 && (
          <button
            onClick={importSelected}
            disabled={selectedCount === 0}
            className="ml-auto px-3 py-2 rounded-lg text-sm bg-[#bd93f9] text-[#282a36] disabled:bg-[#44475a] disabled:text-[#6272a4]"
          >
            Import {selectedCount} game{selectedCount !== 1 ? "s" : ""}
          </button>
        )}
      </div>

      {error && <div className="mt-2 text-xs text-[#ff5555]">{error}</div>}

      {games.length > 0 && (
        <div className="mt-2 text-xs text-[#6272a4]">
          <div className="mb-1 flex items-center justify-between">
            <span>Preview ({games.length}):</span>
            <button onClick={toggleAll} className="text-xs text-[#6272a4] underline">
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div className="grid gap-1 max-h-48 overflow-y-auto">
            {games.map((g) => {
              const isSelected = selectedIds.has(g.id);
              return (
                <div
                  key={g.id}
                  onClick={() => toggleGame(g.id)}
                  className={`cursor-pointer px-2 py-1.5 border rounded-md text-sm flex items-center gap-2 transition-opacity ${
                    isSelected
                      ? "bg-[#343746] border-[#44475a]"
                      : "bg-[#21222c] border-[#21222c] opacity-40"
                  }`}
                >
                  <div className={`w-4 h-4 rounded flex-shrink-0 border flex items-center justify-center transition-colors ${
                    isSelected ? "bg-[#bd93f9] border-[#bd93f9]" : "border-[#6272a4]"
                  }`}>
                    {isSelected && (
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                        <path d="M1 4L3.5 6.5L9 1" stroke="#282a36" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{g.away && g.home ? `${g.away} @ ${g.home}` : g.id}</div>
                    {oddsPreview(g) && <div className="text-[11px] text-[#8be9fd] truncate">{oddsPreview(g)}</div>}
                  </div>
                  <div className="text-xs text-[#6272a4] ml-1 whitespace-nowrap flex-shrink-0">
                    {fetchMode === "week" && g.date ? `${g.date}  ` : ""}{g.gameTime}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
