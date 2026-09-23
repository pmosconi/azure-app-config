/**
 * A container that loops forever on a typo is indistinguishable from one waiting out a genuine
 * outage, and only one of those is worth waiting for. `hydrateWithBackoff` retries what the store
 * might recover from and rejects what it cannot.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import {
  ConfigFloorError,
  ConfigInputError,
  ConfigLoadError,
  hydrate,
  hydrateWithBackoff,
  resetHydration,
} from '../src/index';
import {
  KEYS,
  VALUES,
  fakeStore,
  failingLoad,
  failingLoadAfterRead,
  failingLoadWithHangingRequest,
  failingLoadWithNoRequest,
  providerArgumentError,
  providerFailoverError,
  providerPreRequestError,
  restoreEnv,
  snapshotEnv,
} from './helpers';

vi.mock('@azure/app-configuration-provider', () => ({ load: vi.fn() }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken() {
      return Promise.resolve(null);
    }
  },
}));

const loadMock = vi.mocked(load);
const fast = { initialMs: 1, maxMs: 2, onError: () => {} };
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = snapshotEnv();
  resetHydration();
  loadMock.mockReset();
  process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
  process.env.APP_CONFIG_LABEL = 'prod';
  delete process.env.NODE_ENV;
  delete process.env.WEBSITE_INSTANCE_ID;
  for (const variable of Object.values(KEYS)) delete process.env[variable];
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv(env);
});

describe('hydrateWithBackoff does not retry what retrying cannot fix', () => {
  it('rejects a wildcard key instead of looping', async () => {
    const error = await hydrateWithBackoff({ keys: { 'shared:*': 'ANYTHING' } }, fast).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ConfigInputError);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('rejects an empty key map instead of looping', async () => {
    const error = await hydrateWithBackoff({ keys: {} }, fast).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigInputError);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('rejects a missing label instead of looping', async () => {
    delete process.env.APP_CONFIG_LABEL;

    const error = await hydrateWithBackoff({ keys: KEYS }, fast).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigInputError);
    expect((error as Error).message).toContain('APP_CONFIG_LABEL');
  });

  it('rejects a missing endpoint instead of looping', async () => {
    delete process.env.APP_CONFIG_ENDPOINT;

    const error = await hydrateWithBackoff({ keys: KEYS }, fast).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigInputError);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('rejects the provider’s own ArgumentError after one attempt', async () => {
    loadMock.mockImplementation(
      failingLoadWithNoRequest(
        providerPreRequestError()
      ) as never
    );

    const error = await hydrateWithBackoff({ keys: KEYS, retryFloorMs: 0 }, fast).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ConfigInputError);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});

describe('hydrateWithBackoff keeps retrying what the store can recover from', () => {
  it('retries a refused read until the grant comes back', async () => {
    loadMock
      .mockRejectedValueOnce(providerFailoverError())
      .mockRejectedValueOnce(providerFailoverError())
      .mockResolvedValue(fakeStore() as never);

    const result = await hydrateWithBackoff({ keys: KEYS, retryFloorMs: 0 }, fast);

    expect(loadMock).toHaveBeenCalledTimes(3);
    expect(result.applied).toContain('MONGO_URL');
  });

  it('retries a key that is missing until a deploy adds it', async () => {
    loadMock
      .mockResolvedValueOnce(fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']! }) as never)
      .mockResolvedValue(fakeStore() as never);

    const result = await hydrateWithBackoff({ keys: KEYS, retryFloorMs: 0 }, fast);

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.applied).toContain('HTTP_PORT');
  });
});

/**
 * The floor protects the store's request quota, so what arms it is whether the failed attempt
 * sent a request — not what kind of error it ended in. 0.1.0 exempted every ConfigInputError,
 * including one the provider raised after reading the store, so that one was repeated, a request
 * a key, on every call from every handler.
 */
