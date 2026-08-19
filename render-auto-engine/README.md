# Auto Engine — integration into Kmpanel-proxy

1. Copy this whole `auto-engine/` folder into the root of the `Kmpanel-proxy`
   repo (alongside the existing `server.js`).
2. Add `@supabase/supabase-js` to `Kmpanel-proxy/package.json` dependencies
   (same version as used in the Vercel repo).
3. In `server.js`, add exactly ONE line near the top (after existing
   requires), and ONE line near the bottom (after the server starts
   listening). Do not change anything else in server.js:

   ```js
   const startAutoEngine = require('./auto-engine');
   // ... existing code untouched ...
   startAutoEngine(); // call this once, anywhere after the server starts
   ```

## Environment variables to add on Render (Dashboard → Environment)

| Name | Value |
|---|---|
| `SUPABASE_URL` | same as Vercel's |
| `SUPABASE_SERVICE_ROLE_KEY` | same as Vercel's |
| `PROVIDER_ENCRYPTION_KEY` | **must be the exact same value** as Vercel's `PROVIDER_ENCRYPTION_KEY` — Render needs to decrypt keys Vercel encrypted |
| `CHUNK_SIZE_DEFAULT` | e.g. `100000` (optional, defaults to 100000) |
| `MAX_RETRY_COUNT` | e.g. `3` (optional, defaults to 3) |
| `AUTO_ENGINE_TICK_MS` | e.g. `15000` (optional, defaults to 15 seconds) |

No changes needed to any existing Render env vars used by Manual Order.
