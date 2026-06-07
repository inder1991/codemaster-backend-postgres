/**
 * SSRF-safe URL validator for credential-target URLs (Confluence, Qwen, etc.) — 1:1 port of
 * `vendor/codemaster-py/codemaster/security/url_validator.py` (spec v4 §11.1). Applied at the
 * platform-credentials PATCH boundary so a mis-typed or malicious operator URL cannot trigger SSRF against
 * internal services (Vault, Postgres, the K8s API, the cloud metadata endpoint, etc.).
 *
 * Divergences from the Python (Node-forced or TS-is-the-safer-side; the parity oracle should treat these as
 * intended, NOT weaken the TS to mirror the weaker Python behavior):
 *  - `validateExternalUrl` is ASYNC (Node DNS is async; Python's socket.getaddrinfo is sync). Callers await.
 *  - CIDR membership is hand-rolled with BigInt (no `ipaddr.js` dep → no spine-dependency ADR). The exact
 *    private/reserved network lists + the IPv4-mapped-IPv6 unwrap + the all-addresses DNS-rebind check are
 *    ported verbatim.
 *  - The injected `resolver` returns address strings (vs Python's getaddrinfo tuples) — a cleaner shape; the
 *    default wraps node:dns lookup with { all: true } and checks EVERY returned address.
 *  - HOST CANONICALIZATION (TS-stricter, accepted): `new URL` applies WHATWG host parsing, so obfuscated IPv4
 *    literals (`0177.0.0.1`, `2130706433`, trailing-dot `127.0.0.1.`) are canonicalized to dotted form BEFORE
 *    the deny-list check → TS blocks them fail-closed, whereas Python's `urlsplit` hands the raw literal to
 *    getaddrinfo (which may resolve `0177.0.0.1` to a PUBLIC `177.0.0.1` and pass). TS is the safer verdict.
 *  - OUT-OF-RANGE PORT (TS-correct, accepted): a bad port (`:99999`) → `new URL` throws → MalformedUrlError →
 *    422 `malformed_url`, where Python's `parts.port` raises a bare ValueError → unhandled 500 (a Python bug).
 *  - EXTREME-MALFORMED 422 CODE (accepted): for a few degenerate inputs (`https:///x`, host-with-space) the
 *    WHATWG vs urlsplit host extraction differs, so the 422 `error` code can be `malformed_url` vs
 *    `dns_resolution_failed`. Both still 422; only the machine-readable code flips.
 */

import { promises as dnsPromises } from "node:dns";

// ───────────── Error hierarchy (1:1 names with the Python classes) ─────────────

export class UrlValidationError extends Error {}
/** URL is syntactically invalid or missing scheme/host. */
export class MalformedUrlError extends UrlValidationError {}
/** URL scheme is not 'https' and allowHttp=false. */
export class HttpsRequiredError extends UrlValidationError {}
/** Hostname resolves to a private / reserved CIDR (SSRF prevention). */
export class PrivateCidrError extends UrlValidationError {}
/** Hostname is not in the explicit allowlist (when an allowlist is provided). */
export class HostnameNotInAllowlistError extends UrlValidationError {}
/** Hostname could not be resolved to any IP. */
export class DnsResolutionError extends UrlValidationError {}
/** URL carries userinfo (user:pass@host); rejected to prevent credential leakage into logs/traces. */
export class UserInfoNotAllowedError extends UrlValidationError {}

export type ValidatedUrl = {
  readonly scheme: string;
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  readonly resolvedIp: string;
};

/** Injectable DNS resolver — returns ALL resolved address strings for (host, port). Tests inject a stub. */
export type DnsResolver = (host: string, port: number) => Promise<Array<string>>;

// ───────────── Private / reserved network deny-lists (verbatim from the Python) ─────────────

type Cidr = { net: bigint; prefix: number };

