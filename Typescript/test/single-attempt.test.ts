/**
 * Invariant 1 — one attempt per call.
 *
 * `hydrate()` does not loop. Retry policy belongs to the caller: a function invocation with a
 * five-minute timeout must not contain a ten-minute backoff loop. If someone puts a retry inside
 * `hydrate()`, the call counts here go up and these fail.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { hydrate, hydrateWithBackoff, resetHydration } from '../src/index';
import { KEYS, fakeStore, providerAggregate, forbidden, restoreEnv, snapshotEnv } from './helpers';

vi.mock('@azure/app-configuration-provider', () => ({ load: vi.fn() }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken() {
      return Promise.resolve(null);
    }
  },
}));

const loadMock = vi.mocked(load);
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = snapshotEnv();
  resetHydration();
  loadMock.mockReset();
  process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
  process.env.APP_CONFIG_LABEL = 'prod';
  delete process.env.NODE_ENV;
});

afterEach(() => restoreEnv(env));

describe('one attempt per call', () => {
  it('calls the provider exactly once on success', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('calls the provider exactly once on failure, and rejects rather than retrying', async () => {
    loadMock.mockRejectedValue(providerAggregate(forbidden()));

    await expect(hydrate({ keys: KEYS })).rejects.toThrow();

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-read the store when keys are missing at the label', async () => {
    loadMock.mockResolvedValue(fakeStore({ 'shared:mongoUrl': 'mongodb://example.invalid' }) as never);

    await expect(hydrate({ keys: KEYS })).rejects.toThrow(/Missing key-values/);

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('shares one attempt between concurrent callers', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    const [first, second] = await Promise.all([hydrate({ keys: KEYS }), hydrate({ keys: KEYS })]);

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('puts the loop in hydrateWithBackoff, where a long-lived process opts into it', async () => {
    loadMock
      .mockRejectedValueOnce(providerAggregate(forbidden()))
      .mockRejectedValueOnce(providerAggregate(forbidden()))
      .mockResolvedValue(fakeStore() as never);

    const result = await hydrateWithBackoff(
      { keys: KEYS, retryFloorMs: 0 },
      { initialMs: 1, maxMs: 2, onError: () => {} }
    );

    expect(loadMock).toHaveBeenCalledTimes(3);
    expect(result.applied).toContain('MONGO_URL');
  });
});
