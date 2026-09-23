import { vi } from 'vitest';

/** Neutral keys — this repository is public, and nothing here names a real store or estate. */
export const KEYS = {
  'shared:mongoUrl': 'MONGO_URL',
  'shared:serviceBus': 'SERVICE_BUS_CONNECTION',
  'myapp:httpPort': 'HTTP_PORT',
};

export const VALUES: Record<string, string> = {
  'shared:mongoUrl': 'mongodb://example.invalid:27017/app',
  'shared:serviceBus': 'Endpoint=sb://example.invalid/;SharedAccessKeyName=n;SharedAccessKey=k',
  'myapp:httpPort': '8080',
};

/** What the provider's `load()` resolves to, as far as this package uses it. */
export function fakeStore(values: Record<string, unknown> = VALUES) {
  return {
    get: vi.fn((key: string) => values[key]),
  };
}

export function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

/*
 * ---------------------------------------------------------------------------------------------
 * The provider's real error shapes.
 *
 * Taken from @azure/app-configuration-provider 2.6.0, not invented. Getting these wrong is how a
 * suite certifies the bug it was written to catch: an earlier version of this file fabricated an
 * `errors: [...]` aggregate that the provider never produces, and every test passed against a
 * package that could not report a cause at all.
 *
 * appConfigurationImpl.js:729-738 — a failoverable error (401, 403, 408, 429, 5xx, ENOTFOUND,
 * ENOENT, ECONNREFUSED, ECONNRESET, ETIMEDOUT) is caught, `continue`d past and DISCARDED; on
 * running out of clients the provider throws a bare Error with no cause and no errors array.
 * appConfigurationImpl.js:218 — load() wraps whatever escaped in "The load operation failed."
 * ---------------------------------------------------------------------------------------------
 */

/** What reaches the caller when the store refuses or cannot be reached. No cause, by construction. */
export function providerFailoverError(): Error {
  const allFallbackClientsFailed = new Error(
    'All fallback clients failed to get configuration settings.'
  );
  return new Error('The load operation failed.', { cause: allFallbackClientsFailed });
}

/** What reaches the caller when the startup timeout wins the race first. */
export function providerTimeoutError(): Error {
  return new Error('The load operation failed.', {
    cause: new Error('The load operation timed out.'),
  });
}

/** A non-failoverable error — 404, 400 — is re-thrown, so its cause does survive. */
export function providerNonFailoverableError(underlying: Error): Error {
  return new Error('The load operation failed.', { cause: underlying });
}

/*
 * A Key Vault reference the provider cannot parse or resolve has no shape of its own at startup.
 * keyVaultKeyValueAdapter.js:30/50 and keyVaultSecretProvider.js:49 wrap it in a
 * KeyVaultReferenceError, which the retry loop (appConfigurationImpl.js:322-326) finds neither an
 * input error nor a RestError, so it re-reads the store and retries until the startup timeout
 * wins: the caller gets providerTimeoutError(), after the store answered 200. Verified against
 * 2.6.0 with a local fake store, for an unparseable URI, a malformed secret path and an
 * unreachable vault. An earlier fixture here — the load error wrapping the KeyVaultReferenceError
 * wrapping a 403 — was a shape 2.6.0 never produces. Use failingLoadAfterRead(providerTimeoutError()).
 */

/** What the provider says about a connection string it cannot parse. */
export const INVALID_CONNECTION_STRING =
  "Invalid connection string. Valid connection strings should match the regex 'Endpoint=(.*);Id=(.*);Secret=(.*)'.";

/**
 * An input error the provider raises before any request. ConfigurationClientManager checks the
 * connection string and endpoint in its constructor (configurationClientManager.js:58, :66), which
 * load.js calls before its try, so the ArgumentError — or the TypeError from `new URL` — arrives
 * bare, unwrapped and unpadded. Verified against 2.6.0 for both. (The selector checks,
 * appConfigurationImpl.js:853-859, throw the same bare shape after a five-second pad; hydrate() now
 * rejects a label with `*` or `,` itself, so they are no longer reached.)
 */
export function providerPreRequestError(message: string = INVALID_CONNECTION_STRING): Error {
  const argumentError = new Error(message);
  argumentError.name = 'ArgumentError';
  return argumentError;
}

/**
 * An input error raised inside the initial load: #initializeWithRetryPolicy re-throws a top-level
 * ArgumentError, TypeError or RangeError at once (appConfigurationImpl.js:322), and load() wraps it
 * (:218). Nothing we found in store data reaches this in 2.6.0 — see the Key Vault note above — but
 * the path exists, and when it is taken after the read, the attempt has spent quota.
 */
export function providerArgumentError(message: string): Error {
  const argumentError = new Error(message);
  argumentError.name = 'ArgumentError';
  return new Error('The load operation failed.', { cause: argumentError });
}

