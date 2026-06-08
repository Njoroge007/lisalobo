// Hidden Markov Model engine for V75 regime detection.
// Pure TypeScript — no external ML libraries.

export const N_STATES = 4;
export const N_OBS = 9;
export const STATE_NAMES = ["STRONG_BULL", "WEAK_BULL", "WEAK_BEAR", "STRONG_BEAR"] as const;
export type HMMStateName = typeof STATE_NAMES[number];
export const STATE_DIRECTIONS: Array<"RISE" | "FALL" | "NEUTRAL"> = ["RISE", "RISE", "FALL", "FALL"];

export interface HMMModel {
  A: number[][];   // N×N transition
  B: number[][];   // N×M emission
  pi: number[];    // initial
  converged: boolean;
  iterations: number;
  logLikelihood: number;
}

const deepCopy = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

export function initializeHMM(): HMMModel {
  const A = [
    [0.60, 0.25, 0.10, 0.05],
    [0.20, 0.45, 0.25, 0.10],
    [0.10, 0.25, 0.45, 0.20],
    [0.05, 0.10, 0.25, 0.60],
  ];
  const B = [
    [0.02, 0.03, 0.05, 0.05, 0.05, 0.10, 0.20, 0.30, 0.20],
    [0.03, 0.05, 0.07, 0.10, 0.20, 0.25, 0.15, 0.10, 0.05],
    [0.05, 0.10, 0.15, 0.25, 0.20, 0.10, 0.07, 0.05, 0.03],
    [0.20, 0.30, 0.20, 0.10, 0.05, 0.05, 0.05, 0.03, 0.02],
  ];
  const pi = [0.25, 0.25, 0.25, 0.25];
  return { A, B, pi, converged: false, iterations: 0, logLikelihood: -Infinity };
}

// ── Observation builder ───────────────────────────────────────
export function computeObservation(
  candles: { open: number; high: number; low: number; close: number }[],
  atr: number,
  ema9: number[],
  ema21: number[],
  rsi: number[],
  macdHist: number[],
): number[] {
  const i = candles.length - 1;
  if (i < 1 || atr <= 0) return [0, 0, 0, 0, 0, 0];
  const c = candles[i];
  const prev = candles[i - 1];

  const logReturn = (Math.log(c.close / prev.close)) / (atr / prev.close);
  const f1 = logReturn > 1.0 ? 2 : logReturn > 0.3 ? 1 : logReturn < -1.0 ? -2 : logReturn < -0.3 ? -1 : 0;

  const volRatio = (c.high - c.low) / atr;
  const f2 = volRatio > 2.0 ? 2 : volRatio > 0.8 ? 1 : 0;

  const price = c.close;
  const e9 = ema9[i] ?? price;
  const e21 = ema21[i] ?? price;
  const eAbove = [e9, e21].filter((e) => price > e).length;
  const f3 = eAbove === 2 ? 2 : eAbove === 1 ? 0 : -2;

  const r = rsi[i] ?? 50;
  const f4 = r > 70 ? 2 : r > 55 ? 1 : r < 30 ? -2 : r < 45 ? -1 : 0;

  const mh = macdHist[i] ?? 0;
  const f5 = mh > atr * 0.3 ? 2 : mh > 0 ? 1 : mh < -(atr * 0.3) ? -2 : mh < 0 ? -1 : 0;

  const body = c.close - c.open;
  const f6 = body > atr * 0.5 ? 2 : body > atr * 0.15 ? 1 : body < -(atr * 0.5) ? -2 : body < -(atr * 0.15) ? -1 : 0;

  return [f1, f2, f3, f4, f5, f6];
}

export function getCompositeObsScore(obs: number[]): number {
  const weights = [2.0, 0.5, 1.5, 1.0, 1.5, 1.5];
  let s = 0;
  for (let i = 0; i < obs.length; i++) s += obs[i] * weights[i];
  return s;
}

export function scoreToSymbol(score: number): number {
  if (score > 12) return 8;
  if (score > 8) return 7;
  if (score > 4) return 6;
  if (score > 1) return 5;
  if (score > -1) return 4;
  if (score > -4) return 3;
  if (score > -8) return 2;
  if (score > -12) return 1;
  return 0;
}

// ── Forward (scaled) ──────────────────────────────────────────
export function forward(model: HMMModel, obs: number[]): { alpha: number[][]; scale: number[] } {
  const T = obs.length, N = N_STATES;
  const alpha: number[][] = Array.from({ length: T }, () => Array(N).fill(0));
  const scale: number[] = Array(T).fill(0);
  for (let i = 0; i < N; i++) alpha[0][i] = model.pi[i] * model.B[i][obs[0]];
  scale[0] = alpha[0].reduce((a, b) => a + b, 0);
  if (scale[0] > 0) for (let i = 0; i < N; i++) alpha[0][i] /= scale[0];
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += alpha[t - 1][i] * model.A[i][j];
      alpha[t][j] = sum * model.B[j][obs[t]];
    }
    scale[t] = alpha[t].reduce((a, b) => a + b, 0);
    if (scale[t] > 0) for (let j = 0; j < N; j++) alpha[t][j] /= scale[t];
  }
  return { alpha, scale };
}

export function getCurrentStateProbs(model: HMMModel, obs: number[]): number[] {
  if (!obs.length) return [0.25, 0.25, 0.25, 0.25];
  const { alpha } = forward(model, obs);
  const last = alpha[alpha.length - 1];
  const sum = last.reduce((a, b) => a + b, 0);
  return sum > 0 ? last.map((v) => v / sum) : [0.25, 0.25, 0.25, 0.25];
}

