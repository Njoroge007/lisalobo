import { pgTable, text, uuid, numeric, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const v75SegmentRecordsTable = pgTable("v75_segment_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  timestamp: numeric("timestamp").notNull(),
  dateStr: text("date_str").notNull(),
  timeStr: text("time_str").notNull(),
  openPrice: numeric("open_price").notNull(),
  closePrice: numeric("close_price").notNull(),
  outcome: text("outcome"),
  pointMove: numeric("point_move").notNull(),
  score: integer("score").notNull(),
  adjustedScore: integer("adjusted_score"),
  rsi: numeric("rsi"),
  stochK: numeric("stoch_k"),
  stochD: numeric("stoch_d"),
  macdHistogram: numeric("macd_histogram"),
  williamsR: numeric("williams_r"),
  cci: numeric("cci"),
  bbPosition: numeric("bb_position"),
  bbWidth: numeric("bb_width"),
  atr: numeric("atr"),
  relativeAtr: numeric("relative_atr"),
  ema9: numeric("ema9"),
  ema21: numeric("ema21"),
  ema50: numeric("ema50"),
  ema200: numeric("ema200"),
  emaAlignment: text("ema_alignment"),
  hasActiveBOB: boolean("has_active_bob"),
  hasActiveBEOB: boolean("has_active_beob"),
  obTimeframe: text("ob_timeframe"),
  hasFVGBull: boolean("has_fvg_bull"),
  hasFVGBear: boolean("has_fvg_bear"),
  chochDetected: text("choch_detected"),
  liquiditySweep: text("liquidity_sweep"),
  h4Bias: text("h4_bias"),
  h1Bias: text("h1_bias"),
  topDownAlignment: text("top_down_alignment"),
  candlePattern: text("candle_pattern"),
  structure: text("structure"),
  rsiDivergence: text("rsi_divergence"),
  macdDivergence: text("macd_divergence"),
  hourOfDay: integer("hour_of_day"),
  dayOfWeek: integer("day_of_week"),
  dominantPattern: text("dominant_pattern"),
  patternScore: integer("pattern_score"),
  patternDirection: text("pattern_direction"),
  m15Bias: text("m15_bias"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const insertV75SegmentSchema = createInsertSchema(v75SegmentRecordsTable).omit({ id: true, createdAt: true });
export type InsertV75Segment = z.infer<typeof insertV75SegmentSchema>;
export type V75Segment = typeof v75SegmentRecordsTable.$inferSelect;

export const v75SignalHistoryTable = pgTable("v75_signal_history", {
  id: uuid("id").primaryKey(),
  timestamp: numeric("timestamp").notNull(),
  direction: text("direction").notNull(),
  strength: text("strength").notNull(),
  confidence: integer("confidence").notNull(),
  score: integer("score").notNull(),
  adjustedScore: integer("adjusted_score"),
  durationMinutes: integer("duration_minutes").notNull(),
  entryPrice: numeric("entry_price"),
  exitPrice: numeric("exit_price"),
  outcome: text("outcome").default("PENDING"),
  chochPresent: boolean("choch_present"),
  sweepPresent: boolean("sweep_present"),
  obTimeframe: text("ob_timeframe"),
  h4Bias: text("h4_bias"),
  h1Bias: text("h1_bias"),
  patternMatchRate: numeric("pattern_match_rate"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const insertV75SignalSchema = createInsertSchema(v75SignalHistoryTable).omit({ createdAt: true });
export type InsertV75Signal = z.infer<typeof insertV75SignalSchema>;
export type V75Signal = typeof v75SignalHistoryTable.$inferSelect;

export const v75ConditionStatsTable = pgTable("v75_condition_stats", {
  id: uuid("id").primaryKey().defaultRandom(),
  conditionName: text("condition_name").notNull().unique(),
  riseWins: integer("rise_wins").default(0),
  fallWins: integer("fall_wins").default(0),
  total: integer("total").default(0),
  accuracy: numeric("accuracy"),
  weightMultiplier: numeric("weight_multiplier").notNull().default("1"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const insertV75ConditionSchema = createInsertSchema(v75ConditionStatsTable).omit({ id: true });
export type InsertV75Condition = z.infer<typeof insertV75ConditionSchema>;
export type V75Condition = typeof v75ConditionStatsTable.$inferSelect;
