import { useState } from "react";
import type { SnapbackSignal } from "@/lib/v75/types";

interface DerivTicketPayload {
  proposal: 1;
  amount: number;
  basis: "stake";
  currency: "USD";
  duration: 2;
  duration_unit: "m";
  symbol: "R_75";
  contract_type: "CALL" | "PUT";
}

function buildPayload(signal: SnapbackSignal, stake: number): DerivTicketPayload {
  return {
    proposal: 1,
    amount: stake,
    basis: "stake",
    currency: "USD",
    duration: 2,
    duration_unit: "m",
    symbol: "R_75",
    contract_type: signal.direction === "RISE" ? "CALL" : "PUT",
  };
}

export function DerivOptionTicket({ signal }: { signal: SnapbackSignal }) {
  const [stake, setStake] = useState<number>(1);
  const [copied, setCopied] = useState(false);

  const payload = buildPayload(signal, stake);
  const json = JSON.stringify(payload, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const isRise = signal.direction === "RISE";

  return (
    <div className="border border-zinc-700 rounded-lg p-4 space-y-3 bg-zinc-900/60">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-zinc-400">Deriv API Contract</span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-cyan-500/40 text-cyan-300 bg-cyan-500/10">
          ⏱ 2-MIN FIXED EXPIRY
        </span>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-400 whitespace-nowrap">Stake (USD)</label>
        <input
          type="number"
          min={0.35}
          step={0.5}
          value={stake}
          onChange={(e) => setStake(Math.max(0.35, Number(e.target.value)))}
          className="w-24 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-cyan-500"
        />
        <span className="text-[10px] text-zinc-500">(min $0.35)</span>
      </div>

      <div className={`flex items-center gap-2 px-3 py-2 rounded border text-xs font-mono font-bold ${
        isRise
          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
          : "border-rose-500/50 bg-rose-500/10 text-rose-300"
      }`}>
        <span>{isRise ? "▲ CALL (RISE)" : "▼ PUT (FALL)"}</span>
        <span className="text-zinc-500">·</span>
        <span>R_75</span>
        <span className="text-zinc-500">·</span>
        <span>2 min</span>
        <span className="text-zinc-500">·</span>
        <span>${stake.toFixed(2)} USD</span>
      </div>

      <pre className="bg-black/60 border border-zinc-700 rounded p-3 text-[10px] font-mono text-cyan-100 leading-relaxed overflow-x-auto">
        {json}
      </pre>

      <button
        onClick={handleCopy}
        className={`w-full py-2 rounded text-xs font-semibold tracking-wide transition-all ${
          copied
            ? "bg-emerald-600/70 text-white border border-emerald-500"
            : "bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/40 text-cyan-300"
        }`}
      >
        {copied ? "✓ Copied!" : "Copy API Payload"}
      </button>
    </div>
  );
}
