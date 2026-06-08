import type { Candle } from "./types";

export type MRDirection = "RISE" | "FALL";
export type MRPatternType =
  | "equal_highs_bearish_reversal"
  | "equal_lows_bullish_reversal"
  | "equal_lows_breakdown_bearish"
  | "equal_highs_breakout_bullish";

export interface MicroReversalResult {
  patternType: MRPatternType;
  direction: MRDirection;
  candleA: Candle;
  candleB: Candle;
  candleC: Candle;
  levelPrice: number;
  highDifference?: number;
  lowDifference?: number;
  toleranceUsed: number;
  entryPrice: number;
  equalCount?: number;
}

export interface MicroReversalSettings {
  enabled: boolean;
  toleranceMode: "auto" | "manual";
  manualTolerance: number;
  minConfidence: number;
  alertMinConfidence: number;
  tradeDuration: "auto" | "3min" | "5min" | "6min" | "15min";
  showOnChart: boolean;
  requireCrossConfirmation: boolean;
  evaluationWindow: number;
  maxSignalsPerHour: number | null;
  enableEqualHighs: boolean;
  enableEqualLows: boolean;
  enableBreakdown: boolean;
  enableBreakout: boolean;
  telegramBotToken: string;
  telegramChatId: string;
}

export const DEFAULT_MR_SETTINGS: MicroReversalSettings = {
  enabled: true,
  toleranceMode: "auto",
  manualTolerance: 2.0,
  minConfidence: 45,
  alertMinConfidence: 60,
  tradeDuration: "auto",
  showOnChart: true,
  requireCrossConfirmation: false,
  evaluationWindow: 5,
  maxSignalsPerHour: null,
  enableEqualHighs: true,
  enableEqualLows: true,
  enableBreakdown: true,
  enableBreakout: true,
  telegramBotToken: "",
  telegramChatId: "",
};

export interface MicroReversalSignal {
  timestamp: string;
  ts: number;
  instrument: string;
  timeframe: string;
  module: string;
  direction: MRDirection;
  patternType: MRPatternType;
  confidence: number;
  strength: string;
  recommendedDuration: string;
  entryPrice: number;
  candleA: Candle;
  candleB: Candle;
  candleC: Candle;
  levelPrice: number;
  toleranceUsed: number;
  confluenceFactors: string[];
  suggestedSL: number;
  suggestedTP1: number;
  suggestedTP2: number;
  riskRewardRatio: string;
  existingAnalyzerDirection: string | null;
  crossConfirmed: boolean;
  counterTrend: boolean;
  shouldAlert: boolean;
  indicators: { ema9: number; ema21: number; bbUpper: number; bbLower: number; atr: number };
  outcome?: "WIN" | "LOSS" | "PENDING";
  exitPrice?: number;
}

export function getTolerance(atr: number, settings?: MicroReversalSettings): number {
  if (settings && settings.toleranceMode === "manual") {
    return Math.max(0.01, settings.manualTolerance);
  }
  return Math.max(2.0, atr * 0.08);
}

// ── Pattern 1: Equal Highs Bearish Reversal ──────────────────
export function detectEqualHighsBearish(candles: Candle[], atr: number, tol?: number): MicroReversalResult | null {
  if (candles.length < 3) return null;
  const tolerance = tol ?? getTolerance(atr);
  const minBody = atr * 0.3;
  const cA = candles[candles.length - 3];
  const cB = candles[candles.length - 2];
  const cC = candles[candles.length - 1];
  if (cA.close <= cA.open) return null;
  if (cB.close >= cB.open) return null;
  const highDiff = Math.abs(cA.high - cB.high);
  if (highDiff > tolerance) return null;
  if (cB.close >= cA.open) return null;
  if (Math.abs(cB.close - cB.open) < minBody) return null;
  if (cC.open > cB.close && cC.low > cB.close) return null;
  return {
    patternType: "equal_highs_bearish_reversal",
    direction: "FALL",
    candleA: cA, candleB: cB, candleC: cC,
    levelPrice: (cA.high + cB.high) / 2,
    highDifference: highDiff,
    toleranceUsed: tolerance,
    entryPrice: cC.open,
  };
}

