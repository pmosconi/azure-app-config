/**
 * The rest of the documented behaviour: precedence, the missing-key report, the label, the
 * credential path and the startup timeout.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { hydrate, hydrateWithBackoff, resetHydration } from '../src/index';
import { KEYS, VALUES, fakeStore, providerFailoverError, restoreEnv, snapshotEnv } from './helpers';

vi.mock('@azure/app-configuration-provider', () => ({ load: vi.fn() }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    readonly kind = 'default';
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
  delete process.env.APP_CONFIG_CONNECTION_STRING;
  delete process.env.NODE_ENV;
  // Not deployed, unless a test says otherwise — which is what a test runner is.
  delete process.env.WEBSITE_INSTANCE_ID;
  for (const variable of Object.values(KEYS)) delete process.env[variable];
});

/** What App Service and Azure Functions inject on every instance. The value is irrelevant. */
function deployed(): void {
  process.env.WEBSITE_INSTANCE_ID = 'a1b2c3d4e5f6';
}

afterEach(() => restoreEnv(env));

describe('writing the environment', () => {
  it('writes every mapped variable and reports what it applied', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS });

    expect(process.env.MONGO_URL).toBe(VALUES['shared:mongoUrl']);
    expect(process.env.HTTP_PORT).toBe('8080');
    expect(result).toEqual({
      label: 'prod',
      applied: ['MONGO_URL', 'SERVICE_BUS_CONNECTION', 'HTTP_PORT'],
      kept: [],
      loadedAt: expect.any(Number),
    });
  });

  it('says when it loaded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    try {
      loadMock.mockResolvedValue(fakeStore() as never);

      const result = await hydrate({ keys: KEYS });

      expect(result.loadedAt).toBe(Date.parse('2026-09-20T00:00:00Z'));
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * localOverridesWin is a dev-only escape hatch: false in every deployed environment, true
 * locally. Its default is "not deployed", read from WEBSITE_INSTANCE_ID, and NODE_ENV plays no
 * part — in a Functions app NODE_ENV is an ordinary per-slot setting, and a staging slot carrying
 * `development` let leftover settings beat the store without a word, so the run proved nothing.
 */
describe('precedence', () => {
  it('lets the store win when deployed — even under NODE_ENV=development', async () => {
    deployed();
    process.env.NODE_ENV = 'development';
    process.env.MONGO_URL = 'mongodb://stale.invalid/app';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS });

    expect(process.env.MONGO_URL).toBe(VALUES['shared:mongoUrl']);
    expect(result.kept).toEqual([]);
    expect(result.applied).toContain('MONGO_URL');
  });

  it('lets the store win when deployed under any other NODE_ENV too', async () => {
    deployed();
    process.env.NODE_ENV = 'test';
    process.env.HTTP_PORT = '9000';
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });

    expect(process.env.HTTP_PORT).toBe('8080');
  });

  it('keeps the local value when not deployed — even under NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.MONGO_URL = 'mongodb://127.0.0.1:27017/local';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS });

    expect(process.env.MONGO_URL).toBe('mongodb://127.0.0.1:27017/local');
    expect(result.kept).toEqual(['MONGO_URL']);
    expect(result.applied).toEqual(['SERVICE_BUS_CONNECTION', 'HTTP_PORT']);
  });

  it('treats an empty WEBSITE_INSTANCE_ID as not deployed', async () => {
    process.env.WEBSITE_INSTANCE_ID = '';
    process.env.HTTP_PORT = '9000';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS });

    expect(result.kept).toEqual(['HTTP_PORT']);
  });

  it('reads the signal on every attempt, not once at import', async () => {
    process.env.HTTP_PORT = '9000';
    loadMock.mockResolvedValue(fakeStore() as never);

    const local = await hydrate({ keys: KEYS });
    resetHydration();
    deployed();
    const remote = await hydrate({ keys: KEYS });

    expect(local.kept).toEqual(['HTTP_PORT']);
    expect(remote.kept).toEqual([]);
    expect(process.env.HTTP_PORT).toBe('8080');
  });

  it('takes localOverridesWin: true from the caller on a deployed instance', async () => {
    deployed();
    process.env.HTTP_PORT = '9000';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS, localOverridesWin: true });

    expect(process.env.HTTP_PORT).toBe('9000');
    expect(result.kept).toEqual(['HTTP_PORT']);
  });

  it('takes localOverridesWin: false from the caller on a host with no signal', async () => {
    // Container Apps, Kubernetes, a VM: nothing injects WEBSITE_INSTANCE_ID, so the default reads
    // "not deployed". Those hosts pass false, and the store wins.
    process.env.NODE_ENV = 'development';
    process.env.HTTP_PORT = '9000';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS, localOverridesWin: false });

    expect(process.env.HTTP_PORT).toBe('8080');
    expect(result.kept).toEqual([]);
  });

  it('lets a local value stand in for a key the store has not got yet', async () => {
    // The README promises a .env line can point one variable at a local database "without
    // reaching into the store". Deciding precedence after the missing-key check broke that: the
    // load failed on a key the caller had already supplied.
    process.env.HTTP_PORT = '3000';
    loadMock.mockResolvedValue(
      fakeStore({
        'shared:mongoUrl': VALUES['shared:mongoUrl']!,
        'shared:serviceBus': VALUES['shared:serviceBus']!,
      }) as never
    );

    const result = await hydrate({ keys: KEYS });

    expect(result.kept).toEqual(['HTTP_PORT']);
    expect(process.env.HTTP_PORT).toBe('3000');
  });

  it('still fails on a missing key the local environment does not supply', async () => {
    loadMock.mockResolvedValue(
      fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']! }) as never
    );

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(/myapp:httpPort/);
  });

  it('treats an empty local value as absent', async () => {
    process.env.HTTP_PORT = '';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS });

    expect(process.env.HTTP_PORT).toBe('8080');
    expect(result.kept).toEqual([]);
  });
});

