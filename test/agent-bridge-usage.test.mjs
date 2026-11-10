// test/agent-bridge-usage.test.mjs — the one v1 usage shape
// (adapters/usage.mjs). The wire contract is server.mjs's header: top-level
// prompt_tokens/completion_tokens plus optional cached_tokens /
// cache_write_tokens, with cached_tokens a SUBSET of prompt_tokens. The
// nested OpenAI-style prompt_tokens_details.cached_tokens is kept as an
// additive alias because three adapters shipped it first and browsa reads
// either spelling (lib/bridge-client.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { v1Usage } from '../adapters/usage.mjs';

test('v1Usage: no cache counters → the frozen minimal shape', () => {
  assert.deepEqual(
    v1Usage({ promptTokens: 100, completionTokens: 3 }),
    { prompt_tokens: 100, completion_tokens: 3 },
  );
});

test('v1Usage: cached tokens ride BOTH the contract key and the nested alias', () => {
  assert.deepEqual(
    v1Usage({ promptTokens: 120, completionTokens: 10, cachedTokens: 80 }),
    {
      prompt_tokens: 120,
      completion_tokens: 10,
      cached_tokens: 80,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  );
});

test('v1Usage: a zero cache read is still reported (headless sends 0)', () => {
  assert.deepEqual(
    v1Usage({ promptTokens: 100, completionTokens: 3, cachedTokens: 0 }),
    {
      prompt_tokens: 100,
      completion_tokens: 3,
      cached_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  );
});

test('v1Usage: cache write rides additively', () => {
  assert.deepEqual(
    v1Usage({ promptTokens: 155, completionTokens: 45, cachedTokens: 30, cacheWriteTokens: 5 }),
    {
      prompt_tokens: 155,
      completion_tokens: 45,
      cached_tokens: 30,
      prompt_tokens_details: { cached_tokens: 30 },
      cache_write_tokens: 5,
    },
  );
});

test('v1Usage: an absent cache counter omits the key (not a fake 0)', () => {
  const usage = v1Usage({ promptTokens: 8, completionTokens: 2, cacheWriteTokens: 4 });
  assert.equal('cached_tokens' in usage, false);
  assert.equal('prompt_tokens_details' in usage, false);
  assert.equal(usage.cache_write_tokens, 4);
});