// ── Pattern 2: Equal Lows Bullish Reversal ───────────────────
export function detectEqualLowsBullish(candles: Candle[], atr: number, tol?: number): MicroReversalResult | null {
  if (candles.length < 3) return null;
  const tolerance = tol ?? getTolerance(atr);
  const minBody = atr * 0.3;
  const cA = candles[candles.length - 3];
  const cB = candles[candles.length - 2];
  const cC = candles[candles.length - 1];
  if (cA.close >= cA.open) return null;
  if (cB.close <= cB.open) return null;
  const lowDiff = Math.abs(cA.low - cB.low);
  if (lowDiff > tolerance) return null;
  if (cB.close <= cA.open) return null;
  if (Math.abs(cB.close - cB.open) < minBody) return null;
  if (cC.open < cB.close && cC.high < cB.close) return null;
  return {
    patternType: "equal_lows_bullish_reversal",
    direction: "RISE",
    candleA: cA, candleB: cB, candleC: cC,
    levelPrice: (cA.low + cB.low) / 2,
    lowDifference: lowDiff,
    toleranceUsed: tolerance,
    entryPrice: cC.open,
  };
}

// ── Pattern 3: Equal Lows Breakdown (Bearish) ────────────────
export function detectEqualLowsBreakdown(candles: Candle[], atr: number, tol?: number): MicroReversalResult | null {
  if (candles.length < 4) return null;
  const tolerance = tol ?? getTolerance(atr);
  const minBody = atr * 0.3;
  const lookback = candles.slice(-6, -1);
  const breakCandle = candles[candles.length - 1];
  let supportLevel: number | null = null;
  let equalCount = 0;
  for (let i = 0; i < lookback.length - 1; i++) {
    for (let j = i + 1; j < lookback.length; j++) {
      const diff = Math.abs(lookback[i].low - lookback[j].low);
      if (diff <= tolerance) {
        supportLevel = (lookback[i].low + lookback[j].low) / 2;
        equalCount++;
      }
    }
  }
  if (!supportLevel || equalCount < 1) return null;
  if (breakCandle.close >= supportLevel) return null;
  if (breakCandle.close >= breakCandle.open) return null;
  const bodySize = Math.abs(breakCandle.close - breakCandle.open);
  if (bodySize < minBody) return null;
  const avgBody = lookback.slice(-5).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / Math.max(1, lookback.slice(-5).length);
  if (bodySize <= avgBody) return null;
  return {
    patternType: "equal_lows_breakdown_bearish",
    direction: "FALL",
    candleA: lookback[lookback.length - 2],
    candleB: lookback[lookback.length - 1],
    candleC: breakCandle,
    levelPrice: supportLevel,
    equalCount,
    toleranceUsed: tolerance,
    entryPrice: breakCandle.close,
  };
}

// ── Pattern 4: Equal Highs Breakout (Bullish) ────────────────
export function detectEqualHighsBreakout(candles: Candle[], atr: number, tol?: number): MicroReversalResult | null {
  if (candles.length < 4) return null;
  const tolerance = tol ?? getTolerance(atr);
  const minBody = atr * 0.3;
  const lookback = candles.slice(-6, -1);
  const breakCandle = candles[candles.length - 1];
  let resistanceLevel: number | null = null;
  let equalCount = 0;
  for (let i = 0; i < lookback.length - 1; i++) {
    for (let j = i + 1; j < lookback.length; j++) {
      const diff = Math.abs(lookback[i].high - lookback[j].high);
      if (diff <= tolerance) {
        resistanceLevel = (lookback[i].high + lookback[j].high) / 2;
        equalCount++;
      }
    }
  }
  if (!resistanceLevel || equalCount < 1) return null;
  if (breakCandle.close <= resistanceLevel) return null;
  if (breakCandle.close <= breakCandle.open) return null;
  const bodySize = Math.abs(breakCandle.close - breakCandle.open);
  if (bodySize < minBody) return null;
  const avgBody = lookback.slice(-5).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / Math.max(1, lookback.slice(-5).length);
  if (bodySize <= avgBody) return null;
  return {
    patternType: "equal_highs_breakout_bullish",
    direction: "RISE",
    candleA: lookback[lookback.length - 2],
    candleB: lookback[lookback.length - 1],
    candleC: breakCandle,
    levelPrice: resistanceLevel,
    equalCount,
    toleranceUsed: tolerance,
    entryPrice: breakCandle.close,
  };
}

