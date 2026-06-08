import type { Candle, SMCState, OrderBlock, TopDownBias } from "./types";
import { ema, macd } from "./indicators";

export type MicroTrendState =
  | "STRONG_BULL"
  | "BULL"
  | "BULL_FORMING"
  | "NEUTRAL"
  | "CONFLICTED"
  | "BEAR_FORMING"
  | "BEAR"
  | "STRONG_BEAR"
  | "REVERSAL_UP"
  | "REVERSAL_DOWN";

export type LayerVerdict = "BULL" | "BEAR" | "NEUTRAL";

export interface LayerBreakdown {
  macro: LayerVerdict;
  emaStack: LayerVerdict;
  macd: LayerVerdict;
  emaSlope: LayerVerdict;
  cci: LayerVerdict;
  momentum: LayerVerdict;
  srOB: LayerVerdict;
}

export interface MicroTrend {
  state: MicroTrendState;
  strength: number; // 0-100
  duration: number; // = sustainCount
  entryScore: number; // = layerScore
  shouldFire: boolean;
  direction: "RISE" | "FALL" | "WAIT";
  reason: string;
  accelerating: boolean;
  exhausting: boolean;
  // New transparency fields
  layerScore: number;
  sustainCount: number;
  bearTFs: number;
  bullTFs: number;
  macroBlock: "BULL" | "BEAR" | "NONE";
  layers: LayerBreakdown;
  agreeCount: number; // layers in agreement with direction
  blockReason: string; // reason why shouldFire is false (or "")
}

export interface MicroTrendInputs {
  candles: Candle[]; // M1 closed candles
  ind: {
    ema9: number; ema21: number; ema50: number; ema200: number;
    macdHist: number; cci: number; atr: number;
  };
  td: TopDownBias;
  m1Bias: "BULL" | "BEAR" | "NEUTRAL";
  nearestBOB: OrderBlock | null;
  nearestBEOB: OrderBlock | null;
  supports: number[];
  resistances: number[];
  price: number;
}

function countSustainCandles(
  candles: Candle[],
  direction: "RISE" | "FALL" | "WAIT",
  atr: number,
): number {
  if (direction === "WAIT" || atr <= 0) return 0;
  const thr = atr * 0.2;
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    const move = c.close - c.open;
    if (direction === "FALL" && move < -thr) count++;
    else if (direction === "RISE" && move > thr) count++;
    else break;
  }
  return count;
}

function verdictAgrees(v: LayerVerdict, dir: "RISE" | "FALL" | "WAIT"): boolean {
  if (dir === "RISE") return v === "BULL";
  if (dir === "FALL") return v === "BEAR";
  return false;
}

