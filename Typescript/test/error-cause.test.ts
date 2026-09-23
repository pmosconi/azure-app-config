/**
 * Invariant 3 — report the underlying cause.
 *
 * The provider does not hide the cause so much as destroy it: a failoverable error is caught,
 * skipped past and dropped, and what reaches the caller is a sentence the provider constructed
 * with no cause attached. So unwrapping the chain is not enough, and these tests use the
 * provider's real shapes rather than an aggregate it never produces.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { ConfigInputError, ConfigLoadError, hydrate, resetHydration } from '../src/index';
import {
  KEYS,
  fakeStore,
  failingLoad,
  failingLoadAfterRead,
  failingLoadWithHangingRequest,
  failingLoadWithNoRequest,
  loadAnsweredAfterTimeout,
  INVALID_CONNECTION_STRING,
  providerFailoverError,
  providerNonFailoverableError,
  providerPreRequestError,
  providerTimeoutError,
  policiesFrom,
  respondingCredential,
  hangingCredential,
  failingLoadAfterToken,
  failingLoadWithPendingToken,
  restError,
  restoreEnv,
  snapshotEnv,
  type WireFailure,
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

/** Fail on the wire with `failure`, and report whatever the provider then throws. */
async function failOnTheWire(failure: WireFailure, thrown?: Error): Promise<ConfigLoadError> {
  loadMock.mockImplementation(failingLoad(failure, thrown) as never);
  const error = await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigLoadError);
  return error as ConfigLoadError;
}

