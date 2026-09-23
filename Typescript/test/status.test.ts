/**
 * hydrationStatus — configuration health without spending the quota.
 *
 * A health endpoint that calls hydrate() to learn whether configuration loaded may start a store
 * attempt on every ping. On a Free store (1,000 requests a day), pings from a few instances during
 * a failure that persists spend the day's quota in about an hour, and no finite floor fixes that.
 * So the status is a read of the bookkeeping and nothing else: every test here asserts that
 * `load()` was not called by it, in every state, including before any attempt and while one is in
 * flight.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import {
  ConfigFloorError,
  ConfigInputError,
  ConfigLoadError,
  hydrate,
  hydrationStatus,
  resetHydration,
} from '../src/index';
import {
  KEYS,
  fakeStore,
  failingLoadAfterRead,
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
const T0 = Date.parse('2026-09-20T00:00:00Z');
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
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv(env);
});

/** Read the status many times and prove none of the reads reached the provider. */
function statusWithoutLoading(label?: string) {
  const before = loadMock.mock.calls.length;
  let status = hydrationStatus(KEYS, label);
  for (let i = 0; i < 50; i++) status = hydrationStatus(KEYS, label);
  expect(loadMock.mock.calls.length).toBe(before);
  return status;
}

describe('hydrationStatus makes no request, in every state', () => {
  it('none — before any attempt, and starts none', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    expect(statusWithoutLoading()).toEqual({ state: 'none' });

    // Nothing was started behind the caller's back: the first real call is the first attempt.
    await hydrate({ keys: KEYS });
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('pending — while an attempt is in flight', async () => {
    let finish: (value: unknown) => void = () => {};
    loadMock.mockImplementation(() => new Promise(resolve => (finish = resolve)) as never);

    const inFlight = hydrate({ keys: KEYS });
    expect(loadMock).toHaveBeenCalledTimes(1);

    expect(statusWithoutLoading()).toEqual({ state: 'pending' });

    finish(fakeStore());
    await inFlight;
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('loaded — with the same loadedAt the result carries', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);
    const result = await hydrate({ keys: KEYS });

    const status = statusWithoutLoading();

    expect(status).toEqual({ state: 'loaded', loadedAt: T0 });
    expect(status.loadedAt).toBe(result.loadedAt);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('failing — inside the floor, with the fresh error and when the floor opens', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    vi.advanceTimersByTime(1_000);
    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);

    const status = statusWithoutLoading();

    expect(status.state).toBe('failing');
    expect(status.failedAt).toBe(T0);
    // The attempt's own error, never the floor rejection that came after it.
    expect(status.lastError).toBe(first);
    expect(status.lastError).toBeInstanceOf(ConfigLoadError);
    expect(status.nextAttemptAt).toBe(T0 + 30_000);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('failing — after the floor has opened, with no nextAttemptAt', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);
    vi.advanceTimersByTime(30_000);

    const status = statusWithoutLoading();

    expect(status.state).toBe('failing');
    expect(status.failedAt).toBe(T0);
    expect(status).not.toHaveProperty('nextAttemptAt');
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('pending — a retry in flight still carries the failure before it', async () => {
    let finish: (value: unknown) => void = () => {};
    loadMock
      .mockRejectedValueOnce(providerFailoverError())
      .mockImplementationOnce(() => new Promise(resolve => (finish = resolve)) as never);
    const first = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);
    vi.advanceTimersByTime(30_000);
    const retry = hydrate({ keys: KEYS, retryFloorMs: 30_000 });

    expect(statusWithoutLoading()).toEqual({ state: 'pending', failedAt: T0, lastError: first });

    finish(fakeStore());
    await retry;
    expect(statusWithoutLoading()).toEqual({ state: 'loaded', loadedAt: T0 + 30_000 });
  });
});

describe('what the status is about', () => {
  it('is per key map and label, like the memo', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);
    await hydrate({ keys: KEYS });

    expect(hydrationStatus(KEYS).state).toBe('loaded');
    expect(hydrationStatus(KEYS, 'prod').state).toBe('loaded');
    expect(hydrationStatus(KEYS, 'staging').state).toBe('none');
    expect(hydrationStatus({ 'myapp:httpPort': 'HTTP_PORT' }).state).toBe('none');
    // Order-insensitive, like the memo.
    const reversed = Object.fromEntries(Object.entries(KEYS).reverse());
    expect(hydrationStatus(reversed).state).toBe('loaded');
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('resolves the label from APP_CONFIG_LABEL as hydrate does', async () => {
    process.env.APP_CONFIG_LABEL = 'staging';
    loadMock.mockResolvedValue(fakeStore() as never);
    await hydrate({ keys: KEYS });

    expect(hydrationStatus(KEYS).state).toBe('loaded');
    expect(hydrationStatus(KEYS, 'staging').state).toBe('loaded');
    expect(hydrationStatus(KEYS, 'prod').state).toBe('none');
  });

  it('reports a floor another key map armed, which will hold this one back too', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    await hydrate({ keys: { 'shared:mongoUrl': 'MONGO_URL' }, retryFloorMs: 30_000 }).catch(
      () => undefined
    );

    expect(statusWithoutLoading()).toEqual({ state: 'none', nextAttemptAt: T0 + 30_000 });
    await expect(hydrate({ keys: KEYS, retryFloorMs: 30_000 })).rejects.toBeInstanceOf(
      ConfigFloorError
    );
  });

  it('reports nextAttemptAt with the floor of the attempt that armed it', async () => {
    // hydrate() enforces each caller's own retryFloorMs; the status has no caller, so it reports
    // the arming attempt's. A caller with a shorter floor sees a shorter window — documented.
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore() as never);
    await hydrate({ keys: KEYS, retryFloorMs: 60_000 }).catch(() => undefined);
    vi.advanceTimersByTime(20_000);

    expect(statusWithoutLoading().nextAttemptAt).toBe(T0 + 60_000);
    await expect(hydrate({ keys: KEYS, retryFloorMs: 10_000 })).resolves.toBeDefined();
  });

  it('never reports nextAttemptAt when loaded, even with the floor closed', async () => {
    loadMock.mockResolvedValueOnce(fakeStore() as never).mockRejectedValue(providerFailoverError());
    await hydrate({ keys: KEYS });
    await hydrate({ keys: { 'shared:mongoUrl': 'MONGO_URL' }, retryFloorMs: 30_000 }).catch(
      () => undefined
    );

    expect(statusWithoutLoading()).toEqual({ state: 'loaded', loadedAt: T0 });
    expect(hydrationStatus({ 'shared:mongoUrl': 'MONGO_URL' }).nextAttemptAt).toBe(T0 + 30_000);
  });

  it('reports a store-rejected input error with the floor it armed', async () => {
    loadMock.mockImplementation(
      failingLoadAfterRead(providerArgumentError('Invalid value read from the store.')) as never
    );
    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);

    const status = statusWithoutLoading();

    expect(status.state).toBe('failing');
    expect(status.lastError).toBeInstanceOf(ConfigInputError);
    expect(status.nextAttemptAt).toBe(T0 + 30_000);
  });

  it('reports a pre-request input error with no floor, because it armed none', async () => {
    loadMock.mockImplementation(
      failingLoadWithNoRequest(
        providerPreRequestError()
      ) as never
    );
    await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch(() => undefined);

    const status = statusWithoutLoading();

    expect(status.state).toBe('failing');
    expect(status.lastError).toBeInstanceOf(ConfigInputError);
    expect(status).not.toHaveProperty('nextAttemptAt');
  });

  it('is cleared by resetHydration', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);
    await hydrate({ keys: KEYS });

    resetHydration();

    expect(hydrationStatus(KEYS)).toEqual({ state: 'none' });
  });

  it('needs no endpoint, because it never reaches the store', () => {
    delete process.env.APP_CONFIG_ENDPOINT;

    expect(hydrationStatus(KEYS)).toEqual({ state: 'none' });
  });

  it('throws ConfigInputError for a call hydrate would reject before any request', () => {
    expect(() => hydrationStatus({})).toThrow(ConfigInputError);
    expect(() => hydrationStatus({ 'shared:*': 'X' })).toThrow(ConfigInputError);
    delete process.env.APP_CONFIG_LABEL;
    expect(() => hydrationStatus(KEYS)).toThrow(/APP_CONFIG_LABEL/);
    expect(loadMock).not.toHaveBeenCalled();
  });
});

/**
 * The shape the backlog describes: handlers (or an appStart hook) do the loading, and the health
 * endpoint only reads. Pings through a whole outage and its recovery cost the store nothing.
 */
describe('a health endpoint beside handlers that load', () => {
  it('costs no request across an outage and its recovery', async () => {
    loadMock.mockRejectedValue(providerFailoverError());
    const handler = () => hydrate({ keys: KEYS }).catch(() => undefined);
    const health = () => (hydrationStatus(KEYS).state === 'failing' ? 503 : 200);

    expect(health()).toBe(200);
    await handler();
    const answers: number[] = [];
    for (let minute = 0; minute < 10; minute++) {
      answers.push(health());
      vi.advanceTimersByTime(60_000);
    }
    expect(answers.every(code => code === 503)).toBe(true);
    expect(loadMock).toHaveBeenCalledTimes(1);

    loadMock.mockResolvedValue(fakeStore() as never);
    await handler();
    expect(health()).toBe(200);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});
