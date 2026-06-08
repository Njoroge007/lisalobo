import {
  initializeHMM, baumWelch, getCurrentStateProbs, viterbi,
  computeObservation, getCompositeObsScore, scoreToSymbol,
  STATE_NAMES, STATE_DIRECTIONS, N_STATES, type HMMModel, type HMMStateName,
} from "./hmm";
import type { Candle } from "./types";

export interface RegimeState {
  currentState: number;
  stateName: HMMStateName;
  stateProbs: number[];
  confidence: number;
  dominantDirection: "RISE" | "FALL" | "NEUTRAL";
  prevState: number;
  regimeChanged: boolean;
  regimeChangedTo: string;
  regimeDuration: number;
  isSustainable: boolean;
  modelConverged: boolean;
  modelLogLikelihood: number;
  trainingObsCount: number;
  nextStateProbs: number[];
  isTraining: boolean;
}

const LS_KEY = "v75_hmm_model_v1";
const LS_TTL_MS = 60 * 60 * 1000;

export class HMMRegimeManager {
  private model: HMMModel;
  private observations: number[] = [];
  private stateHistory: number[] = [];
  private regimeDuration = 0;
  private lastTrainingSize = 0;
  private isTraining = false;
  readonly stateNames = STATE_NAMES;

  constructor() {
    this.model = initializeHMM();
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.ts && Date.now() - saved.ts < LS_TTL_MS && saved.model) {
            this.model = saved.model;
          }
        }
      } catch {}
    }
  }

  private persist() {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), model: this.model })); } catch {}
  }

  update(
    candles: Candle[],
    atr: number,
    ema9: number[],
    ema21: number[],
    rsi: number[],
    macdHist: number[],
  ): RegimeState {
    const obs = computeObservation(candles, atr, ema9, ema21, rsi, macdHist);
    const score = getCompositeObsScore(obs);
    const symbol = scoreToSymbol(score);
    this.observations.push(symbol);
    if (this.observations.length > 500) this.observations.shift();

    if (
      this.observations.length >= 100 &&
      !this.isTraining &&
      this.observations.length - this.lastTrainingSize >= 50
    ) {
      this.trainAsync();
    }

    const windowSize = Math.min(30, this.observations.length);
    const recent = this.observations.slice(-windowSize);
    const stateProbs = getCurrentStateProbs(this.model, recent);
    let currentState = 0, maxP = -1;
    for (let i = 0; i < stateProbs.length; i++) if (stateProbs[i] > maxP) { maxP = stateProbs[i]; currentState = i; }
    const confidence = Math.round(stateProbs[currentState] * 100);

    const prevState = this.stateHistory.length ? this.stateHistory[this.stateHistory.length - 1] : currentState;
    const regimeChanged = currentState !== prevState && this.stateHistory.length > 0;
    if (regimeChanged || this.stateHistory.length === 0) this.regimeDuration = 1;
    else this.regimeDuration++;

    this.stateHistory.push(currentState);
    if (this.stateHistory.length > 200) this.stateHistory.shift();

    // Next state prediction
    const next = Array(N_STATES).fill(0);
    for (let j = 0; j < N_STATES; j++)
      for (let i = 0; i < N_STATES; i++) next[j] += stateProbs[i] * this.model.A[i][j];

    return {
      currentState,
      stateName: STATE_NAMES[currentState],
      stateProbs,
      confidence,
      dominantDirection: STATE_DIRECTIONS[currentState],
      prevState,
      regimeChanged,
      regimeChangedTo: regimeChanged ? STATE_NAMES[currentState] : "",
      regimeDuration: this.regimeDuration,
      isSustainable: this.regimeDuration >= 3,
      modelConverged: this.model.converged,
      modelLogLikelihood: this.model.logLikelihood,
      trainingObsCount: this.observations.length,
      nextStateProbs: next,
      isTraining: this.isTraining,
    };
  }

  // Initial bulk-train on the historical candle buffer
  bootstrap(
    candles: Candle[],
    atr: number,
    ema9: number[],
    ema21: number[],
    rsi: number[],
    macdHist: number[],
  ) {
    if (this.observations.length > 0) return;
    const N = Math.min(500, candles.length);
    const start = candles.length - N;
    for (let i = start + 1; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const obs = computeObservation(slice, atr, ema9, ema21, rsi, macdHist);
      this.observations.push(scoreToSymbol(getCompositeObsScore(obs)));
    }
    if (this.observations.length >= 50) this.trainAsync();
  }

  private trainAsync() {
    this.isTraining = true;
    this.lastTrainingSize = this.observations.length;
    setTimeout(() => {
      try {
        this.model = baumWelch(this.model, this.observations.slice(), 100, 1e-5);
        this.persist();
      } catch (e) {
        console.error("[HMM] training error", e);
      } finally {
        this.isTraining = false;
      }
    }, 0);
  }

  getViterbiPath(length = 50): number[] {
    const obs = this.observations.slice(-length);
    if (obs.length < 10) return [];
    return viterbi(this.model, obs).stateSequence;
  }

  getModel(): HMMModel { return this.model; }
}

export const hmmManager = new HMMRegimeManager();