// ── Backward ─────────────────────────────────────────────────
export function backward(model: HMMModel, obs: number[], scale: number[]): number[][] {
  const T = obs.length, N = N_STATES;
  const beta: number[][] = Array.from({ length: T }, () => Array(N).fill(0));
  for (let i = 0; i < N; i++) beta[T - 1][i] = 1.0 / (scale[T - 1] || 1);
  for (let t = T - 2; t >= 0; t--) {
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let j = 0; j < N; j++) sum += model.A[i][j] * model.B[j][obs[t + 1]] * beta[t + 1][j];
      beta[t][i] = sum / (scale[t] || 1);
    }
  }
  return beta;
}

// ── Baum-Welch training ───────────────────────────────────────
export function baumWelch(model: HMMModel, obs: number[], maxIter = 50, tol = 1e-4): HMMModel {
  const T = obs.length, N = N_STATES, M = N_OBS;
  let cur = deepCopy(model);
  let prevLL = -Infinity;
  for (let iter = 0; iter < maxIter; iter++) {
    const { alpha, scale } = forward(cur, obs);
    const beta = backward(cur, obs, scale);
    const gamma: number[][] = Array.from({ length: T }, () => Array(N).fill(0));
    for (let t = 0; t < T; t++) {
      let s = 0;
      for (let i = 0; i < N; i++) { gamma[t][i] = alpha[t][i] * beta[t][i]; s += gamma[t][i]; }
      if (s > 0) for (let i = 0; i < N; i++) gamma[t][i] /= s;
    }
    const xi: number[][][] = Array.from({ length: T - 1 }, () =>
      Array.from({ length: N }, () => Array(N).fill(0)));
    for (let t = 0; t < T - 1; t++) {
      let s = 0;
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          xi[t][i][j] = alpha[t][i] * cur.A[i][j] * cur.B[j][obs[t + 1]] * beta[t + 1][j];
          s += xi[t][i][j];
        }
      if (s > 0) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) xi[t][i][j] /= s;
    }
    const newPi = gamma[0].slice();
    const newA: number[][] = Array.from({ length: N }, () => Array(N).fill(0));
    for (let i = 0; i < N; i++) {
      let denom = 0;
      for (let t = 0; t < T - 1; t++) denom += gamma[t][i];
      for (let j = 0; j < N; j++) {
        let num = 0;
        for (let t = 0; t < T - 1; t++) num += xi[t][i][j];
        newA[i][j] = denom > 0 ? num / denom : 1 / N;
      }
    }
    const newB: number[][] = Array.from({ length: N }, () => Array(M).fill(0));
    for (let j = 0; j < N; j++) {
      let denom = 0;
      for (let t = 0; t < T; t++) denom += gamma[t][j];
      for (let k = 0; k < M; k++) {
        let num = 0;
        for (let t = 0; t < T; t++) if (obs[t] === k) num += gamma[t][j];
        newB[j][k] = denom > 0 ? num / denom : 1 / M;
      }
    }
    for (let i = 0; i < N; i++) {
      const sA = newA[i].reduce((a, b) => a + b, 0);
      if (sA > 0) newA[i] = newA[i].map((v) => v / sA);
      const sB = newB[i].reduce((a, b) => a + b, 0);
      if (sB > 0) newB[i] = newB[i].map((v) => v / sB);
    }
    const ll = scale.reduce((s, x) => s + Math.log(x || 1e-300), 0);
    cur = { A: newA, B: newB, pi: newPi, converged: false, iterations: iter + 1, logLikelihood: ll };
    if (Math.abs(ll - prevLL) < tol) { cur.converged = true; break; }
    prevLL = ll;
  }
  return cur;
}

// ── Viterbi ──────────────────────────────────────────────────
export function viterbi(model: HMMModel, obs: number[]): { stateSequence: number[]; probability: number; stateProbs: number[][] } {
  const T = obs.length, N = N_STATES;
  const delta: number[][] = Array.from({ length: T }, () => Array(N).fill(0));
  const psi: number[][] = Array.from({ length: T }, () => Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    delta[0][i] = Math.log(model.pi[i] + 1e-300) + Math.log(model.B[i][obs[0]] + 1e-300);
  }
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < N; j++) {
      let maxV = -Infinity, maxS = 0;
      for (let i = 0; i < N; i++) {
        const v = delta[t - 1][i] + Math.log(model.A[i][j] + 1e-300);
        if (v > maxV) { maxV = v; maxS = i; }
      }
      delta[t][j] = maxV + Math.log(model.B[j][obs[t]] + 1e-300);
      psi[t][j] = maxS;
    }
  }
  let maxFinal = -Infinity, lastState = 0;
  for (let i = 0; i < N; i++) if (delta[T - 1][i] > maxFinal) { maxFinal = delta[T - 1][i]; lastState = i; }
  const seq = Array(T).fill(0);
  seq[T - 1] = lastState;
  for (let t = T - 2; t >= 0; t--) seq[t] = psi[t + 1][seq[t + 1]];
  const stateProbs = delta.map((row) => {
    const m = Math.max(...row);
    const e = row.map((v) => Math.exp(v - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / s);
  });
  return { stateSequence: seq, probability: Math.exp(maxFinal), stateProbs };
}