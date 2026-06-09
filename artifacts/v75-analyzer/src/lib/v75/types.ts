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

export type SignalTier = "REJECT" | "WATCH" | "CANDIDATE" | "TRADE" | "PREMIUM";

export interface AdaptiveThresholds {
  hurst: number;
  zMin: number;
  zMax: number;
  velocity: number;
  dti: number;
}

export interface LayerScores {
  compression: number;
  expansion: number;
  structure: number;
  flowAlignment: number;
  persistence: number;
}

export interface Signal {
  id: string;
  timestamp: number;
  direction: Direction;
  entryPrice: number;
  strength: number;
  probabilityScore: number;
  tier: SignalTier;
  layerScores: LayerScores;
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
  layerScores: LayerScores;
  probabilityScore: number;
  tier: SignalTier;
  trendDirection: "RISE" | "FALL" | "FLAT";
  flowDirection: "RISE" | "FALL" | "NEUTRAL";
  atr: number;
  ready: boolean;
  volatilityFactor: number;
  zScore: number;
  hurstExponent: number;
  tickVelocity: number;
  dti: number;
  sma10: number;
  sd10: number;
  hurstRegime: HurstRegime;
  signalStrength: number;
  adaptiveThresholds: AdaptiveThresholds;
}

export interface QuantMetrics extends MomentumMetrics {}
