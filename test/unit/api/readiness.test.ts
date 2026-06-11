// test/unit/api/readiness.test.ts
//
// CS3.2 (cutover-safety plan, finding CS3 — audit C5/H7/XH11/RT2): /readyz aggregates the REAL
// dependency checks (Postgres + Vault + the CS3.1 loop-health registry) and the two K8s probes get
// their CORRECT, NON-INTERCHANGEABLE semantics. Pre-CS3.2: server.ts called buildApp() with NO
// checks, so /readyz was PERMANENTLY ready (a pod with a dead DB / dead Vault / crashed required
// loop kept receiving traffic forever and self-healing structurally could not trigger — C5); and
// /healthz keyed its dependency snapshot into the response while a THROWN check 500'd it, the
// restart-storm shape (a transient downstream outage must NEVER restart every pod in lockstep).
//
// Proves the owner-directed split:
//   READINESS (/readyz) — fails (503 + the failed name) when ANY of {Postgres, Vault, a required
//   runtime loop} is down, so Kubernetes stops routing to the pod and a rollout replaces a
//   persistently-degraded one; recovers (200) when the dependency does.
//   LIVENESS (/healthz) — 200 with an INFORMATIONAL dependency snapshot EVEN WHEN dependencies are
//   down or their checks THROW (no restart storms); 503 ONLY when the explicit process-WEDGE
//   signal trips (the process cannot make progress after internal recovery).
//
// Also proves the api/dependency_checks.ts factories main.ts wires:
//   makePostgresCheck (cheap SELECT 1 over the shared ADR-0062 pool), makeVaultCheck (the
//   unauthenticated GET /v1/sys/health probe over the bounded-timeout VaultHttpClient), and
//   makeRuntimeLoopsCheck (the CS3.1 LoopHealthRegistry → 'runtime-loops' readiness dependency).
//
// Pure unit — Fastify's in-process inject() (no socket), fake pools/transports, the REAL
// LoopHealthRegistry, FakeClock for latency instants. No DB, no network.

import { describe, expect, it } from "vitest";

import { buildApp, type HealthCheck } from "#backend/api/app.js";
import {
  makePostgresCheck,
  makeRuntimeLoopsCheck,
  makeVaultCheck,
} from "#backend/api/dependency_checks.js";
import type { VaultHttpRequestArgs } from "#backend/adapters/vault_http.js";
import { LoopHealthRegistry } from "#backend/runner/loop_health.js";
import { FakeClock } from "#platform/clock.js";

const okCheck: HealthCheck = async () => ({ status: "ok", latency_ms: 1, error: null });
const downCheck =
  (error: string): HealthCheck =>
  async () => ({ status: "down", latency_ms: null, error });

/** A LoopHealthRegistry with the postgres-mode supervised set registered (all initially up). */
function registryWithLoops(clock: FakeClock): LoopHealthRegistry {
  const loopHealth = new LoopHealthRegistry({ clock });
  for (const loop of ["runner", "scheduler", "outbox", "review"]) {
    loopHealth.register(loop);
  }
  return loopHealth;
}

