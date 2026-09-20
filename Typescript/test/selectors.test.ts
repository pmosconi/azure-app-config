/**
 * Invariant 4 — explicit key map, one selector per key.
 *
 * Never a prefix or wildcard selector. Every Key Vault reference the provider loads it also
 * resolves, so a wildcard attempts to resolve secrets the caller holds no grant on, and turns
 * another application's credential into this application's startup failure.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { hydrate, resetHydration } from '../src/index';
import { KEYS, fakeStore, restoreEnv, snapshotEnv } from './helpers';

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

type LoadOptions = {
  selectors: { keyFilter: string; labelFilter: string }[];
  startupOptions: { timeoutInMs: number };
  keyVaultOptions: { credential: unknown };
};

function optionsPassedToProvider(): LoadOptions {
  const call = loadMock.mock.calls[0];
  expect(call).toBeDefined();
  return call![call!.length - 1] as LoadOptions;
}

beforeEach(() => {
  env = snapshotEnv();
  resetHydration();
  loadMock.mockReset();
  process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
  process.env.APP_CONFIG_LABEL = 'prod';
  delete process.env.NODE_ENV;
});

afterEach(() => restoreEnv(env));

describe('selectors', () => {
  it('sends one selector per key and nothing else', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });

    const { selectors } = optionsPassedToProvider();
    expect(selectors).toEqual([
      { keyFilter: 'shared:mongoUrl', labelFilter: 'prod' },
      { keyFilter: 'shared:serviceBus', labelFilter: 'prod' },
      { keyFilter: 'myapp:httpPort', labelFilter: 'prod' },
    ]);
  });

  it('never lets a wildcard reach the provider', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await expect(
      hydrate({ keys: { 'shared:*': 'ANYTHING' }, retryFloorMs: 0 })
    ).rejects.toThrow(/Wildcard key/);

    expect(loadMock).not.toHaveBeenCalled();
  });

  it('reads exactly one label, never a wildcard label', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS, label: 'staging' });

    for (const selector of optionsPassedToProvider().selectors) {
      expect(selector.labelFilter).toBe('staging');
      expect(selector.keyFilter).not.toContain('*');
    }
  });

  it('refuses an empty key map rather than falling back to everything', async () => {
    await expect(hydrate({ keys: {}, retryFloorMs: 0 })).rejects.toThrow(/no keys/);

    expect(loadMock).not.toHaveBeenCalled();
  });
});
