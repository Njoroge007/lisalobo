import { Router } from "express";
const router = Router();

router.post("/auth/token", async (req, res) => {
  try {
    const { code, codeVerifier } = req.body;
    if (!code || !codeVerifier) {
      return res.status(400).json({ error: "Missing code or codeVerifier" });
    }

    const APP_ID = "33uTkAzdOo9TdI46YlHdQ";
    const REDIRECT_URI = "https://volatility-75--lisalobo89.replit.app/";

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: APP_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    });

    const tokenRes = await fetch("https://auth.deriv.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const body = await tokenRes.json() as Record<string, string>;

    if (!tokenRes.ok) {
      return res.status(tokenRes.status).json({
        error: body.error_description || body.error || "Token exchange failed",
      });
    }

    return res.json({ access_token: body.access_token });
  } catch (e: any) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
});

export default router;
