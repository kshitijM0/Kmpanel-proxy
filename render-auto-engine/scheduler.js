const { getSupabase } = require("./supabaseClient");
const { log } = require("./logger");
const { createChunksForOrder } = require("./chunkEngine");
const { processDueLegs, pollProcessingLegServices } = require("./legExecutor");

const TICK_INTERVAL_MS = Number(process.env.AUTO_ENGINE_TICK_MS || 15000);

let isTicking = false; // re-entrancy lock — same pattern as the existing Manual Order scheduler

async function tick() {
  if (isTicking) return; // previous tick still running — never overlap
  isTicking = true;
  try {
    const supabase = getSupabase();

    // 1. New orders that haven't been chunked yet.
    const { data: freshOrders } = await supabase.from("orders").select("*").eq("status", "pending").limit(20);
    for (const order of freshOrders || []) {
      await createChunksForOrder(order);
    }

    // 2. Legs whose scheduled time has arrived — place provider orders.
    await processDueLegs();

    // 3. Already-placed orders — poll for completion.
    await pollProcessingLegServices();
  } catch (err) {
    console.error("[auto-engine] tick error:", err);
    await log("scheduler_tick_error", { details: { error: err.message } });
  } finally {
    isTicking = false;
  }
}

// Starts the Auto Engine's own interval loop. Completely separate from the
// existing Manual Order scheduler — does not touch its code or its
// schedule-store.json.
function start() {
  console.log(`[auto-engine] starting, tick every ${TICK_INTERVAL_MS}ms`);
  setInterval(tick, TICK_INTERVAL_MS);
}

module.exports = { start, tick };
