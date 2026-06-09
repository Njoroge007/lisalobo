import type { Candle, Tick } from "./types";

// ── Utilities ─────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rangeOf = (prices: number[]): number =>
  prices.length < 2 ? 0 : Math.max(...prices) - Math.min(...prices);
const tickAtrLocal = (prices: number[], n: number): number => {
  const w = prices.slice(-n);
  if (w.length < 2) return 0;
  const s = w.slice(1).reduce((a, v, i) => a + Math.abs(v - w[i]), 0);
  return s / (w.length - 1);
};

// ── Standard chart indicators ──────────────────────────────────────────────────

export const sma = (vals: number[], p: number): number[] => {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= p) sum -= vals[i - p];
    out.push(i >= p - 1 ? sum / p : NaN);
  }
  return out;
};

export const stdev = (vals: number[], p: number): number[] => {
  const m = sma(vals, p);
  const out: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    if (i < p - 1) { out.push(NaN); continue; }
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (vals[j] - m[i]) ** 2;
    out.push(Math.sqrt(s / p));
  }
  return out;
};

export const atr = (candles: Candle[], p = 14): number[] => {
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { trs.push(candles[i].high - candles[i].low); continue; }
    const c = candles[i], pc = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  const out: number[] = new Array(candles.length).fill(NaN);
  if (trs.length < p) return out;
  let a = 0;
  for (let i = 0; i < p; i++) a += trs[i];
  a /= p;
  out[p - 1] = a;
  for (let i = p; i < trs.length; i++) { a = (a * (p - 1) + trs[i]) / p; out[i] = a; }
  return out;
};

export const computeATR = (candles: Candle[], p = 14): number => {
  const arr = atr(candles, p);
  return arr[arr.length - 1] ?? 0;
};

export const computeZScore = (prices: number[], period = 10): number => {
  if (prices.length < period) return 0;
  const window = prices.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (prices[prices.length - 1] - mean) / sd;
};

export const computeZScoreComponents = (
  prices: number[],
  period = 10,
): { zScore: number; sma: number; sd: number } => {
  if (prices.length < period) return { zScore: 0, sma: prices[prices.length - 1] ?? 0, sd: 0 };
  const window = prices.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  if (sd === 0) return { zScore: 0, sma: mean, sd: 0 };
  return { zScore: (prices[prices.length - 1] - mean) / sd, sma: mean, sd };
};

export const computeTickVelocity = (
  ticks: Tick[],
  windowMs: number,
  currentAtr: number,
): number => {
  if (ticks.length < 2 || currentAtr <= 0) return 0;
  const now = ticks[ticks.length - 1].ms;
  const recent = ticks.filter((t) => t.ms >= now - windowMs);
  if (recent.length < 2) return 0;
  let totalMove = 0;
  for (let i = 1; i < recent.length; i++) totalMove += Math.abs(recent[i].price - recent[i - 1].price);
  const atrPerSec = currentAtr / 60;
  if (atrPerSec <= 0) return 0;
  return totalMove / (windowMs / 1000) / atrPerSec;
};

export const computeTickImbalance = (prices: number[], period = 15): number => {
  const window = prices.slice(-period);
  if (window.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < window.length; i++) {
    const d = window[i] - window[i - 1];
    if (d > 0) sum += 1;
    else if (d < 0) sum -= 1;
  }
  return sum / (window.length - 1);
};

export const computeHurst = (prices: number[], n = 30): number => {
  const window = prices.slice(-n);
  if (window.length < 8) return 0.5;
  const diffs = window.slice(1).map((v, i) => v - window[i]);
  const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const adjusted = diffs.map((d) => d - m);
  let cum = 0;
  const cumulative: number[] = [];
  for (const d of adjusted) { cum += d; cumulative.push(cum); }
  const R = Math.max(...cumulative) - Math.min(...cumulative);
  const variance = diffs.reduce((s, v) => s + (v - m) ** 2, 0) / diffs.length;
  const S = Math.sqrt(variance);
  if (S === 0 || R === 0) return 0.5;
  return Math.max(0, Math.min(1, Math.log(R / S) / Math.log(diffs.length)));
};

// ── Layer 1: Compression Engine ───────────────────────────────────────────────

export const computeCompressionLayer = (
  prices: number[],
): { rcr: number; vcr: number; score: number } => {
  if (prices.length < 50) return { rcr: 1, vcr: 1, score: 0 };

  const currentRange = rangeOf(prices.slice(-50));
  const hist200 = prices.slice(-200);
  const segments = [
    hist200.slice(0, 50), hist200.slice(50, 100),
    hist200.slice(100, 150), hist200.slice(150, 200),
  ].filter(s => s.length === 50);
  const avgRange = segments.length
    ? segments.reduce((a, s) => a + rangeOf(s), 0) / segments.length
    : currentRange;

  const rcr = avgRange > 0 ? currentRange / avgRange : 1;

  const shortAtr = tickAtrLocal(prices, 10);
  const longAtr  = tickAtrLocal(prices, 100);
  const vcr = longAtr > 0 ? shortAtr / longAtr : 1;

  const rcrScore = clamp((2 - rcr) / 2 * 100, 0, 100);
  const vcrScore = clamp((2 - vcr) / 2 * 100, 0, 100);
  const score = clamp(rcrScore * 0.6 + vcrScore * 0.4, 0, 100);

  return { rcr, vcr, score };
};

// ── Layer 2: Expansion Detection Engine ──────────────────────────────────────

