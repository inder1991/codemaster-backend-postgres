// Non-blocking feature-config precedence (go-live Step 4): DB (UI) > env (ConfigMap/Secret) > Vault
// > disabled. The first layer to yield a non-null value wins, and its source is reported (for
// /config-status). Layers are tried in order and short-circuit — no wasted Vault round-trip once a
// higher layer answers. Used by the GitHub + Confluence (+ future) feature-config resolvers.

export type ConfigLayer<T> = {
  /** Where this layer reads from (e.g. "db" | "env" | "vault") — surfaced in the resolved source. */
  readonly source: string;
  /** Load the config from this layer, or null when this layer has nothing. */
  readonly load: () => Promise<T | null>;
  /** When true, a thrown load() error is treated as "nothing here" (resolution falls through to the next
   *  tier) instead of propagating — for tiers prone to TRANSIENT outages (e.g. the DB: a core-DB blip must
   *  not break a feature whose creds live in env/Vault — review P1). Default false: a throw PROPAGATES
   *  (fail-closed — e.g. a Vault path-not-found is a deployment misconfiguration that must fail loud, not
   *  silently disable the feature). */
  readonly tolerateErrors?: boolean;
};

/**
 * Resolve through the layers in order; return the first non-null value + its source, or null.
 *
 * A layer marked `tolerateErrors` whose `load()` THROWS is treated as "this layer has nothing" and
 * resolution falls through to the next — so a TRANSIENT outage of a tolerant tier (e.g. a core-DB blip)
 * doesn't break a feature whose creds live in a lower tier (review P1). The throw is surfaced via `onError`
 * (never silent). A throw from a NON-tolerant tier PROPAGATES (fail-closed — e.g. a Vault path-not-found is
 * a deployment misconfiguration). If NO layer yields, the result is null (the feature is disabled).
 */
export async function resolveLayered<T>(
  layers: ReadonlyArray<ConfigLayer<T>>,
  onError?: (source: string, err: unknown) => void,
): Promise<{ value: T; source: string } | null> {
  for (const layer of layers) {
    let value: T | null;
    try {
      value = await layer.load();
    } catch (err) {
      if (layer.tolerateErrors !== true) {
        throw err; // fail-closed tier — propagate (e.g. Vault path-not-found at deployment)
      }
      onError?.(layer.source, err); // transient-tolerant tier (e.g. DB blip) — surface + fall through
      continue;
    }
    if (value !== null) {
      return { value, source: layer.source };
    }
  }
  return null;
}
