// ==========================================
// KM Panel — API Proxy Server
// ==========================================
// Why this exists: most SMM panel APIs block direct browser calls
// (CORS). This tiny server sits in between — the browser talks to
// THIS server, and this server talks to the real panel. Since the
// call from here to the panel is server-to-server, CORS doesn't apply.
//
// Run locally:   npm install   then   npm start
// Deploy free:   push this folder to Render.com or Railway.app as a
//                Node web service, then point the panel's "Proxy URL"
//                field at the deployed address instead of localhost.

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors()); // allow the panel (running from any origin) to call this server
app.use(express.json());

const PORT = process.env.PORT || 3001;

// POST /proxy
// body: { baseUrl: "https://panel.example.com/api/v2", params: { key, action, ... } }
app.post("/proxy", async (req, res) => {
  const { baseUrl, params } = req.body || {};

  if (!baseUrl || !params) {
    return res.status(400).json({ error: "Missing baseUrl or params in request body." });
  }

  try {
    const body = new URLSearchParams(params);

    const panelResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await panelResponse.text();

    // Try to parse as JSON; if the panel returned something else, pass the raw text back.
    try {
      const json = JSON.parse(text);
      res.json(json);
    } catch {
      res.status(502).json({ error: "Panel did not return JSON.", raw: text.slice(0, 500) });
    }
  } catch (err) {
    res.status(502).json({ error: `Could not reach the panel: ${err.message}` });
  }
});

app.get("/", (req, res) => {
  res.send("KM Panel proxy is running. POST to /proxy with { baseUrl, params }.");
});

app.listen(PORT, () => {
  console.log(`KM Panel proxy listening on http://localhost:${PORT}`);
});
