// ── Deriv OAuth 2.0 — Token Redirect (Implicit) Flow ─────────────────────────
//
// Deriv uses implicit OAuth — NOT auth-code exchange.
// After the user authorises, Deriv redirects back to your registered redirect_uri with:
//   ?acct1=CR12345&token1=a1-xxx...&cur1=USD
//   &acct2=VRTC5678&token2=a1-yyy...&cur2=USD  (demo account, if any)
//
// The redirect_uri is configured server-side in the Deriv developer portal for
// the registered app_id — it is NOT passed as a URL parameter.
//
// Register your app → https://app.deriv.com/account/api-token → Apps tab
// Set redirect URL  → https://lisalobo--gomamoja.replit.app/
// Copy numeric app_id → set VITE_DERIV_APP_ID in Replit Secrets

// ── Configuration ─────────────────────────────────────────────────────────────

// Deriv numeric app_id — MUST be an integer from the Deriv developer portal.
// Set VITE_DERIV_APP_ID in Replit Secrets (Settings → Secrets).
const APP_ID: string =
  (import.meta.env.VITE_DERIV_APP_ID as string | undefined) ?? "";

const OAUTH_ENDPOINT = "https://oauth.deriv.com/oauth2/authorize";

// Correct Deriv WebSocket endpoint — must include numeric app_id as query param
const derivWsUrl = () => `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID || "1"}`;

// ── Diagnostic log ─────────────────────────────────────────────────────────────

export type DiagEntry = { ts: number; level: "info" | "warn" | "error"; msg: string };
const _diagLog: DiagEntry[] = [];

function diag(level: DiagEntry["level"], msg: string) {
  const entry: DiagEntry = { ts: Date.now(), level, msg };
  _diagLog.push(entry);
  const tag = level === "error" ? "❌" : level === "warn" ? "⚠️" : "✓";
  console.log(`[Deriv Auth] ${tag} ${msg}`);
}

export const getDiagLog = (): DiagEntry[] => [..._diagLog];
export const clearDiagLog = (): void => { _diagLog.length = 0; };

// ── Module-level token store ──────────────────────────────────────────────────

let _accessToken: string | null = null;
export const getAccessToken   = () => _accessToken;
export const clearAccessToken = () => { _accessToken = null; };
export const restoreToken     = (t: string) => { _accessToken = t; };

// ── Persistent session (localStorage, 8-hour TTL) ────────────────────────────

export const SESSION_TTL_HOURS = 8;
const SESSION_KEY  = "deriv_v75_session_v1";
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;

export interface StoredSession {
  token:             string;
  expiresAt:         number;
  accounts:          DerivAccount[];
  selectedAccountId: string;
}

export function saveSession(
  token:             string,
  accounts:          DerivAccount[],
  selectedAccountId: string,
): void {
  try {
    const session: StoredSession = {
      token, accounts, selectedAccountId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* quota or private-mode */ }
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session: StoredSession = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch { return null; }
}

export function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  _accessToken = null;
}

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

// ── Validate app ID ──────────────────────────────────────────────────────────

export function appIdStatus(): "valid" | "missing" | "invalid" {
  if (!APP_ID) return "missing";
  if (!/^\d+$/.test(APP_ID)) return "invalid";
  return "valid";
}

// ── Initiate login — full-page redirect ──────────────────────────────────────
//
// Redirects to Deriv OAuth. After the user authorises, Deriv redirects back to
// the redirect_uri registered for this app_id in the Deriv developer portal.
// No redirect_uri param is sent — Deriv uses the registered one.

export function initiateLogin() {
  const status = appIdStatus();
  if (status === "missing") {
    diag("error", "OAuth start failed — VITE_DERIV_APP_ID is not set");
    throw new Error(
      "VITE_DERIV_APP_ID is not configured.\n\n" +
      "1. Register your app at app.deriv.com/account/api-token → Apps tab\n" +
      "2. Set redirect URL to https://lisalobo--gomamoja.replit.app/\n" +
      "3. Copy the numeric app_id\n" +
      "4. Add VITE_DERIV_APP_ID=<your-id> in Replit Secrets"
    );
  }
  if (status === "invalid") {
    diag("warn", `APP_ID "${APP_ID}" is not a valid Deriv numeric ID — OAuth may fail`);
  }

  const params = new URLSearchParams({ app_id: APP_ID, l: "en", brand: "deriv" });
  const url = `${OAUTH_ENDPOINT}?${params.toString()}`;
  diag("info", `OAuth started → ${url}`);
  window.location.href = url;
}

// ── Callback handler — parse tokens from Deriv redirect URL ──────────────────
//
// Call once on page load. Parses acct1/token1/cur1 … acctN/tokenN/curN from
// the URL query string, picks the best account (first real, fallback to demo),
// stores the token in module scope, then strips the params from the URL.

export async function handleOAuthCallback(
  _apiBase?: string,
): Promise<CallbackResult> {
  const url   = new URL(window.location.href);
  const error = url.searchParams.get("error");

  // Strip OAuth params from URL immediately so tokens don't linger in history
  const hadParams = url.searchParams.has("acct1") || url.searchParams.has("error");
  if (hadParams) {
    window.history.replaceState({}, "", window.location.pathname);
  }

  if (error) {
    const desc = url.searchParams.get("error_description") ?? "";
    const msg = `Deriv OAuth error: ${error}${desc ? ` — ${desc}` : ""}`;
    diag("error", `OAuth callback error — ${msg}`);
    return { status: "error", message: msg };
  }

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

  diag("info", `OAuth callback received — ${rawAccounts.length} account(s) in redirect`);

  // Prefer first real account (loginId does not start with VRTC)
  const primary =
    rawAccounts.find(a => !a.loginId.startsWith("VRTC")) ?? rawAccounts[0];

  diag("info", `Authorization code received — primary account: ${primary.loginId}`);
  _accessToken = primary.token;
  return { status: "connected", accessToken: primary.token };
}

// ── Normalize a Deriv `authorize` WS response into DerivAccount[] ─────────────

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

// ── Authorize via Deriv WebSocket and return account list + live balance ───────

function authorizeViaDerivWS(token: string): Promise<DerivAccount[]> {
  return new Promise((resolve, reject) => {
    const wsUrl = derivWsUrl();
    diag("info", `Opening WS → ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      diag("error", "WS authorize timed out after 12s");
      reject(new Error("Authorize timed out — check your network"));
    }, 12_000);

    ws.onopen = () => {
      diag("info", "WS open — sending authorize");
      ws.send(JSON.stringify({ authorize: token, req_id: 99 }));
    };

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string);
        if (data.req_id !== 99 && data.msg_type !== "authorize") return;
        clearTimeout(timeout);
        ws.close();
        if (data.error) {
          const msg = data.error.message ?? "Authorization failed";
          diag("error", `WS authorize error — ${msg}`);
          reject(new Error(msg));
          return;
        }
        const accs = normalizeAccounts(data.authorize);
        diag("info", `Token exchange successful — account loaded: ${accs[0]?.loginId}`);
        diag("info", "Trading session active");
        resolve(accs);
      } catch { /* ignore parse errors */ }
    };

    ws.onerror  = () => {
      clearTimeout(timeout);
      diag("error", "WS connection failed");
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose  = () => clearTimeout(timeout);
  });
}

// ── Public: authorize and return accounts ─────────────────────────────────────

export async function authorizeAndGetAccounts(
  token:    string,
  _apiBase?: string,
): Promise<DerivAccount[]> {
  return authorizeViaDerivWS(token);
}
