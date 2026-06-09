import type {
  Tick, EngineState, HurstRegime, AdaptiveThresholds,
  Signal, MomentumMetrics,
} from "./types";
import {
  computeZScoreComponents,
  computeTickVelocity,
  computeHurst,
  computeTickImbalance,
} from "./indicators";

export type { MomentumMetrics } from "./types";

const TICK_WINDOW_MS   = 5_000;
const TICK_HISTORY_MAX = 500;
const ATR_BASELINE_WIN = 50;
const Z_PERIOD         = 10;
const HURST_PERIOD     = 30;
const DTI_PERIOD       = 15;
const RESETTING_MS     = 5_000;

const BASE_THRESHOLDS: AdaptiveThresholds = {
  hurst:    0.55,
  zMin:     1.5,
  zMax:     2.5,
  velocity: 1.2,
  dti:      0.70,
};

const DEFAULT_METRICS: MomentumMetrics = {
  zScore: 0, hurstExponent: 0.5, tickVelocity: 0, dti: 0,
  atr: 0, sma10: 0, sd10: 0, ready: false,
  hurstRegime: "RANDOM", trendDirection: "FLAT",
  signalStrength: 0, volatilityFactor: 1,
  adaptiveThresholds: { ...BASE_THRESHOLDS },
};

export default class MomentumEngine {
  private state: EngineState = "IDLE";
  private ticks: Tick[] = [];
  private atrHistory: number[] = [];
  private tradeEndMs  = 0;
  private resetEndMs  = 0;
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
        this.state = "RESETTING";
        this.resetEndMs = now + RESETTING_MS;
      }
      this.updateMetrics(atr);
      return null;
    }

    if (this.state === "RESETTING") {
      if (now >= this.resetEndMs) {
        this.ticks = [];
        this.state = "IDLE";
      }
      this.updateMetrics(atr);
      return null;
    }

    this.updateMetrics(atr);
    if (!this.lastMetrics.ready) return null;

    const {
      zScore, hurstExponent, tickVelocity, dti,
      adaptiveThresholds: t, hurstRegime, signalStrength, volatilityFactor,
    } = this.lastMetrics;

    const absZ = Math.abs(zScore);

    if (hurstExponent < t.hurst)        return null;
    if (absZ < t.zMin || absZ > t.zMax) return null;
    if (tickVelocity  < t.velocity)     return null;
    if (zScore > 0 && dti  <  t.dti)   return null;
    if (zScore < 0 && dti  > -t.dti)   return null;

    const direction: "RISE" | "FALL" = zScore > 0 ? "RISE" : "FALL";
    const cooldownMs = this.adaptiveCooldown(volatilityFactor);

    this.state = "IN_TRADE";
    this.tradeEndMs = now + cooldownMs;

    return {
      id:            crypto.randomUUID(),
      timestamp:     now,
      direction,
      entryPrice:    price,
      strength:      signalStrength,
      zScore,
      hurstExponent,
      tickVelocity,
      dti,
      hurstRegime,
      thresholds:    { ...t },
      outcome:       "PENDING",
    };
  }

  private updateMetrics(atr: number) {
    const prices = this.ticks.map(t => t.price);
    const { zScore, sma, sd } = computeZScoreComponents(prices, Z_PERIOD);
    const hurstExponent = computeHurst(prices, HURST_PERIOD);
    const tickVelocity  = computeTickVelocity(this.ticks, TICK_WINDOW_MS, atr);
    const dti           = computeTickImbalance(prices, DTI_PERIOD);
    const ready         = prices.length >= Math.max(Z_PERIOD, DTI_PERIOD);

    const vf                 = this.getVolatilityFactor(atr);
    const adaptiveThresholds = this.getAdaptiveThresholds(vf);
    const hurstRegime        = this.getHurstRegime(hurstExponent);
    const trendDirection     = zScore > 0.3 ? "RISE" as const
                             : zScore < -0.3 ? "FALL" as const
                             : "FLAT" as const;
    const signalStrength = this.computeStrength(
      hurstExponent, Math.abs(zScore), tickVelocity, Math.abs(dti), adaptiveThresholds,
    );

    this.lastMetrics = {
      zScore, hurstExponent, tickVelocity, dti, atr,
      sma10: sma, sd10: sd, ready,
      hurstRegime, trendDirection, signalStrength,
      volatilityFactor: vf, adaptiveThresholds,
    };
  }

  private getVolatilityFactor(currentAtr: number): number {
    if (this.atrHistory.length < 5 || currentAtr <= 0) return 1.0;
    const baseline = this.atrHistory.reduce((a, b) => a + b, 0) / this.atrHistory.length;
    if (baseline <= 0) return 1.0;
    return Math.max(0.5, Math.min(2.0, currentAtr / baseline));
  }

  private getAdaptiveThresholds(vf: number): AdaptiveThresholds {
    if (vf > 1.3) return { hurst: 0.52, zMin: 1.2, zMax: 3.0, velocity: 1.0, dti: 0.58 };
    if (vf < 0.8) return { hurst: 0.58, zMin: 1.8, zMax: 2.3, velocity: 1.4, dti: 0.78 };
    return { ...BASE_THRESHOLDS };
  }

  private adaptiveCooldown(vf: number): number {
    if (vf > 1.5) return 60_000;
    if (vf > 1.2) return 90_000;
    return 120_000;
  }

  private getHurstRegime(h: number): HurstRegime {
    if (h >= 0.60) return "TRENDING";
    if (h >= 0.50) return "RANDOM";
    return "MEAN_REVERTING";
  }

  private computeStrength(
    h: number, absZ: number, v: number, absDTI: number, t: AdaptiveThresholds,
  ): number {
    const hScore = Math.max(0, (h - t.hurst) / (1 - t.hurst));
    const zRange = t.zMax - t.zMin;
    const zS     = zRange > 0 ? Math.max(0, Math.min(1, (absZ - t.zMin) / zRange)) : 0;
    const vScore = Math.max(0, Math.min(1, (v - t.velocity) / (t.velocity * 2)));
    const dScore = Math.max(0, Math.min(1, (absDTI - t.dti) / (1 - t.dti)));
    return Math.round((hScore + zS + vScore + dScore) * 25);
  }
}
