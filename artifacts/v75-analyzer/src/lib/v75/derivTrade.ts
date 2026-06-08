import { getAccessToken } from "./derivAuth";

export type DurationUnit = "t" | "s" | "m" | "h" | "d";

export interface TradeResult {
  contractId: number;
  buyPrice: number;
  longcode: string;
}

export const DURATION_LIMITS: Record<DurationUnit, { min: number; max: number; label: string }> = {
  t: { min: 1,  max: 10,   label: "ticks"   },
  s: { min: 15, max: 3600, label: "seconds" },
  m: { min: 1,  max: 1440, label: "minutes" },
  h: { min: 1,  max: 24,   label: "hours"   },
  d: { min: 1,  max: 365,  label: "days"    },
};

export async function executeTradeViaOTP(
  apiBase: string,
  accountId: string,
  contractType: "CALL" | "PUT",
  stake: number,
  duration: number = 2,
  durationUnit: DurationUnit = "m",
): Promise<TradeResult> {
  const token = getAccessToken();
  if (!token)     throw new Error("Not authenticated — please log in again");
  if (!accountId) throw new Error("No account selected");

  const limits = DURATION_LIMITS[durationUnit];
  const clampedDuration = Math.max(limits.min, Math.min(limits.max, Math.round(duration)));

  // Determine correct symbol: real accounts use R_75, demo accounts use R_75
  // Deriv uses R_75 for Volatility 75 Index on both real and demo
  const underlying_symbol = "R_75";

  const otpRes = await fetch(`${apiBase}/deriv/ws-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, accessToken: token }),
  });

  if (!otpRes.ok) {
    const body = await otpRes.json().catch(() => ({}));
    throw new Error(body.error || `Failed to get trade session (${otpRes.status})`);
  }

  const { wsUrl } = await otpRes.json();
  if (!wsUrl) throw new Error("Backend returned no WebSocket URL");

  return new Promise<TradeResult>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let proposalId: string | null = null;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Trade timed out (20s)"));
    }, 20_000);

    ws.onopen = () => {
      // Step 1: Request a proposal first
      ws.send(JSON.stringify({
        proposal: 1,
        amount: stake,
        basis: "stake",
        contract_type: contractType,
        currency: "USD",
        duration: clampedDuration,
        duration_unit: durationUnit,
        symbol: underlying_symbol,
        req_id: 1,
      }));
    };

    ws.onmessage = (ev) => {
      let d: any;
      try { d = JSON.parse(ev.data as string); } catch { return; }

      if (d.error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(d.error.message || JSON.stringify(d.error)));
        return;
      }

      // Step 2: Got proposal — now buy it
      if (d.msg_type === "proposal" && d.proposal?.id) {
        proposalId = d.proposal.id;
        ws.send(JSON.stringify({
          buy: proposalId,
          price: stake,
          req_id: 2,
        }));
      }

      // Step 3: Buy confirmed
      if (d.msg_type === "buy" && d.buy) {
        clearTimeout(timeout);
        ws.close();
        resolve({
          contractId: d.buy.contract_id ?? 0,
          buyPrice:   parseFloat(d.buy.buy_price ?? "0"),
          longcode:   d.buy.longcode ?? "",
        });
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error("WebSocket connection to Deriv failed"));
    };
  });
}