export const computeExpansionLayer = (
  prices: number[],
  ticks: Tick[],
  atrVal: number,
): { der: number; vbr: number; score: number } => {
  if (prices.length < 20) return { der: 0, vbr: 0, score: 0 };

  const window30 = prices.slice(-30);
  const netMove = Math.abs(window30[window30.length - 1] - window30[0]);
  let totalMove = 0;
  for (let i = 1; i < window30.length; i++) totalMove += Math.abs(window30[i] - window30[i - 1]);
  const der = totalMove > 0 ? netMove / totalMove : 0;

  const now = ticks.length > 0 ? ticks[ticks.length - 1].ms : Date.now();
  const recent2  = ticks.filter(t => t.ms >= now - 2_000);
  const recent20 = ticks.filter(t => t.ms >= now - 20_000);
  const atrPerSec = atrVal > 0 ? atrVal / 60 : 0.001;

  const velOf = (ts: Tick[], secs: number): number => {
    if (ts.length < 2) return 0;
    let m = 0;
    for (let i = 1; i < ts.length; i++) m += Math.abs(ts[i].price - ts[i - 1].price);
    return m / secs / atrPerSec;
  };

  const curVel  = velOf(recent2, 2);
  const baseVel = velOf(recent20, 20);
  const vbr = baseVel > 0 ? curVel / baseVel : (curVel > 0 ? 1 : 0);

  const derScore = der * 100;
  const vbrScore = clamp(vbr * 50, 0, 100);
  const score = clamp(derScore * 0.5 + vbrScore * 0.5, 0, 100);

  return { der, vbr, score };
};

// ── Layer 3: Structure Persistence ───────────────────────────────────────────

export const computeStructureLayer = (
  prices: number[],
  windows: number[] = [20, 50, 100],
): { bullPoints: number; bearPoints: number; score: number; bias: "BULL" | "BEAR" | "NEUTRAL" } => {
  let bullPts = 0, bearPts = 0;

  for (const w of windows) {
    if (prices.length < w) continue;
    const seg   = prices.slice(-w);
    const half  = Math.floor(w / 2);
    const first  = seg.slice(0, half);
    const second = seg.slice(half);

    const fHigh = Math.max(...first), fLow  = Math.min(...first);
    const sHigh = Math.max(...second), sLow = Math.min(...second);

    if (sHigh > fHigh) bullPts += 2; else if (sHigh < fHigh) bearPts += 1;
    if (sLow  > fLow)  bullPts += 1; else if (sLow  < fLow)  bearPts += 2;
  }

  const total = bullPts + bearPts;
  const net   = total > 0 ? (bullPts - bearPts) / total : 0;
  const score = clamp(50 + net * 50, 0, 100);
  const bias: "BULL" | "BEAR" | "NEUTRAL" = score >= 62 ? "BULL" : score <= 38 ? "BEAR" : "NEUTRAL";

  return { bullPoints: bullPts, bearPoints: bearPts, score, bias };
};

// ── Layer 4: Multi-Horizon Flow Alignment ─────────────────────────────────────

export const computeFlowAlignmentLayer = (
  prices: number[],
  windows: number[] = [20, 50, 100, 200],
): { dtis: number[]; score: number; direction: "RISE" | "FALL" | "NEUTRAL" } => {
  const dtis = windows.map(w => computeTickImbalance(prices, w));

  const posCount = dtis.filter(d => d > 0).length;
  const negCount = dtis.filter(d => d < 0).length;

  let direction: "RISE" | "FALL" | "NEUTRAL";
  if (posCount >= 3)      direction = "RISE";
  else if (negCount >= 3) direction = "FALL";
  else                    direction = "NEUTRAL";

  if (direction === "NEUTRAL") return { dtis, score: 20, direction };

  const sign = direction === "RISE" ? 1 : -1;
  let score = 0;

  for (const dti of dtis) {
    const signedMag = dti * sign;
    if (signedMag >= 0.65) {
      score += 20 + clamp((signedMag - 0.65) / 0.35 * 5, 0, 5);
    } else if (signedMag > 0) {
      score += (signedMag / 0.65) * 20;
    } else {
      score -= clamp(Math.abs(signedMag) * 15, 0, 10);
    }
  }

  return { dtis, score: clamp(score, 0, 100), direction };
};

// ── Layer 5: Momentum Persistence Predictor ───────────────────────────────────

export interface VelSample { v: number; ms: number }

export const computePersistenceLayer = (
  velocityHistory: VelSample[],
  _currentVelocity: number,
): { slope: number; score: number } => {
  if (velocityHistory.length < 3) return { slope: 0, score: 50 };

  const n    = velocityHistory.length;
  const tMin = velocityHistory[0].ms;
  const tNorm = velocityHistory.map(s => (s.ms - tMin) / 1000);
  const vArr  = velocityHistory.map(s => s.v);

  const sumT  = tNorm.reduce((a, b) => a + b, 0);
  const sumV  = vArr.reduce((a, b) => a + b, 0);
  const sumTT = tNorm.reduce((a, t) => a + t * t, 0);
  const sumTV = tNorm.reduce((a, t, i) => a + t * vArr[i], 0);

  const denom = n * sumTT - sumT * sumT;
  const slope = denom !== 0 ? (n * sumTV - sumT * sumV) / denom : 0;

  const baseV     = sumV / n;
  const normSlope = baseV > 0.01 ? slope / baseV : 0;
  const score     = clamp(50 + normSlope * 200, 0, 100);

  return { slope, score };
};