/** A RestError as the SDK reports one. */
export function restError(status: number, code?: string): Error {
  const error = new Error(`Operation returned an invalid status code: ${status}`) as Error & {
    statusCode: number;
    code?: string;
  };
  error.statusCode = status;
  if (code) error.code = code;
  return error;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Driving the diagnostics policy.
 *
 * The package learns the real cause from a pipeline policy it hands the provider through
 * clientOptions, so a fake load() has to do what the provider does: run the policy, get the
 * failure, discard it, and throw its own opaque error.
 * ---------------------------------------------------------------------------------------------
 */

interface PolicyEntry {
  policy: { name: string; sendRequest: (request: unknown, next: (r: unknown) => Promise<unknown>) => Promise<unknown> };
  position: string;
}

interface LoadOptionsShape {
  clientOptions?: { additionalPolicies?: PolicyEntry[] };
}

/** What the store answers on the wire: either an HTTP response, or a transport error. */
export type WireFailure = { status: number; body?: string } | { throws: Error };

export function policiesFrom(args: unknown[]): PolicyEntry[] {
  const options = args[args.length - 1] as LoadOptionsShape;
  return options.clientOptions?.additionalPolicies ?? [];
}

/**
 * A `load()` implementation that answers `failure` on the wire, lets the provider's policies see
 * it, and then throws `thrown` — exactly as the provider does, cause and all discarded.
 */
export function failingLoad(failure: WireFailure, thrown: Error = providerFailoverError()) {
  return async (...args: unknown[]): Promise<never> => {
    for (const { policy } of policiesFrom(args)) {
      // The policy re-throws what it observed; the provider swallows it and carries on.
      await policy
        .sendRequest({ url: 'https://example.invalid/kv', method: 'GET' }, async () => {
          if ('throws' in failure) throw failure.throws;
          return {
            status: failure.status,
            bodyAsText: failure.body ?? null,
            headers: {},
          };
        })
        .catch(() => undefined);
    }
    throw thrown;
  };
}

/**
 * A `load()` whose store read succeeds on the wire — the policies see a 200 for each list request,
 * one per selector unless `answered` says otherwise — and which then throws `thrown`, as the
 * provider does when what it read cannot be used. On the endpoint path it asks for a token first,
 * as the real one does before its first request.
 */
export function failingLoadAfterRead(thrown: Error, answered?: number) {
  return async (...args: unknown[]): Promise<never> => {
    if (args.length === 3) {
      const credential = args[1] as { getToken: (s: string) => Promise<unknown> };
      await credential.getToken('https://example.invalid/.default');
    }
    const count = answered ?? (args[args.length - 1] as { selectors: unknown[] }).selectors.length;
    for (const { policy } of policiesFrom(args)) {
      for (let i = 0; i < count; i++) {
        await policy.sendRequest({ url: 'https://example.invalid/kv', method: 'GET' }, async () => ({
          status: 200,
          bodyAsText: '{"items":[]}',
          headers: {},
        }));
      }
    }
    throw thrown;
  };
}

/**
 * A `load()` with a startup timeout shorter than the provider's five-second hold: its one request
 * is still in flight when the timeout fires, is answered `answerAfterMs` later, and only then does
 * the rejection arrive — as 2.6.0 does when `timeoutMs` is under five seconds.
 */
export function loadAnsweredAfterTimeout(answerAfterMs: number, thrown: Error = providerTimeoutError()) {
  return async (...args: unknown[]): Promise<never> => {
    for (const { policy } of policiesFrom(args)) {
      await policy.sendRequest(
        { url: 'https://example.invalid/kv', method: 'GET' },
        () =>
          new Promise(resolve =>
            setTimeout(() => resolve({ status: 200, bodyAsText: '{"items":[]}', headers: {} }), answerAfterMs)
          )
      );
    }
    throw thrown;
  };
}

/**
 * A `load()` that sends `answered` requests the store answers with 200, then one that never comes
 * back, then throws `thrown` — the startup timeout winning while that request is still in flight.
 * The provider passes no abort signal to its list requests, so behind a blackholed private endpoint
 * or a store that answers one selector and hangs on the next, this is what the policy sees.
 */
export function failingLoadWithHangingRequest(thrown: Error, answered = 0) {
  return async (...args: unknown[]): Promise<never> => {
    const [entry] = policiesFrom(args);
    if (entry) {
      for (let i = 0; i < answered; i++) {
        await entry.policy.sendRequest({ url: 'https://example.invalid/kv', method: 'GET' }, async () => ({
          status: 200,
          bodyAsText: '{"items":[]}',
          headers: {},
        }));
      }
      void entry.policy.sendRequest(
        { url: 'https://example.invalid/kv', method: 'GET' },
        () => new Promise<never>(() => {})
      );
    }
    throw thrown;
  };
}

/** A `load()` that fails before any request is made — the startup timeout, or a bad argument. */
export function failingLoadWithNoRequest(thrown: Error) {
  return async (): Promise<never> => {
    throw thrown;
  };
}

/** A credential that answers instantly. */
export function respondingCredential() {
  return {
    getToken: async () => ({ token: 'not-a-real-token', expiresOnTimestamp: Date.now() + 3_600_000 }),
  };
}

/** A credential that is asked and never answers — the case a timeout cannot distinguish. */
export function hangingCredential() {
  return { getToken: () => new Promise<never>(() => {}) };
}

/** A `load()` that asks for a token, waits for it, and then fails without making a request. */
export function failingLoadAfterToken(thrown: Error) {
  return async (...args: unknown[]): Promise<never> => {
    const credential = args[1] as { getToken: (s: string) => Promise<unknown> };
    await credential.getToken('https://example.invalid/.default');
    throw thrown;
  };
}

/** A `load()` that asks for a token that never arrives, then fails on the startup timeout. */
export function failingLoadWithPendingToken(thrown: Error) {
  return async (...args: unknown[]): Promise<never> => {
    const credential = args[1] as { getToken: (s: string) => Promise<unknown> };
    void credential.getToken('https://example.invalid/.default').catch(() => undefined);
    throw thrown;
  };
}
