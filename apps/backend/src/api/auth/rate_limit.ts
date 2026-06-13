// Per-IP login rate limiter — defends against credential spraying (many usernames from one source);
// account-level lockout misses this because each username only sees one failure.
//
// Two implementations of {@link LoginRateLimiterPort}:
//   * {@link LoginRateLimiter} — in-process `Map<key, Date[]>` sliding window. Test/dev fallback ONLY:
//     defeated by a multi-replica admin-api and leaks keys for IPs that never retry.
//   * {@link PostgresLoginRateLimiter} (W4.7 / EM5) — PRODUCTION: counter in
//     core.login_rate_limit_failures shared across replicas, stale rows GC'd on every recordFailure,
//     every method FAILS OPEN on a DB error (a limiter outage must not 500 the login route).
//
// Note: no threading.Lock needed — Node's event loop runs each synchronous method to completion without
// preemption, so Map mutations are already atomic.

import { type Kysely, sql } from "kysely";

import type { Clock } from "#platform/clock.js";

/** The limiter seam the auth router consumes (sync for the in-memory adapter, async for Postgres). */
export type LoginRateLimiterPort = {
  /** True if a fresh attempt from `key` may proceed. */
  checkAllowed(key: string): boolean | Promise<boolean>;
  /** Record a failed authentication attempt for `key`. */
  recordFailure(key: string): void | Promise<void>;
  /** Clear all failure history for `key` (legitimate auth). */
  recordSuccess(key: string): void | Promise<void>;
};

export type LoginRateLimiterOptions = {
  maxAttempts: number;
  /** Sliding-window width in ms. */
  windowMs: number;
  /** Cooldown horizon in ms (kept for prune-horizon parity with the Python's `lockout` arg). */
  lockoutMs: number;
  clock: Clock;
}

/** Per-key sliding-window failure counter with cooldown (in-process; see the module header). */
export class LoginRateLimiter implements LoginRateLimiterPort {
  readonly #maxAttempts: number;
  readonly #windowMs: number;
  readonly #lockoutMs: number;
  readonly #clock: Clock;
  readonly #failures = new Map<string, Array<Date>>();

  public constructor(opts: LoginRateLimiterOptions) {
    if (opts.maxAttempts < 1) {
      throw new Error("max_attempts must be >= 1");
    }
    if (opts.windowMs <= 0) {
      throw new Error("window must be positive");
    }
    if (opts.lockoutMs <= 0) {
      throw new Error("lockout must be positive");
    }
    this.#maxAttempts = opts.maxAttempts;
    this.#windowMs = opts.windowMs;
    this.#lockoutMs = opts.lockoutMs;
    this.#clock = opts.clock;
  }

  /** True if a fresh attempt from `key` may proceed. */
  public checkAllowed(key: string): boolean {
    this.#prune(key);
    const count = this.#failures.get(key)?.length ?? 0;
    return count < this.#maxAttempts;
  }

  /** Record a failed authentication attempt for `key`. */
  public recordFailure(key: string): void {
    const bucket = this.#failures.get(key) ?? [];
    bucket.push(this.#clock.now());
    this.#failures.set(key, bucket);
    this.#prune(key);
  }

  /** Clear all failure history for `key` (legitimate auth). */
  public recordSuccess(key: string): void {
    this.#failures.delete(key);
  }

  /** Drop failures outside the relevant horizon (= max(window, lockout)); a failure ages out only when it
   *  can no longer count toward either the sliding-window threshold or an active cooldown. */
  #prune(key: string): void {
    const bucket = this.#failures.get(key);
    if (bucket === undefined || bucket.length === 0) {
      return;
    }
    const horizon = Math.max(this.#windowMs, this.#lockoutMs);
    const cutoff = this.#clock.now().getTime() - horizon;
    const kept = bucket.filter((ts) => ts.getTime() > cutoff);
    if (kept.length > 0) {
      this.#failures.set(key, kept);
    } else {
      this.#failures.delete(key);
    }
  }
}

// ─── Postgres limiter (W4.7 / EM5) ────────────────────────────────────────────────────────────────

export type PostgresLoginRateLimiterOptions = LoginRateLimiterOptions & {
  /** The core pool (core.login_rate_limit_failures lives beside core.local_users). */
  db: Kysely<unknown>;
};

/** Cross-replica sliding-window failure counter over core.login_rate_limit_failures (migration 0045).
 *  Same window/horizon semantics as the in-memory limiter; every method fails OPEN on a DB error. */
export class PostgresLoginRateLimiter implements LoginRateLimiterPort {
  readonly #db: Kysely<unknown>;
  readonly #maxAttempts: number;
  readonly #horizonMs: number;
  readonly #clock: Clock;

  public constructor(opts: PostgresLoginRateLimiterOptions) {
    if (opts.maxAttempts < 1) {
      throw new Error("max_attempts must be >= 1");
    }
    if (opts.windowMs <= 0) {
      throw new Error("window must be positive");
    }
    if (opts.lockoutMs <= 0) {
      throw new Error("lockout must be positive");
    }
    this.#db = opts.db;
    this.#maxAttempts = opts.maxAttempts;
    // The in-memory limiter counts every failure inside max(window, lockout) — a failure counts as
    // long as it can feed either the sliding-window threshold or an active cooldown. Same horizon.
    this.#horizonMs = Math.max(opts.windowMs, opts.lockoutMs);
    this.#clock = opts.clock;
  }

  #cutoff(): Date {
    return new Date(this.#clock.now().getTime() - this.#horizonMs);
  }

  #warnFailOpen(op: string, exc: unknown): void {
    console.warn(
      JSON.stringify({
        event: "login_rate_limiter_db_error",
        op,
        fail_open: true,
        error_class: exc instanceof Error ? exc.constructor.name : typeof exc,
      }),
    );
  }

  public async checkAllowed(key: string): Promise<boolean> {
    try {
      const r = await sql<{ n: string | number }>`
        SELECT COUNT(*) AS n FROM core.login_rate_limit_failures
        WHERE rl_key = ${key} AND failed_at > ${this.#cutoff()}
      `.execute(this.#db);
      return Number(r.rows[0]?.n ?? 0) < this.#maxAttempts;
    } catch (exc) {
      this.#warnFailOpen("checkAllowed", exc);
      return true;
    }
  }

  public async recordFailure(key: string): Promise<void> {
    try {
      await sql`
        INSERT INTO core.login_rate_limit_failures (rl_key, failed_at)
        VALUES (${key}, ${this.#clock.now()})
      `.execute(this.#db);
      // Opportunistic GLOBAL GC: failed logins are themselves rate-limited, so this stays cheap, and
      // it bounds the table for keys that never retry (the in-memory limiter's leak class).
      await sql`
        DELETE FROM core.login_rate_limit_failures WHERE failed_at <= ${this.#cutoff()}
      `.execute(this.#db);
    } catch (exc) {
      this.#warnFailOpen("recordFailure", exc);
    }
  }

  public async recordSuccess(key: string): Promise<void> {
    try {
      await sql`
        DELETE FROM core.login_rate_limit_failures WHERE rl_key = ${key}
      `.execute(this.#db);
    } catch (exc) {
      this.#warnFailOpen("recordSuccess", exc);
    }
  }
}
