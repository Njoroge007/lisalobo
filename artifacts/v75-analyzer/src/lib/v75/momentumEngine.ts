import type {
  Tick, EngineState, Signal, MomentumMetrics, LayerScores, SignalTier,
  HurstRegime, AdaptiveThresholds,
} from "./types";
import {
  computeZScoreComponents,
  computeHurst,
  computeTickVelocity,
  computeTickImbalance,
  computeCompressionLayer,
  computeExpansionLayer,
  computeStructureLayer,
  computeFlowAlignmentLayer,
  computePersistenceLayer,
  type VelSample,
} from "./indicators";

export type { MomentumMetrics } from "./types";

const TICK_HISTORY_MAX  = 500;
const ATR_BASELINE_WIN  = 100;
const READY_MIN_TICKS   = 100;
const RESETTING_MS      = 5_000;
const TRADE_DURATION_MS = 120_000;
const VEL_SAMPLE_INTERVAL_MS = 300;
const VEL_HISTORY_MAX   = 20;

const TIER_MIN: Record<SignalTier, number> = {
  PREMIUM: 90, TRADE: 85, CANDIDATE: 80, WATCH: 70, REJECT: 0,
};

const WEIGHTS = { compression: 0.20, expansion: 0.25, structure: 0.20, flowAlignment: 0.20, persistence: 0.15 };

const LEGACY_THRESHOLDS: AdaptiveThresholds = {
  hurst: 0.55, zMin: 1.5, zMax: 2.5, velocity: 1.2, dti: 0.70,
};

const DEFAULT_LAYER_SCORES: LayerScores = {
  compression: 0, expansion: 0, structure: 50, flowAlignment: 20, persistence: 50,
};

const DEFAULT_METRICS: MomentumMetrics = {
  layerScores:     { ...DEFAULT_LAYER_SCORES },
  probabilityScore: 0,
  tier:            "REJECT",
  trendDirection:  "FLAT",
  flowDirection:   "NEUTRAL",
  atr:             0,
  ready:           false,
  volatilityFactor: 1,
  zScore:          0,
  hurstExponent:   0.5,
  tickVelocity:    0,
  dti:             0,
  sma10:           0,
  sd10:            0,
  hurstRegime:     "RANDOM",
  signalStrength:  0,
  adaptiveThresholds: { ...LEGACY_THRESHOLDS },
};

function classifyTier(prob: number): SignalTier {
  if (prob >= TIER_MIN.PREMIUM)   return "PREMIUM";
  if (prob >= TIER_MIN.TRADE)     return "TRADE";
  if (prob >= TIER_MIN.CANDIDATE) return "CANDIDATE";
  if (prob >= TIER_MIN.WATCH)     return "WATCH";
  return "REJECT";
}

export default class MomentumEngine {
  private state: EngineState = "IDLE";
  private ticks: Tick[] = [];
  private atrHistory: number[] = [];
  private velocityHistory: VelSample[] = [];
  private lastVelSampleMs = 0;
  private tradeEndMs = 0;
  private resetEndMs = 0;
  private lastMetrics: MomentumMetrics = { ...DEFAULT_METRICS };

  getState(): EngineState { return this.state; }

  getCountdownMs(): number {
    const now = Date.now();
    if (this.state === "IN_TRADE")  return Math.max(0, this.tradeEndMs - now);
    if (this.state === "RESETTING") return Math.max(0, this.resetEndMs  - now);
    return 0;
  }

  getMetrics(): MomentumMetrics { return this.lastMetrics; }

