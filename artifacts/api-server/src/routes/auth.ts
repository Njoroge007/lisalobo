import { Router } from "express";

const router = Router();

// Simple mock authentication layout or session handler matching your environment
router.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "admin") {
    return res.json({ success: true, token: "mock-jwt-token" });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

export default router;
