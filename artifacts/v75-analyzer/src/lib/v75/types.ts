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

export interface SnapbackSignal {
  id: string;
  timestamp: number;
  direction: Direction;
  entryPrice: number;
  zScore: number;
  hurstExponent: number;
  tickVelocity: number;
  dti?: number;
  outcome: "WIN" | "LOSS" | "PENDING";
  exitPrice?: number;
}

export interface QuantMetrics {
  zScore: number;
  hurstExponent: number;
  tickVelocity: number;
  atr: number;
  sma10: number;
  sd10: number;
  ready: boolean;
}
