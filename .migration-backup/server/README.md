# V75 Background Collector

Standalone Node service that keeps the `v75_segment_records` table fed 24/7,
independent of any browser tab. Designed for Railway, Fly.io, Render, or
any always-on Node host.

## What it does

- Connects to Deriv's public WebSocket and subscribes to `R_75`.
- Maintains rolling M1 / M5 / H1 / H4 candle buffers.
- Every 15-minute boundary, snapshots an indicator + bias profile and
  inserts a row into `v75_segment_records` with `outcome = FLAT`.
- 15 minutes later, resolves the segment to `RISE` / `FALL` / `FLAT`
  (threshold = `0.3 × ATR`) and updates the same row.
- Auto-reconnects with exponential back-off (capped at 15s).

## Required env vars

| Variable                    | Value                                          |
| --------------------------- | ---------------------------------------------- |
| `SUPABASE_URL`              | `https://<project-ref>.supabase.co`            |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (bypasses RLS — server only)  |
| `DERIV_APP_ID`              | Optional, defaults to `1089`                   |

## Run locally

```bash
npm i ws @supabase/supabase-js
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node server/v75-collector.js
```

## Deploy to Railway

1. Create a new Railway project from this repo.
2. Settings → Variables: add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Settings → Deploy → Start Command: `node server/v75-collector.js`.
4. Deploy. Logs should show `[ws] open`, then `[hist] … loaded`, then a
   `[seg open]` line at the next :00 / :15 / :30 / :45 UTC boundary.

The collector is completely separate from the React app — both write into
the same Supabase table, so the UI always has a populated learning history.