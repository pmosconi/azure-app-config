/**
 * Invariant 2 — memoise success, never failure, and rate-limit retrying.
 *
 * Caching a rejected promise makes the first attempt the only one. Not rate-limiting means every
 * queue trigger re-attempts on every invocation, which on the Free SKU (1,000 requests a day,
 * then HTTP 429 to every reader until midnight UTC) spends the quota in minutes and starves
 * every other consumer of the store.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { hydrate, resetHydration } from '../src/index';
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

afterEach(() => {
  vi.useRealTimers();
  restoreEnv(env);
});

describe('memoisation', () => {
  it('memoises a success — later calls are free', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    const first = await hydrate({ keys: KEYS });
    const second = await hydrate({ keys: KEYS });

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not memoise a failure — a later call can still succeed', async () => {
    loadMock
      .mockRejectedValueOnce(providerAggregate(forbidden()))
      .mockResolvedValue(fakeStore() as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow();
    const result = await hydrate({ keys: KEYS, retryFloorMs: 0 });

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.applied).toContain('MONGO_URL');
  });
});

describe('the retry floor', () => {
  it('re-throws the previous error inside the floor without touching the store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    const failure = providerAggregate(forbidden());
    loadMock.mockRejectedValue(failure);

    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    expect(loadMock).toHaveBeenCalledTimes(1);

    // Eight queue triggers arriving a second later must not become eight more store requests.
    vi.advanceTimersByTime(1_000);
    for (let i = 0; i < 8; i++) {
      const again = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
      expect(again).toBe(first);
    }

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('attempts again once the floor has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValueOnce(providerAggregate(forbidden())).mockResolvedValue(fakeStore() as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toThrow();
    expect(loadMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_999);
    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toThrow();
    expect(loadMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    const result = await hydrate({ keys: KEYS, retryFloorMs: 30_000 });

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.label).toBe('prod');
  });

  it('is cleared by resetHydration, floor timestamp included', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValueOnce(providerAggregate(forbidden())).mockResolvedValue(fakeStore() as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toThrow();

    resetHydration();
    const result = await hydrate({ keys: KEYS, retryFloorMs: 30_000 });

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.applied).toContain('MONGO_URL');
  });
});