  processTick(price: number, ms: number, atr: number): Signal | null {
    this.ticks.push({ price, ms });
    if (this.ticks.length > TICK_HISTORY_MAX)
      this.ticks = this.ticks.slice(-TICK_HISTORY_MAX);

    if (atr > 0) {
      this.atrHistory.push(atr);
      if (this.atrHistory.length > ATR_BASELINE_WIN)
        this.atrHistory = this.atrHistory.slice(-ATR_BASELINE_WIN);
    }

    const now = ms || Date.now();

    if (this.state === "IN_TRADE") {
      if (now >= this.tradeEndMs) {
        this.state   = "RESETTING";
        this.resetEndMs = now + RESETTING_MS;
      }
      this.updateMetrics(atr, now);
      return null;
    }

    if (this.state === "RESETTING") {
      if (now >= this.resetEndMs) {
        this.ticks           = [];
        this.velocityHistory = [];
        this.state           = "IDLE";
      }
      this.updateMetrics(atr, now);
      return null;
    }

    this.updateMetrics(atr, now);
    if (!this.lastMetrics.ready) return null;

    const { probabilityScore, tier, flowDirection } = this.lastMetrics;

    if (tier === "REJECT" || tier === "WATCH" || tier === "CANDIDATE") return null;
    if (flowDirection === "NEUTRAL") return null;

    const direction = flowDirection as "RISE" | "FALL";
    this.state      = "IN_TRADE";
    this.tradeEndMs = now + TRADE_DURATION_MS;

    const { layerScores, zScore, hurstExponent, tickVelocity, dti, hurstRegime } = this.lastMetrics;

    return {
      id:              crypto.randomUUID(),
      timestamp:       now,
      direction,
      entryPrice:      price,
      strength:        probabilityScore / 100,
      probabilityScore,
      tier,
      layerScores:     { ...layerScores },
      zScore,
      hurstExponent,
      tickVelocity,
      dti,
      hurstRegime,
      thresholds:      { ...LEGACY_THRESHOLDS },
      outcome:         "PENDING",
    };
  }

  private updateMetrics(atr: number, now: number) {
    const prices = this.ticks.map(t => t.price);
    const ready  = prices.length >= READY_MIN_TICKS;

    const { zScore, sma, sd } = computeZScoreComponents(prices, 10);
    const hurstExponent       = computeHurst(prices, 30);
    const tickVelocity        = computeTickVelocity(this.ticks, 5_000, atr);
    const dti                 = computeTickImbalance(prices, 15);
    const hurstRegime: HurstRegime = hurstExponent >= 0.60 ? "TRENDING"
      : hurstExponent >= 0.50 ? "RANDOM" : "MEAN_REVERTING";

    if (now - this.lastVelSampleMs >= VEL_SAMPLE_INTERVAL_MS) {
      this.velocityHistory.push({ v: tickVelocity, ms: now });
      if (this.velocityHistory.length > VEL_HISTORY_MAX) this.velocityHistory.shift();
      this.lastVelSampleMs = now;
    }

    const vf = this.getVolatilityFactor(atr);

    if (!ready) {
      this.lastMetrics = {
        ...DEFAULT_METRICS,
        zScore, hurstExponent, tickVelocity, dti, atr,
        sma10: sma, sd10: sd, hurstRegime, volatilityFactor: vf,
      };
      return;
    }

    const L1 = computeCompressionLayer(prices);
    const L2 = computeExpansionLayer(prices, this.ticks, atr);
    const L3 = computeStructureLayer(prices, [20, 50, 100]);
    const L4 = computeFlowAlignmentLayer(prices, [20, 50, 100, 200]);
    const L5 = computePersistenceLayer(this.velocityHistory, tickVelocity);

    const layerScores: LayerScores = {
      compression:  L1.score,
      expansion:    L2.score,
      structure:    L3.score,
      flowAlignment: L4.score,
      persistence:  L5.score,
    };

    const probabilityScore = Math.round(
      L1.score * WEIGHTS.compression  +
      L2.score * WEIGHTS.expansion    +
      L3.score * WEIGHTS.structure    +
      L4.score * WEIGHTS.flowAlignment +
      L5.score * WEIGHTS.persistence,
    );

    const tier          = classifyTier(probabilityScore);
    const flowDirection = L4.direction;

    const trendDirection: "RISE" | "FALL" | "FLAT" =
      flowDirection !== "NEUTRAL" ? flowDirection
      : L3.bias === "BULL"  ? "RISE"
      : L3.bias === "BEAR"  ? "FALL"
      : "FLAT";

    this.lastMetrics = {
      layerScores, probabilityScore, tier,
      trendDirection, flowDirection,
      atr, ready, volatilityFactor: vf,
      zScore, hurstExponent, tickVelocity, dti,
      sma10: sma, sd10: sd, hurstRegime,
      signalStrength: probabilityScore / 100,
      adaptiveThresholds: { ...LEGACY_THRESHOLDS },
    };
  }

  private getVolatilityFactor(currentAtr: number): number {
    if (this.atrHistory.length < 5 || currentAtr <= 0) return 1.0;
    const baseline = this.atrHistory.reduce((a, b) => a + b, 0) / this.atrHistory.length;
    if (baseline <= 0) return 1.0;
    return Math.max(0.5, Math.min(2.0, currentAtr / baseline));
  }
}
