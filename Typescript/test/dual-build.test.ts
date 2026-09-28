/**
 * Two module instances of one version share one state, and their errors match each other's
 * classes.
 *
 * The package ships an ESM and a CJS build, and a consumer graph can reach both. With the state
 * in module scope, each copy had its own memo and its own retry floor — the quota invariant spent
 * twice — `resetHydration()` from one cleared only its own, and `instanceof` failed across the
 * copies, so a `hydrateWithBackoff` in one copy joining an attempt from the other would retry a
 * `ConfigInputError` it should stop on. The state now lives on `globalThis` under a symbol keyed
 * on the exact package version, and the error classes carry a brand `instanceof` checks.
 *
 * `vi.resetModules()` and a second dynamic import give a second module instance of `src/index`,
 * with its own module scope and its own classes, which is what the second build is.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json';
import { KEYS, fakeStore, providerFailoverError, restoreEnv, snapshotEnv } from './helpers';

// One mock shared by every module instance, however many times the modules are reset.
const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock('@azure/app-configuration-provider', () => ({ load: loadMock }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    getToken() {
      return Promise.resolve(null);
    }
  },
}));

type Package = typeof import('../src/index');

/** A fresh module instance of the package: its own module scope, its own classes. */
async function instance(): Promise<Package> {
  vi.resetModules();
  return import('../src/index');
}

const quiet = { log: () => {} };
let env: NodeJS.ProcessEnv;
let a: Package;
let b: Package;

beforeEach(async () => {
  env = snapshotEnv();
  a = await instance();
  b = await instance();
  a.resetHydration();
  loadMock.mockReset();
  process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
  process.env.APP_CONFIG_LABEL = 'prod';
  delete process.env.WEBSITE_INSTANCE_ID;
  for (const variable of Object.values(KEYS)) delete process.env[variable];
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv(env);
});

describe('two module instances share one state', () => {
  it('are really two instances, with two sets of classes', () => {
    expect(a).not.toBe(b);
    expect(a.hydrate).not.toBe(b.hydrate);
    expect(a.ConfigLoadError).not.toBe(b.ConfigLoadError);
  });

  it('share the memo: one success serves both', async () => {
    loadMock.mockResolvedValue(fakeStore());

    const first = await a.hydrate({ keys: KEYS, logger: quiet });
    const second = await b.hydrate({ keys: KEYS, logger: quiet });

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(b.hydrationStatus(KEYS)).toEqual({ state: 'loaded', loadedAt: first.loadedAt });
  });

  it('share one attempt in flight', async () => {
    loadMock.mockResolvedValue(fakeStore());

    const [first, second] = await Promise.all([
      a.hydrate({ keys: KEYS, logger: quiet }),
      b.hydrate({ keys: KEYS, logger: quiet }),
    ]);

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('share the retry floor: a failure through one holds the other back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    const fresh = await a.hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet }).catch((e: unknown) => e);
    vi.advanceTimersByTime(1_000);
    const again = await b.hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet }).catch((e: unknown) => e);

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(again).toBeInstanceOf(b.ConfigFloorError);
    expect((again as InstanceType<Package['ConfigFloorError']>).cause).toBe(fresh);
    expect(b.retryAfterMs(fresh)).toBe(29_050);
  });

  it('are both cleared by resetHydration from either one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValueOnce(providerFailoverError()).mockResolvedValue(fakeStore());
    await a.hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet }).catch(() => undefined);

    b.resetHydration();

    expect(a.hydrationStatus(KEYS)).toEqual({ state: 'none' });
    const result = await a.hydrate({ keys: KEYS, retryFloorMs: 30_000, logger: quiet });
    expect(result.applied).toContain('MONGO_URL');
    expect(loadMock).toHaveBeenCalledTimes(2);

    a.resetHydration();
    expect(b.hydrationStatus(KEYS)).toEqual({ state: 'none' });
  });

  it('share the set of pre-request errors already logged', async () => {
    delete process.env.APP_CONFIG_LABEL;
    const log = { log: vi.fn(), error: vi.fn() };

    await a.hydrate({ keys: KEYS, logger: log }).catch(() => undefined);
    await b.hydrate({ keys: KEYS, logger: log }).catch(() => undefined);

    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('keep the state under a symbol keyed on the exact package version', async () => {
    const registry = globalThis as unknown as Record<symbol, unknown>;
    const key = Symbol.for(`@actvalue/azure-app-config/state@${pkg.version}`);
    loadMock.mockResolvedValue(fakeStore());

    a.resetHydration();
    const before = registry[key];
    await b.hydrate({ keys: KEYS, logger: quiet });

    expect(before).toBeDefined();
    expect(registry[key]).toBe(before);
    b.resetHydration();
    expect(registry[key]).not.toBe(before);
  });

  it('leave another version’s state alone', async () => {
    // Each version has its own floor: a different version's state, under its own key, is neither
    // read nor cleared.
    const registry = globalThis as unknown as Record<symbol, unknown>;
    const other = Symbol.for('@actvalue/azure-app-config/state@0.0.0-other');
    const foreign = { calls: new Map(), reportedInputErrors: new Set(), failedAt: Date.now(), floorMs: 1e9 };
    registry[other] = foreign;
    loadMock.mockResolvedValue(fakeStore());
    try {
      await a.hydrate({ keys: KEYS, logger: quiet });
      a.resetHydration();

      expect(loadMock).toHaveBeenCalledTimes(1);
      expect(registry[other]).toBe(foreign);
    } finally {
      delete registry[other];
    }
  });
});

