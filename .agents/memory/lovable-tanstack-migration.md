---
name: Lovable TanStack Start migration
description: Key patterns when migrating a Lovable app that used TanStack Start + Supabase to Replit pnpm_workspace
---

# Lovable TanStack Start Migration

The app used `@lovable.dev/vite-tanstack-config` which wraps TanStack Start (SSR framework). Vite React artifact uses plain Vite + React, so these must be removed:

## Files to delete from copied src/
- `src/start.ts` — TanStack Start entry (createStart, createMiddleware)
- `src/server.ts` — SSR server entry
- `src/router.tsx` — TanStack Router setup
- `src/routeTree.gen.ts` — TanStack Router generated file
- `src/lib/config.server.ts` — uses `import process from "node:process"` (wrong for browser)
- `src/integrations/supabase/` — Supabase client + auth middleware
- `src/routes/` — TanStack Router file-based routes

## App.tsx pattern
Replace TanStack Router with direct component render:
```tsx
import { V75Analyzer } from "@/components/v75/V75Analyzer";
// Just render the main component in App
```

## Supabase → API fetch
Replace `supabase.from(...)` calls with `fetch(API + "/route")`. Base URL via `import.meta.env.BASE_URL`.

## Packages to remove
- `@supabase/supabase-js`
- `@tanstack/react-router`
- `@tanstack/react-start`

**Why:** TanStack Start is an SSR framework incompatible with the plain Vite static build used by react-vite artifacts.