function ipv4ToBigInt(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m === null) {
    return null;
  }
  const octets = [m[1]!, m[2]!, m[3]!, m[4]!]; // 4 capture groups guaranteed by the match
  let v = 0n;
  for (const oct of octets) {
    const o = Number(oct);
    if (o > 255) {
      return null;
    }
    v = (v << 8n) | BigInt(o);
  }
  return v;
}

/** Parse an IPv6 (incl. ::, zone ids, and embedded-IPv4 forms like ::ffff:10.0.0.1) to a 128-bit BigInt. */
function ipv6ToBigInt(input: string): bigint | null {
  const pct = input.indexOf("%");
  const s = pct >= 0 ? input.slice(0, pct) : input;
  if (s.indexOf("::") !== s.lastIndexOf("::")) {
    return null; // more than one "::"
  }
  const hasDouble = s.includes("::");
  let head: Array<string>;
  let tail: Array<string>;
  if (hasDouble) {
    const halves = s.split("::");
    const h = halves[0] ?? "";
    const t = halves[1] ?? "";
    head = h === "" ? [] : h.split(":");
    tail = t === "" ? [] : t.split(":");
  } else {
    head = s.split(":");
    tail = [];
  }
  const expand = (groups: Array<string>): Array<string> | null => {
    const out: Array<string> = [];
    for (const g of groups) {
      if (g.includes(".")) {
        const v4 = ipv4ToBigInt(g);
        if (v4 === null) {
          return null;
        }
        out.push(((v4 >> 16n) & 0xffffn).toString(16));
        out.push((v4 & 0xffffn).toString(16));
      } else {
        out.push(g);
      }
    }
    return out;
  };
  const h2 = expand(head);
  const t2 = expand(tail);
  if (h2 === null || t2 === null) {
    return null;
  }
  let groups: Array<string>;
  if (hasDouble) {
    const missing = 8 - (h2.length + t2.length);
    if (missing < 0) {
      return null;
    }
    groups = [...h2, ...Array<string>(missing).fill("0"), ...t2];
  } else {
    groups = h2;
  }
  if (groups.length !== 8) {
    return null;
  }
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      return null;
    }
    v = (v << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return v;
}

function parseCidr(cidr: string, parse: (s: string) => bigint | null): Cidr {
  const [ip, p] = cidr.split("/");
  const net = parse(ip!);
  if (net === null) {
    throw new Error(`invalid CIDR in deny-list: ${cidr}`);
  }
  return { net, prefix: Number(p) };
}

const PRIVATE_IPV4: ReadonlyArray<Cidr> = [
  "0.0.0.0/8", // "this" network
  "10.0.0.0/8", // RFC 1918
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local + cloud metadata
  "172.16.0.0/12", // RFC 1918
  "192.0.0.0/24", // IANA special
  "192.168.0.0/16", // RFC 1918
  "198.18.0.0/15", // benchmarking
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
  "255.255.255.255/32", // broadcast
].map((c) => parseCidr(c, ipv4ToBigInt));

const PRIVATE_IPV6: ReadonlyArray<Cidr> = [
  "::1/128", // loopback
  "::/128", // unspecified
  "fc00::/7", // ULA (RFC 4193)
  "fe80::/10", // link-local
  "ff00::/8", // multicast
  "64:ff9b::/96", // IPv4/IPv6 translation
].map((c) => parseCidr(c, ipv6ToBigInt));

function inCidr(ip: bigint, cidr: Cidr, bits: number): boolean {
  if (cidr.prefix === 0) {
    return true;
  }
  const mask = (~0n << BigInt(bits - cidr.prefix)) & ((1n << BigInt(bits)) - 1n);
  return (ip & mask) === (cidr.net & mask);
}

/** True if `addr` falls into a denied private/reserved range. Fail-CLOSED: an unparseable address (which a
 *  real resolver never returns) is treated as private/blocked. The IPv4-mapped-IPv6 unwrap mirrors Python's
 *  `ipv4_mapped` defense — an adversarial AAAA record returning ::ffff:10.x must re-check the IPv4 deny-list. */
