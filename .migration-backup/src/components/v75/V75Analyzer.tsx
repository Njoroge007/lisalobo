import { useEffect, useMemo, useRef, useState } from "react";
import { DerivClient, type ConnState } from "@/lib/v75/deriv";
import type { Candle, Signal, SegmentRecord, TopDownBias } from "@/lib/v75/types";
import { computeIndicators, detectCandlePattern } from "@/lib/v75/indicators";
import { ema as emaSeries, rsi as rsiSeries, macd as macdSeries, atr as atrSeries } from "@/lib/v75/indicators";
import { hmmManager, type RegimeState } from "@/lib/v75/hmmRegimeManager";
import { computeSMC, computeBias } from "@/lib/v75/smc";
import { computeScore, tierFromScore, directionFromScore, strengthFromScore, confidenceFromScore } from "@/lib/v75/scoring";
import { findSimilar, hourStats, conditionAccuracy } from "@/lib/v75/patternMatch";
import { saveSegment, saveSignal, updateSignalOutcome, loadSegments, loadSignals, flushQueue, loadWeights, bumpConditions, loadConditionStats, type WeightMap } from "@/lib/v75/storage";
import { detectAllPatterns, getPatternScore, scanPatternHistory, type PatternResult, colorForSignal } from "@/lib/v75/candlePatterns";
import { detectMicroTrend, detectReversal, frequencyTarget, type MicroTrendSnapshot, type MicroTrend, type LayerVerdict } from "@/lib/v75/microTrend";
import {
  runMicroReversalScanner,
  runBacktest as runMRBacktest,
  loadMRSettings, saveMRSettings,
  playMicroReversalChime, sendTelegramAlert,
  type MicroReversalSignal, type MicroReversalSettings, type BacktestResult,
} from "@/lib/v75/microReversal";
import { bollinger as bollingerSeries } from "@/lib/v75/indicators";
import { supabase } from "@/integrations/supabase/client";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { V75Chart } from "./V75Chart";
import { MT5CopyPanel } from "./MT5CopyPanel";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Tab = "signals" | "chart" | "pattern" | "learning" | "history" | "backtest";
type TF = "M1" | "M5" | "M15" | "H1" | "H4";
type DailyBias = "STRONG_BULL" | "BULL" | "NEUTRAL" | "BEAR" | "STRONG_BEAR";
type CondStat = { name: string; accuracy: number; total: number };

const computeDailyBias = (recs: SegmentRecord[]): { bias: DailyBias; rises: number; falls: number; total: number } => {
  const today = new Date().toISOString().slice(0, 10);
  const todays = recs.filter((s) => s.dateStr === today);
  const rises = todays.filter((s) => s.outcome === "RISE").length;
  const falls = todays.filter((s) => s.outcome === "FALL").length;
  const total = rises + falls;
  if (todays.length < 4 || total === 0) return { bias: "NEUTRAL", rises, falls, total };
  const fr = falls / total, rr = rises / total;
  if (fr >= 0.65) return { bias: "STRONG_BEAR", rises, falls, total };
  if (fr >= 0.55) return { bias: "BEAR", rises, falls, total };
  if (rr >= 0.65) return { bias: "STRONG_BULL", rises, falls, total };
  if (rr >= 0.55) return { bias: "BULL", rises, falls, total };
  return { bias: "NEUTRAL", rises, falls, total };
};

const computeRecentTrendBias = (recs: SegmentRecord[]): { bias: number; last5: SegmentRecord[] } => {
  const last5 = recs.slice(0, 5);
  if (last5.length < 3) return { bias: 0, last5 };
  const r = last5.filter((s) => s.outcome === "RISE").length;
  const f = last5.filter((s) => s.outcome === "FALL").length;
  let bias = 0;
  if (f >= 4) bias = -2;
  else if (r >= 4) bias = 2;
  else if (f >= 3) bias = -1;
  else if (r >= 3) bias = 1;
  return { bias, last5 };
};

