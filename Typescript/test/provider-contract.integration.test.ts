/**
 * The provider's half of the contract — the one thing the unit suite cannot check.
 *
 * Everywhere else `load()` is mocked, so the tests prove that this package builds the policy and
 * that the policy records what it is shown. They assume the rest: that `clientOptions` is still
 * honoured, that it reaches the replica clients too, and that `perRetry` still sits below the
 * SDK's retry policy. The whole of invariant 3 rests on that assumption, and a provider upgrade
 * that quietly dropped or renamed `clientOptions` would leave every unit test green while
 * `detail` fell through to the no-observations branch — reporting a refused read as "the store
 * was unreachable or slower than the startup timeout", confidently and specifically wrong in the
 * one sentence the incident needed to be right.
 *
 * So this runs the real `load()` once and asserts the one fact everything else depends on: a
 * genuine failure yields at least one observation.
 *
 * It needs no Azure, no credentials and no egress. `example.invalid` is reserved by RFC 2606 and
 * can never resolve, so the request fails in the transport whether or not a resolver answers.
 * The provider pads an unhandled startup failure to a five-second minimum
 * (`MIN_DELAY_FOR_UNHANDLED_FAILURE`), which is why this is not in the unit run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessToken, TokenCredential } from '@azure/identity';
import { ConfigLoadError, hydrate, resetHydration } from '../src/index';

/** Answers instantly, so the failure under test is the request and not the credential. */
const stubCredential: TokenCredential = {
  getToken: async (): Promise<AccessToken> => ({
    token: 'not-a-real-token',
    expiresOnTimestamp: Date.now() + 3_600_000,
  }),
};

afterEach(() => resetHydration());

describe('the real provider', () => {
  it('still lets the diagnostics policy see a failure', async () => {
    const error = await hydrate({
      keys: { 'shared:mongoUrl': 'MONGO_URL_UNUSED' },
      label: 'prod',
      endpoint: 'https://nope.example.invalid',
      credential: stubCredential,
      timeoutMs: 10_000,
      retryFloorMs: 0,
      logger: { log: () => {} },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigLoadError);
    const failure = error as ConfigLoadError;

    // The contract, in one assertion: clientOptions was honoured and the policy ran.
    expect(failure.observations.length).toBeGreaterThan(0);

    // And the fallback branch was not taken — this is the sentence that would be wrong.
    expect(failure.detail).not.toContain('no response was observed');

    // What the provider handed us, for contrast: nothing usable, bottoming out with no cause.
    expect((failure.cause as Error).message).toBe('The load operation failed.');
  });

  it('gets nothing from unwrapping the provider chain, which is why the policy exists', async () => {
    const error = (await hydrate({
      keys: { 'shared:mongoUrl': 'MONGO_URL_UNUSED' },
      label: 'prod',
      endpoint: 'https://nope.example.invalid',
      credential: stubCredential,
      timeoutMs: 10_000,
      retryFloorMs: 0,
      logger: { log: () => {} },
    }).catch((e: unknown) => e)) as ConfigLoadError;

    // Walk the chain the way unwrap() does. It bottoms out with no cause and no errors array.
    let node: unknown = error.cause;
    let depth = 0;
    while (node !== undefined && node !== null && depth < 10) {
      const next = node as { cause?: unknown; errors?: unknown };
      expect(Array.isArray(next.errors)).toBe(false);
      node = next.cause;
      depth++;
    }

    expect(depth).toBeLessThanOrEqual(2);
  });
});
