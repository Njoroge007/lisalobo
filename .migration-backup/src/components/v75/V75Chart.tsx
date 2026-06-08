import { useEffect, useRef } from "react";
import {
  createChart, CandlestickSeries, LineSeries, AreaSeries,
  type IChartApi, type ISeriesApi, LineStyle,
} from "lightweight-charts";
import type { Candle, OrderBlock, FVG, SMCState } from "@/lib/v75/types";
import { ema, sma, stdev } from "@/lib/v75/indicators";
import type { PatternResult } from "@/lib/v75/candlePatterns";
import { colorForSignal } from "@/lib/v75/candlePatterns";

interface OverlayProps {
  candles: Candle[];
  smc?: SMCState;
  smcHigher?: { tf: "H1" | "H4"; obs: OrderBlock[] }[];
  livePrice?: number;
  patternMarkers?: { time: number; pattern: PatternResult }[];
  microState?: "STRONG_BULL" | "BULL" | "BULL_FORMING" | "NEUTRAL" | "CONFLICTED" | "BEAR_FORMING" | "BEAR" | "STRONG_BEAR" | "REVERSAL_UP" | "REVERSAL_DOWN";
  showMicroRibbon?: boolean;
}

const EMA_COLORS = [
  { p: 9,   color: "#3B82F6", width: 1 as const },
  { p: 21,  color: "#F59E0B", width: 1 as const },
  { p: 50,  color: "#E2E8F0", width: 2 as const },
  { p: 200, color: "#8B5CF6", width: 2 as const },
];

