/**
 * `retryAfterMs(error)` — how long to wait after any rejection from `hydrate()`, so a caller never
 * recomputes the floor from `hydrationStatus()` and a hardcoded copy of the margin.
 *
 * A fail-fast consumer sends it as `Retry-After`; a message handler waits it once before its
 * second attempt. It must make no request, give nothing for an input error (waiting won't fix
 * it), and carry the same margin a `ConfigFloorError` does, so waiting exactly that long lands
 * outside the floor.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import {
  ConfigFloorError,
  ConfigInputError,
  DEFAULT_RETRY_FLOOR_MS,
  hydrate,
  hydrationStatus,
  resetHydration,
  retryAfterMs,
} from '../src/index';
import {
  KEYS,
  failingLoadAfterRead,
  fakeStore,
  providerArgumentError,
  providerFailoverError,
  restoreEnv,
  snapshotEnv,
} from './helpers';

/** What the floor's wait carries on top of the exact time, so a timer firing early still clears it. */
const MARGIN_MS = 50;

vi.mock('@azure/app-configuration-provider', () => ({ load: vi.fn() }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken() {
      return Promise.resolve(null);
    }
  },
}));

const loadMock = vi.mocked(load);
const quiet = { log: () => {} };
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = snapshotEnv();
  resetHydration();
  loadMock.mockReset();
  process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
  process.env.APP_CONFIG_LABEL = 'prod';
  delete process.env.WEBSITE_INSTANCE_ID;
  for (const variable of Object.values(KEYS)) delete process.env[variable];
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv(env);
});

describe('retryAfterMs', () => {
  it('is a floor rejection’s own retryAfterMs', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet }).catch(() => undefined);
    vi.advanceTimersByTime(4_000);

    const floor = (await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet }).catch(
      (e: unknown) => e
    )) as ConfigFloorError;

    expect(floor).toBeInstanceOf(ConfigFloorError);
    expect(retryAfterMs(floor)).toBe(floor.retryAfterMs);
    expect(retryAfterMs(floor)).toBe(26_000 + MARGIN_MS);
  });

  it('is the time until the floor a fresh failure armed opens, plus the margin', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const fresh = await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet }).catch((e: unknown) => e);

    expect(retryAfterMs(fresh)).toBe(30_000 + MARGIN_MS);
    vi.advanceTimersByTime(10_000);
    expect(retryAfterMs(fresh)).toBe(20_000 + MARGIN_MS);
  });

  it('agrees with hydrationStatus().nextAttemptAt, plus the margin', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const fresh = await hydrate({ keys: KEYS, retryFloorMs: 45_000, logger: quiet }).catch((e: unknown) => e);
    vi.advanceTimersByTime(1_234);

    const { nextAttemptAt } = hydrationStatus(KEYS);
    expect(retryAfterMs(fresh)).toBe(nextAttemptAt! - Date.now() + MARGIN_MS);
  });

  it('measures with the floor of the attempt that armed it, and the default when none was given', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const fresh = await hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e);

    expect(retryAfterMs(fresh)).toBe(DEFAULT_RETRY_FLOOR_MS + MARGIN_MS);
  });

  it('rounds a fractional wait up', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const fresh = await hydrate({ keys: KEYS, retryFloorMs: 30_000.4, logger: quiet }).catch((e: unknown) => e);

    expect(retryAfterMs(fresh)).toBe(30_001 + MARGIN_MS);
  });

  it('lets a caller who waits exactly that long, on a timer 1 ms early, reach the store', async () => {
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore() as never);
    const fresh = await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet }).catch((e: unknown) => e);

    vi.advanceTimersByTime(retryAfterMs(fresh)! - 1);
    const result = await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet });

    expect(result.applied).toContain('MONGO_URL');
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('is undefined once the floor has opened', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const fresh = await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet }).catch((e: unknown) => e);

    vi.advanceTimersByTime(30_000);
    expect(retryAfterMs(fresh)).toBeUndefined();
  });

  it('is undefined for a fresh failure with a floor of zero', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const fresh = await hydrate({ keys: KEYS, retryFloorMs: 0, logger: quiet }).catch((e: unknown) => e);

    expect(retryAfterMs(fresh)).toBeUndefined();
  });

  it('is undefined for an input error rejected before any request — waiting won’t fix it', async () => {
    delete process.env.APP_CONFIG_LABEL;
    const input = await hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e);

    expect(input).toBeInstanceOf(ConfigInputError);
    expect(retryAfterMs(input)).toBeUndefined();
  });

  it('is undefined for an input error that reached the store, although it armed the floor', async () => {
    loadMock.mockImplementation(failingLoadAfterRead(providerArgumentError('bad')) as never);
    const input = await hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e);

    expect(input).toBeInstanceOf(ConfigInputError);
    expect((input as ConfigInputError).reachedStore).toBe(true);
    expect(hydrationStatus(KEYS).nextAttemptAt).toBeDefined();
    expect(retryAfterMs(input)).toBeUndefined();
  });

  it('is undefined for anything else when no floor is armed', () => {
    expect(retryAfterMs(new Error('unrelated'))).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
  });

  it('makes no request, in any state', async () => {
    const errors: unknown[] = [undefined, new Error('none yet')];
    loadMock.mockRejectedValue(providerFailoverError());
    errors.push(await hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e));
    errors.push(await hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e));
    const calls = loadMock.mock.calls.length;

    for (const error of errors) retryAfterMs(error);
    vi.advanceTimersByTime(DEFAULT_RETRY_FLOOR_MS);
    for (const error of errors) retryAfterMs(error);

    expect(loadMock).toHaveBeenCalledTimes(calls);
    expect(calls).toBe(1);
  });
});
