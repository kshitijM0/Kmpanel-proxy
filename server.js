// ==========================================
// KM Panel — API Proxy + Order Scheduler
// ==========================================
// 1. Proxies balance/services/add calls to any SMM panel (fixes CORS).
// 2. Accepts a full order's legs in one go and schedules them SERVER-SIDE,
//    grouped as an "order" that can be paused, resumed, or deleted from
//    the Schedules tab — so delivery keeps happening even if the
//    browser tab is closed, and can be controlled at any time.
// 3. Keeps a short delivered-history log (Tracker tab) and a full
//    activity log of connects + orders (Schedules tab, password gated
//    client-side).
//
// Run locally:   npm install   then   npm start
// Deploy free:   push this folder to Render.com or Railway.app as a
//                Node web service (Build: npm install, Start: npm start)
//
// IMPORTANT: free hosting plans sleep after ~15 min with no requests.
// While asleep, scheduled legs will NOT fire. Use a free uptime pinger
// (e.g. UptimeRobot hitting this URL every 10 minutes) during delivery.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const startAutoEngine = require("./render-auto-engine");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const STORE_FILE = path.join(__dirname, "schedule-store.json");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- STATE (persisted to disk so a simple process restart can recover) ----------
// orders: [{ id, name, link, baseUrl, apiKey, status: 'active'|'paused'|'completed',
//            createdAt, legs: [{ id, serviceId, category, serviceLabel, quantity, fireAt, fired }] }]
let state = { orders: [], delivered: [], activityLog: [] };

function loadState() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      state = {
        orders: loaded.orders || [],
        delivered: loaded.delivered || [],
        activityLog: loaded.activityLog || [],
      };
    }
  } catch {
    state = { orders: [], delivered: [], activityLog: [] };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(state));
  } catch (err) {
    console.error("Could not save state to disk:", err.message);
  }
}

