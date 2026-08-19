const { getSupabase } = require("./supabaseClient");
const { log } = require("./logger");
const { generateLegsForChunk } = require("./legGenerator");

const CHUNK_SIZE_DEFAULT = Number(process.env.CHUNK_SIZE_DEFAULT || 100000);

// Splits an order's views_quantity into chunks (customer never sees this —
// it's purely so provider min/max limits and leg-generation stay manageable).
async function createChunksForOrder(order) {
  const supabase = getSupabase();
  const chunkSize = CHUNK_SIZE_DEFAULT;
  const chunkCount = Math.ceil(order.views_quantity / chunkSize);

  let remaining = order.views_quantity;
  const chunkRows = [];
  for (let i = 0; i < chunkCount; i++) {
    const qty = Math.min(chunkSize, remaining);
    remaining -= qty;
    chunkRows.push({ order_id: order.id, chunk_number: i + 1, views_quantity: qty, status: "pending" });
  }

  const { data: chunks, error } = await supabase.from("order_chunks").insert(chunkRows).select("id, chunk_number, views_quantity");
  if (error) {
    await log("chunk_creation_failed", { orderId: order.id, details: { error: error.message } });
    return false;
  }

  await log("chunks_created", { orderId: order.id, details: { count: chunks.length, chunkSize } });

  for (const chunk of chunks) {
    await generateLegsForChunk(order, chunk);
  }

  await supabase.from("orders").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", order.id);
  return true;
}

module.exports = { createChunksForOrder, CHUNK_SIZE_DEFAULT };
