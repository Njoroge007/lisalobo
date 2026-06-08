import type { Candle } from "./types";

export interface PatternResult {
  name: string;          // canonical name e.g. "Three Black Crows"
  key: string;           // PATTERN_THREE_BLACK_CROWS
  label: string;         // emoji label for chart marker / UI
  signal: number;        // -3 … +3
  direction: "RISE" | "FALL" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK";
  candleIndex: number;   // index inside passed candles array
  candleTime: number;    // unix seconds of the candle that triggered
  description: string;
}

// ── helpers ────────────────────────────────────────────────
const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => Math.max(c.high - c.low, 1e-9);
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;
const isBull = (c: Candle) => c.close > c.open;
const isBear = (c: Candle) => c.close < c.open;
const isDoji = (c: Candle, atr: number) => body(c) < atr * 0.05;

const priorDown = (candles: Candle[], i: number, n = 2) => {
  if (i < n) return false;
  let bears = 0;
  for (let k = i - n; k < i; k++) if (isBear(candles[k])) bears++;
  return bears >= Math.max(1, n - 1);
};
const priorUp = (candles: Candle[], i: number, n = 2) => {
  if (i < n) return false;
  let bulls = 0;
  for (let k = i - n; k < i; k++) if (isBull(candles[k])) bulls++;
  return bulls >= Math.max(1, n - 1);
};

const strengthOf = (signal: number): PatternResult["strength"] =>
  Math.abs(signal) >= 3 ? "STRONG" : Math.abs(signal) >= 2 ? "MODERATE" : "WEAK";

const make = (
  name: string,
  label: string,
  signal: number,
  description: string,
  i: number,
  candle: Candle,
): PatternResult => ({
  name,
  key: "PATTERN_" + name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
  label,
  signal,
  direction: signal > 0 ? "RISE" : signal < 0 ? "FALL" : "NEUTRAL",
  strength: strengthOf(signal),
  candleIndex: i,
  candleTime: candle.time,
  description,
});

// ── SINGLE CANDLE ───────────────────────────────────────────
function checkHammer(c: Candle, candles: Candle[], atr: number, out: PatternResult[], i: number) {
  if (!isBull(c)) return;
  const b = body(c);
  if (b < atr * 0.1) return;
  if (lowerWick(c) < b * 2.0) return;
  if (upperWick(c) > b * 0.5) return;
  if (!priorDown(candles, i)) return;
  out.push(make("Hammer", "🔨 Hammer", 2, "Long lower wick after downtrend — buyers reject lows.", i, c));
}
function checkInvertedHammer(c: Candle, candles: Candle[], atr: number, out: PatternResult[], i: number) {
  if (!isBull(c)) return;
  const b = body(c);
  if (b < atr * 0.1) return;
  if (upperWick(c) < b * 2.0) return;
  if (lowerWick(c) > b * 0.5) return;
  if (!priorDown(candles, i)) return;
  out.push(make("Inv Hammer", "🔨 Inv. Hammer", 1, "Upper wick rejection after downtrend.", i, c));
}
function checkShootingStar(c: Candle, candles: Candle[], atr: number, out: PatternResult[], i: number) {
  if (!isBear(c)) return;
  const b = body(c);
  if (b < atr * 0.1) return;
  if (upperWick(c) < b * 2.0) return;
  if (lowerWick(c) > b * 0.5) return;
  if (!priorUp(candles, i)) return;
  out.push(make("Shooting Star", "⭐ Shooting Star", -2, "Long upper wick rejection after rally.", i, c));
}
function checkHangingMan(c: Candle, candles: Candle[], atr: number, out: PatternResult[], i: number) {
  if (!isBear(c)) return;
  const b = body(c);
  if (b < atr * 0.1) return;
  if (lowerWick(c) < b * 2.0) return;
  if (upperWick(c) > b * 0.5) return;
  if (!priorUp(candles, i)) return;
  out.push(make("Hanging Man", "🪝 Hanging Man", -1, "Hammer shape after uptrend — bearish warning.", i, c));
}
function checkBullMarubozu(c: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBull(c)) return;
  if (body(c) / range(c) < 0.85) return;
  if (body(c) < atr * 0.8) return;
  out.push(make("Marubozu Bull", "⬛ Bull Marubozu", 2, "Full-body bullish — pure buying pressure.", i, c));
}
function checkBearMarubozu(c: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBear(c)) return;
  if (body(c) / range(c) < 0.85) return;
  if (body(c) < atr * 0.8) return;
  out.push(make("Marubozu Bear", "⬛ Bear Marubozu", -2, "Full-body bearish — pure selling pressure.", i, c));
}
function checkDoji(c: Candle, atr: number, out: PatternResult[], i: number) {
  if (body(c) / range(c) >= 0.08) return;
  if (range(c) <= atr * 0.2) return;
  out.push(make("Doji", "➕ Doji", 0, "Indecision — possible reversal pivot.", i, c));
}
function checkDragonflyDoji(c: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isDoji(c, atr)) return;
  if (lowerWick(c) < range(c) * 0.6) return;
  if (upperWick(c) > range(c) * 0.1) return;
  out.push(make("Dragonfly Doji", "🐉 Dragonfly Doji", 1, "Long lower wick doji — bullish reversal.", i, c));
}
function checkGravestoneDoji(c: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isDoji(c, atr)) return;
  if (upperWick(c) < range(c) * 0.6) return;
  if (lowerWick(c) > range(c) * 0.1) return;
  out.push(make("Gravestone Doji", "🪦 Gravestone Doji", -1, "Long upper wick doji — bearish reversal.", i, c));
}

