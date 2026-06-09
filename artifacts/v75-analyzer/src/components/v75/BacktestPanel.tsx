import { useState, useCallback, useRef } from "react";
import type { SignalTier, LayerScores } from "@/lib/v75/types";
import {
  fetchDerivTicks, runBacktest,
  bucketsOf,
  type BacktestResult, type BacktestSignal, type TierStats,
} from "@/lib/v75/backtest";

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt2 = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

const hitRate = (wins: number, losses: number): string => {
  const total = wins + losses;
  if (total === 0) return "—";
  return `${Math.round((wins / total) * 100)}%`;
};

const TIER_COLOR: Record<SignalTier, string> = {
  PREMIUM:   "#a78bfa",
  TRADE:     "#10b981",
  CANDIDATE: "#f59e0b",
  WATCH:     "#64748b",
  REJECT:    "#3f3f46",
};
const TIER_ORDER: SignalTier[] = ["PREMIUM", "TRADE", "CANDIDATE", "WATCH", "REJECT"];
const TIER_LABEL: Record<SignalTier, string> = {
  PREMIUM: "PREMIUM", TRADE: "TRADE", CANDIDATE: "CANDIDATE",
  WATCH: "WATCH", REJECT: "REJECT",
};

const LAYER_META = [
  { key: "compression"   as keyof LayerScores, name: "L1 Compression",    color: "#06b6d4" },
  { key: "expansion"     as keyof LayerScores, name: "L2 Expansion",      color: "#f59e0b" },
  { key: "structure"     as keyof LayerScores, name: "L3 Structure",      color: "#10b981" },
  { key: "flowAlignment" as keyof LayerScores, name: "L4 Flow Alignment", color: "#3b82f6" },
  { key: "persistence"   as keyof LayerScores, name: "L5 Persistence",    color: "#8b5cf6" },
];

const TICK_OPTIONS = [1000, 2000, 5000] as const;

// ── Mini histogram ────────────────────────────────────────────────────────────

