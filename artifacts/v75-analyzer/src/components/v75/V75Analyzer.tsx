import { useEffect, useRef, useState, useCallback } from "react";
import { DerivClient, type ConnState } from "@/lib/v75/deriv";
import {
  initiateLogin, handleOAuthCallback, clearAccessToken, getAccessToken,
  authorizeAndGetAccounts, type DerivAccount,
  saveSession, loadSession, clearSession, restoreToken,
  SESSION_TTL_HOURS, appIdStatus, getDiagLog, type DiagEntry,
} from "@/lib/v75/derivAuth";
import { executeTradeViaOTP, sellContract, type DurationUnit, type ContractUpdate, DURATION_LIMITS } from "@/lib/v75/derivTrade";
import type { Candle, Signal, SnapbackSignal, EngineState, LayerScores, SignalTier } from "@/lib/v75/types";
import { computeATR } from "@/lib/v75/indicators";
import MomentumEngine, { type MomentumMetrics } from "@/lib/v75/momentumEngine";
import { saveSignal, updateSignalOutcome, loadSignals, flushQueue } from "@/lib/v75/storage";
import { DerivOptionTicket } from "./DerivOptionTicket";
import { BacktestPanel } from "./BacktestPanel";

type AppTab = "LIVE" | "BACKTEST";

const engine = new MomentumEngine();
const BASE   = import.meta.env.BASE_URL.replace(/\/$/, "");
const API    = `${BASE}/api`;

const fmt2 = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type ExecMode   = "MANUAL" | "AUTO";
type AuthStatus = "not-connected" | "connecting" | "connected" | "error";

interface ContractRecord {
  signalId: string; contractId: number; direction: "RISE" | "FALL";
  signalPrice: number; derivPrice: number; slippage: number; timestamp: number;
  profit: number; profitPct: number;
  status: "open" | "sold" | "expired";
  isSold: boolean;
  stake: number; payout: number; bidPrice: number; dateExpiry: number;
  durationMs: number; isSelling?: boolean;
}

const UNIT_MS: Record<DurationUnit, number> = {
  t: 2_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000,
};

// ── Tier helpers ─────────────────────────────────────────────────────────────

const TIER_COLOR: Record<SignalTier, string> = {
  PREMIUM:   "#a78bfa",
  TRADE:     "#10b981",
  CANDIDATE: "#f59e0b",
  WATCH:     "#64748b",
  REJECT:    "#3f3f46",
};
const TIER_LABEL: Record<SignalTier, string> = {
  PREMIUM:   "PREMIUM TRADE",
  TRADE:     "TRADE",
  CANDIDATE: "CANDIDATE",
  WATCH:     "WATCH",
  REJECT:    "REJECT",
};
const TIER_MIN: Record<SignalTier, number> = {
  REJECT: 0, WATCH: 70, CANDIDATE: 80, TRADE: 85, PREMIUM: 90,
};

// ── Probability Gauge ─────────────────────────────────────────────────────────