// ── TWO CANDLE ─────────────────────────────────────────────
function checkBullEngulfing(c1: Candle, c2: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBear(c1) || !isBull(c2)) return;
  if (c2.open > c1.close) return;
  if (c2.close < c1.open) return;
  if (body(c2) <= body(c1)) return;
  if (body(c2) < atr * 0.3) return;
  out.push(make("Bull Engulfing", "🟢 Bull Engulfing", 3, "Bullish body engulfs prior bearish candle.", i, c2));
}
function checkBearEngulfing(c1: Candle, c2: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBull(c1) || !isBear(c2)) return;
  if (c2.open < c1.close) return;
  if (c2.close > c1.open) return;
  if (body(c2) <= body(c1)) return;
  if (body(c2) < atr * 0.3) return;
  out.push(make("Bear Engulfing", "🔴 Bear Engulfing", -3, "Bearish body engulfs prior bullish candle.", i, c2));
}
function checkBullHarami(c1: Candle, c2: Candle, _atr: number, out: PatternResult[], i: number) {
  if (!isBear(c1) || !isBull(c2)) return;
  if (c2.open < c1.close) return;
  if (c2.close > c1.open) return;
  if (body(c2) >= body(c1) * 0.5) return;
  out.push(make("Bull Harami", "🤰 Bull Harami", 1, "Small bull body inside prior bear — reversal hint.", i, c2));
}
function checkBearHarami(c1: Candle, c2: Candle, _atr: number, out: PatternResult[], i: number) {
  if (!isBull(c1) || !isBear(c2)) return;
  if (c2.open > c1.close) return;
  if (c2.close < c1.open) return;
  if (body(c2) >= body(c1) * 0.5) return;
  out.push(make("Bear Harami", "🤰 Bear Harami", -1, "Small bear body inside prior bull — reversal hint.", i, c2));
}
function checkTweezerBottom(c1: Candle, c2: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBear(c1) || !isBull(c2)) return;
  if (Math.abs(c1.low - c2.low) > atr * 0.05) return;
  if (lowerWick(c1) < body(c1) * 0.3 || lowerWick(c2) < body(c2) * 0.3) return;
  out.push(make("Tweezer Bot", "🔧 Tweezer Bot", 1, "Two matching lows — support held.", i, c2));
}
function checkTweezerTop(c1: Candle, c2: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBull(c1) || !isBear(c2)) return;
  if (Math.abs(c1.high - c2.high) > atr * 0.05) return;
  if (upperWick(c1) < body(c1) * 0.3 || upperWick(c2) < body(c2) * 0.3) return;
  out.push(make("Tweezer Top", "🔧 Tweezer Top", -1, "Two matching highs — resistance held.", i, c2));
}
function checkPiercingLine(c1: Candle, c2: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBear(c1) || !isBull(c2)) return;
  if (c2.open >= c1.low) return;
  const mid = (c1.open + c1.close) / 2;
  if (c2.close <= mid) return;
  if (body(c2) < atr * 0.3) return;
  out.push(make("Piercing Line", "🗡️ Piercing Line", 2, "Bull pierces above prior bear midpoint.", i, c2));
}
function checkDarkCloud(c1: Candle, c2: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBull(c1) || !isBear(c2)) return;
  if (c2.open <= c1.high) return;
  const mid = (c1.open + c1.close) / 2;
  if (c2.close >= mid) return;
  if (body(c2) < atr * 0.3) return;
  out.push(make("Dark Cloud", "☁️ Dark Cloud", -2, "Bear dips below prior bull midpoint.", i, c2));
}

