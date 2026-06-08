import { useState } from "react";
import type { Signal } from "@/lib/v75/types";

const DURATIONS = [15, 30, 60] as const;

function buildMT5Order(s: Signal, mins: number) {
  // Smart Trader / MT5 Rise-Fall ticket text
  return [
    `Symbol: Volatility 75 Index`,
    `Type: ${s.direction === "RISE" ? "Rise (Higher)" : "Fall (Lower)"}`,
    `Duration: ${mins} minutes`,
    `Entry: ${s.entryPrice.toFixed(2)}`,
    `SL: ${s.mtLevels.sl.toFixed(2)}`,
    `TP1: ${s.mtLevels.tp1.toFixed(2)}  TP2: ${s.mtLevels.tp2.toFixed(2)}`,
    `Confidence: ${s.confidence}%  Tier ${s.tier}  Score ${s.score}`,
  ].join("\n");
}

export function MT5CopyPanel({ signal }: { signal: Signal }) {
  const [copied, setCopied] = useState<number | null>(null);
  const copy = (mins: number) => {
    navigator.clipboard.writeText(buildMT5Order(signal, mins));
    setCopied(mins);
    window.setTimeout(() => setCopied(null), 1500);
  };
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
        MT5 / Smart Trader · 3-duration ticket
      </div>
      <div className="grid grid-cols-3 gap-2">
        {DURATIONS.map((m) => (
          <button
            key={m}
            onClick={() => copy(m)}
            className="bg-secondary hover:bg-primary/20 border border-border rounded p-2 text-xs font-mono text-left transition"
          >
            <div className="font-bold text-primary">{m} min</div>
            <div className="text-muted-foreground">
              {signal.direction === "RISE" ? "↑ Rise" : "↓ Fall"} @ {signal.entryPrice.toFixed(2)}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {copied === m ? "✓ copied" : "tap to copy"}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}