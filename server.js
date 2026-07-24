// ==========================================
// KM Panel — API Proxy + Scheduler
// ==========================================
// 1. Proxies balance/services/add calls to any SMM panel (fixes CORS).
// 2. Accepts a full order's legs in one go and schedules them SERVER-SIDE,
//    so delivery keeps happening even if the website's tab is closed.
// 3. Keeps a short delivered-history log so the Tracker tab can show real
//    data for a link even after the browser was closed while it fired.
//
// Run locally:   npm install   then   npm start
// Deploy free:   Render.com / Railway.app as a Node web service
//                (Build: npm install, Start: npm start)
//
// IMPORTANT LIMITATION: free hosting plans (like Render's free tier)
// put the server to sleep after ~15 minutes with no incoming requests.
// While asleep, scheduled legs will NOT fire. Use a free uptime pinger
// (e.g. UptimeRobot hitting this URL every 10 minutes) to keep it awake
// for the full 12-24h delivery window.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const STORE_FILE = path.join(__dirname, "schedule-store.json");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- STATE (persisted to disk so a simple process restart can recover) ----------
let state = { pending: [], delivered: [], activityLog: [] };

function loadState() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      state = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      if (!state.activityLog) state.activityLog = [];
    }
  } catch {
    state = { pending: [], delivered: [], activityLog: [] };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(state));
  } catch (err) {
    console.error("Could not save state to disk:", err.message);
  }
}

function maskKey(key) {
  if (!key || key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function logActivity(entry) {
  state.activityLog.unshift({ timestamp: Date.now(), ...entry });
  if (state.activityLog.length > 300) state.activityLog.length = 300;
  saveState();
}

loadState();

// ---------- HELPER: call the real panel ----------
async function callPanel(baseUrl, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  return JSON.parse(text); // let it throw if the panel didn't return JSON
}

// ==========================================
// POST /proxy — generic pass-through (balance, services, manual add)
// ==========================================
app.post("/proxy", async (req, res) => {
  const { baseUrl, params } = req.body || {};
  if (!baseUrl || !params) {
    return res.status(400).json({ error: "Missing baseUrl or params in request body." });
  }
  try {
    const data = await callPanel(baseUrl, params);
    if (params.action === "balance") {
      logActivity({ type: "connect", baseUrl, keyMasked: maskKey(params.key) });
    }
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not reach the panel: ${err.message}` });
  }
});

// ==========================================
// POST /schedule-order — accepts a full order's legs and schedules
// them server-side. Works even if the browser is closed afterwards.
// body: { baseUrl, apiKey, legs: [{ serviceId, link, quantity, category, serviceLabel, fireInMs }] }
// ==========================================
app.post("/schedule-order", (req, res) => {
  const { baseUrl, apiKey, legs } = req.body || {};

  if (!baseUrl || !apiKey || !Array.isArray(legs) || legs.length === 0) {
    return res.status(400).json({ error: "Missing baseUrl, apiKey, or legs array." });
  }

  const now = Date.now();
  const scheduled = legs.map((leg) => ({
    id: `${now}_${Math.random().toString(36).slice(2, 9)}`,
    baseUrl,
    apiKey,
    serviceId: leg.serviceId,
    link: leg.link,
    quantity: leg.quantity,
    category: leg.category,
    serviceLabel: leg.serviceLabel,
    fireAt: now + (leg.fireInMs || 0),
  }));

  state.pending.push(...scheduled);

  scheduled.forEach((leg) => {
    logActivity({
      type: "order",
      baseUrl,
      keyMasked: maskKey(apiKey),
      link: leg.link,
      quantity: leg.quantity,
      serviceLabel: leg.serviceLabel,
    });
  });

  saveState();

  res.json({ scheduled: scheduled.length });
});

// ==========================================
// GET /history?link=... — delivered legs for a link, last 7 days
// ==========================================
app.get("/history", (req, res) => {
  const link = req.query.link;
  if (!link) return res.status(400).json({ error: "Missing link query param." });

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const entries = state.delivered.filter((d) => d.link === link && d.timestamp >= cutoff);
  res.json(entries);
});

// ==========================================
// GET /pending-count?link=... — how many legs are still queued for a link
// ==========================================
app.get("/pending-count", (req, res) => {
  const link = req.query.link;
  const count = link ? state.pending.filter((p) => p.link === link).length : state.pending.length;
  res.json({ pending: count });
});

app.get("/delivered-log", (req, res) => {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  res.json(state.delivered.filter((d) => d.timestamp >= cutoff));
});

app.get("/activity-log", (req, res) => {
  res.json(state.activityLog.slice(0, 100));
});

app.get("/", (req, res) => {
  res.send("KM Panel proxy is running. POST to /proxy with { baseUrl, params }.");
});

// ==========================================
// BACKGROUND SCHEDULER LOOP
// ==========================================
async function processDueLegs() {
  const now = Date.now();
  const due = state.pending.filter((leg) => leg.fireAt <= now);
  if (due.length === 0) return;

  for (const leg of due) {
    try {
      const data = await callPanel(leg.baseUrl, {
        key: leg.apiKey,
        action: "add",
        service: leg.serviceId,
        link: leg.link,
        quantity: leg.quantity,
      });
      state.delivered.push({
        link: leg.link,
        category: leg.category,
        amount: leg.quantity,
        timestamp: now,
        order: data.order || null,
      });
      console.log(`Delivered ${leg.quantity} ${leg.serviceLabel} for ${leg.link} — order #${data.order || "?"}`);
    } catch (err) {
      console.error(`Failed to deliver leg for ${leg.link}: ${err.message}`);
      // still record it as delivered=false isn't tracked separately here to keep things simple;
      // it's dropped after this attempt rather than retried indefinitely.
    }
  }

  state.pending = state.pending.filter((leg) => leg.fireAt > now);

  const historyCutoff = now - SEVEN_DAYS_MS;
  state.delivered = state.delivered.filter((d) => d.timestamp >= historyCutoff);

  saveState();
}

setInterval(processDueLegs, 15000); // check every 15 seconds

app.listen(PORT, () => {
  console.log(`KM Panel proxy listening on http://localhost:${PORT}`);
  console.log(`Loaded ${state.pending.length} pending leg(s) from disk.`);
});
