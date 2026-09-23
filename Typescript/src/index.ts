import { load, type AzureAppConfiguration } from '@azure/app-configuration-provider';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import {
  createDiagnostics,
  describeObservations,
  watchCredential,
  type CredentialWatch,
  type Diagnostics,
  type Traffic,
} from './diagnostics';
import type {
  BackoffOptions,
  CallRecord,
  CredentialEvidence,
  FailureObservation,
  HydrateOptions,
  HydrationResult,
  HydrationState,
  HydrationStatus,
  KeyMap,
} from './interface';

export type {
  BackoffOptions,
  HydrateOptions,
  HydrationResult,
  HydrationStatus,
  KeyMap,
  Logger,
} from './interface';

/**
 * A load that failed for a reason retrying cannot change: a key map with a wildcard in it, no
 * label, no endpoint, or input the provider rejected as malformed.
 *
 * `instanceof ConfigInputError` means one thing wherever it is caught: don't wait, waiting won't
 * fix it — a change to the call or to the store will. {@link hydrateWithBackoff} re-throws it
 * instead of retrying. A container that loops forever on a typo is indistinguishable from one
 * waiting out a genuine outage, and only one of those is worth waiting for.
 */
export class ConfigInputError extends Error {
  override readonly cause: unknown;
  /**
   * Whether a response had come back from the store before the input was rejected.
   *
   * `false` for everything rejected before that — the checks `hydrate()` makes itself, and the
   * provider's own argument checks. That spent nothing, so it does not arm the retry floor. `true`
   * when the provider rejected something after the store had answered: that attempt spent quota,
   * and repeating it on every call would spend it again, so it arms the floor like any other
   * failure. It is still an input error, because waiting alone will not fix it.
   *
   * Defensive on provider 2.6.0: no store data we could find reaches the provider's post-read
   * input-error path (a broken Key Vault reference surfaces as a startup timeout instead), so in
   * practice every `ConfigInputError` it produces has `reachedStore: false`.
   */
  readonly reachedStore: boolean;

  constructor(message: string, cause?: unknown, reachedStore = false) {
    super(message);
    this.name = 'ConfigInputError';
    this.cause = cause;
    this.reachedStore = reachedStore;
  }
}

/**
 * Added to `retryAfterMs` so that a caller who waits exactly that long lands outside the floor.
 * A timer can fire a millisecond or so early relative to `Date.now()`, and a retry that lands a
 * millisecond inside the floor is another `ConfigFloorError` — for a message handler, the
 * dead-letter path this error exists to avoid. The floor itself is enforced exactly.
 */
const FLOOR_MARGIN_MS = 50;

/**
 * A call `hydrate()` refused to make because the retry floor is closed. No request was sent.
 *
 * Not a fresh failure, and deliberately not a {@link ConfigLoadError}: nothing was attempted, and
 * telemetry that counts load failures must not count this. `cause` is the error of the attempt
 * that armed the floor — any of the three kinds, and the same object on every rejection until the
 * floor opens. `retryAfterMs` is how long to wait: the time until the floor opens, measured with
 * this call's `retryFloorMs`, rounded up to a whole millisecond, plus a 50 ms margin so a timer
 * that fires slightly early still lands outside it. A call made after that reaches the store.
 *
 * In a message-triggered handler, a bare re-throw of this abandons the message, the broker
 * redelivers it at once, and every redelivery fails the same way within milliseconds — so the
 * delivery count is spent in seconds and the message is dead-lettered. Wait `retryAfterMs`, try
 * once more, and only then give up. See the README.
 */
export class ConfigFloorError extends Error {
  /** The error of the attempt that armed the floor, unmodified. */
  override readonly cause: unknown;
  /** Milliseconds to wait before the next call reaches the store: until the floor opens, plus 50 ms. */
  readonly retryAfterMs: number;

