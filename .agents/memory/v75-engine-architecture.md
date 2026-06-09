---
name: V75 5-Layer Engine Architecture
description: Key decisions for the 5-Layer Microstructure Regime Classifier — weights, thresholds, direction logic, legacy compat.
---

## Architecture

5-layer weighted composite probability (0-100%) replaces the original 4-gate boolean system.

**Weights:** L1 Compression 20% · L2 Expansion 25% · L3 Structure 20% · L4 Flow 20% · L5 Persistence 15%

**Tiers:** REJECT <70 · WATCH 70-79 · CANDIDATE 80-84 · TRADE 85-89 · PREMIUM ≥90

**Signals fire only at tier TRADE or PREMIUM (prob ≥ 85) AND flowDirection !== NEUTRAL.**

## Layer formulas

- **L1 Compression:** RCR = range(50-tick) / avgRange(4×50-tick windows over 200 ticks). VCR = ATR(10) / ATR(100). Score = RCR·0.6 + VCR·0.4, remapped so 0=expanded, 100=compressed.
- **L2 Expansion:** DER = netMove/totalMove over 30 ticks. VBR = curVel(2s) / baseVel(20s), ATR-normalized. Score = DER·50 + VBR·50.
- **L3 Structure:** For windows [20,50,100]: split in halves, award HH=+2 bull, HL=+1 bull, LH=+1 bear, LL=+2 bear. Score = 50 + net/total * 50 (50=neutral, >62=BULL, <38=BEAR).
- **L4 Flow:** DTI across [20,50,100,200]-tick windows. Direction = RISE if 3+ positive, FALL if 3+ negative, else NEUTRAL. Scoring: aligned at |dti|≥0.65 gives 20-25 per window; opposing deducts up to 10.
- **L5 Persistence:** Linear regression slope of velocity history (sampled every 300ms, 20-point buffer). normSlope = slope/baseVelocity. Score = clamp(50 + normSlope*200, 0, 100).

## Direction

Primary: L4 flowDirection (RISE/FALL/NEUTRAL). If NEUTRAL, falls back to L3 structure bias. Signal blocked if both neutral.

## Legacy compat

Signal still carries zScore, hurstExponent, tickVelocity, dti, hurstRegime, thresholds — used by storage.ts DB mapping and DerivOptionTicket component.

## Ready threshold

100 ticks in buffer (READY_MIN_TICKS). Engine warms up before emitting any metrics.

## Pre-existing TS errors

resizable.tsx and example.functions.ts have pre-existing type errors unrelated to v75. Zero errors in all src/lib/v75/ and src/components/v75/ files.

**Why:** Institutional-grade signal quality requires near-perfect alignment across multiple microstructure dimensions simultaneously. The strict 85% threshold deliberately filters to high-conviction setups only.