/**
 * The success line states the precedence mode and why, whether or not anything was kept. Precedence
 * hangs on a platform signal, so on a host where it is missing the first sign used to be a stale
 * value winning — and a consumer with no local settings left could never confirm it from the logs.
 * The 0.2.0 prefix is unchanged: the mode follows the variable list.
 */
describe('the success line states which side wins, and why', () => {
  const ALL = 'MONGO_URL, SERVICE_BUS_CONNECTION, HTTP_PORT';
  const LINE = `Configuration loaded from App Configuration, label prod: ${ALL}`;

  function logger() {
    return { log: vi.fn(), error: vi.fn() };
  }

  it('says the store wins because WEBSITE_INSTANCE_ID is present', async () => {
    deployed();
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, logger: log });

    expect(log.log.mock.calls).toEqual([[`${LINE} (store wins: WEBSITE_INSTANCE_ID present)`]]);
  });

  it('says the local environment wins because WEBSITE_INSTANCE_ID is absent — with nothing kept', async () => {
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS, logger: log });

    // Nothing was set locally, so nothing was kept: the mode is stated all the same.
    expect(result.kept).toEqual([]);
    expect(log.log.mock.calls).toEqual([[`${LINE} (local wins: WEBSITE_INSTANCE_ID absent)`]]);
  });

  it('counts an empty WEBSITE_INSTANCE_ID as absent, as precedence does', async () => {
    process.env.WEBSITE_INSTANCE_ID = '';
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, logger: log });

    expect(log.log.mock.calls).toEqual([[`${LINE} (local wins: WEBSITE_INSTANCE_ID absent)`]]);
  });

  it('names the option, not the signal, when localOverridesWin: true is passed', async () => {
    deployed();
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, localOverridesWin: true, logger: log });

    expect(log.log.mock.calls).toEqual([[`${LINE} (local wins: localOverridesWin option true)`]]);
  });

  it('names the option, not the signal, when localOverridesWin: false is passed', async () => {
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, localOverridesWin: false, logger: log });

    expect(log.log.mock.calls).toEqual([[`${LINE} (store wins: localOverridesWin option false)`]]);
  });

  it('states the decision, not the raw value, for the string "false" — which is truthy, so local wins', async () => {
    // A JavaScript caller, or one reading the option from an environment variable, can pass a
    // string. Precedence has always gone by truthiness; the line must agree with what happened.
    deployed();
    process.env.HTTP_PORT = '9000';
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS, localOverridesWin: 'false' as unknown as boolean, logger: log });

    expect(result.kept).toEqual(['HTTP_PORT']);
    expect(process.env.HTTP_PORT).toBe('9000');
    expect(log.log.mock.calls[0]![0]).toBe(
      'Configuration loaded from App Configuration, label prod: MONGO_URL, SERVICE_BUS_CONNECTION (local wins: localOverridesWin option true)'
    );
  });

  it('treats null as ?? does — the platform signal decides, and the line names the signal', async () => {
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);
    process.env.HTTP_PORT = '9000';

    deployed();
    const remote = await hydrate({ keys: KEYS, localOverridesWin: null as unknown as boolean, logger: log });
    resetHydration();
    delete process.env.WEBSITE_INSTANCE_ID;
    for (const variable of Object.values(KEYS)) delete process.env[variable];
    process.env.HTTP_PORT = '9000';
    const local = await hydrate({ keys: KEYS, localOverridesWin: null as unknown as boolean, logger: log });

    expect(remote.kept).toEqual([]);
    expect(local.kept).toEqual(['HTTP_PORT']);
    expect(log.log.mock.calls).toEqual([
      [`${LINE} (store wins: WEBSITE_INSTANCE_ID present)`],
      [
        'Configuration loaded from App Configuration, label prod: MONGO_URL, SERVICE_BUS_CONNECTION (local wins: WEBSITE_INSTANCE_ID absent)',
      ],
      ['Kept from the local environment: HTTP_PORT'],
    ]);
  });

  it('keeps the 0.2.0 prefix intact, so a matcher on it still matches', async () => {
    deployed();
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, logger: log });

    expect(log.log.mock.calls[0]![0]).toMatch(/^Configuration loaded from App Configuration, label prod: MONGO_URL/);
  });

  it('leaves the kept line as it was, and never logs a value', async () => {
    process.env.HTTP_PORT = '9000';
    process.env.MONGO_URL = 'mongodb://127.0.0.1:27017/local';
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, logger: log });

    expect(log.log.mock.calls).toEqual([
      [
        'Configuration loaded from App Configuration, label prod: SERVICE_BUS_CONNECTION (local wins: WEBSITE_INSTANCE_ID absent)',
      ],
      ['Kept from the local environment: MONGO_URL, HTTP_PORT'],
    ]);
    const logged = log.log.mock.calls.flat().join('\n');
    for (const value of [...Object.values(VALUES), '9000', 'mongodb://127.0.0.1:27017/local']) {
      expect(logged).not.toContain(value);
    }
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs once per successful attempt, not per call', async () => {
    deployed();
    const log = logger();
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, logger: log });
    await hydrate({ keys: KEYS, logger: log });

    expect(log.log).toHaveBeenCalledTimes(1);
  });

  it('reaches a warn-level logger unchanged — the Functions shape, which passes console.warn itself', async () => {
    // A Functions consumer passes { log: console.warn, error: console.error } so the line survives
    // a host.json that filters Information outside an invocation. It must keep working as passed.
    deployed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plain = vi.spyOn(console, 'log').mockImplementation(() => {});
    loadMock.mockResolvedValue(fakeStore() as never);
    try {
      await hydrate({ keys: KEYS, logger: { log: console.warn, error: console.error } });

      expect(warn.mock.calls).toEqual([[`${LINE} (store wins: WEBSITE_INSTANCE_ID present)`]]);
      expect(plain).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      plain.mockRestore();
    }
  });
});