  /** @param opensInMs Milliseconds until the floor opens, exactly. */
  constructor(opensInMs: number, lastError: unknown) {
    const last = lastError instanceof Error ? lastError.message : String(lastError);
    super(
      `App Configuration not attempted: the retry floor opens in ${Math.ceil(opensInMs / 1000)}s. The last attempt failed: ${last}`
    );
    this.name = 'ConfigFloorError';
    this.cause = lastError;
    this.retryAfterMs = Math.max(0, Math.ceil(opensInMs)) + FLOOR_MARGIN_MS;
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
 * the provider does preserve a cause (a 404, a 400), that is used instead, because it is the more
 * specific fact.
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

  constructor(
    message: string,
    cause: unknown,
    observations: FailureObservation[] = [],
    credential?: CredentialEvidence
  ) {
    const { detail, statusCode } = explain(cause, observations, credential, wireForNextError);
    super(`${message}: ${detail}`);
    this.name = 'ConfigLoadError';
    this.cause = cause;
    this.detail = detail;
    this.statusCode = statusCode;
    this.observations = observations;
  }
}

/**
 * What the wire showed during the attempt that is about to become a {@link ConfigLoadError}. Set
 * by {@link loadError} for the length of one synchronous constructor call, so the evidence reaches
 * the constructor without widening its public signature beyond 0.1.0's.
 */
let wireForNextError: WireEvidence | undefined;

function loadError(
  message: string,
  cause: unknown,
  observations: FailureObservation[],
  credential: CredentialEvidence | undefined,
  wire: WireEvidence
): ConfigLoadError {
  wireForNextError = wire;
  try {
    return new ConfigLoadError(message, cause, observations, credential);
  } finally {
    wireForNextError = undefined;
  }
}

/**
 * Request counts for the attribution, taken when the startup timeout fired if it did, and when
 * the load rejected otherwise. Internal.
 */
interface WireEvidence {
  traffic: Traffic;
  /** One selector per key: the number of list requests a complete first read takes, at least. */
  selectors: number;
  atTimeout: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** The largest delay `setTimeout` honours; Node turns anything longer into 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * The default `retryFloorMs`: after a failed attempt, 30 s during which `hydrate()` rejects with a
 * {@link ConfigFloorError} instead of reaching the store. Exported so a caller that waits out the
 * floor, or sizes a queue's redelivery around it, lines up with the real value.
 */
export const DEFAULT_RETRY_FLOOR_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 600_000;

/**
 * The sentences the provider produces in place of a cause. Recognising them is what lets the
 * diagnostics observations take over: anything else in the chain is a real error and wins.
 */
const OPAQUE_PROVIDER_MESSAGES = [
  // Kept although it never reaches a caller from the startup path today — it is a plain Error, so
  // the provider's retry loop finds it neither an input nor a REST error and backs off on it until
  // the abort, by which point the timeout has won. Nothing is keyed on it: a guard that reads the
  // provider's wording is a guard that fails open when the wording changes. See explain().
  'All fallback clients failed to get configuration settings.',
  'The load operation timed out.',
  'The load operation failed.',
];

function freshState(): HydrationState {
  return { calls: new Map() };
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
 * further call inside `retryFloorMs` rejects with a {@link ConfigFloorError} without touching the
 * store. Without that floor, eight queue triggers each re-hydrating on every invocation spend a
 * Free store's daily quota (1,000 requests, then HTTP 429 to every reader until midnight UTC) in
 * minutes, and starve every other consumer of the store with them.
 *
 * Every failure that reached the store arms the floor — a failed request, a missing key, and an
 * input error raised after the store answered. Only input rejected before any request leaves it
 * alone. A floor rejection's `retryAfterMs` includes a small margin, so a caller who waits exactly
 * that long reaches the store even if the timer fires a little early.
 *
 * Nothing is written unless every key is usable: a rejection leaves `process.env` as it was.
 */
export function hydrate(options: HydrateOptions): Promise<HydrationResult> {
  let plan: Plan;
  try {
    plan = validate(options);
  } catch (error) {
    // Rejected before any request, so it neither consumes the quota nor arms the floor.
    return Promise.reject(error);
  }

  const record = state.calls.get(plan.fingerprint);
  if (record?.promise) {
    return record.promise;
  }

  if (state.failedAt !== undefined) {
    const floorMs = options.retryFloorMs ?? DEFAULT_RETRY_FLOOR_MS;
    const opensInMs = state.failedAt + floorMs - Date.now();
    if (opensInMs > 0) {
      // Inside the floor. Say so, rather than re-throwing the last error as if it were new: the
      // store is not touched, and a caller must be able to tell this from a fresh failure.
      return Promise.reject(new ConfigFloorError(opensInMs, state.lastError));
    }
  }

  // Capture the state object, not the binding. A rejection that lands after resetHydration() must
  // not clear a memo or re-arm a floor that belongs to the state which replaced this one.
  const current = state;
  const entry: CallRecord = record ?? {};
  current.calls.set(plan.fingerprint, entry);

  const attempt = attemptHydration(plan, options).then(
    result => {
      entry.result = result;
      return result;
    },
    (error: unknown) => {
      if (state === current) {
        const now = Date.now();
        entry.promise = undefined;
        entry.failedAt = now;
        entry.lastError = error;
        if (armsFloor(error)) {
          current.failedAt = now;
          current.lastError = error;
          current.floorMs = options.retryFloorMs ?? DEFAULT_RETRY_FLOOR_MS;
        }
      }
      throw error;
    }
  );

  entry.promise = attempt;
  return attempt;
}

/**
 * What {@link hydrate} has done for this key map and label, without doing anything.
 *
 * **Never makes a request and never starts an attempt**, whatever the state — so a health
 * endpoint can report configuration health on every ping without spending the store's quota. On
 * a Free store, pinging `hydrate()` instead during an outage spends the day's requests within
 * about an hour, and no finite floor fixes that across several instances.
 *
 * The label resolves as it does for `hydrate()`: the argument, else `APP_CONFIG_LABEL`. Throws
 * {@link ConfigInputError} for no keys, an unescaped `*` or `,` in a key, no label, or a `*` or `,`
 * in the label — calls there can never be an attempt for. It does not check the endpoint or the
 * timing options, and cannot run the provider's own pre-request checks.
 *
 * `nextAttemptAt` is when the floor opens for the floor of the attempt that armed it — its
 * `retryFloorMs` — exactly, with no margin. `hydrate()` enforces each caller's own `retryFloorMs`,
 * so a caller passing a different value sees a different window; its `ConfigFloorError` carries
 * the wait measured with its own floor. A process that passes one value everywhere, or none, sees
 * the two agree.
 */
export function hydrationStatus(keys: KeyMap, label?: string): HydrationStatus {
  const plan = planFor(keys, label);
  const record = state.calls.get(plan.fingerprint);

  if (record?.result) {
    return { state: 'loaded', loadedAt: record.result.loadedAt };
  }
  const lastFailure =
    record?.failedAt !== undefined ? { failedAt: record.failedAt, lastError: record.lastError } : {};
  if (record?.promise) {
    return { state: 'pending', ...lastFailure };
  }

  const floor: { nextAttemptAt?: number } = {};
  if (state.failedAt !== undefined) {
    const opensAt = state.failedAt + (state.floorMs ?? DEFAULT_RETRY_FLOOR_MS);
    if (opensAt > Date.now()) floor.nextAttemptAt = opensAt;
  }
  if (record?.failedAt !== undefined) {
    return { state: 'failing', ...lastFailure, ...floor };
  }
  return { state: 'none', ...floor };
}

/**
 * Calls {@link hydrate} until it succeeds, widening the delay from `initialMs` to `maxMs`.
 * **Long-lived processes only.**
 *
 * Bind the port and answer unhealthy before calling this. A configuration failure then reaches
 * the platform as a container that started and is unhealthy, rather than one that never opened
 * its port — and a store that recovers inside the window heals the application with no restart.
 *
 * It retries a failure the store could recover from for as long as that takes — a missing key
 * included, since adding it to the store heals the process — and rejects immediately on a
 * {@link ConfigInputError}, which no amount of waiting will fix.
 *
 * `hydrate`'s retry floor still applies. A {@link ConfigFloorError} is not a failed attempt, so it
 * is not reported to `onError`, not logged, and does not widen the delay: the loop sleeps until
 * the floor opens and calls again. The effect is that a re-attempt lands at the floor rather than
 * at a shorter delay, which is immaterial when RBAC propagation is measured in minutes.
 *
 * Never inside a function invocation: it does not return until the store answers, which can be
 * long after the invocation's own timeout.
 */
export async function hydrateWithBackoff(
  options: HydrateOptions,
  backoff: BackoffOptions = {}
): Promise<HydrationResult> {
  const initialMs = backoff.initialMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxMs = backoff.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
  // A delay of zero or NaN would turn the loop into a spin against a floor of zero.
  positive('initialMs', initialMs);
  positive('maxMs', maxMs);
  const floorMs = options.retryFloorMs ?? DEFAULT_RETRY_FLOOR_MS;
  const logger = options.logger ?? console;
  const onError =
    backoff.onError ??
    ((error: unknown, nextDelayMs: number) => {
      const message = error instanceof Error ? error.message : String(error);
      const report = logger.error ?? logger.log;
      report.call(logger, `Configuration load failed, retrying in ${nextDelayMs / 1000}s: ${message}`);
    });

  let delay = initialMs;
  for (;;) {
    try {
      return await hydrate(options);
    } catch (error) {
      if (error instanceof ConfigInputError) throw error;
      if (error instanceof ConfigFloorError) {
        // Nothing was attempted, so nothing failed: wait for the floor, and keep the schedule of
        // real attempts where it was. retryAfterMs is never zero, and sleep() never hands
        // setTimeout more than it honours, so this cannot spin.
        await sleep(error.retryAfterMs);
        continue;
      }
      // Report when the next attempt will really happen: a failure that armed the floor holds the
      // next call back until it opens, however short the backoff delay.
      const wait = Math.max(delay, floorWaitMs(floorMs));
      onError(error, wait);
      await sleep(wait);
      delay = Math.min(delay * 2, maxMs);
    }
  }
}

/** Clears the memoised results, the recorded failures and the retry floor. For tests. */
export function resetHydration(): void {
  state = freshState();
}

/** How long a call with this floor would wait for the retry floor now, margin included; 0 if open. */
function floorWaitMs(floorMs: number): number {
  if (state.failedAt === undefined) return 0;
  const opensInMs = state.failedAt + floorMs - Date.now();
  return opensInMs > 0 ? Math.ceil(opensInMs) + FLOOR_MARGIN_MS : 0;
}

/**
 * Whether a failure arms the retry floor: every failure except an input error rejected before the
 * store answered, which spent nothing — holding a corrected call back for it would help no one.
 */
function armsFloor(error: unknown): boolean {
  return !(error instanceof ConfigInputError) || error.reachedStore;
}

/** A validated call: everything checked before a request is worth making. */
interface Plan {
  entries: [string, string][];
  label: string;
  fingerprint: string;
}

function validate(options: HydrateOptions): Plan {
  const plan = planFor(options.keys, options.label);

  // NaN makes every floor comparison false, which turns the floor off: the quota invariant
  // failing open. A huge finite floor is allowed — sleep() and the floor check both handle it.
  if (options.retryFloorMs !== undefined) nonNegative('retryFloorMs', options.retryFloorMs);
  // The provider hands this to setTimeout, which turns anything past 2^31-1 ms into 1 ms.
  if (options.timeoutMs !== undefined) {
    positive('timeoutMs', options.timeoutMs);
    if (options.timeoutMs > MAX_TIMER_MS) {
      throw new ConfigInputError(`timeoutMs must be at most ${MAX_TIMER_MS}, got ${options.timeoutMs}`);
    }
  }

  const connectionString = options.connectionString ?? process.env.APP_CONFIG_CONNECTION_STRING;
  const endpoint = options.endpoint ?? process.env.APP_CONFIG_ENDPOINT;
  if (!connectionString && !endpoint) {
    throw new ConfigInputError('Neither APP_CONFIG_ENDPOINT nor APP_CONFIG_CONNECTION_STRING is set');
  }

  return plan;
}

/** The half of {@link validate} that identifies a call — shared with {@link hydrationStatus}. */
function planFor(keys: KeyMap, labelOption: string | undefined): Plan {
  const entries = Object.entries(keys);
  if (entries.length === 0) {
    throw new ConfigInputError('hydrate() was called with no keys');
  }
  for (const [key] of entries) {
    // Invariant, enforced rather than documented: one selector per key, never a filter. A
    // wildcard here would reach the provider as a wildcard selector and resolve every Key Vault
    // reference behind it. A comma is the same thing spelled differently — App Configuration
    // reads `a,b` as a filter matching both keys. Escaped, `\*` and `\,` match themselves.
    if (hasFilterCharacter(key)) {
      throw new ConfigInputError(
        `Key "${key}" is a filter, not a key: unescaped '*' and ',' are not allowed, and keys must be listed one by one, because every Key Vault reference the provider loads it also resolves`
      );
    }
  }

  const label = labelOption ?? process.env.APP_CONFIG_LABEL;
  if (!label) {
    throw new ConfigInputError('APP_CONFIG_LABEL is not set (expected "prod" or "staging")');
  }
  // Exactly one label. The provider refuses these too, escaped or not (appConfigurationImpl.js:859
  // tests `includes`), but only after a five-second pad, so this mirrors it exactly — escapes
  // included — and keeps hydrationStatus() honest about a call that can never be made.
  if (label.includes('*') || label.includes(',')) {
    throw new ConfigInputError(
      `Label "${label}" is a filter, not a label: '*' and ',' are not allowed, and exactly one label is read`
    );
  }

  return { entries, label, fingerprint: fingerprint(entries, label) };
}

function nonNegative(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigInputError(`${name} must be a finite number of milliseconds, 0 or more, got ${String(value)}`);
  }
}

function positive(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigInputError(`${name} must be a finite number of milliseconds above 0, got ${String(value)}`);
  }
}

/**
 * Whether `text` holds `*` or `,` as a filter character. App Configuration matches a reserved
 * character literally when it is escaped with a backslash, so `\*` and `\,` are part of a key,
 * not a filter: a character counts only when an even number of backslashes precedes it.
 */
function hasFilterCharacter(text: string): boolean {
  let backslashes = 0;
  for (const character of text) {
    if (character === '\\') {
      backslashes++;
      continue;
    }
    if ((character === '*' || character === ',') && backslashes % 2 === 0) return true;
    backslashes = 0;
  }
  return false;
}

/** The key the store holds for a filter with escapes in it — what the provider files it under. */
function unescapeKey(filter: string): string {
  return filter.replace(/\\([\\*,])/g, '$1');
}

/**
 * What makes two calls the same call. Order-insensitive, so two modules listing the same keys in
 * a different order share one attempt rather than making two.
 */
function fingerprint(entries: [string, string][], label: string): string {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([label, sorted]);
}

/**
 * Whether this process is running on a developer machine rather than deployed — the default for
 * `localOverridesWin`. Read on every attempt, never cached.
 *
 * `WEBSITE_INSTANCE_ID` is injected by App Service and Azure Functions on every instance, and set
 * by none of `func start`, a plain `node` run or a test runner. Other hosts set nothing this reads,
 * which is why the option is documented as one they must pass. Never `NODE_ENV`: in a Functions
 * app that is an ordinary per-slot setting, and a slot carrying `development` would let leftover
 * settings beat the store without a word.
 */
function isLocal(): boolean {
  return !process.env.WEBSITE_INSTANCE_ID;
}

/**
 * Which side wins this attempt, and why, for the success line. Stated whether or not anything was
 * kept: on a host where the platform signal is missing, the first sign would otherwise be a stale
 * value winning, and a consumer with no local settings left could never confirm the signal at all.
 *
 * Decided exactly as `options.localOverridesWin ?? isLocal()` always was, and the reason is built
 * from that decision, never from the raw option: a JavaScript caller passing the string `"false"`
 * gets local-wins, because the string is truthy, and the line must say `true`, not echo `false`
 * against the decision. `null` falls through to the platform signal, as `??` does, and the reason
 * names the signal. An empty `WEBSITE_INSTANCE_ID` counts as absent, as {@link isLocal} reads it.
 * Never a value.
 */
function precedence(option: unknown): { localWins: boolean; reason: string } {
  if (option !== undefined && option !== null) {
    const localWins = Boolean(option);
    return { localWins, reason: `localOverridesWin option ${String(localWins)}` };
  }
  const localWins = isLocal();
  return { localWins, reason: `WEBSITE_INSTANCE_ID ${localWins ? 'absent' : 'present'}` };
}

async function attemptHydration(plan: Plan, options: HydrateOptions): Promise<HydrationResult> {
  const { entries, label } = plan;
  // The logger of the call that started this attempt. Callers that join it log nothing.
  const logger = options.logger ?? console;
  const config = await loadStore(entries.map(([key]) => key), label, options);
  const { localWins, reason } = precedence(options.localOverridesWin);

  const unusable: string[] = [];
  const writes: [string, string][] = [];
  const kept: string[] = [];

  for (const [key, variable] of entries) {
    // Precedence first. On a developer machine a .env line is allowed to stand in for a key that
    // is not in the store yet — which is the point of the inversion, and is why this test comes
    // before the one for a missing value rather than after it.
    const local = process.env[variable];
    if (localWins && local !== undefined && local !== '') {
      kept.push(variable);
      continue;
    }

    // The provider files a setting under its real key, so an escaped filter is looked up unescaped.
    const value = config.get<unknown>(unescapeKey(key));
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

    writes.push([variable, value]);
  }

  if (unusable.length) {
    // Every name at once. A caller fixing the store should not have to redeploy to discover the
    // second gap. Nothing has been written: a rejection means the environment is as it was, not
    // a mix of store values and old ones that a process carrying on would run on.
    throw new Error(`Missing key-values in App Configuration: ${unusable.join(', ')}`);
  }

  // All or nothing, and nothing awaited in between, so no other code sees a half-written set.
  const applied: string[] = [];
  for (const [variable, value] of writes) {
    process.env[variable] = value;
    applied.push(variable);
  }

  // One line, names only, never a value. The 0.2.0 prefix is unchanged and the mode follows the
  // list, stated whether or not anything was kept.
  logger.log(
    `Configuration loaded from App Configuration, label ${label}: ${applied.join(', ') || 'nothing'} (${localWins ? 'local' : 'store'} wins: ${reason})`
  );
  if (kept.length) {
    logger.log(`Kept from the local environment: ${kept.join(', ')}`);
  }

  return { label, applied, kept, loadedAt: Date.now() };
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
  // Only the store credential is wrapped. The Key Vault client gets the caller's own object
  // unchanged. A vault failure is not reported with its cause — the provider retries it until the
  // startup timeout — but the store responses that preceded it are counted, and explain() says so.
  let watch: CredentialWatch | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const loadOptions = {
    selectors: keys.map(key => ({ keyFilter: key, labelFilter: label })),
    keyVaultOptions: { credential: getCredential() },
    startupOptions: { timeoutInMs: timeoutMs },
    clientOptions: {
      // `perRetry` puts this below the SDK's own retry policy, so it sees every attempt rather
      // than only the last. The provider merges clientOptions into every client it builds.
      additionalPolicies: [{ policy: diagnostics.policy, position: 'perRetry' as const }],
    },
  };

  // Count the traffic when the startup timeout fires, not when the rejection arrives: the provider
  // holds a rejection until five seconds after it started, and a request answering in that gap
  // would turn "still in flight at the timeout" into "answered".
  let atTimeout: Traffic | undefined;
  const snapshot = setTimeout(() => (atTimeout = diagnostics.traffic()), timeoutMs);
  snapshot.unref?.();

  try {
    // The access-key path exists for a run with no identity to borrow. Where the store has local
    // auth disabled, the endpoint path is the only one that works: the instance metadata endpoint
    // in Azure, `az login` on a developer machine, and AZURE_CLIENT_ID / AZURE_TENANT_ID /
    // AZURE_CLIENT_SECRET for a container run off-platform.
    if (connectionString) {
      return await load(connectionString, loadOptions);
    }
    watch = watchCredential(getCredential());
    return await load(endpoint as string, watch.credential, loadOptions);
  } catch (error) {
    const where = connectionString ? 'the configured connection string' : endpoint;
    const message = `Could not read App Configuration at ${where}, label ${label}`;
    const observations = diagnostics.observations();
    const now = diagnostics.traffic();
    const wire: WireEvidence = {
      traffic: atTimeout ?? now,
      selectors: keys.length,
      atTimeout: atTimeout !== undefined,
    };
    if (hasInputError(error)) {
      // Rejected before the store answered (an argument the provider refused) or after (something
      // it read and could not use). Only the second spent quota, so only the second arms the floor
      // — and any response by now counts, whenever it came.
      const { detail } = explain(error, observations, watch?.evidence(), wire);
      throw new ConfigInputError(`${message}: ${detail}`, error, now.answered > 0);
    }
    throw loadError(message, error, observations, watch?.evidence(), wire);
  } finally {
    clearTimeout(snapshot);
  }
}

/**
 * Decide what to report as the underlying reason.
 *
 * The provider's own chain wins when it contains anything real, because a preserved cause is more
 * specific than a status seen in passing. When the chain contains only the provider's
 * manufactured sentences, the observations are all there is.
 */
function explain(
  cause: unknown,
  observations: FailureObservation[],
  credential: CredentialEvidence | undefined,
  wire?: WireEvidence
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

  return {
    detail: `${unwrapped.detail} ${attributeSilence(credential, wire)}`,
    statusCode: undefined,
  };
}

/**
 * Nothing was observed. Say what that is evidence of — and, where it is evidence of nothing, say
 * that instead of guessing.
 *
 * An unreachable store and a refused one are both *observed*: a failed name lookup and a refused
 * connection each throw in the transport, underneath the policy. So silence is never evidence
 * about the store, and the earlier wording — "the store was unreachable or slower than the
 * startup timeout" — was a guess presented as a finding, which is the failure this package exists
 * to remove. What silence does distinguish is whether the credential answered — and, where the
 * store was asked, what became of each request.
 */
function attributeSilence(credential: CredentialEvidence | undefined, wire: WireEvidence | undefined): string {
  const traffic = wire?.traffic;
  if (wire && traffic && traffic.answered + traffic.pending > 0) {
    return describeTraffic(wire);
  }
  if (credential === undefined) {
    // Accepted limit, not an oversight: on the access-key path there is no token, so drift and a
    // genuinely silent failure are indistinguishable and this says so rather than picking one.
    // Closing it would need a second in-process signal for the one path that carries no
    // production traffic — a store with local auth disabled leaves every deployed consumer on
    // the endpoint path, and this one reaching a developer who can re-read the stack trace,
    // rather than a container answering 503 at four in the morning.
    return '(no request was observed, and no token was in play on this path, so the cause is unreported)';
  }
  if (!credential.requested) {
    return '(no request was observed and no token was ever requested, so the cause is unreported)';
  }
  if (!credential.resolved) {
    return '(the credential was asked for a token and never answered, so the credential is the suspect rather than the store)';
  }
  // The token arrived, so the provider got as far as building a request — and no request was
  // seen. That cannot happen while the policy is installed, so the policy is not installed.
  return '(the credential answered but no request was observed, which cannot happen while the diagnostics policy is running — so the provider is no longer honouring clientOptions, and the real cause was discarded)';
}

/**
 * The store was asked and nothing failed. Say what was seen, and name every cause it leaves open —
 * never one it cannot rule out.
 *
 * A request still in flight is the network path or the store not answering, but on provider
 * 2.6.0 it can also be a re-read: a Key Vault reference the provider cannot parse or resolve makes
 * it re-read the store every few seconds until the timeout, so one may be in flight when it fires.
 * That candidate needs a complete first read — one list request per selector, answered — because
 * references are resolved only after it. With every request answered and a complete read, a Key
 * Vault reference is the step left that can fail; with fewer answers than selectors, the reads
 * simply had not finished.
 */
function describeTraffic({ traffic, selectors, atTimeout }: WireEvidence): string {
  const { answered, pending } = traffic;
  const sent = answered + pending + traffic.failed;
  const when = atTimeout ? 'when the startup timeout fired' : 'when the load failed';
  const facts = `${when}, the store had answered ${answered} of the ${plural(sent, 'request')} this attempt sent, ${pending} ${pending === 1 ? 'was' : 'were'} still in flight and none had failed, for ${plural(selectors, 'selector')}`;

  const candidates: string[] = [];
  if (pending > 0) {
    candidates.push('the network path to the store (a private endpoint, a firewall rule)');
    candidates.push('the store not answering');
  }
  if (answered >= selectors) {
    candidates.push(
      "a Key Vault reference the provider could not parse or resolve (it re-reads the store while it retries one, and names it only in its console warnings)"
    );
  } else if (pending === 0) {
    candidates.push('reads that had not finished when the load gave up');
  }
  return `(${facts}. Not ruled out: ${candidates.join('; ')})`;
}

/**
 * Walk an error's `errors` array and `cause` chain down to the leaves and report what is there.
 *
 * Works for the failures the provider preserves — a non-failoverable REST error such as a 404 or a
 * 400, and an input error. Not for a Key Vault reference: provider 2.6.0 retries that until the
 * startup timeout, so it arrives as the manufactured timeout chain (see the 23 September 2026
 * correction in CLAUDE.md). `opaque` says the provider preserved nothing: every leaf is one of the
 * sentences it manufactures, and the real reason has to come from somewhere else.
 */
function unwrap(error: unknown): { detail: string; statusCode: number | undefined; opaque: boolean } {
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

  return { detail: messages.join('; ') || 'no underlying error reported', statusCode, opaque };
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'a JSON array';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'a JSON object';
  return `a ${typeof value}`;
}

/**
 * `setTimeout`, in steps it honours. Node turns a delay past 2^31-1 ms — about 24.8 days — into
 * 1 ms, so one call with a huge floor's wait would return at once and spin the caller.
 */
async function sleep(ms: number): Promise<void> {
  let remaining = ms;
  do {
    const step = Math.min(Math.max(remaining, 0), MAX_TIMER_MS);
    await new Promise(resolve => setTimeout(resolve, step));
    remaining -= step;
  } while (remaining > 0);
}
