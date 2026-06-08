import { Router } from "express";

const router = Router();

const APP_ID = "33uTkAzdOo9TdI46YlHdQ";
const REDIRECT_URI = "https://volatility-75--lisalobo89.replit.app/";
const TOKEN_ENDPOINT = "https://auth.deriv.com/oauth2/token";
const DERIV_REST_BASE = "https://api.derivws.com";

// ── POST /auth/token — server-side PKCE token exchange ───────────────────────
router.post("/auth/token", async (req, res) => {
  try {
    const { code, codeVerifier } = req.body as { code?: string; codeVerifier?: string };

    if (!code || !codeVerifier) {
      res.status(400).json({ error: "code and codeVerifier are required" });
      return;
    }

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: APP_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    });

    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok) {
      res.status(400).json({ error: data.error_description || data.error || "Token exchange failed" });
      return;
    }

    res.json({ access_token: data.access_token, expires_in: data.expires_in });
  } catch (err) {
    req.log.error({ err }, "auth/token failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /deriv/accounts — proxy account list ─────────────────────────────────
router.get("/deriv/accounts", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) {
      res.status(401).json({ error: "Missing Authorization header" });
      return;
    }

    const acctRes = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
      headers: {
        Authorization: auth,
        "Deriv-App-ID": APP_ID,
      },
    });

    const raw = await acctRes.text();
    req.log.info({ status: acctRes.status, body: raw.slice(0, 500) }, "deriv/accounts raw response");

    if (!acctRes.ok) {
      res.status(acctRes.status).json({ error: `Deriv API ${acctRes.status}: ${raw.slice(0, 200)}` });
      return;
    }

    let data: any;
    try { data = JSON.parse(raw); } catch {
      res.status(502).json({ error: "Deriv API returned non-JSON response" });
      return;
    }

    let list: any[] = [];
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data.accounts)) list = data.accounts;
    else if (Array.isArray(data.data)) list = data.data;
    else if (data.authorize?.account_list) list = data.authorize.account_list;

    res.json(
      list.map((a: any) => ({
        id: a.loginid ?? a.id ?? a.account_id,
        loginId: a.loginid ?? a.login_id ?? a.id,
        type: a.account_type ?? (a.is_virtual ? "demo" : "real"),
        currency: a.currency ?? "USD",
        balance: Number(a.balance ?? 0),
      }))
    );
  } catch (err) {
    req.log.error({ err }, "deriv/accounts failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /deriv/ws-token — fetch a single-use OTP WebSocket URL ──────────────
// Must be proxied from the backend — the Authorization header cannot be set
// from the browser to api.derivws.com due to CORS restrictions.
router.post("/deriv/ws-token", async (req, res) => {
  try {
    const { accountId, accessToken } = req.body as { accountId?: string; accessToken?: string };

    if (!accountId || !accessToken) {
      res.status(400).json({ error: "accountId and accessToken are required" });
      return;
    }

    const otpRes = await fetch(
      `${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/otp`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Deriv-App-ID": "33ueDwEu9upIvEkFRHZQf",
        },
      }
    );

    const raw = await otpRes.text();
    req.log.info({ status: otpRes.status, body: raw.slice(0, 400) }, "deriv/ws-token OTP response");

    if (!otpRes.ok) {
      let errBody: any = {};
      try { errBody = JSON.parse(raw); } catch {}
      res.status(otpRes.status).json({ error: errBody.message || errBody.error || raw.slice(0, 200) });
      return;
    }

    let data: any;
    try { data = JSON.parse(raw); } catch {
      res.status(502).json({ error: "Deriv OTP endpoint returned non-JSON" });
      return;
    }

    // Deriv returns: { data: { url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=..." } }
    const wsUrl = data?.data?.url ?? data?.url;
    if (!wsUrl) {
      req.log.error({ data }, "deriv/ws-token: no url in response");
      res.status(502).json({ error: "No WebSocket URL in Deriv OTP response" });
      return;
    }

    res.json({ wsUrl });
  } catch (err) {
    req.log.error({ err }, "deriv/ws-token failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
