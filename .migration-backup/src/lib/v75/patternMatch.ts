import type { SegmentRecord } from "./types";

export interface MatchResult {
  matches: SegmentRecord[];
  riseRate: number;
  fallRate: number;
  flatRate: number;
  dominant: "RISE" | "FALL" | "FLAT" | "NONE";
  dominantRate: number;
}

const num = (a: number, b: number, scale: number) =>
  Math.max(0, scale - (Math.abs(a - b) / scale) * scale);

export const findSimilar = (
  current: Omit<SegmentRecord, "outcome" | "pointMove" | "closePrice" | "timestamp" | "dateStr" | "timeStr" | "openPrice">,
  history: SegmentRecord[],
  minSim = 45,
  topN = 50,
): MatchResult => {
  const scored = history.map((h) => {
    let s = 0;
    if (h.emaAlignment === current.emaAlignment) s += 25;
    if (h.topDownAlignment === current.topDownAlignment) s += 20;
    if (h.chochDetected === current.chochDetected) s += 15;
    if (h.liquiditySweep === current.liquiditySweep) s += 15;
    if (h.obTimeframe === current.obTimeframe) s += 15;
    if (h.candlePattern === current.candlePattern) s += 10;
    if (h.structure === current.structure) s += 10;
    s += num(h.rsi, current.rsi, 15);
    s += num(h.score, current.score, 15);
    s += num(h.bbPosition * 100, current.bbPosition * 100, 10);
    s += num(h.stochK, current.stochK, 10);
    return { h, s };
  }).filter((x) => x.s >= minSim).sort((a, b) => b.s - a.s).slice(0, topN);

  const matches = scored.map((x) => x.h);
  const n = matches.length || 1;
  const r = matches.filter((m) => m.outcome === "RISE").length;
  const f = matches.filter((m) => m.outcome === "FALL").length;
  const fl = matches.filter((m) => m.outcome === "FLAT").length;
  const riseRate = (r / n) * 100;
  const fallRate = (f / n) * 100;
  const flatRate = (fl / n) * 100;
  let dominant: MatchResult["dominant"] = "NONE";
  let dominantRate = 0;
  if (riseRate >= fallRate && riseRate >= flatRate) { dominant = "RISE"; dominantRate = riseRate; }
  else if (fallRate >= flatRate) { dominant = "FALL"; dominantRate = fallRate; }
  else { dominant = "FLAT"; dominantRate = flatRate; }
  return { matches, riseRate, fallRate, flatRate, dominant, dominantRate };
};

export const hourStats = (history: SegmentRecord[]) => {
  const buckets: { hour: number; rise: number; fall: number; total: number; winRate: number }[] = [];
  for (let h = 0; h < 24; h++) {
    const hs = history.filter((x) => x.hourOfDay === h);
    const rise = hs.filter((x) => x.outcome === "RISE").length;
    const fall = hs.filter((x) => x.outcome === "FALL").length;
    const winRate = hs.length ? ((rise + fall) / hs.length) * 100 : 0;
    buckets.push({ hour: h, rise, fall, total: hs.length, winRate });
  }
  return buckets;
};

export const conditionAccuracy = (
  history: SegmentRecord[],
): { name: string; total: number; rise: number; fall: number; accuracy: number }[] => {
  const conditions = [
    "FULL_BULL_STACK", "FULL_BEAR_STACK",
    "BOB_H4", "BEOB_H4", "BOB_H1", "BEOB_H1", "BOB_M1", "BEOB_M1",
    "BULL_CHOCH", "BEAR_CHOCH", "BULL_SWEEP", "BEAR_SWEEP",
    "BULL_FVG", "BEAR_FVG",
  ];
  return conditions.map((name) => {
    const isBull = name.startsWith("FULL_BULL") || name.startsWith("BOB") || name.startsWith("BULL");
    const matches = history.filter((h) => {
      if (name.includes("STACK")) return h.emaAlignment === name;
      if (name === "BOB_H4" || name === "BOB_H1" || name === "BOB_M1")
        return h.hasActiveBOB && h.obTimeframe === name.split("_")[1];
      if (name === "BEOB_H4" || name === "BEOB_H1" || name === "BEOB_M1")
        return h.hasActiveBEOB && h.obTimeframe === name.split("_")[1];
      if (name === "BULL_CHOCH") return h.chochDetected === "BULL";
      if (name === "BEAR_CHOCH") return h.chochDetected === "BEAR";
      if (name === "BULL_SWEEP") return h.liquiditySweep === "BULL";
      if (name === "BEAR_SWEEP") return h.liquiditySweep === "BEAR";
      if (name === "BULL_FVG") return h.hasFVGBull;
      if (name === "BEAR_FVG") return h.hasFVGBear;
      return false;
    });
    const rise = matches.filter((m) => m.outcome === "RISE").length;
    const fall = matches.filter((m) => m.outcome === "FALL").length;
    const accuracy = matches.length
      ? ((isBull ? rise : fall) / matches.length) * 100
      : 0;
    return { name, total: matches.length, rise, fall, accuracy };
  });
};