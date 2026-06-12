// Trusted client-IP derivation — W4.7 / EM5.
//
// The login rate limiter buckets per client IP. The legacy port used the LEFTMOST X-Forwarded-For
// entry — a value the CLIENT controls (anything it sends arrives left of the entries trusted
// proxies append), so a credential sprayer rotating fake XFF values lands in a fresh bucket per
// attempt and the limit never trips. The trusted derivation walks the chain from the RIGHT by the
// deployment's KNOWN proxy hop count:
//
//   trustedProxyHops = 0  →  the socket peer address; XFF ignored entirely (the safe default —
//                            correct whenever clients reach the pod directly or the edge cannot be
//                            trusted to strip client-supplied XFF).
//   trustedProxyHops = N  →  the Nth entry from the right of the joined XFF chain (each trusted
//                            proxy appends exactly one entry, so position N from the right is the
//                            address the OUTERMOST trusted proxy saw as its peer). Fewer entries
//                            than N → fall back to the socket peer.
//
// Production sets CODEMASTER_TRUSTED_PROXY_HOPS to the real edge depth (1 for the OpenShift router).

export type TrustedClientIpArgs = {
  /** The raw X-Forwarded-For header (string, repeated-header array, or absent). */
  xff: string | ReadonlyArray<string> | undefined;
  /** The transport peer address (Fastify `request.ip` with no trust-proxy configured). */
  socketIp: string;
  /** Number of trusted reverse-proxy hops between the client and this pod (>= 0). */
  trustedProxyHops: number;
};

/** Derive the rate-limit bucketing key. Never returns an empty string ("unknown" floor). */
export function trustedClientIp(args: TrustedClientIpArgs): string {
  const fallback = args.socketIp !== "" ? args.socketIp : "unknown";
  if (args.trustedProxyHops <= 0) {
    return fallback;
  }
  const joined = Array.isArray(args.xff) ? args.xff.join(",") : (args.xff ?? "");
  const entries = String(joined)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  const fromRight = entries[entries.length - args.trustedProxyHops];
  return fromRight !== undefined && fromRight !== "" ? fromRight : fallback;
}