function Histogram({
  title, color, buckets, highlight,
}: {
  title: string; color: string; buckets: number[]; highlight?: [number, number];
}) {
  const max = Math.max(...buckets, 1);
  const total = buckets.reduce((a, b) => a + b, 0);
  return (
    <div className="bg-zinc-800/50 border border-zinc-700/40 rounded-lg p-3 space-y-2">
      <div className="flex justify-between items-baseline">
        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color }}>{title}</span>
        <span className="text-[9px] text-zinc-600 font-mono">{total} samples</span>
      </div>
      <div className="flex items-end gap-px h-14">
        {buckets.map((count, i) => {
          const lo = i * 10, hi = lo + 10;
          const inHighlight = highlight ? lo >= highlight[0] && hi <= highlight[1] : false;
          const barColor = inHighlight ? color : `${color}55`;
          return (
            <div key={i} title={`${lo}–${hi}: ${count}`}
              className="flex-1 flex flex-col items-center justify-end gap-0.5 group cursor-default">
              <div className="relative w-full flex items-end justify-center">
                {count > 0 && (
                  <div className="absolute -top-4 opacity-0 group-hover:opacity-100 text-[8px] font-mono text-zinc-300 pointer-events-none bg-zinc-900 px-1 rounded z-10">
                    {count}
                  </div>
                )}
                <div className="w-full rounded-t-sm transition-all"
                  style={{
                    height: `${Math.max(2, (count / max) * 52)}px`,
                    background: count > 0 ? barColor : "#27272a",
                  }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[8px] text-zinc-700 font-mono">
        <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
      </div>
    </div>
  );
}

// ── Prob score histogram at signal time ───────────────────────────────────────

function SignalProbHistogram({ signals }: { signals: BacktestSignal[] }) {
  const buckets = bucketsOf(signals.map(s => s.probabilityScore));
  return (
    <Histogram
      title="Probability at Signal Trigger"
      color="#a78bfa"
      buckets={buckets}
      highlight={[85, 100]}
    />
  );
}

// ── Tier performance table ────────────────────────────────────────────────────

function TierTable({ stats }: { stats: TierStats }) {
  const rows = TIER_ORDER.filter(t => stats[t].count > 0);
  if (rows.length === 0) {
    return <p className="text-xs text-zinc-600 text-center py-4">No signals fired during this backtest period.</p>;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700/40">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-700/40">
            <th className="text-left px-3 py-2">Tier</th>
            <th className="text-right px-3 py-2">Signals</th>
            <th className="text-right px-3 py-2">Wins</th>
            <th className="text-right px-3 py-2">Losses</th>
            <th className="text-right px-3 py-2">Pending</th>
            <th className="text-right px-3 py-2">Hit Rate</th>
            <th className="px-3 py-2 w-32">Rate Bar</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(tier => {
            const s = stats[tier];
            const color = TIER_COLOR[tier];
            const hr = s.wins + s.losses > 0 ? (s.wins / (s.wins + s.losses)) : 0;
            return (
              <tr key={tier} className="border-b border-zinc-800/60 hover:bg-zinc-800/20 transition-colors">
                <td className="px-3 py-2.5">
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ color, background: `${color}22` }}>
                    {TIER_LABEL[tier]}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right text-zinc-300">{s.count}</td>
                <td className="px-3 py-2.5 text-right text-emerald-400">{s.wins}</td>
                <td className="px-3 py-2.5 text-right text-rose-400">{s.losses}</td>
                <td className="px-3 py-2.5 text-right text-zinc-500">{s.pending}</td>
                <td className="px-3 py-2.5 text-right font-bold" style={{ color: hr >= 0.65 ? "#10b981" : hr >= 0.5 ? "#f59e0b" : "#f43f5e" }}>
                  {hitRate(s.wins, s.losses)}
                </td>
                <td className="px-3 py-2.5">
                  {s.wins + s.losses > 0 && (
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden w-full">
                      <div className="h-full rounded-full" style={{ width: `${hr * 100}%`, background: hr >= 0.65 ? "#10b981" : hr >= 0.5 ? "#f59e0b" : "#f43f5e" }} />
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Signal log ────────────────────────────────────────────────────────────────

function SignalLog({ signals }: { signals: BacktestSignal[] }) {
  const [page, setPage] = useState(0);
  const PER_PAGE = 20;
  const pageCount = Math.ceil(signals.length / PER_PAGE);
  const slice = signals.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  if (signals.length === 0) {
    return <p className="text-xs text-zinc-600 text-center py-6">No signals fired.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-zinc-700/40">
        <table className="w-full text-xs font-mono min-w-[600px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-700/40 bg-zinc-900">
              <th className="text-left px-3 py-2">Time</th>
              <th className="text-center px-3 py-2">Direction</th>
              <th className="text-right px-3 py-2">Entry</th>
              <th className="text-right px-3 py-2">Prob %</th>
              <th className="text-center px-3 py-2">Tier</th>
              <th className="text-right px-3 py-2">Exit</th>
              <th className="text-center px-3 py-2">Outcome</th>
              <th className="text-right px-3 py-2">P&L pts</th>
            </tr>
          </thead>
          <tbody>
            {slice.map(sig => {
              const isRise = sig.direction === "RISE";
              const win    = sig.outcome === "WIN";
              const loss   = sig.outcome === "LOSS";
              const color  = TIER_COLOR[sig.tier];
              const pl     = sig.exitPrice != null
                ? isRise
                  ? sig.exitPrice - sig.entryPrice
                  : sig.entryPrice - sig.exitPrice
                : null;
              return (
                <tr key={sig.id} className="border-b border-zinc-800/40 hover:bg-zinc-800/20">
                  <td className="px-3 py-2 text-zinc-500">{fmtTime(sig.timestamp)}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`font-bold ${isRise ? "text-emerald-400" : "text-rose-400"}`}>
                      {isRise ? "▲ RISE" : "▼ FALL"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-300">{fmt2(sig.entryPrice)}</td>
                  <td className="px-3 py-2 text-right font-bold" style={{ color }}>
                    {sig.probabilityScore.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ color, background: `${color}22` }}>
                      {TIER_LABEL[sig.tier]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-400">
                    {sig.exitPrice != null ? fmt2(sig.exitPrice) : "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {sig.outcome ? (
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${win ? "text-emerald-400 bg-emerald-500/15" : "text-rose-400 bg-rose-500/15"}`}>
                        {sig.outcome}
                      </span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {pl != null ? (
                      <span className={pl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                        {pl >= 0 ? "+" : ""}{pl.toFixed(4)}
                      </span>
                    ) : <span className="text-zinc-600">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] text-zinc-600">{signals.length} signals total</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-zinc-300">←</button>
            <span className="text-[10px] text-zinc-500 font-mono">{page + 1}/{pageCount}</span>
            <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page === pageCount - 1}
              className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 text-zinc-300">→</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Prob time-series minimap ──────────────────────────────────────────────────

function ProbabilityTimeline({
  layerHistory, signals,
}: {
  layerHistory: Array<{ ms: number; probabilityScore: number }>;
  signals: BacktestSignal[];
}) {
  if (layerHistory.length < 2) return null;
  const W = 800, H = 60;
  const startMs = layerHistory[0].ms;
  const totalMs = layerHistory[layerHistory.length - 1].ms - startMs;
  if (totalMs <= 0) return null;

  const xOf = (ms: number) => ((ms - startMs) / totalMs) * W;
  const yOf = (prob: number) => H - (prob / 100) * H;

  const pts = layerHistory.map(e => `${xOf(e.ms).toFixed(1)},${yOf(e.probabilityScore).toFixed(1)}`).join(" ");

  return (
    <div className="bg-zinc-800/50 border border-zinc-700/40 rounded-lg p-3 space-y-1.5">
      <div className="flex justify-between items-baseline">
        <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">Probability Over Time</span>
        <span className="text-[9px] text-zinc-600">{layerHistory.length} samples</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 60 }} preserveAspectRatio="none">
        {/* Grid lines */}
        {[70, 85, 90].map(t => (
          <g key={t}>
            <line x1="0" y1={yOf(t)} x2={W} y2={yOf(t)}
              stroke={t === 85 ? "#10b981" : t === 90 ? "#a78bfa" : "#3f3f46"}
              strokeWidth="0.8" strokeDasharray={t === 85 || t === 90 ? "4,3" : "2,3"} />
            <text x="4" y={yOf(t) - 2} fontSize="7" fill={t === 85 ? "#10b981" : t === 90 ? "#a78bfa" : "#52525b"}>{t}%</text>
          </g>
        ))}
        {/* Signal markers */}
        {signals.filter(s => s.tier === "TRADE" || s.tier === "PREMIUM").map(sig => {
          const x = xOf(sig.timestamp);
          const isRise = sig.direction === "RISE";
          const color  = sig.tier === "PREMIUM" ? "#a78bfa" : "#10b981";
          return (
            <g key={sig.id}>
              <line x1={x} y1="0" x2={x} y2={H} stroke={color} strokeWidth="1" strokeDasharray="3,2" opacity="0.6" />
              <polygon points={isRise ? `${x},${H - 6} ${x - 4},${H} ${x + 4},${H}` : `${x},6 ${x - 4},0 ${x + 4},0`}
                fill={color} opacity="0.8" />
            </g>
          );
        })}
        {/* Probability polyline */}
        <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth="1.2" opacity="0.7" />
        {/* Fill under curve */}
        <polygon
          points={`0,${H} ${pts} ${W},${H}`}
          fill="url(#probGrad)" opacity="0.2"
        />
        <defs>
          <linearGradient id="probGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#6366f100" />
          </linearGradient>
        </defs>
      </svg>
      <div className="flex gap-4 text-[9px] text-zinc-600">
        <span className="flex items-center gap-1"><span className="w-3 h-px bg-emerald-500 inline-block" /> TRADE threshold (85%)</span>
        <span className="flex items-center gap-1"><span className="w-3 h-px bg-violet-400 inline-block" /> PREMIUM threshold (90%)</span>
        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-indigo-400 inline-block" /> Probability</span>
      </div>
    </div>
  );
}

// ── Main BacktestPanel ────────────────────────────────────────────────────────

type RunState = "idle" | "fetching" | "running" | "done" | "error";

export function BacktestPanel() {
  const [tickCount, setTickCount]     = useState<typeof TICK_OPTIONS[number]>(2000);
  const [runState, setRunState]       = useState<RunState>("idle");
  const [progress, setProgress]       = useState(0);
  const [error, setError]             = useState("");
  const [result, setResult]           = useState<BacktestResult | null>(null);
  const abortRef                      = useRef(false);

  const handleRun = useCallback(async () => {
    abortRef.current = false;
    setRunState("fetching");
    setProgress(0);
    setError("");
    setResult(null);

    try {
      const ticks = await fetchDerivTicks(tickCount);
      if (abortRef.current) return;
      setRunState("running");
      setProgress(5);

      // Run in a microtask to allow the UI to update first
      await new Promise(r => setTimeout(r, 20));
      const bt = runBacktest(ticks, pct => setProgress(5 + pct * 0.9));
      if (abortRef.current) return;

      setResult(bt);
      setRunState("done");
      setProgress(100);
    } catch (e: any) {
      if (!abortRef.current) {
        setError(e?.message ?? "Backtest failed");
        setRunState("error");
      }
    }
  }, [tickCount]);

  const handleReset = useCallback(() => {
    abortRef.current = true;
    setRunState("idle");
    setResult(null);
    setError("");
    setProgress(0);
  }, []);

  // ── Layer distributions from all history points ───────────────────────────

  const layerBuckets = result
    ? LAYER_META.map(l => ({
        ...l,
        buckets: bucketsOf(result.layerHistory.map(h => h.layerScores[l.key])),
      }))
    : null;

  const tradePlusSigs = result?.signals.filter(s => s.tier === "TRADE" || s.tier === "PREMIUM") ?? [];
  const allExecutable = result?.signals ?? [];

  // Overall hit rate at ≥85%
  const overallWins   = tradePlusSigs.filter(s => s.outcome === "WIN").length;
  const overallLosses = tradePlusSigs.filter(s => s.outcome === "LOSS").length;
  const overallHR     = hitRate(overallWins, overallLosses);

  return (
    <div className="min-h-screen bg-[#090912] text-white p-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <div className="text-sm font-bold tracking-widest text-zinc-300 uppercase">Backtest Mode</div>
          <div className="text-[10px] text-zinc-600">Replay tick history through the 5-Layer Microstructure Engine</div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Tick count selector */}
          <div className="flex rounded-lg overflow-hidden border border-zinc-700 text-xs font-mono">
            {TICK_OPTIONS.map(n => (
              <button key={n}
                onClick={() => setTickCount(n)}
                disabled={runState === "fetching" || runState === "running"}
                className={`px-3 py-1.5 transition-colors disabled:opacity-50 ${tickCount === n ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
                {n.toLocaleString()} ticks
              </button>
            ))}
          </div>

          {runState === "idle" || runState === "error" || runState === "done" ? (
            <button onClick={handleRun}
              className="px-5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold tracking-wide transition-colors flex items-center gap-2">
              <span>▶</span> Run Backtest
            </button>
          ) : (
            <button onClick={handleReset}
              className="px-5 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs font-bold transition-colors">
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* ── Progress / Error ── */}
      {(runState === "fetching" || runState === "running") && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs text-zinc-400">
            <div className="w-3 h-3 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
            {runState === "fetching"
              ? `Fetching ${tickCount.toLocaleString()} ticks from Deriv…`
              : `Running engine (${progress.toFixed(0)}%)…`}
          </div>
          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-violet-500 rounded-full transition-all duration-300"
              style={{ width: `${runState === "fetching" ? 15 : progress}%` }} />
          </div>
        </div>
      )}

      {runState === "error" && (
        <div className="bg-rose-900/20 border border-rose-500/30 rounded-xl px-4 py-3 text-xs text-rose-400 space-y-1">
          <div className="font-semibold">Backtest failed</div>
          <div>{error}</div>
        </div>
      )}

      {/* ── Results ── */}
      {runState === "done" && result && (
        <div className="space-y-6">

          {/* Summary strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {[
              { label: "Ticks Analyzed",    value: result.tickCount.toLocaleString(),    color: "#a1a1aa" },
              { label: "Period",            value: fmtDuration(result.durationMs),        color: "#a1a1aa" },
              { label: "Total Signals",     value: String(allExecutable.length),           color: "#a78bfa" },
              { label: "≥85% Signals",      value: String(tradePlusSigs.length),           color: "#10b981" },
              { label: "≥85% Hit Rate",     value: overallHR,                              color: overallWins > overallLosses ? "#10b981" : overallLosses > overallWins ? "#f43f5e" : "#f59e0b" },
              { label: "History Points",    value: result.layerHistory.length.toLocaleString(), color: "#a1a1aa" },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
                <div className="text-xl font-mono font-bold mt-0.5" style={{ color }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Probability timeline */}
          <ProbabilityTimeline layerHistory={result.layerHistory} signals={result.signals} />

          {/* Tier performance */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="text-xs uppercase tracking-widest text-zinc-400">Tier Performance (120s horizon)</div>
            <TierTable stats={result.tierStats} />
          </div>

          {/* Per-layer distributions */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-xs uppercase tracking-widest text-zinc-400">Per-Layer Score Distribution</span>
              <span className="text-[9px] text-zinc-600">across {result.layerHistory.length} history samples</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
              {layerBuckets!.map(l => (
                <Histogram key={l.key} title={l.name} color={l.color} buckets={l.buckets} />
              ))}
            </div>
            <p className="text-[9px] text-zinc-600">
              Bars show how often each layer scored in each 10-point bucket across all ticks in the replay. Bars in highlighted zones indicate consistent performance.
            </p>
          </div>

          {/* Prob distribution at signal trigger */}
          {allExecutable.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
              <div className="text-xs uppercase tracking-widest text-zinc-400">Probability at Signal Trigger</div>
              <div className="max-w-sm">
                <SignalProbHistogram signals={allExecutable} />
              </div>
              <p className="text-[9px] text-zinc-600">
                Distribution of composite probability scores at the exact tick when a signal was fired. Signals with highlighted bars (85–100) are TRADE or PREMIUM tier.
              </p>
            </div>
          )}

          {/* Signal log */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-xs uppercase tracking-widest text-zinc-400">Signal Log</span>
              <span className="text-[9px] text-zinc-600">{allExecutable.length} signals · 120s outcome window</span>
            </div>
            <SignalLog signals={allExecutable} />
          </div>

          {/* Notes */}
          <div className="bg-zinc-800/30 border border-zinc-700/30 rounded-xl px-4 py-3 text-[10px] text-zinc-500 space-y-1">
            <div className="font-semibold text-zinc-400">Notes</div>
            <div>• ATR is estimated from rolling 100-tick mean absolute change × 60 (proxy for M1 ATR).</div>
            <div>• Outcome uses the price 120 seconds after entry. "Pending" means the tick window did not extend far enough to determine outcome.</div>
            <div>• Backtest uses live engine state machine — trade cooldown and 5s reset buffer apply, reducing signal frequency vs raw scan.</div>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {runState === "idle" && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-10 text-center space-y-3">
          <div className="text-3xl">📊</div>
          <div className="text-sm font-semibold text-zinc-300">Ready to backtest</div>
          <p className="text-xs text-zinc-500 max-w-md mx-auto">
            Fetches live tick history from Deriv, replays it tick-by-tick through the 5-Layer engine, then reports per-layer score distributions and hit-rate by signal tier.
          </p>
          <div className="flex flex-wrap gap-2 justify-center pt-1 text-[10px] text-zinc-600">
            <span className="bg-zinc-800 px-2 py-1 rounded">L1 Compression histograms</span>
            <span className="bg-zinc-800 px-2 py-1 rounded">L2–L5 score distributions</span>
            <span className="bg-zinc-800 px-2 py-1 rounded">Tier hit-rate table</span>
            <span className="bg-zinc-800 px-2 py-1 rounded">Probability timeline</span>
            <span className="bg-zinc-800 px-2 py-1 rounded">Signal log with P&amp;L</span>
          </div>
        </div>
      )}
    </div>
  );
}
