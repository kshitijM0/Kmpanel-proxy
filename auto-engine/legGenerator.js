const { getSupabase } = require("./supabaseClient");
const { log } = require("./logger");
const { distributeBellCurve } = require("./bellCurve");
const { generateOffsets, presetFor } = require("./offsets");

const ENGAGEMENT_TYPES = ["likes", "shares", "saves", "reposts", "comments"];
const ROUND_ROBIN_TYPES = ["views", "likes"];

async function getActiveMapping(serviceType) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("service_mapping")
    .select("provider_id, provider_service_id")
    .eq("service_type", serviceType)
    .eq("active", true)
    .order("display_order", { ascending: true });
  return data || [];
}

function pickFromPool(pool, index) {
  if (!pool.length) return null;
  return pool[index % pool.length];
}

function isEnabled(order, type) {
  if (!order.enabled_services) return true;
  return order.enabled_services[type] !== false;
}

// Creates every leg for a chunk. Views drives the schedule (bell curve +
// organic offsets). Every OTHER enabled service type's TOTAL for this order
// was already decided once, authoritatively, at order-creation time
// (order.target_quantities) — this function only DISTRIBUTES that fixed
// total across legs (proportional to this chunk's share, then bell-curved
// across the chunk's legs). It never invents a new random total — that
// would let delivery drift away from what was billed.
async function generateLegsForChunk(order, chunk) {
  const supabase = getSupabase();

  const { legCount, durationMinutes, variance } = presetFor(order.mode);
  const viewsQuantities = distributeBellCurve(chunk.views_quantity, legCount, variance);
  const scheduledTimes = generateOffsets(legCount, durationMinutes, new Date());

  const activeEngagementTypes = ENGAGEMENT_TYPES.filter((t) => isEnabled(order, t));

  const viewsPool = await getActiveMapping("views");
  const pools = { views: viewsPool };
  for (const t of activeEngagementTypes) pools[t] = await getActiveMapping(t);

  if (!viewsPool.length) {
    await log("chunk_generation_failed", { orderId: order.id, details: { reason: "no active Views mapping", chunkId: chunk.id } });
    await supabase.from("order_chunks").update({ status: "failed" }).eq("id", chunk.id);
    return;
  }

  // This chunk's share of each engagement type's ORDER-WIDE authoritative
  // total, then bell-curved across this chunk's legs (reusing the exact
  // same distribution function used for Views — one source of truth).
  const perLegEngagementQty = {};
  const targets = order.target_quantities || {};
  for (const type of activeEngagementTypes) {
    if (!pools[type] || !pools[type].length) continue; // not configured — skip entirely
    const orderTotal = targets[type];
    if (!orderTotal) continue;
    const chunkShare = Math.max(1, Math.round(orderTotal * (chunk.views_quantity / order.views_quantity)));
    perLegEngagementQty[type] = distributeBellCurve(chunkShare, legCount, variance);
  }

  for (let i = 0; i < legCount; i++) {
    const legViewsQty = viewsQuantities[i];
    if (legViewsQty <= 0) continue;

    const { data: leg, error: legError } = await supabase
      .from("order_legs")
      .insert({ chunk_id: chunk.id, leg_number: i + 1, scheduled_at: scheduledTimes[i].toISOString(), status: "pending" })
      .select("id")
      .single();
    if (legError) continue;

    const legServiceRows = [];

    const viewsProvider = pickFromPool(pools.views, chunk.chunk_number * 1000 + i);
    legServiceRows.push({
      leg_id: leg.id, service_type: "views", quantity: legViewsQty,
      provider_id: viewsProvider.provider_id, provider_service_id: viewsProvider.provider_service_id, status: "pending",
    });

    for (const type of activeEngagementTypes) {
      if (!perLegEngagementQty[type]) continue;
      const qty = perLegEngagementQty[type][i];
      if (!qty || qty <= 0) continue;
      const provider = ROUND_ROBIN_TYPES.includes(type) ? pickFromPool(pools[type], chunk.chunk_number * 1000 + i) : pools[type][0];
      legServiceRows.push({
        leg_id: leg.id, service_type: type, quantity: qty,
        provider_id: provider.provider_id, provider_service_id: provider.provider_service_id, status: "pending",
      });
    }

    await supabase.from("leg_services").insert(legServiceRows);
  }

  await log("legs_generated", { orderId: order.id, details: { chunkId: chunk.id, legCount, durationMinutes, targets, enabledServices: activeEngagementTypes } });
}

module.exports = { generateLegsForChunk };
