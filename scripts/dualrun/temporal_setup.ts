// Dual-run / skeleton Temporal setup: ensure an ISOLATED `dualrun` namespace exists on the connected
// Temporal frontend. Read-only list first (so we can see — and never touch — the real namespaces),
// then register `dualrun` only if absent. Idempotent.
//
// Connects to TEMPORAL_ADDRESS (default localhost:7233 — the kubectl port-forward of the in-cluster
// svc/temporal-frontend). This is the ONLY cluster-Temporal write the skeleton makes; it creates a
// sandbox namespace that real workers never poll.
import { Connection } from "@temporalio/client";

import type Long from "long";

const TARGET = process.env.TEMPORAL_NAMESPACE ?? "dualrun";
const RETENTION_DAYS = 1;

async function main(): Promise<void> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  try {
    const listed = await connection.workflowService.listNamespaces({});
    const names = (listed.namespaces ?? [])
      .map((n) => n.namespaceInfo?.name)
      .filter((n): n is string => typeof n === "string");
    process.stdout.write(`existing namespaces: ${names.join(", ")}\n`);

    if (names.includes(TARGET)) {
      process.stdout.write(`namespace "${TARGET}" already exists — nothing to do.\n`);
      return;
    }
    await connection.workflowService.registerNamespace({
      namespace: TARGET,
      // The gRPC Duration types `seconds` as protobuf `Long`; protobufjs coerces a plain number at
      // runtime (verified live), so a type-only cast keeps tsc happy without a runtime `long` dep.
      workflowExecutionRetentionPeriod: {
        seconds: (RETENTION_DAYS * 24 * 60 * 60) as unknown as Long,
        nanos: 0,
      },
    });
    process.stdout.write(`registered isolated namespace "${TARGET}" (retention ${RETENTION_DAYS}d).\n`);
  } finally {
    await connection.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`temporal_setup FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
