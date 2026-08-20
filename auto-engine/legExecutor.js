const { getSupabase } = require("./supabaseClient");
const { log } = require("./logger");
const providerApi = require("./providerApi");
const providerHealth = require("./providerHealth");
const { hasActiveOrderForSameTarget } = require("./orderProtection");
const { shouldRetry, shouldFailover } = require("./retryEngine");
const { getNextProvider } = require("./failoverEngine");
const { refreshOrderStatus } = require("./orderProgress");

// Finds order_legs whose scheduled_at has arrived and still have pending
// leg_services, then attempts to place each one.
async function processDueLegs() {
  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  const { data: dueLegs } = await supabase
    .from("order_legs")
    .select("id, chunk_id, status, order_chunks(order_id, orders(link))")
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .limit(50);

  if (!dueLegs || !dueLegs.length) return;

  for (const leg of dueLegs) {
    const link = leg.order_chunks && leg.order_chunks.orders && leg.order_chunks.orders.link;
    const orderId = leg.order_chunks && leg.order_chunks.order_id;

    const { data: services } = await supabase.from("leg_services").select("*").eq("leg_id", leg.id).in("status", ["pending"]);

    for (const svc of services || []) {
      await attemptPlaceOrder(svc, link, orderId, leg.id);
    }

    // If every service in this leg is now terminal-or-processing (i.e. no
    // more "pending" awaiting placement), mark the leg started/processing.
    const { data: remainingPending } = await supabase.from("leg_services").select("id").eq("leg_id", leg.id).eq("status", "pending");
    if (!remainingPending || !remainingPending.length) {
      await supabase.from("order_legs").update({ status: "processing", started_at: new Date().toISOString() }).eq("id", leg.id);
    }
  }
}

async function attemptPlaceOrder(svc, link, orderId, legId) {
  const supabase = getSupabase();

  // Duplicate-order protection (global, per Provider+Service+Link).
  const blocked = await hasActiveOrderForSameTarget(svc.provider_id, svc.provider_service_id, link);
  if (blocked) {
    await log("order_blocked_duplicate_target", { orderId, legId, details: { serviceType: svc.service_type, providerId: svc.provider_id } });
    return; // leave pending — tried again next tick
  }

  const healthy = await providerHealth.isHealthy(svc.provider_id);
  if (!healthy) {
    await failoverOrFail(svc, orderId, legId, "provider_offline");
    return;
  }

  // Custom-comments services need the actual comment lines passed alongside
  // the add call. Only present on a Comments leg_service (see legGenerator);
  // every other service leaves `extra` empty so their calls are unchanged.
  const extra = svc.comments ? { comments: svc.comments } : {};
  const result = await providerApi.placeOrder(svc.provider_id, svc.provider_service_id, link, svc.quantity, extra);

  if (result.ok) {
    await supabase.from("leg_services").update({
      status: "processing", provider_order_id: result.providerOrderId, started_at: new Date().toISOString(),
    }).eq("id", svc.id);
    await providerHealth.recordSuccess(svc.provider_id);
    await log("provider_order_placed", { orderId, legId, details: { serviceType: svc.service_type, providerOrderId: result.providerOrderId } });
    return;
  }

  await providerHealth.recordFailure(svc.provider_id, result.kind);
  await log("provider_order_failed", { orderId, legId, details: { serviceType: svc.service_type, error: result.error, kind: result.kind } });
  await failoverOrFail(svc, orderId, legId, result.kind);
}

async function failoverOrFail(svc, orderId, legId, kind) {
  const supabase = getSupabase();

  if (shouldFailover(kind)) {
    const next = await getNextProvider(svc.service_type, svc.provider_id);
    if (next) {
      await supabase.from("leg_services").update({
        provider_id: next.provider_id, provider_service_id: next.provider_service_id, retry_count: svc.retry_count + 1,
      }).eq("id", svc.id);
      await log("failover", { orderId, legId, details: { serviceType: svc.service_type, from: svc.provider_id, to: next.provider_id } });
      return;
    }
    // Pool exhausted — fall through to retry/fail logic below.
  }

  if (shouldRetry(svc.retry_count, kind)) {
    await supabase.from("leg_services").update({ retry_count: svc.retry_count + 1 }).eq("id", svc.id);
    await log("retry_scheduled", { orderId, legId, details: { serviceType: svc.service_type, retryCount: svc.retry_count + 1 } });
    return;
  }

  await supabase.from("leg_services").update({ status: "failed", completed_at: new Date().toISOString() }).eq("id", svc.id);
  await log("leg_service_failed_permanently", { orderId, legId, details: { serviceType: svc.service_type, kind } });
}

// Polls provider status for every leg_service currently "processing".
async function pollProcessingLegServices() {
  const supabase = getSupabase();
  const { data: processing } = await supabase
    .from("leg_services")
    .select("id, leg_id, provider_id, provider_order_id, service_type, order_legs(order_chunks(order_id))")
    .eq("status", "processing")
    .not("provider_order_id", "is", null)
    .limit(100);

  if (!processing || !processing.length) return;

  const touchedOrderIds = new Set();

  for (const svc of processing) {
    const orderId = svc.order_legs && svc.order_legs.order_chunks && svc.order_legs.order_chunks.order_id;
    const result = await providerApi.checkStatus(svc.provider_id, svc.provider_order_id);
    if (!result.ok) continue; // transient — try again next tick

    if (["completed", "partial", "cancelled", "failed"].includes(result.status)) {
      await supabase.from("leg_services").update({ status: result.status, completed_at: new Date().toISOString() }).eq("id", svc.id);
      await log("provider_status_terminal", { orderId, legId: svc.leg_id, details: { serviceType: svc.service_type, status: result.status } });
      if (orderId) touchedOrderIds.add(orderId);
    }
  }

  for (const orderId of touchedOrderIds) {
    await refreshOrderStatus(orderId);
  }
}

module.exports = { processDueLegs, pollProcessingLegServices };
