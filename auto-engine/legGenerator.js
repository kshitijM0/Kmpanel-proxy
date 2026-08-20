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

// Reads the per-service ON/OFF plan the Vercel API froze onto the order at
// creation time (`orders.service_selection`). Returns null for legacy orders
// that predate the field, so those keep their original behavior untouched.
function readSelection(order) {
  const sel = order && order.service_selection;
  if (sel && typeof sel === "object" && !Array.isArray(sel)) return sel;
  return null; // legacy / older order → fall back to ratio-driven behavior
}

// Effective per-leg ratio for a NON-comments engagement type.
//   • New order (has service_selection): ratio = selected total qty ÷ order views.
//     Because the API stored qty = views × ratio × (1 ± variation), delivery now
//     sums back to EXACTLY the quantity the customer was billed for — natural
//     variation preserved, billing never drifts.
//   • Legacy order (no service_selection): the previously-configured ratio.
// Returns null when the type must NOT be built at all (disabled → absent).
function effectiveRatio(type, sel, ratios, orderViews) {
  if (sel) {
    if (!sel[type]) return null; // OFF / absent → no leg, no provider, no billing
    const q = Number(sel[type].quantity);
    if (!(q > 0) || !(orderViews > 0)) return null;
    return q / orderViews;
  }
  return ratios[type] != null ? ratios[type] : 0; // legacy behavior
}

// Creates every leg for a chunk. Views drives the schedule (bell curve +
// organic offsets); every other service type's quantity for that SAME leg
// is derived from Views' quantity × its effective ratio, so everything
// fires together — never independently, never hours apart.
async function generateLegsForChunk(order, chunk) {
  const supabase = getSupabase();

  const sel = readSelection(order);
  const orderViews = Number(order.views_quantity);

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

  // Which engagement types get spread across the bell-curve legs. Comments is
  // NEVER spread — for new orders it is a custom-text leg handled once below
  // (splitting it would fragment the customer's comment lines). For legacy
  // orders comments stays ratio-driven exactly as before.
  const perLegTypes = sel
    ? ENGAGEMENT_TYPES.filter((t) => t !== "comments" && sel[t]) // only ENABLED types
    : ENGAGEMENT_TYPES; // legacy: every configured type, comments included

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

    for (const type of perLegTypes) {
      const pool = pools[type];
      if (!pool.length) continue; // not configured — skip this engagement type entirely
      const ratio = effectiveRatio(type, sel, ratios, orderViews);
      if (ratio == null) continue; // disabled/absent → no leg, no provider, no billing
      const qty = Math.max(1, Math.round(legViewsQty * ratio));
      if (qty <= 0) continue;
      const provider = ROUND_ROBIN_TYPES.includes(type) ? pickFromPool(pool, chunk.chunk_number * 1000 + i) : pool[0];
      legServiceRows.push({
        leg_id: leg.id, service_type: type, quantity: qty,
        provider_id: provider.provider_id, provider_service_id: provider.provider_service_id, status: "pending",
      });
    }

    await supabase.from("leg_services").insert(legServiceRows);
  }

  // ----- Custom Comments (new orders only) -----
  // Delivered as ONE dedicated leg for the whole order so the exact comment
  // lines stay intact. Built only on the first chunk to avoid delivering the
  // same comments once per chunk. Absent/disabled comments → nothing here.
  if (sel && sel.comments && chunk.chunk_number === 1) {
    const commentsPool = pools.comments;
    const lineCount = Number(sel.comments.quantity);
    const text = typeof order.custom_comments === "string" ? order.custom_comments.trim() : "";
    if (commentsPool.length && lineCount > 0 && text) {
      const { data: cLeg, error: cErr } = await supabase
        .from("order_legs")
        .insert({ chunk_id: chunk.id, leg_number: legCount + 1, scheduled_at: scheduledTimes[0].toISOString(), status: "pending" })
        .select("id")
        .single();
      if (!cErr && cLeg) {
        const provider = commentsPool[0];
        await supabase.from("leg_services").insert([{
          leg_id: cLeg.id, service_type: "comments", quantity: lineCount,
          provider_id: provider.provider_id, provider_service_id: provider.provider_service_id,
          comments: text, status: "pending",
        }]);
      }
    } else if (!commentsPool.length) {
      await log("comments_skipped_no_provider", { orderId: order.id, details: { chunkId: chunk.id } });
    }
  }

  await log("legs_generated", { orderId: order.id, details: { chunkId: chunk.id, legCount, durationMinutes, mode: sel ? "per-service" : "legacy" } });
}

module.exports = { generateLegsForChunk };
