const MAX_RETRY_COUNT = Number(process.env.MAX_RETRY_COUNT || 3);

// Only these kinds are worth retrying at all. Invalid API keys, for
// example, will never succeed on retry — that provider needs a failover
// (or admin attention), not a retry loop.
const RETRYABLE_KINDS = new Set(["unknown", "duplicate_active_order"]);
const FAILOVER_KINDS = new Set(["invalid_key", "insufficient_balance", "rate_limited"]);

function shouldRetry(retryCount, kind) {
  if (retryCount >= MAX_RETRY_COUNT) return false;
  return RETRYABLE_KINDS.has(kind) || kind === "unknown";
}

function shouldFailover(kind) {
  return FAILOVER_KINDS.has(kind);
}

module.exports = { MAX_RETRY_COUNT, shouldRetry, shouldFailover };
