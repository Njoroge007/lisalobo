const APP_ID = "33vW8wqPMzOZsHKekI9P2";
const REDIRECT_URI = "https://lisalobo--gomamoja.replit.app/";
const AUTH_ENDPOINT = "https://auth.deriv.com/oauth2/auth";

// Same host that DerivClient uses for tick data — confirmed to work in-browser
const DERIV_WS_HOST = "wss://api.derivws.com/trading/v1/options/ws/public";

// Module-level token store — intentionally lost on page refresh
let _accessToken: string | null = null;
export const getAccessToken = () => _accessToken;
export const clearAccessToken = () => { _accessToken = null; };

export interface DerivAccount {
  id: string;
  loginId: string;
  type: "real" | "demo" | string;
  currency: string;
  balance: number;
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string; state: string }> {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const raw = crypto.getRandomValues(new Uint8Array(64));
  const codeVerifier = Array.from(raw).map(v => CHARS[v % 66]).join("");

  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const stateBytes = crypto.getRandomValues(new Uint8Array(16));
  const state = Array.from(stateBytes).map(b => b.toString(16).padStart(2, "0")).join("");

  return { codeVerifier, codeChallenge, state };
}

// ── Normalize a Deriv authorize response into DerivAccount[] ─────────────────

function normalizeAccounts(auth: any): DerivAccount[] {
  const currentLoginId: string = auth.loginid ?? "";
  const currentBalance: number = Number(auth.balance ?? 0);
  const currentCurrency: string = auth.currency ?? "USD";

  const accounts: DerivAccount[] = (auth.account_list ?? []).map((a: any) => ({
    id: a.loginid,
    loginId: a.loginid,
    type: a.is_virtual ? "demo" : "real",
    currency: a.currency ?? currentCurrency,
    balance: a.loginid === currentLoginId ? currentBalance : 0,
  }));

  if (accounts.length === 0) {
    accounts.push({
      id: currentLoginId,
      loginId: currentLoginId,
      type: "real",
      currency: currentCurrency,
      balance: currentBalance,
    });
  }

  return accounts;
}

// ── Try authorize via the api.derivws.com WebSocket (same host as tick feed) ─

function authorizeViaDerivWS(token: string): Promise<DerivAccount[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_HOST);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Authorize timed out")); }, 12000);

    ws.onopen = () => ws.send(JSON.stringify({ authorize: token, req_id: 99 }));

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string);
        if (data.req_id !== 99 && data.msg_type !== "authorize") return;
        clearTimeout(timeout);
        ws.close();
        if (data.error) { reject(new Error(data.error.message || "Authorization failed")); return; }
        resolve(normalizeAccounts(data.authorize));
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => { clearTimeout(timeout); reject(new Error("WS unavailable")); };
    ws.onclose = () => clearTimeout(timeout);
  });
}

// ── Authorize and load accounts — WS first, REST fallback ────────────────────

export async function authorizeAndGetAccounts(
  token: string,
  apiBase: string
): Promise<DerivAccount[]> {
  // 1. Try WebSocket authorize (api.derivws.com — same host as tick feed)
  try {
    const accounts = await authorizeViaDerivWS(token);
    if (accounts.length > 0) return accounts;
  } catch (_wsErr) {
    // fall through to REST
  }

  // 2. Fallback: backend REST proxy
  const res = await fetch(`${apiBase}/deriv/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Accounts fetch failed (${res.status})`);
  }

  const data: DerivAccount[] = await res.json();
  return data;
}

// ── Initiate login — full-page redirect (no popup, no new tab) ───────────────

export async function initiateLogin() {
  const { codeVerifier, codeChallenge, state } = await generatePKCE();

  sessionStorage.setItem("pkce_code_verifier", codeVerifier);
  sessionStorage.setItem("oauth_state", state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    scope: "trade account_manage",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ── Callback handler — call once on page load ────────────────────────────────

export type CallbackResult =
  | { status: "none" }
  | { status: "connecting" }
  | { status: "connected"; accessToken: string }
  | { status: "error"; message: string };

export async function handleOAuthCallback(apiBase: string): Promise<CallbackResult> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Clean the URL immediately regardless of outcome
  window.history.replaceState({}, "", window.location.pathname);

  if (error) {
    const description = url.searchParams.get("error_description");
    return { status: "error", message: `Deriv error: ${error}${description ? ` — ${description}` : ""}` };
  }

  if (!code || !state) {
    return { status: "none" };
  }

  // Validate state
  const storedState = sessionStorage.getItem("oauth_state");
  if (state !== storedState) {
    sessionStorage.removeItem("pkce_code_verifier");
    sessionStorage.removeItem("oauth_state");
    return { status: "error", message: "Authentication failed: state mismatch" };
  }

  const codeVerifier = sessionStorage.getItem("pkce_code_verifier") ?? "";
  sessionStorage.removeItem("pkce_code_verifier");
  sessionStorage.removeItem("oauth_state");

  // Exchange code for token via backend (server-side only)
  try {
    const res = await fetch(`${apiBase}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { status: "error", message: body.error || "Token exchange failed" };
    }

    const { access_token } = await res.json();
    _accessToken = access_token;
    return { status: "connected", accessToken: access_token };
  } catch (e: any) {
    return { status: "error", message: e?.message || "Network error during token exchange" };
  }
}