export function detectMicroTrend(inp: MicroTrendInputs): MicroTrend {
  const { candles, ind, td, m1Bias, nearestBOB, nearestBEOB, supports, resistances, price } = inp;
  const atr = ind.atr;

  const empty: MicroTrend = {
    state: "NEUTRAL", strength: 0, duration: 0, entryScore: 0,
    shouldFire: false, direction: "WAIT", reason: "Insufficient data",
    accelerating: false, exhausting: false,
    layerScore: 0, sustainCount: 0, bearTFs: 0, bullTFs: 0,
    macroBlock: "NONE",
    layers: { macro: "NEUTRAL", emaStack: "NEUTRAL", macd: "NEUTRAL", emaSlope: "NEUTRAL", cci: "NEUTRAL", momentum: "NEUTRAL", srOB: "NEUTRAL" },
    agreeCount: 0, blockReason: "Insufficient data",
  };
  if (candles.length < 30 || atr <= 0) return empty;

  // ── LAYER 1: Macro alignment (H4, H1, M15, M5, M1) ──
  const tfs = [td.h4, td.h1, td.m15, td.m5, m1Bias];
  const bearTFs = tfs.filter((t) => t === "BEAR").length;
  const bullTFs = tfs.filter((t) => t === "BULL").length;

  let macroBlock: "BULL" | "BEAR" | "NONE" = "NONE";
  if (bearTFs >= 4) macroBlock = "BEAR";
  else if (bullTFs >= 4) macroBlock = "BULL";

  let layerScore = 0;
  if (bearTFs >= 4) layerScore -= 3;
  else if (bearTFs === 3) layerScore -= 2;
  else if (bullTFs >= 4) layerScore += 3;
  else if (bullTFs === 3) layerScore += 2;

  const macroVerdict: LayerVerdict =
    bearTFs >= 3 ? "BEAR" : bullTFs >= 3 ? "BULL" : "NEUTRAL";

  // ── LAYER 2: Price vs EMA stack ──
  const emas = [ind.ema9, ind.ema21, ind.ema50, ind.ema200];
  const emasAbove = emas.filter((e) => price > e).length;
  const emasBelow = 4 - emasAbove;
  if (emasBelow === 4) layerScore -= 2;
  else if (emasBelow === 3) layerScore -= 1;
  else if (emasAbove === 4) layerScore += 2;
  else if (emasAbove === 3) layerScore += 1;
  const emaStackVerdict: LayerVerdict =
    emasBelow >= 3 ? "BEAR" : emasAbove >= 3 ? "BULL" : "NEUTRAL";

  // ── LAYER 3: MACD histogram direction ──
  const closes = candles.map((c) => c.close);
  const md = macd(closes);
  const histSeries = md.hist;
  const histNow = ind.macdHist;
  const histPrev = histSeries[histSeries.length - 4] ?? histNow;
  const histSlope = histNow - histPrev;

  if (histNow < -20 && histSlope < 0) layerScore -= 2;
  else if (histNow < 0) layerScore -= 1;
  else if (histNow > 20 && histSlope > 0) layerScore += 2;
  else if (histNow > 0) layerScore += 1;
  const macdVerdict: LayerVerdict =
    histNow < 0 ? "BEAR" : histNow > 0 ? "BULL" : "NEUTRAL";

  // ── LAYER 4: EMA slope ──
  const ema9arr = ema(closes, 9);
  const ema21arr = ema(closes, 21);
  const n = ema9arr.length - 1;
  const ema9Slope = ema9arr[n] - ema9arr[Math.max(0, n - 5)];
  const ema21Slope = ema21arr[n] - ema21arr[Math.max(0, n - 5)];
  if (ema9Slope < 0 && ema21Slope < 0) layerScore -= 2;
  else if (ema9Slope > 0 && ema21Slope > 0) layerScore += 2;
  const slopeVerdict: LayerVerdict =
    ema9Slope < 0 && ema21Slope < 0 ? "BEAR" :
    ema9Slope > 0 && ema21Slope > 0 ? "BULL" : "NEUTRAL";

  // ── LAYER 5: CCI extreme filter ──
  const cciVal = ind.cci;
  if (cciVal < -150) {
    layerScore = Math.min(layerScore, -1);
  } else if (cciVal > 150) {
    layerScore = Math.max(layerScore, 1);
  }
  const cciVerdict: LayerVerdict =
    cciVal < -150 ? "BEAR" : cciVal > 150 ? "BULL" : "NEUTRAL";

  // ── LAYER 6: Price momentum (ATR-normalized) ──
  const last = candles[candles.length - 1];
  const prev3 = candles[candles.length - 4];
  let moveInATR = 0;
  if (last && prev3) {
    moveInATR = (last.close - prev3.close) / atr;
    if (moveInATR < -1.0) layerScore -= 2;
    else if (moveInATR < -0.5) layerScore -= 1;
    else if (moveInATR > 1.0) layerScore += 2;
    else if (moveInATR > 0.5) layerScore += 1;
  }
  const momVerdict: LayerVerdict =
    moveInATR < -0.5 ? "BEAR" : moveInATR > 0.5 ? "BULL" : "NEUTRAL";

  // ── LAYER 7: S/R + OB context ──
  let srVerdict: LayerVerdict = "NEUTRAL";
  const nearestRes = resistances.length ? Math.min(...resistances.filter((r) => r > price)) : NaN;
  const nearestSup = supports.length ? Math.max(...supports.filter((s) => s < price)) : NaN;
  if (nearestBEOB) {
    const mid = (nearestBEOB.high + nearestBEOB.low) / 2;
    if (Math.abs(price - mid) < atr * 2) { layerScore -= 2; srVerdict = "BEAR"; }
  }
  if (nearestBOB) {
    const mid = (nearestBOB.high + nearestBOB.low) / 2;
    if (Math.abs(price - mid) < atr * 2) { layerScore += 2; srVerdict = "BULL"; }
  }
  if (!isNaN(nearestRes) && nearestRes - price < atr * 0.5) {
    layerScore -= 1;
    if (srVerdict === "NEUTRAL") srVerdict = "BEAR";
  }
  if (!isNaN(nearestSup) && price - nearestSup < atr * 0.5) {
    layerScore += 1;
    if (srVerdict === "NEUTRAL") srVerdict = "BULL";
  }

  // ── APPLY MACRO HARD BLOCK ──
  if (macroBlock === "BEAR" && layerScore > 0) layerScore = Math.min(layerScore, -1);
  if (macroBlock === "BULL" && layerScore < 0) layerScore = Math.max(layerScore, 1);

  // ── DETERMINE STATE ──
  let state: MicroTrendState;
  let direction: "RISE" | "FALL" | "WAIT";
  if (layerScore <= -10) { state = "STRONG_BEAR"; direction = "FALL"; }
  else if (layerScore <= -5) { state = "BEAR"; direction = "FALL"; }
  else if (layerScore >= 10) { state = "STRONG_BULL"; direction = "RISE"; }
  else if (layerScore >= 5) { state = "BULL"; direction = "RISE"; }
  else { state = "NEUTRAL"; direction = "WAIT"; }

  // ── SUSTAIN CHECK ──
  const sustainCount = countSustainCandles(candles, direction, atr);
  if (state !== "NEUTRAL") {
    if (sustainCount < 3) {
      if (state === "STRONG_BEAR") state = "BEAR";
      if (state === "STRONG_BULL") state = "BULL";
    }
    if (sustainCount < 2) {
      state = direction === "FALL" ? "BEAR_FORMING" : "BULL_FORMING";
    }
  }

  // Detect "CONFLICTED" — layers strongly disagree (high abs score on each side)
  const layers: LayerBreakdown = {
    macro: macroVerdict, emaStack: emaStackVerdict, macd: macdVerdict,
    emaSlope: slopeVerdict, cci: cciVerdict, momentum: momVerdict, srOB: srVerdict,
  };
  const layerArr: LayerVerdict[] = Object.values(layers);
  const bullLayers = layerArr.filter((v) => v === "BULL").length;
  const bearLayers = layerArr.filter((v) => v === "BEAR").length;
  if (state === "NEUTRAL" && bullLayers >= 2 && bearLayers >= 2) {
    state = "CONFLICTED";
  }

  const agreeCount = direction === "WAIT" ? 0
    : layerArr.filter((v) => verdictAgrees(v, direction)).length;

  // Acceleration & exhaustion
  const recentMove = candles[candles.length - 1].close - candles[Math.max(0, candles.length - 4)].close;
  const olderMove = candles[Math.max(0, candles.length - 4)].close - candles[Math.max(0, candles.length - 7)].close;
  const accelerating = Math.sign(recentMove) === Math.sign(olderMove) && Math.abs(recentMove) > Math.abs(olderMove) * 0.7;
  const exhausting = sustainCount >= 15;

  // ── SHOULD-FIRE GATES (7 rules) ──
  let shouldFire = true;
  let blockReason = "";
  if (state === "NEUTRAL" || state === "CONFLICTED" || state === "BULL_FORMING" || state === "BEAR_FORMING") {
    shouldFire = false; blockReason = `State=${state}`;
  }
  if (shouldFire && sustainCount < 3) { shouldFire = false; blockReason = `Sustain ${sustainCount}/3`; }
  if (shouldFire && Math.abs(layerScore) < 7) { shouldFire = false; blockReason = `|score|=${Math.abs(layerScore)}<7`; }
  if (shouldFire) {
    const majorityOK = direction === "FALL" ? bearTFs >= 3 : bullTFs >= 3;
    const extremeOverride = Math.abs(layerScore) >= 12 &&
      (direction === "FALL" ? bearTFs >= 2 : bullTFs >= 2);
    if (!majorityOK && !extremeOverride) {
      shouldFire = false;
      blockReason = `TFs ${direction === "FALL" ? bearTFs : bullTFs}/5 not majority`;
    }
  }
  if (shouldFire) {
    if (direction === "FALL" && ema9Slope >= 0) { shouldFire = false; blockReason = "EMA9 not falling"; }
    if (direction === "RISE" && ema9Slope <= 0) { shouldFire = false; blockReason = "EMA9 not rising"; }
  }
  if (shouldFire) {
    if (direction === "FALL" && histNow >= 0) { shouldFire = false; blockReason = "MACD hist not negative"; }
    if (direction === "RISE" && histNow <= 0) { shouldFire = false; blockReason = "MACD hist not positive"; }
  }

  const strength = Math.min(100, (Math.abs(layerScore) / 14) * 100);
  const reason = `${state.replace("_", " ")} · score ${layerScore > 0 ? "+" : ""}${layerScore} · ${agreeCount}/7 layers · TFs ${bullTFs}↑/${bearTFs}↓ · sustain ${sustainCount}c${shouldFire ? "" : ` · BLOCKED: ${blockReason}`}`;

  return {
    state, strength, duration: sustainCount, entryScore: layerScore,
    shouldFire, direction, reason, accelerating, exhausting,
    layerScore, sustainCount, bearTFs, bullTFs, macroBlock,
    layers, agreeCount, blockReason,
  };
}

