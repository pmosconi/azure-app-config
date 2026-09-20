import { load, type AzureAppConfiguration } from '@azure/app-configuration-provider';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { createDiagnostics, describeObservations, type Diagnostics } from './diagnostics';
import type {
  BackoffOptions,
  FailureObservation,
  HydrateOptions,
  HydrationResult,
  HydrationState,
} from './interface';

export type { BackoffOptions, HydrateOptions, HydrationResult, KeyMap, Logger } from './interface';

/**
 * A load that failed for a reason retrying cannot change: a key map with a wildcard in it, no
 * label, no endpoint, or a request the store rejected as malformed.
 *
 * {@link hydrateWithBackoff} re-throws this instead of retrying. A container that loops forever
 * on a typo is indistinguishable from one waiting out a genuine outage, and only one of those is
 * worth waiting for.
 */
export class ConfigInputError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ConfigInputError';
    this.cause = cause;
  }
}

/**
 * A load that failed, with the reason the provider discards.
 *
 * A refused read surfaces from the provider as `The load operation failed.` wrapping
 * `All fallback clients failed to get configuration settings.` — a sentence it constructs fresh,
 * having caught the underlying `RestError` and moved on without it. No 403 survives anywhere in
 * the chain, so a revoked grant and an unreachable store read identically.
 *
 * `detail` is therefore not an unwrapping of what the provider handed us. It is what the
 * diagnostics policy saw on the wire while the provider was failing — see `diagnostics.ts`. Where
 * the provider does preserve a cause (a 404, a 400, an unresolvable Key Vault reference), that is
 * used instead, because it is the more specific fact.
 */
export class ConfigLoadError extends Error {
  /** The provider's own error, unmodified. */
  override readonly cause: unknown;
  /** The underlying reason: what the store actually answered. */
  readonly detail: string;
  /** HTTP status of the failure, when one was observed. */
  readonly statusCode: number | undefined;
  /** Every distinct failure seen on the wire during the attempt. Empty if none got that far. */
  readonly observations: FailureObservation[];

