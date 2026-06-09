import type { Tick, SnapbackSignal, EngineState, QuantMetrics } from "./types";
import {
  computeZScoreComponents,
  computeTickVelocity,
  computeHurst,
  computeTickImbalance,
} from "./indicators";

const TICK_WINDOW_MS = 5_000;
const TICK_HISTORY_MAX = 500;
const Z_PERIOD = 10;
const HURST_PERIOD = 30;
const DTI_PERIOD = 15;

const HURST_THRESHOLD = 0.55;
const Z_MIN = 1.5;
const Z_MAX = 2.5;
const VELOCITY_THRESHOLD = 1.2;
const DTI_THRESHOLD = 0.70;

const IN_TRADE_MS = 120_000;
const RESETTING_MS = 5_000;

export interface MomentumMetrics {
  zScore: number;
  hurstExponent: number;
  tickVelocity: number;
  dti: number;
  atr: number;
  sma10: number;
  sd10: number;
  ready: boolean;
}

export class MomentumEngine {
  private state: EngineState = "IDLE";
  private ticks: Tick[] = [];
  private tradeEndMs = 0;
  private resetEndMs = 0;
  private lastMetrics: MomentumMetrics = {
    zScore: 0,
    hurstExponent: 0.5,
    tickVelocity: 0,
    dti: 0,
    atr: 0,
    sma10: 0,
    sd10: 0,
    ready: false,
  };

  getState(): EngineState {
    return this.state;
  }

  getCountdownMs(): number {
    const now = Date.now();
    if (this.state === "IN_TRADE") return Math.max(0, this.tradeEndMs - now);
    if (this.state === "RESETTING") return Math.max(0, this.resetEndMs - now);
    return 0;
  }

  getMetrics(): MomentumMetrics {
    return this.lastMetrics;
  }

  processTick(price: number, ms: number, atr: number): SnapbackSignal | null {
    this.ticks.push({ price, ms });
    if (this.ticks.length > TICK_HISTORY_MAX) {
      this.ticks = this.ticks.slice(-TICK_HISTORY_MAX);
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

    const { zScore, hurstExponent, tickVelocity, dti } = this.lastMetrics;

    // Gate 1: Trending regime
    if (hurstExponent < HURST_THRESHOLD) return null;

    // Gate 2: Goldilocks zone — not too weak, not overextended
    const absZ = Math.abs(zScore);
    if (absZ < Z_MIN || absZ > Z_MAX) return null;

    // Gate 3: Sufficient tick velocity (fuel)
    if (tickVelocity < VELOCITY_THRESHOLD) return null;

    // Gate 4: DTI must confirm direction (smoothness / directional pressure)
    if (zScore > 0 && dti < DTI_THRESHOLD) return null;
    if (zScore < 0 && dti > -DTI_THRESHOLD) return null;

    const direction: "RISE" | "FALL" = zScore > 0 ? "RISE" : "FALL";

    this.state = "IN_TRADE";
    this.tradeEndMs = now + IN_TRADE_MS;

    return {
      id: crypto.randomUUID(),
      timestamp: now,
      direction,
      entryPrice: price,
      zScore,
      hurstExponent,
      tickVelocity,
      dti,
      outcome: "PENDING",
    };
  }

  private updateMetrics(atr: number) {
    const prices = this.ticks.map((t) => t.price);
    const { zScore, sma, sd } = computeZScoreComponents(prices, Z_PERIOD);
    const hurstExponent = computeHurst(prices, HURST_PERIOD);
    const tickVelocity = computeTickVelocity(this.ticks, TICK_WINDOW_MS, atr);
    const dti = computeTickImbalance(prices, DTI_PERIOD);
    const ready = prices.length >= Math.max(Z_PERIOD, DTI_PERIOD);
    this.lastMetrics = {
      zScore, hurstExponent, tickVelocity, dti, atr, sma10: sma, sd10: sd, ready,
    };
  }
}