// ── Swing levels (S/R helper) ────────────────────────────────
export function detectSwingLevels(candles: Candle[]): number[] {
  const levels: number[] = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (
      candles[i].high > candles[i - 1].high &&
      candles[i].high > candles[i - 2].high &&
      candles[i].high > candles[i + 1].high &&
      candles[i].high > candles[i + 2].high
    ) levels.push(candles[i].high);
    if (
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i - 2].low &&
      candles[i].low < candles[i + 1].low &&
      candles[i].low < candles[i + 2].low
    ) levels.push(candles[i].low);
  }
  return levels;
}

const DEFAULT_HIGH_REVERSAL_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
export function getHighReversalHours(): number[] {
  return DEFAULT_HIGH_REVERSAL_HOURS;
}

// ── Confluence Scoring ───────────────────────────────────────
export function computeConfluenceScore(
  pattern: MicroReversalResult,
  candles: Candle[],
  atr: number,
  ema9: number,
  ema21: number,
  ema9Prev: number,
  ema21Prev: number,
  bbUpper: number,
  bbLower: number,
  existingAnalyzerDirection: string | null,
): { score: number; factors: string[] } {
  let score = 0;
  const factors: string[] = [];
  const price = pattern.entryPrice;
  const direction = pattern.direction;

  if (direction === "FALL" && price >= bbUpper) { score += 15; factors.push("bollinger_upper_band"); }
  if (direction === "RISE" && price <= bbLower) { score += 15; factors.push("bollinger_lower_band"); }

  if (Math.abs(price - ema9) > atr * 1.5) { score += 10; factors.push("ema_deviation_extended"); }

  const emaCrossBear = ema9 < ema21 && ema9Prev >= ema21Prev;
  const emaCrossBull = ema9 > ema21 && ema9Prev <= ema21Prev;
  if (direction === "FALL" && emaCrossBear) { score += 10; factors.push("ema_crossover_bearish"); }
  if (direction === "RISE" && emaCrossBull) { score += 10; factors.push("ema_crossover_bullish"); }

  const srLevels = detectSwingLevels(candles.slice(-100));
  if (srLevels.some((lv) => Math.abs(price - lv) <= 5)) { score += 15; factors.push("sr_zone_proximity"); }

  const cB = pattern.candleB;
  const cA = pattern.candleA;
  const bodyB = Math.abs(cB.close - cB.open);
  const bodyA = Math.abs(cA.close - cA.open);
  const rangeB = cB.high - cB.low;
  if (bodyB > bodyA) { score += 5; factors.push("rejection_body_larger"); }
  const wickInDir = direction === "FALL"
    ? (cB.high - Math.max(cB.open, cB.close))
    : (Math.min(cB.open, cB.close) - cB.low);
  if (rangeB > 0 && wickInDir / rangeB > 0.6) { score += 5; factors.push("rejection_wick_strong"); }

  const last10 = candles.slice(-10);
  if (last10.length >= 2) {
    const totalMove = Math.abs(last10[last10.length - 1].close - last10[0].open);
    if (totalMove > atr * 2) { score += 10; factors.push("exhaustion_reversal"); }
  }

  if (pattern.equalCount && pattern.equalCount >= 3) { score += 10; factors.push("triple_equal_levels"); }
  if (pattern.equalCount && pattern.equalCount >= 4) { score += 5; factors.push("quadruple_equal_levels"); }

  const hour = new Date().getUTCHours();
  if (getHighReversalHours().includes(hour)) { score += 5; factors.push("high_reversal_time_window"); }

  if (existingAnalyzerDirection === direction) { score += 10; factors.push("existing_analyzer_agrees"); }

  return { score: Math.min(100, score), factors };
}

