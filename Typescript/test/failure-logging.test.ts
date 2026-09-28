/**
 * `hydrate()` reports a failed attempt itself — once, through the logger of the call that started
 * it — so a caller no longer writes its own failure line and deduplicates it.
 *
 * Every caller that was not `hydrateWithBackoff` used to log in its own `catch`. Callers joining
 * one attempt all receive the same rejection, so that meant one line per waiting request unless
 * the caller deduplicated on the error object, and one line per call inside the floor unless it
 * left `ConfigFloorError` out. Two fail-fast consumers carried the same sixty lines to do this.
 * `hydrateWithBackoff` is unchanged: its `onError` already reports every failure, with the delay,
 * and a container consumer with a custom `onError` must not get a second line per failure.
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
  failingLoad,
  failingLoadAfterRead,
  fakeStore,
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
let env: NodeJS.ProcessEnv;

/** The text two fail-fast consumers log today, so deleting their line leaves the logs unchanged. */
const failed = (error: unknown) => `Configuration load failed: ${(error as Error).message}`;

function logger() {
  return { log: vi.fn(), error: vi.fn() };
}

/** Every line a logger received that reports a failure, from either method. */
function failureLines(log: { log: ReturnType<typeof vi.fn>; error?: ReturnType<typeof vi.fn> }): string[] {
  return [...log.log.mock.calls, ...(log.error?.mock.calls ?? [])]
    .map(([line]) => String(line))
    .filter(line => line.startsWith('Configuration load failed'));
}

beforeEach(() => {
  env = snapshotEnv();
  resetHydration();
  loadMock.mockReset();
  process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
  process.env.APP_CONFIG_LABEL = 'prod';
  delete process.env.APP_CONFIG_CONNECTION_STRING;
  delete process.env.NODE_ENV;
  delete process.env.WEBSITE_INSTANCE_ID;
  for (const variable of Object.values(KEYS)) delete process.env[variable];
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv(env);
});

describe('a failed attempt is logged once, by the call that started it', () => {
  it('logs the failure through logger.error, in the text consumers log today', async () => {
    const log = logger();
    loadMock.mockImplementation(failingLoad({ status: 403 }) as never);

    const error = await hydrate({ keys: KEYS, logger: log }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigLoadError);
    expect(log.error.mock.calls).toEqual([[failed(error)]]);
    // It names the store, the label and the cause, because that is what the message says.
    expect(log.error.mock.calls[0]![0]).toMatch(
      /^Configuration load failed: Could not read App Configuration at https:\/\/example\.invalid, label prod: .*403/
    );
    expect(log.log).not.toHaveBeenCalled();
  });

  it('falls back to logger.log when the logger has no error method', async () => {
    const log = { log: vi.fn() };
    loadMock.mockRejectedValue(providerFailoverError());

    const error = await hydrate({ keys: KEYS, logger: log }).catch((e: unknown) => e);

    expect(log.log.mock.calls).toEqual([[failed(error)]]);
  });

  it('logs through console.error when no logger is passed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadMock.mockRejectedValue(providerFailoverError());
    try {
      const error = await hydrate({ keys: KEYS }).catch((e: unknown) => e);

      expect(consoleError.mock.calls).toEqual([[failed(error)]]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs a missing key, which names the keys', async () => {
    const log = logger();
    loadMock.mockResolvedValue(fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']! }) as never);

    const error = await hydrate({ keys: KEYS, logger: log }).catch((e: unknown) => e);

    expect(log.error.mock.calls).toEqual([[failed(error)]]);
    expect(log.error.mock.calls[0]![0]).toContain('shared:serviceBus');
    expect(log.error.mock.calls[0]![0]).toContain('myapp:httpPort');
  });

  it('logs one line for concurrent callers joining one attempt — and hands each the same object', async () => {
    const first = logger();
    const second = logger();
    const third = logger();
    let failIt: (error: unknown) => void = () => {};
    loadMock.mockImplementation(() => new Promise((_resolve, reject) => (failIt = reject)));

    const calls = [
      hydrate({ keys: KEYS, logger: first }).catch((e: unknown) => e),
      hydrate({ keys: KEYS, logger: second }).catch((e: unknown) => e),
      hydrate({ keys: KEYS, logger: third }).catch((e: unknown) => e),
    ];
    failIt(providerFailoverError());
    const [a, b, c] = await Promise.all(calls);

    expect(loadMock).toHaveBeenCalledTimes(1);
    // The README promises this identity; the consumers' old dedupe relied on it.
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(first.error.mock.calls).toEqual([[failed(a)]]);
    expect(second.error).not.toHaveBeenCalled();
    expect(third.error).not.toHaveBeenCalled();
  });

  it('logs nothing for a floor rejection — it attempted nothing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    const log = logger();
    loadMock.mockRejectedValue(providerFailoverError());

    await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: log }).catch(() => undefined);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000);
      const again = await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: log }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ConfigFloorError);
    }

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('logs each real attempt once, when the floor lets it through', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    const log = logger();
    loadMock.mockRejectedValue(providerFailoverError());

    await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: log }).catch(() => undefined);
    vi.advanceTimersByTime(30_000);
    await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: log }).catch(() => undefined);

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('logs no failure for a success, nor for the memo hits after it', async () => {
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, logger: log });
    await hydrate({ keys: KEYS, logger: log });

    expect(log.error).not.toHaveBeenCalled();
    expect(failureLines(log)).toEqual([]);
  });

  it('never logs a value — only what the message names', async () => {
    // A connection string, values in the store and a local value that differs: none may appear.
    const connectionString = 'Endpoint=https://example.invalid;Id=not-an-id;Secret=not-a-secret';
    const log = logger();
    process.env.MONGO_URL = 'mongodb://127.0.0.1:27017/local';
    loadMock.mockResolvedValue(
      fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']!, 'myapp:httpPort': { port: 8080 } }) as never
    );

    await hydrate({ keys: KEYS, connectionString, localOverridesWin: false, logger: log }).catch(() => undefined);
    resetHydration();
    loadMock.mockImplementation(failingLoad({ status: 403 }) as never);
    await hydrate({ keys: KEYS, connectionString, logger: log }).catch(() => undefined);

    const lines = failureLines(log);
    expect(lines).toHaveLength(2);
    for (const value of [...Object.values(VALUES), 'not-a-secret', 'not-an-id', connectionString, '127.0.0.1', '8080']) {
      for (const line of lines) expect(line).not.toContain(value);
    }
  });
});