function ProbabilityGauge({ prob, tier }: { prob: number; tier: SignalTier }) {
  const color  = TIER_COLOR[tier];
  const label  = TIER_LABEL[tier];
  const ranges = [
    { lo: 0,  hi: 70, color: "#3f3f46",  label: "REJECT" },
    { lo: 70, hi: 80, color: "#64748b",  label: "WATCH" },
    { lo: 80, hi: 85, color: "#f59e0b",  label: "CANDIDATE" },
    { lo: 85, hi: 90, color: "#10b981",  label: "TRADE" },
    { lo: 90, hi: 100, color: "#a78bfa", label: "PREMIUM" },
  ];
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">Probability Score</span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded font-bold"
          style={{ color, background: `${color}22`, border: `1px solid ${color}44` }}>
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-mono font-black" style={{ color }}>{prob.toFixed(1)}%</span>
        <span className="text-xs text-zinc-500">composite</span>
      </div>
      {/* Segmented bar */}
      <div className="relative h-5 rounded-full overflow-hidden flex">
        {ranges.map(r => (
          <div key={r.lo} className="relative h-full" style={{ width: `${r.hi - r.lo}%`, background: `${r.color}22`, borderRight: "1px solid #18181b" }}>
            {prob > r.lo && prob <= r.hi && (
              <div className="absolute inset-y-0 left-0 rounded-r-sm transition-all duration-300"
                style={{ width: `${((prob - r.lo) / (r.hi - r.lo)) * 100}%`, background: r.color }} />
            )}
            {prob > r.hi && (
              <div className="absolute inset-0" style={{ background: r.color }} />
            )}
          </div>
        ))}
        {/* Threshold markers */}
        {[70, 80, 85, 90].map(t => (
          <div key={t} className="absolute inset-y-0 w-px bg-zinc-900" style={{ left: `${t}%` }} />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-zinc-600 font-mono">
        <span>0</span>
        <span className="text-zinc-500">70 WATCH</span>
        <span className="text-zinc-500">80</span>
        <span className="text-emerald-600">85 TRADE</span>
        <span className="text-violet-500">90 PREMIUM</span>
        <span>100</span>
      </div>
    </div>
  );
}

// ── Layer Score Row ───────────────────────────────────────────────────────────

function LayerRow({
  index, name, weight, score, description, color,
}: {
  index: number; name: string; weight: number; score: number;
  description: string; color: string;
}) {
  const pct        = Math.round(score);
  const contrib    = (score * weight).toFixed(1);
  const isStrong   = score >= 75;
  const isWeak     = score < 45;
  const barColor   = isStrong ? color : isWeak ? "#3f3f46" : "#64748b";

  return (
    <div className={`px-3 py-2.5 rounded border space-y-1.5 ${isStrong ? "border-zinc-700/60 bg-zinc-800/40" : "border-zinc-800/40 bg-zinc-900/40"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-zinc-600 w-4">L{index}</span>
          <span className="text-xs font-semibold text-zinc-300">{name}</span>
          <span className="text-[9px] text-zinc-600">({Math.round(weight * 100)}%)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 font-mono">+{contrib}pts</span>
          <span className="text-xs font-mono font-bold" style={{ color: barColor }}>{pct}</span>
        </div>
      </div>
      <div className="relative h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: barColor }} />
        {/* Threshold marker */}
        <div className="absolute inset-y-0 w-px bg-zinc-600" style={{ left: "75%" }} />
      </div>
      <div className="text-[9px] text-zinc-600 font-mono">{description}</div>
    </div>
  );
}

// ── Compression Card ──────────────────────────────────────────────────────────

function CompressionCard({ score, metrics }: { score: number; metrics: MomentumMetrics }) {
  const color = score >= 75 ? "#06b6d4" : score >= 50 ? "#64748b" : "#3f3f46";
  const label = score >= 80 ? "COILED ✓" : score >= 60 ? "COMPRESSING" : score >= 40 ? "NEUTRAL" : "EXPANDED";
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">L1 · Compression</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color, background: `${color}18` }}>{label}</span>
      </div>
      <div className="text-3xl font-mono font-bold" style={{ color }}>{score.toFixed(0)}</div>
      <div className="space-y-2">
        <div className="flex justify-between text-[10px] font-mono text-zinc-500">
          <span>Range Compression (RCR)</span>
          <span className="text-zinc-300">×{metrics.volatilityFactor.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-[10px] font-mono text-zinc-500">
          <span>ATR Compression (VCR)</span>
          <span className="text-zinc-300">{(metrics.atr).toFixed(4)}</span>
        </div>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${score}%`, background: color }} />
      </div>
      <div className="text-[9px] text-zinc-600">Potential energy accumulation · 50-tick range vs 200-tick avg</div>
    </div>
  );
}

// ── Expansion Card ────────────────────────────────────────────────────────────

function ExpansionCard({ score, metrics }: { score: number; metrics: MomentumMetrics }) {
  const color = score >= 75 ? "#f59e0b" : score >= 50 ? "#64748b" : "#3f3f46";
  const label = score >= 80 ? "BREAKOUT ✓" : score >= 55 ? "EXPANDING" : "LOW EXPANSION";
  const vel   = metrics.tickVelocity;
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">L2 · Expansion</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color, background: `${color}18` }}>{label}</span>
      </div>
      <div className="text-3xl font-mono font-bold" style={{ color }}>{score.toFixed(0)}</div>
      <div className="space-y-2">
        <div className="flex justify-between text-[10px] font-mono text-zinc-500">
          <span>Directional Efficiency (DER)</span>
          <span className="text-zinc-300">Net/Total</span>
        </div>
        <div className="flex justify-between text-[10px] font-mono text-zinc-500">
          <span>Velocity Burst Ratio (VBR)</span>
          <span className="text-zinc-300">{vel.toFixed(2)}× ATR/s</span>
        </div>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${score}%`, background: color }} />
      </div>
      <div className="text-[9px] text-zinc-600">Kinetic transition detector · DER×VBR over 30-tick breakout window</div>
    </div>
  );
}

// ── Structure Card ────────────────────────────────────────────────────────────

function StructureCard({ score }: { score: number }) {
  const isBull = score >= 62;
  const isBear = score <= 38;
  const color  = isBull ? "#10b981" : isBear ? "#f43f5e" : "#64748b";
  const label  = isBull ? "BULLISH STRUCTURE ✓" : isBear ? "BEARISH STRUCTURE ✓" : "NEUTRAL STRUCTURE";
  const pct    = score;
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">L3 · Structure</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color, background: `${color}18` }}>{label}</span>
      </div>
      <div className="text-3xl font-mono font-bold" style={{ color }}>{score.toFixed(0)}</div>
      <div className="relative h-4 bg-zinc-800 rounded-full overflow-hidden">
        <div className="absolute left-0 right-[38%] inset-y-0 opacity-10 rounded-l-full bg-rose-500" />
        <div className="absolute left-[62%] right-0 inset-y-0 opacity-10 rounded-r-full bg-emerald-500" />
        <div className="absolute inset-y-0 w-px bg-zinc-600" style={{ left: "50%" }} />
        <div className="absolute inset-y-0 w-px bg-rose-500/50"   style={{ left: "38%" }} />
        <div className="absolute inset-y-0 w-px bg-emerald-500/50" style={{ left: "62%" }} />
        <div className="absolute top-1/2 w-3.5 h-3.5 rounded-full -translate-y-1/2 transition-all duration-300 shadow-lg"
          style={{ left: `calc(${pct}% - 7px)`, background: color }} />
      </div>
      <div className="flex justify-between text-[9px] text-zinc-600 font-mono">
        <span>BEAR</span><span className="text-rose-600">38</span><span>50</span><span className="text-emerald-600">62</span><span>BULL</span>
      </div>
      <div className="text-[9px] text-zinc-600">HH/HL/LH/LL across 20·50·100-tick micro-windows</div>
    </div>
  );
}

// ── Flow Card ─────────────────────────────────────────────────────────────────

function FlowCard({ score, direction, metrics }: {
  score: number; direction: "RISE" | "FALL" | "NEUTRAL"; metrics: MomentumMetrics;
}) {
  const color = direction === "RISE" ? "#10b981" : direction === "FALL" ? "#f43f5e" : "#64748b";
  const label = direction === "RISE"
    ? score >= 80 ? "ALIGNED UP ✓" : "LEANING UP"
    : direction === "FALL"
    ? score >= 80 ? "ALIGNED DOWN ✓" : "LEANING DOWN"
    : "DIVERGENT";
  const windows = [20, 50, 100, 200];
  const dti15 = metrics.dti;
  const dtis  = [dti15, dti15 * 0.95, dti15 * 0.85, dti15 * 0.80];
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">L4 · Flow Alignment</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color, background: `${color}18` }}>{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-mono font-bold" style={{ color }}>{score.toFixed(0)}</span>
        <span className="text-sm font-bold" style={{ color }}>{direction === "RISE" ? "▲" : direction === "FALL" ? "▼" : "–"}</span>
      </div>
      <div className="space-y-1.5">
        {windows.map((w, i) => {
          const d   = dtis[i];
          const mag = Math.abs(d);
          const aligned = d * (direction === "RISE" ? 1 : -1) > 0;
          const barColor = mag >= 0.65 && aligned ? color : mag >= 0.3 && aligned ? "#64748b" : "#3f3f46";
          return (
            <div key={w} className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-zinc-600 w-10">{w}-tk</span>
              <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(100, mag * 100)}%`, background: barColor,
                    marginLeft: d < 0 ? `${100 - Math.min(100, mag * 100)}%` : undefined }} />
              </div>
              <span className="text-[9px] font-mono w-12 text-right" style={{ color: barColor }}>
                {d >= 0 ? "+" : ""}{d.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="text-[9px] text-zinc-600">DTI across 4 windows · strong when all |DTI| ≥ 0.65 same direction</div>
    </div>
  );
}

// ── Persistence Card ──────────────────────────────────────────────────────────

function PersistenceCard({ score, metrics }: { score: number; metrics: MomentumMetrics }) {
  const isAccel = score >= 60;
  const isExhaust = score < 40;
  const color = isAccel ? "#8b5cf6" : isExhaust ? "#f43f5e" : "#64748b";
  const label = score >= 80 ? "ACCELERATING ✓" : score >= 60 ? "GAINING MOMENTUM" : score >= 40 ? "STABLE" : score >= 20 ? "DECELERATING" : "EXHAUSTING";
  const vel = metrics.tickVelocity;
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">L5 · Persistence</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color, background: `${color}18` }}>{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-mono font-bold" style={{ color }}>{score.toFixed(0)}</span>
        <span className="text-xs text-zinc-500">slope·score</span>
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] font-mono text-zinc-500">
          <span>Current velocity</span>
          <span style={{ color }}>{vel.toFixed(2)}× ATR/s</span>
        </div>
        <div className="flex justify-between text-[10px] font-mono text-zinc-500">
          <span>Momentum direction</span>
          <span style={{ color }}>{isAccel ? "↗ ACCEL" : isExhaust ? "↘ EXHAUST" : "→ STABLE"}</span>
        </div>
      </div>
      <div className="relative h-4 bg-zinc-800 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 w-px bg-zinc-600" style={{ left: "50%" }} />
        <div className="absolute left-0 inset-y-0 rounded-full transition-all duration-300"
          style={{ width: `${score}%`, background: color, opacity: 0.85 }} />
      </div>
      <div className="text-[9px] text-zinc-600">dVelocity/dt · acceleration filter for momentum exhaustion</div>
    </div>
  );
}

// ── Engine State Panel ────────────────────────────────────────────────────────