export function classifySignal(confidence: number): { strength: string; recommendedDuration: string; shouldAlert: boolean } {
  if (confidence >= 80) return { strength: "Strong", recommendedDuration: "15min", shouldAlert: true };
  if (confidence >= 60) return { strength: "Moderate", recommendedDuration: "5-6min", shouldAlert: true };
  if (confidence >= 45) return { strength: "Weak", recommendedDuration: "3min", shouldAlert: false };
  return { strength: "No Trade", recommendedDuration: "Skip", shouldAlert: false };
}

export function calculateLevels(pattern: MicroReversalResult, atr: number): { sl: number; tp1: number; tp2: number } {
  const entry = pattern.entryPrice;
  if (pattern.direction === "FALL") {
    const sl = pattern.levelPrice + atr * 0.3;
    const risk = Math.abs(entry - sl);
    return { sl: +sl.toFixed(2), tp1: +(entry - risk).toFixed(2), tp2: +(entry - risk * 2).toFixed(2) };
  }
  const sl = pattern.levelPrice - atr * 0.3;
  const risk = Math.abs(entry - sl);
  return { sl: +sl.toFixed(2), tp1: +(entry + risk).toFixed(2), tp2: +(entry + risk * 2).toFixed(2) };
}

// ── Master scanner ───────────────────────────────────────────
export function runMicroReversalScanner(
  candles: Candle[],
  atr: number,
  ema9: number,
  ema21: number,
  ema9Prev: number,
  ema21Prev: number,
  bbUpper: number,
  bbLower: number,
  existingAnalyzerDirection: string | null,
  settings: MicroReversalSettings,
): MicroReversalSignal | null {
  if (!settings.enabled) return null;
  const tol = getTolerance(atr, settings);

  const detections = [
    settings.enableEqualHighs ? detectEqualHighsBearish(candles, atr, tol) : null,
    settings.enableEqualLows ? detectEqualLowsBullish(candles, atr, tol) : null,
    settings.enableBreakdown ? detectEqualLowsBreakdown(candles, atr, tol) : null,
    settings.enableBreakout ? detectEqualHighsBreakout(candles, atr, tol) : null,
  ].filter(Boolean) as MicroReversalResult[];

  if (detections.length === 0) return null;

  const reversals = detections.filter((d) => d.patternType.includes("reversal"));
  const pattern = reversals.length > 0 ? reversals[0] : detections[0];

  const { score, factors } = computeConfluenceScore(
    pattern, candles, atr, ema9, ema21, ema9Prev, ema21Prev, bbUpper, bbLower, existingAnalyzerDirection,
  );

  let finalScore = score;
  let crossConfirmed = false;
  let counterTrend = false;
  if (existingAnalyzerDirection === pattern.direction) {
    crossConfirmed = true;
  } else if (existingAnalyzerDirection !== null && existingAnalyzerDirection !== "WAIT") {
    counterTrend = true;
    finalScore = Math.max(0, finalScore - 15);
  }

  if (settings.requireCrossConfirmation && !crossConfirmed) return null;
  if (finalScore < settings.minConfidence) return null;

  const cls = classifySignal(finalScore);
  if (cls.strength === "No Trade") return null;

  const dur = settings.tradeDuration === "auto" ? cls.recommendedDuration : settings.tradeDuration;
  const levels = calculateLevels(pattern, atr);
  const now = Date.now();

  return {
    timestamp: new Date(now).toISOString(),
    ts: now,
    instrument: "Volatility_75_Index",
    timeframe: "1m",
    module: "micro_reversal_scanner",
    direction: pattern.direction,
    patternType: pattern.patternType,
    confidence: finalScore,
    strength: cls.strength,
    recommendedDuration: dur,
    entryPrice: pattern.entryPrice,
    candleA: pattern.candleA,
    candleB: pattern.candleB,
    candleC: pattern.candleC,
    levelPrice: pattern.levelPrice,
    toleranceUsed: pattern.toleranceUsed,
    confluenceFactors: factors,
    suggestedSL: levels.sl,
    suggestedTP1: levels.tp1,
    suggestedTP2: levels.tp2,
    riskRewardRatio: "1:2",
    existingAnalyzerDirection,
    crossConfirmed,
    counterTrend,
    shouldAlert: cls.shouldAlert && finalScore >= settings.alertMinConfidence,
    indicators: { ema9, ema21, bbUpper, bbLower, atr },
    outcome: "PENDING",
  };
}

