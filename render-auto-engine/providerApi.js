const { getSupabase } = require("./supabaseClient");
const crypto = require("crypto");

// Decrypts a provider's API key. Mirrors Vercel's lib/crypto.js exactly —
// PROVIDER_ENCRYPTION_KEY must be set to the SAME value on both Render and
// Vercel, or Render won't be able to read keys Vercel encrypted (and vice versa).
function decryptSecret(payload) {
  const secret = process.env.PROVIDER_ENCRYPTION_KEY;
  if (!secret) throw new Error("Missing PROVIDER_ENCRYPTION_KEY on Render.");
  const key = crypto.createHash("sha256").update(secret).digest();
  const [ivB64, tagB64, dataB64] = String(payload).split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

async function getDecryptedProvider(providerId) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("api_providers").select("id, api_url, encrypted_api_key, status").eq("id", providerId).maybeSingle();
  if (error || !data) throw new Error("Provider not found.");
  if (data.status !== "active") throw new Error("Provider is disabled.");
  return { id: data.id, apiUrl: data.api_url, apiKey: decryptSecret(data.encrypted_api_key) };
}

async function callPanel(apiUrl, apiKey, params, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ key: apiKey, ...params });
    const res = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: controller.signal });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, retryable: false, error: "Provider returned invalid JSON." };
    }
    if (data && data.error) return { ok: false, retryable: classify(data.error), error: String(data.error) };
    return { ok: true, data };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, retryable: true, error: "Provider timed out." };
    return { ok: false, retryable: true, error: `Network error: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function classify(errorMessage) {
  const msg = String(errorMessage).toLowerCase();
  if (msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("authentication")) return false;
  return true;
}

function classifyKind(errorMessage) {
  const msg = String(errorMessage || "").toLowerCase();
  if (msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("authentication")) return "invalid_key";
  if (msg.includes("rate limit")) return "rate_limited";
  if (msg.includes("insufficient") || msg.includes("balance")) return "insufficient_balance";
  if (msg.includes("active order") || msg.includes("already")) return "duplicate_active_order";
  return "unknown";
}

async function placeOrder(providerId, providerServiceId, link, quantity, extra = {}) {
  const provider = await getDecryptedProvider(providerId);
  const result = await callPanel(provider.apiUrl, provider.apiKey, { action: "add", service: providerServiceId, link, quantity, ...extra });
  if (!result.ok) return { ok: false, retryable: result.retryable, error: result.error, kind: classifyKind(result.error) };
  const orderId = result.data && (result.data.order !== undefined ? String(result.data.order) : null);
  if (!orderId) return { ok: false, retryable: true, error: "Provider did not return an order id.", kind: "unknown" };
  return { ok: true, providerOrderId: orderId };
}

async function checkStatus(providerId, providerOrderId) {
  const provider = await getDecryptedProvider(providerId);
  const result = await callPanel(provider.apiUrl, provider.apiKey, { action: "status", order: providerOrderId });
  if (!result.ok) return { ok: false, retryable: result.retryable, error: result.error };
  return { ok: true, status: mapProviderStatus(result.data && result.data.status), raw: result.data };
}

// Maps whatever a provider calls its statuses into our common set.
function mapProviderStatus(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("progress") || s === "processing") return "processing";
  if (s === "pending" || s === "queued" || s === "waiting" || s === "in queue") return "pending";
  if (s === "completed") return "completed";
  if (s === "partial") return "partial";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  return "failed";
}

async function checkBalance(providerId) {
  const provider = await getDecryptedProvider(providerId);
  return callPanel(provider.apiUrl, provider.apiKey, { action: "balance" });
}

module.exports = { placeOrder, checkStatus, checkBalance, classifyKind };
