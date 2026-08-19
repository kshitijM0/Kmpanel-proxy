const { getSupabase } = require("./supabaseClient");

// Returns the next active, healthy provider mapping for this service_type,
// excluding the one that just failed. Respects the admin's configured
// priority order (display_order).
async function getNextProvider(serviceType, excludeProviderId) {
  const supabase = getSupabase();
  const { data: pool } = await supabase
    .from("service_mapping")
    .select("provider_id, provider_service_id, api_providers(status)")
    .eq("service_type", serviceType)
    .eq("active", true)
    .order("display_order", { ascending: true });

  if (!pool || !pool.length) return null;

  const { data: health } = await supabase.from("provider_health").select("provider_id, status");
  const offlineSet = new Set((health || []).filter((h) => h.status !== "online").map((h) => h.provider_id));

  for (const entry of pool) {
    if (entry.provider_id === excludeProviderId) continue;
    if (entry.api_providers && entry.api_providers.status !== "active") continue;
    if (offlineSet.has(entry.provider_id)) continue;
    return { provider_id: entry.provider_id, provider_service_id: entry.provider_service_id };
  }
  return null; // every mapped provider for this type is exhausted
}

module.exports = { getNextProvider };
