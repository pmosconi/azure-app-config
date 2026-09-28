# Changelog

Changes to `@actvalue/azure-app-config`. Until `1.0.0` a minor version may break things; each
release says what, and which consumer workarounds it lets you delete. The Python half, when it is
written, matches every behaviour listed here (see the parity rule in `CLAUDE.md`).

## 0.3.0 - unreleased

What the third and fourth consumers found on `0.2.1` — two Functions apps with HTTP triggers only,
which answer a failed load with an immediate 503 — plus the two items deferred to `1.0.0`, now
settled. `BACKLOG.md` items 12–19 and "Already open" give the reasoning. This is the candidate for
the frozen TypeScript API: `1.0.0` adds the Python half and republishes this one without a
behaviour change. Nothing is removed and no signature changes; three exports are added.

### What a consumer changes

- [ ] **A fail-fast HTTP gate → `gated()`.** Delete the gate at the top of each handler — the
      `ConfigFloorError` branch, the `Retry-After` arithmetic, the `lastLogged` identity dedupe and
      its `Configuration load failed` line — and register `handler: gated(CONFIG, handler)`. The
      response is the same: 503, `Service Unavailable`, `Retry-After` in whole seconds (at least
      1), none for a `ConfigInputError`.
- [ ] **A hardcoded `FLOOR_MARGIN_MS = 50`**, and a `Retry-After` computed from
      `hydrationStatus(keys).nextAttemptAt`. Use `retryAfterMs(error)`.
- [ ] **A message trigger's fresh-failure wait** computed from `nextAttemptAt` plus 50, with a
      `DEFAULT_RETRY_FLOOR_MS + 50` fallback, and its own warn line. Rethrow a
      `ConfigInputError`, otherwise wait `retryAfterMs(error) ?? 0` — it covers the floor
      rejection and the fresh failure alike, and `undefined` there means the floor is already open
      — and delete the line: `hydrate()` logs the failure.
- [ ] **Any failure line a consumer logs itself after `hydrate()` rejects is now a duplicate**
      until it is deleted. `hydrate()` logs `Configuration load failed: <message>` once per
      attempt, the text the fail-fast consumers used, so deleting theirs changes no log.
- [ ] **A logger with no `error` method now receives failure lines through `log`**, and **with
      the default logger (`console`) each failed attempt now prints a `console.error` line.**
      Consumer tests that spy on `console.error` or `logger.log` and assert zero calls, or exact
      counts, on failure paths need updating.
- [ ] **Tests that re-import the package for fresh state** — `vi.resetModules()` before a dynamic
      import, `jest.resetModules()`, `jest.isolateModules(() => require(...))` — no longer get it:
      the state is shared across module instances, so memo and floor leak from test to test.
      Call `resetHydration()` in `beforeEach`. Separate test files stay isolated.
- `hydrateWithBackoff` users change nothing: a custom `onError` still produces the only line per
  failure, and the default still logs its own `Configuration load failed, retrying in …` line.

### Added

- **`retryAfterMs(error): number | undefined`** — how long to wait after any rejection from
  `hydrate()`. A `ConfigFloorError`: its `retryAfterMs`. A `ConfigInputError`, whether or not it
  reached the store: `undefined`, since waiting won't fix it. Anything else: the time until the
  armed retry floor opens, measured with the `retryFloorMs` of the attempt that armed it (as
  `hydrationStatus().nextAttemptAt` is), rounded up, plus the same 50 ms margin — `undefined` if
  the floor is already open, meaning retry now. So `undefined` is "don't retry" for a
  `ConfigInputError` and "retry now" for anything else. Makes no request.
- **`gated(options, handler)`** — wraps an HTTP handler. Each call awaits `hydrate(options)`,
  then calls the handler with the original arguments and returns its result; the handler's own
  errors propagate untouched. On any rejection it returns `{ status: 503, body: 'Service
  Unavailable' }`, with `headers: { 'Retry-After': '<seconds>' }` —
  `Math.max(1, Math.ceil(retryAfterMs(error) / 1000))` — whenever `retryAfterMs` gives a wait. It
  never rejects because of configuration and logs nothing itself.
