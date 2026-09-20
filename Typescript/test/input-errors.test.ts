/**
 * A container that loops forever on a typo is indistinguishable from one waiting out a genuine
 * outage, and only one of those is worth waiting for. `hydrateWithBackoff` retries what the store
 * might recover from and rejects what it cannot.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { ConfigInputError, hydrate, hydrateWithBackoff, resetHydration } from '../src/index';
import {
  KEYS,
  VALUES,
  fakeStore,
  failingLoadWithNoRequest,
  providerArgumentError,
  providerFailoverError,
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
  for (const variable of Object.values(KEYS)) delete process.env[variable];
});

afterEach(() => restoreEnv(env));

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
      failingLoadWithNoRequest(providerArgumentError('Invalid selector.')) as never
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

describe('an input error never arms the retry floor', () => {
  it('leaves a well-formed call free to read the store immediately', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await expect(hydrate({ keys: { 'shared:*': 'X' } })).rejects.toBeInstanceOf(ConfigInputError);
    const result = await hydrate({ keys: KEYS });

    expect(result.applied).toContain('MONGO_URL');
  });
});
