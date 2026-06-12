-- 0045_login_rate_limit.sql — W4.7 (master-hardening-plan, audit EM5): Postgres-backed login
-- rate-limit counter.
--
-- The login rate limiter was an in-process Map (rate_limit.py parity): defeated by a multi-replica
-- admin-api (each pod sees < threshold, so a distributed credential spray never trips it) and an
-- unbounded per-IP key leak. The counter moves to a shared table: one append per failed attempt,
-- keyed on the TRUSTED client IP (derived from the configured proxy hop count, never the spoofable
-- leftmost X-Forwarded-For). PostgresLoginRateLimiter (api/auth/rate_limit.ts) counts rows inside
-- the sliding window and prunes everything older than max(window, lockout) opportunistically on
-- each recordFailure — bounded growth by construction, no janitor required.
--
-- NOT tenant-scoped by design: rows key on client IP at the pre-auth edge (no installation exists
-- yet); the table never stores credentials, usernames, or session material.

CREATE TABLE core.login_rate_limit_failures (
    failure_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rl_key text NOT NULL,
    failed_at timestamptz NOT NULL
);

COMMENT ON TABLE core.login_rate_limit_failures IS
    'W4.7/EM5 — sliding-window login-failure counter shared across admin-api replicas. One row per failed attempt keyed on the trusted client IP; pruned opportunistically past max(window, lockout).';

-- The hot path is COUNT(*) WHERE rl_key = $1 AND failed_at > $2 — an index-only range scan.
CREATE INDEX ix_login_rate_limit_failures_key_time
    ON core.login_rate_limit_failures (rl_key, failed_at DESC);
