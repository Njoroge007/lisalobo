// ── Deriv Trade Execution — Direct WebSocket ──────────────────────────────────
//
// All trades go through wss://ws.derivws.com/websockets/v3 directly from the
// browser. Flow per trade: connect → authorize with stored token → buy/sell.
// No backend OTP proxy required.

import { getAccessToken } from "./derivAuth";

export type DurationUnit = "t" | "s" | "m" | "h" | "d";

export interface TradeResult {
  contractId: number;
  buyPrice:   number;
  longcode:   string;
}

export interface ContractUpdate {
  contractId:  number;
  profit:      number;
  profitPct:   number;
  currentSpot: number;
  isSold:      boolean;
  status:      "open" | "sold" | "expired";
  dateExpiry:  number;
  bidPrice:    number;
  payout:      number;
}

export const DURATION_LIMITS: Record<DurationUnit, { min: number; max: number; label: string }> = {
  t: { min: 1,   max: 10,   label: "ticks"   },
  s: { min: 15,  max: 3600, label: "seconds" },
  m: { min: 1,   max: 1440, label: "minutes" },
  h: { min: 1,   max: 24,   label: "hours"   },
  d: { min: 1,   max: 365,  label: "days"    },
};

const DERIV_WS = "wss://ws.derivws.com/websockets/v3?app_id=1";

// ── Buy contract ──────────────────────────────────────────────────────────────

export async function executeTradeViaOTP(
  _apiBase:    string,            // kept for call-site compatibility
  _accountId:  string,            // kept for call-site compatibility
  contractType: "CALL" | "PUT",
  stake:        number,
  duration:     number = 2,
  durationUnit: DurationUnit = "m",
  onContractUpdate?: (update: ContractUpdate) => void,
): Promise<TradeResult> {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated — please log in first");

  const limits = DURATION_LIMITS[durationUnit];
  const clampedDuration = Math.max(limits.min, Math.min(limits.max, Math.round(duration)));

  return new Promise<TradeResult>((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS);
    let authorized    = false;
    let buyResolved   = false;
    let currency      = "USD";
    let monitorTimer: ReturnType<typeof setTimeout> | null = null;

    const buyTimeout = setTimeout(() => {
      ws.close();
      if (!buyResolved) reject(new Error("Trade timed out (25s) — check your connection"));
    }, 25_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ authorize: token, req_id: 1 }));
    };

    ws.onmessage = (ev) => {
      let d: any;
      try { d = JSON.parse(ev.data as string); } catch { return; }

      // Any error at any stage
      if (d.error) {
        clearTimeout(buyTimeout);
        if (monitorTimer) clearTimeout(monitorTimer);
        ws.close();
        if (!buyResolved) reject(new Error(d.error.message ?? JSON.stringify(d.error)));
        return;
      }

      // Step 1 — authorized: send buy proposal
      if (d.msg_type === "authorize" && !authorized) {
        authorized = true;
        currency   = d.authorize?.currency ?? "USD";
        ws.send(JSON.stringify({
          buy: 1,
          price: stake,
          parameters: {
            amount:        stake,
            basis:         "stake",
            contract_type: contractType,
            currency,
            duration:      clampedDuration,
            duration_unit: durationUnit,
            symbol:        "R_75",
          },
          req_id: 2,
        }));
        return;
      }

      // Step 2 — buy confirmed
      if (d.msg_type === "buy" && d.buy && !buyResolved) {
        clearTimeout(buyTimeout);
        buyResolved = true;

        const result: TradeResult = {
          contractId: d.buy.contract_id ?? 0,
          buyPrice:   parseFloat(d.buy.buy_price ?? "0"),
          longcode:   d.buy.longcode ?? "",
        };

        if (onContractUpdate && result.contractId) {
          ws.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: result.contractId,
            subscribe:   1,
            req_id:      3,
          }));
          // auto-close monitor after 12 min
          monitorTimer = setTimeout(() => ws.close(), 12 * 60 * 1000);
        } else {
          ws.close();
        }

        resolve(result);
        return;
      }

      // Step 3 — contract live updates
      if (d.msg_type === "proposal_open_contract" && d.proposal_open_contract) {
        const poc      = d.proposal_open_contract;
        const isSold    = poc.is_sold    === 1;
        const isExpired = poc.is_expired === 1;

        onContractUpdate?.({
          contractId:  poc.contract_id,
          profit:      parseFloat(poc.profit            ?? "0"),
          profitPct:   parseFloat(poc.profit_percentage ?? "0"),
          currentSpot: parseFloat(poc.current_spot      ?? "0"),
          isSold:      isSold || isExpired,
          status:      isSold ? "sold" : isExpired ? "expired" : "open",
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
      if (!buyResolved) reject(new Error("WebSocket connection to Deriv failed"));
    };
  });
}

// ── Sell open contract early ───────────────────────────────────────────────────

export async function sellContract(
  _apiBase:   string,   // kept for call-site compatibility
  _accountId: string,   // kept for call-site compatibility
  contractId: number,
): Promise<{ sellPrice: number }> {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS);
    let authorized = false;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Sell timed out (20s)"));
    }, 20_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ authorize: token, req_id: 1 }));
    };

    ws.onmessage = (ev) => {
      let d: any;
      try { d = JSON.parse(ev.data as string); } catch { return; }

      if (d.error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(d.error.message ?? JSON.stringify(d.error)));
        return;
      }

      if (d.msg_type === "authorize" && !authorized) {
        authorized = true;
        ws.send(JSON.stringify({ sell: contractId, price: 0, req_id: 2 }));
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
      reject(new Error("WebSocket sell connection failed"));
    };
  });
}
