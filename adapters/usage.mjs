// adapters/usage.mjs — the ONE place that decides what a v1 `usage` event
// looks like.
//
// Contract (server.mjs header, frozen): prompt_tokens is the FULL prompt
// total, cached_tokens is a SUBSET of it, and cache_write_tokens is additive.
// Three adapters shipped the OpenAI-style nested spelling
// (`prompt_tokens_details.cached_tokens`) before the contract was written
// down, and the pinned reference client (browsa, lib/bridge-client.js) reads
// either spelling. So this builder emits BOTH: the frozen top-level key plus
// the nested alias. Additive-only — nothing that existed is renamed or
// removed.
//
// Callers own the provider-specific arithmetic (ACP's inclusive-vs-exclusive
// correction, zcode's cumulative deltas); this module owns only the wire
// shape. Pass `cachedTokens`/`cacheWriteTokens` as a number to report them
// (0 included), or leave them undefined to omit the key.

export function v1Usage({ promptTokens, completionTokens, cachedTokens, cacheWriteTokens }) {
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
  };
  if (typeof cachedTokens === 'number') {
    usage.cached_tokens = cachedTokens;
    usage.prompt_tokens_details = { cached_tokens: cachedTokens };
  }
  if (typeof cacheWriteTokens === 'number') usage.cache_write_tokens = cacheWriteTokens;
  return usage;
}