function isPrivateAddress(addr: string): boolean {
  const v4 = ipv4ToBigInt(addr);
  if (v4 !== null) {
    return PRIVATE_IPV4.some((c) => inCidr(v4, c, 32));
  }
  const v6 = ipv6ToBigInt(addr);
  if (v6 === null) {
    return true; // fail-closed (unreachable for real resolvers, which emit canonical IPs)
  }
  if (v6 >> 32n === 0xffffn) {
    // IPv4-mapped (::ffff:a.b.c.d): low 32 bits are the IPv4; re-check the IPv4 deny-list.
    const mapped = v6 & 0xffffffffn;
    return PRIVATE_IPV4.some((c) => inCidr(mapped, c, 32));
  }
  return PRIVATE_IPV6.some((c) => inCidr(v6, c, 128));
}

const defaultResolver: DnsResolver = async (host) => {
  const results = await dnsPromises.lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

/**
 * Validate `url` is safe for outbound HTTP from this service. 1:1 with `validate_external_url`.
 * Throws MalformedUrlError / HttpsRequiredError / UserInfoNotAllowedError / HostnameNotInAllowlistError /
 * DnsResolutionError / PrivateCidrError on the respective failure; returns a ValidatedUrl on success.
 */
export async function validateExternalUrl(
  url: string,
  opts: { allowHttp?: boolean; hostnameAllowlist?: Iterable<string>; resolver?: DnsResolver } = {},
): Promise<ValidatedUrl> {
  const allowHttp = opts.allowHttp ?? false;
  if (!url) {
    throw new MalformedUrlError("url must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MalformedUrlError(`malformed url: ${url}`);
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw new MalformedUrlError(`unsupported scheme: ${scheme}`);
  }
  // new URL strips brackets off [::1]-form IPv6 literals only in .hostname? It keeps them; normalize.
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (hostname === "") {
    throw new MalformedUrlError("missing hostname");
  }
  if (scheme === "http" && !allowHttp) {
    throw new HttpsRequiredError(`https:// required (got ${scheme}://); set allowHttp only for dev/test`);
  }
  // Reject ANY userinfo, including a bare '@' (empty user:pass). `new URL` collapses empty userinfo to "", so
  // parsed.username/password can't distinguish `@host` from `host`; scan the raw authority for '@' to match
  // Python's urlsplit (which reports username='' → rejected) 1:1.
  const afterScheme = url.slice(url.indexOf("://") + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority.includes("@")) {
    throw new UserInfoNotAllowedError("URL must not contain userinfo (user:pass@)");
  }
  const port = parsed.port !== "" ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  if (opts.hostnameAllowlist !== undefined) {
    const allow = new Set([...opts.hostnameAllowlist].map((h) => h.toLowerCase()));
    if (!allow.has(hostname)) {
      throw new HostnameNotInAllowlistError(`hostname ${hostname} not in allowlist (size=${allow.size})`);
    }
  }
  const resolvedIp = await resolveAndCheck(hostname, port, opts.resolver ?? defaultResolver);
  return { scheme, hostname, port, path: parsed.pathname || "/", resolvedIp };
}

/** Resolve `hostname` and assert NO returned address is private (DNS-rebind defense checks ALL). */
async function resolveAndCheck(hostname: string, port: number, resolver: DnsResolver): Promise<string> {
  let addrs: Array<string>;
  try {
    addrs = await resolver(hostname, port);
  } catch (err) {
    throw new DnsResolutionError(`DNS resolution failed for ${hostname}: ${String(err)}`);
  }
  if (addrs.length === 0) {
    throw new DnsResolutionError(`no addresses returned for ${hostname}`);
  }
  let resolvedIp: string | null = null;
  for (const addr of addrs) {
    if (isPrivateAddress(addr)) {
      throw new PrivateCidrError(`hostname ${hostname} resolves to private/reserved address ${addr}`);
    }
    if (resolvedIp === null) {
      resolvedIp = addr;
    }
  }
  // Non-empty + no throw above guarantees resolvedIp is set.
  return resolvedIp ?? addrs[0]!;
}
