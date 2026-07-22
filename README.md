# KM Panel — API Proxy + Server-Side Scheduler

Most SMM panel APIs (including most that behave like YoYo Media) block
direct calls from a browser (CORS). This server sits in between —
your browser talks to this server, and this server talks to the real
panel. Server-to-server calls aren't subject to CORS, so this fixes it.

**It now also schedules your order deliveries itself.** When you click
"Create Order" with a real panel connected, the whole schedule (every
leg + its exact fire time) is handed to this server in one go. The
server keeps its own timer running and calls the panel at the right
time — so delivery keeps happening even if you close the website tab
or your laptop's browser entirely.

## Already deployed?

If you already deployed the older version of this proxy to Render,
you need to **redeploy** — push these updated files (`server.js`,
`package.json`) to the same GitHub repo (upload again / commit
changes), and Render will automatically rebuild and redeploy.

## Run it locally

1. Open a terminal in this `proxy-server` folder.
2. Install dependencies:
   ```
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
   You should see: `KM Panel proxy listening on http://localhost:3001`

The website's proxy address is hardcoded to the deployed Render URL,
so local runs are mainly useful for testing changes to this server.

## Deploy it for free

1. Push this `proxy-server` folder to a GitHub repo.
2. Create a free account on [Render.com](https://render.com) or
   [Railway.app](https://railway.app).
3. Create a new **Web Service** pointing at that repo, with:
   - Build command: `npm install`
   - Start command: `npm start`
4. You'll get a URL like `https://your-app.onrender.com`. Make sure
   the `PROXY_URL` constant near the top of the website's `script.js`
   points at `https://your-app.onrender.com/proxy`.

## Important: keep it awake for long deliveries

Render's **free tier puts the server to sleep after ~15 minutes** with
no incoming requests. While asleep, scheduled legs will **not** fire.

To keep a 12-24 hour delivery schedule running reliably, set up a free
uptime pinger — [UptimeRobot](https://uptimerobot.com) is a good option —
to hit your proxy's URL every 10 minutes. This keeps it awake for the
whole delivery window.

## What gets stored on the server

- **Pending legs** — every scheduled-but-not-yet-fired delivery, saved
  to `schedule-store.json` on disk so a simple process restart can
  recover them (this does *not* protect against Render fully sleeping
  and losing the container — hence the uptime pinger above).
- **Delivered history** — a rolling 7-day log per link, used by the
  website's Tracker tab (`GET /history?link=...`) so real delivery
  data shows up even if the browser was closed while it happened.

## Tested

This was tested end-to-end against a mock panel API: balance/services
fetch, real order scheduling, and — critically — **delivery firing
with the browser completely closed**, verified by querying the
server directly afterwards.
