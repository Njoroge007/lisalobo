// ── Deriv OAuth 2.0 — Token Redirect flow ─────────────────────────────────────
//
// Deriv does NOT use PKCE / authorization code exchange.
// After the user logs in, Deriv redirects back to REDIRECT_URI with:
//   ?acct1=CR12345&token1=a1-xxx...&cur1=USD
//   &acct2=VRTC5678&token2=a1-yyy...&cur2=USD  (virtual account, if any)
// We read the tokens directly from the URL — no backend call required.

const APP_ID = "33vW8wqPMzOZsHKekI9P2";
const REDIRECT_URI = "https://lisalobo--gomamoja.replit.app/";
const OAUTH_ENDPOINT = "https://oauth.deriv.com/oauth2/authorize";

// WebSocket host used for token authorization + tick feed
const DERIV_WS_HOST = "wss://api.derivws.com/trading/v1/options/ws/public";

// Module-level token store — intentionally lost on page refresh (no localStorage)
let _accessToken: string | null = null;
export const getAccessToken   = () => _accessToken;
export const clearAccessToken = () => { _accessToken = null; };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DerivAccount {
  id:       string;
  loginId:  string;
  type:     "real" | "demo" | string;
  currency: string;
  balance:  number;
}

export type CallbackResult =
  | { status: "none" }
  | { status: "connected"; accessToken: string }
  | { status: "error";     message: string };

// ── Initiate login — full-page redirect ───────────────────────────────────────

export function initiateLogin() {
  const params = new URLSearchParams({
    app_id:       APP_ID,
    redirect_uri: REDIRECT_URI,
    l:            "en",
  });
  window.location.href = `${OAUTH_ENDPOINT}?${params.toString()}`;
}

// ── Callback handler — parse tokens from Deriv redirect URL ──────────────────
//
// Call once on page load. Parses acct1/token1/cur1 … acctN/tokenN/curN from
// the URL query string, picks the best account (first real, fallback to demo),
// stores the token in module scope, then strips the params from the URL.

export async function handleOAuthCallback(
  _apiBase?: string, // kept for call-site compatibility — not used
): Promise<CallbackResult> {
  const url   = new URL(window.location.href);
  const error = url.searchParams.get("error");

  // Always clean the URL so tokens don't linger in browser history
  window.history.replaceState({}, "", window.location.pathname);

  if (error) {
    const desc = url.searchParams.get("error_description") ?? "";
    return { status: "error", message: `Deriv: ${error}${desc ? ` — ${desc}` : ""}` };
  }

  // Collect all acctN/tokenN/curN triplets
  interface RawAccount { loginId: string; token: string; currency: string }
  const rawAccounts: RawAccount[] = [];

  for (let i = 1; ; i++) {
    const loginId = url.searchParams.get(`acct${i}`);
    const token   = url.searchParams.get(`token${i}`);
    if (!loginId || !token) break;
    rawAccounts.push({
      loginId,
      token,
      currency: url.searchParams.get(`cur${i}`) ?? "",
    });
  }

  if (rawAccounts.length === 0) return { status: "none" };

  // Prefer the first real account (loginId does not start with VRTC)
  const primary =
    rawAccounts.find(a => !a.loginId.startsWith("VRTC")) ?? rawAccounts[0];

  _accessToken = primary.token;
  return { status: "connected", accessToken: primary.token };
}

// ── Normalize a Deriv `authorize` WebSocket response into DerivAccount[] ──────

function normalizeAccounts(auth: any): DerivAccount[] {
  const currentLoginId: string  = auth.loginid  ?? "";
  const currentBalance: number  = Number(auth.balance ?? 0);
  const currentCurrency: string = auth.currency ?? "USD";

  const accounts: DerivAccount[] = (auth.account_list ?? []).map((a: any) => ({
    id:       a.loginid,
    loginId:  a.loginid,
    type:     a.is_virtual ? "demo" : "real",
    currency: a.currency ?? currentCurrency,
    balance:  a.loginid === currentLoginId ? currentBalance : 0,
  }));

  if (accounts.length === 0) {
    accounts.push({
      id:       currentLoginId,
      loginId:  currentLoginId,
      type:     "real",
      currency: currentCurrency,
      balance:  currentBalance,
    });
  }

  return accounts;
}

// ── Authorize via Deriv WebSocket and return account list + live balance ──────

function authorizeViaDerivWS(token: string): Promise<DerivAccount[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_HOST);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Authorize timed out after 12s")); }, 12_000);

    ws.onopen = () => ws.send(JSON.stringify({ authorize: token, req_id: 99 }));

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string);
        if (data.req_id !== 99 && data.msg_type !== "authorize") return;
        clearTimeout(timeout);
        ws.close();
        if (data.error) {
          reject(new Error(data.error.message ?? "Authorization failed"));
          return;
        }
        resolve(normalizeAccounts(data.authorize));
      } catch { /* ignore parse errors */ }
    };

    ws.onerror  = () => { clearTimeout(timeout); reject(new Error("WebSocket connection failed")); };
    ws.onclose  = () => clearTimeout(timeout);
  });
}

// ── Public: authorize and return accounts (WS first, REST proxy fallback) ─────

export async function authorizeAndGetAccounts(
  token:   string,
  apiBase: string,
): Promise<DerivAccount[]> {
  // 1. WebSocket authorize (same host as tick feed — works cross-origin in browser)
  try {
    const accounts = await authorizeViaDerivWS(token);
    if (accounts.length > 0) return accounts;
  } catch (_wsErr) {
    // fall through to REST proxy
  }

  // 2. Backend REST proxy (fallback)
  const res = await fetch(`${apiBase}/deriv/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Accounts fetch failed (${res.status})`);
  }

  return res.json() as Promise<DerivAccount[]>;
}
