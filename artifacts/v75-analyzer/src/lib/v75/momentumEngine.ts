export interface EngineState {
  ticks: number[];
  cooldown: number;
}

export interface Signal {
  action: "CALL" | "PUT" | "WAIT";
  reason: string;
  metrics: { ema: string; zScore: string; velocity: string; };
}

// Calculates the momentum logic on every single tick
export function processTick(price: number, state: EngineState): { newState: EngineState, signal: Signal } {
  const MAX_HISTORY = 100;
  const ticks = [...state.ticks, price].slice(-MAX_HISTORY);
  
  // Tick down the cooldown timer
  let cooldown = state.cooldown > 0 ? state.cooldown - 1 : 0;

  const defaultMetrics = { ema: "0.00", zScore: "0.00", velocity: "0.00" };

  // Wait for enough data to form a 50-tick EMA
  if (ticks.length < 50) {
    return {
      newState: { ticks, cooldown },
      signal: { action: "WAIT", reason: `Warming up (${ticks.length}/50)`, metrics: defaultMetrics }
    };
  }

  // If we just took a trade, ignore noise until cooldown clears
  if (cooldown > 0) {
    return {
      newState: { ticks, cooldown },
      signal: { action: "WAIT", reason: `Cooldown (${cooldown} ticks left)`, metrics: defaultMetrics }
    };
  }

  const currentPrice = ticks[ticks.length - 1];

  // 1. THE RIVER (Macro Trend): 50-tick EMA
  const k = 2 / (50 + 1);
  let ema = ticks[ticks.length - 50];
  for (let i = ticks.length - 49; i < ticks.length; i++) {
    ema = (ticks[i] * k) + (ema * (1 - k));
  }

  // 2. THE RUBBER BAND: 30-tick Rolling Z-Score
  const zSlice = ticks.slice(-30);
  const zMean = zSlice.reduce((a, b) => a + b, 0) / 30;
  const zVariance = zSlice.reduce((a, b) => a + Math.pow(b - zMean, 2), 0) / 30;
  const zStdDev = Math.sqrt(zVariance) || 0.0001; // Prevent divide-by-zero
  const zScore = (currentPrice - zMean) / zStdDev;

  // 3. THE IGNITION: 5-tick Velocity (Dynamic)
  const velSlice = ticks.slice(-6);
  const rawVelocity = currentPrice - velSlice[0];
  
  // We require the 5-tick move to be at least half of the 30-tick standard deviation.
  // This automatically adjusts to high/low volatility regimes.
  const dynamicVelocityThreshold = zStdDev * 0.5;

  const metrics = {
    ema: ema.toFixed(2),
    zScore: zScore.toFixed(2),
    velocity: rawVelocity.toFixed(2)
  };

  // --- THE FIRING GATES ---

  // CALL LOGIC: Price above EMA, Momentum pushing up (1.0+), but not exhausted (< 2.2)
  if (currentPrice > ema && zScore >= 1.0 && zScore <= 2.2 && rawVelocity > dynamicVelocityThreshold) {
    return {
      newState: { ticks, cooldown: 15 }, // Lock out fake follow-up signals for 15 ticks
      signal: { action: "CALL", reason: "Momentum Continuation UP", metrics }
    };
  }

  // PUT LOGIC: Price below EMA, Momentum pushing down (-1.0+), but not exhausted (> -2.2)
  if (currentPrice < ema && zScore <= -1.0 && zScore >= -2.2 && rawVelocity < -dynamicVelocityThreshold) {
    return {
      newState: { ticks, cooldown: 15 }, // Lock out fake follow-up signals for 15 ticks
      signal: { action: "PUT", reason: "Momentum Continuation DOWN", metrics }
    };
  }

  return {
    newState: { ticks, cooldown },
    signal: { action: "WAIT", reason: "Idle - Watching for Setup", metrics }
  };
}