  constructor(message: string, cause: unknown, observations: FailureObservation[] = []) {
    const { detail, statusCode } = explain(cause, observations);
    super(`${message}: ${detail}`);
    this.name = 'ConfigLoadError';
    this.cause = cause;
    this.detail = detail;
    this.statusCode = statusCode;
    this.observations = observations;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_FLOOR_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 600_000;

/**
 * The sentences the provider produces in place of a cause. Recognising them is what lets the
 * diagnostics observations take over: anything else in the chain is a real error and wins.
 */
const ALL_FALLBACK_CLIENTS_FAILED = 'All fallback clients failed to get configuration settings.';
const LOAD_OPERATION_TIMED_OUT = 'The load operation timed out.';
const LOAD_OPERATION_FAILED = 'The load operation failed.';

const OPAQUE_PROVIDER_MESSAGES = [
  ALL_FALLBACK_CLIENTS_FAILED,
  LOAD_OPERATION_TIMED_OUT,
  LOAD_OPERATION_FAILED,
];

function freshState(): HydrationState {
  return { attempts: new Map() };
}

let state: HydrationState = freshState();

/**
 * One attempt to read the store and write the environment.
 *
 * Does not loop. Retry policy belongs to the caller: a function invocation with a five-minute
 * timeout must not contain a ten-minute backoff loop. {@link hydrateWithBackoff} is the helper
 * for long-lived processes.
 *
 * A success is memoised against the key map and label it was made with, so every later call with
 * the same pair is free and a call with a different pair is actually performed. A failure is
 * *not* memoised — caching a rejected promise would make the first attempt the only one — but a
 * further attempt inside `retryFloorMs` re-throws the previous error without touching the store.
 * Without that floor, eight queue triggers each re-hydrating on every invocation spend a Free
 * store's daily quota (1,000 requests, then HTTP 429 to every reader until midnight UTC) in
 * minutes, and starve every other consumer of the store with them.
 */
export function hydrate(options: HydrateOptions): Promise<HydrationResult> {
  let plan: Plan;
  try {
    plan = validate(options);
  } catch (error) {
    // Bad input never reaches the store, so it neither consumes the quota nor arms the floor.
    return Promise.reject(error);
  }

  const memoised = state.attempts.get(plan.fingerprint);
  if (memoised) {
    return memoised;
  }

  if (state.failedAt !== undefined) {
    const floorMs = options.retryFloorMs ?? DEFAULT_RETRY_FLOOR_MS;
    if (Date.now() - state.failedAt < floorMs) {
      // Inside the floor. Re-throw the previous error; the store is not touched.
      return Promise.reject(state.lastError);
    }
  }

  // Capture the state object, not the binding. A rejection that lands after resetHydration() must
  // not clear a memo or re-arm a floor that belongs to the state which replaced this one.
  const current = state;
  const attempt = attemptHydration(plan, options).catch((error: unknown) => {
    if (state === current) {
      current.attempts.delete(plan.fingerprint);
      if (!(error instanceof ConfigInputError)) {
        current.failedAt = Date.now();
        current.lastError = error;
      }
    }
    throw error;
  });

  current.attempts.set(plan.fingerprint, attempt);
  return attempt;
}

/**
 * Calls {@link hydrate} until it succeeds, widening the delay from `initialMs` to `maxMs`.
 * **Long-lived processes only.**
 *
 * Bind the port and answer unhealthy before calling this. A configuration failure then reaches
 * the platform as a container that started and is unhealthy, rather than one that never opened
 * its port — and a store that recovers inside the window heals the application with no restart.
 *
 * It retries a failure the store could recover from for as long as that takes, and rejects
 * immediately on a {@link ConfigInputError}, which no amount of waiting will fix.
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
      if (error instanceof ConfigInputError) throw error;
      onError(error, delay);
      await sleep(delay);
    }
  }
}

/** Clears the memoised results and the retry floor. For tests. */
export function resetHydration(): void {
  state = freshState();
}

/** A validated call: everything checked before a request is worth making. */
interface Plan {
  entries: [string, string][];
  label: string;
  fingerprint: string;
}

function validate(options: HydrateOptions): Plan {
  const entries = Object.entries(options.keys);
  if (entries.length === 0) {
    throw new ConfigInputError('hydrate() was called with no keys');
  }
  for (const [key] of entries) {
    // Invariant, enforced rather than documented: one selector per key, never a filter. A
    // wildcard here would reach the provider as a wildcard selector and resolve every Key Vault
    // reference behind it.
    if (key.includes('*')) {
      throw new ConfigInputError(
        `Wildcard key "${key}" is not allowed: keys must be listed one by one, because every Key Vault reference the provider loads it also resolves`
      );
    }
  }

  const label = options.label ?? process.env.APP_CONFIG_LABEL;
  if (!label) {
    throw new ConfigInputError('APP_CONFIG_LABEL is not set (expected "prod" or "staging")');
  }

  const connectionString = options.connectionString ?? process.env.APP_CONFIG_CONNECTION_STRING;
  const endpoint = options.endpoint ?? process.env.APP_CONFIG_ENDPOINT;
  if (!connectionString && !endpoint) {
    throw new ConfigInputError('Neither APP_CONFIG_ENDPOINT nor APP_CONFIG_CONNECTION_STRING is set');
  }

  return { entries, label, fingerprint: fingerprint(entries, label) };
}

/**
 * What makes two calls the same call. Order-insensitive, so two modules listing the same keys in
 * a different order share one attempt rather than making two.
 */
function fingerprint(entries: [string, string][], label: string): string {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([label, sorted]);
}

async function attemptHydration(plan: Plan, options: HydrateOptions): Promise<HydrationResult> {
  const { entries, label } = plan;
  const logger = options.logger ?? console;
  const config = await loadStore(entries.map(([key]) => key), label, options);
  const localWins = options.localOverridesWin ?? process.env.NODE_ENV === 'development';

  const unusable: string[] = [];
  const applied: string[] = [];
  const kept: string[] = [];

  for (const [key, variable] of entries) {
    // Precedence first. Under NODE_ENV=development a .env line is allowed to stand in for a key
    // that is not in the store yet — which is the point of the inversion, and is why this test
    // comes before the one for a missing value rather than after it.
    const local = process.env[variable];
    if (localWins && local !== undefined && local !== '') {
      kept.push(variable);
      continue;
    }

    const value = config.get<unknown>(key);
    if (value === undefined || value === '') {
      unusable.push(`${key} (label ${label}, absent or empty)`);
      continue;
    }
    // `get<string>()` is a promise the provider does not keep: a key-value with a JSON content
    // type comes back parsed, and assigning that to an environment variable stores the string
    // "[object Object]" and reports it as applied. An environment variable is a string or it is
    // a mistake.
    if (typeof value !== 'string') {
      unusable.push(`${key} (label ${label}, ${typeName(value)} rather than a string)`);
      continue;
    }

    process.env[variable] = value;
    applied.push(variable);
  }

  if (unusable.length) {
    // Every name at once. A caller fixing the store should not have to redeploy to discover the
    // second gap.
    throw new Error(`Missing key-values in App Configuration: ${unusable.join(', ')}`);
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

  const diagnostics: Diagnostics = createDiagnostics();
  const loadOptions = {
    selectors: keys.map(key => ({ keyFilter: key, labelFilter: label })),
    keyVaultOptions: { credential: getCredential() },
    startupOptions: { timeoutInMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    clientOptions: {
      // `perRetry` puts this below the SDK's own retry policy, so it sees every attempt rather
      // than only the last. The provider merges clientOptions into every client it builds.
      additionalPolicies: [{ policy: diagnostics.policy, position: 'perRetry' as const }],
    },
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
    const message = `Could not read App Configuration at ${where}, label ${label}`;
    const observations = diagnostics.observations();
    if (hasInputError(error)) {
      const { detail } = explain(error, observations);
      throw new ConfigInputError(`${message}: ${detail}`, error);
    }
    throw new ConfigLoadError(message, error, observations);
  }
}

/**
 * Decide what to report as the underlying reason.
 *
 * The provider's own chain wins when it contains anything real, because a preserved cause is more
 * specific than a status seen in passing — an unresolvable Key Vault reference, for instance, is
 * reported by the provider and produces no failing App Configuration request at all. When the
 * chain contains only the provider's manufactured sentences, the observations are all there is.
 */
function explain(
  cause: unknown,
  observations: FailureObservation[]
): { detail: string; statusCode: number | undefined } {
  const unwrapped = unwrap(cause);
  if (!unwrapped.opaque) {
    return { detail: unwrapped.detail, statusCode: unwrapped.statusCode };
  }

  if (observations.length > 0) {
    return {
      detail: describeObservations(observations),
      statusCode: observations.map(o => o.status).find(status => status !== undefined),
    };
  }

  // Nothing was observed. What can honestly be concluded from that depends entirely on which
  // sentence the provider produced, and one of the two is a contradiction rather than a fact.

  if (unwrapped.messages.includes(ALL_FALLBACK_CLIENTS_FAILED)) {
    // This combination is impossible while the diagnostics policy is running. The provider throws
    // this only after iterating clients that each threw a *failoverable* error, and
    // `isFailoverableError` requires `isRestError` — a >= 400 response, or a transport failure
    // carrying a code. Both are things the policy records. So zero observations here does not
    // mean the store was quiet; it means the policy never ran, and the cause is unreported.
    //
    // Saying anything about the store at this point would be a guess presented as a finding,
    // which is the failure mode this whole file exists to remove.
    return {
      detail: `${unwrapped.detail} (the cause is unreported: no HTTP failure was observed, which cannot happen while the diagnostics policy is running, so the provider is no longer honouring clientOptions and the real reason was discarded)`,
      statusCode: undefined,
    };
  }

  if (unwrapped.messages.includes(LOAD_OPERATION_TIMED_OUT)) {
    // A store that is unreachable or refusing *is* observed — a refused connection and a failed
    // name lookup both throw in the transport, under the policy. So a timeout with nothing
    // observed means nothing reached the transport: the credential never arrived, or the abort
    // fired before the first request went out. That is not evidence about the store.
    return {
      detail: `${unwrapped.detail} (no request reached the transport before the startup timeout, so the credential or the first send is the suspect rather than the store)`,
      statusCode: undefined,
    };
  }

  return { detail: `${unwrapped.detail} (no request was observed)`, statusCode: undefined };
}

/**
 * Walk an error's `errors` array and `cause` chain down to the leaves and report what is there.
 *
 * Works for the failures the provider preserves — a 404, a 400, a Key Vault reference it could
 * not resolve. `opaque` says that it did not: that every leaf is one of the sentences the
 * provider manufactures, and the real reason has to come from somewhere else.
 */
function unwrap(error: unknown): {
  detail: string;
  statusCode: number | undefined;
  opaque: boolean;
  messages: string[];
} {
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

  const opaque =
    statusCode === undefined &&
    leaves.every(leaf => leaf instanceof Error && OPAQUE_PROVIDER_MESSAGES.includes(leaf.message));

  const rawMessages = leaves
    .filter((leaf): leaf is Error => leaf instanceof Error)
    .map(leaf => leaf.message);

  return {
    detail: messages.join('; ') || 'no underlying error reported',
    statusCode,
    opaque,
    messages: rawMessages,
  };
}

/** The provider's own classification: `ArgumentError`, `TypeError`, `RangeError` are input errors. */
function hasInputError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') {
      if (seen.has(value)) return false;
      seen.add(value);
    }
    if (value instanceof TypeError || value instanceof RangeError) return true;
    if (value instanceof Error && value.name === 'ArgumentError') return true;
    return childrenOf(value).some(walk);
  };
  return walk(error);
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

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'a JSON array';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'a JSON object';
  return `a ${typeof value}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
