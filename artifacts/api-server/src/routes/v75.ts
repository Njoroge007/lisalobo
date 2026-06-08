import { Router } from "express";

const router = Router();

// Proxy token route for Deriv authenticated WebSocket connections
router.post("/ws-token", async (req, res) => {
  try {
    const { accountId, accessToken } = req.body;
    
    if (!accessToken || !accountId) {
      return res.status(400).json({ error: "Missing required auth parameters" });
    }

    // Direct connection endpoint to Deriv App production WebSocket API
    const targetWs = `wss://ws.derivws.com/websockets/v3?app_id=1089&token=${accessToken}`;
    
    return res.json({ wsUrl: targetWs });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