describe('missing keys', () => {
  it('names every missing key at once, not the first', async () => {
    loadMock.mockResolvedValue(fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']! }) as never);

    const error = await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('shared:serviceBus');
    expect((error as Error).message).toContain('myapp:httpPort');
    expect((error as Error).message).toContain('label prod');
  });

  it('treats an empty stored value as missing', async () => {
    loadMock.mockResolvedValue(fakeStore({ ...VALUES, 'myapp:httpPort': '' }) as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(/myapp:httpPort/);
  });

  it('refuses a JSON key-value rather than writing "[object Object]"', async () => {
    // A key-value with a JSON content type comes back from the provider parsed, so get<string>()
    // is a type assertion the provider does not honour. An environment variable is a string or
    // it is a mistake.
    loadMock.mockResolvedValue(
      fakeStore({ ...VALUES, 'myapp:httpPort': { port: 8080 } }) as never
    );

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(
      /myapp:httpPort .*a JSON object rather than a string/
    );
    expect(process.env.HTTP_PORT).toBeUndefined();
    expect(process.env.MONGO_URL).toBeUndefined();
  });

  it('refuses a number as firmly as an object', async () => {
    loadMock.mockResolvedValue(fakeStore({ ...VALUES, 'myapp:httpPort': 8080 }) as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(
      /a number rather than a string/
    );
  });

  it('writes nothing when any key is unusable — all or nothing', async () => {
    // 0.1.0 wrote each usable value as it went and threw afterwards, so a rejection left the
    // environment half-written, and a process that carried on — a health path, a partial
    // feature — ran on a mix of store values and old ones.
    loadMock.mockResolvedValue(fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']! }) as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(/Missing key-values/);

    expect(process.env.MONGO_URL).toBeUndefined();
    expect(process.env.SERVICE_BUS_CONNECTION).toBeUndefined();
    expect(process.env.HTTP_PORT).toBeUndefined();
  });

  it('leaves a value it would have overwritten exactly as it was', async () => {
    deployed();
    process.env.MONGO_URL = 'mongodb://stale.invalid/app';
    process.env.SERVICE_BUS_CONNECTION = 'Endpoint=sb://stale.invalid/';
    loadMock.mockResolvedValue(fakeStore({ ...VALUES, 'myapp:httpPort': '' }) as never);
    const before = snapshotEnv();

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(/myapp:httpPort/);

    expect(process.env).toEqual(before);
  });

  it('keeps hydrateWithBackoff retrying, and writes only once every key is there', async () => {
    loadMock
      .mockResolvedValueOnce(fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']! }) as never)
      .mockResolvedValue(fakeStore() as never);
    const seenOnError: (string | undefined)[] = [];

    const result = await hydrateWithBackoff(
      { keys: KEYS, retryFloorMs: 0 },
      { initialMs: 1, maxMs: 2, onError: () => seenOnError.push(process.env.MONGO_URL) }
    );

    expect(seenOnError).toEqual([undefined]);
    expect(result.applied).toEqual(['MONGO_URL', 'SERVICE_BUS_CONNECTION', 'HTTP_PORT']);
    expect(process.env.MONGO_URL).toBe(VALUES['shared:mongoUrl']);
  });
});

describe('how the store is addressed', () => {
  it('requires a label and does not invent one from NODE_ENV', async () => {
    delete process.env.APP_CONFIG_LABEL;
    process.env.NODE_ENV = 'production';

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(/APP_CONFIG_LABEL/);

    expect(loadMock).not.toHaveBeenCalled();
  });

  it('requires an endpoint or a connection string', async () => {
    delete process.env.APP_CONFIG_ENDPOINT;

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(
      /APP_CONFIG_ENDPOINT nor APP_CONFIG_CONNECTION_STRING/
    );
  });

  it('prefers the connection string when one is set', async () => {
    process.env.APP_CONFIG_CONNECTION_STRING = 'Endpoint=https://example.invalid;Id=x;Secret=y';
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });

    expect(loadMock.mock.calls[0]![0]).toBe(process.env.APP_CONFIG_CONNECTION_STRING);
    // Access-key path: no credential is passed as the second positional argument.
    expect(loadMock.mock.calls[0]!.length).toBe(2);
  });

  it('passes the endpoint and a credential otherwise', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });

    expect(loadMock.mock.calls[0]![0]).toBe('https://example.invalid');
    expect(loadMock.mock.calls[0]!.length).toBe(3);
  });

  it('uses the caller credential for the store, through a watch that delegates to it', async () => {
    // The store credential is wrapped so that a failed load can say whether a token was ever
    // asked for and whether it arrived — see src/diagnostics.ts. The wrapper must be transparent.
    const credential = { getToken: vi.fn(async () => null) };
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, credential });

    const [, passed] = loadMock.mock.calls[0] as unknown[];
    expect(passed).not.toBe(credential);

    const options = { requestOptions: {} };
    await (passed as { getToken: (s: string, o: unknown) => Promise<unknown> }).getToken(
      'https://example.invalid/.default',
      options
    );
    expect(credential.getToken).toHaveBeenCalledTimes(1);
    expect(credential.getToken).toHaveBeenCalledWith('https://example.invalid/.default', options);
  });

  it('gives the Key Vault client the caller credential untouched', async () => {
    const credential = { getToken: vi.fn(async () => null) };
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, credential });

    const options = loadMock.mock.calls[0]!.at(-1) as { keyVaultOptions: { credential: unknown } };
    expect(options.keyVaultOptions.credential).toBe(credential);
  });

  it('defaults the startup timeout to 15 s, not the provider ~100 s', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });

    const options = loadMock.mock.calls[0]!.at(-1) as { startupOptions: { timeoutInMs: number } };
    expect(options.startupOptions.timeoutInMs).toBe(15_000);
  });

  it('lets the caller set the startup timeout', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, timeoutMs: 3_000 });

    const options = loadMock.mock.calls[0]!.at(-1) as { startupOptions: { timeoutInMs: number } };
    expect(options.startupOptions.timeoutInMs).toBe(3_000);
  });
});

describe('hydrateWithBackoff', () => {
  it('widens the delay and reports each failure', async () => {
    loadMock
      .mockRejectedValueOnce(providerFailoverError())
      .mockRejectedValueOnce(providerFailoverError())
      .mockRejectedValueOnce(providerFailoverError())
      .mockResolvedValue(fakeStore() as never);
    const delays: number[] = [];

    await hydrateWithBackoff(
      { keys: KEYS, retryFloorMs: 0 },
      { initialMs: 1, maxMs: 2, onError: (_error, next) => delays.push(next) }
    );

    expect(delays).toEqual([1, 2, 2]);
    expect(process.env.MONGO_URL).toBe(VALUES['shared:mongoUrl']);
  });

  it('is the only place that retries — a bare hydrate stays a single attempt', async () => {
    loadMock.mockRejectedValue(providerFailoverError());

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow();

    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});

describe('resetHydration', () => {
  it('drops the memoised success so the next call reads the store again', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });
    resetHydration();
    await hydrate({ keys: KEYS });

    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});
