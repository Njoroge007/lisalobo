import { getAccessToken } from "./derivAuth";

export type DurationUnit = "t" | "s" | "m" | "h" | "d";

export interface TradeResult {
  contractId: number;
  buyPrice: number;
  longcode: string;
}

export interface ContractUpdate {
  contractId: number;
  profit: number;
  profitPct: number;
  currentSpot: number;
  isSold: boolean;
  status: "open" | "sold" | "expired";
  dateExpiry: number;  // unix seconds from Deriv
  bidPrice: number;    // current sell / contract value
  payout: number;      // max potential payout
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
  onContractUpdate?: (update: ContractUpdate) => void,
): Promise<TradeResult> {
  const token = getAccessToken();
  if (!token)     throw new Error("Not authenticated — please log in again");
  if (!accountId) throw new Error("No account selected");

  const limits = DURATION_LIMITS[durationUnit];
  const clampedDuration = Math.max(limits.min, Math.min(limits.max, Math.round(duration)));

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
    let buyResolved = false;
    let monitorTimer: ReturnType<typeof setTimeout> | null = null;

    const buyTimeout = setTimeout(() => {
      if (!buyResolved) {
        ws.close();
        reject(new Error("Trade timed out (20s)"));
      }
    }, 20_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        buy: 1,
        price: stake,
        parameters: {
          amount: stake,
          basis: "stake",
          contract_type: contractType,
          currency: "USD",
          duration: clampedDuration,
          duration_unit: durationUnit,
          underlying_symbol: "R_75",
        },
        req_id: 1,
      }));
    };

    ws.onmessage = (ev) => {
      let d: any;
      try { d = JSON.parse(ev.data as string); } catch { return; }

      if (d.error && !buyResolved) {
        clearTimeout(buyTimeout);
        ws.close();
        reject(new Error(d.error.message || JSON.stringify(d.error)));
        return;
      }

      if (d.msg_type === "buy" && d.buy) {
        clearTimeout(buyTimeout);
        buyResolved = true;
        const result: TradeResult = {
          contractId: d.buy.contract_id ?? 0,
          buyPrice:   parseFloat(d.buy.buy_price  ?? "0"),
          longcode:   d.buy.longcode ?? "",
        };

        if (onContractUpdate && result.contractId) {
          ws.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: result.contractId,
            subscribe: 1,
            req_id: 2,
          }));
          monitorTimer = setTimeout(() => ws.close(), 12 * 60 * 1000);
        } else {
          ws.close();
        }
        resolve(result);
        return;
      }

      if (d.msg_type === "proposal_open_contract" && d.proposal_open_contract) {
        const poc = d.proposal_open_contract;
        const isSold    = poc.is_sold    === 1;
        const isExpired = poc.is_expired === 1;
        const status: ContractUpdate["status"] =
          isSold ? "sold" : isExpired ? "expired" : "open";

        onContractUpdate?.({
          contractId:  poc.contract_id,
          profit:      parseFloat(poc.profit            ?? "0"),
          profitPct:   parseFloat(poc.profit_percentage ?? "0"),
          currentSpot: parseFloat(poc.current_spot      ?? "0"),
          isSold:      isSold || isExpired,
          status,
          dateExpiry:  poc.date_expiry  ?? 0,
          bidPrice:    parseFloat(poc.bid_price ?? "0"),
          payout:      parseFloat(poc.payout    ?? "0"),
        });

        if (isSold || isExpired) {
          if (monitorTimer) clearTimeout(monitorTimer);
          ws.close();
        }
      }
    };

    ws.onerror = () => {
      clearTimeout(buyTimeout);
      if (monitorTimer) clearTimeout(monitorTimer);
      ws.close();
      if (!buyResolved) reject(new Error("WebSocket connection to Deriv failed"));
    };
  });
}

export async function sellContract(
  apiBase: string,
  accountId: string,
  contractId: number,
): Promise<{ sellPrice: number }> {
  const token = getAccessToken();
  if (!token)     throw new Error("Not authenticated");
  if (!accountId) throw new Error("No account selected");

  const otpRes = await fetch(`${apiBase}/deriv/ws-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, accessToken: token }),
  });
  if (!otpRes.ok) {
    const body = await otpRes.json().catch(() => ({}));
    throw new Error(body.error || `Failed to get sell session (${otpRes.status})`);
  }
  const { wsUrl } = await otpRes.json();
  if (!wsUrl) throw new Error("Backend returned no WebSocket URL");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Sell timed out (15s)"));
    }, 15_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ sell: contractId, price: 0, req_id: 1 }));
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

      if (d.msg_type === "sell" && d.sell) {
        clearTimeout(timeout);
        ws.close();
        resolve({ sellPrice: parseFloat(d.sell.sold_for ?? "0") });
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error("WebSocket sell connection failed"));
    };
  });
}
