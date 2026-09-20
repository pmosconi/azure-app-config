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
import { KEYS, VALUES, fakeStore, providerFailoverError, restoreEnv, snapshotEnv } from './helpers';

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
  for (const variable of Object.values(KEYS)) delete process.env[variable];
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
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore() as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow();
    const result = await hydrate({ keys: KEYS, retryFloorMs: 0 });

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.applied).toContain('MONGO_URL');
  });
});

/**
 * One Functions worker hosts every function in the app. If the memo is a single promise, the
 * second handler to call hydrate gets the first handler's result — no request, none of its own
 * variables written, and an `applied` list naming variables it never asked for.
 */
describe('the memo is keyed on the call, not on the module', () => {
  it('does not hand one key map another key map’s result', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    const first = await hydrate({ keys: { 'shared:mongoUrl': 'MONGO_URL' } });
    const second = await hydrate({ keys: { 'myapp:httpPort': 'HTTP_PORT' } });

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(first.applied).toEqual(['MONGO_URL']);
    expect(second.applied).toEqual(['HTTP_PORT']);
    expect(process.env.HTTP_PORT).toBe('8080');
  });

  it('shares one attempt when the same keys are listed in a different order', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: { 'shared:mongoUrl': 'MONGO_URL', 'myapp:httpPort': 'HTTP_PORT' } });
    await hydrate({ keys: { 'myapp:httpPort': 'HTTP_PORT', 'shared:mongoUrl': 'MONGO_URL' } });

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('reads again when the same keys are asked for at a different label', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    const prod = await hydrate({ keys: KEYS, label: 'prod' });
    const staging = await hydrate({ keys: KEYS, label: 'staging' });

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(prod.label).toBe('prod');
    expect(staging.label).toBe('staging');
  });
});

describe('the retry floor', () => {
  it('re-throws the previous error inside the floor without touching the store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

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

  it('is global, because the store’s quota is — a second key map is held back too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toThrow();
    vi.advanceTimersByTime(1_000);
    await expect(
      hydrate({ keys: { 'myapp:httpPort': 'HTTP_PORT' }, retryFloorMs: 30_000 })
    ).rejects.toThrow();

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('attempts again once the floor has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore() as never);

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
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore() as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toThrow();

    resetHydration();
    const result = await hydrate({ keys: KEYS, retryFloorMs: 30_000 });

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.applied).toContain('MONGO_URL');
  });

  it('is not armed by a rejection that lands after resetHydration', async () => {
    // The .catch closes over the state object it was created with, not the module binding, so a
    // slow failure cannot re-arm a floor belonging to the state that replaced it.
    let failIt: (error: unknown) => void = () => {};
    loadMock
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (failIt = reject)))
      .mockResolvedValue(fakeStore() as never);

    const pending = hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    resetHydration();
    failIt(providerFailoverError());
    await pending;

    const result = await hydrate({ keys: KEYS, retryFloorMs: 30_000 });

    expect(result.applied).toContain('MONGO_URL');
    expect(process.env.MONGO_URL).toBe(VALUES['shared:mongoUrl']);
  });
});
