# KM Panel — API Proxy

Most SMM panel APIs (including most that behave like YoYo Media) block
direct calls from a browser (CORS). This tiny server sits in between —
your browser talks to this server, and this server talks to the real
panel. Server-to-server calls aren't subject to CORS, so this fixes it.

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
4. In the KM Panel website's **API** tab, leave the **Proxy server URL**
   field as `http://localhost:3001/proxy` (it's already the default),
   fill in your real panel URL + API key, and click **Connect**.

This only works while the terminal running `npm start` stays open.

## Deploy it for free (so it works even when your laptop is off)

1. Push this `proxy-server` folder to a GitHub repo.
2. Create a free account on [Render.com](https://render.com) or
   [Railway.app](https://railway.app).
3. Create a new **Web Service** pointing at that repo, with:
   - Build command: `npm install`
   - Start command: `npm start`
4. Once deployed, you'll get a URL like `https://your-app.onrender.com`.
5. In the KM Panel **Proxy server URL** field, use
   `https://your-app.onrender.com/proxy` instead of localhost.

## Tested

This proxy was tested end-to-end against a mock panel API — balance
fetch, services fetch, and order placement all confirmed working
through it before being handed over.