describe('errors match across module instances', () => {
  it('matches an error thrown by one against the other’s class', async () => {
    delete process.env.APP_CONFIG_LABEL;
    const input = await a.hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e);

    expect(input).toBeInstanceOf(a.ConfigInputError);
    expect(input).toBeInstanceOf(b.ConfigInputError);
    expect(input).toBeInstanceOf(Error);
  });

  it('matches a load error and a floor error across instances too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    loadMock.mockRejectedValue(providerFailoverError());

    const load = await a.hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e);
    const floor = await a.hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e);

    expect(load).toBeInstanceOf(b.ConfigLoadError);
    expect(floor).toBeInstanceOf(b.ConfigFloorError);
    expect(load).toBeInstanceOf(Error);
    expect(floor).toBeInstanceOf(Error);
  });

  it('does not let one brand match another class — a floor error is still not a load error', () => {
    const floor = new a.ConfigFloorError(1_000, new Error('before'));
    const load = new a.ConfigLoadError('failed', new Error('cause'));
    const input = new a.ConfigInputError('bad');

    for (const pkgInstance of [a, b]) {
      expect(floor).not.toBeInstanceOf(pkgInstance.ConfigLoadError);
      expect(floor).not.toBeInstanceOf(pkgInstance.ConfigInputError);
      expect(load).not.toBeInstanceOf(pkgInstance.ConfigFloorError);
      expect(load).not.toBeInstanceOf(pkgInstance.ConfigInputError);
      expect(input).not.toBeInstanceOf(pkgInstance.ConfigLoadError);
      expect(input).not.toBeInstanceOf(pkgInstance.ConfigFloorError);
    }
    expect(new Error('plain')).not.toBeInstanceOf(b.ConfigLoadError);
    expect({ message: 'duck' }).not.toBeInstanceOf(b.ConfigInputError);
    expect(null).not.toBeInstanceOf(b.ConfigInputError);
  });

  it('keeps the brand out of what an error enumerates', () => {
    const input = new a.ConfigInputError('bad');

    const symbols = Object.getOwnPropertySymbols(input);
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every(s => !Object.getOwnPropertyDescriptor(input, s)!.enumerable)).toBe(true);
    expect(JSON.stringify({ ...input })).not.toContain('true');
  });

  it('keeps ordinary instanceof for a consumer’s subclass', () => {
    class Special extends a.ConfigInputError {}
    const special = new Special('special');

    expect(special).toBeInstanceOf(Special);
    expect(special).toBeInstanceOf(b.ConfigInputError);
    expect(new a.ConfigInputError('plain')).not.toBeInstanceOf(Special);
  });

  it('lets hydrateWithBackoff in one instance stop on an input error from an attempt the other started', async () => {
    // The case that made this matter: the loop joins the other copy's attempt, gets that copy's
    // ConfigInputError, and must recognise it — or it retries what waiting cannot fix.
    const argument = new Error('bad');
    argument.name = 'ArgumentError';
    let failIt: (error: unknown) => void = () => {};
    loadMock.mockImplementationOnce(() => new Promise((_resolve, reject) => (failIt = reject)));

    const started = a.hydrate({ keys: KEYS, logger: quiet }).catch((e: unknown) => e);
    const loop = b.hydrateWithBackoff({ keys: KEYS, logger: quiet }, { initialMs: 1, maxMs: 2, onError: () => {} });
    failIt(argument);

    await expect(loop).rejects.toBeInstanceOf(b.ConfigInputError);
    expect(await started).toBeInstanceOf(a.ConfigInputError);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });
});
