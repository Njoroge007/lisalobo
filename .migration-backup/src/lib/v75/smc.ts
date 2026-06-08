import type { Candle, OrderBlock, FVG, SMCState } from "./types";
import { atr } from "./indicators";

export const detectOrderBlocks = (
  candles: Candle[],
  tf: "M1" | "M5" | "M15" | "H1" | "H4",
): OrderBlock[] => {
  const out: OrderBlock[] = [];
  if (candles.length < 30) return out;
  const a = atr(candles, 14);
  const n = candles.length;
  for (let i = 5; i < n - 4; i++) {
    const atrV = a[i] || 0;
    if (!atrV) continue;
    // Bullish OB: bearish candle then 3+ bullish candles, total move >= 3*ATR
    if (candles[i].close < candles[i].open) {
      let bulls = 0, move = 0;
      for (let j = i + 1; j < Math.min(i + 6, n); j++) {
        if (candles[j].close > candles[j].open) {
          bulls++;
          move += candles[j].close - candles[j].open;
        } else break;
      }
      if (bulls >= 3 && move >= 3 * atrV) {
        // mitigation: any close below low after?
        let mitigated = false;
        for (let j = i + bulls + 1; j < n; j++) {
          if (candles[j].close < candles[i].low) { mitigated = true; break; }
        }
        out.push({
          type: "BULL", low: candles[i].low, high: candles[i].high,
          time: candles[i].time, timeframe: tf, mitigated,
        });
      }
    }
    // Bearish OB
    if (candles[i].close > candles[i].open) {
      let bears = 0, move = 0;
      for (let j = i + 1; j < Math.min(i + 6, n); j++) {
        if (candles[j].close < candles[j].open) {
          bears++;
          move += candles[j].open - candles[j].close;
        } else break;
      }
      if (bears >= 3 && move >= 3 * atrV) {
        let mitigated = false;
        for (let j = i + bears + 1; j < n; j++) {
          if (candles[j].close > candles[i].high) { mitigated = true; break; }
        }
        out.push({
          type: "BEAR", low: candles[i].low, high: candles[i].high,
          time: candles[i].time, timeframe: tf, mitigated,
        });
      }
    }
  }
  return out.slice(-20);
};

export const detectFVGs = (candles: Candle[]): FVG[] => {
  const out: FVG[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c3 = candles[i];
    if (c1.high < c3.low) {
      let mitigated = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].close > c1.high && candles[j].close < c3.low) { mitigated = true; break; }
      }
      out.push({ type: "BULL", low: c1.high, high: c3.low, time: c3.time, mitigated });
    } else if (c1.low > c3.high) {
      let mitigated = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].close < c1.low && candles[j].close > c3.high) { mitigated = true; break; }
      }
      out.push({ type: "BEAR", low: c3.high, high: c1.low, time: c3.time, mitigated });
    }
  }
  return out.filter((f) => !f.mitigated).slice(-10);
};

export const findSwings = (candles: Candle[], lr = 3) => {
  const highs: { i: number; price: number }[] = [];
  const lows: { i: number; price: number }[] = [];
  for (let i = lr; i < candles.length - lr; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ i, price: candles[i].high });
    if (isLow) lows.push({ i, price: candles[i].low });
  }
  return { highs, lows };
};

export const detectCHoCH = (candles: Candle[]): "BULL" | "BEAR" | "NONE" => {
  const { highs, lows } = findSwings(candles, 3);
  if (highs.length < 2 || lows.length < 2) return "NONE";
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  const prevHigh = highs[highs.length - 2];
  const last = candles[candles.length - 1];
  // Uptrend (HH+HL) broken below last HL = bearish CHoCH
  if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price && last.close < lastLow.price) return "BEAR";
  // Downtrend (LH+LL) broken above last LH = bullish CHoCH
  if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price && last.close > lastHigh.price) return "BULL";
  return "NONE";
};

export const detectLiquiditySweep = (candles: Candle[]): "BULL" | "BEAR" | "NONE" => {
  const { highs, lows } = findSwings(candles.slice(0, -1), 3);
  if (!highs.length || !lows.length) return "NONE";
  const last = candles[candles.length - 1];
  const lastLow = lows[lows.length - 1].price;
  const lastHigh = highs[highs.length - 1].price;
  if (last.low < lastLow && last.close > lastLow) return "BULL";
  if (last.high > lastHigh && last.close < lastHigh) return "BEAR";
  return "NONE";
};

export const computeSMC = (
  candles: Candle[],
  tf: "M1" | "M5" | "M15" | "H1" | "H4" = "M1",
): SMCState => {
  const orderBlocks = detectOrderBlocks(candles, tf).filter((o) => !o.mitigated);
  const fvgs = detectFVGs(candles);
  const { highs, lows } = findSwings(candles, 3);
  const price = candles[candles.length - 1].close;
  const bobs = orderBlocks.filter((o) => o.type === "BULL").sort((a, b) => Math.abs(price - (a.high + a.low) / 2) - Math.abs(price - (b.high + b.low) / 2));
  const beobs = orderBlocks.filter((o) => o.type === "BEAR").sort((a, b) => Math.abs(price - (a.high + a.low) / 2) - Math.abs(price - (b.high + b.low) / 2));
  return {
    orderBlocks,
    fvgs,
    choch: detectCHoCH(candles),
    bos: "NONE",
    liquiditySweep: detectLiquiditySweep(candles),
    supports: lows.slice(-5).map((l) => l.price).filter((p) => p < price).slice(-3),
    resistances: highs.slice(-5).map((h) => h.price).filter((p) => p > price).slice(0, 3),
    nearestBOB: bobs[0] ?? null,
    nearestBEOB: beobs[0] ?? null,
  };
};

export const computeBias = (candles: Candle[], type: "EMA50" | "EMA9_21"): "BULL" | "BEAR" | "NEUTRAL" => {
  if (candles.length < 50) return "NEUTRAL";
  const closes = candles.map((c) => c.close);
  const k = (p: number) => 2 / (p + 1);
  const calcEma = (period: number) => {
    let v = closes[0];
    const kk = k(period);
    for (let i = 1; i < closes.length; i++) v = closes[i] * kk + v * (1 - kk);
    return v;
  };
  const price = closes[closes.length - 1];
  if (type === "EMA50") {
    const e50 = calcEma(50);
    if (price > e50 * 1.0005) return "BULL";
    if (price < e50 * 0.9995) return "BEAR";
    return "NEUTRAL";
  }
  const e9 = calcEma(9), e21 = calcEma(21);
  if (e9 > e21 * 1.0002) return "BULL";
  if (e9 < e21 * 0.9998) return "BEAR";
  return "NEUTRAL";
};