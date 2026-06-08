#!/usr/bin/env node
/**
 * V75 Background Collector — Railway / any Node host.
 *
 * Subscribes to Deriv R_75 WebSocket, maintains rolling M1/M5/H1/H4
 * candle buffers, and every 15 minutes snapshots a SegmentRecord
 * into the `v75_segment_records` Supabase table. After 15 more
 * minutes the segment's outcome is resolved (RISE / FALL / FLAT)
 * and the row is updated.
 *
 * Required env:
 *   SUPABASE_URL                    (https://<project>.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY       (service-role key — bypasses RLS)
 * Optional:
 *   DERIV_APP_ID                    (defaults to 1089)
 *
 * Run:  node server/v75-collector.js
 * Railway: set the start command to `node server/v75-collector.js`
 *          and add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars.
 */
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_ID = process.env.DERIV_APP_ID || "1089";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Indicator helpers (mirrors src/lib/v75/indicators.ts subset) ────────
const ema = (vals, p) => {
  const k = 2 / (p + 1);
  let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
};
const rsi = (closes, p = 14) => {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const rs = g / Math.max(l, 1e-9);
  return 100 - 100 / (1 + rs);
};
const atr = (cdls, p = 14) => {
  if (cdls.length < p + 1) return 0;
  let s = 0;
  for (let i = cdls.length - p; i < cdls.length; i++) {
    const c = cdls[i], prev = cdls[i - 1];
    s += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  return s / p;
};

// ─── Candle buffers ─────────────────────────────────────────────────────
const buf = { 60: [], 300: [], 3600: [], 14400: [] };
const MAX = { 60: 1000, 300: 500, 3600: 200, 14400: 100 };

function upsertCandle(gran, c) {
  const arr = buf[gran];
  const last = arr[arr.length - 1];
  if (last && last.time === c.time) arr[arr.length - 1] = c;
  else arr.push(c);
  if (arr.length > MAX[gran]) arr.shift();
}

// ─── Segment state ─────────────────────────────────────────────────────
let pendingSegment = null; // { id, startTs, openPrice, snapshot }

function makeSnapshot() {
  const m1 = buf[60];
  const h1 = buf[3600];
  const h4 = buf[14400];
  if (m1.length < 250 || h1.length < 50 || h4.length < 20) return null;
  const closes = m1.map((c) => c.close);
  const e9 = ema(closes.slice(-50), 9);
  const e21 = ema(closes.slice(-100), 21);
  const e50 = ema(closes.slice(-200), 50);
  const e200 = ema(closes, 200);
  const r = rsi(closes);
  const a = atr(m1);
  const price = closes[closes.length - 1];
  const h1Closes = h1.map((c) => c.close);
  const h4Closes = h4.map((c) => c.close);
  const h1Bias = ema(h1Closes.slice(-30), 9) > ema(h1Closes.slice(-60), 21) ? "BULL" : "BEAR";
  const h4Bias = price > ema(h4Closes, 50) ? "BULL" : "BEAR";
  const emaAlign = e9 > e21 && e21 > e50 && e50 > e200 ? "FULL_BULL"
    : e9 < e21 && e21 < e50 && e50 < e200 ? "FULL_BEAR"
    : e9 > e21 ? "PARTIAL_BULL" : "PARTIAL_BEAR";
  return {
    rsi: +r.toFixed(2),
    stoch_k: 50, stoch_d: 50, macd_histogram: 0,
    williams_r: -50, cci: 0,
    bb_position: 0.5, bb_width: 0,
    atr: +a.toFixed(2),
    relative_atr: +(a / price).toFixed(6),
    ema_9: +e9.toFixed(2), ema_21: +e21.toFixed(2),
    ema_50: +e50.toFixed(2), ema_200: +e200.toFixed(2),
    ema_alignment: emaAlign,
    has_active_bob: false, has_active_beob: false, ob_timeframe: "NONE",
    has_fvg_bull: false, has_fvg_bear: false,
    choch_detected: "NONE", liquidity_sweep: "NONE",
    h4_bias: h4Bias, h1_bias: h1Bias,
    top_down_alignment: h4Bias === h1Bias ? `ALIGNED_${h4Bias}` : "MIXED",
    candle_pattern: "NONE", structure: "NEUTRAL",
    rsi_divergence: "NONE", macd_divergence: "NONE",
  };
}

async function openSegment(startTs, openPrice) {
  const snap = makeSnapshot();
  if (!snap) return;
  const date = new Date(startTs);
  const row = {
    timestamp: startTs,
    date_str: date.toISOString().slice(0, 10),
    time_str: date.toISOString().slice(11, 16) + " UTC",
    open_price: openPrice,
    close_price: openPrice,
    outcome: "FLAT",
    point_move: 0,
    score: 0, adjusted_score: 0,
    hour_of_day: date.getUTCHours(),
    day_of_week: date.getUTCDay(),
    ...snap,
  };
  const { data, error } = await sb.from("v75_segment_records").insert(row).select("id").single();
  if (error) { console.error("[open]", error.message); return; }
  pendingSegment = { id: data.id, startTs, openPrice, snap };
  console.log(`[seg open] ${row.time_str} @ ${openPrice}`);
}

async function closeSegment(closePrice) {
  if (!pendingSegment) return;
  const { id, openPrice, snap } = pendingSegment;
  const move = closePrice - openPrice;
  const thr = snap.atr * 0.3;
  const outcome = move > thr ? "RISE" : move < -thr ? "FALL" : "FLAT";
  const { error } = await sb.from("v75_segment_records")
    .update({ close_price: closePrice, outcome, point_move: +move.toFixed(2) })
    .eq("id", id);
  if (error) console.error("[close]", error.message);
  else console.log(`[seg close] ${outcome} (${move.toFixed(2)})`);
  pendingSegment = null;
}

// ─── 15-minute boundary tick ───────────────────────────────────────────
let lastBoundary = 0;
function onMinuteBoundary(epochSec, price) {
  const minute = Math.floor(epochSec / 60);
  if (minute % 15 !== 0 || minute === lastBoundary) return;
  lastBoundary = minute;
  if (pendingSegment) closeSegment(price);
  openSegment(minute * 60 * 1000, price);
}

// ─── WebSocket loop ────────────────────────────────────────────────────
let backoff = 1000;
function connect() {
  console.log("[ws] connecting…");
  const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
  ws.on("open", () => {
    console.log("[ws] open");
    backoff = 1000;
    ws.send(JSON.stringify({ ticks: "R_75", subscribe: 1 }));
    for (const [gran, count] of [[60, 1000], [300, 500], [3600, 200], [14400, 100]]) {
      ws.send(JSON.stringify({
        ticks_history: "R_75", adjust_start_time: 1, count, end: "latest",
        granularity: gran, start: 1, style: "candles", subscribe: gran <= 300 ? 1 : 0,
      }));
    }
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.error) { console.error("[deriv]", msg.error.message); return; }
    if (msg.tick) {
      onMinuteBoundary(msg.tick.epoch, msg.tick.quote);
    } else if (msg.candles) {
      const g = msg.echo_req.granularity;
      buf[g] = msg.candles.map((c) => ({ time: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
      console.log(`[hist] ${g}s loaded (${buf[g].length})`);
    } else if (msg.ohlc) {
      const g = +msg.ohlc.granularity;
      upsertCandle(g, {
        time: +msg.ohlc.open_time, open: +msg.ohlc.open, high: +msg.ohlc.high,
        low: +msg.ohlc.low, close: +msg.ohlc.close,
      });
    }
  });
  ws.on("close", () => {
    console.warn(`[ws] closed — retry in ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  });
  ws.on("error", (e) => { console.error("[ws]", e.message); ws.close(); });
}

connect();
process.on("SIGINT", () => { console.log("bye"); process.exit(0); });