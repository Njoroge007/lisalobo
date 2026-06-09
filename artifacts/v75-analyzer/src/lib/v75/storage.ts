import type { SnapbackSignal } from "./types";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api`;

const QUEUE_KEY = "v75_sb_queue";

type QueueItem =
  | { kind: "signal"; payload: SnapbackSignal }
  | { kind: "outcome"; payload: { id: string; outcome: "WIN" | "LOSS"; exitPrice: number } };

const readQueue = (): QueueItem[] => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
};
const writeQueue = (q: QueueItem[]) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
const enqueue = (item: QueueItem) => writeQueue([...readQueue(), item]);

const signalToRow = (s: SnapbackSignal) => ({
  id: s.id,
  timestamp: s.timestamp,
  direction: s.direction,
  strength: "Strong",
  confidence: Math.round(Math.min(100, Math.abs(s.zScore) * 20)),
  score: Math.round(s.zScore * 100),
  adjusted_score: Math.round(s.hurstExponent * 10000),
  duration_minutes: 2,
  entry_price: s.entryPrice,
  outcome: "PENDING",
  choch_present: false,
  sweep_present: false,
  ob_timeframe: "NONE",
  h4_bias: "NEUTRAL",
  h1_bias: "NEUTRAL",
  pattern_match_rate: Number(s.tickVelocity.toFixed(4)),
});

export const saveSignal = async (s: SnapbackSignal) => {
  try {
    const res = await fetch(`${API}/signals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signalToRow(s)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    enqueue({ kind: "signal", payload: s });
  }
};

export const updateSignalOutcome = async (id: string, outcome: "WIN" | "LOSS", exitPrice: number) => {
  try {
    const res = await fetch(`${API}/signals/${id}/outcome`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome, exit_price: exitPrice }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    enqueue({ kind: "outcome", payload: { id, outcome, exitPrice } });
  }
};

export const loadSignals = async (limit = 50): Promise<SnapbackSignal[]> => {
  try {
    const res = await fetch(`${API}/signals?limit=${limit}`);
    if (!res.ok) return [];
    const data: any[] = await res.json();
    return data.map((r): SnapbackSignal => ({
      id: r.id,
      timestamp: Number(r.timestamp),
      direction: r.direction as "RISE" | "FALL",
      entryPrice: Number(r.entry_price) || 0,
      zScore: (Number(r.score) || 0) / 100,
      hurstExponent: (Number(r.adjusted_score) || 5000) / 10000,
      tickVelocity: Number(r.pattern_match_rate) || 0,
      dti: 0,
      strength: 0,
      hurstRegime: "RANDOM",
      thresholds: { hurst: 0.55, zMin: 1.5, zMax: 2.5, velocity: 1.2, dti: 0.70 },
      outcome: (r.outcome as "WIN" | "LOSS" | "PENDING") || "PENDING",
      exitPrice: r.exit_price != null ? Number(r.exit_price) : undefined,
    }));
  } catch { return []; }
};

export const flushQueue = async () => {
  const q = readQueue();
  if (!q.length) return;
  const remain: QueueItem[] = [];
  for (const it of q) {
    try {
      if (it.kind === "signal") {
        const res = await fetch(`${API}/signals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signalToRow(it.payload)),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        const res = await fetch(`${API}/signals/${it.payload.id}/outcome`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome: it.payload.outcome, exit_price: it.payload.exitPrice }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      remain.push(it);
    }
  }
  writeQueue(remain);
};