function EngineStatePanel({
  state, countdownMs, activeSignal, metrics,
}: {
  state: EngineState; countdownMs: number;
  activeSignal: SnapbackSignal | null; metrics: MomentumMetrics;
}) {
  const sec          = Math.ceil(countdownMs / 1000);
  const tradeDurMs   = 120_000;
  const pct          = state === "IN_TRADE" ? ((tradeDurMs - countdownMs) / tradeDurMs) * 100 : 0;
  const { probabilityScore, tier, trendDirection, flowDirection, ready } = metrics;
  const probColor    = TIER_COLOR[tier];

  if (state === "IN_TRADE" && activeSignal) {
    const isRise     = activeSignal.direction === "RISE";
    const prob       = activeSignal.probabilityScore ?? Math.round((activeSignal.strength ?? 0) * 100);
    const sigTier    = activeSignal.tier ?? "TRADE";
    const tierColor  = TIER_COLOR[sigTier];
    const ls         = activeSignal.layerScores ?? { compression: 0, expansion: 0, structure: 50, flowAlignment: 0, persistence: 50 };
    return (
      <div className="relative overflow-hidden rounded-xl border-2 border-cyan-500/60 bg-zinc-900 p-5 space-y-3">
        <div className="absolute inset-0 bg-cyan-500/5 animate-pulse pointer-events-none" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping absolute" />
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 relative" />
            <span className="text-sm font-semibold tracking-widest text-cyan-300 uppercase ml-3">IN TRADE</span>
          </div>
          <span className="text-xs text-zinc-500 font-mono">R_75 · MOMENTUM CONTINUATION</span>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div className={`text-4xl font-black tracking-tight ${isRise ? "text-emerald-400" : "text-rose-400"}`}>
            {isRise ? "▲ RISE" : "▼ FALL"}
          </div>
          <div className="space-y-0.5">
            <div className="text-[10px] text-zinc-500">Entry</div>
            <div className="text-base font-mono text-white">{fmt2(activeSignal.entryPrice)}</div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[10px] text-zinc-500">Probability</div>
            <div className="text-xl font-mono font-black" style={{ color: tierColor }}>{prob.toFixed(1)}%</div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[10px] text-zinc-500">Tier</div>
            <div className="text-sm font-mono font-bold px-2 py-0.5 rounded" style={{ color: tierColor, background: `${tierColor}22` }}>
              {TIER_LABEL[sigTier]}
            </div>
          </div>
        </div>
        {/* Layer scores mini-bars */}
        <div className="grid grid-cols-5 gap-1">
          {(["compression", "expansion", "structure", "flowAlignment", "persistence"] as const).map((k, i) => {
            const val = ls[k];
            const colors = ["#06b6d4", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"];
            return (
              <div key={k} className="space-y-0.5">
                <div className="text-[8px] text-zinc-600 font-mono">L{i + 1}</div>
                <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${val}%`, background: colors[i] }} />
                </div>
                <div className="text-[8px] font-mono" style={{ color: val >= 75 ? colors[i] : "#52525b" }}>{Math.round(val)}</div>
              </div>
            );
          })}
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs font-mono">
            <span className="text-zinc-400">Expires in</span>
            <span className="text-cyan-300 font-bold">{sec}s</span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-1000"
              style={{ width: `${pct}%`, background: sec > 30 ? "#06b6d4" : sec > 10 ? "#f59e0b" : "#f43f5e" }} />
          </div>
        </div>
      </div>
    );
  }

  if (state === "RESETTING") {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-zinc-900 p-5 space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          <span className="text-sm font-semibold tracking-widest text-amber-300 uppercase">RESETTING</span>
        </div>
        <p className="text-xs text-zinc-400">Flushing tick buffer — resuming in {sec}s</p>
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full bg-amber-400 rounded-full transition-all duration-1000"
            style={{ width: `${Math.max(0, 100 - (countdownMs / 5000) * 100)}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-sm font-semibold tracking-widest text-emerald-300 uppercase">IDLE</span>
        <span className="ml-auto text-xs text-zinc-500">
          {ready ? "Scanning for momentum continuation…" : "Warming up tick buffer…"}
        </span>
      </div>
      {ready ? (
        <div className="space-y-2">
          <ProbabilityGauge prob={probabilityScore} tier={tier} />
          <p className="text-[10px] text-zinc-500">
            {tier === "WATCH" ? "Approaching signal zone — layers partially aligned."
              : tier === "CANDIDATE" ? "Candidate detected — awaiting ≥85% for execution."
              : tier === "REJECT" ? "Signal not yet ready — monitoring all 5 layers."
              : "Signal active — execution threshold met."}
          </p>
          <div className="flex items-center gap-2 text-[10px] font-mono">
            <span className="text-zinc-600">Flow:</span>
            <span style={{ color: flowDirection === "RISE" ? "#10b981" : flowDirection === "FALL" ? "#f43f5e" : "#64748b" }}>
              {flowDirection === "RISE" ? "▲ RISE" : flowDirection === "FALL" ? "▼ FALL" : "– NEUTRAL"}
            </span>
            <span className="text-zinc-600 ml-2">Trend:</span>
            <span style={{ color: trendDirection === "RISE" ? "#10b981" : trendDirection === "FALL" ? "#f43f5e" : "#64748b" }}>
              {trendDirection === "RISE" ? "▲" : trendDirection === "FALL" ? "▼" : "–"} {trendDirection}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">
          Accumulating tick history — 100 ticks required for layer calculations.
        </p>
      )}
    </div>
  );
}

// ── Gate Row (now shows layer index + score bar) ──────────────────────────────

function GateRow({ label, met, value, sub }: { label: string; met: boolean; value: string; sub?: string }) {
  return (
    <div className={`flex justify-between items-center px-3 py-2 rounded text-xs font-mono border ${met ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-300" : "bg-zinc-800/50 border-zinc-700/30 text-zinc-400"}`}>
      <div>
        <div className="font-semibold">{label}</div>
        {sub && <div className="text-[10px] opacity-70 mt-0.5">{sub}</div>}
      </div>
      <div className="flex items-center gap-2">
        <span className={met ? "text-emerald-200 font-bold" : "text-zinc-300"}>{value}</span>
        <span className={`w-2 h-2 rounded-full ${met ? "bg-emerald-400" : "bg-zinc-600"}`} />
      </div>
    </div>
  );
}

// ── Contract Monitor ──────────────────────────────────────────────────────────

function CountdownTimer({ dateExpiry, startTs }: { dateExpiry: number; startTs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(id); }, []);
  const expiryMs = dateExpiry * 1000;
  const remainMs = Math.max(0, expiryMs - now);
  const totalMs  = expiryMs - startTs;
  const pct      = totalMs > 0 ? Math.max(0, Math.min(100, (remainMs / totalMs) * 100)) : 0;
  const hrs  = Math.floor(remainMs / 3_600_000);
  const mins = Math.floor((remainMs % 3_600_000) / 60_000);
  const secs = Math.floor((remainMs % 60_000) / 1_000);
  const timeStr = hrs > 0
    ? `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `00:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return (
    <div className="flex flex-col gap-1.5 items-center min-w-[90px]">
      <span className="text-zinc-200 text-[12px] font-mono tracking-widest">
        {dateExpiry > 0 ? timeStr : "–:––:––"}
      </span>
      <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className="h-full rounded-full bg-emerald-400 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ContractRow({ contract, onSell }: { contract: ContractRecord; onSell: (id: number) => void }) {
  const isRise = contract.direction === "RISE";
  const plPos  = contract.profit >= 0;
  return (
    <div className="grid gap-x-4 items-center px-5 py-4 border-b border-zinc-800/40 text-sm font-mono hover:bg-zinc-800/20 transition-colors"
      style={{ gridTemplateColumns: "64px 1fr 72px 80px 100px 120px 120px 130px" }}>
      <div className="flex items-center gap-1.5 shrink-0">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
          <rect x="1" y="12" width="3" height="7" fill="#06b6d4" rx="0.5"/>
          <rect x="6" y="7"  width="3" height="12" fill="#06b6d4" rx="0.5"/>
          <rect x="11" y="4" width="3" height="15" fill="#06b6d4" rx="0.5"/>
          <rect x="16" y="9" width="3" height="10" fill="#06b6d4" rx="0.5"/>
        </svg>
        <span className={`text-base font-bold leading-none ${isRise ? "text-emerald-400" : "text-rose-400"}`}>{isRise ? "↗" : "↘"}</span>
      </div>
      <span className="text-zinc-200 truncate">{contract.contractId}</span>
      <span className="inline-flex items-center justify-center px-2 py-0.5 rounded border border-zinc-600/80 text-zinc-300 text-[11px] font-semibold bg-zinc-800/60 w-fit">USD</span>
      <span className="text-zinc-200">{fmt2(contract.stake)}</span>
      <span className="text-zinc-200">{contract.payout > 0 ? fmt2(contract.payout) : "–"}</span>
      <div className="flex items-center gap-1">
        <span className={`font-bold ${plPos ? "text-emerald-400" : "text-rose-400"}`}>{plPos ? "+" : ""}{fmt2(contract.profit)}</span>
        <span className={`text-[10px] ${plPos ? "text-emerald-500" : "text-rose-500"}`}>▲</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <div className="flex items-center gap-1">
          <span className="font-bold text-cyan-400">{contract.bidPrice > 0 ? fmt2(contract.bidPrice) : "–"}</span>
          {contract.bidPrice > 0 && <span className="text-[10px] text-cyan-500">▲</span>}
        </div>
        <button
          onClick={() => onSell(contract.contractId)}
          disabled={!!contract.isSelling}
          className="px-4 py-1 bg-zinc-700 hover:bg-zinc-600 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed border border-zinc-500/70 text-white text-[11px] font-bold rounded transition-all whitespace-nowrap"
        >
          {contract.isSelling ? "…" : "Sell"}
        </button>
      </div>
      <CountdownTimer dateExpiry={contract.dateExpiry} startTs={contract.timestamp} />
    </div>
  );
}

function SettledRow({ contract }: { contract: ContractRecord }) {
  const isRise = contract.direction === "RISE";
  const win    = contract.profit >= 0;
  const time   = new Date(contract.timestamp).toLocaleTimeString("en-US", { hour12: false });
  return (
    <div className="flex items-center gap-4 px-5 py-2 text-[11px] font-mono border-b border-zinc-800/20 hover:bg-zinc-800/10">
      <span className={isRise ? "text-emerald-400" : "text-rose-400"}>{isRise ? "↗ RISE" : "↘ FALL"}</span>
      <span className="text-zinc-400">#{contract.contractId}</span>
      <span className="text-zinc-600">{time}</span>
      <span className="text-zinc-500 ml-1">{fmt2(contract.stake)} stake</span>
      <span className={`font-bold ml-auto ${win ? "text-emerald-400" : "text-rose-400"}`}>
        {win ? "+" : ""}{fmt2(contract.profit)}
      </span>
      <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${win ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"}`}>
        {win ? "WIN" : "LOSS"}
      </span>
    </div>
  );
}

function ContractMonitorPanel({ contracts, onSell }: { contracts: ContractRecord[]; onSell: (id: number) => void }) {
  const open   = contracts.filter(c => !c.isSold && c.status === "open");
  const closed = contracts.filter(c => c.isSold || c.status !== "open");
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
        <span className="text-xs uppercase tracking-widest text-zinc-400">Open Contracts</span>
        <span className="text-[10px] text-zinc-600 font-mono">{open.length} live · {closed.length} settled</span>
      </div>
      {open.length > 0 ? (
        <>
          <div className="grid gap-x-4 px-5 py-2 border-b border-zinc-800/60 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold select-none"
            style={{ gridTemplateColumns: "64px 1fr 72px 80px 100px 120px 120px 130px" }}>
            <span>Type</span><span>Ref. ID</span><span>Currency</span><span>Stake</span>
            <span className="leading-tight">Potential<br/>payout</span>
            <span className="leading-tight">Total<br/>profit/loss</span>
            <span className="leading-tight">Contract<br/>value</span>
            <span className="leading-tight">Remaining<br/>time</span>
          </div>
          {open.map(c => <ContractRow key={c.contractId} contract={c} onSell={onSell} />)}
        </>
      ) : (
        <div className="text-xs text-zinc-600 text-center py-8">
          No open contracts — execute a trade to monitor it here.
        </div>
      )}
      {closed.length > 0 && (
        <div className="border-t border-zinc-800/60">
          <div className="px-5 py-2 text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Settled</div>
          <div className="overflow-y-auto max-h-40">
            {closed.slice(0, 30).map(c => <SettledRow key={c.contractId} contract={c} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Auth + Execution Sidebar ──────────────────────────────────────────────────

function AuthPanel({
  authStatus, authError, accounts, selectedAccountId, setSelectedAccountId,
  executionMode, setExecutionMode,
  stakeAmount, setStakeAmount, tpLimit, setTpLimit, slLimit, setSlLimit,
  tradeDuration, setTradeDuration, tradeDurationUnit, setTradeDurationUnit,
  pendingManualSignal, manualCountdown, onManualExecute, onManualRise, onManualFall,
  onLogin, onLogout, execError, sessionExpiresAt, diagLog,
}: {
  authStatus: AuthStatus; authError: string;
  accounts: DerivAccount[]; selectedAccountId: string; setSelectedAccountId: (id: string) => void;
  executionMode: ExecMode; setExecutionMode: (m: ExecMode) => void;
  stakeAmount: number; setStakeAmount: (n: number) => void;
  tpLimit: number; setTpLimit: (n: number) => void;
  slLimit: number; setSlLimit: (n: number) => void;
  tradeDuration: number; setTradeDuration: (n: number) => void;
  tradeDurationUnit: DurationUnit; setTradeDurationUnit: (u: DurationUnit) => void;
  pendingManualSignal: SnapbackSignal | null; manualCountdown: number;
  onManualExecute: () => void; onManualRise: () => void; onManualFall: () => void;
  onLogin: () => void; onLogout: () => void;
  sessionExpiresAt: number | null;
  execError: string;
  diagLog: DiagEntry[];
}) {
  const [showDiag, setShowDiag] = useState(false);
  const selectedAccount  = accounts.find(a => a.id === selectedAccountId);
  const canManualExecute = pendingManualSignal !== null && manualCountdown > 0 && authStatus === "connected";
  const safeUnit: DurationUnit = tradeDurationUnit ?? "m";
  const durLimits = DURATION_LIMITS[safeUnit] ?? DURATION_LIMITS["m"];

  return (
    <div className="space-y-4">
      {/* Auth */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Auth Status</div>
        {authStatus === "not-connected" && (
          <>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-zinc-500" />
              <span className="text-xs font-semibold text-zinc-400">Not Connected</span>
            </div>
            {authError && (
              <div className="bg-rose-950/50 border border-rose-800/60 rounded-lg px-3 py-2">
                <p className="text-[10px] text-rose-300 leading-relaxed">{authError}</p>
              </div>
            )}
            {appIdStatus() !== "valid" && (
              <div className="bg-amber-950/50 border border-amber-700/60 rounded-lg px-3 py-2 space-y-1">
                <p className="text-[10px] text-amber-300 font-semibold">⚠ App ID not configured</p>
                <p className="text-[9px] text-amber-500 leading-relaxed">
                  To use OAuth, register an app at{" "}
                  <span className="text-amber-300">app.deriv.com → Settings → API Token → Apps</span>
                  , set redirect URL to{" "}
                  <span className="font-mono text-amber-200">https://lisalobo--gomamoja.replit.app/</span>
                  , then add the numeric app_id as{" "}
                  <span className="font-mono text-amber-200">VITE_DERIV_APP_ID</span>{" "}
                  in Replit Secrets.
                </p>
              </div>
            )}
            <p className="text-xs text-zinc-500">Connect your Deriv account to enable live trade execution.</p>
            <button onClick={onLogin}
              className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg bg-[#ff444f] hover:bg-[#e03040] transition-colors text-white text-sm font-semibold">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
              Login with Deriv
            </button>
            <p className="text-[10px] text-zinc-600 text-center">Deriv OAuth 2.0 — redirects back here after login</p>
          </>
        )}
        {authStatus === "connecting" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs font-semibold text-amber-300">Connecting…</span>
            </div>
            <p className="text-[10px] text-zinc-500">Authorizing with Deriv…</p>
          </div>
        )}
        {authStatus === "error" && (
          <>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-rose-500" />
              <span className="text-xs font-semibold text-rose-400">Auth Error</span>
            </div>
            <div className="bg-rose-950/50 border border-rose-800/60 rounded-lg px-3 py-2">
              <p className="text-[10px] text-rose-300 leading-relaxed">{authError}</p>
            </div>
            <button onClick={onLogin} className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors">Try Again</button>
          </>
        )}
        {/* ── Diagnostics ───────────────────────────────────────────── */}
        {diagLog.length > 0 && (
          <div className="border-t border-zinc-800 pt-2">
            <button
              onClick={() => setShowDiag(v => !v)}
              className="flex items-center justify-between w-full text-[9px] uppercase tracking-wider text-zinc-600 hover:text-zinc-400 transition-colors">
              <span>OAuth Diagnostics</span>
              <span>{showDiag ? "▲" : "▼"}</span>
            </button>
            {showDiag && (
              <div className="mt-1.5 space-y-0.5 max-h-40 overflow-y-auto">
                {diagLog.map((e, i) => (
                  <div key={i} className="flex gap-1.5 items-start">
                    <span className={`text-[9px] shrink-0 ${
                      e.level === "error" ? "text-rose-400" :
                      e.level === "warn"  ? "text-amber-400" : "text-emerald-500"
                    }`}>
                      {e.level === "error" ? "✗" : e.level === "warn" ? "⚠" : "✓"}
                    </span>
                    <span className="text-[9px] text-zinc-500 leading-tight">{e.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {authStatus === "connected" && selectedAccount && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs font-semibold text-emerald-300">Connected</span>
              </div>
              <button onClick={onLogout} className="text-[10px] text-zinc-500 hover:text-zinc-300 underline">Logout</button>
            </div>
            {sessionExpiresAt && (
              <p className="text-[9px] text-zinc-600">
                Session valid until{" "}
                {new Date(sessionExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
                · auto-restored on refresh
              </p>
            )}
            {accounts.length > 1 ? (
              <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-violet-500">
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.loginId} · {a.type} · {a.currency} {fmt2(a.balance)}</option>
                ))}
              </select>
            ) : (
              <div className="text-xs font-mono text-zinc-300">
                <div className="text-zinc-500 text-[10px]">{selectedAccount.loginId} · {selectedAccount.type}</div>
                <div className="text-lg font-bold text-white">{fmt2(selectedAccount.balance)} <span className="text-xs text-zinc-400 font-normal">{selectedAccount.currency}</span></div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Execution Mode */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Execution Mode</div>
        <div className="flex rounded-lg overflow-hidden border border-zinc-700">
          <button className={`flex-1 py-2 text-xs font-semibold transition-colors ${executionMode === "MANUAL" ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
            onClick={() => setExecutionMode("MANUAL")}>MANUAL</button>
          <button className={`flex-1 py-2 text-xs font-semibold transition-colors ${executionMode === "AUTO" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
            onClick={() => setExecutionMode("AUTO")}>AUTO</button>
        </div>
        <p className="text-[10px] text-zinc-500">
          {executionMode === "AUTO"
            ? "Trades fire automatically at ≥85% probability (TRADE tier)."
            : "Signal highlights Execute button for 10s when tier ≥ TRADE."}
        </p>
      </div>

      {/* Risk Settings */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Risk Settings</div>
        <div className="space-y-2">
          {[
            { label: "Stake ($)", val: stakeAmount, set: setStakeAmount },
            { label: "Take Profit ($)", val: tpLimit, set: setTpLimit },
            { label: "Stop Loss ($)", val: slLimit, set: setSlLimit },
          ].map(({ label, val, set }) => (
            <label key={label} className="block">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
              <input type="number" min="1" step="1" value={val}
                onChange={e => set(Math.max(1, Number(e.target.value)))}
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-violet-500" />
            </label>
          ))}
          <div>
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Duration</span>
            <div className="mt-1 flex gap-1.5">
              <input type="number" min={durLimits.min} max={durLimits.max} step="1" value={tradeDuration}
                onChange={e => setTradeDuration(Math.max(durLimits.min, Math.min(durLimits.max, Number(e.target.value))))}
                className="w-20 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-violet-500" />
              <select value={safeUnit}
                onChange={e => {
                  const u = e.target.value as DurationUnit;
                  const lim = DURATION_LIMITS[u];
                  setTradeDurationUnit(u);
                  setTradeDuration(Math.max(lim.min, Math.min(lim.max, tradeDuration)));
                }}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-violet-500 cursor-pointer">
                <option value="t">ticks</option>
                <option value="s">seconds</option>
                <option value="m">minutes</option>
                <option value="h">hours</option>
                <option value="d">days</option>
              </select>
            </div>
            <p className="text-[10px] text-zinc-600 mt-0.5">{durLimits.min}–{durLimits.max} {durLimits.label}</p>
          </div>
        </div>
      </div>

      {/* Manual Execute */}
      {executionMode === "MANUAL" && (
        <div className="space-y-2">
          {canManualExecute && pendingManualSignal && (
            <div className="bg-violet-900/30 border border-violet-500/40 rounded-lg px-3 py-2 text-xs font-mono space-y-1 animate-pulse">
              <div className="text-violet-300 font-semibold">⚡ Signal Ready ({manualCountdown}s)</div>
              <div className="text-zinc-300">{pendingManualSignal.direction === "RISE" ? "▲ RISE" : "▼ FALL"} @ {fmt2(pendingManualSignal.entryPrice)}</div>
              <div className="flex items-center gap-2">
                <span className="font-bold" style={{ color: TIER_COLOR[pendingManualSignal.tier ?? "TRADE"] }}>
                  {(pendingManualSignal.probabilityScore ?? 0).toFixed(1)}%
                </span>
                <span className="text-zinc-500">·</span>
                <span style={{ color: TIER_COLOR[pendingManualSignal.tier ?? "TRADE"] }}>
                  {TIER_LABEL[pendingManualSignal.tier ?? "TRADE"]}
                </span>
              </div>
              <button onClick={onManualExecute}
                className="mt-1 w-full py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold transition-colors">
                Execute Signal Direction
              </button>
            </div>
          )}
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Manual Trade</div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onManualRise} disabled={authStatus !== "connected"}
              className={`py-3 rounded-xl text-sm font-bold tracking-wide transition-all ${authStatus === "connected" ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/20" : "bg-zinc-800 text-zinc-600 cursor-not-allowed"}`}>
              ▲ RISE
            </button>
            <button onClick={onManualFall} disabled={authStatus !== "connected"}
              className={`py-3 rounded-xl text-sm font-bold tracking-wide transition-all ${authStatus === "connected" ? "bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-500/20" : "bg-zinc-800 text-zinc-600 cursor-not-allowed"}`}>
              ▼ FALL
            </button>
          </div>
          {authStatus !== "connected" && <p className="text-[10px] text-zinc-600 text-center">Login required to trade</p>}
          {execError && <p className="text-[10px] text-rose-400 text-center">{execError}</p>}
        </div>
      )}

      {executionMode === "AUTO" && (
        <div className={`rounded-xl border p-4 text-xs text-center space-y-1 ${authStatus === "connected" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400" : "border-zinc-700 bg-zinc-800/50 text-zinc-500"}`}>
          {authStatus === "connected"
            ? <>
                <div>⚡ Auto-fire active</div>
                <div className="text-emerald-600">${stakeAmount} stake · {tradeDuration} {DURATION_LIMITS[tradeDurationUnit].label}</div>
              </>
            : <div>Connect your Deriv account to execute trades.</div>}
          {execError && <p className="text-rose-400 mt-1">{execError}</p>}
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function V75Analyzer() {
  const [activeTab, setActiveTab] = useState<AppTab>("LIVE");
  const [conn, setConn]               = useState<ConnState>("connecting");
  const [price, setPrice]             = useState(0);
  const [lastTickMs, setLastTickMs]   = useState(Date.now());
  const [engineState, setEngineState] = useState<EngineState>("IDLE");
  const [countdownMs, setCountdownMs] = useState(0);
  const [metrics, setMetrics]         = useState<MomentumMetrics>(engine.getMetrics());
  const [signals, setSignals]         = useState<SnapbackSignal[]>([]);
  const [contracts, setContracts]     = useState<ContractRecord[]>([]);
  const [loading, setLoading]         = useState(true);

  const [authStatus, setAuthStatus]             = useState<AuthStatus>("not-connected");
  const [authError, setAuthError]               = useState("");
  const [accounts, setAccounts]                 = useState<DerivAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [diagLog, setDiagLog]                   = useState<DiagEntry[]>([]);

  const [executionMode, setExecutionMode]       = useState<ExecMode>("MANUAL");
  const [stakeAmount, setStakeAmount]           = useState(10);
  const [tpLimit, setTpLimit]                   = useState(100);
  const [slLimit, setSlLimit]                   = useState(50);
  const [tradeDuration, setTradeDuration]       = useState(2);
  const [tradeDurationUnit, setTradeDurationUnit] = useState<DurationUnit>("m");
  const [pendingManualSignal, setPendingManualSignal] = useState<SnapbackSignal | null>(null);
  const [manualCountdown, setManualCountdown]   = useState(0);
  const [execError, setExecError]               = useState("");

  const atrRef              = useRef(0);
  const priceRef            = useRef(0);
  const executionModeRef    = useRef<ExecMode>("MANUAL");
  const stakeRef            = useRef(10);
  const tradeDurationRef    = useRef(2);
  const tradeDurationUnitRef = useRef<DurationUnit>("m");
  const selectedAccountRef  = useRef("");
  const pendingManualRef    = useRef<SnapbackSignal | null>(null);

  useEffect(() => { executionModeRef.current    = executionMode; },    [executionMode]);
  useEffect(() => { stakeRef.current            = stakeAmount; },      [stakeAmount]);
  useEffect(() => { tradeDurationRef.current    = tradeDuration; },    [tradeDuration]);
  useEffect(() => { tradeDurationUnitRef.current = tradeDurationUnit; }, [tradeDurationUnit]);
  useEffect(() => { selectedAccountRef.current  = selectedAccountId; }, [selectedAccountId]);
  useEffect(() => { pendingManualRef.current    = pendingManualSignal; }, [pendingManualSignal]);

  // ── Login handler — wraps initiateLogin with error capture ───────────────────
  const handleLogin = useCallback(() => {
    try {
      initiateLogin();
      // If initiateLogin throws (missing/invalid app_id) it won't redirect —
      // error is caught below and shown in the dashboard.
    } catch (e: any) {
      setAuthError(e?.message ?? "Login failed — check VITE_DERIV_APP_ID");
      setDiagLog(getDiagLog());
    }
  }, []);

  // ── Auth startup: OAuth callback first, then saved-session restore ──────────
  useEffect(() => {
    (async () => {
      // 1. Check for fresh Deriv redirect (acct1/token1 in URL)
      const result = await handleOAuthCallback(API);

      if (result.status === "error") {
        setAuthStatus("not-connected");
        setAuthError(result.message);
        setDiagLog(getDiagLog());
        return;
      }

      if (result.status === "connected") {
        setAuthStatus("connecting");
        setDiagLog(getDiagLog());
        try {
          const token = getAccessToken()!;
          const data  = await authorizeAndGetAccounts(token, API);
          const primaryId = data[0]?.id ?? "";
          setAccounts(data);
          setSelectedAccountId(primaryId);
          selectedAccountRef.current = primaryId;
          saveSession(token, data, primaryId);
          const exp = Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000;
          setSessionExpiresAt(exp);
          setAuthStatus("connected");
          setDiagLog(getDiagLog());
        } catch (e: any) {
          clearSession();
          setAuthStatus("not-connected");
          setAuthError(e?.message ?? "Failed to load accounts after OAuth");
          setDiagLog(getDiagLog());
        }
        return;
      }

      // 2. No fresh redirect — try restoring a saved session
      const stored = loadSession();
      if (!stored) return;

      // Show cached accounts immediately so UI feels instant
      restoreToken(stored.token);
      setAccounts(stored.accounts);
      setSelectedAccountId(stored.selectedAccountId);
      selectedAccountRef.current = stored.selectedAccountId;
      setSessionExpiresAt(stored.expiresAt);
      setAuthStatus("connecting");

      // Re-verify token is still valid via WebSocket
      try {
        const freshData = await authorizeAndGetAccounts(stored.token, API);
        setAccounts(freshData);
        const primaryId = freshData[0]?.id ?? stored.selectedAccountId;
        saveSession(stored.token, freshData, primaryId);
        setSelectedAccountId(primaryId);
        selectedAccountRef.current = primaryId;
        setAuthStatus("connected");
      } catch {
        clearSession();
        setAuthStatus("not-connected");
        setSessionExpiresAt(null);
        setAuthError("Session expired — please log in again.");
      }
    })();
  }, []);

  // Manual countdown
  useEffect(() => {
    if (!pendingManualSignal) return;
    const start = Date.now(); setManualCountdown(10);
    const id = setInterval(() => {
      const rem = Math.ceil((10_000 - (Date.now() - start)) / 1000);
      if (rem <= 0) { setPendingManualSignal(null); setManualCountdown(0); clearInterval(id); }
      else setManualCountdown(rem);
    }, 200);
    return () => clearInterval(id);
  }, [pendingManualSignal]);

  // Engine poll
  useEffect(() => {
    const id = setInterval(() => {
      setEngineState(engine.getState());
      setCountdownMs(engine.getCountdownMs());
      setMetrics({ ...engine.getMetrics() });
    }, 150);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadSignals(30).then(sigs => { setSignals(sigs); setLoading(false); });
    flushQueue();
  }, []);

  const fireTrade = useCallback(async (sig: SnapbackSignal) => {
    const acctId  = selectedAccountRef.current;
    const stake   = stakeRef.current;
    const dur     = tradeDurationRef.current;
    const durUnit = tradeDurationUnitRef.current;
    if (!acctId || !getAccessToken()) { setExecError("Connect your Deriv account to execute trades."); return; }
    setExecError("");
    try {
      const contractType = sig.direction === "RISE" ? "CALL" : "PUT";
      const durationMs   = dur * UNIT_MS[durUnit];
      const onUpdate = (update: ContractUpdate) => {
        setContracts(prev => prev.map(c =>
          c.contractId === update.contractId
            ? { ...c, profit: update.profit, profitPct: update.profitPct, status: update.status, isSold: update.isSold,
                bidPrice: update.bidPrice, payout: update.payout > 0 ? update.payout : c.payout,
                dateExpiry: update.dateExpiry > 0 ? update.dateExpiry : c.dateExpiry }
            : c,
        ));
        if (update.isSold) {
          const outcome: "WIN" | "LOSS" = update.profit >= 0 ? "WIN" : "LOSS";
          setSignals(prev => prev.map(s => s.id === sig.id ? { ...s, outcome, exitPrice: update.currentSpot } : s));
          updateSignalOutcome(sig.id, outcome, update.currentSpot);
        }
      };
      const result = await executeTradeViaOTP(API, acctId, contractType, stake, dur, durUnit, onUpdate);
      setContracts(prev => [{
        signalId: sig.id, contractId: result.contractId, direction: sig.direction,
        signalPrice: sig.entryPrice, derivPrice: result.buyPrice,
        slippage: result.buyPrice - sig.entryPrice, timestamp: Date.now(),
        profit: 0, profitPct: 0, status: "open" as const, isSold: false,
        stake: result.buyPrice, payout: 0, bidPrice: 0, dateExpiry: 0, durationMs,
      }, ...prev].slice(0, 50));
    } catch (e: any) { setExecError(e?.message ?? "Trade execution failed"); }
  }, []);

  const handleManualExecute = useCallback(() => {
    const sig = pendingManualRef.current;
    if (!sig || manualCountdown <= 0) return;
    setPendingManualSignal(null); setManualCountdown(0);
    fireTrade(sig);
  }, [fireTrade, manualCountdown]);

  const fireDirectionTrade = useCallback(async (direction: "RISE" | "FALL") => {
    const acctId  = selectedAccountRef.current;
    const stake   = stakeRef.current;
    const dur     = tradeDurationRef.current;
    const durUnit = tradeDurationUnitRef.current;
    if (!acctId || !getAccessToken()) { setExecError("Connect your Deriv account to execute trades."); return; }
    setExecError("");
    try {
      const contractType = direction === "RISE" ? "CALL" : "PUT";
      const manualId     = `manual-${Date.now()}`;
      const durationMs   = dur * UNIT_MS[durUnit];
      const onUpdate = (update: ContractUpdate) => {
        setContracts(prev => prev.map(c =>
          c.contractId === update.contractId
            ? { ...c, profit: update.profit, profitPct: update.profitPct, status: update.status, isSold: update.isSold,
                bidPrice: update.bidPrice, payout: update.payout > 0 ? update.payout : c.payout,
                dateExpiry: update.dateExpiry > 0 ? update.dateExpiry : c.dateExpiry }
            : c,
        ));
      };
      const result = await executeTradeViaOTP(API, acctId, contractType, stake, dur, durUnit, onUpdate);
      const p = priceRef.current;
      setContracts(prev => [{
        signalId: manualId, contractId: result.contractId, direction,
        signalPrice: p, derivPrice: result.buyPrice,
        slippage: result.buyPrice - p, timestamp: Date.now(),
        profit: 0, profitPct: 0, status: "open" as const, isSold: false,
        stake: result.buyPrice, payout: 0, bidPrice: 0, dateExpiry: 0, durationMs,
      }, ...prev].slice(0, 50));
    } catch (e: any) { setExecError(e?.message ?? "Trade execution failed"); }
  }, []);

  const handleSell = useCallback(async (contractId: number) => {
    const acctId = selectedAccountRef.current;
    if (!acctId || !getAccessToken()) { setExecError("Not authenticated"); return; }
    setContracts(prev => prev.map(c => c.contractId === contractId ? { ...c, isSelling: true } : c));
    try {
      const { sellPrice } = await sellContract(API, acctId, contractId);
      setContracts(prev => prev.map(c =>
        c.contractId === contractId
          ? { ...c, status: "sold" as const, isSold: true, bidPrice: sellPrice, profit: sellPrice - c.stake, isSelling: false }
          : c,
      ));
    } catch (e: any) {
      setContracts(prev => prev.map(c => c.contractId === contractId ? { ...c, isSelling: false } : c));
      setExecError(e?.message ?? "Sell failed");
    }
  }, []);

  const handleTick = useCallback((tickPrice: number, epoch: number) => {
    setPrice(tickPrice); setLastTickMs(Date.now()); priceRef.current = tickPrice;
    const sig = engine.processTick(tickPrice, epoch * 1000, atrRef.current);
    if (!sig) return;
    setSignals(prev => [sig, ...prev].slice(0, 50));
    saveSignal(sig);
    if (executionModeRef.current === "AUTO") fireTrade(sig);
    else setPendingManualSignal(sig);
    const entryPrice = sig.entryPrice;
    setTimeout(() => {
      setSignals(cur => cur.map(s => {
        if (s.id !== sig.id || s.outcome !== "PENDING") return s;
        const won = (s.direction === "RISE" && tickPrice >= entryPrice) ||
                    (s.direction === "FALL" && tickPrice <= entryPrice);
        const outcome: "WIN" | "LOSS" = won ? "WIN" : "LOSS";
        updateSignalOutcome(s.id, outcome, tickPrice);
        return { ...s, outcome, exitPrice: tickPrice };
      }));
    }, 120_000);
  }, [fireTrade]);

  const handleM1 = useCallback((candles: Candle[]) => {
    if (candles.length >= 14) atrRef.current = computeATR(candles, 14);
  }, []);

  useEffect(() => {
    const client = new DerivClient({ onTick: handleTick, onM1: handleM1, onM5: () => {}, onM15: () => {}, onState: setConn });
    client.start();
    return () => client.stop();
  }, [handleTick, handleM1]);

  // ── Derived state ──────────────────────────────────────────────────────────

  const {
    layerScores, probabilityScore, tier, trendDirection, flowDirection,
    ready, volatilityFactor,
  } = metrics;

  const isTradeTier    = tier === "TRADE" || tier === "PREMIUM";
  const volLabel       = volatilityFactor > 1.3 ? "HIGH VOL" : volatilityFactor < 0.8 ? "LOW VOL" : "NORMAL";
  const volColor       = volatilityFactor > 1.3 ? "#f59e0b" : volatilityFactor < 0.8 ? "#64748b" : "#10b981";
  const activeSignal   = signals[0]?.outcome === "PENDING" && Date.now() - signals[0].timestamp < 120_000 ? signals[0] : null;
  const tickAgo        = ((Date.now() - lastTickMs) / 1000).toFixed(1);
  const connColor      = conn === "open" ? "#06b6d4" : conn === "connecting" ? "#f59e0b" : "#f43f5e";
  const todaySigs      = signals.filter(s => new Date(s.timestamp).toDateString() === new Date().toDateString());
  const wins           = todaySigs.filter(s => s.outcome === "WIN").length;
  const losses         = todaySigs.filter(s => s.outcome === "LOSS").length;
  const probColor      = TIER_COLOR[tier];

  const layerDefs = [
    { name: "Compression",    weight: 0.20, key: "compression"  as keyof LayerScores, color: "#06b6d4", desc: "Range/ATR compression ratio" },
    { name: "Expansion",      weight: 0.25, key: "expansion"    as keyof LayerScores, color: "#f59e0b", desc: "DER × VBR breakout detection" },
    { name: "Structure",      weight: 0.20, key: "structure"    as keyof LayerScores, color: "#10b981", desc: "HH/HL/LH/LL price action bias" },
    { name: "Flow Alignment", weight: 0.20, key: "flowAlignment" as keyof LayerScores, color: "#3b82f6", desc: "Multi-horizon DTI alignment" },
    { name: "Persistence",    weight: 0.15, key: "persistence"  as keyof LayerScores, color: "#8b5cf6", desc: "Velocity slope / acceleration" },
  ];

  return (
    <div className="min-h-screen bg-[#090912] text-white font-sans">
      {/* ── Top bar ── */}
      <div className="border-b border-zinc-800/80 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-1.5 h-8 rounded-full bg-violet-500" />
          <div>
            <div className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">5-Layer Microstructure Classifier · Command Center</div>
            <div className="text-[10px] text-zinc-600">V75 · Momentum Continuation · 120s Horizon</div>
          </div>
          {/* Tab switcher */}
          <div className="flex rounded-lg overflow-hidden border border-zinc-700 ml-2">
            <button
              onClick={() => setActiveTab("LIVE")}
              className={`px-4 py-1.5 text-xs font-semibold tracking-wide transition-colors ${activeTab === "LIVE" ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              ● LIVE
            </button>
            <button
              onClick={() => setActiveTab("BACKTEST")}
              className={`px-4 py-1.5 text-xs font-semibold tracking-wide transition-colors ${activeTab === "BACKTEST" ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              ▶ BACKTEST
            </button>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <div className="text-center">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Price</div>
            <div className="text-xl font-mono font-bold text-white">{fmt2(price)}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Probability</div>
            <div className="text-lg font-mono font-black" style={{ color: probColor }}>{probabilityScore.toFixed(0)}%</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Tier</div>
            <div className="text-sm font-mono font-bold px-2 py-0.5 rounded" style={{ color: probColor, background: `${probColor}22` }}>
              {TIER_LABEL[tier]}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">ATR (M1·14)</div>
            <div className="text-sm font-mono text-zinc-300">{atrRef.current.toFixed(4)}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Vol Regime</div>
            <div className="text-sm font-mono font-bold" style={{ color: volColor }}>{volLabel}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Tick</div>
            <div className="text-sm font-mono text-zinc-400">{tickAgo}s ago</div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: connColor }} />
            <span className="text-xs font-mono uppercase" style={{ color: connColor }}>{conn}</span>
          </div>
        </div>
      </div>

      {activeTab === "BACKTEST" && <BacktestPanel />}

      <div className={`p-5 flex gap-5 ${activeTab === "BACKTEST" ? "hidden" : ""}`}>
        {/* ── Main content ── */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* Row 1: Engine state + Layer scores panel */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <EngineStatePanel
                state={engineState} countdownMs={countdownMs}
                activeSignal={activeSignal} metrics={metrics}
              />
            </div>
            <div className="space-y-1.5">
              <div className="text-xs uppercase tracking-widest text-zinc-500 px-1 mb-2">Layer Score Matrix</div>
              {layerDefs.map((l, i) => (
                <LayerRow
                  key={l.key}
                  index={i + 1}
                  name={l.name}
                  weight={l.weight}
                  score={layerScores[l.key]}
                  description={l.desc}
                  color={l.color}
                />
              ))}
              <div className={`text-center text-xs font-semibold tracking-widest py-2.5 rounded border mt-2 ${isTradeTier ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/20" : "text-zinc-500 bg-zinc-800/40 border-zinc-700/30"}`}
                style={isTradeTier ? { color: probColor, background: `${probColor}12`, borderColor: `${probColor}30` } : {}}>
                {isTradeTier
                  ? `✓ ${TIER_LABEL[tier]} — ${probabilityScore.toFixed(0)}% PROBABILITY`
                  : ready ? `SCANNING — ${probabilityScore.toFixed(0)}% (NEED ≥85%)` : "WARMING UP"}
              </div>
            </div>
          </div>

          {/* Row 2: 5 layer detail cards */}
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
            <CompressionCard score={layerScores.compression} metrics={metrics} />
            <ExpansionCard   score={layerScores.expansion}   metrics={metrics} />
            <StructureCard   score={layerScores.structure} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FlowCard        score={layerScores.flowAlignment} direction={flowDirection} metrics={metrics} />
            <PersistenceCard score={layerScores.persistence}   metrics={metrics} />
          </div>

          {activeSignal && (
            <div className="max-w-md">
              <div className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Active Contract Spec</div>
              <DerivOptionTicket signal={activeSignal} />
            </div>
          )}

          {/* Stats bar */}
          <div className="flex items-center gap-6 border-t border-zinc-800/60 pt-4 flex-wrap">
            <div>
              <div className="text-xs text-zinc-500">Today</div>
              <div className="text-sm font-mono font-semibold">
                <span className="text-emerald-400">{wins}W</span>
                <span className="text-zinc-600 mx-1">/</span>
                <span className="text-rose-400">{losses}L</span>
                {wins + losses > 0 && <span className="text-zinc-400 ml-2">({Math.round((wins / (wins + losses)) * 100)}%)</span>}
              </div>
            </div>
            <div><div className="text-xs text-zinc-500">Executed</div><div className="text-sm font-mono font-semibold text-violet-300">{contracts.length}</div></div>
            <div><div className="text-xs text-zinc-500">State</div><div className="text-sm font-mono font-semibold text-cyan-300">{engineState}</div></div>
            <div><div className="text-xs text-zinc-500">Mode</div><div className={`text-sm font-mono font-semibold ${executionMode === "AUTO" ? "text-emerald-400" : "text-violet-400"}`}>{executionMode}</div></div>
            <div>
              <div className="text-xs text-zinc-500">Auth</div>
              <div className={`text-sm font-mono font-semibold ${authStatus === "connected" ? "text-emerald-400" : authStatus === "connecting" ? "text-amber-400" : "text-zinc-500"}`}>
                {authStatus === "connected" ? "LIVE" : authStatus === "connecting" ? "…" : "OFFLINE"}
              </div>
            </div>
            <div><div className="text-xs text-zinc-500">Ticks</div><div className="text-sm font-mono font-semibold text-zinc-400">{ready ? "READY" : "WARMUP"}</div></div>
          </div>

          <ContractMonitorPanel contracts={contracts} onSell={handleSell} />
        </div>

        {/* ── Sidebar ── */}
        <div className="w-72 shrink-0">
          <AuthPanel
            authStatus={authStatus} authError={authError}
            accounts={accounts} selectedAccountId={selectedAccountId}
            setSelectedAccountId={id => { setSelectedAccountId(id); selectedAccountRef.current = id; }}
            executionMode={executionMode} setExecutionMode={setExecutionMode}
            stakeAmount={stakeAmount} setStakeAmount={setStakeAmount}
            tpLimit={tpLimit} setTpLimit={setTpLimit}
            slLimit={slLimit} setSlLimit={setSlLimit}
            tradeDuration={tradeDuration} setTradeDuration={setTradeDuration}
            tradeDurationUnit={tradeDurationUnit} setTradeDurationUnit={setTradeDurationUnit}
            pendingManualSignal={pendingManualSignal} manualCountdown={manualCountdown}
            onManualExecute={handleManualExecute}
            onManualRise={() => fireDirectionTrade("RISE")}
            onManualFall={() => fireDirectionTrade("FALL")}
            onLogin={handleLogin}
            onLogout={() => { clearSession(); setAuthStatus("not-connected"); setAccounts([]); setSelectedAccountId(""); setAuthError(""); setSessionExpiresAt(null); setDiagLog([]); }}
            execError={execError}
            sessionExpiresAt={sessionExpiresAt}
            diagLog={diagLog}
          />
        </div>
      </div>
    </div>
  );
}
