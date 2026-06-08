import { supabase } from "@/integrations/supabase/client";
import type { SegmentRecord, Signal } from "./types";

const QUEUE_KEY = "v75_offline_queue";

type QueueItem =
  | { kind: "segment"; payload: SegmentRecord }
  | { kind: "signal"; payload: Signal }
  | { kind: "outcome"; payload: { id: string; outcome: "WIN" | "LOSS"; exitPrice: number } };

const readQueue = (): QueueItem[] => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
};
const writeQueue = (q: QueueItem[]) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
const enqueue = (item: QueueItem) => writeQueue([...readQueue(), item]);

const segmentToRow = (s: SegmentRecord) => ({
  timestamp: s.timestamp,
  date_str: s.dateStr,
  time_str: s.timeStr,
  open_price: s.openPrice,
  close_price: s.closePrice,
  outcome: s.outcome,
  point_move: s.pointMove,
  score: s.score,
  adjusted_score: s.adjustedScore,
  rsi: s.rsi,
  stoch_k: s.stochK,
  stoch_d: s.stochD,
  macd_histogram: s.macdHistogram,
  williams_r: s.williamsR,
  cci: s.cci,
  bb_position: s.bbPosition,
  bb_width: s.bbWidth,
  atr: s.atr,
  relative_atr: s.relativeAtr,
  ema9: s.ema9, ema21: s.ema21, ema50: s.ema50, ema200: s.ema200,
  ema_alignment: s.emaAlignment,
  has_active_bob: s.hasActiveBOB,
  has_active_beob: s.hasActiveBEOB,
  ob_timeframe: s.obTimeframe,
  has_fvg_bull: s.hasFVGBull,
  has_fvg_bear: s.hasFVGBear,
  choch_detected: s.chochDetected,
  liquidity_sweep: s.liquiditySweep,
  h4_bias: s.h4Bias,
  h1_bias: s.h1Bias,
  top_down_alignment: s.topDownAlignment,
  candle_pattern: s.candlePattern,
  structure: s.structure,
  rsi_divergence: s.rsiDivergence,
  macd_divergence: s.macdDivergence,
  hour_of_day: s.hourOfDay,
  day_of_week: s.dayOfWeek,
  dominant_pattern: s.dominantPattern ?? "NONE",
  pattern_score: s.patternScore ?? 0,
  pattern_direction: s.patternDirection ?? "NEUTRAL",
  m15_bias: s.m15Bias ?? "NEUTRAL",
});

const signalToRow = (s: Signal) => ({
  timestamp: s.timestamp,
  direction: s.direction,
  strength: s.strength,
  confidence: s.confidence,
  score: s.score,
  adjusted_score: s.adjustedScore,
  duration_minutes: s.durations.primary,
  entry_price: s.entryPrice,
  outcome: "PENDING" as const,
  choch_present: s.smc.choch,
  sweep_present: s.smc.sweep,
  ob_timeframe: s.smc.obTimeframe,
  h4_bias: s.topDown.h4,
  h1_bias: s.topDown.h1,
  pattern_match_rate: s.patternMatchRate,
});

export const saveSegment = async (rec: SegmentRecord) => {
  try {
    const { error } = await supabase.from("v75_segment_records").insert(segmentToRow(rec));
    if (error) throw error;
  } catch {
    enqueue({ kind: "segment", payload: rec });
  }
};

export const saveSignal = async (s: Signal) => {
  try {
    const { error } = await supabase.from("v75_signal_history").insert({ ...signalToRow(s), id: s.id });
    if (error) throw error;
  } catch {
    enqueue({ kind: "signal", payload: s });
  }
};

export const updateSignalOutcome = async (id: string, outcome: "WIN" | "LOSS", exitPrice: number) => {
  try {
    const { error } = await supabase
      .from("v75_signal_history")
      .update({ outcome, exit_price: exitPrice })
      .eq("id", id);
    if (error) throw error;
  } catch {
    enqueue({ kind: "outcome", payload: { id, outcome, exitPrice } });
  }
};