export function V75Analyzer() {
  const [tab, setTab] = useState<Tab>("signals");
  const [chartTF, setChartTF] = useState<TF>("M15");
  const [conn, setConn] = useState<ConnState>("connecting");
  const [price, setPrice] = useState<number>(0);
  const [prevPrice, setPrevPrice] = useState<number>(0);
  const [lastTickMs, setLastTickMs] = useState<number>(Date.now());
  const [m1, setM1] = useState<Candle[]>([]);
  const [m5, setM5] = useState<Candle[]>([]);
  const [m15, setM15] = useState<Candle[]>([]);
  const [h1, setH1] = useState<Candle[]>([]);
  const [h4, setH4] = useState<Candle[]>([]);
  const [history, setHistory] = useState<SegmentRecord[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [weights, setWeights] = useState<WeightMap>({});
  const [condStats, setCondStats] = useState<Record<string, CondStat>>({});
  const [suppression, setSuppression] = useState<string>("");
  const lastSignalRef = useRef<{ score: number; ts: number; dir: string; candleIdx: number } | null>(null);
  const closedCandleCount = useRef<number>(0);
  const lastClosedM1Time = useRef<number>(0);
  const lastSeenM1Time = useRef<number>(0);
  const segmentStartRef = useRef<{ price: number; ts: number; snap: any } | null>(null);
  const lossBreakUntil = useRef<number>(0);

  // ── Micro trend / Tier A state ────────────────────────────
  type TierASignal = {
    id: string;
    timestamp: number;
    direction: "RISE" | "FALL";
    state: MicroTrend["state"];
    strength: number;
    duration: number;
    entryScore: number;
    entryPrice: number;
    sl: number;
    tp1: number;
    tp2: number;
    reason: string;
    isReversal: boolean;
    exhausting: boolean;
    outcome?: "WIN" | "LOSS" | "PENDING";
    exitPrice?: number;
    hmmState?: string;
    hmmConfidence?: number;
    isRegimeChange?: boolean;
  };
  const [tierA, setTierA] = useState<TierASignal[]>([]);
  const [trendHistory, setTrendHistory] = useState<MicroTrendSnapshot[]>([]);
  const [enterAlert, setEnterAlert] = useState<{ id: string; direction: "RISE" | "FALL"; until: number } | null>(null);
  const [regime, setRegime] = useState<RegimeState | null>(null);
  const [regimeHistory, setRegimeHistory] = useState<{ time: number; state: string; duration: number; confidence: number; changedFrom?: string }[]>([]);
  const hmmBootstrapped = useRef(false);
  const microScoreHistoryRef = useRef<number[]>([]);
  const lastTierARef = useRef<{ ts: number; candleIdx: number; dir: "RISE" | "FALL" | "WAIT" }>({ ts: 0, candleIdx: -999, dir: "WAIT" });
  const lastTrendStateRef = useRef<{ state: MicroTrend["state"]; direction: "RISE" | "FALL" | "WAIT"; startTime: number; startCandle: number }>({ state: "NEUTRAL", direction: "WAIT", startTime: 0, startCandle: 0 });
  const neutralStreakRef = useRef<number>(0);

  // ── Micro-Reversal Scanner state ─────────────────────────
  const [mrSettings, setMrSettings] = useState<MicroReversalSettings>(() => loadMRSettings());
  const [mrSignals, setMrSignals] = useState<MicroReversalSignal[]>([]);
  const [mrCurrent, setMrCurrent] = useState<MicroReversalSignal | null>(null);
  const [mrFlash, setMrFlash] = useState<{ id: string; until: number; dir: "RISE" | "FALL" } | null>(null);
  const [mrSettingsOpen, setMrSettingsOpen] = useState(false);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [backtestRunning, setBacktestRunning] = useState(false);
  const mrLastTsRef = useRef<number>(0);
  const mrHourCountRef = useRef<{ hour: number; count: number }>({ hour: -1, count: 0 });

  const updateMRSettings = (patch: Partial<MicroReversalSettings>) => {
    setMrSettings((s) => { const next = { ...s, ...patch }; saveMRSettings(next); return next; });
  };

  // Load history on mount
  useEffect(() => {
    (async () => {
      const [segs, sigs, w, stats] = await Promise.all([loadSegments(500), loadSignals(50), loadWeights(), loadConditionStats()]);
      setHistory(segs);
      setWeights(w);
      const map: Record<string, CondStat> = {};
      for (const r of stats as any[]) {
        map[r.condition_name] = { name: r.condition_name, accuracy: Number(r.accuracy ?? 0), total: Number(r.total ?? 0) };
      }
      setCondStats(map);
      setSignals(sigs.map((s: any) => ({
        id: s.id,
        timestamp: Number(s.timestamp),
        direction: s.direction,
        strength: s.strength,
        confidence: s.confidence,
        score: s.score,
        adjustedScore: s.adjusted_score ?? s.score,
        tier: tierFromScore(s.score),
        entryPrice: +s.entry_price,
        durations: { primary: s.duration_minutes, secondary: 30, tertiary: 60 },
        mtLevels: { sl: 0, tp1: 0, tp2: 0 },
        reasons: [],
        smc: { choch: s.choch_present, sweep: s.sweep_present, obTimeframe: s.ob_timeframe },
        topDown: { h4: s.h4_bias, h1: s.h1_bias, m15: "NEUTRAL", m5: "NEUTRAL", alignment: "MIXED" },
        patternMatchRate: +s.pattern_match_rate || 0,
        outcome: s.outcome,
        exitPrice: s.exit_price ? +s.exit_price : undefined,
      })));
      setLoading(false);
      flushQueue();
    })();
  }, []);

  // Online indicator + 1s tick (hydration-safe)
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.clearInterval(t);
    };
  }, []);

  // Deriv WS
  useEffect(() => {
    const client = new DerivClient({
      onTick: (q, _e) => { setPrevPrice((p) => price || p); setPrice(q); setLastTickMs(Date.now()); },
      onM1: setM1, onM5: setM5, onM15: setM15, onH1: setH1, onH4: setH4,
      onState: setConn,
    });
    client.start();
    return () => client.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute analysis
  const analysis = useMemo(() => {
    if (m1.length < 250 || !h1.length || !h4.length) return null;
    const closed = m1.slice(0, -1);
    const ind = computeIndicators(closed);
    if (!ind) return null;
    const smcM1 = computeSMC(closed, "M1");
    const smcM5 = m5.length ? computeSMC(m5.slice(0, -1), "M5") : smcM1;
    const smcM15 = m15.length ? computeSMC(m15.slice(0, -1), "M15" as any) : smcM5;
    const smcH1 = computeSMC(h1, "H1");
    const smcH4 = computeSMC(h4, "H4");
    const h4Bias = computeBias(h4, "EMA50");
    const h1Bias = computeBias(h1, "EMA9_21");
    const m15Bias = m15.length ? computeBias(m15.slice(0, -1), "EMA9_21") : "NEUTRAL";
    const m5Bias = m5.length ? computeBias(m5.slice(0, -1), "EMA9_21") : "NEUTRAL";
    const m1Bias = computeBias(closed, "EMA9_21");
    const td: TopDownBias = {
      h4: h4Bias, h1: h1Bias, m15: m15Bias as any, m5: m5Bias as any,
      alignment:
        h4Bias === "BULL" && h1Bias === "BULL" ? "ALIGNED_BULL" :
        h4Bias === "BEAR" && h1Bias === "BEAR" ? "ALIGNED_BEAR" :
        (h4Bias !== "NEUTRAL" && h1Bias !== "NEUTRAL" && h4Bias !== h1Bias) ? "OPPOSED" : "MIXED",
    };
    const score = computeScore(closed, ind, smcM1, smcH1, smcH4, td, weights);
    const candlePattern = detectCandlePattern(closed);
    // ── Candle-pattern engine: M15 primary, M5 confirm, M1 micro ──
    const m15Closed = m15.slice(0, -1);
    const m5Closed = m5.slice(0, -1);
    const m15Ind = m15Closed.length >= 20 ? computeIndicators(m15Closed) : null;
    const m5Ind = m5Closed.length >= 20 ? computeIndicators(m5Closed) : null;
    const m15Patterns = m15Ind ? detectAllPatterns(m15Closed.slice(-5), m15Ind.atr) : [];
    const m5Patterns = m5Ind ? detectAllPatterns(m5Closed.slice(-5), m5Ind.atr) : [];
    const m1Patterns = detectAllPatterns(closed.slice(-5), ind.atr);
    // Display patterns: prefer M15 list (most meaningful), then M5, then M1
    const patterns = m15Patterns.length ? m15Patterns
                  : m5Patterns.length ? m5Patterns
                  : m1Patterns;
    const m15Raw = getPatternScore(m15Patterns);          // full
    const m5Raw = getPatternScore(m5Patterns) * 0.5;      // half
    const m1Raw = getPatternScore(m1Patterns) * 0.25;     // quarter
    const rawPatternScore = m15Raw + m5Raw + m1Raw;
    const patternScore = Math.max(-4, Math.min(4, Math.round(rawPatternScore)));
    const dominantPattern: PatternResult | null =
      (m15Patterns[0] ?? m5Patterns[0] ?? m1Patterns[0]) ?? null;
    // 10-candle scanner — run on M15 (matches contract duration)
    const scanSource = m15Closed.length >= 20 ? m15Closed : closed;
    const scanAtr = m15Ind ? m15Ind.atr : ind.atr;
    const patternScan = scanPatternHistory(scanSource, scanAtr, 10);
    let scannerCumulative = 0;
    let scannerBull = 0, scannerBear = 0;
    for (const row of patternScan) {
      if (!row.patterns.length) continue;
      const top = row.patterns[0];
      scannerCumulative += top.signal;
      if (top.direction === "RISE") scannerBull++;
      else if (top.direction === "FALL") scannerBear++;
    }
    const daily = computeDailyBias(history);
    const trend = computeRecentTrendBias(history);
    // Daily bias score adjustment
    let dailyAdj = 0;
    if (daily.bias === "STRONG_BEAR") dailyAdj = -2;
    else if (daily.bias === "BEAR") dailyAdj = -1;
    else if (daily.bias === "STRONG_BULL") dailyAdj = 2;
    else if (daily.bias === "BULL") dailyAdj = 1;
    // ── Pattern accuracy boost (uses learned condition stats) ──
    let patternBoost = 0;
    let patternBoostReason = "";
    const direction = score.adjusted + trend.bias + dailyAdj >= 0 ? "RISE" : "FALL";
    if (dominantPattern && condStats[dominantPattern.key]) {
      const st = condStats[dominantPattern.key];
      if (st.total >= 10) {
        if (dominantPattern.direction === direction) {
          if (st.accuracy >= 85) { patternBoost = 2; patternBoostReason = `${dominantPattern.key} historically ${st.accuracy.toFixed(0)}% accurate +2`; }
          else if (st.accuracy >= 70) { patternBoost = 1; patternBoostReason = `${dominantPattern.key} ${st.accuracy.toFixed(0)}% accurate +1`; }
        } else if (st.accuracy >= 80) {
          patternBoost = direction === "RISE" ? -2 : 2;
          patternBoostReason = `WARNING ${dominantPattern.key} (${st.accuracy.toFixed(0)}% ${dominantPattern.direction}) opposes ${direction}`;
        }
      }
    }
    const finalScore = Math.max(-25, Math.min(25, score.adjusted + trend.bias + dailyAdj + patternScore + patternBoost));
    return { ind, smcM1, smcM5, smcM15, smcH1, smcH4, td, m1Bias, m15Bias, score, finalScore, daily, trend, candlePattern, closed,
      patterns, patternScore, dominantPattern, patternScan, scannerCumulative, scannerBull, scannerBear, patternBoost, patternBoostReason };
  }, [m1, m5, m15, h1, h4, weights, history, condStats]);

  // Pattern match
  const patternMatch = useMemo(() => {
    if (!analysis || history.length < 5) return null;
    const { ind, smcM1, smcH1, smcH4, td, score, candlePattern } = analysis;
    const obTF = smcH4.nearestBOB || smcH4.nearestBEOB ? "H4" :
                 smcH1.nearestBOB || smcH1.nearestBEOB ? "H1" :
                 smcM1.nearestBOB || smcM1.nearestBEOB ? "M1" : "NONE";
    const emaAlign = ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50 && ind.ema50 > ind.ema200 ? "FULL_BULL" :
                     ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50 && ind.ema50 < ind.ema200 ? "FULL_BEAR" :
                     ind.ema9 > ind.ema21 ? "PARTIAL_BULL" :
                     ind.ema9 < ind.ema21 ? "PARTIAL_BEAR" : "MIXED";
    return findSimilar({
      score: score.total, adjustedScore: score.total,
      rsi: ind.rsi, stochK: ind.stochK, stochD: ind.stochD,
      macdHistogram: ind.macdHist, williamsR: ind.williamsR, cci: ind.cci,
      bbPosition: ind.bbPosition, bbWidth: ind.bbWidth, atr: ind.atr, relativeAtr: ind.relativeAtr,
      ema9: ind.ema9, ema21: ind.ema21, ema50: ind.ema50, ema200: ind.ema200,
      emaAlignment: emaAlign,
      hasActiveBOB: !!smcM1.nearestBOB || !!smcH1.nearestBOB || !!smcH4.nearestBOB,
      hasActiveBEOB: !!smcM1.nearestBEOB || !!smcH1.nearestBEOB || !!smcH4.nearestBEOB,
      obTimeframe: obTF,
      hasFVGBull: smcM1.fvgs.some((f) => f.type === "BULL"),
      hasFVGBear: smcM1.fvgs.some((f) => f.type === "BEAR"),
      chochDetected: smcM1.choch,
      liquiditySweep: smcM1.liquiditySweep,
      h4Bias: td.h4, h1Bias: td.h1, topDownAlignment: td.alignment,
      candlePattern, structure: "NEUTRAL",
      rsiDivergence: ind.rsiDivergence, macdDivergence: ind.macdDivergence,
      hourOfDay: new Date().getUTCHours(), dayOfWeek: new Date().getUTCDay(),
    }, history);
  }, [analysis, history]);

  // Increment closed-candle counter when a new M1 bar closes
  useEffect(() => {
    if (m1.length < 2) return;
    const lastClosed = m1[m1.length - 2];
    if (lastClosed.time !== lastSeenM1Time.current) {
      lastSeenM1Time.current = lastClosed.time;
      closedCandleCount.current += 1;
      // Push micro score for new closed candle
      if (analysis) {
        // ── HMM regime update ─────────────────────────────────
        try {
          const closed = analysis.closed;
          const closes = closed.map((c) => c.close);
          const e9arr = emaSeries(closes, 9);
          const e21arr = emaSeries(closes, 21);
          const rArr = rsiSeries(closes, 14);
          const mh = macdSeries(closes).hist;
          const aArr = atrSeries(closed, 14);
          const atrNow = aArr[aArr.length - 1] || analysis.ind.atr;
          if (!hmmBootstrapped.current) {
            hmmManager.bootstrap(closed, atrNow, e9arr, e21arr, rArr, mh);
            hmmBootstrapped.current = true;
          }
          const r = hmmManager.update(closed, atrNow, e9arr, e21arr, rArr, mh);
          setRegime(r);
          if (r.regimeChanged) {
            setRegimeHistory((h) => [{
              time: lastClosed.time, state: r.stateName, duration: 1,
              confidence: r.confidence, changedFrom: hmmManager.stateNames[r.prevState],
            }, ...h].slice(0, 30));
          }
        } catch (e) {
          console.error("[HMM] update error", e);
        }
        const mt = detectMicroTrend({
          candles: analysis.closed,
          ind: analysis.ind,
          td: analysis.td,
          m1Bias: analysis.m1Bias,
          nearestBOB: analysis.smcH4.nearestBOB ?? analysis.smcH1.nearestBOB ?? analysis.smcM15.nearestBOB ?? analysis.smcM5.nearestBOB ?? analysis.smcM1.nearestBOB,
          nearestBEOB: analysis.smcH4.nearestBEOB ?? analysis.smcH1.nearestBEOB ?? analysis.smcM15.nearestBEOB ?? analysis.smcM5.nearestBEOB ?? analysis.smcM1.nearestBEOB,
          supports: [...analysis.smcM15.supports, ...analysis.smcH1.supports, ...analysis.smcH4.supports],
          resistances: [...analysis.smcM15.resistances, ...analysis.smcH1.resistances, ...analysis.smcH4.resistances],
          price: analysis.closed[analysis.closed.length - 1].close,
        });
        const buf = microScoreHistoryRef.current;
        buf.push(mt.entryScore);
        if (buf.length > 50) buf.shift();
        // Track neutral streak
        if (mt.direction === "WAIT") neutralStreakRef.current += 1;
        else neutralStreakRef.current = 0;
        // Record trend-state transitions
        const prev = lastTrendStateRef.current;
        if (mt.state !== prev.state) {
          const snap: MicroTrendSnapshot = {
            time: lastClosed.time,
            state: mt.state,
            duration: mt.duration,
            direction: mt.direction,
            entryScore: mt.entryScore,
          };
          setTrendHistory((h) => [snap, ...h].slice(0, 30));
          lastTrendStateRef.current = { state: mt.state, direction: mt.direction, startTime: lastClosed.time, startCandle: closedCandleCount.current };
        }

        // ── Micro-Reversal Scanner (parallel module) ────────
        try {
          if (mrSettings.enabled && analysis.closed.length >= 30) {
            const closesMR = analysis.closed.map((c) => c.close);
            const e9arrMR = emaSeries(closesMR, 9);
            const e21arrMR = emaSeries(closesMR, 21);
            const aArrMR = atrSeries(analysis.closed, 14);
            const atrMR = aArrMR[aArrMR.length - 1] || analysis.ind.atr;
            const bbMR = bollingerSeries(closesMR, 20, 2);
            const e9 = e9arrMR[e9arrMR.length - 1];
            const e21 = e21arrMR[e21arrMR.length - 1];
            const e9Prev = e9arrMR[e9arrMR.length - 4] ?? e9;
            const e21Prev = e21arrMR[e21arrMR.length - 4] ?? e21;
            const bbU = bbMR.upper[bbMR.upper.length - 1] ?? analysis.ind.bbUpper;
            const bbL = bbMR.lower[bbMR.lower.length - 1] ?? analysis.ind.bbLower;
            const existingDir = microTrend?.direction === "WAIT" ? null : (microTrend?.direction ?? null);
            const sig = runMicroReversalScanner(
              analysis.closed, atrMR, e9, e21, e9Prev, e21Prev, bbU, bbL, existingDir, mrSettings,
            );
            if (sig) {
              // rate-limit per hour
              const hr = new Date().getUTCHours();
              if (mrHourCountRef.current.hour !== hr) mrHourCountRef.current = { hour: hr, count: 0 };
              const limited = mrSettings.maxSignalsPerHour != null && mrHourCountRef.current.count >= mrSettings.maxSignalsPerHour;
              const tooSoon = Date.now() - mrLastTsRef.current < 60_000;
              if (!limited && !tooSoon) {
                mrHourCountRef.current.count += 1;
                mrLastTsRef.current = Date.now();
                setMrCurrent(sig);
                setMrSignals((arr) => [sig, ...arr].slice(0, 100));
                if (sig.shouldAlert) {
                  setMrFlash({ id: sig.timestamp, until: Date.now() + 4500, dir: sig.direction });
                  setTimeout(() => setMrFlash((cur) => (cur && cur.id === sig.timestamp ? null : cur)), 4500);
                  playMicroReversalChime(sig.direction);
                  if (mrSettings.telegramBotToken && mrSettings.telegramChatId) {
                    sendTelegramAlert(sig, mrSettings.telegramBotToken, mrSettings.telegramChatId);
                  }
                }
                // Persist to Supabase (fire-and-forget)
                supabase.from("v75_micro_reversal_signals" as any).insert({
                  timestamp: sig.ts,
                  direction: sig.direction,
                  pattern_type: sig.patternType,
                  confidence: sig.confidence,
                  strength: sig.strength,
                  recommended_duration: sig.recommendedDuration,
                  entry_price: sig.entryPrice,
                  level_price: sig.levelPrice,
                  suggested_sl: sig.suggestedSL,
                  suggested_tp1: sig.suggestedTP1,
                  suggested_tp2: sig.suggestedTP2,
                  confluence_factors: sig.confluenceFactors,
                  cross_confirmed: sig.crossConfirmed,
                  counter_trend: sig.counterTrend,
                  existing_analyzer_direction: sig.existingAnalyzerDirection,
                  outcome: "PENDING",
                  ema9: sig.indicators.ema9,
                  ema21: sig.indicators.ema21,
                  bb_upper: sig.indicators.bbUpper,
                  bb_lower: sig.indicators.bbLower,
                  atr: sig.indicators.atr,
                }).then(() => {}, () => {});
                // Schedule outcome check
                const evalMs = mrSettings.evaluationWindow * 60_000;
                const sigId = sig.timestamp;
                setTimeout(() => {
                  const livePrice = price;
                  const won = (sig.direction === "RISE" && livePrice > sig.entryPrice) ||
                              (sig.direction === "FALL" && livePrice < sig.entryPrice);
                  const outcome: "WIN" | "LOSS" = won ? "WIN" : "LOSS";
                  setMrSignals((arr) => arr.map((s) =>
                    s.timestamp === sigId ? { ...s, outcome, exitPrice: livePrice } : s,
                  ));
                  supabase.from("v75_micro_reversal_signals" as any)
                    .update({ outcome, exit_price: livePrice })
                    .eq("timestamp", sig.ts).then(() => {}, () => {});
                }, evalMs);
              }
            }
          }
        } catch (e) {
          console.error("[MR] scanner error", e);
        }
      }
    }
  }, [m1, analysis]);

  // Segment recording every 15 minutes
  useEffect(() => {
    if (!analysis || !m1.length) return;
    const lastClosed = m1[m1.length - 2];
    if (!lastClosed || lastClosed.time === lastClosedM1Time.current) return;
    lastClosedM1Time.current = lastClosed.time;

    const minute = Math.floor(lastClosed.time / 60);
    // If a 15-min boundary just closed
    if (minute % 15 === 0 && segmentStartRef.current) {
      const start = segmentStartRef.current;
      const closePrice = lastClosed.close;
      const move = closePrice - start.price;
      const atrThr = analysis.ind.atr * 0.3;
      const outcome: "RISE" | "FALL" | "FLAT" =
        move > atrThr ? "RISE" : move < -atrThr ? "FALL" : "FLAT";
      const snap = start.snap;
      const rec: SegmentRecord = {
        timestamp: start.ts,
        dateStr: new Date(start.ts).toISOString().slice(0, 10),
        timeStr: new Date(start.ts).toISOString().slice(11, 16) + " UTC",
        openPrice: start.price, closePrice, outcome,
        pointMove: +move.toFixed(2),
        ...snap,
      };
      setHistory((h) => [rec, ...h].slice(0, 1000));
      saveSegment(rec);
      segmentStartRef.current = null;
    }
    if (!segmentStartRef.current && minute % 15 === 0) {
      const { ind, smcM1, smcH1, smcH4, td, candlePattern, score, dominantPattern, patternScore } = analysis;
      const obTF = smcH4.orderBlocks.length ? "H4" : smcH1.orderBlocks.length ? "H1" : smcM1.orderBlocks.length ? "M1" : "NONE";
      const emaAlign = ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50 && ind.ema50 > ind.ema200 ? "FULL_BULL" :
                       ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50 && ind.ema50 < ind.ema200 ? "FULL_BEAR" :
                       ind.ema9 > ind.ema21 ? "PARTIAL_BULL" : "PARTIAL_BEAR";
      segmentStartRef.current = {
        price: lastClosed.close, ts: lastClosed.time * 1000,
        snap: {
          score: score.total, adjustedScore: score.adjusted,
          rsi: +ind.rsi.toFixed(2), stochK: +ind.stochK.toFixed(2), stochD: +ind.stochD.toFixed(2),
          macdHistogram: +ind.macdHist.toFixed(4), williamsR: +ind.williamsR.toFixed(2),
          cci: +ind.cci.toFixed(2), bbPosition: +ind.bbPosition.toFixed(4),
          bbWidth: +ind.bbWidth.toFixed(4), atr: +ind.atr.toFixed(2),
          relativeAtr: +ind.relativeAtr.toFixed(6),
          ema9: +ind.ema9.toFixed(2), ema21: +ind.ema21.toFixed(2),
          ema50: +ind.ema50.toFixed(2), ema200: +ind.ema200.toFixed(2),
          emaAlignment: emaAlign, obTimeframe: obTF,
          hasActiveBOB: smcM1.orderBlocks.some((o) => o.type === "BULL"),
          hasActiveBEOB: smcM1.orderBlocks.some((o) => o.type === "BEAR"),
          hasFVGBull: smcM1.fvgs.some((f) => f.type === "BULL"),
          hasFVGBear: smcM1.fvgs.some((f) => f.type === "BEAR"),
          chochDetected: smcM1.choch, liquiditySweep: smcM1.liquiditySweep,
          h4Bias: td.h4, h1Bias: td.h1, topDownAlignment: td.alignment,
          m15Bias: analysis.m15Bias,
          candlePattern, structure: "NEUTRAL",
          rsiDivergence: ind.rsiDivergence, macdDivergence: ind.macdDivergence,
          hourOfDay: new Date(lastClosed.time * 1000).getUTCHours(),
          dayOfWeek: new Date(lastClosed.time * 1000).getUTCDay(),
          dominantPattern: dominantPattern?.key ?? "NONE",
          patternScore: patternScore ?? 0,
          patternDirection: dominantPattern?.direction ?? "NEUTRAL",
        },
      };
    }
  }, [m1, analysis]);

  // Signal gating
  useEffect(() => {
    if (!analysis || !patternMatch) return;
    if (Date.now() < lossBreakUntil.current) return;
    const score = analysis.finalScore;
    const rawDir = directionFromScore(score);
    if (rawDir === "NONE") return;
    const rawConf = confidenceFromScore(score);

    // ── Dominant micro-trend evaluation ──
    // Aggregate multi-timeframe bias to decide which side is genuinely
    // dominant. If score's raw direction opposes dominance, flip the
    // displayed signal so it reflects the prevailing trend.
    const bullVotes =
      (analysis.td.h4 === "BULL" ? 1 : 0) +
      (analysis.td.h1 === "BULL" ? 1 : 0) +
      (analysis.td.m15 === "BULL" ? 1 : 0) +
      (analysis.td.m5 === "BULL" ? 1 : 0) +
      (analysis.m1Bias === "BULL" ? 1 : 0);
    const bearVotes =
      (analysis.td.h4 === "BEAR" ? 1 : 0) +
      (analysis.td.h1 === "BEAR" ? 1 : 0) +
      (analysis.td.m15 === "BEAR" ? 1 : 0) +
      (analysis.td.m5 === "BEAR" ? 1 : 0) +
      (analysis.m1Bias === "BEAR" ? 1 : 0);
    let dominantDir: "RISE" | "FALL" | "NONE" = "NONE";
    if (bullVotes >= 3 && bullVotes > bearVotes) dominantDir = "RISE";
    else if (bearVotes >= 3 && bearVotes > bullVotes) dominantDir = "FALL";
    else if (analysis.daily.bias === "STRONG_BULL" || analysis.daily.bias === "BULL") dominantDir = "RISE";
    else if (analysis.daily.bias === "STRONG_BEAR" || analysis.daily.bias === "BEAR") dominantDir = "FALL";

    let dir: "RISE" | "FALL" = rawDir;
    let confidence = rawConf;
    let flipped = false;
    if (dominantDir !== "NONE" && dominantDir !== rawDir) {
      dir = dominantDir;
      confidence = 100 - rawConf;
      flipped = true;
    }

    // ── Confidence band gate: only fire signals in the 55–65% sweet spot ──
    // Below 55% = undecided / likely reversal.
    // Above 65% = approaching exhaustion / high reversal risk.
    if (confidence < 55 || confidence > 65) {
      setSuppression(
        `Confidence ${confidence}% outside 55–65% band${flipped ? ` (flipped to dominant ${dir})` : ""}. Suppressed.`,
      );
      return;
    }

    const last = lastSignalRef.current;
    const now = Date.now();
    // Smart gate: min 3 candles + 3 minutes + score delta >= 3 since last fire
    if (last) {
      const candlesSince = closedCandleCount.current - last.candleIdx;
      if (candlesSince < 3) { setSuppression(`Smart gate: only ${candlesSince} candle(s) since last signal.`); return; }
      if (now - last.ts < 3 * 60 * 1000) { setSuppression("Smart gate: <3 min since last signal."); return; }
      if (Math.abs(score - last.score) < 3) { setSuppression(`Smart gate: score delta ${Math.abs(score - last.score)} <3.`); return; }
      if (dir !== last.dir && Math.abs(score) < 13) { setSuppression("Direction flip needs |score|≥13."); return; }
    }

    // Multi-TF quality gate (2 of 3 H4/H1/M5 must agree)
    const bulls = [analysis.td.h4 === "BULL", analysis.td.h1 === "BULL", analysis.td.m5 === "BULL"].filter(Boolean).length;
    const bears = [analysis.td.h4 === "BEAR", analysis.td.h1 === "BEAR", analysis.td.m5 === "BEAR"].filter(Boolean).length;
    if (dir === "RISE" && bulls < 2) {
      setSuppression(`RISE needs ≥2 bullish TFs (have ${bulls}/3). H4:${analysis.td.h4} H1:${analysis.td.h1} M5:${analysis.td.m5}`);
      return;
    }
    if (dir === "FALL" && bears < 2) {
      setSuppression(`FALL needs ≥2 bearish TFs (have ${bears}/3). H4:${analysis.td.h4} H1:${analysis.td.h1} M5:${analysis.td.m5}`);
      return;
    }

    // H1+M5 oppose direction → block
    const h1Opp = (dir === "RISE" && analysis.td.h1 === "BEAR") || (dir === "FALL" && analysis.td.h1 === "BULL");
    const m5Opp = (dir === "RISE" && analysis.td.m5 === "BEAR") || (dir === "FALL" && analysis.td.m5 === "BULL");
    const h4Opp = (dir === "RISE" && analysis.td.h4 === "BEAR") || (dir === "FALL" && analysis.td.h4 === "BULL");
    const m15Opp = (dir === "RISE" && analysis.td.m15 === "BEAR") || (dir === "FALL" && analysis.td.m15 === "BULL");
    if (h1Opp && m5Opp) { setSuppression(`H1 and M5 both oppose ${dir}. Blocked.`); return; }
    if (h4Opp && h1Opp) { setSuppression(`H4 and H1 both oppose ${dir}. Top-down conflict.`); return; }
    if (m15Opp && m5Opp) { setSuppression(`M15 and M5 both oppose ${dir}. Lower-TF conflict.`); return; }

    // Daily bias suppression on weak counter-trend
    if (analysis.daily.bias === "STRONG_BEAR" && dir === "RISE" && Math.abs(score) < 10) {
      setSuppression(`Daily bias STRONG BEAR (${analysis.daily.falls}/${analysis.daily.total}). Weak RISE blocked.`);
      return;
    }
    if (analysis.daily.bias === "STRONG_BULL" && dir === "FALL" && Math.abs(score) < 10) {
      setSuppression(`Daily bias STRONG BULL (${analysis.daily.rises}/${analysis.daily.total}). Weak FALL blocked.`);
      return;
    }

    // Pattern memory veto
    if (patternMatch.matches.length >= 15) {
      const opposite = dir === "RISE" ? patternMatch.fallRate : patternMatch.riseRate;
      if (opposite >= 60 && Math.abs(score) <= 13) {
        setSuppression(`Pattern memory veto: ${opposite.toFixed(0)}% of similar setups moved ${dir === "RISE" ? "FALL" : "RISE"}.`);
        return;
      }
    }

    const atr = analysis.ind.atr;
    const sign = dir === "RISE" ? 1 : -1;
    const patternReasons: string[] = [];
    if (analysis.dominantPattern) {
      patternReasons.push(`${analysis.dominantPattern.label} (${analysis.dominantPattern.signal > 0 ? "+" : ""}${analysis.dominantPattern.signal})`);
      patternReasons.push(analysis.dominantPattern.key);
    }
    if (analysis.patternBoostReason) patternReasons.push(analysis.patternBoostReason);
    const allReasons = [...analysis.score.conditions, ...patternReasons];
    const displayedScore = flipped ? -analysis.score.total : analysis.score.total;
    const displayedAdjusted = flipped ? -score : score;
    const sig: Signal = {
      id: crypto.randomUUID(),
      timestamp: now,
      direction: dir,
      strength: strengthFromScore(score),
      confidence,
      score: displayedScore, adjustedScore: displayedAdjusted,
      tier: tierFromScore(score),
      entryPrice: price,
      durations: { primary: 15, secondary: 30, tertiary: 60 },
      mtLevels: {
        sl: price - sign * 2.0 * atr,
        tp1: price + sign * 1.5 * atr,
        tp2: price + sign * 3.0 * atr,
      },
      reasons: allReasons,
      smc: {
        choch: analysis.smcM1.choch !== "NONE",
        sweep: analysis.smcM1.liquiditySweep !== "NONE",
        obTimeframe: analysis.smcH4.orderBlocks.length ? "H4" :
                     analysis.smcH1.orderBlocks.length ? "H1" :
                     analysis.smcM1.orderBlocks.length ? "M1" : "NONE",
      },
      topDown: analysis.td,
      patternMatchRate: patternMatch.dominantRate,
    };
    lastSignalRef.current = { score, ts: now, dir, candleIdx: closedCandleCount.current };
    setSuppression("");
    setSignals((s) => [sig, ...s].slice(0, 50));
    saveSignal(sig);
    // Schedule outcome check
    setTimeout(() => {
      setSignals((cur) => {
        const updated = cur.map((s) => {
          if (s.id !== sig.id) return s;
          const won = (s.direction === "RISE" && price >= s.entryPrice) ||
                       (s.direction === "FALL" && price <= s.entryPrice);
          const outcome: "WIN" | "LOSS" = won ? "WIN" : "LOSS";
          updateSignalOutcome(s.id, outcome, price);
          // Feed adaptive learning
          if (sig.reasons.length) {
            bumpConditions(sig.reasons, won ? sig.direction : (sig.direction === "RISE" ? "FALL" : "RISE"));
          }
          // Loss brake: 2 consecutive losses (most-recent first ordering)
          const ordered = [{ ...s, outcome }, ...cur.filter((x) => x.id !== sig.id)];
          const resolved = ordered.filter((x) => x.outcome === "WIN" || x.outcome === "LOSS").slice(0, 2);
          if (resolved.length === 2 && resolved.every((x) => x.outcome === "LOSS")) {
            lossBreakUntil.current = Date.now() + 30 * 60 * 1000;
          }
          return { ...s, outcome, exitPrice: price };
        });
        return updated;
      });
    }, 15 * 60 * 1000);
  }, [analysis, patternMatch, price]);

  // ── Micro trend (live, recomputed on every analysis change) ──
  const microTrend = useMemo<MicroTrend | null>(() => {
    if (!analysis) return null;
    return detectMicroTrend({
      candles: analysis.closed,
      ind: analysis.ind,
      td: analysis.td,
      m1Bias: analysis.m1Bias,
      nearestBOB: analysis.smcH4.nearestBOB ?? analysis.smcH1.nearestBOB ?? analysis.smcM15.nearestBOB ?? analysis.smcM5.nearestBOB ?? analysis.smcM1.nearestBOB,
      nearestBEOB: analysis.smcH4.nearestBEOB ?? analysis.smcH1.nearestBEOB ?? analysis.smcM15.nearestBEOB ?? analysis.smcM5.nearestBEOB ?? analysis.smcM1.nearestBEOB,
      supports: [...analysis.smcM15.supports, ...analysis.smcH1.supports, ...analysis.smcH4.supports],
      resistances: [...analysis.smcM15.resistances, ...analysis.smcH1.resistances, ...analysis.smcH4.resistances],
      price,
    });
  }, [analysis, price]);

  const reversal = useMemo(() => {
    if (!analysis) return { detected: false, direction: "RISE" as const, strength: 0, confirmationCandles: 0 };
    return detectReversal(analysis.closed, microScoreHistoryRef.current);
  }, [analysis]);

  // ── Tier A signal firing ──
  useEffect(() => {
    if (!analysis || !microTrend) return;
    if (m1.length < 50) return;
    // ── HMM REGIME CHANGE SPECIAL signal — fires immediately ──
    if (regime && regime.regimeChanged && regime.isSustainable &&
        regime.confidence >= 65 && regime.dominantDirection !== "NEUTRAL") {
      const lastRC = lastTierARef.current;
      const dirRC = regime.dominantDirection as "RISE" | "FALL";
      const tfsAgree = dirRC === "RISE"
        ? [analysis.td.h4, analysis.td.h1, analysis.td.m15, analysis.td.m5].filter((x) => x === "BULL").length
        : [analysis.td.h4, analysis.td.h1, analysis.td.m15, analysis.td.m5].filter((x) => x === "BEAR").length;
      if (tfsAgree >= 2 && Date.now() - lastRC.ts > 60_000) {
        const atr = analysis.ind.atr;
        const sign = dirRC === "RISE" ? 1 : -1;
        const nowMs = Date.now();
        const sig: TierASignal = {
          id: crypto.randomUUID(), timestamp: nowMs, direction: dirRC,
          state: microTrend.state, strength: regime.confidence,
          duration: regime.regimeDuration, entryScore: microTrend.entryScore,
          entryPrice: price,
          sl: price - sign * 3.0 * atr,
          tp1: price + sign * 2.0 * atr,
          tp2: price + sign * 4.0 * atr,
          reason: `🔄 REGIME CHANGE → ${regime.stateName} (${regime.confidence}%) · was ${hmmManager.stateNames[regime.prevState]}`,
          isReversal: false, exhausting: false, outcome: "PENDING",
          hmmState: regime.stateName, hmmConfidence: regime.confidence, isRegimeChange: true,
        };
        lastTierARef.current = { ts: nowMs, candleIdx: closedCandleCount.current, dir: dirRC };
        setTierA((s) => [sig, ...s].slice(0, 30));
        setEnterAlert({ id: sig.id, direction: dirRC, until: nowMs + 5000 });
        setTimeout(() => setEnterAlert((c) => (c && c.id === sig.id ? null : c)), 5000);
        setTimeout(() => {
          setTierA((cur) => cur.map((x) => {
            if (x.id !== sig.id) return x;
            const won = (x.direction === "RISE" && price >= x.entryPrice) || (x.direction === "FALL" && price <= x.entryPrice);
            return { ...x, outcome: won ? "WIN" : "LOSS", exitPrice: price };
          }));
        }, 15 * 60 * 1000);
        return;
      }
    }
    // 7-layer gate: shouldFire is only true when ALL rules pass
    if (!microTrend.shouldFire) return;
    if (microTrend.direction === "WAIT") return;

    // ── HMM GATES ─────────────────────────────────────────
    if (regime) {
      if (regime.confidence < 60) {
        setSuppression(`HMM regime transition — ${regime.confidence}% confidence. Tier A blocked.`);
        return;
      }
      // Hard block: counter to a confirmed strong regime
      if (microTrend.direction === "RISE" && regime.currentState === 3 && regime.confidence >= 60) {
        setSuppression(`HMM STRONG_BEAR ${regime.confidence}% — RISE blocked.`);
        return;
      }
      if (microTrend.direction === "FALL" && regime.currentState === 0 && regime.confidence >= 60) {
        setSuppression(`HMM STRONG_BULL ${regime.confidence}% — FALL blocked.`);
        return;
      }
      if (!regime.isSustainable) {
        setSuppression(`HMM new regime ${regime.stateName} forming — need ${3 - regime.regimeDuration} more candle(s).`);
        return;
      }
    }

    const last = lastTierARef.current;
    const nowMs = Date.now();
    const timeSince = nowMs - last.ts;
    const isReversal = reversal.detected && reversal.direction === microTrend.direction;
    // Rule 7 — minimum 3-min gap (bypassed for confirmed reversal)
    if (!isReversal && timeSince < 3 * 60 * 1000) return;

    const atr = analysis.ind.atr;
    const sign = microTrend.direction === "RISE" ? 1 : -1;
    const sig: TierASignal = {
      id: crypto.randomUUID(),
      timestamp: nowMs,
      direction: microTrend.direction,
      state: microTrend.state,
      strength: microTrend.strength,
      duration: microTrend.duration,
      entryScore: microTrend.entryScore,
      entryPrice: price,
      sl: price - sign * 2.0 * atr,
      tp1: price + sign * 1.5 * atr,
      tp2: price + sign * 3.0 * atr,
      reason: microTrend.reason,
      isReversal,
      exhausting: microTrend.exhausting,
      outcome: "PENDING",
      hmmState: regime?.stateName,
      hmmConfidence: regime?.confidence,
      isRegimeChange: false,
    };
    lastTierARef.current = { ts: nowMs, candleIdx: closedCandleCount.current, dir: microTrend.direction };
    setTierA((s) => [sig, ...s].slice(0, 30));

    // Flashing "ENTER NOW" alert for 5 seconds
    const alertId = sig.id;
    setEnterAlert({ id: alertId, direction: microTrend.direction, until: nowMs + 5000 });
    setTimeout(() => {
      setEnterAlert((cur) => (cur && cur.id === alertId ? null : cur));
    }, 5000);

    // Outcome check after 15 minutes (using live `price` via closure of setter)
    setTimeout(() => {
      setTierA((cur) => cur.map((x) => {
        if (x.id !== sig.id) return x;
        const won = (x.direction === "RISE" && price >= x.entryPrice) ||
                    (x.direction === "FALL" && price <= x.entryPrice);
        return { ...x, outcome: won ? "WIN" : "LOSS", exitPrice: price };
      }));
    }, 15 * 60 * 1000);
  }, [microTrend, reversal, analysis, m1, price, regime]);

  const chartCandles =
    chartTF === "M1" ? m1 :
    chartTF === "M5" ? m5 :
    chartTF === "M15" ? m15 :
    chartTF === "H1" ? h1 : h4;
  const tickAgo = Math.max(0, ((Date.now() - lastTickMs) / 1000)).toFixed(1);
  const change = price - prevPrice;
  const activeSignal = signals[0] && Date.now() - signals[0].timestamp < 2 * 60 * 1000 ? signals[0] : null;
  const lossBreakLeft = Math.max(0, lossBreakUntil.current - Date.now());
  const adaptiveCount = Object.keys(weights).filter((k) => Math.abs((weights[k] ?? 1) - 1) > 0.001).length;

  // Outcome summary
  const todayKey = new Date().toISOString().slice(0, 10);
  const todays = signals.filter((s) => new Date(s.timestamp).toISOString().slice(0, 10) === todayKey);
  const wins = todays.filter((s) => s.outcome === "WIN").length;
  const losses = todays.filter((s) => s.outcome === "LOSS").length;
  const pending = todays.filter((s) => !s.outcome || s.outcome === "PENDING").length;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  const pnl = wins * 45 - losses * 50;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Flashing ENTER NOW alert — fires when micro trend is confirmed */}
      {enterAlert && (
        <div className="fixed inset-x-0 top-0 z-50 flex justify-center pointer-events-none">
          <div
            className={`mt-2 px-8 py-4 rounded-xl font-extrabold text-2xl md:text-3xl tracking-widest shadow-2xl animate-pulse border-4 ${
              enterAlert.direction === "RISE"
                ? "bg-emerald-500 text-black border-emerald-200"
                : "bg-rose-600 text-white border-rose-200"
            }`}
            style={{ boxShadow: enterAlert.direction === "RISE" ? "0 0 40px rgba(0,230,118,0.9)" : "0 0 40px rgba(255,23,68,0.9)" }}
          >
            {enterAlert.direction === "RISE" ? "▲ ENTER NOW · BUY" : "▼ ENTER NOW · SELL"}
          </div>
        </div>
      )}
      {/* Micro-Reversal flash banner */}
      {mrFlash && (
        <div className="fixed inset-x-0 top-20 z-40 flex justify-center pointer-events-none">
          <div
            className={`mt-2 px-6 py-3 rounded-lg font-bold text-base md:text-lg shadow-2xl animate-pulse border-2 ${
              mrFlash.dir === "RISE"
                ? "bg-emerald-500/90 text-black border-emerald-200"
                : "bg-rose-600/90 text-white border-rose-200"
            }`}
            style={{ boxShadow: mrFlash.dir === "RISE" ? "0 0 30px rgba(0,230,118,0.7)" : "0 0 30px rgba(255,23,68,0.7)" }}
          >
            ⚡ MICRO-REVERSAL · {mrFlash.dir === "RISE" ? "▲ RISE" : "▼ FALL"}
          </div>
        </div>
      )}
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center gap-4 justify-between">
          <div>
            <div className="text-lg font-bold tracking-wider text-primary">V75 ANALYZER</div>
            <div className="text-xs text-muted-foreground">Volatility 75 Index · 24/7</div>
          </div>
          <div className="text-center font-mono">
            <div className="text-3xl font-bold tabular-nums">{price ? fmt(price) : "—"}</div>
            <div className={`text-xs ${change >= 0 ? "text-[color:var(--rise)]" : "text-[color:var(--fall)]"}`}>
              {change >= 0 ? "▲" : "▼"} {fmt(Math.abs(change))} · {tickAgo}s ago
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className={`px-2 py-1 rounded-full ${
              conn === "open" ? "bg-emerald-500/20 text-emerald-300" :
              conn === "connecting" ? "bg-amber-500/20 text-amber-300" :
              "bg-rose-500/20 text-rose-300"
            }`}>● {conn}</span>
            <span suppressHydrationWarning className="px-2 py-1 rounded-full bg-secondary text-muted-foreground">☁ {online ? "synced" : "local"}</span>
          </div>
        </div>
        {analysis && (
          <div className="max-w-7xl mx-auto px-4 pb-3 flex flex-wrap gap-2 text-xs font-mono">
            {(["h4", "h1", "m15", "m5"] as const).map((k) => {
              const v = analysis.td[k];
              const c = v === "BULL" ? "🟢" : v === "BEAR" ? "🔴" : "⚪";
              return <span key={k} className="px-2 py-1 rounded bg-secondary uppercase">{k}: {c} {v}</span>;
            })}
            <span className="px-2 py-1 rounded bg-secondary uppercase">
              m1: {analysis.m1Bias === "BULL" ? "🟢" : analysis.m1Bias === "BEAR" ? "🔴" : "⚪"} {analysis.m1Bias}
            </span>
            <span className={`px-2 py-1 rounded uppercase ${
              analysis.daily.bias.includes("BEAR") ? "bg-rose-500/20 text-rose-300" :
              analysis.daily.bias.includes("BULL") ? "bg-emerald-500/20 text-emerald-300" :
              "bg-secondary text-muted-foreground"
            }`}>
              📊 Today: {analysis.daily.bias.replace("_", " ")} ({analysis.daily.falls}↓/{analysis.daily.rises}↑)
            </span>
            <span className="px-2 py-1 rounded bg-secondary">
              Recent: {analysis.trend.last5.map((s, i) => (
                <span key={i} className={s.outcome === "RISE" ? "text-[color:var(--rise)]" : s.outcome === "FALL" ? "text-[color:var(--fall)]" : "text-muted-foreground"}>
                  {s.outcome === "RISE" ? "▲" : s.outcome === "FALL" ? "▼" : "—"}
                </span>
              ))}
            </span>
            <span className="px-2 py-1 rounded bg-primary/20 text-primary">SCORE: {analysis.finalScore} (raw {analysis.score.total})</span>
            {adaptiveCount > 0 && (
              <span className="px-2 py-1 rounded bg-secondary text-muted-foreground">🧠 {adaptiveCount} adaptive</span>
            )}
            {lossBreakLeft > 0 && (
              <span className="px-2 py-1 rounded bg-amber-500/20 text-amber-300">⏸ brake {Math.ceil(lossBreakLeft / 1000)}s</span>
            )}
          </div>
        )}
      </header>

      {/* Live Micro Trend Bar */}
      {microTrend && (() => {
        const s = microTrend.state;
        const bg =
          s === "STRONG_BULL" ? "bg-emerald-500/90 text-black" :
          s === "BULL" ? "bg-emerald-500/40 text-emerald-100" :
          s === "BULL_FORMING" ? "bg-emerald-500/20 text-emerald-200" :
          s === "STRONG_BEAR" ? "bg-rose-500/90 text-black" :
          s === "BEAR" ? "bg-rose-500/40 text-rose-100" :
          s === "BEAR_FORMING" ? "bg-rose-500/20 text-rose-200" :
          s === "CONFLICTED" ? "bg-amber-500/30 text-amber-100" :
          s === "REVERSAL_UP" ? "bg-emerald-400/80 text-black animate-pulse" :
          s === "REVERSAL_DOWN" ? "bg-rose-400/80 text-black animate-pulse" :
          "bg-secondary text-muted-foreground";
        const arrow = microTrend.direction === "RISE" ? "▲" : microTrend.direction === "FALL" ? "▼" : "■";
        const pct = Math.round(microTrend.strength);
        const dir = microTrend.direction;
        const verdictMatches = (v: LayerVerdict) =>
          dir === "RISE" ? v === "BULL" : dir === "FALL" ? v === "BEAR" : false;
        const pillCls = (v: LayerVerdict) => {
          if (dir === "WAIT") {
            return v === "BULL" ? "bg-emerald-500/40 text-emerald-100" :
                   v === "BEAR" ? "bg-rose-500/40 text-rose-100" :
                   "bg-black/30 text-white/60";
          }
          return verdictMatches(v)
            ? "bg-emerald-500/50 text-emerald-50"
            : v === "NEUTRAL"
              ? "bg-black/30 text-white/60"
              : "bg-rose-500/50 text-rose-50";
        };
        const layerPills: { k: string; v: LayerVerdict }[] = [
          { k: "MACRO", v: microTrend.layers.macro },
          { k: "EMA", v: microTrend.layers.emaStack },
          { k: "MACD", v: microTrend.layers.macd },
          { k: "SLOPE", v: microTrend.layers.emaSlope },
          { k: "CCI", v: microTrend.layers.cci },
          { k: "MOM", v: microTrend.layers.momentum },
          { k: "S/R", v: microTrend.layers.srOB },
        ];
        return (
          <div className={`px-4 py-2 ${bg} text-xs font-mono`}>
            <div className="max-w-7xl mx-auto flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 justify-between">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm">{arrow} MICRO TREND: {s.replace("_", " ")} ({pct}%)</span>
                {reversal.detected && <span className="px-1.5 py-0.5 rounded bg-black/30">↩ REVERSAL</span>}
                {microTrend.exhausting && <span className="px-1.5 py-0.5 rounded bg-amber-500/80 text-black">⚠ exhausting</span>}
                {microTrend.macroBlock !== "NONE" && (
                  <span className="px-1.5 py-0.5 rounded bg-black/40">🔒 macro {microTrend.macroBlock}</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span>TFs: {microTrend.bullTFs}↑ / {microTrend.bearTFs}↓</span>
                <span>Sustain: {microTrend.sustainCount}c {microTrend.accelerating ? "· accel ↑" : ""}</span>
                <span>Score: {microTrend.layerScore > 0 ? "+" : ""}{microTrend.layerScore}</span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-24 h-2 rounded bg-black/40 overflow-hidden align-middle">
                    <span className="block h-full bg-current opacity-80" style={{
                      width: `${pct}%`,
                      marginLeft: microTrend.direction === "FALL" ? `${100 - pct}%` : 0,
                    }} />
                  </span>
                </span>
              </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {layerPills.map((p) => (
                  <span key={p.k} className={`px-1.5 py-0.5 rounded text-[10px] ${pillCls(p.v)}`}>
                    {p.k}: {p.v}
                  </span>
                ))}
                <span className="ml-2 opacity-90">
                  {dir === "WAIT" ? "—" : `${microTrend.agreeCount}/7 agree`}
                </span>
                <span className="ml-auto opacity-80">{frequencyTarget(s, neutralStreakRef.current)}</span>
                {!microTrend.shouldFire && microTrend.blockReason && microTrend.direction !== "WAIT" && (
                  <span className="px-1.5 py-0.5 rounded bg-black/40 text-amber-200">⛔ {microTrend.blockReason}</span>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Tabs */}
      <nav className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {(["signals", "chart", "pattern", "learning", "history", "backtest"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-3 text-xs uppercase tracking-wider whitespace-nowrap ${
                tab === t ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
              }`}>{t}</button>
          ))}
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-4">
        {loading && <div className="text-center text-muted-foreground py-12">⏳ Loading V75 historical data...</div>}
        {!loading && !analysis && <div className="text-center text-muted-foreground py-12">⏳ Loading market data... (need 250+ M1 candles)</div>}

        {!loading && analysis && tab === "signals" && (
          <div className="space-y-4">
            {lossBreakLeft > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/40 text-amber-300 rounded-lg p-3 text-sm">
                ⏸ Loss brake active — 2 consecutive losses. Resuming in {Math.floor(lossBreakLeft / 60000)}:{String(Math.floor((lossBreakLeft % 60000) / 1000)).padStart(2, "0")}
              </div>
            )}
            {suppression && !activeSignal && lossBreakLeft === 0 && (
              <div className="bg-blue-500/10 border border-blue-500/40 text-blue-300 rounded-lg p-3 text-xs font-mono">
                🚫 Signal suppressed: {suppression}
              </div>
            )}

            {/* Active signal */}
            {/* Tier A — Micro Trend signals (active within 2 min) */}
            {tierA.filter((t) => Date.now() - t.timestamp < 2 * 60 * 1000).map((t) => {
              const dirCol = t.direction === "RISE" ? "text-[color:var(--rise)]" : "text-[color:var(--fall)]";
              const sign = t.direction === "RISE" ? 1 : -1;
              const slPts = Math.abs(t.sl - t.entryPrice);
              return (
                <div key={t.id} className="bg-card rounded-lg border-2 border-amber-500/80 p-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs uppercase tracking-wider text-amber-300 flex items-center gap-2">
                      ⚡ {t.isRegimeChange ? "REGIME CHANGE" : "TIER A · MICRO TREND"}
                      {t.isReversal && <span className="px-1.5 py-0.5 rounded bg-amber-500/30">↩ REVERSAL</span>}
                      {t.exhausting && <span className="px-1.5 py-0.5 rounded bg-rose-500/30">⚠ EXHAUSTING</span>}
                      {t.hmmState && <span className="px-1.5 py-0.5 rounded bg-blue-500/30">🧠 {t.hmmState.replace("_", " ")} {t.hmmConfidence}%</span>}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {Math.max(0, 120 - Math.floor((Date.now() - t.timestamp) / 1000))}s shown
                    </span>
                  </div>
                  <div className="flex items-baseline gap-4">
                    <span className={`text-3xl font-bold ${dirCol}`}>
                      {t.direction === "RISE" ? "🟢 RISE" : "🔴 FALL"}
                    </span>
                    <span className="text-sm font-mono text-muted-foreground">
                      {t.state.replace("_", " ")} ({Math.round(t.strength)}%)
                    </span>
                  </div>
                  <div className="mt-3 grid md:grid-cols-2 gap-2 text-xs font-mono">
                    <div>📍 Entry: <span className="font-bold">{fmt(t.entryPrice)}</span></div>
                    <div>Trend duration: {t.duration} candles</div>
                    <div>SL: {fmt(t.sl)} ({sign > 0 ? "−" : "+"}{slPts.toFixed(1)} pts)</div>
                    <div>TP1: {fmt(t.tp1)} · TP2: {fmt(t.tp2)}</div>
                    <div>Micro score: {t.entryScore > 0 ? "+" : ""}{t.entryScore}</div>
                    <div>⏱ 15 min contract</div>
                  </div>
                  <div className="mt-2 text-[11px] text-muted-foreground">{t.reason}</div>
                </div>
              );
            })}

            {activeSignal ? (
              <div className={`bg-card rounded-lg border-2 border-blue-500/70 p-6 ${
                activeSignal.direction === "RISE" ? "border-[color:var(--rise)]" : "border-[color:var(--fall)]"
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs uppercase tracking-wider text-blue-300">TIER B · CONFLUENCE · T{activeSignal.tier} · {activeSignal.tier === 1 ? "ELITE" : activeSignal.tier === 2 ? "STRONG" : activeSignal.tier === 3 ? "CONFIRMED" : "MODERATE"}</span>
                  <span className="text-xs text-muted-foreground">{activeSignal.strength}</span>
                </div>
                <div className="flex items-baseline gap-4">
                  <span className={`text-4xl font-bold ${activeSignal.direction === "RISE" ? "text-[color:var(--rise)]" : "text-[color:var(--fall)]"}`}>
                    {activeSignal.direction === "RISE" ? "🟢 RISE" : "🔴 FALL"}
                  </span>
                  <span className="text-2xl font-mono">{activeSignal.confidence}%</span>
                </div>
                <div className="mt-4 grid md:grid-cols-2 gap-3 text-sm font-mono">
                  <div>📍 Entry: <span className="font-bold">{fmt(activeSignal.entryPrice)}</span></div>
                  <div>⏱ Duration: 15 min</div>
                  <div>SL: {fmt(activeSignal.mtLevels.sl)}</div>
                  <div>TP1: {fmt(activeSignal.mtLevels.tp1)} · TP2: {fmt(activeSignal.mtLevels.tp2)}</div>
                  <div>Score: {activeSignal.score}/20</div>
                  <div>Pattern: {activeSignal.patternMatchRate.toFixed(0)}%</div>
                </div>
                <div className="mt-3 text-xs text-muted-foreground">{activeSignal.reasons.join(" · ")}</div>
                <MT5CopyPanel signal={activeSignal} />
              </div>
            ) : (
              <div className="bg-card rounded-lg border border-border p-8 text-center text-muted-foreground">
                🔍 Scanning V75 market...
                <div className="mt-2 text-xs">Final score: {analysis.finalScore} · raw {analysis.score.total} · trend {analysis.trend.bias >= 0 ? "+" : ""}{analysis.trend.bias} · daily {analysis.daily.bias}</div>
                <div className="mt-1 text-xs">Need ≥4 (RISE) or ≤−4 (FALL), with 2/3 timeframes agreeing.</div>
              </div>
            )}

            {regime && (() => {
              const stateColor = (i: number) =>
                i === 0 ? "bg-emerald-500" : i === 1 ? "bg-emerald-400/60" :
                i === 2 ? "bg-rose-400/60" : "bg-rose-500";
              const headerColor =
                regime.currentState === 0 ? "text-emerald-300" :
                regime.currentState === 1 ? "text-emerald-200" :
                regime.currentState === 2 ? "text-rose-200" : "text-rose-300";
              const nextTop = regime.nextStateProbs.indexOf(Math.max(...regime.nextStateProbs));
              return (
                <div className="bg-card rounded-lg border border-border p-4 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-primary">🧠 HMM Regime Detector</span>
                    <span className="text-[11px] font-mono text-muted-foreground">
                      {regime.modelConverged ? "✓ Converged" : "training…"} · logL {regime.modelLogLikelihood.toFixed(1)} · obs {regime.trainingObsCount}
                    </span>
                  </div>
                  <div className="grid md:grid-cols-2 gap-3 text-xs font-mono">
                    <div>
                      <div>Regime: <span className={`font-bold ${headerColor}`}>{regime.stateName.replace("_", " ")}</span></div>
                      <div>Confidence: <span className="font-bold">{regime.confidence}%</span></div>
                      <div>Duration: {regime.regimeDuration} candles {regime.isSustainable ? "✓ confirmed" : "(forming)"}</div>
                      <div>Bias: <span className={regime.dominantDirection === "RISE" ? "text-[color:var(--rise)]" : regime.dominantDirection === "FALL" ? "text-[color:var(--fall)]" : ""}>{regime.dominantDirection}</span></div>
                    </div>
                    <div className="space-y-1">
                      {regime.stateProbs.map((p, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="w-24 text-muted-foreground">{hmmManager.stateNames[i].replace("_", " ")}</span>
                          <div className="flex-1 h-2 bg-secondary rounded overflow-hidden">
                            <div className={`h-full ${stateColor(i)}`} style={{ width: `${Math.round(p * 100)}%` }} />
                          </div>
                          <span className="w-10 text-right">{Math.round(p * 100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="text-[11px] text-muted-foreground border-t border-border pt-2">
                    Next state likely: <span className="font-semibold">{hmmManager.stateNames[nextTop].replace("_", " ")}</span> ({Math.round(regime.nextStateProbs[nextTop] * 100)}%)
                    {regime.regimeChanged && <span className="ml-2 text-amber-300">🔄 just changed from {hmmManager.stateNames[regime.prevState].replace("_", " ")}</span>}
                  </div>
                </div>
              );
            })()}

            {/* Indicators */}
            <div className="bg-card rounded-lg border border-border p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
              {[
                { l: "RSI", v: analysis.ind.rsi.toFixed(1), ok: analysis.ind.rsi < 30 || analysis.ind.rsi > 70 },
                { l: "Stoch %K", v: analysis.ind.stochK.toFixed(1) },
                { l: "MACD Hist", v: analysis.ind.macdHist.toFixed(2) },
                { l: "BB Pos", v: (analysis.ind.bbPosition * 100).toFixed(0) + "%" },
                { l: "ATR", v: analysis.ind.atr.toFixed(2) },
                { l: "Wm %R", v: analysis.ind.williamsR.toFixed(1) },
                { l: "CCI", v: analysis.ind.cci.toFixed(1) },
                { l: "Rel ATR", v: analysis.ind.relativeAtr.toFixed(3) + "%" },
              ].map((x) => (
                <div key={x.l} className="bg-secondary rounded p-2">
                  <div className="text-muted-foreground">{x.l}</div>
                  <div className={`text-base font-bold ${x.ok ? "text-primary" : ""}`}>{x.v}</div>
                </div>
              ))}
            </div>

            {/* SMC panel */}
            <div className="bg-card rounded-lg border border-border p-4 space-y-2 text-sm">
              <div className="font-semibold text-primary">Smart Money Concepts</div>
              <div className="grid md:grid-cols-2 gap-2 font-mono text-xs">
                <div>CHoCH M1: {analysis.smcM1.choch !== "NONE" ? `🔄 ${analysis.smcM1.choch}` : "—"}</div>
                <div>Sweep: {analysis.smcM1.liquiditySweep !== "NONE" ? `💧 ${analysis.smcM1.liquiditySweep}` : "—"}</div>
                <div>Nearest BOB (H1): {analysis.smcH1.nearestBOB ? `${fmt(analysis.smcH1.nearestBOB.low)} – ${fmt(analysis.smcH1.nearestBOB.high)}` : "—"}</div>
                <div>Nearest BEOB (H1): {analysis.smcH1.nearestBEOB ? `${fmt(analysis.smcH1.nearestBEOB.low)} – ${fmt(analysis.smcH1.nearestBEOB.high)}` : "—"}</div>
                <div>FVG Bull: {analysis.smcM1.fvgs.filter((f) => f.type === "BULL").length}</div>
                <div>FVG Bear: {analysis.smcM1.fvgs.filter((f) => f.type === "BEAR").length}</div>
              </div>
            </div>

            {/* Candle Pattern Analysis */}
            <div className="bg-card rounded-lg border border-border p-4 space-y-2 text-sm">
              <div className="font-semibold text-primary flex items-center justify-between">
                <span>Candle Patterns</span>
                <span className="text-xs font-mono text-muted-foreground">Contribution: {analysis.patternScore >= 0 ? "+" : ""}{analysis.patternScore}</span>
              </div>
              {analysis.patterns.length === 0 ? (
                <div className="text-xs text-muted-foreground">No significant patterns on current candle. Waiting for next closed candle...</div>
              ) : (
                <div className="space-y-2">
                  {analysis.patterns.slice(0, 3).map((p, i) => (
                    <div key={i} className="border-l-2 pl-3" style={{ borderColor: colorForSignal(p.signal) }}>
                      <div className="text-xs font-mono flex gap-2 items-center">
                        <span style={{ color: colorForSignal(p.signal) }}>{p.label}</span>
                        <span className="text-muted-foreground">({p.signal >= 0 ? "+" : ""}{p.signal})</span>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{p.strength}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">{p.description}</div>
                    </div>
                  ))}
                  {analysis.patterns.length >= 2 && analysis.patterns[0].direction !== analysis.patterns[1].direction && analysis.patterns[1].direction !== "NEUTRAL" && (
                    <div className="text-xs text-amber-300">⚠ Conflicting patterns: {analysis.patterns[0].name} vs {analysis.patterns[1].name} — confidence reduced</div>
                  )}
                  {analysis.patternBoostReason && (
                    <div className={`text-xs font-mono ${analysis.patternBoostReason.startsWith("WARNING") ? "text-amber-300" : "text-emerald-300"}`}>
                      {analysis.patternBoostReason}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Pattern Scanner — last 10 candles */}
            <div className="bg-card rounded-lg border border-border p-4 space-y-2 text-sm">
              <div className="font-semibold text-primary flex items-center justify-between">
                <span>Pattern Scanner · Last 10 M15 candles</span>
                <span className={`text-xs font-mono ${analysis.scannerCumulative > 0 ? "text-[color:var(--rise)]" : analysis.scannerCumulative < 0 ? "text-[color:var(--fall)]" : "text-muted-foreground"}`}>
                  Σ {analysis.scannerCumulative >= 0 ? "+" : ""}{analysis.scannerCumulative}
                </span>
              </div>
              <div className="text-xs font-mono space-y-0.5">
                {analysis.patternScan.slice().reverse().map((row, idx) => {
                  const top = row.patterns[0];
                  const off = -idx;
                  return (
                    <div key={row.time} className="grid grid-cols-[40px_70px_1fr_50px] gap-2 items-center bg-secondary/40 rounded px-2 py-1">
                      <span className="text-muted-foreground">{off === 0 ? "now" : off}</span>
                      <span className="text-muted-foreground">{new Date(row.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      {top ? (
                        <>
                          <span style={{ color: colorForSignal(top.signal) }}>{top.label}</span>
                          <span className="text-right" style={{ color: colorForSignal(top.signal) }}>{top.signal >= 0 ? "+" : ""}{top.signal}</span>
                        </>
                      ) : (
                        <>
                          <span className="text-muted-foreground">—</span>
                          <span className="text-right text-muted-foreground">0</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="text-xs text-muted-foreground">
                Confluence: {analysis.scannerBull} bull · {analysis.scannerBear} bear ·{" "}
                {Math.abs(analysis.scannerCumulative) >= 6 ? (
                  <span className={analysis.scannerCumulative > 0 ? "text-[color:var(--rise)]" : "text-[color:var(--fall)]"}>
                    STRONG {analysis.scannerCumulative > 0 ? "RISE" : "FALL"} bias
                  </span>
                ) : Math.abs(analysis.scannerCumulative) >= 3 ? (
                  <span className="text-amber-300">Moderate {analysis.scannerCumulative > 0 ? "RISE" : "FALL"} bias</span>
                ) : "no strong pattern bias"}
              </div>
            </div>


            {patternMatch && patternMatch.matches.length > 0 && (
              <div className="bg-card rounded-lg border border-border p-4 text-sm">
                <div className="font-semibold mb-2">Pattern Memory ({patternMatch.matches.length} matches)</div>
                <div className="flex gap-2 text-xs font-mono">
                  <span className="text-[color:var(--rise)]">RISE {patternMatch.riseRate.toFixed(0)}%</span>
                  <span className="text-[color:var(--fall)]">FALL {patternMatch.fallRate.toFixed(0)}%</span>
                  <span className="text-muted-foreground">FLAT {patternMatch.flatRate.toFixed(0)}%</span>
                </div>
              </div>
            )}

            {/* Tier A signal log */}
            <div className="bg-card rounded-lg border border-amber-500/30 p-4">
              <div className="font-semibold mb-2 text-amber-300 flex items-center justify-between">
                <span>⚡ Tier A Signal Log ({tierA.length})</span>
                <span className="text-[11px] font-mono text-muted-foreground">
                  W {tierA.filter(t=>t.outcome==="WIN").length} · L {tierA.filter(t=>t.outcome==="LOSS").length} · P {tierA.filter(t=>!t.outcome||t.outcome==="PENDING").length}
                </span>
              </div>
              <div className="space-y-1 text-xs font-mono max-h-56 overflow-y-auto">
                {tierA.length === 0 && <div className="text-muted-foreground">No Tier A signals yet.</div>}
                {tierA.map((t) => (
                  <div key={t.id} className="grid grid-cols-[60px_60px_1fr_60px_60px] gap-2 bg-secondary rounded p-1.5 items-center">
                    <span className={t.direction === "RISE" ? "text-[color:var(--rise)]" : "text-[color:var(--fall)]"}>{t.direction}</span>
                    <span>{new Date(t.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    <span className="text-muted-foreground truncate">{t.state.replace("_", " ")}{t.isReversal ? " ↩" : ""} · {t.duration}c</span>
                    <span className="text-right">{t.entryScore > 0 ? "+" : ""}{t.entryScore}</span>
                    <span className={`text-right ${
                      t.outcome === "WIN" ? "text-[color:var(--rise)]" :
                      t.outcome === "LOSS" ? "text-[color:var(--fall)]" :
                      "text-amber-300"
                    }`}>{t.outcome === "WIN" ? "WIN" : t.outcome === "LOSS" ? "LOSS" : "⌛"}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Micro trend state history */}
            <div className="bg-card rounded-lg border border-border p-4">
              <div className="font-semibold mb-2 flex items-center justify-between">
                <span>Micro Trend History</span>
                <span className="text-[11px] text-muted-foreground">{trendHistory.length} transitions</span>
              </div>
              <div className="space-y-0.5 text-xs font-mono">
                <div className="grid grid-cols-[70px_120px_80px_60px] gap-2 text-muted-foreground border-b border-border pb-1">
                  <span>Time</span><span>State</span><span>Duration</span><span>Dir</span>
                </div>
                {trendHistory.length === 0 && <div className="text-muted-foreground py-1">Awaiting state changes…</div>}
                {trendHistory.slice(0, 10).map((h) => (
                  <div key={h.time} className="grid grid-cols-[70px_120px_80px_60px] gap-2 bg-secondary/40 rounded px-2 py-1">
                    <span className="text-muted-foreground">{new Date(h.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className={
                      h.state.includes("BULL") || h.state === "REVERSAL_UP" ? "text-[color:var(--rise)]" :
                      h.state.includes("BEAR") || h.state === "REVERSAL_DOWN" ? "text-[color:var(--fall)]" :
                      "text-muted-foreground"
                    }>{h.state.replace("_", " ")}</span>
                    <span>{h.duration}c</span>
                    <span className={
                      h.direction === "RISE" ? "text-[color:var(--rise)]" :
                      h.direction === "FALL" ? "text-[color:var(--fall)]" :
                      "text-muted-foreground"
                    }>{h.direction === "RISE" ? "↑" : h.direction === "FALL" ? "↓" : "—"}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ⚡ MICRO-REVERSAL SCANNER PANEL */}
            <div className="bg-card rounded-lg border border-border p-4">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">⚡ MICRO-REVERSAL SCANNER</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase tracking-wider">Equal Highs/Lows Detector</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setMrSettingsOpen((v) => !v)}
                    className="text-[11px] px-2 py-1 rounded bg-secondary hover:bg-secondary/70">⚙ Settings</button>
                  <button onClick={() => updateMRSettings({ enabled: !mrSettings.enabled })}
                    className={`text-[11px] px-2 py-1 rounded font-semibold ${
                      mrSettings.enabled ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
                    }`}>
                    {mrSettings.enabled ? "ON" : "OFF"}
                  </button>
                </div>
              </div>

              {mrSettingsOpen && (
                <div className="mb-3 p-3 rounded bg-secondary/40 border border-border text-xs space-y-2">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Min Confidence (%)</span>
                      <input type="number" min={0} max={100} value={mrSettings.minConfidence}
                        onChange={(e) => updateMRSettings({ minConfidence: +e.target.value })}
                        className="bg-background border border-border rounded px-2 py-1" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Alert Min (%)</span>
                      <input type="number" min={0} max={100} value={mrSettings.alertMinConfidence}
                        onChange={(e) => updateMRSettings({ alertMinConfidence: +e.target.value })}
                        className="bg-background border border-border rounded px-2 py-1" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Tolerance Mode</span>
                      <select value={mrSettings.toleranceMode}
                        onChange={(e) => updateMRSettings({ toleranceMode: e.target.value as any })}
                        className="bg-background border border-border rounded px-2 py-1">
                        <option value="auto">Auto (8% ATR)</option>
                        <option value="manual">Manual</option>
                      </select>
                    </label>
                    {mrSettings.toleranceMode === "manual" && (
                      <label className="flex flex-col gap-1">
                        <span className="text-muted-foreground">Manual Tolerance (pts)</span>
                        <input type="number" step="0.1" value={mrSettings.manualTolerance}
                          onChange={(e) => updateMRSettings({ manualTolerance: +e.target.value })}
                          className="bg-background border border-border rounded px-2 py-1" />
                      </label>
                    )}
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Trade Duration</span>
                      <select value={mrSettings.tradeDuration}
                        onChange={(e) => updateMRSettings({ tradeDuration: e.target.value as any })}
                        className="bg-background border border-border rounded px-2 py-1">
                        <option value="auto">Auto</option>
                        <option value="3min">3min</option>
                        <option value="5min">5min</option>
                        <option value="6min">6min</option>
                        <option value="15min">15min</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Eval Window (min)</span>
                      <input type="number" min={1} max={60} value={mrSettings.evaluationWindow}
                        onChange={(e) => updateMRSettings({ evaluationWindow: +e.target.value })}
                        className="bg-background border border-border rounded px-2 py-1" />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-3 pt-1">
                    {([
                      ["enableEqualHighs", "Equal Highs Reversal"],
                      ["enableEqualLows", "Equal Lows Reversal"],
                      ["enableBreakdown", "Equal Lows Breakdown"],
                      ["enableBreakout", "Equal Highs Breakout"],
                      ["requireCrossConfirmation", "Require cross-confirmation"],
                      ["showOnChart", "Show on chart"],
                    ] as const).map(([k, label]) => (
                      <label key={k} className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!(mrSettings as any)[k]}
                          onChange={(e) => updateMRSettings({ [k]: e.target.checked } as any)} />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Telegram Bot Token</span>
                      <input type="password" value={mrSettings.telegramBotToken}
                        onChange={(e) => updateMRSettings({ telegramBotToken: e.target.value })}
                        className="bg-background border border-border rounded px-2 py-1" />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Telegram Chat ID</span>
                      <input type="text" value={mrSettings.telegramChatId}
                        onChange={(e) => updateMRSettings({ telegramChatId: e.target.value })}
                        className="bg-background border border-border rounded px-2 py-1" />
                    </label>
                  </div>
                </div>
              )}

              {mrCurrent ? (() => {
                const dirColor = mrCurrent.direction === "RISE" ? "emerald" : "rose";
                const borderCls = mrCurrent.counterTrend
                  ? "border-amber-500/60"
                  : mrCurrent.direction === "RISE" ? "border-emerald-500/60" : "border-rose-500/60";
                return (
                  <div className={`rounded-lg border-2 ${borderCls} p-3 space-y-2 text-xs font-mono`}>
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className={`font-bold text-sm text-${dirColor}-300`}>
                        {mrCurrent.direction === "RISE" ? "🟢 RISE" : "🔴 FALL"} — {mrCurrent.patternType.replace(/_/g, " ")}
                      </span>
                      <span className="text-muted-foreground">
                        ⏰ {new Date(mrCurrent.ts).toISOString().slice(11, 19)} UTC · Entry: {mrCurrent.entryPrice.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span>Confidence:</span>
                      <span className="font-bold">{mrCurrent.confidence}%</span>
                      <span className="inline-block flex-1 max-w-[200px] h-2 rounded bg-black/40 overflow-hidden">
                        <span className={`block h-full bg-${dirColor}-400`} style={{ width: `${mrCurrent.confidence}%` }} />
                      </span>
                      <span className="uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded bg-secondary">{mrCurrent.strength}</span>
                      <span>Duration: {mrCurrent.recommendedDuration} · R:R {mrCurrent.riskRewardRatio}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <div className="bg-secondary/40 rounded p-2">📍 Entry: <b>{mrCurrent.entryPrice.toFixed(2)}</b></div>
                      <div className="bg-rose-500/10 rounded p-2 text-rose-200">🛑 SL: <b>{mrCurrent.suggestedSL.toFixed(2)}</b></div>
                      <div className="bg-emerald-500/10 rounded p-2 text-emerald-200">🎯 TP1: <b>{mrCurrent.suggestedTP1.toFixed(2)}</b> · TP2: <b>{mrCurrent.suggestedTP2.toFixed(2)}</b></div>
                    </div>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {mrCurrent.confluenceFactors.map((f) => (
                        <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">✅ {f.replace(/_/g, " ")}</span>
                      ))}
                    </div>
                    {mrCurrent.crossConfirmed && (
                      <div className="text-emerald-300 font-semibold pt-1">🔄 DOUBLE CONFIRMED — Main + Micro agree</div>
                    )}
                    {mrCurrent.counterTrend && (
                      <div className="text-amber-300 font-semibold pt-1">⚠ COUNTER-TREND — Main analyzer says {mrCurrent.existingAnalyzerDirection}</div>
                    )}
                    <button onClick={() => {
                      navigator.clipboard?.writeText(
                        `${mrCurrent.direction} ${mrCurrent.entryPrice.toFixed(2)} SL ${mrCurrent.suggestedSL.toFixed(2)} TP1 ${mrCurrent.suggestedTP1.toFixed(2)} TP2 ${mrCurrent.suggestedTP2.toFixed(2)}`,
                      );
                    }} className="text-[11px] px-2 py-1 rounded bg-primary text-primary-foreground">Copy All</button>
                  </div>
                );
              })() : (
                <div className="text-xs text-muted-foreground italic">Awaiting micro-reversal pattern…</div>
              )}

              {/* Signal history */}
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Recent micro-reversal signals (last 20)</div>
                {mrSignals.length === 0 && <div className="text-xs text-muted-foreground italic">No micro-reversal signals yet.</div>}
                <div className="space-y-0.5 text-[11px] font-mono">
                  {mrSignals.slice(0, 20).map((s) => {
                    const time = new Date(s.ts).toISOString().slice(11, 19);
                    const patShort = s.patternType.includes("breakdown") ? "Brkdwn" :
                                     s.patternType.includes("breakout") ? "Brkout" :
                                     s.patternType.includes("highs") ? "EqualH" : "EqualL";
                    return (
                      <div key={s.timestamp} className="grid grid-cols-[60px_50px_50px_70px_60px_80px] gap-2 bg-secondary/40 rounded px-2 py-1 items-center">
                        <span className="text-muted-foreground">{time}</span>
                        <span className={s.direction === "RISE" ? "text-[color:var(--rise)]" : "text-[color:var(--fall)]"}>{s.direction}</span>
                        <span>{s.confidence}%</span>
                        <span className="inline-block h-1.5 rounded bg-black/40 overflow-hidden">
                          <span className={`block h-full ${s.direction === "RISE" ? "bg-emerald-400" : "bg-rose-400"}`} style={{ width: `${s.confidence}%` }} />
                        </span>
                        <span className="text-muted-foreground">{patShort}</span>
                        <span className={
                          s.outcome === "WIN" ? "text-[color:var(--rise)] font-semibold" :
                          s.outcome === "LOSS" ? "text-[color:var(--fall)] font-semibold" :
                          "text-amber-300"
                        }>{s.outcome ?? "PENDING"}</span>
                      </div>
                    );
                  })}
                </div>
                {mrSignals.length > 0 && (() => {
                  const w = mrSignals.filter((s) => s.outcome === "WIN").length;
                  const l = mrSignals.filter((s) => s.outcome === "LOSS").length;
                  const wr = w + l > 0 ? Math.round((w / (w + l)) * 100) : 0;
                  const pnl = w * 8 - l * 10;
                  return (
                    <div className="text-[11px] font-mono mt-2 px-2 py-1 rounded bg-secondary">
                      {w}W / {l}L | Win Rate: {wr}% | Est. P&L:
                      <span className={pnl >= 0 ? " text-[color:var(--rise)]" : " text-[color:var(--fall)]"}> {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}</span>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {!loading && tab === "chart" && (
          <div className="space-y-3">
            <div className="flex gap-1">
              {(["M1", "M5", "M15", "H1", "H4"] as TF[]).map((t) => (
                <button key={t} onClick={() => setChartTF(t)}
                  className={`px-3 py-1.5 text-xs rounded ${chartTF === t ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>{t}</button>
              ))}
            </div>
            {chartCandles.length > 30 && (() => {
              const tfInd = computeIndicators(chartCandles);
              if (!tfInd) return null;
              const tfSmc =
                chartTF === "M1" ? analysis?.smcM1 :
                chartTF === "M5" ? analysis?.smcM5 :
                chartTF === "M15" ? analysis?.smcM15 :
                chartTF === "H1" ? analysis?.smcH1 : analysis?.smcH4;
              const last = chartCandles[chartCandles.length - 1];
              const cell = "flex flex-col gap-0.5 bg-card/60 rounded px-2 py-1.5 border border-border";
              const lbl = "text-[10px] uppercase tracking-wider text-muted-foreground";
              const val = "text-xs font-mono font-semibold";
              return (
                <div className="bg-card rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold">{chartTF} Live Readout</span>
                    <span className="font-mono text-muted-foreground">
                      O {fmt(last.open)} · H {fmt(last.high)} · L {fmt(last.low)} · C {fmt(last.close)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-1.5">
                    <div className={cell}><span className={lbl}>Price</span><span className={val}>{fmt(price || last.close)}</span></div>
                    <div className={cell}><span className={lbl}>EMA 9</span><span className={val} style={{ color: "#3B82F6" }}>{fmt(tfInd.ema9)}</span></div>
                    <div className={cell}><span className={lbl}>EMA 21</span><span className={val} style={{ color: "#F59E0B" }}>{fmt(tfInd.ema21)}</span></div>
                    <div className={cell}><span className={lbl}>EMA 50</span><span className={val} style={{ color: "#E2E8F0" }}>{fmt(tfInd.ema50)}</span></div>
                    <div className={cell}><span className={lbl}>EMA 200</span><span className={val} style={{ color: "#8B5CF6" }}>{fmt(tfInd.ema200)}</span></div>
                    <div className={cell}><span className={lbl}>RSI 14</span><span className={val}>{tfInd.rsi.toFixed(1)}</span></div>
                    <div className={cell}><span className={lbl}>Stoch %K</span><span className={val}>{tfInd.stochK.toFixed(1)}</span></div>
                    <div className={cell}><span className={lbl}>Stoch %D</span><span className={val}>{tfInd.stochD.toFixed(1)}</span></div>
                    <div className={cell}><span className={lbl}>MACD</span><span className={val}>{tfInd.macdLine.toFixed(2)}</span></div>
                    <div className={cell}><span className={lbl}>MACD Sig</span><span className={val}>{tfInd.macdSignal.toFixed(2)}</span></div>
                    <div className={cell}><span className={lbl}>MACD Hist</span><span className={val} style={{ color: tfInd.macdHist >= 0 ? "var(--rise)" : "var(--fall)" }}>{tfInd.macdHist.toFixed(2)}</span></div>
                    <div className={cell}><span className={lbl}>BB Upper</span><span className={val}>{fmt(tfInd.bbUpper)}</span></div>
                    <div className={cell}><span className={lbl}>BB Middle</span><span className={val}>{fmt(tfInd.bbMiddle)}</span></div>
                    <div className={cell}><span className={lbl}>BB Lower</span><span className={val}>{fmt(tfInd.bbLower)}</span></div>
                    <div className={cell}><span className={lbl}>BB Width</span><span className={val}>{tfInd.bbWidth.toFixed(2)}</span></div>
                    <div className={cell}><span className={lbl}>BB Pos</span><span className={val}>{(tfInd.bbPosition * 100).toFixed(0)}%</span></div>
                    <div className={cell}><span className={lbl}>ATR 14</span><span className={val}>{tfInd.atr.toFixed(2)}</span></div>
                    <div className={cell}><span className={lbl}>Rel ATR</span><span className={val}>{(tfInd.relativeAtr * 100).toFixed(2)}%</span></div>
                    <div className={cell}><span className={lbl}>Williams %R</span><span className={val}>{tfInd.williamsR.toFixed(1)}</span></div>
                    <div className={cell}><span className={lbl}>CCI 20</span><span className={val}>{tfInd.cci.toFixed(1)}</span></div>
                    <div className={cell}><span className={lbl}>RSI Div</span><span className={val}>{tfInd.rsiDivergence}</span></div>
                    <div className={cell}><span className={lbl}>MACD Div</span><span className={val}>{tfInd.macdDivergence}</span></div>
                    {tfSmc && <div className={cell}><span className={lbl}>CHoCH</span><span className={val}>{tfSmc.choch}</span></div>}
                    {tfSmc && <div className={cell}><span className={lbl}>Sweep</span><span className={val}>{tfSmc.liquiditySweep}</span></div>}
                    {tfSmc && <div className={cell}><span className={lbl}>BOS</span><span className={val}>{tfSmc.bos}</span></div>}
                  </div>
                </div>
              );
            })()}
            <div className="bg-card rounded-lg border border-border p-2">
              {chartCandles.length > 0 && analysis ? (
                <V75Chart
                  candles={chartCandles}
                  smc={
                    chartTF === "M1" ? analysis.smcM1 :
                    chartTF === "M5" ? analysis.smcM5 :
                    chartTF === "M15" ? analysis.smcM15 :
                    chartTF === "H1" ? analysis.smcH1 : analysis.smcH4
                  }
                  smcHigher={chartTF === "M1" || chartTF === "M5" || chartTF === "M15" ? [
                    { tf: "H1", obs: analysis.smcH1.orderBlocks },
                    { tf: "H4", obs: analysis.smcH4.orderBlocks },
                  ] : []}
                  livePrice={price}
                  patternMarkers={(() => {
                    // compute pattern markers for the active TF (last 50)
                    const tfClosed = chartCandles.slice(0, -1);
                    const tfInd2 = computeIndicators(tfClosed);
                    if (!tfInd2 || tfInd2.atr <= 0) return [];
                    const scan = scanPatternHistory(tfClosed, tfInd2.atr, 50);
                    const out: { time: number; pattern: PatternResult }[] = [];
                    for (const row of scan) {
                      if (row.patterns.length === 0) continue;
                      out.push({ time: row.time, pattern: row.patterns[0] });
                    }
                    return out;
                  })()}
                  microState={microTrend?.state ?? "NEUTRAL"}
                  showMicroRibbon={chartTF === "M1" || chartTF === "M15"}
                />
              ) : <div className="h-[500px] flex items-center justify-center text-muted-foreground">Loading {chartTF}...</div>}
            </div>
          </div>
        )}

        {!loading && tab === "pattern" && (
          <div className="space-y-3">
            <div className="bg-card rounded-lg border border-border p-4">
              <div className="text-sm text-muted-foreground">Learning database</div>
              <div className="text-3xl font-bold">{history.length} segments</div>
            </div>
            {patternMatch && (
              <div className="bg-card rounded-lg border border-border p-4 space-y-2 text-sm font-mono">
                <div>Top matches: {patternMatch.matches.length}</div>
                <div className="text-[color:var(--rise)]">RISE: {patternMatch.riseRate.toFixed(1)}%</div>
                <div className="text-[color:var(--fall)]">FALL: {patternMatch.fallRate.toFixed(1)}%</div>
                <div className="text-muted-foreground">FLAT: {patternMatch.flatRate.toFixed(1)}%</div>
              </div>
            )}
            <div className="bg-card rounded-lg border border-border p-4">
              <div className="text-sm font-semibold mb-2">Recent Segments</div>
              <div className="space-y-1 text-xs font-mono">
                {history.slice(0, 10).map((s, i) => (
                  <div key={i} className="flex justify-between">
                    <span>{s.timeStr}</span>
                    <span className={s.outcome === "RISE" ? "text-[color:var(--rise)]" : s.outcome === "FALL" ? "text-[color:var(--fall)]" : "text-muted-foreground"}>{s.outcome}</span>
                    <span>{s.pointMove > 0 ? "+" : ""}{s.pointMove.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {!loading && tab === "learning" && (
          <div className="space-y-3">
            <div className="bg-card rounded-lg border border-border p-4">
              <div className="font-semibold mb-2">Condition Accuracy</div>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                {conditionAccuracy(history).map((c) => (
                  <div key={c.name} className="flex justify-between bg-secondary p-2 rounded">
                    <span>{c.name}</span>
                    <span>{c.total ? `${c.accuracy.toFixed(0)}% (${c.total})` : "—"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-card rounded-lg border border-border p-4">
              <div className="font-semibold mb-2">Pattern Accuracy on V75</div>
              {Object.values(condStats).filter((s) => s.name.startsWith("PATTERN_")).length === 0 ? (
                <div className="text-xs text-muted-foreground">No pattern outcomes recorded yet. Patterns are tracked as signals resolve.</div>
              ) : (
                <div className="space-y-1 text-xs font-mono">
                  <div className="grid grid-cols-[1fr_70px_60px] gap-2 text-muted-foreground border-b border-border pb-1">
                    <span>Pattern</span><span className="text-right">Accuracy</span><span className="text-right">Total</span>
                  </div>
                  {Object.values(condStats)
                    .filter((s) => s.name.startsWith("PATTERN_"))
                    .sort((a, b) => b.accuracy - a.accuracy)
                    .map((s) => {
                      const reliable = s.accuracy >= 80 && s.total >= 10;
                      return (
                        <div key={s.name} className={`grid grid-cols-[1fr_70px_60px] gap-2 p-1 rounded ${reliable ? "bg-amber-500/15 text-amber-200" : "bg-secondary"}`}>
                          <span>{s.name.replace("PATTERN_", "").replace(/_/g, " ")}</span>
                          <span className="text-right">{s.accuracy.toFixed(0)}%</span>
                          <span className="text-right">{s.total}</span>
                        </div>
                      );
                    })}
                  <div className="text-[10px] text-muted-foreground pt-1">Gold rows = ≥80% accuracy with ≥10 samples (highly reliable on V75).</div>
                </div>
              )}
            </div>
            <div className="bg-card rounded-lg border border-border p-4">
              <div className="font-semibold mb-2">Hour-of-day (UTC)</div>
              <div className="grid grid-cols-6 md:grid-cols-12 gap-1 text-xs font-mono">
                {hourStats(history).map((h) => (
                  <div key={h.hour} className={`p-2 rounded text-center ${
                    h.total === 0 ? "bg-secondary text-muted-foreground" :
                    h.winRate >= 65 ? "bg-emerald-500/20 text-emerald-300" :
                    h.winRate >= 50 ? "bg-amber-500/20 text-amber-300" :
                    "bg-rose-500/20 text-rose-300"
                  }`}>
                    <div>{h.hour}h</div>
                    <div>{h.total}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {!loading && tab === "history" && (
          <div className="bg-card rounded-lg border border-border p-4">
            <div className="font-semibold mb-3 flex items-center justify-between flex-wrap gap-2">
              <span>Signal History</span>
              <span className="text-xs font-mono font-normal text-muted-foreground">
                Today: <span className="text-[color:var(--rise)]">{wins}W</span> / <span className="text-[color:var(--fall)]">{losses}L</span> / {pending}P · Win rate {winRate}% · Est. P&L <span className={pnl >= 0 ? "text-[color:var(--rise)]" : "text-[color:var(--fall)]"}>{pnl >= 0 ? "+" : ""}${pnl}</span>
              </span>
            </div>
            <div className="space-y-1 text-xs font-mono">
              {signals.length === 0 && <div className="text-muted-foreground">No signals fired yet.</div>}
              {signals.map((s) => {
                const age = Date.now() - s.timestamp;
                const tracking = age < 15 * 60 * 1000 && (!s.outcome || s.outcome === "PENDING");
                const patLabel = (s.reasons || []).find((r) => /^[^A-Z]/.test(r) && /\(/.test(r));
                return (
                  <div key={s.id} className="flex justify-between gap-2 bg-secondary p-2 rounded items-center">
                    <span className={s.direction === "RISE" ? "text-[color:var(--rise)]" : "text-[color:var(--fall)]"}>{s.direction}</span>
                    <span>{new Date(s.timestamp).toLocaleTimeString()}</span>
                    <span>{s.score}</span>
                    <span>{s.confidence}%</span>
                    <span>T{s.tier}</span>
                    <span className="text-muted-foreground text-[11px] truncate max-w-[140px]">{patLabel || "—"}</span>
                    <span className={
                      s.outcome === "WIN" ? "text-[color:var(--rise)] font-semibold" :
                      s.outcome === "LOSS" ? "text-[color:var(--fall)] font-semibold" :
                      tracking ? "text-amber-300" : "text-muted-foreground"
                    }>
                      {s.outcome === "WIN" ? "✅ WIN" : s.outcome === "LOSS" ? "❌ LOSS" : tracking ? "⌛ TRACKING" : "⏳ PENDING"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!loading && tab === "backtest" && (
          <div className="space-y-3">
            <div className="bg-card rounded-lg border border-border p-4">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <div>
                  <div className="font-semibold">⚡ Micro-Reversal Backtest</div>
                  <div className="text-[11px] text-muted-foreground">Runs the scanner over loaded M1 candles ({m1.length} available)</div>
                </div>
                <button
                  disabled={backtestRunning || m1.length < 60}
                  onClick={() => {
                    setBacktestRunning(true);
                    setTimeout(() => {
                      try {
                        const closed = m1.slice(0, -1);
                        const closes = closed.map((c) => c.close);
                        const e9 = emaSeries(closes, 9);
                        const e21 = emaSeries(closes, 21);
                        const a = atrSeries(closed, 14);
                        const bb = bollingerSeries(closes, 20, 2);
                        const res = runMRBacktest(closed, a, e9, e21, bb.upper, bb.lower, mrSettings);
                        setBacktest(res);
                      } catch (e) { console.error(e); }
                      setBacktestRunning(false);
                    }, 50);
                  }}
                  className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50">
                  {backtestRunning ? "Running…" : "Run Backtest"}
                </button>
              </div>
              {!backtest && <div className="text-xs text-muted-foreground italic">Click Run Backtest to evaluate the scanner against loaded history.</div>}
              {backtest && (
                <div className="space-y-3 text-xs font-mono">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="bg-secondary/40 rounded p-2"><div className="text-muted-foreground text-[10px] uppercase">Total Signals</div><div className="text-lg font-bold">{backtest.totalSignals}</div></div>
                    <div className="bg-secondary/40 rounded p-2"><div className="text-muted-foreground text-[10px] uppercase">≥ 45%</div><div className="text-lg font-bold">{backtest.above45}</div></div>
                    <div className="bg-secondary/40 rounded p-2"><div className="text-muted-foreground text-[10px] uppercase">≥ 60%</div><div className="text-lg font-bold">{backtest.above60}</div></div>
                    <div className="bg-secondary/40 rounded p-2"><div className="text-muted-foreground text-[10px] uppercase">≥ 80%</div><div className="text-lg font-bold">{backtest.above80}</div></div>
                  </div>
                  <div className="bg-secondary/40 rounded p-3">
                    <div className="font-semibold mb-1">Win Rates by Pattern (3 / 6 / 15 min)</div>
                    {(Object.entries(backtest.byPattern)).map(([k, v]) => (
                      <div key={k} className="grid grid-cols-[1fr_60px_60px_60px_50px] gap-2 py-0.5">
                        <span>{k.replace(/_/g, " ")}</span>
                        <span>{v.total ? Math.round((v.wins3 / v.total) * 100) : 0}%</span>
                        <span>{v.total ? Math.round((v.wins6 / v.total) * 100) : 0}%</span>
                        <span>{v.total ? Math.round((v.wins15 / v.total) * 100) : 0}%</span>
                        <span className="text-muted-foreground">n={v.total}</span>
                      </div>
                    ))}
                  </div>
                  <div className="bg-secondary/40 rounded p-3 grid grid-cols-2 gap-3">
                    <div>Optimal at conf ≥ 65%: <b>{backtest.threshold65WinRate}%</b></div>
                    <div>Optimal at conf ≥ 75%: <b>{backtest.threshold75WinRate}%</b></div>
                  </div>
                  {backtest.equityCurve.length > 0 && (
                    <div className="bg-secondary/40 rounded p-3">
                      <div className="font-semibold mb-2">Equity Curve ($10 trades · 80% payout)</div>
                      <div style={{ width: "100%", height: 220 }}>
                        <ResponsiveContainer>
                          <LineChart data={backtest.equityCurve.map((p) => ({ t: new Date(p.t * 1000).toISOString().slice(11, 16), pnl: p.pnl }))}>
                            <CartesianGrid stroke="#1a2336" strokeDasharray="3 3" />
                            <XAxis dataKey="t" stroke="#94a3b8" tick={{ fontSize: 10 }} />
                            <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} />
                            <Tooltip contentStyle={{ background: "#0F1624", border: "1px solid #1a2336" }} />
                            <Line type="monotone" dataKey="pnl" stroke="#00E676" strokeWidth={2} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                  <div className="bg-secondary/40 rounded p-3">
                    <div className="font-semibold mb-1">By Hour of Day (UTC) — 6-min win rate</div>
                    <div className="grid grid-cols-6 md:grid-cols-12 gap-1">
                      {Array.from({ length: 24 }, (_, h) => h).map((h) => {
                        const b = backtest.byHour[h];
                        const wr = b && b.total ? Math.round((b.wins / b.total) * 100) : 0;
                        return (
                          <div key={h} className={`p-1.5 rounded text-center text-[10px] ${
                            !b || b.total === 0 ? "bg-secondary text-muted-foreground" :
                            wr >= 65 ? "bg-emerald-500/20 text-emerald-300" :
                            wr >= 50 ? "bg-amber-500/20 text-amber-300" :
                            "bg-rose-500/20 text-rose-300"
                          }`}>
                            <div>{h}h</div>
                            <div>{b ? `${wr}%` : "—"}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}