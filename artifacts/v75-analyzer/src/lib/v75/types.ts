export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Tick {
  price: number;
  ms: number;
}

export type Direction = "RISE" | "FALL";

export type EngineState = "IDLE" | "IN_TRADE" | "RESETTING";

export type HurstRegime = "TRENDING" | "RANDOM" | "MEAN_REVERTING";

export interface AdaptiveThresholds {
  hurst: number;
  zMin: number;
  zMax: number;
  velocity: number;
  dti: number;
}

export interface Signal {
  id: string;
  timestamp: number;
  direction: Direction;
  entryPrice: number;
  strength: number;
  zScore: number;
  hurstExponent: number;
  tickVelocity: number;
  dti: number;
  hurstRegime: HurstRegime;
  thresholds: AdaptiveThresholds;
  outcome: "WIN" | "LOSS" | "PENDING";
  exitPrice?: number;
}

export type SnapbackSignal = Signal;

export interface MomentumMetrics {
  zScore: number;
  hurstExponent: number;
  tickVelocity: number;
  dti: number;
  atr: number;
  sma10: number;
  sd10: number;
  ready: boolean;
  hurstRegime: HurstRegime;
  trendDirection: "RISE" | "FALL" | "FLAT";
  signalStrength: number;
  volatilityFactor: number;
  adaptiveThresholds: AdaptiveThresholds;
}

export interface QuantMetrics extends MomentumMetrics {}
