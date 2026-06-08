import type { Candle, Tick } from "./types";

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
  for (let i = p; i < trs.length; i++) {
    a = (a * (p - 1) + trs[i]) / p;
    out[i] = a;
  }
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
  return {
    zScore: (prices[prices.length - 1] - mean) / sd,
    sma: mean,
    sd,
  };
};

export const computeTickVelocity = (
  ticks: Tick[],
  windowMs: number,
  currentAtr: number,
): number => {
  if (ticks.length < 2 || currentAtr <= 0) return 0;
  const now = ticks[ticks.length - 1].ms;
  const cutoff = now - windowMs;
  const recent = ticks.filter((t) => t.ms >= cutoff);
  if (recent.length < 2) return 0;
  let totalMove = 0;
  for (let i = 1; i < recent.length; i++) {
    totalMove += Math.abs(recent[i].price - recent[i - 1].price);
  }
  const windowSec = windowMs / 1000;
  const atrPerSec = currentAtr / 60;
  if (atrPerSec <= 0) return 0;
  return totalMove / windowSec / atrPerSec;
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
  for (const d of adjusted) {
    cum += d;
    cumulative.push(cum);
  }

  const R = Math.max(...cumulative) - Math.min(...cumulative);
  const variance = diffs.reduce((s, v) => s + (v - m) ** 2, 0) / diffs.length;
  const S = Math.sqrt(variance);

  if (S === 0 || R === 0) return 0.5;
  const h = Math.log(R / S) / Math.log(diffs.length);
  return Math.max(0, Math.min(1, h));
};