export function V75Chart({ candles, smc, smcHigher = [], livePrice, patternMarkers = [], microState = "NEUTRAL", showMicroRibbon = false }: OverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const emaRefs = useRef<ISeriesApi<"Line">[]>([]);
  const bbRefs = useRef<{ upper: ISeriesApi<"Line">; lower: ISeriesApi<"Line">; middle: ISeriesApi<"Line"> } | null>(null);
  const zoneRefs = useRef<ISeriesApi<"Area">[]>([]);
  const microRibbonRefs = useRef<{ ema3: ISeriesApi<"Line">; ema8: ISeriesApi<"Line"> } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: { background: { color: "#0F1624" }, textColor: "#cbd5e1" },
      grid: { vertLines: { color: "#1a2336" }, horzLines: { color: "#1a2336" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      width: ref.current.clientWidth,
      height: 500,
    });
    chartRef.current = chart;
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: "#00E676", downColor: "#FF1744",
      wickUpColor: "#00E676", wickDownColor: "#FF1744",
      borderVisible: false,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    emaRefs.current = EMA_COLORS.map(({ color, width }) =>
      chart.addSeries(LineSeries, {
        color, lineWidth: width, priceLineVisible: false, lastValueVisible: true,
      }),
    );
    microRibbonRefs.current = {
      ema3: chart.addSeries(LineSeries, { color: "rgba(0,230,118,0.9)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      ema8: chart.addSeries(LineSeries, { color: "rgba(255,23,68,0.9)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    };
    bbRefs.current = {
      upper:  chart.addSeries(LineSeries, { color: "rgba(20,184,166,0.7)", lineWidth: 1, priceLineVisible: false, lastValueVisible: true, lineStyle: LineStyle.Dotted }),
      lower:  chart.addSeries(LineSeries, { color: "rgba(20,184,166,0.7)", lineWidth: 1, priceLineVisible: false, lastValueVisible: true, lineStyle: LineStyle.Dotted }),
      middle: chart.addSeries(LineSeries, { color: "rgba(20,184,166,0.3)", lineWidth: 1, priceLineVisible: false, lastValueVisible: true }),
    };
    const ro = new ResizeObserver(() => {
      if (ref.current && chartRef.current) chartRef.current.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    // TradingView-style OHLC legend (always visible, updates on crosshair move)
    const fmt = (v: number) => v.toFixed(2);
    const renderLegend = (c?: { open: number; high: number; low: number; close: number }) => {
      if (!legendRef.current || !c) return;
      const up = c.close >= c.open;
      const col = up ? "#00E676" : "#FF1744";
      const chg = c.close - c.open;
      const pct = c.open ? (chg / c.open) * 100 : 0;
      legendRef.current.innerHTML =
        `<span style="color:#94a3b8">O</span> <span style="color:${col}">${fmt(c.open)}</span>` +
        `  <span style="color:#94a3b8">H</span> <span style="color:${col}">${fmt(c.high)}</span>` +
        `  <span style="color:#94a3b8">L</span> <span style="color:${col}">${fmt(c.low)}</span>` +
        `  <span style="color:#94a3b8">C</span> <span style="color:${col}">${fmt(c.close)}</span>` +
        `  <span style="color:${col}">${chg >= 0 ? "+" : ""}${fmt(chg)} (${pct.toFixed(2)}%)</span>`;
    };
    chart.subscribeCrosshairMove((param) => {
      if (!candleRef.current) return;
      const d = param.seriesData?.get(candleRef.current) as any;
      if (d) renderLegend(d);
    });
    (chart as any)._renderLegend = renderLegend;

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, []);

  // Base candle + EMAs + BB
  useEffect(() => {
    if (!candleRef.current || !candles.length) return;
    candleRef.current.setData(candles.map((c) => ({
      time: c.time as any, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    // Update legend with latest candle by default
    const last = candles[candles.length - 1];
    (chartRef.current as any)?._renderLegend?.({ open: last.open, high: last.high, low: last.low, close: last.close });
    const closes = candles.map((c) => c.close);
    EMA_COLORS.forEach(({ p }, i) => {
      const e = ema(closes, p);
      emaRefs.current[i]?.setData(candles.map((c, idx) => ({ time: c.time as any, value: e[idx] })));
    });
    if (bbRefs.current && closes.length >= 20) {
      const m = sma(closes, 20);
      const sd = stdev(closes, 20);
      const up: any[] = [], lo: any[] = [], mi: any[] = [];
      candles.forEach((c, i) => {
        if (isNaN(m[i])) return;
        up.push({ time: c.time as any, value: m[i] + 2 * sd[i] });
        lo.push({ time: c.time as any, value: m[i] - 2 * sd[i] });
        mi.push({ time: c.time as any, value: m[i] });
      });
      bbRefs.current.upper.setData(up);
      bbRefs.current.lower.setData(lo);
      bbRefs.current.middle.setData(mi);
    }
    // Micro EMA ribbon (EMA3/EMA8) — only render when enabled
    if (microRibbonRefs.current) {
      if (showMicroRibbon && closes.length >= 8) {
        const e3 = ema(closes, 3);
        const e8 = ema(closes, 8);
        const isBull = e3[e3.length - 1] >= e8[e8.length - 1];
        microRibbonRefs.current.ema3.applyOptions({ color: isBull ? "rgba(0,230,118,0.95)" : "rgba(255,23,68,0.95)", lineWidth: 2 });
        microRibbonRefs.current.ema8.applyOptions({ color: isBull ? "rgba(0,230,118,0.45)" : "rgba(255,23,68,0.45)", lineWidth: 2 });
        microRibbonRefs.current.ema3.setData(candles.map((c, i) => ({ time: c.time as any, value: e3[i] })));
        microRibbonRefs.current.ema8.setData(candles.map((c, i) => ({ time: c.time as any, value: e8[i] })));
      } else {
        microRibbonRefs.current.ema3.setData([]);
        microRibbonRefs.current.ema8.setData([]);
      }
    }
    // Markers: CHoCH + Liquidity Sweep on the last candle if active
    const markers: any[] = [];
    if (smc) {
      const last = candles[candles.length - 1];
      if (smc.choch === "BULL") markers.push({ time: last.time, position: "belowBar", color: "#00E676", shape: "arrowUp", text: "CHoCH" });
      else if (smc.choch === "BEAR") markers.push({ time: last.time, position: "aboveBar", color: "#FF1744", shape: "arrowDown", text: "CHoCH" });
      if (smc.liquiditySweep === "BULL") markers.push({ time: last.time, position: "belowBar", color: "#F7931A", shape: "circle", text: "Sweep" });
      else if (smc.liquiditySweep === "BEAR") markers.push({ time: last.time, position: "aboveBar", color: "#F7931A", shape: "circle", text: "Sweep" });
    }
    // Pattern markers (last 50)
    const recent = patternMarkers.slice(-50);
    for (const m of recent) {
      const p = m.pattern;
      const isBull = p.direction === "RISE";
      const isBear = p.direction === "FALL";
      markers.push({
        time: m.time as any,
        position: isBull ? "belowBar" : isBear ? "aboveBar" : "inBar",
        color: colorForSignal(p.signal),
        shape: isBull ? "arrowUp" : isBear ? "arrowDown" : "circle",
        text: p.label,
        size: p.strength === "STRONG" ? 2 : 1,
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    (candleRef.current as any).setMarkers?.(markers);
  }, [candles, smc, patternMarkers, showMicroRibbon]);

  // Price + S/R + OB/FVG zone refresh
  useEffect(() => {
    if (!chartRef.current || !candleRef.current || !candles.length) return;

    // Clear previous price lines & zone series
    try { (candleRef.current as any).priceLines?.()?.forEach((pl: any) => candleRef.current!.removePriceLine(pl)); } catch {}
    zoneRefs.current.forEach((s) => { try { chartRef.current!.removeSeries(s); } catch {} });
    zoneRefs.current = [];

    const firstTime = candles[0].time as any;
    const lastTime = candles[candles.length - 1].time as any;

    const addZone = (lo: number, hi: number, color: string, label: string) => {
      const top = chartRef.current!.addSeries(AreaSeries, {
        topColor: color, bottomColor: color, lineColor: "transparent",
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      const bot = chartRef.current!.addSeries(AreaSeries, {
        topColor: "#0F1624", bottomColor: "#0F1624", lineColor: "transparent",
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      top.setData([{ time: firstTime, value: hi }, { time: lastTime, value: hi }]);
      bot.setData([{ time: firstTime, value: lo }, { time: lastTime, value: lo }]);
      // Border lines via priceLine on candle
      candleRef.current!.createPriceLine({
        price: hi, color: color, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: label,
      });
      candleRef.current!.createPriceLine({
        price: lo, color: color, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: "",
      });
      zoneRefs.current.push(top, bot);
    };

    // Order Blocks (own TF) — max 3 of each
    if (smc) {
      const bulls = smc.orderBlocks.filter(o => o.type === "BULL" && !o.mitigated).slice(-3);
      const bears = smc.orderBlocks.filter(o => o.type === "BEAR" && !o.mitigated).slice(-3);
      bulls.forEach(o => addZone(o.low, o.high, "rgba(0,230,118,0.12)", `BOB ${o.timeframe}`));
      bears.forEach(o => addZone(o.low, o.high, "rgba(255,23,68,0.12)", `BEOB ${o.timeframe}`));

      const bullFvgs = smc.fvgs.filter(f => f.type === "BULL" && !f.mitigated).slice(-3);
      const bearFvgs = smc.fvgs.filter(f => f.type === "BEAR" && !f.mitigated).slice(-3);
      bullFvgs.forEach(f => addZone(f.low, f.high, "rgba(0,230,118,0.07)", "FVG↑"));
      bearFvgs.forEach(f => addZone(f.low, f.high, "rgba(255,23,68,0.07)", "FVG↓"));

      // S/R
      smc.resistances.slice(0, 3).forEach((p, i) =>
        candleRef.current!.createPriceLine({
          price: p, color: "rgba(255,255,255,0.25)", lineWidth: 1,
          lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `R${i + 1}`,
        }),
      );
      smc.supports.slice(0, 3).forEach((p, i) =>
        candleRef.current!.createPriceLine({
          price: p, color: "rgba(255,255,255,0.25)", lineWidth: 1,
          lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `S${i + 1}`,
        }),
      );
    }

    // Higher-TF projected OBs
    smcHigher.forEach(({ tf, obs }) => {
      obs.filter(o => !o.mitigated).slice(-2).forEach(o => {
        const color = o.type === "BULL" ? "rgba(0,230,118,0.18)" : "rgba(255,23,68,0.18)";
        addZone(o.low, o.high, color, `${tf} ${o.type === "BULL" ? "BOB" : "BEOB"}`);
      });
    });

    // Live price line
    if (livePrice && livePrice > 0) {
      candleRef.current!.createPriceLine({
        price: livePrice, color: "#FFFFFF", lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "LIVE",
      });
    }
  }, [candles, smc, smcHigher, livePrice]);

  const tintBg =
    microState === "STRONG_BULL" ? "rgba(0,230,118,0.07)" :
    microState === "BULL" ? "rgba(0,230,118,0.035)" :
    microState === "STRONG_BEAR" ? "rgba(255,23,68,0.07)" :
    microState === "BEAR" ? "rgba(255,23,68,0.035)" :
    microState === "REVERSAL_UP" ? "rgba(0,230,118,0.1)" :
    microState === "REVERSAL_DOWN" ? "rgba(255,23,68,0.1)" :
    "transparent";
  return (
    <div className="relative w-full" style={{ height: 500 }}>
      <div ref={ref} className="w-full h-full" />
      <div className="absolute inset-0 pointer-events-none" style={{ background: tintBg }} />
      <div
        ref={legendRef}
        className="absolute top-2 left-3 z-10 text-xs font-mono pointer-events-none"
        style={{ textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}
      />
    </div>
  );
}