export const loadSegments = async (limit = 500): Promise<SegmentRecord[]> => {
  try {
    const { data, error } = await supabase
      .from("v75_segment_records")
      .select("*")
      .order("timestamp", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data.map((r: any): SegmentRecord => ({
      timestamp: Number(r.timestamp),
      dateStr: r.date_str,
      timeStr: r.time_str,
      openPrice: +r.open_price,
      closePrice: +r.close_price,
      outcome: r.outcome,
      pointMove: +r.point_move,
      score: r.score,
      adjustedScore: r.adjusted_score ?? r.score,
      rsi: +r.rsi, stochK: +r.stoch_k, stochD: +r.stoch_d,
      macdHistogram: +r.macd_histogram, williamsR: +r.williams_r, cci: +r.cci,
      bbPosition: +r.bb_position, bbWidth: +r.bb_width,
      atr: +r.atr, relativeAtr: +r.relative_atr,
      ema9: +r.ema9, ema21: +r.ema21, ema50: +r.ema50, ema200: +r.ema200,
      emaAlignment: r.ema_alignment,
      hasActiveBOB: r.has_active_bob, hasActiveBEOB: r.has_active_beob,
      obTimeframe: r.ob_timeframe,
      hasFVGBull: r.has_fvg_bull, hasFVGBear: r.has_fvg_bear,
      chochDetected: r.choch_detected, liquiditySweep: r.liquidity_sweep,
      h4Bias: r.h4_bias, h1Bias: r.h1_bias,
      topDownAlignment: r.top_down_alignment,
      candlePattern: r.candle_pattern, structure: r.structure,
      rsiDivergence: r.rsi_divergence, macdDivergence: r.macd_divergence,
      hourOfDay: r.hour_of_day, dayOfWeek: r.day_of_week,
      dominantPattern: r.dominant_pattern ?? "NONE",
      patternScore: r.pattern_score ?? 0,
      patternDirection: r.pattern_direction ?? "NEUTRAL",
      m15Bias: r.m15_bias ?? "NEUTRAL",
    }));
  } catch { return []; }
};

export const loadSignals = async (limit = 50) => {
  try {
    const { data, error } = await supabase
      .from("v75_signal_history")
      .select("*")
      .order("timestamp", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data;
  } catch { return []; }
};

export const flushQueue = async () => {
  const q = readQueue();
  if (!q.length) return;
  const remain: QueueItem[] = [];
  for (const it of q) {
    try {
      if (it.kind === "segment") {
        const { error } = await supabase.from("v75_segment_records").insert(segmentToRow(it.payload));
        if (error) throw error;
      } else if (it.kind === "signal") {
        const { error } = await supabase.from("v75_signal_history").insert({ ...signalToRow(it.payload), id: it.payload.id });
        if (error) throw error;
      } else {
        const { error } = await supabase.from("v75_signal_history")
          .update({ outcome: it.payload.outcome, exit_price: it.payload.exitPrice })
          .eq("id", it.payload.id);
        if (error) throw error;
      }
    } catch {
      remain.push(it);
    }
  }
  writeQueue(remain);
};

// ─── Adaptive condition weights ──────────────────────────────────────────

export type WeightMap = Record<string, number>;

export const loadWeights = async (): Promise<WeightMap> => {
  try {
    const { data, error } = await supabase
      .from("v75_condition_stats")
      .select("condition_name, weight_multiplier, total, accuracy");
    if (error || !data) return {};
    const out: WeightMap = {};
    for (const r of data as any[]) {
      out[r.condition_name] = Number(r.weight_multiplier ?? 1);
    }
    return out;
  } catch {
    return {};
  }
};

export const loadConditionStats = async () => {
  try {
    const { data, error } = await supabase
      .from("v75_condition_stats")
      .select("*");
    if (error || !data) return [];
    return data as any[];
  } catch { return []; }
};

/** Update accumulated rise/fall wins for a list of conditions and recompute
 *  weight_multiplier. Called from the browser when an outcome resolves. */
export const bumpConditions = async (
  conditions: string[],
  outcome: "RISE" | "FALL" | "FLAT",
) => {
  for (const name of conditions) {
    try {
      const { data } = await supabase
        .from("v75_condition_stats")
        .select("*")
        .eq("condition_name", name)
        .maybeSingle();
      const riseWins = (data?.rise_wins ?? 0) + (outcome === "RISE" ? 1 : 0);
      const fallWins = (data?.fall_wins ?? 0) + (outcome === "FALL" ? 1 : 0);
      const total = (data?.total ?? 0) + 1;
      const accuracy = total ? (Math.max(riseWins, fallWins) / total) * 100 : 0;
      let weight_multiplier = 1.0;
      if (total >= 30) {
        if (accuracy >= 85) weight_multiplier = 1.5;
        else if (accuracy >= 75) weight_multiplier = 1.3;
        else if (accuracy >= 65) weight_multiplier = 1.1;
        else if (accuracy < 50) weight_multiplier = 0.6;
      }
      await supabase.from("v75_condition_stats").upsert(
        {
          condition_name: name,
          rise_wins: riseWins,
          fall_wins: fallWins,
          total,
          accuracy: +accuracy.toFixed(2),
          weight_multiplier,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "condition_name" },
      );
    } catch {
      /* ignore — best-effort */
    }
  }
};