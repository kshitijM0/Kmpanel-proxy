const { getSupabase } = require("./supabaseClient");
const { log } = require("./logger");
const { deductHold, releaseHold } = require("./walletHold");

const TERMINAL = ["completed", "partial", "cancelled", "failed"];

// Re-evaluates one order's overall status from its legs' current state.
// Safe to call repeatedly (idempotent) — it only acts when the order
// transitions into a new terminal state it hasn't already been resolved for.
async function refreshOrderStatus(orderId) {
  const supabase = getSupabase();

  const { data: order } = await supabase.from("orders").select("id, status, views_quantity, customer_cost").eq("id", orderId).maybeSingle();
  if (!order || ["completed", "partial", "cancelled", "refunded"].includes(order.status)) return; // already resolved

  const { data: chunks } = await supabase.from("order_chunks").select("id, status").eq("order_id", orderId);
  if (!chunks || !chunks.length) return;
  const chunkIds = chunks.map((c) => c.id);

  const { data: legs } = await supabase.from("order_legs").select("id, status").in("chunk_id", chunkIds);
  const legIds = (legs || []).map((l) => l.id);
  if (!legIds.length) return;

  const { data: viewServices } = await supabase.from("leg_services").select("quantity, status").in("leg_id", legIds).eq("service_type", "views");
  if (!viewServices || !viewServices.length) return;

  const allTerminal = viewServices.every((s) => TERMINAL.includes(s.status) || s.status === "completed" || s.status === "partial" || s.status === "cancelled" || s.status === "failed");
  const delivered = viewServices.filter((s) => s.status === "completed" || s.status === "partial").reduce((sum, s) => sum + s.quantity, 0);

  await supabase.from("orders").update({ delivered_views: delivered, updated_at: new Date().toISOString() }).eq("id", orderId);

  if (!allTerminal) return; // still in flight — nothing more to do this pass

  if (delivered <= 0) {
    // Nothing was ever delivered — full refund.
    await supabase.from("orders").update({ status: "cancelled" }).eq("id", orderId);
    await releaseHold(orderId, order.customer_cost, "Order failed on all providers — full refund");
    await log("order_cancelled_full_refund", { orderId });
    return;
  }

  const deliveredRatio = Math.min(1, delivered / order.views_quantity);
  const chargeAmount = Math.round(order.customer_cost * deliveredRatio * 100) / 100;
  const finalStatus = deliveredRatio >= 0.98 ? "completed" : "partial";

  await supabase.from("orders").update({ status: finalStatus }).eq("id", orderId);
  await deductHold(orderId, chargeAmount, `Auto Order ${finalStatus} — ${delivered}/${order.views_quantity} views delivered`);
  await log("order_finalized", { orderId, details: { status: finalStatus, delivered, chargeAmount } });
}

module.exports = { refreshOrderStatus };
