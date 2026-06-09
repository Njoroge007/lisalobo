import MomentumEngine from "./momentumEngine";
import type { SignalTier, LayerScores } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BtTick {
  price: number;
  ms: number;
}

export interface BacktestSignal {
  id: string;
  timestamp: number;
  direction: "RISE" | "FALL";
  entryPrice: number;
  probabilityScore: number;
  tier: SignalTier;
  layerScores: LayerScores;
  outcome?: "WIN" | "LOSS";
  exitPrice?: number;
}

export interface LayerHistoryEntry {
  ms: number;
  layerScores: LayerScores;
  probabilityScore: number;
}

export interface TierStat {
  wins: number;
  losses: number;
  pending: number;
  count: number;
}

export type TierStats = Record<SignalTier, TierStat>;

export interface BacktestResult {
  signals: BacktestSignal[];
  layerHistory: LayerHistoryEntry[];
  tierStats: TierStats;
  durationMs: number;
  tickCount: number;
  startMs: number;
  endMs: number;
}

const EMPTY_TIER_STATS = (): TierStats => ({
  REJECT:    { wins: 0, losses: 0, pending: 0, count: 0 },
  WATCH:     { wins: 0, losses: 0, pending: 0, count: 0 },
  CANDIDATE: { wins: 0, losses: 0, pending: 0, count: 0 },
  TRADE:     { wins: 0, losses: 0, pending: 0, count: 0 },
  PREMIUM:   { wins: 0, losses: 0, pending: 0, count: 0 },
});

// ── Fetch historical ticks from Deriv ─────────────────────────────────────────

const DERIV_WS = "wss://ws.derivws.com/websockets/v3?app_id=1";

export const fetchDerivTicks = (count: number): Promise<BtTick[]> =>
  new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    const timeout = setTimeout(() => {
      ws?.close();
      reject(new Error("Timeout — Deriv API did not respond within 20s"));
    }, 20_000);

    try {
      ws = new WebSocket(DERIV_WS);
    } catch {
      clearTimeout(timeout);
      reject(new Error("Failed to open WebSocket"));
      return;
    }

    ws.onopen = () => {
      ws!.send(JSON.stringify({
        ticks_history: "R_75",
        count,
        end: "latest",
        style: "ticks",
        req_id: 99,
      }));
    };

    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data as string);
        if (d.error) {
          clearTimeout(timeout);
          ws?.close();
          reject(new Error(d.error.message ?? "Deriv API error"));
          return;
        }
        if (d.req_id === 99 && d.history) {
          clearTimeout(timeout);
          ws?.close();
          const times:  number[] = d.history.times  ?? [];
          const prices: number[] = d.history.prices ?? [];
          resolve(
            times.map((t, i) => ({ price: Number(prices[i]), ms: t * 1000 })),
          );
        }
      } catch {
        /* ignore parse errors */
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      ws?.close();
      reject(new Error("WebSocket error while fetching tick history"));
    };
  });

// ── Bucket utility (10 buckets: 0-10, 10-20, …, 90-100) ──────────────────────

export const bucketsOf = (values: number[]): number[] => {
  const b = new Array<number>(10).fill(0);
  for (const v of values) b[Math.min(9, Math.floor(v / 10))]++;
  return b;
};

// ── Rolling tick-level ATR estimate ───────────────────────────────────────────

const rollingTickAtr = (prices: number[], window = 100): number => {
  const w = prices.slice(-window);
  if (w.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < w.length; i++) sum += Math.abs(w[i] - w[i - 1]);
  // multiply by 60 to approximate M1 ATR from per-tick moves
  return (sum / (w.length - 1)) * 60;
};

// ── Core backtest runner ───────────────────────────────────────────────────────

export const runBacktest = (
  ticks: BtTick[],
  onProgress?: (pct: number) => void,
): BacktestResult => {
  if (ticks.length < 10) {
    return {
      signals: [], layerHistory: [], tierStats: EMPTY_TIER_STATS(),
      durationMs: 0, tickCount: 0, startMs: 0, endMs: 0,
    };
  }

  const eng      = new MomentumEngine();
  const signals: BacktestSignal[]     = [];
  const layerHistory: LayerHistoryEntry[] = [];
  const prices: number[] = [];

  const total      = ticks.length;
  const startMs    = ticks[0].ms;
  const endMs      = ticks[total - 1].ms;
  const sampleRate = Math.max(1, Math.floor(total / 600)); // ≤600 history points

  for (let i = 0; i < total; i++) {
    const t = ticks[i];
    prices.push(t.price);

    const atr = rollingTickAtr(prices);
    const sig = eng.processTick(t.price, t.ms, atr);
    const m   = eng.getMetrics();

    if (i % sampleRate === 0) {
      layerHistory.push({
        ms: t.ms,
        layerScores: { ...m.layerScores },
        probabilityScore: m.probabilityScore,
      });
    }

    if (sig) {
      signals.push({
        id:              sig.id,
        timestamp:       sig.timestamp,
        direction:       sig.direction,
        entryPrice:      sig.entryPrice,
        probabilityScore: sig.probabilityScore,
        tier:            sig.tier,
        layerScores:     { ...sig.layerScores },
      });
    }

    if (onProgress && i % 250 === 0) onProgress(Math.round((i / total) * 90));
  }

  onProgress?.(92);

  // ── Determine outcomes: first tick at or after entry + 120s ──────────────

  for (const sig of signals) {
    const exitMs   = sig.timestamp + 120_000;
    const exitTick = ticks.find(t => t.ms >= exitMs);
    if (exitTick) {
      const won =
        (sig.direction === "RISE" && exitTick.price >= sig.entryPrice) ||
        (sig.direction === "FALL" && exitTick.price <= sig.entryPrice);
      sig.outcome   = won ? "WIN" : "LOSS";
      sig.exitPrice = exitTick.price;
    }
  }

  // ── Tier stats ─────────────────────────────────────────────────────────────

  const tierStats = EMPTY_TIER_STATS();
  for (const sig of signals) {
    const ts = tierStats[sig.tier];
    ts.count++;
    if      (sig.outcome === "WIN")  ts.wins++;
    else if (sig.outcome === "LOSS") ts.losses++;
    else                             ts.pending++;
  }

  onProgress?.(100);

  return { signals, layerHistory, tierStats, durationMs: endMs - startMs, tickCount: total, startMs, endMs };
};