- **`ConfigUnavailableResponse`**, its return type: `{ status: 503; body: string; headers?:
  Record<string, string> }`. Structural, and assignable to an Azure Functions `HttpResponseInit`,
  so the package depends on `@azure/functions` neither at run time nor in its types.

### Changed

- **`hydrate()` logs a failed attempt, once.** One line, through the `error` method — `log` if the
  logger has none — of the logger of the call that started the attempt:

  ```
  Configuration load failed: <the error's message>
  ```

  The message names the store, the label, the keys or the cause, never a value. Callers that join
  the attempt, memo hits and `ConfigFloorError` rejections log nothing. A call rejected before
  any request — no endpoint, no label, a filter character, a timing option that is not a usable
  number, or an input error the provider raises before its first request — is logged the same way
  the first time its message is seen, and not again until `resetHydration()`. A logger that
  throws, or returns a promise that rejects, changes nothing: the call rejects with the error it
  would have, and nothing goes unhandled — `hydrate(undefined)` still returns a rejected promise.
  `hydrateWithBackoff`'s attempts are reported by its `onError` alone, and the `ConfigInputError`
  it rethrows is not logged.
- **`hydrateWithBackoff`'s default `onError` survives a broken logger.** Its line is unchanged, but
  a logger that throws no longer ends the retry loop with the logger's error, and an async logger
  that rejects no longer leaves an unhandled rejection. A custom `onError` that throws still ends
  the loop, as before: it is the caller's code.
- **The ESM and the CJS build share one state.** It lives on `globalThis` under a symbol that
  carries the exact package version, so a process reaching both builds has one memo and one
  retry floor — before, it had two, spending the quota invariant twice — and `resetHydration()`
  from either clears both. Two different versions in one process keep separate state: each
  version has its own floor. `resetHydration()` also clears the set of pre-request errors already
  logged.
- **`instanceof` works across builds.** `ConfigInputError`, `ConfigLoadError` and
  `ConfigFloorError` carry a brand that `instanceof` checks. The error classes' brands carry no
  version, so `instanceof` matches an instance from either build of any version of the package;
  the state is shared only by the two builds of one exact version. Before, a `hydrateWithBackoff`
  in one build joining an attempt from the other would retry a `ConfigInputError`. `instanceof
  Error` still holds, each class has its own brand (`ConfigFloorError` is still neither of the
  others), and a subclass keeps ordinary `instanceof`.

### Decided

- **Local precedence still reads the store** (item 17). With every mapped variable set locally,
  `hydrate()` still makes its request: it also checks that the store and the grants exist. A
  developer needs `az login`, or the connection-string path. Documented; no change.
- **The retry floor stays global across key maps.** It bounds the store's quota, which every key
  map shares. One key map per process is the supported shape, frozen by `1.0.0`.

### Documentation

- **Quota: the meter is not the request count** (item 19). On a capped tier the store meters
  `RequestQuotaUsage`, and a Free-tier store was observed charging roughly 2 to 4 units per
  request: a ceiling nearer 250 to 400 requests a day than 1,000. It reset daily between 00:00 and
  01:00 UTC, and past it every reader gets HTTP 429, `Resource utilization has surpassed the
  assigned quota`. Watch `RequestQuotaUsage`, not request counts, and count one load per worker
  start, not per deploy: worker churn drives the load count, and nothing in-process can bound it.
  On a capped tier a fail-fast consumer turns quota exhaustion into a hard outage at its next
  worker start. For more than one consumer with churning workers, use a paid tier. The
  per-attempt request costs measured on provider 2.6.0 stand; they are no longer compared with
  1,000. No default moved.
- Concurrent callers joining one in-flight attempt receive the identical rejection object
  (item 14), now stated and pinned by a test.
- Azure Functions: `gated()` for HTTP handlers; `retryAfterMs(error)` in the message-trigger wait;
  a dedicated entry module for the `appStart` hook when `main` is a glob over several entry
  modules, with a side-effect-free config module every handler imports (item 15); the example
  logger's `error` now receives `hydrate()`'s failure line.
