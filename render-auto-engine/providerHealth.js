const { getSupabase } = require("./supabaseClient");

const FAILURE_THRESHOLD = 3; // consecutive failures before marking offline

async function recordSuccess(providerId) {
  const supabase = getSupabase();
  await supabase.from("provider_health").upsert(
    { provider_id: providerId, status: "online", consecutive_failures: 0, last_checked: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "provider_id" }
  );
}

async function recordFailure(providerId, classification) {
  const supabase = getSupabase();
  const { data: existing } = await supabase.from("provider_health").select("consecutive_failures").eq("provider_id", providerId).maybeSingle();
  const failures = (existing ? existing.consecutive_failures : 0) + 1;

  let status = "online";
  if (classification === "invalid_key") status = "invalid_api";
  else if (classification === "rate_limited") status = "rate_limited";
  else if (failures >= FAILURE_THRESHOLD) status = "offline";

  await supabase.from("provider_health").upsert(
    { provider_id: providerId, status, consecutive_failures: failures, last_checked: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "provider_id" }
  );
}

async function isHealthy(providerId) {
  const supabase = getSupabase();
  const { data } = await supabase.from("provider_health").select("status").eq("provider_id", providerId).maybeSingle();
  if (!data) return true; // never tried yet — assume healthy, let it prove otherwise
  return data.status === "online";
}

module.exports = { recordSuccess, recordFailure, isHealthy };
