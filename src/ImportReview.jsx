import React, { useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";

// Review sheet for the picks the ingest-pick edge function extracted from one
// imported tweet or article. Nothing is stored until you add them — accepting
// hands picks back to App.jsx, which runs them through the same persistBoard
// path as every other mutation. Closing the sheet discards them.
//
// Lives outside App.jsx on the same grounds AddPick.jsx does: a self-contained,
// prop-driven feature component rather than several hundred more lines in the
// single-component shell.

const STRENGTHS = [
  { key: "lean", label: "Lean", cls: "text-[#ffb86c] bg-[#ffb86c]/10 border-[#ffb86c]/40" },
  { key: "normal", label: "Play", cls: "text-[#6272a4] bg-transparent border-[#44475a]" },
  { key: "potd", label: "POTD", cls: "text-[#ff79c6] bg-[#ff79c6]/15 border-[#ff79c6]/50" },
];

const RESOLUTION_NOTE = {
  "no-game-on-board": "Team isn't on your board — autofill that week first",
  ambiguous: "Several players match — pick the right game",
  "not-found": "Couldn't find this player",
};

const inputCls =
  "w-full bg-[#282a36] border border-[#44475a] rounded-lg px-3 py-2 text-sm placeholder-[#6272a4]";

function OriginalMedia({ url }) {
  if (!url) return null;
  return (
    <img
      src={url}
      alt="Shared post"
      className="w-full max-h-56 object-contain rounded-lg border border-[#44475a] bg-[#21222c]"
    />
  );
}

function PickRow({ pick, games, onChange }) {
  // Rows from before multi-sport ingestion have no sport; they were all NFL.
  const sport = pick.sport || "NFL";
  const sportGames = useMemo(
    () => games.filter((g) => g.sport === sport),
    [games, sport],
  );

  // When the resolver found several plausible players, narrow the dropdown to
  // their games rather than making you scan the whole slate.
  const candidateGameIds = new Set((pick.candidates ?? []).map((c) => c.gameId));
  const gameOptions = candidateGameIds.size
    ? sportGames.filter((g) => candidateGameIds.has(g.id))
    : sportGames;

  const needsGame = !pick.gameId;
  const note = RESOLUTION_NOTE[pick.resolution];

  return (
    <div className="bg-[#21222c] border border-[#44475a] rounded-lg p-3 space-y-2.5">
      {/* Accept toggle + label */}
      <div className="flex items-start gap-2">
        <button
          onClick={() => onChange({ ...pick, _skip: !pick._skip })}
          aria-pressed={!pick._skip}
          className={`mt-1 w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center ${
            pick._skip
              ? "border-[#44475a] text-transparent"
              : "border-[#50fa7b] bg-[#50fa7b]/15 text-[#50fa7b]"
          }`}
        >
          <Check size={13} />
        </button>
        <input
          value={pick.label ?? ""}
          onChange={(e) => onChange({ ...pick, label: e.target.value })}
          autoCorrect="off"
          spellCheck={false}
          className={`${inputCls} ${pick._skip ? "opacity-40" : ""}`}
        />
      </div>

      {/* Player prop resolution chain — makes a wrong auto-match obvious before
          you accept it, rather than after the game. */}
      {pick.isPlayerProp && (pick.resolvedPlayer || note) && (
        <div className="flex items-start gap-1.5 text-[11px] pl-7">
          {note && <AlertTriangle size={12} className="text-[#ffb86c] mt-0.5 flex-shrink-0" />}
          <span className={note ? "text-[#ffb86c]" : "text-[#6272a4]"}>
            {pick.resolvedPlayer
              ? `${pick.resolvedPlayer} → ${pick.resolvedTeam}${note ? ` · ${note}` : ""}`
              : note}
          </span>
        </div>
      )}

      <div className="pl-7 space-y-2">
        {/* Game */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-[#6272a4] w-12 flex-shrink-0">
            Game
          </span>
          <select
            value={pick.gameId ?? ""}
            onChange={(e) => onChange({ ...pick, gameId: e.target.value || null })}
            className={`${inputCls} py-1.5 ${needsGame ? "border-[#ffb86c]/60" : ""}`}
          >
            <option value="">— no game —</option>
            {gameOptions.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
        </div>

        {/* Strength */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-[#6272a4] w-12 flex-shrink-0">
            Call
          </span>
          <div className="flex rounded-lg border border-[#44475a] overflow-hidden text-[11px]">
            {STRENGTHS.map((s) => (
              <button
                key={s.key}
                onClick={() => onChange({ ...pick, strength: s.key })}
                aria-pressed={(pick.strength ?? "normal") === s.key}
                className={`px-2.5 py-1 border-r last:border-r-0 border-[#44475a] ${
                  (pick.strength ?? "normal") === s.key ? s.cls : "text-[#6272a4]"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Above this many picks, a post is a cheat sheet rather than a call — you want
// to cherry-pick a few, not add all sixteen. So large batches arrive with
// nothing selected and you opt in; small ones stay opt-out.
const CHERRY_PICK_THRESHOLD = 5;

export default function ImportReview({ post, games, sources, onClose, onAccept }) {
  const [picks, setPicks] = useState(() => {
    const list = post.extracted?.picks ?? [];
    const skipByDefault = list.length > CHERRY_PICK_THRESHOLD;
    return list.map((p, i) => ({ ...p, _key: String(i), _skip: skipByDefault }));
  });
  const [busy, setBusy] = useState(false);

  // A post has exactly one author, so the source belongs to the sheet rather
  // than to each pick — fixing it 16 times on a cheat sheet would be absurd.
  // Seeded from whatever the resolver matched; falls back to any pick that did.
  const [sourceId, setSourceId] = useState(
    () => (post.extracted?.picks ?? []).find((p) => p.sourceId)?.sourceId ?? "",
  );

  const warnings = post.extracted?.warnings ?? [];
  const selected = picks.filter((p) => !p._skip);
  const isSheet = picks.length > CHERRY_PICK_THRESHOLD;
  const allSelected = selected.length === picks.length;

  const toggleAll = () =>
    setPicks((cur) => cur.map((p) => ({ ...p, _skip: allSelected })));

  const accept = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    await onAccept(selected.map((p) => ({ ...p, sourceId: sourceId || null })));
    setBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 p-3"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#282a36] border border-[#44475a] rounded-xl p-4 space-y-3 max-h-[88dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Review imported picks"
      >
        <div className="flex items-center justify-between gap-2 sticky -top-4 -mx-4 px-4 py-2 bg-[#282a36] z-10">
          <span className="text-sm font-bold text-[#8be9fd] truncate">
            {post.author_handle || "Imported post"}
          </span>
          <button onClick={onClose} className="text-[#6272a4] p-1 flex-shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <OriginalMedia url={post.image_url} />

        {post.raw_text && (
          <p className="text-xs text-[#6272a4] leading-relaxed whitespace-pre-wrap line-clamp-6">
            {post.raw_text}
          </p>
        )}

        {/* One source for the whole post. */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-[#6272a4] flex-shrink-0">
            Source
          </span>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className={`${inputCls} py-1.5 ${sourceId ? "" : "border-[#ffb86c]/60"}`}
          >
            <option value="">Choose a source…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {!sourceId && post.author_handle && (
          <p className="text-[11px] text-[#ffb86c] -mt-1">
            {post.author_handle} isn't in your sources yet — pick one, or add it in Setup.
          </p>
        )}

        {post.error && (
          <div className="flex items-start gap-1.5 text-[11px] text-[#ff5555]">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{post.error}</span>
          </div>
        )}

        {warnings.map((w, i) => (
          <div key={i} className="flex items-start gap-1.5 text-[11px] text-[#ffb86c]">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{w}</span>
          </div>
        ))}

        {picks.length === 0 ? (
          <p className="text-xs text-[#6272a4] italic">
            No picks found in this post.
          </p>
        ) : (
          <div className="space-y-2">
            {isSheet && (
              <div className="flex items-center justify-between text-[11px] text-[#6272a4] pb-1">
                <span>{picks.length} props — pick the ones you want</span>
                <button onClick={toggleAll} className="text-[#bd93f9] active:opacity-70">
                  {allSelected ? "Clear all" : "Select all"}
                </button>
              </div>
            )}
            {picks.map((p) => (
              <PickRow
                key={p._key}
                pick={p}
                games={games}
                onChange={(next) =>
                  setPicks((cur) => cur.map((x) => (x._key === next._key ? next : x)))
                }
              />
            ))}
          </div>
        )}

        {picks.length > 0 && (
          <button
            onClick={accept}
            disabled={!selected.length || !sourceId || busy}
            className="w-full bg-[#50fa7b] text-[#282a36] rounded-lg py-2.5 text-sm font-semibold active:opacity-80 disabled:opacity-40"
          >
            {busy
              ? "Adding…"
              : !sourceId
              ? "Choose a source first"
              : `Add ${selected.length} pick${selected.length === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    </div>
  );
}
