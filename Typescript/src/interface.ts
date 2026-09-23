import type { TokenCredential } from '@azure/identity';

/** `{ [storeKey]: environmentVariableName }`. A map, never a prefix — see {@link HydrateOptions.keys}. */
export type KeyMap = Record<string, string>;

export interface Logger {
  log(message: string): void;
  error?(message: string): void;
}

export interface HydrateOptions {
  /**
   * The keys to read and the variables to write them into.
   *
   * Explicit, and never a prefix or a wildcard, for two reasons. The store key and the variable
   * name are generally not the same string. And every Key Vault reference the provider loads, it
   * also resolves — so a selector like `shared:*` attempts to resolve secrets the caller holds no
   * grant on, and turns another application's credential into this application's startup failure.
   */
  keys: KeyMap;
  /**
   * The one label to read. Defaults to `APP_CONFIG_LABEL`; throws if neither is set.
   *
   * Its own variable, never derived from `NODE_ENV`: images bake `ENV NODE_ENV=production`, so a
   * staging container would otherwise carry the production label and read production databases,
   * and in a Functions app `NODE_ENV` is an ordinary per-slot setting that often means something
   * else entirely.
   */
  label?: string;
  /** Store endpoint. Defaults to `APP_CONFIG_ENDPOINT`. */
  endpoint?: string;
  /**
   * Access-key fallback for a run with no identity to borrow. Defaults to
   * `APP_CONFIG_CONNECTION_STRING`. Takes precedence over `endpoint` when set.
   */
  connectionString?: string;
  /** Credential for the store and for resolving Key Vault references. Defaults to `DefaultAzureCredential`. */
  credential?: TokenCredential;
  /**
   * Provider startup timeout. Defaults to 15 s, not the provider's ~100 s: App Service gives a
   * container less than 100 s to answer its first ping, so the provider's default means the
   * platform kills you before you can report the failure. Must be a finite number above 0 and at
   * most 2^31-1 (the longest `setTimeout` honours), or `hydrate` rejects with `ConfigInputError`.
   */
  timeoutMs?: number;
  /**
   * Minimum gap between attempts after a failure. Defaults to `DEFAULT_RETRY_FLOOR_MS` (30 s).
   * Inside the floor, `hydrate` rejects with a `ConfigFloorError` without touching the store. Must
   * be a finite number, 0 or more — NaN would switch the floor off — or `hydrate` rejects with
   * `ConfigInputError`. Large values are allowed.
   */
  retryFloorMs?: number;
  /**
   * Whether a value already in the environment beats the store. See {@link HydrationResult.kept}.
   *
   * A dev-only escape hatch: false in every deployed environment, true on a developer machine.
   * Defaults to "not deployed", read on every attempt from `WEBSITE_INSTANCE_ID`, which App Service
   * and Azure Functions inject on every instance and which `func start`, a plain `node` run and a
   * test runner never set. Any other host — Container Apps, Kubernetes, a VM — sets none of that,
   * so it must pass `false` explicitly, or a leftover setting beats the store without a warning.
   *
   * Never derived from `NODE_ENV`, which a Functions slot may set to anything.
   */
  localOverridesWin?: boolean;
  /**
   * Defaults to `console`.
   *
   * Per attempt, not per call: the attempt logs through the logger of the call that started it.
   * A caller that joins an attempt already in flight, or that is handed a memoised success, logs
   * nothing through its own. So a per-invocation logger — a Functions `InvocationContext` — records
   * the success line only in whichever invocation happened to start the attempt. Pass a
   * process-level logger if every line must land in one place.
   */
  logger?: Logger;
}

export interface HydrationResult {
  /** The label that was read. */
  label: string;
  /** Variables written from the store. */
  applied: string[];
  /** Variables left alone because the local environment won. Always empty unless `localOverridesWin`. */
  kept: string[];
  /** When the environment was written, in milliseconds since the epoch (`Date.now()`). */
  loadedAt: number;
}

