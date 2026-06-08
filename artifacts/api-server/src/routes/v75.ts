import { Router } from "express";
import { WebSocket } from "ws";
const router = Router();

const APP_ID = "33uTkAzdOo9TdI46YlHdQ";

router.post("/ws-token", async (req, res) => {
  try {
    const { accountId, accessToken } = req.body;
    if (!accessToken || !accountId) {
      return res.status(400).json({ error: "Missing required auth parameters" });
    }
    const targetWs = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}&token=${accessToken}`;
    return res.json({ wsUrl: targetWs });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

router.get("/deriv/accounts", async (req, res) => {
  try {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Missing token" });
    const accounts = await new Promise<any[]>((resolve, reject) => {
      const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
      const timeout = setTimeout(() => { ws.close(); reject(new Error("Authorize timed out")); }, 12000);
      ws.on("open", () => ws.send(JSON.stringify({ authorize: token, req_id: 99 })));
      ws.on("message", (data: any) => {
        try {
          const d = JSON.parse(data.toString());
          if (d.msg_type !== "authorize") return;
          clearTimeout(timeout);
          ws.close();
          if (d.error) { reject(new Error(d.error.message || "Authorization failed")); return; }
          const auth = d.authorize;
          const loginid: string = auth.loginid ?? "";
          const balance: number = Number(auth.balance ?? 0);
          const currency: string = auth.currency ?? "USD";
          const list = (auth.account_list ?? []).map((a: any) => ({
            id: a.loginid, loginId: a.loginid,
            type: a.is_virtual ? "demo" : "real",
            currency: a.currency ?? currency,
            balance: a.loginid === loginid ? balance : 0,
          }));
          resolve(list.length ? list : [{ id: loginid, loginId: loginid, type: "real", currency, balance }]);
        } catch { }
      });
      ws.on("error", () => { clearTimeout(timeout); reject(new Error("WS error")); });
    });
    return res.json(accounts);
  } catch (e: any) {
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
});

export default router;
