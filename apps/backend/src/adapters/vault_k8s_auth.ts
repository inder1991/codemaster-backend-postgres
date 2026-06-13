// Vault Kubernetes-auth token provider: in vault mode the app authenticates to Vault with its
// OpenShift service-account JWT (no static token). It POSTs {role, jwt} to the kubernetes auth
// backend, caches the returned client_token until ~90% of its lease, re-logs-in past that or on
// invalidate() (called by callers on a 403). The SA JWT is RE-READ on every login so OpenShift's
// short-lived projected-token rotation is transparent. IO (HTTP, token-file, clock) is injected.

const RENEW_AT = 0.9; // re-login once 90% of the lease has elapsed (avoid using a near-expired token)
const DEFAULT_AUTH_PATH = "auth/kubernetes";
// Floor for the cache TTL: a Vault role with token_ttl=0 (use-mount-default) or a backend that omits
// lease_duration would otherwise yield renewAtMs == now → a re-login on EVERY token() call (a self-DoS
// against Vault's login rate limiter). 60s is conservative; real leases are minutes-to-hours. (review P2)
const MIN_LEASE_SECONDS = 60;

/** A Vault login response (the subset we use). */
type LoginBody = { auth?: { client_token?: unknown; lease_duration?: unknown } };

export type VaultK8sAuthDeps = {
  readonly addr: string;
  readonly role: string;
  /** Read the pod's service-account JWT (re-read each login for rotation). */
  readonly readToken: () => Promise<string>;
  /** POST JSON to Vault; returns the HTTP status + parsed body. */
  readonly httpPostJson: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  readonly now: () => number;
  /** Auth backend mount path (default `auth/kubernetes`). */
  readonly authPath?: string;
};

export class VaultK8sAuth {
  readonly #deps: VaultK8sAuthDeps;
  readonly #authPath: string;
  #cached: { token: string; renewAtMs: number } | null = null;
  #loginPromise: Promise<string> | null = null;

  public constructor(deps: VaultK8sAuthDeps) {
    this.#deps = deps;
    this.#authPath = deps.authPath ?? DEFAULT_AUTH_PATH;
  }

  /** A valid Vault client token, logging in (or re-logging-in) as needed. */
  public async token(): Promise<string> {
    if (this.#cached !== null && this.#deps.now() < this.#cached.renewAtMs) {
      return this.#cached.token;
    }
    // De-dup concurrent cold-start logins: the first caller starts the single-flight login; others await
    // the SAME promise rather than each POSTing their own SA-JWT login (review P2). Cleared on settle so a
    // later past-lease refresh starts a fresh login.
    this.#loginPromise ??= this.#login().finally(() => {
      this.#loginPromise = null;
    });
    return this.#loginPromise;
  }

  /** Drop the cached token so the next {@link token} call re-logs-in (call this on a 403). */
  public invalidate(): void {
    this.#cached = null;
  }

  async #login(): Promise<string> {
    let jwt: string;
    try {
      jwt = await this.#deps.readToken();
    } catch (e) {
      throw new Error(
        `cannot read the Kubernetes service account token for Vault login: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { cause: e },
      );
    }

    const url = `${this.#deps.addr}/v1/${this.#authPath}/login`;
    const { status, body } = await this.#deps.httpPostJson(url, { role: this.#deps.role, jwt });
    if (status !== 200) {
      throw new Error(
        `Vault kubernetes login failed (HTTP ${status}) for role "${this.#deps.role}" at ${url} — ` +
          `check the SA is bound to this Vault role and the role's policies grant the needed paths`,
      );
    }

    const auth = (body as LoginBody).auth;
    if (auth === undefined || typeof auth.client_token !== "string") {
      throw new Error(`Vault kubernetes login for role "${this.#deps.role}" returned no client_token`);
    }
    const rawLease = typeof auth.lease_duration === "number" ? auth.lease_duration : 0;
    // Floor ONLY a missing/zero lease (token_ttl=0 / omitted lease_duration) — that's the per-call re-login
    // storm the floor guards. A real positive lease is honored as-is: flooring a short-but-real TTL up to 60s
    // would make renewAtMs OVERSHOOT the true expiry, serving an already-dead token (a 403 window). (review P2)
    const leaseSeconds = rawLease > 0 ? rawLease : MIN_LEASE_SECONDS;
    this.#cached = {
      token: auth.client_token,
      renewAtMs: this.#deps.now() + leaseSeconds * 1000 * RENEW_AT,
    };
    return auth.client_token;
  }
}
