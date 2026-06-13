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

/** Resolve through the layers in order; return the first non-null value + its source, or null. */
export async function resolveLayered<T>(
  layers: ReadonlyArray<ConfigLayer<T>>,
): Promise<{ value: T; source: string } | null> {
  for (const layer of layers) {
    const value = await layer.load();
    if (value !== null) {
      return { value, source: layer.source };
    }
  }
  return null;
}
