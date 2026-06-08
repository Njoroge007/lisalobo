import { useEffect, useRef, useState, useCallback } from "react";
import { DerivClient, type ConnState } from "@/lib/v75/deriv";
import {
  initiateLogin, handleOAuthCallback, clearAccessToken, getAccessToken,
  authorizeAndGetAccounts, type DerivAccount,
} from "@/lib/v75/derivAuth";
import { executeTradeViaOTP, type DurationUnit, DURATION_LIMITS } from "@/lib/v75/derivTrade";
import type { Candle, SnapbackSignal, EngineState } from "@/lib/v75/types";
import { computeATR } from "@/lib/v75/indicators";
import { MomentumEngine, type MomentumMetrics } from "@/lib/v75/momentumEngine";
import { saveSignal, updateSignalOutcome, loadSignals, flushQueue } from "@/lib/v75/storage";
import { DerivOptionTicket } from "./DerivOptionTicket";

const engine = new MomentumEngine();
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api`;

const fmt2 = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type ExecMode = "MANUAL" | "AUTO";
type AuthStatus = "not-connected" | "connecting" | "connected" | "error";

interface ContractRecord {
  signalId: string; contractId: number; direction: "RISE" | "FALL";
  signalPrice: number; derivPrice: number; slippage: number; timestamp: number;
}

// ── EMA Trend Display (The River) ─────────────────────────────────────────────
function EMADisplay({ price, ema }: { price: number; ema: number }) {
  const isUp = price > ema;
  const color = isUp ? "#10b981" : "#f43f5e";
  const label = isUp ? "RIVER FLOWING UP ▲" : "RIVER FLOWING DOWN ▼";
  const diff = Math.abs(price - ema);
  
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">Macro Trend</span>
        <span className="text-[10px] text-zinc-500 font-mono">50-tick EMA</span>
      </div>
      <div className="text-3xl font-mono font-bold" style={{ color }}>{ema.toFixed(2)}</div>
      <div className="relative h-4 bg-zinc-800 rounded-full overflow-hidden">
         <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-500" />
         <div className="absolute inset-y-0 rounded-full transition-all duration-300" 
              style={{ 
                left: isUp ? "50%" : `calc(50% - ${Math.min(50, diff * 10)}%)`,
                width: `${Math.min(50, diff * 10)}%`,
                background: color,
                opacity: 0.8
              }} />
      </div>
      <div className="text-xs font-mono font-semibold" style={{ color }}>{label}</div>
    </div>
  );
}

// ── Z-Score Goldilocks Gauge (Recalibrated for 1.0 - 2.2) ───────────────────
function ZGoldilocks({ z }: { z: number }) {
  const clamped = Math.max(-4, Math.min(4, z));
  const pct = ((clamped + 4) / 8) * 100;
  const absZ = Math.abs(z);
  const inGoldilocks = absZ >= 1.0 && absZ <= 2.2;
  const overExtended = absZ > 2.2;
  const dotColor = inGoldilocks ? "#10b981" : overExtended ? "#f43f5e" : "#64748b";
  const label = inGoldilocks ? "MOMENTUM ✓" : overExtended ? "EXHAUSTED" : absZ > 0 ? "BUILDING" : "FLAT";
  
  const gl1S = ((-2.2 + 4) / 8) * 100; const gl1E = ((-1.0 + 4) / 8) * 100;
  const gl2S = ((1.0 + 4) / 8) * 100;  const gl2E = ((2.2 + 4) / 8) * 100;
  
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">Z-Score</span>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color: dotColor, background: `${dotColor}18` }}>{label}</span>
      </div>
      <div className="text-3xl font-mono font-bold" style={{ color: dotColor }}>{z >= 0 ? "+" : ""}{z.toFixed(4)}</div>
      <div className="relative h-4 rounded-full overflow-hidden bg-zinc-800">
        <div className="absolute inset-y-0 rounded-sm" style={{ left: `${gl1S}%`, width: `${gl1E - gl1S}%`, background: "#10b98130", border: "1px solid #10b98150" }} />
        <div className="absolute inset-y-0 rounded-sm" style={{ left: `${gl2S}%`, width: `${gl2E - gl2S}%`, background: "#10b98130", border: "1px solid #10b98150" }} />
        <div className="absolute inset-y-0 w-px bg-zinc-600" style={{ left: "50%" }} />
        <div className="absolute top-1/2 w-3.5 h-3.5 rounded-full -translate-y-1/2 transition-all duration-150 shadow-lg" style={{ left: `calc(${pct}% - 7px)`, background: dotColor }} />
      </div>
      <div className="flex justify-between text-[9px] text-zinc-600 font-mono">
        <span>−4</span><span className="text-emerald-600">−2.2</span><span className="text-emerald-600">−1.0</span><span>0</span><span className="text-emerald-600">+1.0</span><span className="text-emerald-600">+2.2</span><span>+4</span>
      </div>
    </div>
  );
}

// ── Tick Velocity Bar ─────────────────────────────────────────────────────────
function VelocityDisplay({ v }: { v: number }) {
  const threshold = 1.2;
  const met = v >= threshold;
  const color = met ? "#10b981" : v >= threshold * 0.7 ? "#f59e0b" : "#64748b";
  const barPct = Math.min(100, (v / (threshold * 2.5)) * 100);
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">Tick Velocity</span>
        <span className="text-[10px] text-zinc-500">5s window</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-mono font-bold" style={{ color }}>{v.toFixed(2)}×</span>
        <span className="text-xs text-zinc-500">ATR/sec</span>
      </div>
      <div className="relative h-4 bg-zinc-800 rounded-full overflow-hidden">
        <div className="absolute left-0 inset-y-0 rounded-full transition-all duration-200" style={{ width: `${barPct}%`, background: color }} />
        <div className="absolute inset-y-0 w-px bg-emerald-500/70" style={{ left: `${(threshold / (threshold * 2.5)) * 100}%` }} />
      </div>
      <div className="text-[10px] font-mono" style={{ color }}>{met ? `✓ ≥ ${threshold}× (at ${v.toFixed(2)}×)` : `NEED ${threshold}× (at ${v.toFixed(2)}×)`}</div>
    </div>
  );
}

// ── DTI Gauge ─────────────────────────────────────────────────────────────────
function DTIGauge({ dti, zScore }: { dti: number; zScore: number }) {
  const pct = ((dti + 1) / 2) * 100;
  const met = zScore > 0 ? dti >= 0.70 : zScore < 0 ? dti <= -0.70 : false;
  const color = met ? "#10b981" : Math.abs(dti) >= 0.70 ? "#f59e0b" : "#64748b";
  const label = dti >= 0.70 ? "STRONG UP PRESSURE" : dti <= -0.70 ? "STRONG DOWN PRESSURE" : dti >= 0.30 ? "MILD UP PRESSURE" : dti <= -0.30 ? "MILD DOWN PRESSURE" : "BALANCED";
  const negT = ((-0.70 + 1) / 2) * 100; const posT = ((0.70 + 1) / 2) * 100;
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-baseline">
        <span className="text-xs uppercase tracking-widest text-zinc-400">DTI (Tick Imbalance)</span>
        <span className="text-[10px] text-zinc-500 font-mono">15-tick</span>
      </div>
      <div className="text-3xl font-mono font-bold" style={{ color }}>{dti >= 0 ? "+" : ""}{dti.toFixed(4)}</div>
      <div className="relative h-4 bg-zinc-800 rounded-full overflow-hidden">
        <div className="absolute left-0 inset-y-0 opacity-15 rounded-l-full" style={{ width: `${negT}%`, background: "#f43f5e" }} />
        <div className="absolute right-0 inset-y-0 opacity-15 rounded-r-full" style={{ width: `${100 - posT}%`, background: "#10b981" }} />
        <div className="absolute inset-y-0 w-px bg-zinc-600" style={{ left: "50%" }} />
        <div className="absolute inset-y-0 w-px bg-rose-500/60" style={{ left: `${negT}%` }} />
        <div className="absolute inset-y-0 w-px bg-emerald-500/60" style={{ left: `${posT}%` }} />
        <div className="absolute top-1/2 w-3.5 h-3.5 rounded-full -translate-y-1/2 transition-all duration-150 shadow-lg" style={{ left: `calc(${pct}% - 7px)`, background: color }} />
      </div>
      <div className="flex justify-between text-[9px] text-zinc-600 font-mono"><span>−1.0</span><span className="text-rose-600">−0.70</span><span>0</span><span className="text-emerald-600">+0.70</span><span>+1.0</span></div>
      <div className="text-xs font-mono font-semibold" style={{ color }}>{label}</div>
    </div>
  );
}

// ── Engine State Panel ────────────────────────────────────────────────────────
function EngineStatePanel({ state, countdownMs, activeSignal }: { state: EngineState; countdownMs: number; activeSignal: SnapbackSignal | null }) {
  const sec = Math.ceil(countdownMs / 1000);
  const pct = state === "IN_TRADE" ? ((120_000 - countdownMs) / 120_000) * 100 : 0;
  
  if (state === "IN_TRADE" && activeSignal) {
    const isRise = activeSignal.direction === "RISE";
    return (
      <div className="relative overflow-hidden rounded-xl border-2 border-cyan-500/60 bg-zinc-900 p-5 space-y-3">
        <div className="absolute inset-0 bg-cyan-500/5 animate-pulse pointer-events-none" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping absolute" />
            <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 relative" />
            <span className="text-sm font-semibold tracking-widest text-cyan-300 uppercase ml-3">IN TRADE</span>
          </div>
          <span className="text-xs text-zinc-500 font-mono">R_75 · 2-min · MOMENTUM</span>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div className={`text-4xl font-black tracking-tight ${isRise ? "text-emerald-400" : "text-rose-400"}`}>{isRise ? "▲ RISE" : "▼ FALL"}</div>
          <div className="space-y-0.5"><div className="text-[10px] text-zinc-500">Entry</div><div className="text-base font-mono text-white">{fmt2(activeSignal.entryPrice)}</div></div>
          <div className="space-y-0.5"><div className="text-[10px] text-zinc-500">Z @ entry</div><div className="text-sm font-mono text-cyan-300">{activeSignal.zScore >= 0 ? "+" : ""}{activeSignal.zScore.toFixed(2)}σ</div></div>
          <div className="space-y-0.5"><div className="text-[10px] text-zinc-500">DTI</div><div className="text-sm font-mono text-cyan-300">{(activeSignal.dti ?? 0) >= 0 ? "+" : ""}{(activeSignal.dti ?? 0).toFixed(2)}</div></div>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-xs font-mono"><span className="text-zinc-400">Expires in</span><span className="text-cyan-300 font-bold">{sec}s</span></div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${pct}%`, background: sec > 30 ? "#06b6d4" : sec > 10 ? "#f59e0b" : "#f43f5e" }} />
          </div>
        </div>
      </div>
    );
  }
  
  if (state === "RESETTING") {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-zinc-900 p-5 space-y-2">
        <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-amber-400" /><span className="text-sm font-semibold tracking-widest text-amber-300 uppercase">RESETTING</span></div>
        <p className="text-xs text-zinc-400">Flushing tick buffer — resuming in {sec}s</p>
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden"><div className="h-full bg-amber-400 rounded-full transition-all duration-1000" style={{ width: `${Math.max(0, 100 - (countdownMs / 5000) * 100)}%` }} /></div>
      </div>
    );
  }
  
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-zinc-900 p-5 space-y-2">
      <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /><span className="text-sm font-semibold tracking-widest text-emerald-300 uppercase">IDLE</span><span className="ml-auto text-xs text-zinc-500">Scanning for momentum…</span></div>
      <p className="text-xs text-zinc-500">Waiting for: <span className="text-zinc-300">Trend Align</span>{" · "}<span className="text-zinc-300">1.0 ≤ |Z| ≤ 2.2</span>{" · "}<span className="text-zinc-300">Vel ≥ 1.2×</span>{" · "}<span className="text-zinc-300">|DTI| ≥ 0.70</span></p>
    </div>
  );
}

