import { load, type AzureAppConfiguration } from '@azure/app-configuration-provider';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import type { BackoffOptions, HydrateOptions, HydrationResult, HydrationState } from './interface';

export type { BackoffOptions, HydrateOptions, HydrationResult, KeyMap, Logger } from './interface';

/**
 * A load that failed, with the reason the provider hides.
 *
 * A refused read surfaces from the provider as `All fallback clients failed to get configuration
 * settings` three times and then `The load operation timed out`, with no 403 anywhere — a revoked
 * grant and an unreachable store are indistinguishable. `detail` is the unwrapped underlying
 * cause, which is the part that tells them apart.
 */
export class ConfigLoadError extends Error {
  /** The provider's own error, unmodified. */
  override readonly cause: unknown;
  /** The underlying reason, unwrapped from the provider's aggregate. */
  readonly detail: string;
  /** HTTP status of the innermost error that carried one, when there was one. */
  readonly statusCode: number | undefined;

  constructor(message: string, cause: unknown) {
    const { detail, statusCode } = unwrap(cause);
    super(`${message}: ${detail}`);
    this.name = 'ConfigLoadError';
    this.cause = cause;
    this.detail = detail;
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_FLOOR_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 600_000;

/** See {@link HydrationState} — one object, so that {@link resetHydration} clears all of it. */
let state: HydrationState = {};

/**
 * One attempt to read the store and write the environment.
 *
 * Does not loop. Retry policy belongs to the caller: a function invocation with a five-minute
 * timeout must not contain a ten-minute backoff loop. {@link hydrateWithBackoff} is the helper
 * for long-lived processes.
 *
 * A success is memoised, so every later call is free. A failure is *not* — caching a rejected
 * promise would make the first attempt the only one — but a further attempt inside
 * `retryFloorMs` re-throws the previous error without touching the store. Without that floor,
 * eight queue triggers each re-hydrating on every invocation spend a Free store's daily quota
 * (1,000 requests, then HTTP 429 to every reader until midnight UTC) in minutes, and starve
 * every other consumer of the store with them.
 */
export function hydrate(options: HydrateOptions): Promise<HydrationResult> {
  if (state.inFlight) {
    return state.inFlight;
  }

  if (state.failedAt !== undefined) {
    const floorMs = options.retryFloorMs ?? DEFAULT_RETRY_FLOOR_MS;
    if (Date.now() - state.failedAt < floorMs) {
      // Inside the floor. Re-throw the previous error; the store is not touched.
      return Promise.reject(state.lastError);
    }
  }

  const attempt = attemptHydration(options).catch((error: unknown) => {
    state.inFlight = undefined;
    state.failedAt = Date.now();
    state.lastError = error;
    throw error;
  });

  state.inFlight = attempt;
  return attempt;
}

/**
 * Calls {@link hydrate} until it succeeds, widening the delay from `initialMs` to `maxMs`.
 * Never rejects: it retries forever, by design. **Long-lived processes only.**
 *
 * Bind the port and answer unhealthy before calling this. A configuration failure then reaches
 * the platform as a container that started and is unhealthy, rather than one that never opened
 * its port — and a store that recovers inside the window heals the application with no restart.
 *
 * `hydrate`'s retry floor still applies, so a delay shorter than `retryFloorMs` produces an
 * attempt that re-throws the previous error without touching the store. That is the floor doing
 * its job; the effect is that the first real re-attempt lands at the floor rather than at
 * `initialMs`, which is immaterial when RBAC propagation is measured in minutes.
 */
export async function hydrateWithBackoff(
  options: HydrateOptions,
  backoff: BackoffOptions = {}
): Promise<HydrationResult> {
  const initialMs = backoff.initialMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxMs = backoff.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
  const logger = options.logger ?? console;
  const onError =
    backoff.onError ??
    ((error: unknown, nextDelayMs: number) => {
      const message = error instanceof Error ? error.message : String(error);
      const report = logger.error ?? logger.log;
      report.call(logger, `Configuration load failed, retrying in ${nextDelayMs / 1000}s: ${message}`);
    });

  for (let delay = initialMs; ; delay = Math.min(delay * 2, maxMs)) {
    try {
      return await hydrate(options);
    } catch (error) {
      onError(error, delay);
      await sleep(delay);
    }
  }
}

/** Clears the memoised result and the retry floor. For tests. */
export function resetHydration(): void {
  state = {};
}

async function attemptHydration(options: HydrateOptions): Promise<HydrationResult> {
  const keys = options.keys;
  const entries = Object.entries(keys);
  if (entries.length === 0) {
    throw new Error('hydrate() was called with no keys');
  }
  for (const [key] of entries) {
    // Invariant, enforced rather than documented: one selector per key, never a filter. A
    // wildcard here would reach the provider as a wildcard selector and resolve every Key Vault
    // reference behind it.
    if (key.includes('*')) {
      throw new Error(
        `Wildcard key "${key}" is not allowed: keys must be listed one by one, because every Key Vault reference the provider loads it also resolves`
      );
    }
  }

  const label = options.label ?? process.env.APP_CONFIG_LABEL;
  if (!label) {
    throw new Error('APP_CONFIG_LABEL is not set (expected "prod" or "staging")');
  }

  const logger = options.logger ?? console;
  const config = await loadStore(entries.map(([key]) => key), label, options);
  const localWins = options.localOverridesWin ?? process.env.NODE_ENV === 'development';

  const missing: string[] = [];
  const applied: string[] = [];
  const kept: string[] = [];

  for (const [key, variable] of entries) {
    const value = config.get<string>(key);
    if (value === undefined || value === '') {
      missing.push(`${key} (label ${label})`);
      continue;
    }
    const local = process.env[variable];
    if (localWins && local !== undefined && local !== '') {
      kept.push(variable);
      continue;
    }
    process.env[variable] = value;
    applied.push(variable);
  }

  if (missing.length) {
    // Every missing name at once. A caller fixing the store should not have to redeploy to
    // discover the second gap.
    throw new Error(`Missing key-values in App Configuration: ${missing.join(', ')}`);
  }

  logger.log(
    `Configuration loaded from App Configuration, label ${label}: ${applied.join(', ') || 'nothing'}`
  );
  if (kept.length) {
    logger.log(`Kept from the local environment: ${kept.join(', ')}`);
  }

  return { label, applied, kept };
}

async function loadStore(
  keys: string[],
  label: string,
  options: HydrateOptions
): Promise<AzureAppConfiguration> {
  let credential: TokenCredential | undefined = options.credential;
  const getCredential = (): TokenCredential => (credential ??= new DefaultAzureCredential());

  const connectionString = options.connectionString ?? process.env.APP_CONFIG_CONNECTION_STRING;
  const endpoint = options.endpoint ?? process.env.APP_CONFIG_ENDPOINT;
  if (!connectionString && !endpoint) {
    throw new Error('Neither APP_CONFIG_ENDPOINT nor APP_CONFIG_CONNECTION_STRING is set');
  }

  const loadOptions = {
    selectors: keys.map(key => ({ keyFilter: key, labelFilter: label })),
    keyVaultOptions: { credential: getCredential() },
    startupOptions: { timeoutInMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  };

  try {
    // The access-key path exists for a run with no identity to borrow. Where the store has local
    // auth disabled, the endpoint path is the only one that works: the instance metadata endpoint
    // in Azure, `az login` on a developer machine, and AZURE_CLIENT_ID / AZURE_TENANT_ID /
    // AZURE_CLIENT_SECRET for a container run off-platform.
    if (connectionString) {
      return await load(connectionString, loadOptions);
    }
    return await load(endpoint as string, getCredential(), loadOptions);
  } catch (error) {
    const where = connectionString ? 'the configured connection string' : endpoint;
    throw new ConfigLoadError(
      `Could not read App Configuration at ${where}, label ${label}`,
      error
    );
  }
}

/**
 * Walk an error's `errors` array and `cause` chain down to the leaves and report what is there.
 *
 * The provider wraps a refused read in an aggregate of identical fallback-client failures and
 * then in a timeout. The distinguishing fact — a 403, a DNS failure, an expired token — is at the
 * bottom, and nothing above it mentions it.
 */
function unwrap(error: unknown): { detail: string; statusCode: number | undefined } {
  const leaves: unknown[] = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
    }
    const nested = childrenOf(value);
    if (nested.length === 0) {
      leaves.push(value);
      return;
    }
    for (const child of nested) walk(child);
  };
  walk(error);

  if (leaves.length === 0) leaves.push(error);

  const statusCode = leaves.map(statusOf).find(code => code !== undefined);

  const messages: string[] = [];
  for (const leaf of leaves) {
    const text = describe(leaf);
    if (text && !messages.includes(text)) messages.push(text);
  }

  return { detail: messages.join('; ') || 'no underlying error reported', statusCode };
}

function childrenOf(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  const record = value as { errors?: unknown; cause?: unknown };
  if (Array.isArray(record.errors) && record.errors.length > 0) return record.errors;
  if (record.cause !== undefined && record.cause !== null) return [record.cause];
  return [];
}

function statusOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const candidate of [record.statusCode, record.status, record.response?.status]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    const status = statusOf(value);
    const code = (value as { code?: unknown }).code;
    const qualifiers: string[] = [];
    if (status !== undefined) qualifiers.push(`HTTP ${status}`);
    if (typeof code === 'string' && code !== '') qualifiers.push(code);
    return qualifiers.length ? `${value.message} [${qualifiers.join(' ')}]` : value.message;
  }
  return typeof value === 'string' ? value : String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
