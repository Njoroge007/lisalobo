import type { Candle, IndicatorSnapshot, SMCState, TopDownBias, ScoreBreakdown } from "./types";

export type WeightMap = Record<string, number>;

export const computeScore = (
  candles: Candle[],
  ind: IndicatorSnapshot,
  smc: SMCState,
  smcH1: SMCState,
  smcH4: SMCState,
  topDown: TopDownBias,
  weights: WeightMap = {},
): ScoreBreakdown => {
  const price = candles[candles.length - 1].close;
  const checks: { name: string; value: number; adjusted?: number; weight?: number; condition?: string }[] = [];
  const conditions: string[] = [];
  const add = (n: string, v: number, condition?: string) => {
    if (v === 0) return;
    const w = condition && weights[condition] ? weights[condition] : 1;
    let adj = v * w;
    if (adj > 4) adj = 4;
    if (adj < -4) adj = -4;
    checks.push({ name: n, value: v, adjusted: adj, weight: w, condition });
  };

  // Trend
  add("EMA9 vs EMA21", ind.ema9 > ind.ema21 ? 2 : ind.ema9 < ind.ema21 ? -2 : 0);
  add("EMA21 vs EMA50", ind.ema21 > ind.ema50 ? 2 : ind.ema21 < ind.ema50 ? -2 : 0);
  add("Price vs EMA200", price > ind.ema200 ? 1 : -1);
  add("EMA50 vs EMA200", ind.ema50 > ind.ema200 ? 1 : -1);
  const fullBull = ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50 && ind.ema50 > ind.ema200;
  const fullBear = ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50 && ind.ema50 < ind.ema200;
  if (fullBull) { conditions.push("FULL_BULL_STACK"); add("Full Bull stack", 2, "FULL_BULL_STACK"); }
  else if (fullBear) { conditions.push("FULL_BEAR_STACK"); add("Full Bear stack", -2, "FULL_BEAR_STACK"); }

  // RSI
  const r = ind.rsi;
  let rsiV = 0;
  let rsiCond: string | undefined;
  if (r < 20) { rsiV = 2; conditions.push("RSI_BELOW_20"); rsiCond = "RSI_BELOW_20"; }
  else if (r < 30) rsiV = 1;
  else if (r < 40) rsiV = 0;
  else if (r < 50) rsiV = -1;
  else if (r < 60) rsiV = 1;
  else if (r < 70) rsiV = 0;
  else if (r < 80) rsiV = -1;
  else { rsiV = -2; conditions.push("RSI_ABOVE_80"); rsiCond = "RSI_ABOVE_80"; }
  add("RSI zone", rsiV, rsiCond);

  if (ind.rsiDivergence === "BULL") { conditions.push("RSI_BULL_DIV"); add("RSI Bull Div", 2, "RSI_BULL_DIV"); }
  else if (ind.rsiDivergence === "BEAR") { conditions.push("RSI_BEAR_DIV"); add("RSI Bear Div", -2, "RSI_BEAR_DIV"); }

  // Stoch
  const sk = ind.stochK, sd = ind.stochD;
  if (sk > sd && sk < 20) { conditions.push("STOCH_OVERSOLD"); add("Stoch bull cross OS", 2, "STOCH_OVERSOLD"); }
  else if (sk < sd && sk > 80) { conditions.push("STOCH_OVERBOUGHT"); add("Stoch bear cross OB", -2, "STOCH_OVERBOUGHT"); }
  else if (sk < 20) add("Stoch OS", 1);
  else if (sk > 80) add("Stoch OB", -1);

  // MACD
  if (ind.macdLine > ind.macdSignal && ind.macdHist > 0) { conditions.push("MACD_BULL"); add("MACD bull", 2, "MACD_BULL"); }
  else if (ind.macdLine < ind.macdSignal && ind.macdHist < 0) { conditions.push("MACD_BEAR"); add("MACD bear", -2, "MACD_BEAR"); }
  else if (ind.macdHist > 0) add("MACD hist+", 1);
  else if (ind.macdHist < 0) add("MACD hist-", -1);

  // Williams %R
  add("Williams %R", ind.williamsR < -80 ? 1 : ind.williamsR > -20 ? -1 : 0);

  // CCI
  if (ind.cci < -150) add("CCI extreme OS", 2);
  else if (ind.cci < -100) add("CCI OS", 1);
  else if (ind.cci > 150) add("CCI extreme OB", -2);
  else if (ind.cci > 100) add("CCI OB", -1);

  // BB position
  if (price < ind.bbLower) add("Below BB lower", 1);
  else if (price > ind.bbUpper) add("Above BB upper", -1);

  // Order Blocks
  const inBox = (p: number, lo: number, hi: number) => p >= lo && p <= hi;
  const near = (p: number, lo: number, hi: number, dist: number) =>
    Math.min(Math.abs(p - lo), Math.abs(p - hi)) <= dist;
  const atrDist = ind.atr * 5;
  let obDone = false;
  for (const ob of [...smcH4.orderBlocks, ...smcH1.orderBlocks]) {
    if (ob.mitigated) continue;
    if (inBox(price, ob.low, ob.high)) {
      if (ob.type === "BULL") { add(`Price inside ${ob.timeframe} BOB`, 3); conditions.push(`BOB_${ob.timeframe}`); }
      else { add(`Price inside ${ob.timeframe} BEOB`, -3); conditions.push(`BEOB_${ob.timeframe}`); }
      obDone = true; break;
    }
  }
  if (!obDone) {
    for (const ob of smc.orderBlocks) {
      if (ob.mitigated) continue;
      if (inBox(price, ob.low, ob.high)) {
        if (ob.type === "BULL") { add("M1 BOB", 2); conditions.push("BOB_M1"); }
        else { add("M1 BEOB", -2); conditions.push("BEOB_M1"); }
        obDone = true; break;
      }
      if (near(price, ob.low, ob.high, atrDist)) {
        add(ob.type === "BULL" ? "Near BOB" : "Near BEOB", ob.type === "BULL" ? 1 : -1);
        obDone = true; break;
      }
    }
  }

  // S/R proximity
  const nearS = smc.supports[smc.supports.length - 1];
  const nearR = smc.resistances[0];
  if (nearS && nearR) {
    add("S/R proximity", Math.abs(price - nearS) < Math.abs(price - nearR) ? 1 : -1);
  }

  // Liquidity sweep
  if (smc.liquiditySweep === "BULL") { conditions.push("BULL_SWEEP"); add("Bull sweep", 2, "BULL_SWEEP"); }
  else if (smc.liquiditySweep === "BEAR") { conditions.push("BEAR_SWEEP"); add("Bear sweep", -2, "BEAR_SWEEP"); }

  // CHoCH
  if (smc.choch === "BULL") { conditions.push("BULL_CHOCH"); add("Bull CHoCH", 2, "BULL_CHOCH"); }
  else if (smc.choch === "BEAR") { conditions.push("BEAR_CHOCH"); add("Bear CHoCH", -2, "BEAR_CHOCH"); }

  // FVG
  const bullFvg = smc.fvgs.find((f) => f.type === "BULL" && price >= f.low && price <= f.high);
  const bearFvg = smc.fvgs.find((f) => f.type === "BEAR" && price >= f.low && price <= f.high);
  if (bullFvg) { conditions.push("BULL_FVG"); add("In Bull FVG", 1, "BULL_FVG"); }
  if (bearFvg) { conditions.push("BEAR_FVG"); add("In Bear FVG", -1, "BEAR_FVG"); }

  // Last 3 candle structure
  const last3 = candles.slice(-3);
  if (last3.length === 3) {
    if (last3[0].low < last3[1].low && last3[1].low < last3[2].low) add("Higher lows", 1);
    else if (last3[0].high > last3[1].high && last3[1].high > last3[2].high) add("Lower highs", -1);
  }

  // Wick rejection on last closed candle
  const lc = candles[candles.length - 1];
  if (lc && ind.atr > 0) {
    const upperWick = lc.high - Math.max(lc.open, lc.close);
    const lowerWick = Math.min(lc.open, lc.close) - lc.low;
    if (lowerWick > ind.atr * 0.5) add("Bull wick rejection", 1);
    if (upperWick > ind.atr * 0.5) add("Bear wick rejection", -1);
  }

  // Top-down alignment
  if (topDown.alignment === "ALIGNED_BULL") { conditions.push("TOP_DOWN_ALIGNED"); add("Top-down aligned bull", 3, "TOP_DOWN_ALIGNED"); }
  else if (topDown.alignment === "ALIGNED_BEAR") { conditions.push("TOP_DOWN_ALIGNED"); add("Top-down aligned bear", -3, "TOP_DOWN_ALIGNED"); }
  else if (topDown.alignment === "OPPOSED") add("Top-down opposed", 0);

  const total = Math.max(-20, Math.min(20, checks.reduce((s, c) => s + c.value, 0)));
  const adjusted = Math.max(-20, Math.min(20, Math.round(checks.reduce((s, c) => s + (c.adjusted ?? c.value), 0))));
  const reasons = conditions.slice();
  return { total, adjusted, checks, reasons, conditions };
};

export const tierFromScore = (s: number): 1 | 2 | 3 | 4 => {
  const a = Math.abs(s);
  if (a >= 17) return 1;
  if (a >= 13) return 2;
  if (a >= 10) return 3;
  return 4;
};

export const directionFromScore = (s: number): "RISE" | "FALL" | "NONE" => {
  if (s >= 4) return "RISE";
  if (s <= -4) return "FALL";
  return "NONE";
};

export const strengthFromScore = (s: number): "Strong" | "Moderate" =>
  Math.abs(s) >= 7 ? "Strong" : "Moderate";

export const confidenceFromScore = (s: number): number =>
  Math.round((Math.min(Math.abs(s), 20) / 20) * 100);