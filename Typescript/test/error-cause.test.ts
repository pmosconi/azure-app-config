/**
 * Invariant 3 — report the underlying cause.
 *
 * The provider hides it. A refused read surfaces as `All fallback clients failed to get
 * configuration settings` three times and then `The load operation timed out`, with no 403
 * anywhere — a revoked grant and an unreachable store are indistinguishable. `detail` must
 * unwrap the aggregate.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { ConfigLoadError, hydrate, resetHydration } from '../src/index';
import { KEYS, providerAggregate, forbidden, restoreEnv, snapshotEnv } from './helpers';

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
});

afterEach(() => restoreEnv(env));

async function failWith(error: unknown): Promise<ConfigLoadError> {
  loadMock.mockRejectedValue(error);
  const thrown = await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(ConfigLoadError);
  return thrown as ConfigLoadError;
}

describe('ConfigLoadError', () => {
  it('unwraps the provider aggregate down to the 403 it buries', async () => {
    const error = await failWith(providerAggregate(forbidden()));

    expect(error.detail).toContain('Forbidden');
    expect(error.detail).toContain('HTTP 403');
    expect(error.statusCode).toBe(403);
    // The failure must be attributable without a runbook: the message itself carries the cause.
    expect(error.message).toContain('Forbidden');
  });

  it('tells a refused read apart from an unreachable store', async () => {
    const dns = new Error('getaddrinfo ENOTFOUND example.invalid') as Error & { code: string };
    dns.code = 'ENOTFOUND';

    const refused = await failWith(providerAggregate(forbidden()));
    resetHydration();
    const unreachable = await failWith(providerAggregate(dns));

    expect(refused.detail).not.toBe(unreachable.detail);
    expect(unreachable.detail).toContain('ENOTFOUND');
    expect(unreachable.statusCode).toBeUndefined();
  });

  it('keeps the provider error as cause, unmodified', async () => {
    const provider = providerAggregate(forbidden());

    const error = await failWith(provider);

    expect(error.cause).toBe(provider);
  });

  it('names the store and label that failed', async () => {
    const error = await failWith(providerAggregate(forbidden()));

    expect(error.message).toContain('https://example.invalid');
    expect(error.message).toContain('label prod');
  });

  it('survives an error with no nesting at all', async () => {
    const error = await failWith(new Error('plain failure'));

    expect(error.detail).toBe('plain failure');
  });

  it('does not loop forever on a self-referential cause chain', async () => {
    const circular = new Error('round and round') as Error & { cause: unknown };
    circular.cause = circular;

    const error = await failWith(circular);

    expect(error.detail).toContain('round and round');
  });
});
