const { getSupabase } = require("./supabaseClient");

const ACTIVE_STATUSES = ["pending", "processing"];

// True if there's already an in-flight leg_service for this exact
// provider + provider_service_id + link (checked globally, across all
// orders/customers — this mirrors what the provider itself enforces).
async function hasActiveOrderForSameTarget(providerId, providerServiceId, link) {
  const supabase = getSupabase();

  const { data: candidateOrders } = await supabase.from("orders").select("id").eq("link", link);
  if (!candidateOrders || !candidateOrders.length) return false;
  const orderIds = candidateOrders.map((o) => o.id);

  const { data: chunks } = await supabase.from("order_chunks").select("id").in("order_id", orderIds);
  if (!chunks || !chunks.length) return false;
  const chunkIds = chunks.map((c) => c.id);

  const { data: legs } = await supabase.from("order_legs").select("id").in("chunk_id", chunkIds);
  if (!legs || !legs.length) return false;
  const legIds = legs.map((l) => l.id);

  const { data: active } = await supabase
    .from("leg_services")
    .select("id")
    .in("leg_id", legIds)
    .eq("provider_id", providerId)
    .eq("provider_service_id", providerServiceId)
    .in("status", ACTIVE_STATUSES)
    .limit(1);

  return !!(active && active.length);
}

module.exports = { hasActiveOrderForSameTarget };
