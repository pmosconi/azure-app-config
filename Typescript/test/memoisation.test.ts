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
import {
  ConfigFloorError,
  ConfigInputError,
  ConfigLoadError,
  DEFAULT_RETRY_FLOOR_MS,
  hydrate,
  hydrateWithBackoff,
  hydrationStatus,
  resetHydration,
} from '../src/index';
import { KEYS, VALUES, fakeStore, providerFailoverError, restoreEnv, snapshotEnv } from './helpers';

/** What ConfigFloorError adds to the exact wait, so a timer firing a little early still clears it. */
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
  it('rejects inside the floor with a ConfigFloorError, without touching the store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ConfigLoadError);
    expect(loadMock).toHaveBeenCalledTimes(1);

    // Eight queue triggers arriving a second later must not become eight more store requests.
    vi.advanceTimersByTime(1_000);
    for (let i = 0; i < 8; i++) {
      const again = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ConfigFloorError);
      expect((again as ConfigFloorError).cause).toBe(first);
      expect((again as ConfigFloorError).retryAfterMs).toBe(29_000 + MARGIN_MS);
    }

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('is distinguishable from a fresh failure by class, not by message', async () => {
    // 0.1.0 re-threw the previous error object itself, so a caller could not tell a re-throw from
    // a new failure, and telemetry counted every re-throw as a new exception. A floor rejection
    // must match neither fresh-failure class — a catch on ConfigLoadError counts store failures,
    // and a catch on ConfigInputError stops a backoff loop.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    const again = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);

    expect(again).not.toBe(first);
    expect(again).toBeInstanceOf(Error);
    expect(again).not.toBeInstanceOf(ConfigLoadError);
    expect(again).not.toBeInstanceOf(ConfigInputError);
    expect((again as Error).name).toBe('ConfigFloorError');
  });

  it('counts retryAfterMs down to the floor, plus the margin', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);
    const waits: number[] = [];
    for (const step of [0, 10_000, 19_999]) {
      vi.advanceTimersByTime(step);
      const again = (await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(
        (e: unknown) => e
      )) as ConfigFloorError;
      waits.push(again.retryAfterMs);
    }

    expect(waits).toEqual([30_000 + MARGIN_MS, 20_000 + MARGIN_MS, 1 + MARGIN_MS]);
    expect(loadMock).toHaveBeenCalledTimes(1);

    // The floor itself is exact: the millisecond it opens, the next call reaches the store.
    vi.advanceTimersByTime(1);
    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('rounds a fractional wait up, never down', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    await hydrate({ keys: KEYS, retryFloorMs: 30_000.4 }).catch(() => undefined);
    const again = (await hydrate({ keys: KEYS, retryFloorMs: 30_000.4 }).catch(
      (e: unknown) => e
    )) as ConfigFloorError;

    expect(again.retryAfterMs).toBe(30_001 + MARGIN_MS);
  });

  it('lets a caller whose timer fires a millisecond early still reach the store', async () => {
    // The README's Functions pattern waits retryAfterMs and tries once more. Timers can fire a
    // millisecond or so early against Date.now(); without the margin that retry lands inside the
    // floor, gets another ConfigFloorError, and the handler is back on the dead-letter path.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore() as never);
    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);
    vi.advanceTimersByTime(1_000);

    // The documented pattern, verbatim but for a sleep that fires 1 ms early.
    const earlySleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms - 1));
    const configured = async () => {
      try {
        return await hydrate({ keys: KEYS, retryFloorMs: 30_000 });
      } catch (error) {
        if (!(error instanceof ConfigFloorError)) throw error;
        await earlySleep(error.retryAfterMs);
        return await hydrate({ keys: KEYS, retryFloorMs: 30_000 });
      }
    };

    const pending = configured();
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.applied).toContain('MONGO_URL');
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('measures retryAfterMs with the calling floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);
    vi.advanceTimersByTime(5_000);
    const again = (await hydrate({ keys: KEYS, retryFloorMs: 60_000 }).catch(
      (e: unknown) => e
    )) as ConfigFloorError;

    expect(again.retryAfterMs).toBe(55_000 + MARGIN_MS);
  });

  it('exports its default, and uses it when no floor is given', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());
    expect(DEFAULT_RETRY_FLOOR_MS).toBe(30_000);

    await hydrate({ keys: KEYS }).catch(() => undefined);
    const again = (await hydrate({ keys: KEYS }).catch((e: unknown) => e)) as ConfigFloorError;
    expect(again.retryAfterMs).toBe(DEFAULT_RETRY_FLOOR_MS + MARGIN_MS);

    vi.advanceTimersByTime(DEFAULT_RETRY_FLOOR_MS);
    await hydrate({ keys: KEYS }).catch(() => undefined);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('is not moved by its own rejections — they are not store failures', async () => {
    // If a floor rejection counted as a failure, a steady trickle of messages would hold the
    // floor shut forever and the store would never be asked again.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);
    const failedAt = hydrationStatus(KEYS).failedAt;
    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(1_000);
      await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);
    }
    expect(hydrationStatus(KEYS).failedAt).toBe(failedAt);
    expect(loadMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    const result = await hydrate({ keys: KEYS, retryFloorMs: 30_000 });

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(result.applied).toContain('MONGO_URL');
  });

  it('is global, because the store’s quota is — a second key map is held back too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toThrow();
    vi.advanceTimersByTime(1_000);
    await expect(
      hydrate({ keys: { 'myapp:httpPort': 'HTTP_PORT' }, retryFloorMs: 30_000 })
    ).rejects.toBeInstanceOf(ConfigFloorError);

    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('attempts again once the floor has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore() as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toThrow();
    expect(loadMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_999);
    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toBeInstanceOf(
      ConfigFloorError
    );
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

/**
 * A floor rejection is not a failed attempt, so the backoff loop must not treat it as one: no
 * onError, no "Configuration load failed" line, no doubling of the delay. Treating it as a failure
 * is the phantom double-count ConfigFloorError exists to prevent, and it drifts the schedule of
 * real attempts off the floor.
 */
describe('hydrateWithBackoff and the floor', () => {
  const T0 = Date.parse('2026-09-20T00:00:00Z');

  function loadFailingTimes(failures: number, times: number[]) {
    loadMock.mockImplementation((async () => {
      times.push(Date.now() - T0);
      if (times.length <= failures) throw providerFailoverError();
      return fakeStore();
    }) as never);
  }

  it('sleeps to the floor instead of reporting it, and keeps the real schedule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const times: number[] = [];
    loadFailingTimes(2, times);
    const reported: [unknown, number][] = [];

    const done = hydrateWithBackoff(
      { keys: KEYS, retryFloorMs: 30_000 },
      { initialMs: 5_000, maxMs: 600_000, onError: (error, next) => reported.push([error, next]) }
    );
    await vi.advanceTimersByTimeAsync(300_000);
    const result = await done;

    // Fail at 0; the 5 s delay is shorter than the floor, so the next attempt is when it opens.
    // Fail again; the delay is 10 s — doubled once, for one real failure — and the floor wins
    // again. onError is told when the next attempt really happens, not the backoff delay.
    expect(times).toEqual([0, 30_000 + MARGIN_MS, 60_000 + 2 * MARGIN_MS]);
    expect(reported.map(([, next]) => next)).toEqual([30_000 + MARGIN_MS, 30_000 + MARGIN_MS]);
    expect(reported.every(([error]) => error instanceof ConfigLoadError)).toBe(true);
    expect(result.applied).toContain('MONGO_URL');
  });

  it('does not log a floor rejection as a failed load', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const times: number[] = [];
    loadFailingTimes(1, times);
    const logger = { log: vi.fn(), error: vi.fn() };

    const done = hydrateWithBackoff(
      { keys: KEYS, retryFloorMs: 30_000, logger },
      { initialMs: 1_000, maxMs: 600_000 }
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await done;

    // One real failure, one line — not one more for every floor rejection in between.
    expect(logger.error).toHaveBeenCalledTimes(1);
    // And it says when the next attempt will really be: at the floor, not after the 1 s delay.
    expect(logger.error.mock.calls[0]![0]).toMatch(/^Configuration load failed, retrying in 30\.05s/);
    expect(times).toEqual([0, 30_000 + MARGIN_MS]);
  });

  it('reports the backoff delay when it outlasts the floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const times: number[] = [];
    loadFailingTimes(1, times);
    const reported: number[] = [];

    const done = hydrateWithBackoff(
      { keys: KEYS, retryFloorMs: 30_000 },
      { initialMs: 45_000, maxMs: 600_000, onError: (_error, next) => reported.push(next) }
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await done;

    expect(reported).toEqual([45_000]);
    expect(times).toEqual([0, 45_000]);
  });

  it('never hands setTimeout more than it honours, so a huge floor cannot spin', async () => {
    // Node turns a delay past 2^31-1 ms into 1 ms. A floor of Number.MAX_SAFE_INTEGER — allowed —
    // would otherwise make both the failure wait and the floor wait return at once, forever.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    loadMock.mockRejectedValue(providerFailoverError());
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const huge = Number.MAX_SAFE_INTEGER;
    const reported: number[] = [];

    void hydrateWithBackoff(
      { keys: KEYS, retryFloorMs: huge },
      { initialMs: 1, maxMs: 2, onError: (_error, next) => reported.push(next) }
    );
    // Let that first attempt fail and arm the floor, so the second loop meets it.
    await vi.advanceTimersByTimeAsync(0);
    void hydrateWithBackoff(
      { keys: { 'myapp:httpPort': 'HTTP_PORT' }, retryFloorMs: huge },
      { initialMs: 1, maxMs: 2, onError: (_error, next) => reported.push(next) }
    );
    await vi.advanceTimersByTimeAsync(60_000);

    const delays = timeouts.mock.calls.map(([, ms]) => ms ?? 0);
    expect(delays.length).toBeGreaterThan(0);
    expect(delays.length).toBeLessThan(10);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeGreaterThan(2 ** 31 - 1);
    timeouts.mockRestore();
    resetHydration();
  });
});
