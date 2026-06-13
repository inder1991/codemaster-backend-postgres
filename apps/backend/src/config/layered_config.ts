// Non-blocking feature-config precedence (go-live Step 4): DB (UI) > env (ConfigMap/Secret) > Vault
// > disabled. The first layer to yield a non-null value wins, and its source is reported (for
// /config-status). Layers are tried in order and short-circuit — no wasted Vault round-trip once a
// higher layer answers. Used by the GitHub + Confluence (+ future) feature-config resolvers.

export type ConfigLayer<T> = {
  /** Where this layer reads from (e.g. "db" | "env" | "vault") — surfaced in the resolved source. */
  readonly source: string;
  /** Load the config from this layer, or null when this layer has nothing. */
  readonly load: () => Promise<T | null>;
};

/**
 * Resolve through the layers in order; return the first non-null value + its source, or null.
 *
 * A layer whose `load()` THROWS (e.g. a transient DB/Vault outage) is treated as "this layer has nothing"
 * and resolution falls through to the next — a higher-tier outage must NOT break a feature whose creds live
 * in a lower tier (review P1: a core-DB blip would otherwise disable GitHub creds/webhook + Confluence even
 * when env/Vault has them). The throw is surfaced via `onError` so it is never silent; if NO layer yields,
 * the result is null (the feature is disabled — fail-closed, not a boot/runtime crash).
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
      onError?.(layer.source, err);
      continue;
    }
    if (value !== null) {
      return { value, source: layer.source };
    }
  }
  return null;
}