// ── Audio alert (distinct 2-tone) ────────────────────────────
let _audioCtx: AudioContext | null = null;
export function playMicroReversalChime(direction: MRDirection) {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    if (!_audioCtx) _audioCtx = new Ctx();
    const ctx = _audioCtx!;
    const freq = direction === "RISE" ? 880 : 440;
    const playBeep = (offset: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.2);
    };
    playBeep(0);
    playBeep(0.25);
  } catch (e) {
    // silent failure
  }
}

// ── Telegram alert ───────────────────────────────────────────
export async function sendTelegramAlert(signal: MicroReversalSignal, token: string, chatId: string): Promise<void> {
  if (!token || !chatId) return;
  const emoji = signal.direction === "RISE" ? "🟢" : "🔴";
  const time = new Date(signal.ts).toISOString().slice(11, 19) + " UTC";
  const text =
    `${emoji} V75 ${signal.direction} SIGNAL\n` +
    `⏰ ${time} | Confidence: ${signal.confidence}% (${signal.strength})\n` +
    `📍 Entry: ${signal.entryPrice.toFixed(2)}\n` +
    `🎯 TP1: ${signal.suggestedTP1.toFixed(2)} | TP2: ${signal.suggestedTP2.toFixed(2)}\n` +
    `🛑 SL: ${signal.suggestedSL.toFixed(2)}\n` +
    `⏱ Duration: ${signal.recommendedDuration}\n` +
    (signal.crossConfirmed ? "✅ Cross-confirmed\n" : "") +
    `Confluence: ${signal.confluenceFactors.join(", ")}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.warn("[MR] Telegram send failed", e);
  }
}

// ── Settings persistence ─────────────────────────────────────
const SETTINGS_KEY = "v75_micro_reversal_settings";
export function loadMRSettings(): MicroReversalSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_MR_SETTINGS };
    return { ...DEFAULT_MR_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_MR_SETTINGS };
  }
}
export function saveMRSettings(s: MicroReversalSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

// ── Backtest engine ──────────────────────────────────────────
export interface BacktestResult {
  totalSignals: number;
  above45: number;
  above60: number;
  above80: number;
  byPattern: Record<MRPatternType, { total: number; wins3: number; wins6: number; wins15: number }>;
  byHour: Record<number, { total: number; wins: number }>;
  threshold65WinRate: number;
  threshold75WinRate: number;
  equityCurve: { t: number; pnl: number }[];
  signals: { ts: number; direction: MRDirection; confidence: number; pattern: MRPatternType; outcome3: "WIN" | "LOSS"; outcome6: "WIN" | "LOSS"; outcome15: "WIN" | "LOSS" }[];
}

export function runBacktest(
  candles: Candle[],
  atrSeries: number[],
  ema9Series: number[],
  ema21Series: number[],
  bbUpperSeries: number[],
  bbLowerSeries: number[],
  settings: MicroReversalSettings,
): BacktestResult {
  const sigs: BacktestResult["signals"] = [];
  const byPattern: BacktestResult["byPattern"] = {
    equal_highs_bearish_reversal: { total: 0, wins3: 0, wins6: 0, wins15: 0 },
    equal_lows_bullish_reversal: { total: 0, wins3: 0, wins6: 0, wins15: 0 },
    equal_lows_breakdown_bearish: { total: 0, wins3: 0, wins6: 0, wins15: 0 },
    equal_highs_breakout_bullish: { total: 0, wins3: 0, wins6: 0, wins15: 0 },
  };
  const byHour: BacktestResult["byHour"] = {};
  let above45 = 0, above60 = 0, above80 = 0;
  let pnl = 0;
  const equityCurve: { t: number; pnl: number }[] = [];
  let above65Total = 0, above65Wins = 0, above75Total = 0, above75Wins = 0;

  for (let i = 30; i < candles.length - 15; i++) {
    const slice = candles.slice(0, i + 1);
    const atr = atrSeries[i] || 5;
    const ema9 = ema9Series[i];
    const ema21 = ema21Series[i];
    const ema9Prev = ema9Series[i - 3] || ema9;
    const ema21Prev = ema21Series[i - 3] || ema21;
    const bbU = bbUpperSeries[i] || candles[i].close;
    const bbL = bbLowerSeries[i] || candles[i].close;
    const sig = runMicroReversalScanner(slice, atr, ema9, ema21, ema9Prev, ema21Prev, bbU, bbL, null, settings);
    if (!sig) continue;

    const entry = sig.entryPrice;
    const dir = sig.direction;
    const c3 = candles[i + 3];
    const c6 = candles[i + 6];
    const c15 = candles[i + 15];
    const w3 = c3 ? ((dir === "RISE" && c3.close > entry) || (dir === "FALL" && c3.close < entry)) : false;
    const w6 = c6 ? ((dir === "RISE" && c6.close > entry) || (dir === "FALL" && c6.close < entry)) : false;
    const w15 = c15 ? ((dir === "RISE" && c15.close > entry) || (dir === "FALL" && c15.close < entry)) : false;

    const o3: "WIN" | "LOSS" = w3 ? "WIN" : "LOSS";
    const o6: "WIN" | "LOSS" = w6 ? "WIN" : "LOSS";
    const o15: "WIN" | "LOSS" = w15 ? "WIN" : "LOSS";

    const conf = sig.confidence;
    if (conf >= 45) above45++;
    if (conf >= 60) above60++;
    if (conf >= 80) above80++;
    if (conf >= 65) { above65Total++; if (w6) above65Wins++; }
    if (conf >= 75) { above75Total++; if (w6) above75Wins++; }

    const bp = byPattern[sig.patternType];
    bp.total++;
    if (w3) bp.wins3++;
    if (w6) bp.wins6++;
    if (w15) bp.wins15++;

    const hour = new Date(candles[i].time * 1000).getUTCHours();
    if (!byHour[hour]) byHour[hour] = { total: 0, wins: 0 };
    byHour[hour].total++;
    if (w6) byHour[hour].wins++;

    // Equity curve: $10 trade, 80% payout
    pnl += w6 ? 8 : -10;
    equityCurve.push({ t: candles[i].time, pnl });

    sigs.push({ ts: candles[i].time, direction: dir, confidence: conf, pattern: sig.patternType, outcome3: o3, outcome6: o6, outcome15: o15 });
  }

  return {
    totalSignals: sigs.length,
    above45, above60, above80,
    byPattern, byHour,
    threshold65WinRate: above65Total ? Math.round((above65Wins / above65Total) * 100) : 0,
    threshold75WinRate: above75Total ? Math.round((above75Wins / above75Total) * 100) : 0,
    equityCurve,
    signals: sigs,
  };
}