/**
 * Invariant 4 — explicit key map, one selector per key.
 *
 * Never a prefix or wildcard selector. Every Key Vault reference the provider loads it also
 * resolves, so a wildcard attempts to resolve secrets the caller holds no grant on, and turns
 * another application's credential into this application's startup failure.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { ConfigInputError, hydrate, hydrationStatus, resetHydration } from '../src/index';
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
  delete process.env.WEBSITE_INSTANCE_ID;
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
    ).rejects.toThrow(/is a filter, not a key/);

    expect(loadMock).not.toHaveBeenCalled();
  });

  it('never lets a comma reach the provider — `a,b` is a two-key filter', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    const error = await hydrate({
      keys: { 'shared:mongoUrl,shared:serviceBus': 'MONGO_URL' },
      retryFloorMs: 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigInputError);
    expect((error as ConfigInputError).reachedStore).toBe(false);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a wildcard label passed in', { label: '*' }],
    ['a two-label filter passed in', { label: 'prod,staging' }],
  ])('refuses %s before any request', async (_name, extra) => {
    const error = await hydrate({ keys: KEYS, retryFloorMs: 0, ...extra }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigInputError);
    expect((error as Error).message).toMatch(/is a filter, not a label/);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('refuses a filter in APP_CONFIG_LABEL too', async () => {
    process.env.APP_CONFIG_LABEL = 'prod,staging';

    await expect(hydrate({ keys: KEYS, retryFloorMs: 0 })).rejects.toBeInstanceOf(ConfigInputError);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('lets an escaped comma or asterisk through — it matches the literal character', async () => {
    // App Configuration reads `\,` and `\*` as the characters themselves. The provider files the
    // setting under its real key, so the lookup must unescape.
    loadMock.mockResolvedValue(
      fakeStore({ 'shared:a,b': 'comma', 'shared:star*': 'star', 'shared:back\\,x': 'odd' }) as never
    );

    const result = await hydrate({
      keys: {
        'shared:a\\,b': 'COMMA_VALUE',
        'shared:star\\*': 'STAR_VALUE',
        'shared:back\\\\\\,x': 'ODD_VALUE',
      },
    });

    const { selectors } = optionsPassedToProvider();
    expect(selectors.map(selector => selector.keyFilter)).toEqual([
      'shared:a\\,b',
      'shared:star\\*',
      'shared:back\\\\\\,x',
    ]);
    expect(result.applied).toEqual(['COMMA_VALUE', 'STAR_VALUE', 'ODD_VALUE']);
    expect(process.env.COMMA_VALUE).toBe('comma');
    expect(process.env.STAR_VALUE).toBe('star');
    expect(process.env.ODD_VALUE).toBe('odd');
  });

  it('refuses a comma after an escaped backslash — that comma is a filter', async () => {
    // `\\,` is a literal backslash followed by an unescaped comma.
    const error = await hydrate({ keys: { 'shared:a\\\\,b': 'X' }, retryFloorMs: 0 }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ConfigInputError);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('refuses an escaped comma in the label, as the provider does', async () => {
    // The provider rejects any '*' or ',' in a label filter, escaped or not.
    await expect(
      hydrate({ keys: KEYS, label: 'prod\\,staging', retryFloorMs: 0 })
    ).rejects.toBeInstanceOf(ConfigInputError);
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('shares the checks with hydrationStatus', () => {
    expect(hydrationStatus({ 'shared:a\\,b': 'X' }).state).toBe('none');
    expect(() => hydrationStatus({ 'a,b': 'X' })).toThrow(ConfigInputError);
    expect(() => hydrationStatus({ 'shared:*': 'X' })).toThrow(ConfigInputError);
    expect(() => hydrationStatus(KEYS, 'prod,staging')).toThrow(ConfigInputError);
    expect(() => hydrationStatus(KEYS, '*')).toThrow(ConfigInputError);
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
