import type { Candle, IndicatorSnapshot } from "./types";

export const ema = (vals: number[], p: number): number[] => {
  const k = 2 / (p + 1);
  const out: number[] = [];
  let prev = vals[0];
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
};

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

export const rsi = (closes: number[], p = 14): number[] => {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= p; l /= p;
  out[p] = 100 - 100 / (1 + (l === 0 ? 100 : g / l));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l));
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
  // Wilder smoothing
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

export const stochastic = (candles: Candle[], kP = 5, dP = 3, smooth = 3) => {
  const raw: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < kP - 1) { raw.push(50); continue; }
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kP + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    raw.push(hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100);
  }
  const kRaw = sma(raw, smooth);
  const k = kRaw.map((v, i) => (isNaN(v) ? raw[i] : v));
  const d = sma(k, dP).map((v, i) => (isNaN(v) ? k[i] : v));
  return { k, d };
};

export const macd = (closes: number[], fast = 12, slow = 26, sig = 9) => {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const signal = ema(line, sig);
  const hist = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
};

export const bollinger = (closes: number[], p = 20, mult = 2) => {
  const m = sma(closes, p), sd = stdev(closes, p);
  return {
    middle: m,
    upper: m.map((v, i) => v + mult * sd[i]),
    lower: m.map((v, i) => v - mult * sd[i]),
  };
};

export const williamsR = (candles: Candle[], p = 14): number[] => {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < p - 1) { out.push(NaN); continue; }
    let hh = -Infinity, ll = Infinity;
    for (let j = i - p + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    out.push(hh === ll ? -50 : ((hh - candles[i].close) / (hh - ll)) * -100);
  }
  return out;
};

export const cci = (candles: Candle[], p = 20): number[] => {
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const m = sma(tp, p);
  const out: number[] = [];
  for (let i = 0; i < tp.length; i++) {
    if (i < p - 1) { out.push(NaN); continue; }
    let md = 0;
    for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= p;
    out.push(md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md));
  }
  return out;
};

// Detect divergence by comparing last two swing pivots in `vals` (indicator) vs price
export const detectDivergence = (
  closes: number[],
  vals: number[],
  lookback = 30,
): "BULL" | "BEAR" | "NONE" => {
  const n = closes.length;
  if (n < lookback) return "NONE";
  // Find two recent lows/highs (simple pivots, left/right 2)
  const lows: number[] = [], highs: number[] = [];
  for (let i = n - lookback + 2; i < n - 2; i++) {
    const lo = closes[i] < closes[i - 1] && closes[i] < closes[i - 2] &&
      closes[i] < closes[i + 1] && closes[i] < closes[i + 2];
    const hi = closes[i] > closes[i - 1] && closes[i] > closes[i - 2] &&
      closes[i] > closes[i + 1] && closes[i] > closes[i + 2];
    if (lo) lows.push(i);
    if (hi) highs.push(i);
  }
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    if (closes[b] < closes[a] && vals[b] > vals[a]) return "BULL";
  }
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    if (closes[b] > closes[a] && vals[b] < vals[a]) return "BEAR";
  }
  return "NONE";
};

export const computeIndicators = (candles: Candle[]): IndicatorSnapshot | null => {
  if (candles.length < 50) return null;
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const e50 = ema(closes, 50), e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const st = stochastic(candles, 5, 3, 3);
  const md = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const a = atr(candles, 14);
  const w = williamsR(candles, 14);
  const c = cci(candles, 20);
  const i = candles.length - 1;
  const price = closes[i];
  const bbW = bb.upper[i] && bb.lower[i] ? ((bb.upper[i] - bb.lower[i]) / bb.middle[i]) * 100 : 0;
  const bbPos = bb.upper[i] !== bb.lower[i]
    ? (price - bb.lower[i]) / (bb.upper[i] - bb.lower[i])
    : 0.5;
  return {
    ema9: e9[i], ema21: e21[i], ema50: e50[i], ema200: e200[i],
    rsi: r[i] ?? 50,
    stochK: st.k[i] ?? 50,
    stochD: st.d[i] ?? 50,
    macdLine: md.line[i], macdSignal: md.signal[i], macdHist: md.hist[i],
    bbUpper: bb.upper[i], bbMiddle: bb.middle[i], bbLower: bb.lower[i],
    bbWidth: bbW, bbPosition: bbPos,
    atr: a[i] ?? 0,
    relativeAtr: a[i] ? (a[i] / price) * 100 : 0,
    williamsR: w[i] ?? -50,
    cci: c[i] ?? 0,
    rsiDivergence: detectDivergence(closes, r),
    macdDivergence: detectDivergence(closes, md.hist),
  };
};

export const detectCandlePattern = (candles: Candle[]): string => {
  if (candles.length < 2) return "NONE";
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 1;
  const upper = c.high - Math.max(c.close, c.open);
  const lower = Math.min(c.close, c.open) - c.low;
  if (body / range < 0.1) return "DOJI";
  if (c.close > c.open && p.close < p.open && c.close > p.open && c.open < p.close) return "BULL_ENGULF";
  if (c.close < c.open && p.close > p.open && c.close < p.open && c.open > p.close) return "BEAR_ENGULF";
  if (body / range > 0.9 && c.close > c.open) return "MARUBOZU_BULL";
  if (body / range > 0.9 && c.close < c.open) return "MARUBOZU_BEAR";
  if (lower > body * 2 && upper < body) return "HAMMER";
  if (upper > body * 2 && lower < body) return "SHOOTING_STAR";
  return "NONE";
};