describe('an input error arms the floor exactly when it reached the store', () => {
  it('leaves a well-formed call free after input rejected before any request', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await expect(hydrate({ keys: { 'shared:*': 'X' } })).rejects.toBeInstanceOf(ConfigInputError);
    const result = await hydrate({ keys: KEYS });

    expect(result.applied).toContain('MONGO_URL');
  });

  it('does not arm it for the provider’s own pre-request argument check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock
      .mockImplementationOnce(
        failingLoadWithNoRequest(
          providerPreRequestError()
        ) as never
      )
      .mockResolvedValue(fakeStore() as never);

    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    vi.advanceTimersByTime(1_000);
    const result = await hydrate({ keys: KEYS, retryFloorMs: 30_000 });

    expect(first).toBeInstanceOf(ConfigInputError);
    expect((first as ConfigInputError).reachedStore).toBe(false);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.applied).toContain('MONGO_URL');
  });

  it('arms it for an input error raised after the store was read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockImplementation(
      failingLoadAfterRead(providerArgumentError('Invalid value read from the store.')) as never
    );

    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ConfigInputError);
    expect((first as ConfigInputError).reachedStore).toBe(true);

    vi.advanceTimersByTime(1_000);
    for (let i = 0; i < 8; i++) {
      const again = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ConfigFloorError);
      expect((again as ConfigFloorError).cause).toBe(first);
    }
    expect(loadMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_000);
    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('does not count a request that left and never came back as reaching the store', async () => {
    // reachedStore means a response came back, not that a request departed: a request still in
    // flight at the rejection is evidence of nothing about the store.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock
      .mockImplementationOnce(
        failingLoadWithHangingRequest(providerArgumentError('Invalid argument.')) as never
      )
      .mockResolvedValue(fakeStore() as never);

    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    vi.advanceTimersByTime(1_000);
    await hydrate({ keys: KEYS, retryFloorMs: 30_000 });

    expect(first).toBeInstanceOf(ConfigInputError);
    expect((first as ConfigInputError).reachedStore).toBe(false);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('still stops hydrateWithBackoff on it — waiting alone will not fix it', async () => {
    loadMock.mockImplementation(
      failingLoadAfterRead(providerArgumentError('Invalid value read from the store.')) as never
    );

    const error = await hydrateWithBackoff({ keys: KEYS, retryFloorMs: 0 }, fast).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ConfigInputError);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('holds back a second key map’s backoff loop without stopping it', async () => {
    // The floor rejection is not an input error even when its cause is one: it says nothing about
    // the second key map, which gets its own attempt once the floor opens.
    loadMock
      .mockImplementationOnce(
        failingLoadAfterRead(providerArgumentError('Invalid value read from the store.')) as never
      )
      .mockResolvedValue(fakeStore() as never);
    await hydrate({ keys: { 'shared:mongoUrl': 'MONGO_URL' }, retryFloorMs: 20 }).catch(
      () => undefined
    );
    const reported: unknown[] = [];

    const result = await hydrateWithBackoff(
      { keys: { 'myapp:httpPort': 'HTTP_PORT' }, retryFloorMs: 20 },
      { initialMs: 1, maxMs: 2, onError: error => reported.push(error) }
    );

    // It waited the floor out rather than reporting it: nothing was attempted, so nothing failed.
    expect(reported).toEqual([]);
    expect(result.applied).toEqual(['HTTP_PORT']);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The other side of the classification, and the side with a production gate behind it.
 *
 * Phase 4 was gated on exactly this behaviour: the store grant was revoked, the container came up
 * and stayed up answering unhealthy, the backoff widened from 5 s to its 600 s cap, and the
 * application loaded its configuration fourteen minutes after the grant was restored — one
 * process start, no restart, no instance replacement. Every part of that requires a 403 to be a
 * failure worth retrying.
 *
 * These tests assert the consequence rather than the classification. Widening `hasInputError` to
 * something like `name.endsWith('Error')` would turn that gate's passing behaviour into a
 * container that rejects immediately and never recovers, and a test that only asserted
 * `403 -> ConfigLoadError` would be rewritten alongside the guard it was checking. A test on the
 * consequence fails however the guard is spelled.
 */
describe('what must stay retryable, because the Phase 4 gate depends on it', () => {
  it('retries a revoked grant and recovers when it is restored, with no restart', async () => {
    loadMock
      .mockImplementationOnce(failingLoad({ status: 403 }) as never)
      .mockImplementationOnce(failingLoad({ status: 403 }) as never)
      .mockResolvedValue(fakeStore() as never);

    const result = await hydrateWithBackoff({ keys: KEYS, retryFloorMs: 0 }, fast);

    expect(loadMock).toHaveBeenCalledTimes(3);
    expect(result.applied).toContain('MONGO_URL');
    expect(process.env.MONGO_URL).toBe(VALUES['shared:mongoUrl']);
  });

  it('retries a throttled store rather than giving up on it', async () => {
    loadMock
      .mockImplementationOnce(failingLoad({ status: 429 }) as never)
      .mockResolvedValue(fakeStore() as never);

    const result = await hydrateWithBackoff({ keys: KEYS, retryFloorMs: 0 }, fast);

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.label).toBe('prod');
  });

  it('arms the retry floor on a 403, so eight triggers cost one request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockImplementation(failingLoad({ status: 403 }) as never);

    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ConfigLoadError);
    expect((first as ConfigLoadError).statusCode).toBe(403);

    vi.advanceTimersByTime(1_000);
    for (let i = 0; i < 7; i++) {
      const again = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ConfigFloorError);
      expect((again as ConfigFloorError).cause).toBe(first);
    }

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('arms the retry floor on a throttled store, which is when it matters most', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockImplementation(failingLoad({ status: 429 }) as never);

    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    vi.advanceTimersByTime(1_000);
    const again = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);

    expect((again as ConfigFloorError).cause).toBe(first);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Numbers that turn a safeguard off are input errors, caught before any request. A NaN floor makes
 * every floor comparison false — the quota invariant failing open — and a zero or NaN backoff
 * delay turns the loop into a spin.
 */
describe('timing options are checked before any request', () => {
  it.each([
    ['retryFloorMs', Number.NaN],
    ['retryFloorMs', -1],
    ['retryFloorMs', Number.POSITIVE_INFINITY],
    ['timeoutMs', Number.NaN],
    ['timeoutMs', 0],
    ['timeoutMs', -5],
    ['timeoutMs', Number.POSITIVE_INFINITY],
    ['timeoutMs', 2 ** 31],
  ])('rejects %s = %s', async (name, value) => {
    loadMock.mockResolvedValue(fakeStore() as never);

    const error = await hydrate({ keys: KEYS, [name]: value }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigInputError);
    expect((error as Error).message).toContain(name);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it.each([
    ['initialMs', Number.NaN],
    ['initialMs', 0],
    ['initialMs', -1],
    ['initialMs', Number.POSITIVE_INFINITY],
    ['maxMs', Number.NaN],
    ['maxMs', 0],
    ['maxMs', Number.POSITIVE_INFINITY],
  ])('rejects backoff %s = %s instead of looping', async (name, value) => {
    loadMock.mockResolvedValue(fakeStore() as never);

    const error = await hydrateWithBackoff({ keys: KEYS }, { ...fast, [name]: value }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ConfigInputError);
    expect((error as Error).message).toContain(name);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('allows a huge finite floor, and a floor of zero', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, retryFloorMs: Number.MAX_SAFE_INTEGER });
    resetHydration();
    await hydrate({ keys: KEYS, retryFloorMs: 0, timeoutMs: 2 ** 31 - 1 });

    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});
