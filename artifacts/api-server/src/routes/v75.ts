import { Router } from "express";
import { db, v75SegmentRecordsTable, v75SignalHistoryTable, v75ConditionStatsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const router = Router();

// ─── Segments ──────────────────────────────────────────────────────────────

router.get("/segments", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const rows = await db
      .select()
      .from(v75SegmentRecordsTable)
      .orderBy(desc(v75SegmentRecordsTable.timestamp))
      .limit(limit);
    res.json(rows.map(serializeSegment));
  } catch (err) {
    req.log.error({ err }, "listSegments failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/segments", async (req, res) => {
  try {
    const body = req.body;
    const [row] = await db
      .insert(v75SegmentRecordsTable)
      .values({
        timestamp: String(body.timestamp),
        dateStr: body.date_str,
        timeStr: body.time_str,
        openPrice: String(body.open_price),
        closePrice: String(body.close_price),
        outcome: body.outcome ?? null,
        pointMove: String(body.point_move),
        score: Number(body.score),
        adjustedScore: body.adjusted_score != null ? Number(body.adjusted_score) : null,
        rsi: body.rsi != null ? String(body.rsi) : null,
        stochK: body.stoch_k != null ? String(body.stoch_k) : null,
        stochD: body.stoch_d != null ? String(body.stoch_d) : null,
        macdHistogram: body.macd_histogram != null ? String(body.macd_histogram) : null,
        williamsR: body.williams_r != null ? String(body.williams_r) : null,
        cci: body.cci != null ? String(body.cci) : null,
        bbPosition: body.bb_position != null ? String(body.bb_position) : null,
        bbWidth: body.bb_width != null ? String(body.bb_width) : null,
        atr: body.atr != null ? String(body.atr) : null,
        relativeAtr: body.relative_atr != null ? String(body.relative_atr) : null,
        ema9: body.ema9 != null ? String(body.ema9) : null,
        ema21: body.ema21 != null ? String(body.ema21) : null,
        ema50: body.ema50 != null ? String(body.ema50) : null,
        ema200: body.ema200 != null ? String(body.ema200) : null,
        emaAlignment: body.ema_alignment ?? null,
        hasActiveBOB: body.has_active_bob ?? null,
        hasActiveBEOB: body.has_active_beob ?? null,
        obTimeframe: body.ob_timeframe ?? null,
        hasFVGBull: body.has_fvg_bull ?? null,
        hasFVGBear: body.has_fvg_bear ?? null,
        chochDetected: body.choch_detected ?? null,
        liquiditySweep: body.liquidity_sweep ?? null,
        h4Bias: body.h4_bias ?? null,
        h1Bias: body.h1_bias ?? null,
        topDownAlignment: body.top_down_alignment ?? null,
        candlePattern: body.candle_pattern ?? null,
        structure: body.structure ?? null,
        rsiDivergence: body.rsi_divergence ?? null,
        macdDivergence: body.macd_divergence ?? null,
        hourOfDay: body.hour_of_day != null ? Number(body.hour_of_day) : null,
        dayOfWeek: body.day_of_week != null ? Number(body.day_of_week) : null,
        dominantPattern: body.dominant_pattern ?? null,
        patternScore: body.pattern_score != null ? Number(body.pattern_score) : null,
        patternDirection: body.pattern_direction ?? null,
        m15Bias: body.m15_bias ?? null,
      })
      .returning();
    res.status(201).json(serializeSegment(row));
  } catch (err) {
    req.log.error({ err }, "createSegment failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Signals ───────────────────────────────────────────────────────────────

router.get("/signals", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const rows = await db
      .select()
      .from(v75SignalHistoryTable)
      .orderBy(desc(v75SignalHistoryTable.timestamp))
      .limit(limit);
    res.json(rows.map(serializeSignal));
  } catch (err) {
    req.log.error({ err }, "listSignals failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/signals", async (req, res) => {
  try {
    const body = req.body;
    const [row] = await db
      .insert(v75SignalHistoryTable)
      .values({
        id: body.id,
        timestamp: String(body.timestamp),
        direction: body.direction,
        strength: body.strength,
        confidence: Number(body.confidence),
        score: Number(body.score),
        adjustedScore: body.adjusted_score != null ? Number(body.adjusted_score) : null,
        durationMinutes: Number(body.duration_minutes),
        entryPrice: body.entry_price != null ? String(body.entry_price) : null,
        outcome: body.outcome ?? "PENDING",
        chochPresent: body.choch_present ?? null,
        sweepPresent: body.sweep_present ?? null,
        obTimeframe: body.ob_timeframe ?? null,
        h4Bias: body.h4_bias ?? null,
        h1Bias: body.h1_bias ?? null,
        patternMatchRate: body.pattern_match_rate != null ? String(body.pattern_match_rate) : null,
      })
      .returning();
    res.status(201).json(serializeSignal(row));
  } catch (err) {
    req.log.error({ err }, "createSignal failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/signals/:id/outcome", async (req, res) => {
  try {
    const { id } = req.params;
    const { outcome, exit_price } = req.body;
    const [row] = await db
      .update(v75SignalHistoryTable)
      .set({ outcome, exitPrice: String(exit_price) })
      .where(eq(v75SignalHistoryTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Signal not found" });
    res.json(serializeSignal(row));
  } catch (err) {
    req.log.error({ err }, "updateSignalOutcome failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Conditions ────────────────────────────────────────────────────────────

router.get("/conditions", async (req, res) => {
  try {
    const rows = await db.select().from(v75ConditionStatsTable);
    res.json(rows.map(serializeCondition));
  } catch (err) {
    req.log.error({ err }, "listConditions failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/conditions/bump", async (req, res) => {
  try {
    const { conditions, outcome } = req.body as { conditions: string[]; outcome: "RISE" | "FALL" | "FLAT" };
    for (const name of conditions) {
      const [existing] = await db
        .select()
        .from(v75ConditionStatsTable)
        .where(eq(v75ConditionStatsTable.conditionName, name));
      const riseWins = (Number(existing?.riseWins ?? 0)) + (outcome === "RISE" ? 1 : 0);
      const fallWins = (Number(existing?.fallWins ?? 0)) + (outcome === "FALL" ? 1 : 0);
      const total = (Number(existing?.total ?? 0)) + 1;
      const accuracy = total ? (Math.max(riseWins, fallWins) / total) * 100 : 0;
      let weightMultiplier = 1.0;
      if (total >= 30) {
        if (accuracy >= 85) weightMultiplier = 1.5;
        else if (accuracy >= 75) weightMultiplier = 1.3;
        else if (accuracy >= 65) weightMultiplier = 1.1;
        else if (accuracy < 50) weightMultiplier = 0.6;
      }
      await db
        .insert(v75ConditionStatsTable)
        .values({
          conditionName: name,
          riseWins,
          fallWins,
          total,
          accuracy: accuracy.toFixed(2),
          weightMultiplier: String(weightMultiplier),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: v75ConditionStatsTable.conditionName,
          set: {
            riseWins,
            fallWins,
            total,
            accuracy: accuracy.toFixed(2),
            weightMultiplier: String(weightMultiplier),
            updatedAt: new Date(),
          },
        });
    }
    res.json({ status: "ok" });
  } catch (err) {
    req.log.error({ err }, "bumpConditions failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Serializers ───────────────────────────────────────────────────────────

function serializeSegment(r: typeof v75SegmentRecordsTable.$inferSelect) {
  return {
    id: r.id,
    timestamp: Number(r.timestamp),
    date_str: r.dateStr,
    time_str: r.timeStr,
    open_price: Number(r.openPrice),
    close_price: Number(r.closePrice),
    outcome: r.outcome,
    point_move: Number(r.pointMove),
    score: r.score,
    adjusted_score: r.adjustedScore,
    rsi: r.rsi != null ? Number(r.rsi) : null,
    stoch_k: r.stochK != null ? Number(r.stochK) : null,
    stoch_d: r.stochD != null ? Number(r.stochD) : null,
    macd_histogram: r.macdHistogram != null ? Number(r.macdHistogram) : null,
    williams_r: r.williamsR != null ? Number(r.williamsR) : null,
    cci: r.cci != null ? Number(r.cci) : null,
    bb_position: r.bbPosition != null ? Number(r.bbPosition) : null,
    bb_width: r.bbWidth != null ? Number(r.bbWidth) : null,
    atr: r.atr != null ? Number(r.atr) : null,
    relative_atr: r.relativeAtr != null ? Number(r.relativeAtr) : null,
    ema9: r.ema9 != null ? Number(r.ema9) : null,
    ema21: r.ema21 != null ? Number(r.ema21) : null,
    ema50: r.ema50 != null ? Number(r.ema50) : null,
    ema200: r.ema200 != null ? Number(r.ema200) : null,
    ema_alignment: r.emaAlignment,
    has_active_bob: r.hasActiveBOB,
    has_active_beob: r.hasActiveBEOB,
    ob_timeframe: r.obTimeframe,
    has_fvg_bull: r.hasFVGBull,
    has_fvg_bear: r.hasFVGBear,
    choch_detected: r.chochDetected,
    liquidity_sweep: r.liquiditySweep,
    h4_bias: r.h4Bias,
    h1_bias: r.h1Bias,
    top_down_alignment: r.topDownAlignment,
    candle_pattern: r.candlePattern,
    structure: r.structure,
    rsi_divergence: r.rsiDivergence,
    macd_divergence: r.macdDivergence,
    hour_of_day: r.hourOfDay,
    day_of_week: r.dayOfWeek,
    dominant_pattern: r.dominantPattern,
    pattern_score: r.patternScore,
    pattern_direction: r.patternDirection,
    m15_bias: r.m15Bias,
  };
}

function serializeSignal(r: typeof v75SignalHistoryTable.$inferSelect) {
  return {
    id: r.id,
    timestamp: Number(r.timestamp),
    direction: r.direction,
    strength: r.strength,
    confidence: r.confidence,
    score: r.score,
    adjusted_score: r.adjustedScore,
    duration_minutes: r.durationMinutes,
    entry_price: r.entryPrice != null ? Number(r.entryPrice) : null,
    exit_price: r.exitPrice != null ? Number(r.exitPrice) : null,
    outcome: r.outcome,
    choch_present: r.chochPresent,
    sweep_present: r.sweepPresent,
    ob_timeframe: r.obTimeframe,
    h4_bias: r.h4Bias,
    h1_bias: r.h1Bias,
    pattern_match_rate: r.patternMatchRate != null ? Number(r.patternMatchRate) : null,
  };
}

function serializeCondition(r: typeof v75ConditionStatsTable.$inferSelect) {
  return {
    id: r.id,
    condition_name: r.conditionName,
    rise_wins: r.riseWins,
    fall_wins: r.fallWins,
    total: r.total,
    accuracy: r.accuracy != null ? Number(r.accuracy) : null,
    weight_multiplier: Number(r.weightMultiplier),
    updated_at: r.updatedAt?.toISOString() ?? null,
  };
}

export default router;
