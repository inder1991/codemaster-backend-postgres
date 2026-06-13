/**
 * Worker Temporal-connection config resolver + production-misconfiguration guard (finding H).
 *
 * The spine worker defaults to the dualrun-ISOLATED namespace/queue (`dualrun` /
 * `review-pull-request-dualrun` on `localhost:7233`) so dev + the dual-run never touch a real cluster's
 * path. But those defaults are DANGEROUS against a real cluster: a worker pointed at a production Temporal
 * address while still falling back to the `dualrun` queue would silently poll the wrong queue and process
 * ZERO reviews — a misconfiguration with no error. This resolver fails boot loudly in that case.
 */

export type WorkerTemporalConfig = {
  address: string;
  namespace: string;
  taskQueue: string;
  tls: boolean;
};

const DEFAULT_ADDRESS = "localhost:7233";
const DUALRUN_NAMESPACE = "dualrun";
const DUALRUN_TASK_QUEUE = "review-pull-request-dualrun";

/**
 * A loopback host — dev / dual-run / a `kubectl port-forward`. Never a real cluster. The host is the
 * segment before the (optional) `:port`. An empty/unset address is treated as loopback (the default).
 */
function isLoopbackAddress(address: string): boolean {
  const host = (address.split(":")[0] ?? "").toLowerCase();
  return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolve `{address, namespace, taskQueue, tls}` from an env-like object. When the worker is pointed at a
 * REAL cluster — a non-loopback `TEMPORAL_ADDRESS`, or `NODE_ENV=production` — both `TEMPORAL_NAMESPACE`
 * and `TEMPORAL_TASK_QUEUE` MUST be set explicitly; otherwise this throws rather than fall back to the
 * dualrun-isolated defaults (which would silently process nothing). On a loopback address the defaults
 * apply (dev / dual-run convenience).
 */
export function resolveWorkerTemporalConfig(env: NodeJS.ProcessEnv): WorkerTemporalConfig {
  const address = env.TEMPORAL_ADDRESS ?? DEFAULT_ADDRESS;
  const tls = env.TEMPORAL_TLS === "1";
  const namespace = env.TEMPORAL_NAMESPACE;
  const taskQueue = env.TEMPORAL_TASK_QUEUE;

  const isRealCluster = !isLoopbackAddress(address) || env.NODE_ENV === "production";
  const namespaceMissing = namespace === undefined || namespace === "";
  const taskQueueMissing = taskQueue === undefined || taskQueue === "";

  if (isRealCluster && (namespaceMissing || taskQueueMissing)) {
    throw new Error(
      `Refusing to boot the worker against a real cluster (address=${address}, ` +
        `NODE_ENV=${env.NODE_ENV ?? "unset"}) without TEMPORAL_NAMESPACE + TEMPORAL_TASK_QUEUE set. The ` +
        `dualrun-isolated defaults (${DUALRUN_NAMESPACE} / ${DUALRUN_TASK_QUEUE}) would silently poll the ` +
        `wrong queue and process zero reviews. Set both env vars explicitly.`,
    );
  }

  return {
    address,
    namespace: namespace ?? DUALRUN_NAMESPACE,
    taskQueue: taskQueue ?? DUALRUN_TASK_QUEUE,
    tls,
  };
}

/** The producer-side default task queue (matches the outbox-payload parity tests). */
export const REVIEW_TASK_QUEUE = "review-default";

/**
 * The task queue that workflow PRODUCERS (webhook persistence, push/reconcile/repair emitters, outbox
 * schedules) start workflows on. It reads the SAME `TEMPORAL_TASK_QUEUE` env the polling worker resolves
 * ({@link resolveWorkerTemporalConfig}), so once production sets that env a producer can NEVER start a
 * workflow on a queue the worker isn't polling (review #1 — divergence/stranding). The unset-default is
 * `review-default` (relied on by the outbox-payload tests), which intentionally differs from the worker's
 * dualrun-isolated unset-default (`review-pull-request-dualrun`): production always sets the env so both
 * agree, and only a bare no-env loopback dev (which the smoke harness sets anyway) sees the dev defaults.
 */
export function resolveReviewTaskQueue(env: NodeJS.ProcessEnv = process.env): string {
  const q = env.TEMPORAL_TASK_QUEUE;
  return q !== undefined && q !== "" ? q : REVIEW_TASK_QUEUE;
}