// ── Reversal detection (unchanged contract; uses layerScore history) ──
export interface ReversalResult {
  detected: boolean;
  direction: "RISE" | "FALL";
  strength: number;
  confirmationCandles: number;
}

export function detectReversal(
  candles: Candle[],
  microScoreHistory: number[],
): ReversalResult {
  if (microScoreHistory.length < 6) {
    return { detected: false, direction: "RISE", strength: 0, confirmationCandles: 0 };
  }
  const recent = microScoreHistory.slice(-3);
  const previous = microScoreHistory.slice(-6, -3);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const previousAvg = previous.reduce((a, b) => a + b, 0) / previous.length;
  const crossedUp = previousAvg < -4 && recentAvg > 4;
  const crossedDown = previousAvg > 4 && recentAvg < -4;
  if (!crossedUp && !crossedDown) {
    return { detected: false, direction: "RISE", strength: 0, confirmationCandles: 0 };
  }
  const last3 = candles.slice(-3);
  const bullConfirm = last3.filter((c) => c.close > c.open).length;
  const bearConfirm = last3.filter((c) => c.close < c.open).length;
  const direction: "RISE" | "FALL" = crossedUp ? "RISE" : "FALL";
  const confirmation = crossedUp ? bullConfirm : bearConfirm;
  if (confirmation < 2) return { detected: false, direction, strength: 0, confirmationCandles: 0 };
  const strength = Math.min(100, (Math.abs(recentAvg - previousAvg) / 12) * 100);
  return { detected: true, direction, strength, confirmationCandles: confirmation };
}

export interface MicroTrendSnapshot {
  time: number;
  state: MicroTrendState;
  duration: number;
  direction: "RISE" | "FALL" | "WAIT";
  entryScore: number;
}

export function frequencyTarget(state: MicroTrendState, neutralStreak: number): string {
  if (state === "STRONG_BULL" || state === "STRONG_BEAR")
    return "Strong trend — Tier A every ~3 min";
  if (state === "BULL" || state === "BEAR")
    return "Tier A every ~5 min";
  if (state === "BULL_FORMING" || state === "BEAR_FORMING")
    return "Forming — awaiting 3rd confirm candle";
  if (state === "CONFLICTED") return "Layers conflict — not tradeable";
  if (neutralStreak >= 10) return "Market ranging — Tier A paused";
  return "Awaiting clear micro trend…";
}