describe("/readyz — readiness fails on ANY down dependency (CS3.2)", () => {
  it("503 + the failed name when the POSTGRES check fails (vault + loops stay un-blamed)", async () => {
    const clock = new FakeClock();
    const app = buildApp({
      postgresCheck: downCheck("conn refused"),
      vaultCheck: okCheck,
      dependencyChecks: [makeRuntimeLoopsCheck({ loopHealth: registryWithLoops(clock) })],
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.reason).toContain("postgres: conn refused");
    expect(body.reason).not.toContain("vault");
    expect(body.reason).not.toContain("runtime-loops");
    await app.close();
  });

  it("503 + 'vault' when the VAULT check fails — vaultCheck NOW aggregates into readiness (pre-CS3.2 it was snapshot-only and a dead Vault never failed /readyz)", async () => {
    const app = buildApp({
      postgresCheck: okCheck,
      vaultCheck: downCheck("sealed"),
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toContain("vault: sealed");
    await app.close();
  });

  it("503 + 'runtime-loops' naming the DOWN loop when a required loop crashed; recovers to 200 on markUp", async () => {
    const clock = new FakeClock();
    const loopHealth = registryWithLoops(clock);
    const app = buildApp({
      postgresCheck: okCheck,
      vaultCheck: okCheck,
      dependencyChecks: [makeRuntimeLoopsCheck({ loopHealth })],
    });

    loopHealth.markDown("outbox", new Error("claim pass exploded"));
    const down = await app.inject({ method: "GET", url: "/readyz" });
    expect(down.statusCode).toBe(503);
    const body = down.json();
    expect(body.ready).toBe(false);
    expect(body.reason).toContain("runtime-loops");
    expect(body.reason).toContain("outbox");
    expect(body.reason).toContain("claim pass exploded");

    // The pod is allowed to recover internally and flip back to Ready — no crash loop.
    loopHealth.markUp("outbox");
    const up = await app.inject({ method: "GET", url: "/readyz" });
    expect(up.statusCode).toBe(200);
    expect(up.json().ready).toBe(true);
    await app.close();
  });

  it("200 ready when Postgres + Vault + every required loop are up", async () => {
    const clock = new FakeClock();
    const app = buildApp({
      postgresCheck: okCheck,
      vaultCheck: okCheck,
      dependencyChecks: [makeRuntimeLoopsCheck({ loopHealth: registryWithLoops(clock) })],
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ schema_version: 1, ready: true, reason: null });
    await app.close();
  });
});

describe("/healthz — liveness is wedge-only; NEVER fails on a dependency (CS3.2)", () => {
  it("200 EVEN WHEN the DB check is down AND the Vault check THROWS — the snapshot is informational (no restart storms during a downstream outage)", async () => {
    const app = buildApp({
      postgresCheck: downCheck("conn refused"),
      vaultCheck: async () => {
        throw new Error("vault transport exploded");
      },
      dependencyChecks: [
        { name: "runtime-loops", check: downCheck("outbox loop dead") }, // readiness-only concern
      ],
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200); // liveness MUST NOT fail on dependency issues
    const body = res.json();
    expect(body.wedged).toBe(false);
    expect(body.postgres.status).toBe("down"); // the snapshot still TELLS the truth…
    expect(body.vault.status).toBe("down"); // …and a THROWN check is normalized, never a 500
    expect(body.vault.error).toContain("vault transport exploded");
    await app.close();
  });

  it("503 ONLY when the explicit wedge signal trips; recovers to 200 when it clears", async () => {
    let wedgeReason: string | null = null;
    const app = buildApp({
      postgresCheck: okCheck, // all dependencies healthy — the wedge alone decides liveness
      vaultCheck: okCheck,
      wedgeCheck: () => wedgeReason,
    });

    const alive = await app.inject({ method: "GET", url: "/healthz" });
    expect(alive.statusCode).toBe(200);
    expect(alive.json().wedged).toBe(false);

    wedgeReason = "supervisor cannot schedule ticks";
    const wedged = await app.inject({ method: "GET", url: "/healthz" });
    expect(wedged.statusCode).toBe(503);
    const body = wedged.json();
    expect(body.wedged).toBe(true);
    expect(body.reason).toBe("supervisor cannot schedule ticks");

    wedgeReason = null;
    const recovered = await app.inject({ method: "GET", url: "/healthz" });
    expect(recovered.statusCode).toBe(200);
    await app.close();
  });

  it("no-restart-storm regression: a transient DB blip flips /readyz but NEVER /healthz", async () => {
    let dbUp = true;
    const flappingDb: HealthCheck = async () =>
      dbUp
        ? { status: "ok", latency_ms: 1, error: null }
        : { status: "down", latency_ms: null, error: "transient blip" };
    const app = buildApp({ postgresCheck: flappingDb });

    dbUp = false; // the blip
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);

    dbUp = true; // recovery
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });
});

describe("dependency_checks factories — what main.ts wires (CS3.2)", () => {
  it("makePostgresCheck: SELECT 1 resolves → ok with clock-seam latency; rejects → down with the error", async () => {
    const clock = new FakeClock();
    const good = makePostgresCheck({
      pool: {
        query: async (queryText: string) => {
          expect(queryText).toBe("SELECT 1");
          clock.advance({ seconds: 0.005 }); // 5ms of "query time" on the monotonic axis
          return {};
        },
      },
      clock,
    });
    expect(await good()).toEqual({ status: "ok", latency_ms: 5, error: null });

    const bad = makePostgresCheck({
      pool: {
        query: async () => {
          throw new Error("ECONNREFUSED 10.0.0.1:5432");
        },
      },
      clock,
    });
    const result = await bad();
    expect(result.status).toBe("down");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("makeVaultCheck: GET /v1/sys/health → 200 ok; non-200 down naming the status; transport throw → down", async () => {
    const clock = new FakeClock();
    const requests: Array<VaultHttpRequestArgs> = [];
    const respond = (status: number) => ({
      request: async (args: VaultHttpRequestArgs) => {
        requests.push(args);
        return { status, headers: {}, bodyText: "" };
      },
    });

    const healthy = makeVaultCheck({ addr: "https://vault.example:8200/", http: respond(200), clock });
    const ok = await healthy();
    expect(ok.status).toBe("ok");
    expect(ok.error).toBeNull();
    expect(requests[0]?.method).toBe("GET");
    // The standard unauthenticated Vault health endpoint; standby nodes count as healthy. The
    // trailing slash on addr must not produce a `//v1` path.
    expect(requests[0]?.url).toBe(
      "https://vault.example:8200/v1/sys/health?standbyok=true&perfstandbyok=true",
    );

    const sealed = makeVaultCheck({ addr: "https://vault.example:8200", http: respond(503), clock });
    const down = await sealed();
    expect(down.status).toBe("down");
    expect(down.error).toContain("503");

    const unreachable = makeVaultCheck({
      addr: "https://vault.example:8200",
      http: {
        request: async () => {
          throw new Error("vault transport error: TypeError");
        },
      },
      clock,
    });
    const dead = await unreachable();
    expect(dead.status).toBe("down");
    expect(dead.error).toContain("vault transport error");
  });

  it("makeRuntimeLoopsCheck: named 'runtime-loops'; up while all required loops are up (vacuously up before registration); down names EVERY down loop + reason", async () => {
    const clock = new FakeClock();
    const loopHealth = new LoopHealthRegistry({ clock });
    const dep = makeRuntimeLoopsCheck({ loopHealth });
    expect(dep.name).toBe("runtime-loops");

    // EMPTY registry → vacuously up: readiness must not fail during the boot window before
    // runSupervisedLoops registers the supervised set (and never in a pod without runtime loops).
    expect((await dep.check()).status).toBe("ok");

    loopHealth.register("runner");
    loopHealth.register("scheduler");
    expect((await dep.check()).status).toBe("ok");

    loopHealth.markDown("runner", new Error("poisoned claim"));
    loopHealth.markDown("scheduler", "poll pass exploded");
    const down = await dep.check();
    expect(down.status).toBe("down");
    expect(down.error).toContain("runner");
    expect(down.error).toContain("Error: poisoned claim");
    expect(down.error).toContain("scheduler");
    expect(down.error).toContain("poll pass exploded");
  });
});