// ── Gate Row ──────────────────────────────────────────────────────────────────
function GateRow({ label, met, value, sub }: { label: string; met: boolean; value: string; sub?: string }) {
  return (
    <div className={`flex justify-between items-center px-3 py-2 rounded text-xs font-mono border ${met ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-300" : "bg-zinc-800/50 border-zinc-700/30 text-zinc-400"}`}>
      <div><div className="font-semibold">{label}</div>{sub && <div className="text-[10px] opacity-70 mt-0.5">{sub}</div>}</div>
      <div className="flex items-center gap-2"><span className={met ? "text-emerald-200 font-bold" : "text-zinc-300"}>{value}</span><span className={`w-2 h-2 rounded-full ${met ? "bg-emerald-400" : "bg-zinc-600"}`} /></div>
    </div>
  );
}

// ── Signal Row ────────────────────────────────────────────────────────────────
function SignalRow({ sig, contract }: { sig: SnapbackSignal; contract?: ContractRecord }) {
  const isRise = sig.direction === "RISE";
  const time = new Date(sig.timestamp).toLocaleTimeString("en-US", { hour12: false });
  return (
    <div className="py-2 border-b border-zinc-800/60 text-xs font-mono space-y-1">
      <div className="flex items-center gap-3">
        <span className={`px-1.5 py-0.5 rounded font-bold ${isRise ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>{isRise ? "▲ RISE" : "▼ FALL"}</span>
        <span className="text-zinc-400">{time}</span>
        <span className="text-zinc-300">{fmt2(sig.entryPrice)}</span>
        <span className="text-zinc-500">Z={sig.zScore >= 0 ? "+" : ""}{sig.zScore.toFixed(2)}</span>
        <span className="text-zinc-500">DTI={(sig.dti ?? 0) >= 0 ? "+" : ""}{(sig.dti ?? 0).toFixed(2)}</span>
        <span className={`ml-auto px-1.5 py-0.5 rounded text-[10px] ${sig.outcome === "WIN" ? "bg-emerald-500/15 text-emerald-400" : sig.outcome === "LOSS" ? "bg-rose-500/15 text-rose-400" : "bg-zinc-700/40 text-zinc-400"}`}>{sig.outcome}</span>
      </div>
      {contract && (
        <div className="flex items-center gap-4 pl-1 text-[10px] text-zinc-500">
          <span className="text-violet-400">#{contract.contractId}</span>
          <span>Signal: {fmt2(contract.signalPrice)}</span>
          <span>Exec: {fmt2(contract.derivPrice)}</span>
          <span className={Math.abs(contract.slippage) > 0.5 ? "text-amber-400" : ""}>
            Slip: {contract.slippage >= 0 ? "+" : ""}{contract.slippage.toFixed(4)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Auth Status Panel ─────────────────────────────────────────────────────────
function AuthPanel({
  authStatus, authError, accounts, selectedAccountId, setSelectedAccountId,
  executionMode, setExecutionMode,
  stakeAmount, setStakeAmount, tpLimit, setTpLimit, slLimit, setSlLimit,
  pendingManualSignal, manualCountdown, onManualExecute, onManualRise, onManualFall, onLogin, onLogout,
  allGates, execError,
}: any) {
  const selectedAccount = accounts.find((a: any) => a.id === selectedAccountId);
  const canManualExecute = pendingManualSignal !== null && manualCountdown > 0 && authStatus === "connected";

  return (
    <div className="space-y-4">
      {/* Auth Status */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Auth Status</div>
        {authStatus === "not-connected" && (
          <>
            <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-zinc-500" /><span className="text-xs font-semibold text-zinc-400">Not Connected</span></div>
            {authError && <p className="text-[10px] text-rose-400">{authError}</p>}
            <button onClick={onLogin} className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg bg-[#ff444f] hover:bg-[#e03040] transition-colors text-white text-sm font-semibold">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
              Login with Deriv
            </button>
          </>
        )}
        {authStatus === "connecting" && (
          <div className="flex items-center gap-2"><div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" /><span className="text-xs font-semibold text-amber-300">Connecting…</span></div>
        )}
        {authStatus === "error" && (
          <>
            <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-rose-500" /><span className="text-xs font-semibold text-rose-400">Error</span></div>
            <p className="text-[10px] text-rose-400">{authError}</p>
            <button onClick={onLogin} className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors">Try Again</button>
          </>
        )}
        {authStatus === "connected" && selectedAccount && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-400" /><span className="text-xs font-semibold text-emerald-300">Connected</span></div>
              <button onClick={onLogout} className="text-[10px] text-zinc-500 hover:text-zinc-300 underline">Logout</button>
            </div>
            {accounts.length > 1 ? (
              <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-violet-500">
                {accounts.map((a: any) => <option key={a.id} value={a.id}>{a.loginId} · {a.type} · {a.currency} {fmt2(a.balance)}</option>)}
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
          <button className={`flex-1 py-2 text-xs font-semibold transition-colors ${executionMode === "MANUAL" ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`} onClick={() => setExecutionMode("MANUAL")}>MANUAL</button>
          <button className={`flex-1 py-2 text-xs font-semibold transition-colors ${executionMode === "AUTO" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`} onClick={() => setExecutionMode("AUTO")}>AUTO</button>
        </div>
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
              <input type="number" min="1" step="1" value={val} onChange={e => set(Math.max(1, Number(e.target.value)))}
                className="mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-violet-500" />
            </label>
          ))}
          
          {/* Protected Duration Input */}
          <div>
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Duration (Protected)</span>
            <div className="mt-1 flex gap-1.5">
              <input type="number" value={2} readOnly className="w-20 bg-zinc-800 border border-zinc-700/50 rounded px-3 py-1.5 text-sm font-mono text-emerald-500/70 focus:outline-none cursor-not-allowed" />
              <select value="m" disabled className="flex-1 bg-zinc-800 border border-zinc-700/50 rounded px-2 py-1.5 text-sm text-emerald-500/70 focus:outline-none cursor-not-allowed">
                <option value="m">minutes</option>
              </select>
            </div>
            <p className="text-[10px] text-zinc-600 mt-0.5">Locked to 2m for Momentum Strategy</p>
          </div>
        </div>
      </div>

      {/* Manual Controls */}
      {executionMode === "MANUAL" && (
        <div className="space-y-2">
          {canManualExecute && pendingManualSignal && (
            <div className="bg-violet-900/30 border border-violet-500/40 rounded-lg px-3 py-2 text-xs font-mono space-y-1 animate-pulse">
              <div className="text-violet-300 font-semibold">⚡ Signal Ready ({manualCountdown}s)</div>
              <div className="text-zinc-300">{pendingManualSignal.direction === "RISE" ? "▲ RISE" : "▼ FALL"} @ {fmt2(pendingManualSignal.entryPrice)}</div>
              <button onClick={onManualExecute} className="mt-1 w-full py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold transition-colors">Execute Signal Direction</button>
            </div>
          )}
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Manual Trade</div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={onManualRise} disabled={authStatus !== "connected"} className={`py-3 rounded-xl text-sm font-bold tracking-wide transition-all ${authStatus === "connected" ? "bg-emerald-600 hover:bg-emerald-500 text-white" : "bg-zinc-800 text-zinc-600 cursor-not-allowed"}`}>▲ RISE</button>
            <button onClick={onManualFall} disabled={authStatus !== "connected"} className={`py-3 rounded-xl text-sm font-bold tracking-wide transition-all ${authStatus === "connected" ? "bg-rose-600 hover:bg-rose-500 text-white" : "bg-zinc-800 text-zinc-600 cursor-not-allowed"}`}>▼ FALL</button>
          </div>
          {execError && <p className="text-[10px] text-rose-400 text-center">{execError}</p>}
        </div>
      )}

      {/* Auto Controls */}
      {executionMode === "AUTO" && (
        <div className={`rounded-xl border p-4 text-xs text-center space-y-1 ${authStatus === "connected" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400" : "border-zinc-700 bg-zinc-800/50 text-zinc-500"}`}>
          {authStatus === "connected" ? <><div>⚡ Auto-fire active</div><div className="text-emerald-600">${stakeAmount} stake · 2 minutes</div></> : <div>Connect your Deriv account to execute trades.</div>}
          {execError && <p className="text-rose-400 mt-1">{execError}</p>}
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export function V75Analyzer() {
  const [conn, setConn] = useState<ConnState>("connecting");
  const [price, setPrice] = useState(0);
  const [lastTickMs, setLastTickMs] = useState(Date.now());
  const [engineState, setEngineState] = useState<EngineState>("IDLE");
  const [countdownMs, setCountdownMs] = useState(0);
  const [metrics, setMetrics] = useState<MomentumMetrics>(engine.getMetrics());
  const [signals, setSignals] = useState<SnapbackSignal[]>([]);
  const [contracts, setContracts] = useState<ContractRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Auth
  const [authStatus, setAuthStatus] = useState<AuthStatus>("not-connected");
  const [authError, setAuthError] = useState("");
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");

  // Execution
  const [executionMode, setExecutionMode] = useState<ExecMode>("MANUAL");
  const [stakeAmount, setStakeAmount] = useState(10);
  const [tpLimit, setTpLimit] = useState(100);
  const [slLimit, setSlLimit] = useState(50);
  const [pendingManualSignal, setPendingManualSignal] = useState<SnapbackSignal | null>(null);
  const [manualCountdown, setManualCountdown] = useState(0);
  const [execError, setExecError] = useState("");

  const atrRef = useRef(0);
  const priceRef = useRef(0);
  const executionModeRef = useRef<ExecMode>("MANUAL");
  const stakeRef = useRef(10);
  const selectedAccountRef = useRef("");
  const pendingManualRef = useRef<SnapbackSignal | null>(null);

  useEffect(() => { executionModeRef.current = executionMode; }, [executionMode]);
  useEffect(() => { stakeRef.current = stakeAmount; }, [stakeAmount]);
  useEffect(() => { selectedAccountRef.current = selectedAccountId; }, [selectedAccountId]);
  useEffect(() => { pendingManualRef.current = pendingManualSignal; }, [pendingManualSignal]);

  // OAuth on mount
  useEffect(() => {
    (async () => {
      const result = await handleOAuthCallback(API);
      if (result.status === "none") return;
      if (result.status === "error") { setAuthStatus("not-connected"); setAuthError(result.message); return; }
      if (result.status === "connected") {
        setAuthStatus("connecting");
        try {
          const token = getAccessToken()!;
          const data = await authorizeAndGetAccounts(token, API);
          setAccounts(data);
          setSelectedAccountId(data[0]?.id ?? "");
          selectedAccountRef.current = data[0]?.id ?? "";
          setAuthStatus("connected");
        } catch (e: any) {
          setAuthStatus("not-connected"); setAuthError(e?.message ?? "Failed to load accounts");
        }
      }
    })();
  }, []);

  // Manual countdown
  useEffect(() => {
    if (!pendingManualSignal) return;
    const start = Date.now();
    setManualCountdown(10);
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

  // Reconstructed load signals block
  useEffect(() => {
    loadSignals().then(loaded => {
      setSignals(loaded);
      setLoading(false);
    }).catch(err => {
      console.error(err);
      setLoading(false);
    });
  }, []);

  const fireTrade = useCallback(async (sig: SnapbackSignal) => {
    const acctId = selectedAccountRef.current;
    const stake = stakeRef.current;
    
    // HARDCODED TO PROTECTED 2-MINUTE WINDOW
    const dur = 2;
    const durUnit = "m";
    
    if (!acctId || !getAccessToken()) {
      setExecError("Connect your Deriv account to execute trades.");
      return;
    }
    setExecError("");
    try {
      const contractType = sig.direction === "RISE" ? "CALL" : "PUT";
      const result = await executeTradeViaOTP(API, acctId, contractType, stake, dur, durUnit);
      setContracts(prev => [{
        signalId: sig.id, contractId: result.contractId, direction: sig.direction,
        signalPrice: sig.entryPrice, derivPrice: result.buyPrice,
        slippage: result.buyPrice - sig.entryPrice, timestamp: Date.now(),
      }, ...prev].slice(0, 50));
    } catch (e: any) {
      setExecError(e?.message ?? "Trade execution failed");
    }
  }, []);

  const handleManualExecute = useCallback(() => {
    const sig = pendingManualRef.current;
    if (!sig || manualCountdown <= 0) return;
    setPendingManualSignal(null); setManualCountdown(0);
    fireTrade(sig);
  }, [fireTrade, manualCountdown]);

  const fireDirectionTrade = useCallback(async (direction: "RISE" | "FALL") => {
    const acctId = selectedAccountRef.current;
    const stake = stakeRef.current;
    const dur = 2; const durUnit = "m"; // HARDCODED
    
    if (!acctId || !getAccessToken()) { setExecError("Connect your Deriv account to execute trades."); return; }
    setExecError("");
    try {
      const contractType = direction === "RISE" ? "CALL" : "PUT";
      const result = await executeTradeViaOTP(API, acctId, contractType, stake, dur, durUnit);
      const p = priceRef.current;
      setContracts(prev => [{
        signalId: `manual-${Date.now()}`, contractId: result.contractId, direction,
        signalPrice: p, derivPrice: result.buyPrice,
        slippage: result.buyPrice - p, timestamp: Date.now(),
      }, ...prev].slice(0, 50));
    } catch (e: any) {
      setExecError(e?.message ?? "Trade execution failed");
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
        if (s.id !== sig.id) return s;
        const won = (s.direction === "RISE" && tickPrice >= entryPrice) || (s.direction === "FALL" && tickPrice <= entryPrice);
        const outcome: "WIN" | "LOSS" = won ? "WIN" : "LOSS";
        updateSignalOutcome(s.id, outcome, tickPrice);
        return { ...s, outcome, exitPrice: tickPrice };
      }));
    }, 120_000); // 2-min resolve
  }, [fireTrade]);

  const handleM1 = useCallback((candles: Candle[]) => {
    if (candles.length >= 14) atrRef.current = computeATR(candles, 14);
  }, []);

  useEffect(() => {
    const client = new DerivClient({ onTick: handleTick, onM1: handleM1, onM5: () => {}, onM15: () => {}, onState: setConn });
    client.start();
    return () => client.stop();
  }, [handleTick, handleM1]);

  // Derived Gate Logic
  const ema = (metrics as any).ema ?? price; // Fallback syncs perfectly with your engine
  const zScore = metrics.zScore ?? 0;
  const tickVelocity = metrics.tickVelocity ?? 0;
  const dti = metrics.dti ?? 0;
  const ready = metrics.ready ?? false;

  const gateTrend = zScore > 0 ? price > ema : zScore < 0 ? price < ema : false;
  const gateZ = Math.abs(zScore) >= 1.0 && Math.abs(zScore) <= 2.2;
  const gateV = tickVelocity >= 1.2;
  const gateDTI = zScore > 0 ? dti >= 0.70 : zScore < 0 ? dti <= -0.70 : false;
  const allGates = gateTrend && gateZ && gateV && gateDTI;

  const activeSignal = signals[0]?.outcome === "PENDING" && Date.now() - signals[0].timestamp < 120_000 ? signals[0] : null;
  const tickAgo = ((Date.now() - lastTickMs) / 1000).toFixed(1);
  const connColor = conn === "open" ? "#06b6d4" : conn === "connecting" ? "#f59e0b" : "#f43f5e";

  const todaySigs = signals.filter(s => new Date(s.timestamp).toDateString() === new Date().toDateString());
  const wins = todaySigs.filter(s => s.outcome === "WIN").length;
  const losses = todaySigs.filter(s => s.outcome === "LOSS").length;

  return (
    <div className="min-h-screen bg-[#090912] text-white font-sans">
      <div className="border-b border-zinc-800/80 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-1.5 h-8 rounded-full bg-violet-500" />
          <div>
            <div className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">Momentum Breakout · Command Center</div>
            <div className="text-[10px] text-zinc-600">V75 · Trend-Following · 2-min Rise/Fall</div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-center"><div className="text-[10px] text-zinc-500 uppercase tracking-wider">Price</div><div className="text-xl font-mono font-bold text-white">{fmt2(price)}</div></div>
          <div className="text-center"><div className="text-[10px] text-zinc-500 uppercase tracking-wider">ATR (M1·14)</div><div className="text-sm font-mono text-zinc-300">{atrRef.current.toFixed(4)}</div></div>
          <div className="text-center"><div className="text-[10px] text-zinc-500 uppercase tracking-wider">Tick</div><div className="text-sm font-mono text-zinc-400">{tickAgo}s ago</div></div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: connColor }} />
            <span className="text-xs font-mono uppercase" style={{ color: connColor }}>{conn}</span>
          </div>
        </div>
      </div>

      <div className="p-5 flex gap-5">
        <div className="flex-1 min-w-0 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <EngineStatePanel state={engineState} countdownMs={countdownMs} activeSignal={activeSignal} />
            </div>
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-widest text-zinc-500 px-1">Gates Check</div>
              <GateRow label="Gate 1 — The River" sub="Macro Trend Alignment" met={gateTrend} value={price > ema ? "FLOW UP" : "FLOW DOWN"} />
              <GateRow label="Gate 2 — Goldilocks" sub="1.0 ≤ |Z| ≤ 2.2" met={gateZ} value={`Z=${zScore >= 0 ? "+" : ""}${zScore.toFixed(2)}`} />
              <GateRow label="Gate 3 — Fuel" sub="Tick Velocity ≥ 1.2×" met={gateV} value={`${tickVelocity.toFixed(2)}×`} />
              <GateRow label="Gate 4 — DTI Pressure" sub={zScore > 0 ? "Need DTI ≥ +0.70" : zScore < 0 ? "Need DTI ≤ −0.70" : "Need directional Z first"} met={gateDTI} value={`DTI=${dti >= 0 ? "+" : ""}${dti.toFixed(2)}`} />
              <div className={`text-center text-xs font-semibold tracking-widest py-2 rounded border ${allGates ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/20" : "text-zinc-500 bg-zinc-800/40 border-zinc-700/30"}`}>
                {allGates ? "✓ ALL GATES OPEN" : ready ? "SCANNING…" : "WARMING UP"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5"><EMADisplay price={price} ema={ema} /></div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 md:col-span-1 xl:col-span-2"><ZGoldilocks z={zScore} /></div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5"><VelocityDisplay v={tickVelocity} /></div>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5"><DTIGauge dti={dti} zScore={zScore} /></div>

          {activeSignal && (
            <div className="max-w-md">
              <div className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Active Contract Spec</div>
              <DerivOptionTicket signal={activeSignal} />
            </div>
          )}

          <div className="flex items-center gap-6 border-t border-zinc-800/60 pt-4 flex-wrap">
            <div><div className="text-xs text-zinc-500">Today</div>
              <div className="text-sm font-mono font-semibold">
                <span className="text-emerald-400">{wins}W</span><span className="text-zinc-600 mx-1">/</span><span className="text-rose-400">{losses}L</span>
                {wins + losses > 0 && <span className="text-zinc-400 ml-2">({Math.round((wins / (wins + losses)) * 100)}%)</span>}
              </div>
            </div>
            <div><div className="text-xs text-zinc-500">Executed</div><div className="text-sm font-mono font-semibold text-violet-300">{contracts.length}</div></div>
            <div><div className="text-xs text-zinc-500">State</div><div className="text-sm font-mono font-semibold text-cyan-300">{engineState}</div></div>
            <div><div className="text-xs text-zinc-500">Mode</div><div className={`text-sm font-mono font-semibold ${executionMode === "AUTO" ? "text-emerald-400" : "text-violet-400"}`}>{executionMode}</div></div>
            <div><div className="text-xs text-zinc-500">Auth</div>
              <div className={`text-sm font-mono font-semibold ${authStatus === "connected" ? "text-emerald-400" : authStatus === "connecting" ? "text-amber-400" : "text-zinc-500"}`}>
                {authStatus === "connected" ? "LIVE" : authStatus === "connecting" ? "…" : "OFFLINE"}
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs uppercase tracking-widest text-zinc-400">Signal History</span>
              <span className="text-[10px] text-zinc-600 font-mono">{signals.length} signals · {contracts.length} executed</span>
            </div>
            {loading ? <div className="text-xs text-zinc-500 text-center py-6">Loading…</div>
              : signals.length === 0 ? <div className="text-xs text-zinc-600 text-center py-6">No signals yet. All 4 gates must open simultaneously.</div>
              : <div className="overflow-y-auto max-h-64">{signals.slice(0, 30).map(sig => <SignalRow key={sig.id} sig={sig} contract={contracts.find(c => c.signalId === sig.id)} />)}</div>}
          </div>
        </div>

        <div className="w-72 shrink-0">
          <AuthPanel
            authStatus={authStatus} authError={authError}
            accounts={accounts} selectedAccountId={selectedAccountId} setSelectedAccountId={(id: string) => { setSelectedAccountId(id); selectedAccountRef.current = id; }}
            executionMode={executionMode} setExecutionMode={setExecutionMode}
            stakeAmount={stakeAmount} setStakeAmount={setStakeAmount}
            tpLimit={tpLimit} setTpLimit={setTpLimit} slLimit={slLimit} setSlLimit={setSlLimit}
            pendingManualSignal={pendingManualSignal} manualCountdown={manualCountdown}
            onManualExecute={handleManualExecute} onManualRise={() => fireDirectionTrade("RISE")} onManualFall={() => fireDirectionTrade("FALL")}
            onLogin={initiateLogin} onLogout={() => { clearAccessToken(); setAuthStatus("not-connected"); setAccounts([]); setSelectedAccountId(""); setAuthError(""); }}
            allGates={allGates} execError={execError}
          />
        </div>
      </div>
    </div>
  );
}