function logActivity(entry) {
  state.activityLog.unshift({ timestamp: Date.now(), ...entry });
  if (state.activityLog.length > 300) state.activityLog.length = 300;
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
      logActivity({ type: "connect", baseUrl, apiKey: params.key });
      saveState();
    }
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not reach the panel: ${err.message}` });
  }
});

// ==========================================
// POST /schedule-order — creates a new order (a group of legs) and
// schedules it server-side. Shows up immediately in GET /orders.
// body: { name, baseUrl, apiKey, link, legs: [{ serviceId, link, quantity, category, serviceLabel, fireInMs }] }
// ==========================================
app.post("/schedule-order", (req, res) => {
  const { name, baseUrl, apiKey, link, legs } = req.body || {};

  if (!Array.isArray(legs) || legs.length === 0 || (!baseUrl && !legs.every((l) => l.baseUrl && l.apiKey))) {
    return res.status(400).json({ error: "Missing baseUrl/apiKey (order-level or per-leg), or legs array." });
  }

  const now = Date.now();
  const orderId = `order_${now}_${Math.random().toString(36).slice(2, 8)}`;

  const orderLegs = legs.map((leg, i) => ({
    id: `${orderId}_leg${i}`,
    serviceId: leg.serviceId,
    link: leg.link || link,
    quantity: leg.quantity,
    category: leg.category,
    serviceLabel: leg.serviceLabel,
    baseUrl: leg.baseUrl || baseUrl,
    apiKey: leg.apiKey || apiKey,
    fireAt: now + (leg.fireInMs || 0),
    fired: false,
  }));

  state.orders.push({
    id: orderId,
    name: name || "Untitled schedule",
    link: link || (legs[0] && legs[0].link) || "",
    baseUrl,
    apiKey,
    status: "active",
    createdAt: now,
    legs: orderLegs,
  });

  logActivity({
    type: "order",
    baseUrl: baseUrl || "multiple panels",
    apiKey: apiKey || "(per-leg)",
    link: link || (legs[0] && legs[0].link) || "",
    legCount: orderLegs.length,
    totalQuantity: orderLegs.reduce((a, l) => a + l.quantity, 0),
  });

  saveState();
  res.json({ orderId, scheduled: orderLegs.length });
});

// ==========================================
// GET /orders — every order with computed progress, for the Schedules tab
// ==========================================
app.get("/orders", (req, res) => {
  const now = Date.now();

  const orders = state.orders.map((order) => {
    const totalLegs = order.legs.length;
    const doneLegs = order.legs.filter((l) => l.fired).length;

    const upcoming = order.legs.filter((l) => !l.fired).sort((a, b) => a.fireAt - b.fireAt);
    const nextFireAt = upcoming.length > 0 ? upcoming[0].fireAt : null;

    const byCategory = {};
    order.legs.forEach((l) => {
      byCategory[l.category] = (byCategory[l.category] || 0) + l.quantity;
    });

    return {
      id: order.id,
      name: order.name,
      link: order.link,
      status: order.status,
      createdAt: order.createdAt,
      doneLegs,
      totalLegs,
      nextFireAt,
      byCategory,
    };
  });

  res.json(orders);
});

// ==========================================
// Pause / Resume / Delete an order
// ==========================================
app.post("/orders/:id/pause", (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  order.status = "paused";
  saveState();
  res.json({ ok: true });
});

app.post("/orders/:id/resume", (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  order.status = "active";
  saveState();
  res.json({ ok: true });
});

app.delete("/orders/:id", (req, res) => {
  const before = state.orders.length;
  state.orders = state.orders.filter((o) => o.id !== req.params.id);
  saveState();
  res.json({ deleted: before !== state.orders.length });
});

// ==========================================
// GET /history?link=... — delivered legs for a link, last 7 days (Tracker tab)
// ==========================================
app.get("/history", (req, res) => {
  const link = req.query.link;
  if (!link) return res.status(400).json({ error: "Missing link query param." });

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const entries = state.delivered.filter((d) => d.link === link && d.timestamp >= cutoff);
  res.json(entries);
});

// ==========================================
// GET /delivered-log — every delivered leg, all links, last 7 days (Logs tab)
// ==========================================
app.get("/delivered-log", (req, res) => {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  res.json(state.delivered.filter((d) => d.timestamp >= cutoff));
});

// ==========================================
// GET /activity-log — full connects + orders log, WITH the real API key
// (this endpoint is only ever surfaced behind the client-side Schedules
// password gate — it's the owner's own panel activity, not public)
// ==========================================
app.get("/activity-log", (req, res) => {
  res.json(state.activityLog.slice(0, 150));
});

app.get("/", (req, res) => {
  res.send("KM Panel proxy is running. POST to /proxy with { baseUrl, params }.");
});

// ==========================================
// BACKGROUND SCHEDULER LOOP — only fires legs belonging to ACTIVE orders
// ==========================================
let isProcessingLegs = false;

async function processDueLegs() {
  if (isProcessingLegs) {
    console.log("Previous processDueLegs run still in progress — skipping this tick to avoid double-firing.");
    return;
  }
  isProcessingLegs = true;

  try {
    const now = Date.now();

    for (const order of state.orders) {
      if (order.status !== "active") continue; // paused orders are skipped entirely

      const due = order.legs.filter((l) => !l.fired && l.fireAt <= now);
      if (due.length === 0) continue;

      for (const leg of due) {
        // mark fired FIRST and persist immediately, so even if this exact
        // request is slow, no other tick (or a restart) can pick this leg up again
        leg.fired = true;
        saveState();

        try {
          const data = await callPanel(leg.baseUrl || order.baseUrl, {
            key: leg.apiKey || order.apiKey,
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
        }
        saveState();
      }

      if (order.legs.every((l) => l.fired)) {
        order.status = "completed";
        saveState();
      }
    }

    const historyCutoff = now - SEVEN_DAYS_MS;
    state.delivered = state.delivered.filter((d) => d.timestamp >= historyCutoff);
    saveState();
  } finally {
    isProcessingLegs = false;
  }
}

setInterval(processDueLegs, 15000); // check every 15 seconds

app.listen(PORT, () => {
  console.log(`KM Panel proxy listening on http://localhost:${PORT}`);
  console.log(`Loaded ${state.orders.length} order(s) from disk.`);
  startAutoEngine();
});