describe('the failure the provider discards', () => {
  it('reports the 403 that never appears anywhere in the provider chain', async () => {
    const error = await failOnTheWire({ status: 403 });

    // The provider gave us only "The load operation failed." wrapping "All fallback clients
    // failed to get configuration settings." Nothing in there is a 403.
    expect((error.cause as Error).message).toBe('The load operation failed.');
    expect(error.detail).not.toContain('fallback');

    expect(error.statusCode).toBe(403);
    expect(error.detail).toContain('HTTP 403');
    expect(error.message).toContain('not authorised');
  });

  it('tells a refused read apart from an unreachable store', async () => {
    const refused = await failOnTheWire({ status: 403 });
    resetHydration();
    const unreachable = await failOnTheWire({
      throws: Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' }),
    });

    // The two produce an identical provider error. That is the whole problem.
    expect((refused.cause as Error).message).toBe((unreachable.cause as Error).message);

    expect(refused.detail).not.toBe(unreachable.detail);
    expect(refused.statusCode).toBe(403);
    expect(unreachable.detail).toContain('ENOTFOUND');
    expect(unreachable.statusCode).toBeUndefined();
  });

  it('tells a throttled store apart from a refused one', async () => {
    const throttled = await failOnTheWire({ status: 429 });

    expect(throttled.statusCode).toBe(429);
    expect(throttled.message).toContain('quota');
  });

  it('prefers the store’s own words when it sends them', async () => {
    const error = await failOnTheWire({
      status: 403,
      body: JSON.stringify({
        type: 'https://azconfig.io/errors/forbidden',
        title: 'Access denied to the requested key-value.',
        status: 403,
      }),
    });

    expect(error.detail).toContain('Access denied to the requested key-value.');
  });

  it('records every distinct failure across the provider’s retries', async () => {
    const error = await failOnTheWire({ status: 500 });

    expect(error.observations).toHaveLength(1);
    expect(error.observations[0]!.status).toBe(500);
  });

  /*
   * Silence is never evidence about the store: an unreachable store and a refused one are both
   * observed, because a failed name lookup and a refused connection each throw in the transport
   * under the policy. So these cases are attributed from in-process evidence — whether a token
   * was asked for and whether it came back — and not from the provider's wording, which is
   * identical across all of them.
   */
  it('names the policy, not the credential, when the token arrived and no request was seen', async () => {
    // This is what provider drift looks like: clientOptions stops being honoured, so the policy
    // never runs. The provider's chain is the same one a hung credential produces.
    loadMock.mockImplementation(failingLoadAfterToken(providerTimeoutError()) as never);

    const error = (await hydrate({
      keys: KEYS,
      retryFloorMs: 0,
      credential: respondingCredential(),
    }).catch((e: unknown) => e)) as ConfigLoadError;

    expect(error.detail).toContain('clientOptions');
    expect(error.detail).toContain('the real cause was discarded');
    expect(error.detail).not.toContain('the credential is the suspect');
    // The sentences that would each have been confidently, specifically wrong.
    expect(error.detail).not.toContain('unreachable');
    expect(error.detail).not.toContain('refusing the read');
  });

  it('names the credential when the token was asked for and never answered', async () => {
    loadMock.mockImplementation(failingLoadWithPendingToken(providerTimeoutError()) as never);

    const error = (await hydrate({
      keys: KEYS,
      retryFloorMs: 0,
      credential: hangingCredential(),
    }).catch((e: unknown) => e)) as ConfigLoadError;

    expect(error.detail).toContain('never answered');
    expect(error.detail).toContain('rather than the store');
    expect(error.detail).not.toContain('clientOptions');
  });

  /*
   * When the store was asked and nothing failed, `detail` states what the wire showed — answered,
   * in flight, against the number of selectors — and names every cause that leaves open. It never
   * rules one out that the evidence cannot: these assert the facts and the candidates, not a
   * single verdict.
   */
  async function silentFailure(load: (...args: unknown[]) => Promise<never>, extra = {}) {
    loadMock.mockImplementation(load as never);
    const error = (await hydrate({
      keys: KEYS,
      retryFloorMs: 0,
      credential: respondingCredential(),
      ...extra,
    }).catch((e: unknown) => e)) as ConfigLoadError;
    expect(error).toBeInstanceOf(ConfigLoadError);
    expect(error.observations).toHaveLength(0);
    expect(error.statusCode).toBeUndefined();
    // Before requests were counted, every case here was blamed on clientOptions drift.
    expect(error.detail).not.toContain('clientOptions');
    expect(error.detail).not.toContain('credential is the suspect');
    return error.detail;
  }

  it('reports a complete read with nothing in flight, and names a Key Vault reference', async () => {
    // A Key Vault reference the provider cannot parse or resolve: every selector answered 200,
    // then the provider retries the reference until the startup timeout.
    const detail = await silentFailure(failingLoadAfterRead(providerTimeoutError()));

    expect(detail).toContain('the store had answered 3 of the 3 requests');
    expect(detail).toContain('0 were still in flight');
    expect(detail).toContain('for 3 selectors');
    expect(detail).toContain('Not ruled out: a Key Vault reference');
    expect(detail).not.toContain('network path');
  });

  it('reports the same on the access-key path, where no token is in play', async () => {
    process.env.APP_CONFIG_CONNECTION_STRING = 'Endpoint=https://example.invalid;Id=x;Secret=c2VjcmV0';
    loadMock.mockImplementation(failingLoadAfterRead(providerTimeoutError()) as never);

    const error = (await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch(
      (e: unknown) => e
    )) as ConfigLoadError;

    expect(error.detail).toContain('answered 3 of the 3 requests');
    expect(error.detail).toContain('Key Vault reference');
    expect(error.detail).not.toContain('the cause is unreported');
  });

  it('names the network and the store when a request never came back', async () => {
    // Behind a blackholed private endpoint the provider's list request is still in flight when the
    // timeout wins. No selector was answered, so no reference was ever resolved: Key Vault is out.
    const detail = await silentFailure(failingLoadWithHangingRequest(providerTimeoutError()));

    expect(detail).toContain('answered 0 of the 1 request');
    expect(detail).toContain('1 was still in flight');
    expect(detail).toContain('the network path to the store');
    expect(detail).toContain('the store not answering');
    expect(detail).not.toContain('Key Vault');
  });

  it('keeps the network in play when one selector was answered and the next hung', async () => {
    const detail = await silentFailure(failingLoadWithHangingRequest(providerTimeoutError(), 1));

    expect(detail).toContain('answered 1 of the 2 requests');
    expect(detail).toContain('1 was still in flight');
    expect(detail).toContain('the network path to the store');
    expect(detail).not.toContain('Key Vault');
  });

  it('does not rule out a Key Vault re-read when a request is in flight after a full read', async () => {
    // On 2.6.0 a broken reference makes the provider re-read the store every few seconds, so a
    // re-read can be in flight when the timeout fires. That must not become "not its data".
    const detail = await silentFailure(failingLoadWithHangingRequest(providerTimeoutError(), 3));

    expect(detail).toContain('answered 3 of the 4 requests');
    expect(detail).toContain('the network path to the store');
    expect(detail).toContain('a Key Vault reference');
    expect(detail).not.toContain('not its data');
  });

  it('says the reads had not finished when fewer selectors were answered and none is in flight', async () => {
    const detail = await silentFailure(failingLoadAfterRead(providerTimeoutError(), 1));

    expect(detail).toContain('answered 1 of the 1 request');
    expect(detail).toContain('reads that had not finished');
    expect(detail).not.toContain('Key Vault');
  });

  it('counts what was in flight when the startup timeout fired, not when the rejection came', async () => {
    // With timeoutMs under five seconds the provider holds its rejection until five seconds after
    // it started. A request answered in that gap must not turn "in flight" into "answered".
    const detail = await silentFailure(loadAnsweredAfterTimeout(80), { timeoutMs: 20 });

    expect(detail).toContain('when the startup timeout fired');
    expect(detail).toContain('answered 0 of the 1 request');
    expect(detail).toContain('1 was still in flight');
  });

  it('names nothing when no token was ever requested', async () => {
    loadMock.mockImplementation(failingLoadWithNoRequest(providerTimeoutError()) as never);

    const error = (await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch(
      (e: unknown) => e
    )) as ConfigLoadError;

    expect(error.detail).toContain('the cause is unreported');
    expect(error.detail).not.toContain('unreachable');
  });

  it('names nothing on the access-key path, where no token is in play (accepted)', async () => {
    // This is the diagnostics' accepted stopping point, not a gap waiting to be closed. With no
    // token there is no second signal, so drift and a silent failure look alike here — and the
    // path exists for a run with no identity to borrow, which in practice is a developer machine.
    // Deployed consumers are all on the endpoint path, where the watch works.
    process.env.APP_CONFIG_CONNECTION_STRING = 'Endpoint=https://example.invalid;Id=x;Secret=c2VjcmV0';
    loadMock.mockImplementation(failingLoadWithNoRequest(providerTimeoutError()) as never);

    const error = (await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch(
      (e: unknown) => e
    )) as ConfigLoadError;

    expect(error.detail).toContain('no token was in play');
    expect(error.detail).toContain('the cause is unreported');
    expect(error.detail).not.toContain('credential is the suspect');
  });
});

