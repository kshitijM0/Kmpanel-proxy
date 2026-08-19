const { getSupabase } = require("./supabaseClient");
const { log } = require("./logger");

async function deductHold(orderId, amount, description = "Auto Order charge") {
  const supabase = getSupabase();
  const { data: hold } = await supabase.from("wallet_holds").select("id, device_id, amount, status").eq("order_id", orderId).eq("status", "held").maybeSingle();
  if (!hold) return;

  const deductAmount = amount !== undefined ? amount : hold.amount;
  await supabase.rpc("adjust_device_wallet_balance", { p_device_id: hold.device_id, p_delta: -deductAmount });
  await supabase.from("wallet_holds").update({ status: "deducted", resolved_at: new Date().toISOString() }).eq("id", hold.id);
  await supabase.from("wallet_transactions").insert({
    device_id: hold.device_id,
    type: "auto_order_charge",
    amount: -deductAmount,
    description,
    status: "completed",
    completed_at: new Date().toISOString(),
  });

  // Partial delivery: release whatever wasn't actually charged.
  const remainder = hold.amount - deductAmount;
  if (remainder > 0.009) {
    await releaseHold(orderId, remainder, "Partial refund — undelivered portion", true);
  }

  await log("wallet_hold_deducted", { orderId, details: { amount: deductAmount } });
}

async function releaseHold(orderId, amount, description = "Order refunded — hold released", skipHoldRowUpdate = false) {
  const supabase = getSupabase();

  if (!skipHoldRowUpdate) {
    const { data: hold } = await supabase.from("wallet_holds").select("id, device_id, amount, status").eq("order_id", orderId).eq("status", "held").maybeSingle();
    if (!hold) return;
    await supabase.rpc("adjust_device_wallet_balance", { p_device_id: hold.device_id, p_delta: hold.amount });
    await supabase.from("wallet_holds").update({ status: "released", resolved_at: new Date().toISOString() }).eq("id", hold.id);
    await supabase.from("wallet_transactions").insert({
      device_id: hold.device_id,
      type: "refund",
      amount: hold.amount,
      description,
      status: "completed",
      completed_at: new Date().toISOString(),
    });
  } else {
    // Called from deductHold for a partial remainder — device_id already known there.
    const { data: order } = await supabase.from("orders").select("device_id").eq("id", orderId).maybeSingle();
    if (!order) return;
    await supabase.rpc("adjust_device_wallet_balance", { p_device_id: order.device_id, p_delta: amount });
    await supabase.from("wallet_transactions").insert({
      device_id: order.device_id,
      type: "refund",
      amount,
      description,
      status: "completed",
      completed_at: new Date().toISOString(),
    });
  }

  await log("wallet_hold_released", { orderId, details: { amount } });
}

module.exports = { deductHold, releaseHold };
