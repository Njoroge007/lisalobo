import { getAccessToken } from "./derivAuth";

export type DurationUnit = "t" | "s" | "m" | "h" | "d";

export interface TradeResult {
  contractId: number;
  buyPrice: number;
  longcode: string;
}

/** Min/max valid values per duration unit for R_75 Rise/Fall contracts */
export const DURATION_LIMITS: Record<
  DurationUnit,
  { min: number; max: number; label: string }
> = {
  t: { min: 1, max: 10, label: "ticks" },
  s: { min: 15, max: 3600, label: "seconds" },
  m: { min: 1, max: 1440, label: "minutes" },
  h: { min: 1, max: 24, label: "hours" },
  d: { min: 1, max: 365, label: "days" },
};

/**
 * Execute a Rise/Fall trade via the Deriv OTP WebSocket flow.
 *
 * Flow:
 *   1. Backend proxies POST /trading/v1/options/accounts/{id}/otp → returns a
 *      single-use authenticated wss:// URL (CORS blocks this from the browser).
 *   2. Frontend opens that URL — the connection is already authenticated;
 *      NO `authorize` message is sent.
 *   3. On open: send proposal request.
 *   4. On proposal response: buy immediately using the proposal ID.
 *   5. On buy confirmation: resolve with { contractId, buyPrice, longcode }.
 *
 * OTPs are single-use and short-lived — a fresh one is fetched every trade.
 */
export async function executeTradeViaOTP(
  apiBase: string,
  accountId: string,
  contractType: "CALL" | "PUT",
  stake: number,
  duration: number = 2,
  durationUnit: DurationUnit = "m",
): Promise<TradeResult> {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated — please log in again");
  if (!accountId) throw new Error("No account selected");

  const limits = DURATION_LIMITS[durationUnit];
  const clampedDuration = Math.max(
    limits.min,
    Math.min(limits.max, Math.round(duration)),
  );

  // ── Step 1: Get a fresh OTP WebSocket URL from the backend proxy ────────────
  const otpRes = await fetch(`${apiBase}/deriv/ws-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, accessToken: token }),
  });

  if (!otpRes.ok) {
    const body = await otpRes.json().catch(() => ({}));
    throw new Error(
      body.error || `Failed to get trade session (${otpRes.status})`,
    );
  }

  const { wsUrl } = await otpRes.json();
  if (!wsUrl) throw new Error("Backend returned no WebSocket URL");

  // ── Step 2: Open the authenticated WebSocket — NO authorize message needed ──
  return new Promise<TradeResult>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Trade timed out (20s)"));
    }, 20_000);

    ws.onopen = () => {
      // Send buy directly — the OTP URL IS the authentication; no proposal step needed
      ws.send(
        JSON.stringify({
          buy: 1,
          price: stake,
          parameters: {
            amount: stake,
            basis: "stake",
            contract_type: contractType, // "CALL" | "PUT"
            currency: "USD",
            duration: clampedDuration,
            duration_unit: durationUnit, // "t"|"s"|"m"|"h"|"d"
          },
          req_id: 1,
        }),
      );
    };

    ws.onmessage = (ev) => {
      let d: any;
      try {
        d = JSON.parse(ev.data as string);
      } catch {
        return;
      }

      if (d.error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(d.error.message || JSON.stringify(d.error)));
        return;
      }

      // Buy confirmed
      if (d.msg_type === "buy" && d.buy) {
        clearTimeout(timeout);
        ws.close();
        resolve({
          contractId: d.buy.contract_id ?? 0,
          buyPrice: parseFloat(d.buy.buy_price ?? "0"),
          longcode: d.buy.longcode ?? "",
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