describe('the failures the provider does preserve', () => {
  it('uses the provider’s own cause for a non-failoverable error', async () => {
    loadMock.mockImplementation(
      failingLoadWithNoRequest(providerNonFailoverableError(restError(404))) as never
    );

    const error = (await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch(
      (e: unknown) => e
    )) as ConfigLoadError;

    expect(error.statusCode).toBe(404);
    expect(error.detail).toContain('HTTP 404');
  });


  it('keeps the provider error as cause, unmodified', async () => {
    const provider = providerFailoverError();

    const error = await failOnTheWire({ status: 403 }, provider);

    expect(error.cause).toBe(provider);
  });

  it('names the store and label that failed', async () => {
    const error = await failOnTheWire({ status: 403 });

    expect(error.message).toContain('https://example.invalid');
    expect(error.message).toContain('label prod');
  });

  it('survives an error with no nesting at all', async () => {
    loadMock.mockImplementation(failingLoadWithNoRequest(new Error('plain failure')) as never);

    const error = (await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch(
      (e: unknown) => e
    )) as ConfigLoadError;

    expect(error.detail).toBe('plain failure');
  });

  it('does not loop forever on a self-referential cause chain', async () => {
    const circular = new Error('round and round') as Error & { cause: unknown };
    circular.cause = circular;
    loadMock.mockImplementation(failingLoadWithNoRequest(circular) as never);

    const error = (await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch(
      (e: unknown) => e
    )) as ConfigLoadError;

    expect(error.detail).toContain('round and round');
  });
});

describe('input errors from the provider', () => {
  it('reports an ArgumentError as a ConfigInputError, not a load failure', async () => {
    loadMock.mockImplementation(failingLoadWithNoRequest(providerPreRequestError()) as never);

    const error = await hydrate({ keys: KEYS, retryFloorMs: 0 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigInputError);
    expect(error).not.toBeInstanceOf(ConfigLoadError);
    expect((error as Error).message).toContain(INVALID_CONNECTION_STRING);
    expect((error as ConfigInputError).reachedStore).toBe(false);
  });
});

/**
 * Our half of the contract with the provider. The other half — that `clientOptions` is still
 * honoured and that `perRetry` still sits below the SDK's retry policy — cannot be checked with
 * `load()` mocked, and is covered by test/provider-contract.integration.test.ts.
 */
describe('how the diagnostics policy is handed to the provider', () => {
  it('sends exactly one policy, positioned below the retry policy', async () => {
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });

    const policies = policiesFrom(loadMock.mock.calls[0] as unknown[]);
    expect(policies).toHaveLength(1);
    // `perCall` would sit ABOVE the SDK's retry policy and see one attempt per call rather than
    // one per try, which is fewer observations for exactly the failures that get retried.
    expect(policies[0]!.position).toBe('perRetry');
    expect(policies[0]!.policy.name).toBe('actvalue-azure-app-config-diagnostics');
  });

  it('sends it on the access-key path too', async () => {
    process.env.APP_CONFIG_CONNECTION_STRING = 'Endpoint=https://example.invalid;Id=x;Secret=c2VjcmV0';
    loadMock.mockResolvedValue(fakeStore() as never);

    await hydrate({ keys: KEYS });

    expect(policiesFrom(loadMock.mock.calls[0] as unknown[])).toHaveLength(1);
  });
});