// ── THREE CANDLE ───────────────────────────────────────────
function checkThreeWhiteSoldiers(c1: Candle, c2: Candle, c3: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBull(c1) || !isBull(c2) || !isBull(c3)) return;
  if (!(c2.close > c1.close && c3.close > c2.close)) return;
  if (!(c2.open > c1.open && c2.open < c1.close)) return;
  if (!(c3.open > c2.open && c3.open < c2.close)) return;
  if (body(c1) < atr * 0.4 || body(c2) < atr * 0.4 || body(c3) < atr * 0.4) return;
  if (upperWick(c1) > body(c1) * 0.5 || upperWick(c2) > body(c2) * 0.5 || upperWick(c3) > body(c3) * 0.5) return;
  out.push(make("Three White Soldiers", "⚔️ Three White Soldiers", 3, "Three consecutive strong bulls — confirmed uptrend.", i, c3));
}
function checkThreeBlackCrows(c1: Candle, c2: Candle, c3: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBear(c1) || !isBear(c2) || !isBear(c3)) return;
  if (!(c2.close < c1.close && c3.close < c2.close)) return;
  if (!(c2.open < c1.open && c2.open > c1.close)) return;
  if (!(c3.open < c2.open && c3.open > c2.close)) return;
  if (body(c1) < atr * 0.4 || body(c2) < atr * 0.4 || body(c3) < atr * 0.4) return;
  if (lowerWick(c1) > body(c1) * 0.5 || lowerWick(c2) > body(c2) * 0.5 || lowerWick(c3) > body(c3) * 0.5) return;
  out.push(make("Three Black Crows", "🦅 Three Black Crows", -3, "Three consecutive strong bears — confirmed downtrend.", i, c3));
}
function checkMorningStar(c1: Candle, c2: Candle, c3: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBear(c1) || body(c1) < atr * 0.5) return;
  if (body(c2) > body(c1) * 0.3) return;
  if (!(c2.open <= c1.close || Math.max(c2.open, c2.close) < c1.close)) return;
  if (!isBull(c3) || body(c3) < atr * 0.4) return;
  const mid = (c1.open + c1.close) / 2;
  if (c3.close <= mid) return;
  out.push(make("Morning Star", "🌅 Morning Star", 3, "Bear → indecision → strong bull. Powerful reversal.", i, c3));
}
function checkEveningStar(c1: Candle, c2: Candle, c3: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBull(c1) || body(c1) < atr * 0.5) return;
  if (body(c2) > body(c1) * 0.3) return;
  if (!(c2.open >= c1.close || Math.min(c2.open, c2.close) > c1.close)) return;
  if (!isBear(c3) || body(c3) < atr * 0.4) return;
  const mid = (c1.open + c1.close) / 2;
  if (c3.close >= mid) return;
  out.push(make("Evening Star", "🌆 Evening Star", -3, "Bull → indecision → strong bear. Powerful top reversal.", i, c3));
}
function checkThreeInsideUp(c1: Candle, c2: Candle, c3: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBear(c1) || body(c1) < atr * 0.4) return;
  if (!isBull(c2)) return;
  if (c2.open < c1.close || c2.close > c1.open) return;
  if (body(c2) >= body(c1) * 0.5) return;
  if (!isBull(c3) || c3.close <= c1.open) return;
  out.push(make("Three Inside Up", "📈 Three Inside Up", 2, "Bull harami confirmed by next bull close above prior open.", i, c3));
}
function checkThreeInsideDown(c1: Candle, c2: Candle, c3: Candle, atr: number, out: PatternResult[], i: number) {
  if (!isBull(c1) || body(c1) < atr * 0.4) return;
  if (!isBear(c2)) return;
  if (c2.open > c1.close || c2.close < c1.open) return;
  if (body(c2) >= body(c1) * 0.5) return;
  if (!isBear(c3) || c3.close >= c1.open) return;
  out.push(make("Three Inside Down", "📉 Three Inside Down", -2, "Bear harami confirmed by next bear close below prior open.", i, c3));
}
function checkBearContinuation(candles: Candle[], _c3: Candle, atr: number, out: PatternResult[], i: number) {
  if (i < 5) return;
  const prior = candles.slice(i - 5, i - 2);
  if (prior.length < 3) return;
  const priorBearish = prior[2].close < prior[0].close && prior.filter(isBear).length >= 2;
  if (!priorBearish) return;
  const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
  if (body(c1) > atr * 0.2 || body(c2) > atr * 0.2) return;
  if (!isBear(c3) || body(c3) < atr * 0.4) return;
  if (c3.close >= c1.low) return;
  out.push(make("Bear Continuation", "⬇️ Bear Continuation", -2, "Pause then resumed strong bear — flag breakdown.", i, c3));
}
function checkBullContinuation(candles: Candle[], _c3: Candle, atr: number, out: PatternResult[], i: number) {
  if (i < 5) return;
  const prior = candles.slice(i - 5, i - 2);
  if (prior.length < 3) return;
  const priorBullish = prior[2].close > prior[0].close && prior.filter(isBull).length >= 2;
  if (!priorBullish) return;
  const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
  if (body(c1) > atr * 0.2 || body(c2) > atr * 0.2) return;
  if (!isBull(c3) || body(c3) < atr * 0.4) return;
  if (c3.close <= c1.high) return;
  out.push(make("Bull Continuation", "⬆️ Bull Continuation", 2, "Pause then resumed strong bull — flag breakout.", i, c3));
}

