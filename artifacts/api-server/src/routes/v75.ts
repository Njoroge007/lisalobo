import { Router } from "express";
import { WebSocket } from "ws";
import { db, v75SignalHistoryTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

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

// ── Signal History ────────────────────────────────────────────────────────────

router.get("/signals", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = await db
      .select()
      .from(v75SignalHistoryTable)
      .orderBy(desc(v75SignalHistoryTable.createdAt))
      .limit(limit);
    return res.json(rows);
  } catch (e: any) {
    req.log.error({ err: e }, "loadSignals failed");
    return res.status(500).json({ error: e.message });
  }
});

router.post("/signals", async (req, res) => {
  try {
    const b = req.body;
    const [row] = await db
      .insert(v75SignalHistoryTable)
      .values({
        id: b.id,
        timestamp: String(b.timestamp),
        direction: b.direction,
        strength: b.strength ?? "Strong",
        confidence: Number(b.confidence) || 0,
        score: Number(b.score) || 0,
        adjustedScore: b.adjusted_score != null ? Number(b.adjusted_score) : null,
        durationMinutes: Number(b.duration_minutes) || 2,
        entryPrice: b.entry_price != null ? String(b.entry_price) : null,
        outcome: b.outcome ?? "PENDING",
        chochPresent: b.choch_present ?? false,
        sweepPresent: b.sweep_present ?? false,
        obTimeframe: b.ob_timeframe ?? null,
        h4Bias: b.h4_bias ?? null,
        h1Bias: b.h1_bias ?? null,
        patternMatchRate: b.pattern_match_rate != null ? String(b.pattern_match_rate) : null,
      })
      .returning();
    return res.status(201).json(row);
  } catch (e: any) {
    req.log.error({ err: e }, "saveSignal failed");
    return res.status(500).json({ error: e.message });
  }
});

router.patch("/signals/:id/outcome", async (req, res) => {
  try {
    const { id } = req.params;
    const { outcome, exit_price } = req.body;
    if (!outcome || !["WIN", "LOSS"].includes(outcome)) {
      return res.status(400).json({ error: "outcome must be WIN or LOSS" });
    }
    const [row] = await db
      .update(v75SignalHistoryTable)
      .set({
        outcome,
        exitPrice: exit_price != null ? String(exit_price) : null,
      })
      .where(eq(v75SignalHistoryTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Signal not found" });
    return res.json(row);
  } catch (e: any) {
    req.log.error({ err: e }, "updateSignalOutcome failed");
    return res.status(500).json({ error: e.message });
  }
});

export default router;
