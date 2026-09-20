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
  for (const variable of Object.values(KEYS)) delete process.env[variable];
});

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
    });
  });

  it('overwrites a value already in the environment — the store wins', async () => {
    process.env.MONGO_URL = 'mongodb://stale.invalid/app';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS });

    expect(process.env.MONGO_URL).toBe(VALUES['shared:mongoUrl']);
    expect(result.kept).toEqual([]);
  });

  it('keeps the local value under NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.MONGO_URL = 'mongodb://127.0.0.1:27017/local';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS });

    expect(process.env.MONGO_URL).toBe('mongodb://127.0.0.1:27017/local');
    expect(result.kept).toEqual(['MONGO_URL']);
    expect(result.applied).toEqual(['SERVICE_BUS_CONNECTION', 'HTTP_PORT']);
  });

  it('takes localOverridesWin from the caller when it is given', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HTTP_PORT = '9000';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS, localOverridesWin: true });

    expect(process.env.HTTP_PORT).toBe('9000');
    expect(result.kept).toEqual(['HTTP_PORT']);
  });

  it('lets a local value stand in for a key the store has not got yet', async () => {
    // The README promises a .env line can point one variable at a local database "without
    // reaching into the store". Deciding precedence after the missing-key check broke that: the
    // load failed on a key the caller had already supplied.
    process.env.NODE_ENV = 'development';
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
    process.env.NODE_ENV = 'development';
    loadMock.mockResolvedValue(
      fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']! }) as never
    );

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(/myapp:httpPort/);
  });

  it('treats an empty local value as absent', async () => {
    process.env.NODE_ENV = 'development';
    process.env.HTTP_PORT = '';
    loadMock.mockResolvedValue(fakeStore() as never);

    const result = await hydrate({ keys: KEYS });

    expect(process.env.HTTP_PORT).toBe('8080');
    expect(result.kept).toEqual([]);
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
  });

  it('refuses a number as firmly as an object', async () => {
    loadMock.mockResolvedValue(fakeStore({ ...VALUES, 'myapp:httpPort': 8080 }) as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow(
      /a number rather than a string/
    );
  });

  it('writes the keys it did find before it throws', async () => {
    // Today's copy collects the missing names and then throws, leaving what it read in place.
    // A caller that treats the throw as fatal — every documented shape does — never observes
    // the partial write, and a caller that retries overwrites it.
    loadMock.mockResolvedValue(fakeStore({ 'shared:mongoUrl': VALUES['shared:mongoUrl']! }) as never);

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toThrow();

    expect(process.env.MONGO_URL).toBe(VALUES['shared:mongoUrl']);
    expect(process.env.HTTP_PORT).toBeUndefined();
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