- A "Testing a consumer" section (item 16): vitest's `server.deps.inline:
  ['@actvalue/azure-app-config']`, without which `vi.mock` of the provider does not reach the
  package's own import; mocking `load()`; and `resetHydration()` in `beforeEach`.

## 0.2.1 - released 2026-09-23

What the second consumer found on `0.2.0`: a container web app on App Service. `BACKLOG.md`
items 8–11 give the reasoning.

**No code change is required.** A patch release: no API is added, removed or changed. Code that
passes a `logger`, reads `hydrationStatus().nextAttemptAt`, waits on
`ConfigFloorError.retryAfterMs` or catches `ConfigInputError` around `hydrateWithBackoff` works as
it did. The only visible change is text appended to the success line. Its `0.2.0` prefix,
`Configuration loaded from App Configuration, label <label>: <variables>`, is unchanged, so only a
log matcher anchored at the **end** of that line is affected.

### Changed

- **The success line ends with the precedence mode, and why.** It says which side wins, on every
  successful attempt, whether or not anything was kept, after the variable list. It is still one
  line through `logger.log`, once per successful attempt, and names variables, never values. The
  `Kept from the local environment: …` line is unchanged. The four forms:

  ```
  Configuration loaded from App Configuration, label prod: A, B (store wins: WEBSITE_INSTANCE_ID present)
  Configuration loaded from App Configuration, label prod: A, B (local wins: WEBSITE_INSTANCE_ID absent)
  Configuration loaded from App Configuration, label prod: A, B (store wins: localOverridesWin option false)
  Configuration loaded from App Configuration, label prod: A, B (local wins: localOverridesWin option true)
  ```

  The reason states the decision precedence actually made, which is unchanged: an empty
  `WEBSITE_INSTANCE_ID` counts as absent; a non-boolean option goes by truthiness, so the string
  `"false"` gives `(local wins: localOverridesWin option true)`; `null` is treated as not passed
  and the reason names the signal. Before, a host missing the signal showed nothing until a stale
  local value won, and a consumer with no local settings left could never confirm the signal from
  its logs.
- `hydrateWithBackoff` still rethrows every `ConfigInputError`, including one with
  `reachedStore: true`: that flag does not prove a store-side defect, and retrying would break the
  "don't wait" contract (`BACKLOG.md` item 10, decided not done).

### Documentation

- **Corrected quota figures. The backoff cap bounds attempts, not requests.** What an attempt costs
  depends on how it fails, measured on provider 2.6.0: a refused read (403) about one request,
  because the provider backs its client off after the 403; an unreachable store none; a failure
  after a complete read, such as a missing key, one per key, as a success does. Under a persistent
  403 attempts start at about 0, 45, 90, 135, 190, 285, 460 and 795 s, then every ~615 s: about
  140 requests a day, not "a few dozen". Under a persistent failure after a full read, about 144
  attempts a day at the cap, so about 144 × keys requests: past a Free store's 1,000 from 7 keys.
  The 600 s cap and its reasoning stand; no default changed.
- **What the retry floor allows.** For `hydrate()` callers on message triggers the floor is the
  only limit: at most one attempt per floor window per process, up to 2,880 a day per process at
  the 30 s default. A Functions app on a Free store should weigh that against its instance count
  when it chooses `retryFloorMs`.
- The provider's own `Failed to load … Retrying in 5000 ms` warnings, about three per attempt, are
  its internal loop inside the startup timeout, not the retry schedule.
- Azure Functions: a typical `host.json` (`logLevel.default: "Warning"`) filters the
  Information-level success line from an attempt started outside an invocation, by an `appStart`
  hook. The README's Functions examples now share one options object whose logger writes at warn
  level, `{ log: (m) => console.warn(m), error: (m) => console.error(m) }`, passed to every call,
  a retry included.

### Workarounds to delete after upgrading

- [ ] A precedence line the consumer logs itself at startup, repeating the
      `!WEBSITE_INSTANCE_ID` rule. The success line now carries the mode and the reason.

## 0.2.0 - released 2026-09-23

Everything the first consumer found while converting to `0.1.0`: an Azure Functions app with eight
Service Bus triggers and a timer, deployed with a staging slot, on a Free-tier store. See
`BACKLOG.md` for the reasoning behind each item.

### Breaking

- **`localOverridesWin` defaults to "not deployed", not to `NODE_ENV === 'development'`.** The
  default is now `!process.env.WEBSITE_INSTANCE_ID`, read on every attempt. App Service and Azure
  Functions inject that variable on every instance; `func start`, a plain `node` run and a test
  runner never set it. `NODE_ENV` plays no part any more.
  - *On App Service or Azure Functions:* nothing to add. Delete a
    `localOverridesWin: !process.env.WEBSITE_INSTANCE_ID` workaround; it is the default now.
  - *On any other host* — Container Apps, Kubernetes, a VM, a container run anywhere else: **add
    `localOverridesWin: false`.** Nothing there sets `WEBSITE_INSTANCE_ID`, so `0.2.0` treats the
    host as a developer machine. Plainly: a host that is not App Service or Functions, upgrading
    from `0.1.0` with `NODE_ENV=production` — where the store won — **flips to local-wins** unless
    it passes `localOverridesWin: false`, and a stale value already in its environment then beats
    the store without a warning.
  - *On a developer machine:* a value in the environment now wins whatever `NODE_ENV` says. Pass
    `localOverridesWin: false` for a local run that must read the store, as deployed code does.
- **Inside the retry floor, `hydrate()` rejects with a `ConfigFloorError`**, not with the previous
  error object. `retryAfterMs` is how long to wait: the time until the floor opens, rounded up,
  plus a 50 ms margin, so a caller that waits exactly that long reaches the store even when its
  timer fires a little early. The floor itself is enforced exactly. `cause` is the previous error,
  unmodified. It is neither a `ConfigLoadError` nor a `ConfigInputError`.
  - Code that compared the rejection with the previous error, or read `detail`, `statusCode` or
    `observations` off it, reads them from `error.cause` instead.
  - A `catch` on `ConfigLoadError` no longer sees floor rejections, so logs and telemetry stop
    counting each one as a new failure.
  - `hydrateWithBackoff` no longer counts a floor rejection as a failure: it sleeps until the floor
    opens, without calling `onError`, logging "Configuration load failed", or doubling the delay.
    A custom `onError` sees only real failures, and the delay doubles once per real failure.
  - After a real failure, `onError`'s `nextDelayMs` and the default "retrying in" log report when
    the next attempt will really happen: the backoff delay, or the time until the floor opens if
    that is longer. `0.1.0` reported the backoff delay alone.
- **An unescaped comma in a key, or `*` or `,` in the label, is a `ConfigInputError` before any
  request.** App Configuration reads `a,b` as a filter matching both keys, which is the multi-key
  selector invariant 4 forbids; `0.1.0` let it through. Escaped, `\*` and `\,` match the literal
  character and are allowed in a key, and the value is looked up under the unescaped key. The
  label check mirrors the provider's own — any `*` or `,`, escaped or not — which came after a
  five-second pad. `hydrationStatus` applies the same checks.
- **Timing options are validated before any request.** `retryFloorMs` must be finite and 0 or
  more (NaN used to switch the floor off); `timeoutMs` finite, above 0 and at most 2^31-1; the
  backoff's `initialMs` and `maxMs` finite and above 0. Anything else is a `ConfigInputError`.
  Large finite floors, such as `Number.MAX_SAFE_INTEGER`, are still allowed.

### Added

- `ConfigFloorError` (above), and **`DEFAULT_RETRY_FLOOR_MS`** (`30_000`), the default
  `retryFloorMs`, exported so a caller can line up with it.
- **`hydrationStatus(keys, label?)`**, with its return type `HydrationStatus`:
  `{ state: 'loaded' | 'failing' | 'pending' | 'none', loadedAt?, failedAt?, lastError?, nextAttemptAt? }`.
  It never makes a request and never starts an attempt, in any state, so a health endpoint can call
  it on every ping. The label resolves as it does for `hydrate()`. `nextAttemptAt` appears only in
  the `failing` and `none` states, while the floor is closed. It is when the floor opens by the
  `retryFloorMs` of the attempt that armed it; a caller passing a different `retryFloorMs` sees a
  different window in its own `ConfigFloorError`.
- **`HydrationResult.loadedAt`**, in milliseconds since the epoch. Code that builds a
  `HydrationResult` itself, such as a test double, must add it.
- **`ConfigInputError.reachedStore`**: `true` when a response had come back from the store before
  the provider rejected the input, `false` otherwise (below).

### Fixed

- **A `ConfigInputError` raised after the store has answered arms the retry floor** — a defensive
  change. What arms the floor is now whether a response came back from the store, which the
  diagnostics policy counts; before, every `ConfigInputError` was exempt. **On provider 2.6.0
  nothing changes in practice:** no store data we could find reaches the provider's post-read
  input-error path, so every `ConfigInputError` it produces has `reachedStore: false` and leaves
  the floor alone, as in `0.1.0`. The store-data defect the backlog cited — a Key Vault reference
  that can't be parsed or resolved — never was a `ConfigInputError`: 2.6.0 re-reads the store
  until the startup timeout and reports a `ConfigLoadError`, which already armed the floor in
  `0.1.0`. `hydrateWithBackoff` still stops on every `ConfigInputError`.
- **A rejected load writes nothing to `process.env`.** `0.1.0` wrote each usable value and then
  threw for the missing ones, leaving the environment half-written. Every entry is now checked
  first. `hydrateWithBackoff` still retries a missing key, since adding it to the store heals the
  process.
- **A timeout with no failed request reports what the wire showed.** On provider 2.6.0 a broken
  Key Vault reference arrives as a `ConfigLoadError` timeout after repeated store reads that all
  answered 200, and on the endpoint path `detail` used to blame the provider for no longer
  honouring `clientOptions`. The diagnostics policy now counts answered and in-flight requests,
  snapshotted when the startup timeout fires, and `detail` states them against the number of
  selectors and names every cause they leave open — never ruling one out the evidence cannot:
  - a request still in flight keeps the network path (a private endpoint, a firewall rule) and
    the store in play;
  - a complete first read keeps a broken Key Vault reference in play, whether or not a request is
    in flight, since 2.6.0 re-reads the store while it retries one; the reference is named only in
    the provider's console warnings.

### Documentation

- The logger is per attempt, not per call: the call that starts an attempt logs it, and callers
  that join it or hit the memo log nothing. Said in the option's JSDoc and the README.
- Azure Functions: an `appStart` hook runs after every entry-point import and blocks worker
  initialisation, so never throw from one or await long work in one. It is an early start, and lazy
  initialisation is the guarantee. A handler that gets a `ConfigFloorError` waits `retryAfterMs`
  and tries once more rather than rethrowing, which would dead-letter the message.
  `hydrateWithBackoff` does not belong inside an invocation. There is also a health endpoint
  example built on `hydrationStatus`.
- Removed the "unpublished, consume from an `npm pack` tarball" wording.

### Workarounds to delete after upgrading

- [ ] `localOverridesWin: !process.env.WEBSITE_INSTANCE_ID` on App Service or Functions. On any
      other host, replace it with `localOverridesWin: false`.
- [ ] A pinned `retryFloorMs` and a hard-coded "wait the floor plus a second". Wait
      `error.retryAfterMs` on a `ConfigFloorError`, and use `DEFAULT_RETRY_FLOOR_MS` wherever the
      floor's value is needed.
- [ ] A health check that calls `hydrate({ ...options, retryFloorMs: Number.MAX_SAFE_INTEGER })`.
      It still starts an attempt when no floor is armed, and now rejects with `ConfigFloorError`.
      Use `hydrationStatus(keys)`.
- [ ] A module-level `loadedAt` recorded beside `hydrate()`. Use `result.loadedAt` or
      `hydrationStatus(keys).loadedAt`.
- [ ] A health path that remembers a `ConfigInputError` so it doesn't ask the store again. Safe to
      delete, though on provider 2.6.0 it was guarding nothing: the broken Key Vault reference it
      was written for arrives as a `ConfigLoadError` timeout, which the floor already covered in
      `0.1.0`, and a pre-request input error makes no request to repeat. A post-read input error
      from a later provider arms the floor itself, and `hydrationStatus` reports all three.
- [ ] Any clean-up of `process.env` after a missing-key rejection. Nothing was written.

## 0.1.0

First release: `hydrate`, `hydrateWithBackoff`, `ConfigLoadError`, `ConfigInputError`,
`resetHydration`, and the four invariants in `CLAUDE.md`.