describe('a call rejected before any request is logged once per message', () => {
  it('logs the same bad input once, however often it is called', async () => {
    delete process.env.APP_CONFIG_ENDPOINT;
    const log = logger();

    const errors = [];
    for (let i = 0; i < 3; i++) errors.push(await hydrate({ keys: KEYS, logger: log }).catch((e: unknown) => e));

    expect(errors.every(error => error instanceof ConfigInputError)).toBe(true);
    expect(log.error.mock.calls).toEqual([[failed(errors[0])]]);
    expect(log.error.mock.calls[0]![0]).toBe(
      'Configuration load failed: Neither APP_CONFIG_ENDPOINT nor APP_CONFIG_CONNECTION_STRING is set'
    );
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('logs a different bad input with its own line', async () => {
    const log = logger();

    await hydrate({ keys: { 'shared:*': 'ALL' }, logger: log }).catch(() => undefined);
    await hydrate({ keys: KEYS, retryFloorMs: Number.NaN, logger: log }).catch(() => undefined);
    await hydrate({ keys: { 'shared:*': 'ALL' }, logger: log }).catch(() => undefined);
    await hydrate({ keys: KEYS, label: 'prod,staging', logger: log }).catch(() => undefined);

    const lines = log.error.mock.calls.map(([line]) => line as string);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Configuration load failed: Key "shared:\*" is a filter/);
    expect(lines[1]).toMatch(/^Configuration load failed: retryFloorMs must be/);
    expect(lines[2]).toMatch(/^Configuration load failed: Label "prod,staging" is a filter/);
  });

  it('logs it again after resetHydration, which clears what was said', async () => {
    delete process.env.APP_CONFIG_LABEL;
    const log = logger();

    await hydrate({ keys: KEYS, logger: log }).catch(() => undefined);
    resetHydration();
    await hydrate({ keys: KEYS, logger: log }).catch(() => undefined);

    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('logs the provider’s own pre-request input error once per message, though each call attempts', async () => {
    // reachedStore: false arms no floor, so every call is a new attempt — but it is the same
    // rejection before any request as validate()'s, and is said once.
    const log = logger();
    loadMock.mockRejectedValue(providerPreRequestError());

    const first = await hydrate({ keys: KEYS, logger: log }).catch((e: unknown) => e);
    const second = await hydrate({ keys: KEYS, logger: log }).catch((e: unknown) => e);

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(first).toBeInstanceOf(ConfigInputError);
    expect((first as ConfigInputError).reachedStore).toBe(false);
    expect(second).not.toBe(first);
    expect(log.error.mock.calls).toEqual([[failed(first)]]);

    loadMock.mockRejectedValue(providerPreRequestError('Invalid endpoint URL.'));
    await hydrate({ keys: KEYS, logger: log }).catch(() => undefined);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('logs an input error that reached the store once per attempt, like any attempt', async () => {
    const log = logger();
    loadMock.mockImplementation(failingLoadAfterRead(providerArgumentError('bad')) as never);

    const first = await hydrate({ keys: KEYS, retryFloorMs: 0, logger: log }).catch((e: unknown) => e);
    await hydrate({ keys: KEYS, retryFloorMs: 0, logger: log }).catch(() => undefined);

    expect((first as ConfigInputError).reachedStore).toBe(true);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});

describe('logging never changes the outcome', () => {
  /** Calls `start` and returns its promise, failing the test if it throws synchronously instead. */
  function noSyncThrow<T>(start: () => Promise<T>): Promise<T> {
    let promise: Promise<T> | undefined;
    expect(() => {
      promise = start();
    }).not.toThrow();
    return promise!;
  }

  it('returns a rejected promise, not a synchronous throw, for hydrate(undefined) and hydrate(null)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(noSyncThrow(() => hydrate(undefined as never))).rejects.toBeInstanceOf(TypeError);
      await expect(noSyncThrow(() => hydrate(null as never))).rejects.toBeInstanceOf(TypeError);
      expect(loadMock).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns a rejected promise when the logger getter throws, before or during an attempt', async () => {
    const withThrowingLogger = (options: object) =>
      Object.defineProperty({ ...options }, 'logger', {
        get() {
          throw new Error('logger getter down');
        },
      }) as never;
    loadMock.mockRejectedValue(providerFailoverError());

    delete process.env.APP_CONFIG_ENDPOINT;
    const before = await noSyncThrow(() => hydrate(withThrowingLogger({ keys: KEYS }))).catch((e: unknown) => e);
    expect(before).toBeInstanceOf(ConfigInputError);

    process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
    const during = await noSyncThrow(() => hydrate(withThrowingLogger({ keys: KEYS }))).catch((e: unknown) => e);
    expect(during).toBeInstanceOf(Error);
  });

  it('rejects with the load’s own error when the logger throws', async () => {
    const original = providerFailoverError();
    loadMock.mockRejectedValue(original);
    const throwing = {
      log: () => {
        throw new Error('logger down');
      },
      error: () => {
        throw new Error('logger down');
      },
    };

    const error = await hydrate({ keys: KEYS, logger: throwing }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigLoadError);
    expect((error as ConfigLoadError).cause).toBe(original);
  });

  it('rejects with the input error when the logger throws on a pre-request rejection', async () => {
    delete process.env.APP_CONFIG_ENDPOINT;
    const throwing = {
      log: () => {
        throw new Error('logger down');
      },
    };

    const error = await hydrate({ keys: KEYS, logger: throwing }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigInputError);
    expect((error as Error).message).toMatch(/^Neither APP_CONFIG_ENDPOINT/);
  });

  it('leaves no unhandled rejection behind an async logger that rejects', async () => {
    // vitest fails the run on an unhandled rejection, so this passing is the assertion.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    loadMock.mockRejectedValue(providerFailoverError());
    try {
      const error = await hydrate({
        keys: KEYS,
        logger: { log: () => {}, error: (() => Promise.reject(new Error('logger down'))) as never },
      }).catch((e: unknown) => e);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(error).toBeInstanceOf(ConfigLoadError);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('still arms the floor when the logger throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());
    const throwing = {
      log: () => {
        throw new Error('logger down');
      },
    };

    await hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: throwing }).catch(() => undefined);
    const again = await hydrate({ keys: KEYS, retryFloorMs: 30_000 }).catch((e: unknown) => e);

    expect(again).toBeInstanceOf(ConfigFloorError);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});

describe('hydrateWithBackoff reports through onError alone', () => {
  it('adds no line of its own per failure when onError is custom', async () => {
    const log = logger();
    const reported: unknown[] = [];
    loadMock
      .mockRejectedValueOnce(providerFailoverError())
      .mockRejectedValueOnce(providerFailoverError())
      .mockResolvedValue(fakeStore() as never);

    await hydrateWithBackoff(
      { keys: KEYS, retryFloorMs: 0, logger: log },
      { initialMs: 1, maxMs: 2, onError: error => reported.push(error) }
    );

    expect(reported).toHaveLength(2);
    expect(log.error).not.toHaveBeenCalled();
    expect(failureLines(log)).toEqual([]);
  });

  it('logs exactly one line per failure with the default onError — the one it always logged', async () => {
    const log = logger();
    loadMock
      .mockRejectedValueOnce(providerFailoverError())
      .mockRejectedValueOnce(providerFailoverError())
      .mockResolvedValue(fakeStore() as never);

    await hydrateWithBackoff({ keys: KEYS, retryFloorMs: 0, logger: log }, { initialMs: 1, maxMs: 2 });

    const lines = failureLines(log);
    expect(lines).toHaveLength(2);
    expect(lines.every(line => line.startsWith('Configuration load failed, retrying in '))).toBe(true);
  });

  it('keeps retrying until success when the default onError meets a logger that throws', async () => {
    const throwing = {
      log: vi.fn(),
      error: vi.fn((message: string) => {
        throw new Error(`logger down while writing: ${message.length} characters`);
      }),
    };
    loadMock
      .mockRejectedValueOnce(providerFailoverError())
      .mockRejectedValueOnce(providerFailoverError())
      .mockResolvedValue(fakeStore() as never);

    const result = await hydrateWithBackoff({ keys: KEYS, retryFloorMs: 0, logger: throwing }, { initialMs: 1, maxMs: 2 });

    expect(result.applied).toContain('MONGO_URL');
    expect(loadMock).toHaveBeenCalledTimes(3);
    expect(throwing.error).toHaveBeenCalledTimes(2);
    expect(throwing.error.mock.calls[0]![0]).toMatch(/^Configuration load failed, retrying in 0\.001s: /);
  });

  it('keeps retrying, with nothing unhandled, when the default onError meets an async logger that rejects', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    // A plain function, not vi.fn(): a spy handles the promises it returns, which would hide the
    // very rejection this test is about.
    let reports = 0;
    const rejecting = {
      log: () => {},
      error: () => {
        reports++;
        return Promise.reject(new Error('logger down'));
      },
    };
    loadMock
      .mockRejectedValueOnce(providerFailoverError())
      .mockRejectedValueOnce(providerFailoverError())
      .mockResolvedValue(fakeStore() as never);
    try {
      const result = await hydrateWithBackoff(
        { keys: KEYS, retryFloorMs: 0, logger: rejecting as never },
        { initialMs: 1, maxMs: 2 }
      );
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(result.applied).toContain('MONGO_URL');
      expect(reports).toBe(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('leaves a custom onError that throws to end the loop, as it always did — caller code', async () => {
    const own = new Error('onError bug');
    loadMock.mockRejectedValue(providerFailoverError());

    await expect(
      hydrateWithBackoff(
        { keys: KEYS, retryFloorMs: 0, logger: logger() },
        {
          initialMs: 1,
          maxMs: 2,
          onError: () => {
            throw own;
          },
        }
      )
    ).rejects.toBe(own);
  });

  it('does not log the ConfigInputError it rethrows before any request', async () => {
    delete process.env.APP_CONFIG_ENDPOINT;
    const log = logger();

    await expect(
      hydrateWithBackoff({ keys: KEYS, logger: log }, { initialMs: 1, maxMs: 2, onError: () => {} })
    ).rejects.toBeInstanceOf(ConfigInputError);
    await expect(hydrateWithBackoff({ keys: KEYS, logger: log }, { initialMs: 0 })).rejects.toBeInstanceOf(
      ConfigInputError
    );

    expect(failureLines(log)).toEqual([]);
  });

  it('does not spend hydrate()’s once-per-message line, so a later hydrate() still reports it', async () => {
    delete process.env.APP_CONFIG_ENDPOINT;
    const log = logger();

    await hydrateWithBackoff({ keys: KEYS, logger: log }, { onError: () => {} }).catch(() => undefined);
    await hydrate({ keys: KEYS, logger: log }).catch(() => undefined);

    expect(failureLines(log)).toHaveLength(1);
  });
});
