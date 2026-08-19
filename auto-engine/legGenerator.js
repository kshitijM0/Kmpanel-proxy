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

// Creates every leg for a chunk. Views drives the schedule (bell curve +
// organic offsets); every other service type's quantity for that SAME leg
// is derived from Views' quantity × its configured ratio, so everything
// fires together — never independently, never hours apart.
async function generateLegsForChunk(order, chunk) {
  const supabase = getSupabase();

  const { legCount, durationMinutes, variance } = presetFor(order.mode);
  const viewsQuantities = distributeBellCurve(chunk.views_quantity, legCount, variance);
  const scheduledTimes = generateOffsets(legCount, durationMinutes, new Date());

  const { data: ratioRows } = await supabase.from("engagement_ratios").select("service_type, ratio");
  const ratios = Object.fromEntries((ratioRows || []).map((r) => [r.service_type, Number(r.ratio)]));

  const viewsPool = await getActiveMapping("views");
  const pools = { views: viewsPool };
  for (const t of ENGAGEMENT_TYPES) pools[t] = await getActiveMapping(t);

  if (!viewsPool.length) {
    await log("chunk_generation_failed", { orderId: order.id, details: { reason: "no active Views mapping", chunkId: chunk.id } });
    await supabase.from("order_chunks").update({ status: "failed" }).eq("id", chunk.id);
    return;
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

    for (const type of ENGAGEMENT_TYPES) {
      const pool = pools[type];
      if (!pool.length) continue; // not configured — skip this engagement type entirely
      const qty = Math.max(1, Math.round(legViewsQty * (ratios[type] || 0)));
      if (qty <= 0) continue;
      const provider = ROUND_ROBIN_TYPES.includes(type) ? pickFromPool(pool, chunk.chunk_number * 1000 + i) : pool[0];
      legServiceRows.push({
        leg_id: leg.id, service_type: type, quantity: qty,
        provider_id: provider.provider_id, provider_service_id: provider.provider_service_id, status: "pending",
      });
    }

    await supabase.from("leg_services").insert(legServiceRows);
  }

  await log("legs_generated", { orderId: order.id, details: { chunkId: chunk.id, legCount, durationMinutes } });
}

module.exports = { generateLegsForChunk };
