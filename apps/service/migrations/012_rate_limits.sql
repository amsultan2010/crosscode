-- Durable rate-limit counters.
--
-- The in-process FixedWindowRateLimiter is correct in a persistent deployment, where one
-- process is the whole service. On a function platform every instance starts cold and
-- shares nothing, so an in-memory counter silently becomes "N x the limit" for N warm
-- instances. For courtesy limits that is a degradation; for POST /v1/pairing-codes/claim
-- it is a security regression, because that per-IP throttle is the only thing standing
-- between an attacker and brute-forcing a 40-bit code space.
--
-- So limits whose job is defence live here, shared across instances. Limits whose job is
-- politeness stay in memory rather than paying a database round-trip on every request.

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0)
);

-- Lets the sweep find expired rows without scanning the whole table.
CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx ON rate_limits (window_start);

-- Service-internal bookkeeping: no member ever selects from this. RLS on with no policy
-- denies every non-service role by default, which is exactly the intent.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