/**
 * What {@link hydrationStatus} reports for one key map and label. Timestamps are milliseconds
 * since the epoch, as `Date.now()` returns them.
 *
 * - `loaded` — a success is memoised; `loadedAt` says when. `hydrate()` with the same keys and
 *   label resolves at once and makes no request.
 * - `pending` — an attempt is in flight. `failedAt` and `lastError` describe the previous failed
 *   attempt, if there was one.
 * - `failing` — the last attempt failed; `failedAt` and `lastError` are that attempt's, never a
 *   floor rejection.
 * - `none` — no attempt has been made for this key map and label.
 *
 * `nextAttemptAt` appears only in the `failing` and `none` states, and there exactly while the
 * retry floor is closed, whichever key map armed it: until then a `hydrate()` call rejects with a
 * `ConfigFloorError` rather than reaching the store. It is when the floor opens by the
 * `retryFloorMs` of the attempt that armed it, with no margin. `hydrate()` enforces each caller's
 * own `retryFloorMs`, so a caller passing a different value sees a different window. Never present
 * when `loaded` (the memo answers) or `pending` (the attempt in flight answers).
 */
export interface HydrationStatus {
  state: 'loaded' | 'failing' | 'pending' | 'none';
  loadedAt?: number;
  failedAt?: number;
  lastError?: unknown;
  nextAttemptAt?: number;
}

export interface BackoffOptions {
  /** First delay after a failed attempt. Default 5 s. A finite number above 0. */
  initialMs?: number;
  /**
   * Cap on the delay. Default 600 s.
   *
   * At a 60 s cap one stuck application spends a Free store's entire daily quota in about five
   * hours; at 600 s it is a few dozen requests a day. Nothing is waiting on a faster poll —
   * role-assignment changes take minutes to propagate in both directions, so a restored grant is
   * not a restored application either way. A finite number above 0.
   */
  maxMs?: number;
  /**
   * Called with every failed attempt and the wait before the next one — the backoff delay, or the
   * time until the retry floor opens if that is longer, since the next call cannot reach the
   * store before then. Never called for a `ConfigFloorError`, which is not a failed attempt.
   * Defaults to logging.
   */
  onError?: (error: unknown, nextDelayMs: number) => void;
}

/** One failure seen on the wire, captured by the diagnostics policy. */
export interface FailureObservation {
  /** HTTP status, when the failure was a response rather than a transport error. */
  status?: number;
  /** Node or SDK error code — `ENOTFOUND`, `ECONNREFUSED`, `AbortError`. */
  code?: string;
  message: string;
}

/**
 * Whether a token was ever asked for during an attempt, and whether it ever came back.
 *
 * The signal has to be in-process. The provider produces an identical error chain whether the
 * credential hung or the diagnostics policy vanished, so no string can separate them — but the
 * two differ in whether `getToken` resolved, which is observable here.
 */
export interface CredentialEvidence {
  requested: boolean;
  resolved: boolean;
}

/**
 * All the state the module holds, in one object so that `resetHydration()` clears every part of
 * it — the memoised successes and the retry floor's bookkeeping alike. A floor whose timestamp
 * survived a reset would make the first attempt after it re-throw a discarded error.
 *
 * Internal: not exported from the package.
 */
export interface HydrationState {
  /**
   * One record per key map and label, keyed on the pair.
   *
   * Keyed, rather than a single promise, because one process legitimately holds more than one
   * call site: a Functions worker hosts every function in the app, and a handler that declares
   * its own subset of keys must not be handed another handler's result and told it succeeded.
   */
  calls: Map<string, CallRecord>;
  /**
   * When the retry floor was last armed, and by what.
   *
   * Deliberately *not* per key map. The memo is about correctness and belongs to a call site;
   * the floor is about the store's request quota, which every call site spends from together.
   * Two key maps failing against a dead store must cost one request per floor, not two.
   */
  failedAt?: number;
  lastError?: unknown;
  /** The `retryFloorMs` of the attempt that armed the floor, for `hydrationStatus`. */
  floorMs?: number;
}

/**
 * What one key map and label has done. Internal.
 *
 * `promise` is the memo: the attempt in flight, or the success. A failure removes it and records
 * itself in `failedAt`/`lastError` instead, so a failure is never memoised but is still reported.
 */
export interface CallRecord {
  promise?: Promise<HydrationResult>;
  /** Set once the attempt has succeeded. `promise` then resolves to it. */
  result?: HydrationResult;
  failedAt?: number;
  lastError?: unknown;
}
