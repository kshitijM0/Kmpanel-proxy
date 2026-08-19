const { getSupabase } = require("./supabaseClient");

async function log(eventType, { orderId = null, legId = null, details = {} } = {}) {
  try {
    await getSupabase().from("engine_logs").insert({
      order_id: orderId,
      leg_id: legId,
      event_type: eventType,
      details,
    });
  } catch (err) {
    // Logging must never crash the engine.
    console.error("[auto-engine] log failed:", err.message);
  }
}

module.exports = { log };
