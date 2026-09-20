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
export function fakeStore(values: Record<string, string> = VALUES) {
  return {
    get: vi.fn((key: string) => values[key]),
  };
}

/** The variables the key map writes into, so a test can prove none of them leaked between tests. */
export const MANAGED_VARIABLES = Object.values(KEYS);

export function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

/** An error shaped the way the provider reports a refused read: identical wrappers, cause at the bottom. */
export function providerAggregate(underlying: Error): Error {
  const fallbackFailures = new Error('All fallback clients failed to get configuration settings.');
  (fallbackFailures as Error & { errors: unknown[] }).errors = [underlying, underlying, underlying];
  const timeout = new Error('The load operation timed out.');
  (timeout as Error & { cause: unknown }).cause = fallbackFailures;
  return timeout;
}

/** A 403 as the SDK reports one. */
export function forbidden(): Error {
  const error = new Error(
    'Operation returned an invalid status code: Forbidden'
  ) as Error & { statusCode: number; code: string };
  error.statusCode = 403;
  error.code = 'AuthorizationFailed';
  return error;
}
