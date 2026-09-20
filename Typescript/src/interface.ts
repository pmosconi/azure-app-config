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
   * staging container would otherwise carry the production label and read production databases.
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
   * platform kills you before you can report the failure.
   */
  timeoutMs?: number;
  /**
   * Minimum gap between attempts after a failure. Defaults to 30 s. Inside the floor, `hydrate`
   * re-throws the previous error without touching the store.
   */
  retryFloorMs?: number;
  /** Defaults to `process.env.NODE_ENV === 'development'`. See {@link HydrationResult.kept}. */
  localOverridesWin?: boolean;
  /** Defaults to `console`. */
  logger?: Logger;
}

export interface HydrationResult {
  /** The label that was read. */
  label: string;
  /** Variables written from the store. */
  applied: string[];
  /** Variables left alone because the local environment won. Always empty unless `localOverridesWin`. */
  kept: string[];
}

export interface BackoffOptions {
  /** First delay after a failed attempt. Default 5 s. */
  initialMs?: number;
  /**
   * Cap on the delay. Default 600 s.
   *
   * At a 60 s cap one stuck application spends a Free store's entire daily quota in about five
   * hours; at 600 s it is a few dozen requests a day. Nothing is waiting on a faster poll —
   * role-assignment changes take minutes to propagate in both directions, so a restored grant is
   * not a restored application either way.
   */
  maxMs?: number;
  /** Called with every failure and the delay before the next attempt. Defaults to logging. */
  onError?: (error: unknown, nextDelayMs: number) => void;
}

/**
 * All the state the module holds, in one object so that `resetHydration()` clears every part of
 * it — the memoised success and the retry floor's bookkeeping alike. A floor whose timestamp
 * survived a reset would make the first attempt of the next test re-throw the previous test's
 * error.
 *
 * Internal: not exported from the package.
 */
export interface HydrationState {
  /** The in-flight or successful attempt. Never a rejected promise. */
  inFlight?: Promise<HydrationResult>;
  /** When the last attempt failed, and with what. The retry floor is measured from here. */
  failedAt?: number;
  lastError?: unknown;
}