// ── Master detector ────────────────────────────────────────
export function detectAllPatterns(candles: Candle[], atr: number): PatternResult[] {
  if (candles.length < 3 || atr <= 0) return [];
  const results: PatternResult[] = [];
  const i = candles.length - 1;
  const c1 = candles[i - 2];
  const c2 = candles[i - 1];
  const c3 = candles[i];

  // Single (on c3)
  checkHammer(c3, candles, atr, results, i);
  checkInvertedHammer(c3, candles, atr, results, i);
  checkShootingStar(c3, candles, atr, results, i);
  checkHangingMan(c3, candles, atr, results, i);
  checkBullMarubozu(c3, atr, results, i);
  checkBearMarubozu(c3, atr, results, i);
  checkDragonflyDoji(c3, atr, results, i);
  checkGravestoneDoji(c3, atr, results, i);
  checkDoji(c3, atr, results, i);

  // Two-candle (c2, c3)
  checkBullEngulfing(c2, c3, atr, results, i);
  checkBearEngulfing(c2, c3, atr, results, i);
  checkBullHarami(c2, c3, atr, results, i);
  checkBearHarami(c2, c3, atr, results, i);
  checkTweezerBottom(c2, c3, atr, results, i);
  checkTweezerTop(c2, c3, atr, results, i);
  checkPiercingLine(c2, c3, atr, results, i);
  checkDarkCloud(c2, c3, atr, results, i);

  // Three-candle
  checkThreeWhiteSoldiers(c1, c2, c3, atr, results, i);
  checkThreeBlackCrows(c1, c2, c3, atr, results, i);
  checkMorningStar(c1, c2, c3, atr, results, i);
  checkEveningStar(c1, c2, c3, atr, results, i);
  checkThreeInsideUp(c1, c2, c3, atr, results, i);
  checkThreeInsideDown(c1, c2, c3, atr, results, i);
  checkBearContinuation(candles, c3, atr, results, i);
  checkBullContinuation(candles, c3, atr, results, i);

  return results.sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal));
}

/** Net pattern score, deduped: use strongest, reduce when 2 top patterns conflict. */
export function getPatternScore(patterns: PatternResult[]): number {
  if (patterns.length === 0) return 0;
  const strongest = patterns[0];
  if (patterns.length >= 2) {
    const second = patterns[1];
    if (
      strongest.direction !== "NEUTRAL" &&
      second.direction !== "NEUTRAL" &&
      strongest.direction !== second.direction
    ) {
      return Math.round(strongest.signal * 0.5);
    }
  }
  return strongest.signal;
}

/** Scan the last N candles and return detected patterns per candle (oldest→newest). */
export function scanPatternHistory(
  candles: Candle[],
  atr: number,
  lookback = 10,
): { time: number; index: number; patterns: PatternResult[] }[] {
  if (candles.length < 3) return [];
  const out: { time: number; index: number; patterns: PatternResult[] }[] = [];
  const start = Math.max(2, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const found = detectAllPatterns(slice, atr);
    out.push({ time: candles[i].time, index: i, patterns: found });
  }
  return out;
}

/** Pick the dominant pattern from a scan (strongest signal across the lookback window). */
export function dominantFromScan(
  scan: { patterns: PatternResult[] }[],
): PatternResult | null {
  let best: PatternResult | null = null;
  for (const row of scan) {
    if (!row.patterns.length) continue;
    const top = row.patterns[0];
    if (!best || Math.abs(top.signal) > Math.abs(best.signal)) best = top;
  }
  return best;
}

export const PATTERN_COLOR: Record<number, string> = {
  3: "#00E676",
  2: "#69F0AE",
  1: "#B9F6CA",
  0: "#90A4AE",
  [-1 as number]: "#FF8A80",
  [-2 as number]: "#FF5252",
  [-3 as number]: "#FF1744",
};

export const colorForSignal = (s: number) =>
  PATTERN_COLOR[s] ?? (s > 0 ? "#00E676" : s < 0 ? "#FF1744" : "#90A4AE");
