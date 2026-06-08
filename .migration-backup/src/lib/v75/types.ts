export interface Candle {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Direction = "RISE" | "FALL";
export type Strength = "Strong" | "Moderate";

export interface IndicatorSnapshot {
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  rsi: number;
  stochK: number;
  stochD: number;
  macdLine: number;
  macdSignal: number;
  macdHist: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbWidth: number;
  bbPosition: number;
  atr: number;
  relativeAtr: number;
  williamsR: number;
  cci: number;
  rsiDivergence: "BULL" | "BEAR" | "NONE";
  macdDivergence: "BULL" | "BEAR" | "NONE";
}

export interface OrderBlock {
  type: "BULL" | "BEAR";
  low: number;
  high: number;
  time: number;
  timeframe: "M1" | "M5" | "M15" | "H1" | "H4";
  mitigated: boolean;
}

export interface FVG {
  type: "BULL" | "BEAR";
  low: number;
  high: number;
  time: number;
  mitigated: boolean;
}

export interface SMCState {
  orderBlocks: OrderBlock[];
  fvgs: FVG[];
  choch: "BULL" | "BEAR" | "NONE";
  bos: "BULL" | "BEAR" | "NONE";
  liquiditySweep: "BULL" | "BEAR" | "NONE";
  supports: number[];
  resistances: number[];
  nearestBOB: OrderBlock | null;
  nearestBEOB: OrderBlock | null;
}

export interface TopDownBias {
  h4: "BULL" | "BEAR" | "NEUTRAL";
  h1: "BULL" | "BEAR" | "NEUTRAL";
  m15: "BULL" | "BEAR" | "NEUTRAL";
  m5: "BULL" | "BEAR" | "NEUTRAL";
  alignment: "ALIGNED_BULL" | "ALIGNED_BEAR" | "MIXED" | "OPPOSED";
}

export interface ScoreBreakdown {
  total: number;
  adjusted: number;
  checks: { name: string; value: number }[];
  reasons: string[];
  conditions: string[];
}

export interface Signal {
  id: string;
  timestamp: number;
  direction: Direction;
  strength: Strength;
  confidence: number;
  score: number;
  adjustedScore: number;
  tier: 1 | 2 | 3 | 4;
  entryPrice: number;
  durations: { primary: number; secondary: number; tertiary: number };
  mtLevels: {
    sl: number;
    tp1: number;
    tp2: number;
  };
  reasons: string[];
  smc: { choch: boolean; sweep: boolean; obTimeframe: string };
  topDown: TopDownBias;
  patternMatchRate: number;
  outcome?: "WIN" | "LOSS" | "PENDING";
  exitPrice?: number;
}

export interface SegmentRecord {
  timestamp: number;
  dateStr: string;
  timeStr: string;
  openPrice: number;
  closePrice: number;
  outcome: "RISE" | "FALL" | "FLAT";
  pointMove: number;
  score: number;
  adjustedScore: number;
  rsi: number;
  stochK: number;
  stochD: number;
  macdHistogram: number;
  williamsR: number;
  cci: number;
  bbPosition: number;
  bbWidth: number;
  atr: number;
  relativeAtr: number;
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  emaAlignment: string;
  hasActiveBOB: boolean;
  hasActiveBEOB: boolean;
  obTimeframe: string;
  hasFVGBull: boolean;
  hasFVGBear: boolean;
  chochDetected: string;
  liquiditySweep: string;
  h4Bias: string;
  h1Bias: string;
  topDownAlignment: string;
  candlePattern: string;
  structure: string;
  rsiDivergence: string;
  macdDivergence: string;
  hourOfDay: number;
  dayOfWeek: number;
  dominantPattern?: string;
  patternScore?: number;
  patternDirection?: "RISE" | "FALL" | "NEUTRAL";
  m15Bias?: string;
}