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

/** A Key Vault reference the provider could not resolve. It preserves the cause here. */
export function providerKeyVaultError(underlying: Error): Error {
  const referenceError = new Error('Failed to resolve Key Vault reference.', { cause: underlying });
  referenceError.name = 'KeyVaultReferenceError';
  return new Error('The load operation failed.', { cause: referenceError });
}

/** The provider's own input error, which no amount of retrying can fix. */
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

/** A `load()` that fails before any request is made — the startup timeout, or a bad argument. */
export function failingLoadWithNoRequest(thrown: Error) {
  return async (): Promise<never> => {
    throw thrown;
  };
}
