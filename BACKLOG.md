# Backlog

Changes found while converting the first consumer to `@actvalue/azure-app-config@0.1.0`. The consumer is an Azure Functions app: eight Service Bus triggers and a timer, deployed with a staging slot, on a Free-tier store. None of these blocked the conversion. The consumer works around each one locally, and the notes say how, so the workaround can be deleted when the fix ships.

All of them should land in 0.x, before `1.0.0`. The second consumer, a container web app, should run against the result. Items that change behaviour or the public API are marked **breaking (0.x)**. Every item applies to the Python half too (see the parity rule in CLAUDE.md).

Line references are to `Typescript/src/index.ts` at `93f2724`.

## 1. `localOverridesWin` should default on "is this deployed", not on `NODE_ENV`

**Shipped in 0.2.0.** The default is `!process.env.WEBSITE_INSTANCE_ID`, read on every attempt, and `NODE_ENV` plays no part. Other hosts must pass `localOverridesWin: false`, and the README says so.

**Breaking (0.x). Priority: high.**

- **Now:** `options.localOverridesWin ?? process.env.NODE_ENV === 'development'` (line 255).
- **Problem:** in a Functions app, `NODE_ENV` is an ordinary per-slot app setting that often means something else. In the first consumer it selects queue names: `production` on the production slot, `test` on staging and under the test runner. A slot that carries `development` lets leftover app settings beat the store without any warning, so a staging run proves nothing.
- **Policy:** `localOverridesWin` is an escape hatch for local development. It should be false in every deployed environment and true locally.
- **Proposal:** default to "not deployed", detected from a platform signal. On App Service and Functions that is `WEBSITE_INSTANCE_ID`: the platform injects it on every instance, and neither Core Tools `func start`, a plain `node` run nor a test runner sets it. Container Apps and other hosts need their own signal. Choose them with the second consumer, and keep the option as an explicit override.
- **Consumer workaround:** `localOverridesWin: !process.env.WEBSITE_INSTANCE_ID`, read on each call.

## 2. A re-throw from inside the retry floor should be distinguishable, and the default floor exported

**Shipped in 0.2.0.** Inside the floor, `hydrate()` rejects with `ConfigFloorError` (`retryAfterMs`, `cause: lastError`). It extends neither `ConfigLoadError` nor `ConfigInputError`, never moves `failedAt`, and `hydrateWithBackoff` sleeps through it without reporting it. `retryAfterMs` carries a 50 ms margin so waiting exactly that long is safe. `DEFAULT_RETRY_FLOOR_MS` is exported.

**Breaking (0.x). Priority: high.**

- **Now:** inside `retryFloorMs`, `hydrate()` rejects with `state.lastError`, the same object each time (line 136). The default `DEFAULT_RETRY_FLOOR_MS` is not exported (line 79).
- **Problem, for message-triggered consumers:**
  - A handler that rethrows abandons the message, and Service Bus redelivers it at once.
  - Inside the floor every redelivery fails within milliseconds, so `maxDeliveryCount` (typically 10) is used up in seconds, and every message a cold worker receives during a store failure is dead-lettered.
  - A caller can't tell a fresh failure from a re-throw, and logs and telemetry count each re-throw as a new exception.
- **Proposal:**
  - Reject from inside the floor with a distinct error, for example `ConfigFloorError`, that carries `retryAfterMs` and `cause: lastError`.
  - Export the default floor so callers can line up with it.
- **Consumer workaround:** the consumer pins `retryFloorMs: 30_000` itself. On failure it waits `floor + 1 s`, tries once more, then rethrows.

## 3. A `ConfigInputError` that reached the store should arm the floor

**Shipped in 0.2.0.** Every failure that reached the store arms the floor. The diagnostics policy counts answered requests, and `ConfigInputError.reachedStore` tells the store-rejected case apart. This is defensive: provider 2.6.0 turns the example below into a startup timeout (already floored in 0.1.0), not an input error. Its misattributed `detail` is fixed too.

**Priority: medium.**

- **Now:** a rejection that is a `ConfigInputError` never sets `failedAt` (lines 144–146). The comment at line 122 says "bad input never reaches the store". That is true for errors thrown by `validate()`, but not for the ones built at line ~320: those are store responses classed as input errors because an `ArgumentError`, `TypeError` or `RangeError` sits in the error chain.
- **Example:** a Key Vault reference whose URI can't be parsed becomes `KeyVaultReferenceError`, with the `TypeError` from `new URL` as its `cause`. It is a store-data defect, fixed in the store, and fixing it restarts nothing.
- **Problem:** every call makes the request again. For message-triggered consumers that means one store attempt, about one request per key, on every message, against a quota of 1,000 requests a day.
- **Proposal:** arm the floor for any failure that made a request. Keep `ConfigInputError` for callers that shouldn't wait, but tell "rejected before any request" apart from "rejected by the store", for example with a property, or with a subclass for the store case.
- **Consumer workaround:** the consumer's health path remembers the input error and clears it on the next success from any path. Handlers are still exposed.

## 4. A read-only status

**Shipped in 0.2.0.** `hydrationStatus(keys, label?)` never makes a request, and tests assert that in every state. `HydrationResult` carries `loadedAt`.

**Priority: medium.**

- **Problem:** a health endpoint can't report config health without calling `hydrate()`, and that may start a store attempt.
  - On a Free store, pings (about one a minute per instance) during a failure that persists use up the quota in about an hour.
  - No finite floor fixes that: 3 instances × about 5 requests × one attempt every 10 minutes is still about 2,000 requests a day.
- **Proposal:** `hydrationStatus(keys, label?)` returns `{ state: 'loaded' | 'failing' | 'pending' | 'none', loadedAt?, failedAt?, lastError?, nextAttemptAt? }` and never makes a request. `loadedAt` covers a gap the consumer also had to fill: `HydrationResult` carries no timestamp.
- **Consumer workaround:** `hydrate({ ...options, retryFloorMs: Number.MAX_SAFE_INTEGER })`, which works only because the floor isn't validated and isn't part of the memo fingerprint. Plus a module-level `loadedAt`.

## 5. A missing key leaves the environment half-written

**Shipped in 0.2.0.** Every entry is checked before anything is written (all or nothing), and `hydrateWithBackoff` still retries the missing-key case.

**Priority: medium.**

- **Now:** `attemptHydration` writes each usable value into `process.env` in the loop (line 283). Only after the loop does it throw `Missing key-values…` for the ones that are absent, empty or not strings (lines 286–291).
- **Problem:** the call rejects, but part of the environment has already changed. A caller that treats the rejection as "nothing happened" is wrong. A process that goes on (a health path, a partial feature) runs on a mix of store values and old values.
- **Proposal:** check every entry first, and write only when all of them are usable (all-or-nothing). `hydrateWithBackoff` retrying this case is correct, because fixing the store heals it. So only the write order needs to change.

## 6. The logger belongs to whichever caller wins the memo

**Shipped in 0.2.0.** Documented as per attempt, in the option's JSDoc and the README. There is no `configureHydration`.

**Priority: low.**

- **Now:** `attemptHydration` logs through `options.logger` of the call that started the attempt (line 253). Concurrent callers joining the memoised promise, and every later caller, get no log.
- **Problem:** a per-invocation logger, such as a Functions `InvocationContext`, can't be passed usefully. The success line lands in whichever invocation happened to be first.
- **Proposal:** document that the logger is per attempt, not per call. Or accept a process-level logger once, for example `configureHydration({ logger })`, and leave `options.logger` out of the memoised path.

## 7. Docs

**Shipped in 0.2.0.** The tarball wording is gone and CLAUDE.md's Status is updated. The `appStart` guidance is corrected. The README's Functions section now covers floor handling, `hydrateWithBackoff` outside invocations, and a `hydrationStatus` health endpoint.

**Priority: low (with the first release that ships any of the above).**

- **Out of date:**
  - `README.md` lines 14–17 and 232–236 and `Typescript/README.md` line 6 still say "unpublished, consume from an `npm pack` tarball". `0.1.0` is on npm.
  - `CLAUDE.md` **Status**: the first-consumer item is done, and it was consumed from the registry, not a tarball.
- **Wrong for Azure Functions:** the README advises checking that an `app.hook.appStart()` hook "completes before module-scope code runs". That can never be true on the v4 Node worker:
  - `startApp()` loads every entry-point file first, which runs all module-scope code, and only then runs the `appStart` hooks.
  - It awaits those hooks before it answers `WorkerInitRequest`.

  State it plainly: hooks run after all imports and block worker init, so never throw from one and never await long work in one. Lazy initialisation is the guarantee; a hook is only an early start.
- **Incomplete:** the README's "Azure Functions" section covers trigger connections, hydrating at the top of each handler, and lazy initialisation. It is missing:
  - what a handler should do when `hydrate()` rejects inside the floor (see item 2), since a bare rethrow dead-letters messages;
  - that `hydrateWithBackoff` doesn't belong inside an invocation;
  - how a health endpoint can report config status without spending quota (see item 4).

## Found by the second consumer, on `0.2.0`

The second consumer, a container web app on App Service, converted to `0.2.0`, and so did the first consumer, with its workarounds deleted. Neither needed a library change. These items are for `0.2.x` or `1.0.0`.

### 8. The quota figures in the docs are wrong

**Shipped in 0.2.1.** The docs now say the cap bounds attempts, not requests: about 140 requests a day under a persistent 403, about 144 × keys under a failure after a full read, and up to 2,880 attempts a day per process from the floor alone for `hydrate()` callers. The README says what the provider's `Retrying in 5000 ms` warnings are.

**Priority: low.**

- **Now:** `README.md` (about line 101) and `CLAUDE.md` (about line 135) say that at the 600 s cap a persistent failure costs "a few dozen requests a day".
- **Measured on provider 2.6.0, against a local fake store:**
  - A refused read (403) costs **1 request per attempt**. After the 403 the provider puts its only client into a 30 s backoff, so its later passes inside the same attempt send nothing.
  - An unreachable store costs **0**.
  - A success costs one request per key.
  - With the default backoff, attempts start at about 0, 45, 90, 135, 190, 285, 460 and 795 s, then every ~615 s. That is about **140 attempts a day**, so about 140 requests a day under a persistent 403, or 14% of the Free tier. The 600 s cap is still right; only the figure is wrong.
- **Also worth a README sentence:** the provider logs its own `Failed to load … Retrying in 5000 ms` warning three times per attempt. That is its internal loop inside the startup timeout, not the retry schedule.

### 9. The precedence mode is not logged

**Shipped in 0.2.1.** The success line ends with which side wins and why, kept or not, for example `…: A, B (store wins: WEBSITE_INSTANCE_ID present)` or `(local wins: localOverridesWin option true)`. The `0.2.0` prefix is unchanged.

**Priority: medium.**

- **Now:** the success line names the variables taken from the store. A `Kept from the local environment` line appears only when something was kept.
- **Problem:** item 1 made precedence depend on a platform signal. On a host where that signal is missing, nothing is logged until a variable is set locally, so the first sign is a stale value winning. A consumer that has removed its app settings can never confirm the signal from the logs.
- **Proposal:** put the mode in the success line, for example `… label prod (store wins: deployed)` / `(local wins: no platform signal)`, whether or not anything was kept.
- **Consumer workaround:** the container consumer logs its own precedence line at startup, which repeats the `!WEBSITE_INSTANCE_ID` rule.

### 10. `hydrateWithBackoff` gives up on a store-side input error

**Decided in 0.2.1: not done.** `hydrateWithBackoff` still rethrows every `ConfigInputError`, for two reasons. First, `reachedStore` is `answered > 0` for a response of any status, and the input classification covers a `TypeError` or `RangeError` anywhere in the chain, so it does not prove a store-side defect, and a retry could loop for ever on a defect no store fix heals. Second, it would break the `0.2.0` contract: `ConfigInputError` means "don't wait" wherever it is caught, and `onError` never receives one, so a consumer whose `onError` treats it as fatal would break. Unreachable on provider 2.6.0; revisit if a provider version can produce it.

**Priority: low (defensive on provider 2.6.0).**

- **Now:** `hydrateWithBackoff` rethrows every `ConfigInputError`, including one with `reachedStore: true`.
- **Problem:** a store-side input error is fixed in the store. A long-lived process that stopped retrying needs a restart to pick up the fix, while one that kept retrying would heal itself, and the floor already limits what retrying costs.
- **Proposal:** keep retrying when `reachedStore` is true, or document why not.
- **Consumer workaround:** none needed on 2.6.0, where this error cannot occur.

### 11. Functions: the success line is at Information level, outside an invocation

**Shipped in 0.2.1.** The README's Functions section recommends a logger whose `log` writes at warn level, with an example.

**Priority: medium (docs).**

- **Problem:** a typical `host.json` sets `logLevel.default` to `Warning` and raises only `Function` to `Information`. The success line from an attempt that an `appStart` hook started is a `console.log` outside any invocation, so it is filtered out. On a slot where only a health endpoint runs, that line is the only evidence of a load.
- **Proposal:** a README note in the Functions section: pass a `logger` whose `log` writes at warn level, or raise the relevant category in `host.json`.
- **Consumer workaround:** the first consumer passes a logger that maps `log` to `console.warn`.

## Found by the third consumer, on `0.2.1`

The third consumer is a Functions app with HTTP triggers only. It converted to `0.2.1` with no
library change. It answers a failed load with an immediate 503 and never waits for the floor.

### 12. `hydrate()` does not report a failed attempt, so each Functions consumer writes its own

**Shipped in 0.3.0.** A failed attempt logs `Configuration load failed: <message>` once, through the `error` method (else `log`) of the logger of the call that started it. Joiners, memo hits and `ConfigFloorError` rejections log nothing. A pre-request rejection is logged once per distinct message until `resetHydration()`. A throwing logger changes nothing, and `hydrateWithBackoff` does not double-log: its `onError` stays the only report.

**Priority: low. Candidate for `1.0.0`.**

- **Now:** `hydrate()` logs its success line through the caller's `logger`, but it logs no failure.
  Only `hydrateWithBackoff`'s default `onError` does. Every caller that is not
  `hydrateWithBackoff` has to log the failure itself.
- **Problem:** requests that join one in-flight attempt all receive the same rejection. A caller that
  logs in its `catch` therefore writes one line per waiting request unless it deduplicates. A
  caller must also leave out `ConfigFloorError`, or it writes one line per call inside the floor.
  The two Functions consumers now do this differently:
  - the first logs at warn from its wait-and-retry helper;
  - the third deduplicates on the error object's identity and logs at error.
  
  The prefixes and levels drift between them.
- **Proposal:** log a failed attempt once, through the `logger.error` of the call that started it,
  as the success line already goes through that call's `logger.log`. Never log a
  `ConfigFloorError`. The consumers can then drop their own lines. The line should keep the
  message's current guarantee: it names the endpoint, the label, the keys and the cause, never a
  value.
- **Consumer workaround:** the third consumer keeps a module-level `lastLogged` and writes one
  `console.error` per distinct rejection. Delete it when this ships.
- **Fourth consumer (below):** it carries the same code, about 60 lines, copied unchanged. That
  makes two copies to delete.

## Found by the fourth consumer, on `0.2.1`

The fourth consumer is a Functions app with HTTP triggers only. It has no single entry file: its
`main` is a glob over several entry modules. It converted to `0.2.1` with no library change and uses
the third consumer's fail-fast shape.

### 13. A fresh failure's `Retry-After` needs a constant the package does not export

**Shipped in 0.3.0.** `retryAfterMs(error)` returns a `ConfigFloorError`'s own wait, `undefined` for any `ConfigInputError`, and otherwise the time until the armed floor opens, margin included, or `undefined` if it is open. It makes no request. `FLOOR_MARGIN_MS` stays unexported.

**Priority: low. Goes with item 12.**

- **Now:** `ConfigFloorError.retryAfterMs` carries the time until the floor opens plus a 50 ms
  margin. A fresh failure carries no such figure, so a fail-fast caller computes it from
  `hydrationStatus(keys).nextAttemptAt` and adds the margin again. `FLOOR_MARGIN_MS` is not
  exported, so the caller hardcodes 50.
- **Proposal:** give a fresh floor-arming failure the same `retryAfterMs`, or export the margin. If
  item 12's logging moves into the package, a small helper returning "retry after" for any
  rejection would remove the rest of the consumers' copy.
- **Consumer workaround:** both fail-fast consumers keep a local `FLOOR_MARGIN_MS = 50`.

### 14. Document that callers joining an attempt receive the same rejection object

**Shipped in 0.3.0.** The README states it and a test pins it. Item 12 makes the consumers' dedupe on it unnecessary.

**Priority: low. Docs only.**

- **Now:** concurrent `hydrate()` calls for one key map and label share one in-flight promise, so
  every joiner receives the identical error object. Both fail-fast consumers deduplicate their
  failure line on that identity, but the README doesn't promise it.
- **Proposal:** state it in the README and pin it with a test, or make it unnecessary through
  item 12.

### 15. README: where the `appStart` hook goes when there is no single entry file

**Shipped in 0.3.0.** The Functions section shows a dedicated entry module that registers only the hook, and a config module with no side effects that every handler imports.

**Priority: low. Docs only.**

- **Now:** the README's hook example assumes one entry file. Under the v4 Node model, `main` can be
  a glob, and then every matched module is an entry point. Registering the hook in a shared module
  imported by several handlers works only because of module caching. A dedicated entry module
  that registers only the hook is clearer and easy to test.
- **Proposal:** add that case to the Functions section: one dedicated entry module that registers
  the hook and nothing else, and a config module with no side effects.

### 16. README: how a consumer tests against the real package with the provider mocked

**Shipped in 0.3.0.** A "Testing a consumer" section covers `server.deps.inline`, why it is needed, mocking `load()`, and `resetHydration()` between tests, which re-importing no longer replaces.

**Priority: low. Docs only.**

- **Now:** a consumer that wants its tests to run the real package, with only the provider's
  `load()` replaced, must make its test runner process the package itself. For vitest that means
  `server.deps.inline: ['@actvalue/azure-app-config']`; otherwise `vi.mock` of the provider
  doesn't reach the package's own import of it. Three consumers found this out independently.
- **Proposal:** add a short "Testing a consumer" section to the README.

### 17. With local precedence, a fully local environment still needs the store

**Decided in 0.3.0: kept, and documented.** The request also checks that the store exists and that the identity holds its grants. A developer needs `az login`, or the connection-string path. README (Precedence) and CLAUDE.md say so.

**Priority: low. Decide for `1.0.0`.**

- **Now:** `attemptHydration` loads the store first and applies precedence afterwards. A developer
  who has set every mapped variable locally still needs the endpoint, a credential and a
  reachable store, and gets a load failure when any of these is missing.
- **Options:**
  - skip the request when local precedence is on and every mapped variable is already set
    locally, and log that no request was made;
  - or keep the current behaviour and document it, since the request also checks that the store
    and the grants are in place.
- **Consumer workaround:** none; developers run `az login`.

### 18. A gate helper for HTTP handlers

**Shipped in 0.3.0.** `gated(options, handler)` answers `ConfigUnavailableResponse`, a structural type with no dependency on `@azure/functions`: 503, `Service Unavailable`, and `Retry-After` in whole seconds when `retryAfterMs` gives a wait. It never rejects because of configuration and logs nothing itself. A compile-time test proves it fits `app.http()`.

**Priority: low. Idea for `0.3.0`, after item 12.**

- **Now:** each fail-fast consumer pastes the same gate at the top of every handler that reads a
  hydrated value: await the check, then return the 503 if there is one. A new handler that forgets
  it reads undefined values.
- **Proposal:** once item 12 is in the package, a wrapper such as `gated(handler, options)` that
  returns the 503 response with `Retry-After`. Gating then becomes part of registering the handler.
  It needs care, because the package would take a dependency on the Functions HTTP types. A
  structural type, or a separate entry point, avoids that.

### 19. On a capped store, the quota meter is not the request count, and fail fast turns exhaustion into an outage

**Shipped in 0.3.0 (docs only).** The README, the JSDoc and CLAUDE.md now reason in `RequestQuotaUsage` and in loads per worker start. They give the observed Free-tier ceiling of about 250 to 400 requests a day, the reset window and the 429 message, and they warn that fail fast turns exhaustion into an outage at the next worker start. They recommend a paid tier for more than one consumer with churning workers. No default moved.

**Priority: medium for the docs. Observed on the Free tier, same day as the fourth consumer's deploy.**

- **What happened:** the store's quota meter (`RequestQuotaUsage`) reached 100% while the request
  metric (`HttpIncomingRequestCount`) showed about 400 requests that day. The meter had charged
  roughly 2 to 4 units per metered request all day. A fail-fast consumer then started a new
  worker, could not load, and answered 503 to every request for 35 minutes, until the store moved
  to a paid tier. Consumers that had already loaded kept serving from their cached configuration.
- **What drove it:** one consumer's host started a new worker instance every few minutes, and each
  one loads the store again. On a capped tier, the load count follows worker churn, not traffic.
- **Where the docs are wrong:** the README and item 8's quota figures reason in requests against
  a cap of 1,000 a day. Measured, the Free-tier ceiling was nearer 250 to 400 requests a day. The
  meter reset daily between 00:00 and 01:00 UTC. The 429 message is `Resource utilization has
  surpassed the assigned quota`.
- **Proposal:**
  - Correct the quota section. Tell readers to watch `RequestQuotaUsage` rather than request
    counts, and to count one load per worker start, not per deploy.
  - State plainly that on a capped tier, a fail-fast consumer turns quota exhaustion into a hard
    outage at its next worker start.
  - Recommend a paid tier for more than one consumer with churning workers.
- **Not a code change:** the floor and the memo behaved as designed. The per-process floor doesn't
  bound the load count across worker starts, and nothing in-process can.

## Found by the third consumer, on `0.3.0`

The third consumer moved from `0.2.1` to `0.3.0`. Its gate became `gated(CONFIG, handler)` with no
change in behaviour, and no library change was needed. These items are for `1.0.0`.

### 20. README: mocking the exported `hydrate` does not reach `gated()`

**Priority: low. Docs only.**

- **Now:** `gated()` calls the package's internal `hydrate`, so a consumer test that replaces the
  exported `hydrate` with a mock does not change what the gate does. The consumer's old tests used
  that approach and had to be rewritten to mock the provider's `load()`.
- **Proposal:** add one sentence to "Testing a consumer": mock the provider's `load()`, not
  `hydrate`, because `gated()` does not go through the export.

### 21. `retryAfterMs` for a floor rejection whose cause is an input error

**Priority: low. Decide for `1.0.0`. Unreachable from store data on provider 2.6.0.**

- **Now:** a `ConfigInputError` with `reachedStore: true` gives `retryAfterMs` → `undefined`, so
  `gated()` sends no `Retry-After`. Every call inside the floor it armed is a `ConfigFloorError`
  with that error as `cause`, and gets a wait of about 31 s, although waiting alone will not fix
  it. The behaviour is the same as in `0.2.1`, and a consumer test now pins it.
- **Options:**
  - return `undefined` when a floor error's `cause` is a `ConfigInputError`;
  - or keep the wait and document why: a fix in the store heals the next attempt, and the floor
    is the right pace for it.

## Found writing the Python half, for the `1.0.0` API review

The Python half was written against the TypeScript `0.3.0` spec on provider
`azure-appconfiguration-provider` 2.5.0, whose behaviour differs from the JS provider's. Its
CHANGELOG entry lists every deliberate difference. These items need a decision across both halves
before `1.0.0` freezes them.

### 22. TypeScript: a logger that throws on the success line breaks all-or-nothing

**Priority: medium. Decide for `1.0.0`.**

- **Now:** TypeScript guards the failure line against a throwing logger but not the success line.
  A `logger.log` that throws after the environment was written makes `hydrate()` reject, although
  the environment has changed. The Python half guards both.
- **Proposal:** guard the success line the same way in TypeScript; a patch, no API change.

### 23. Empty keys and unusable variable names

**Priority: low. Decide for `1.0.0`.**

- **Now:** the Python half refuses, before any request, an empty store key, variable names that
  are empty or contain `=` or NUL, and a value containing NUL. TypeScript does not. The SDK sends
  an empty key as `key=`, and what the store does with that is unverified.
- **Options:** add the same checks to TypeScript, or drop them from Python. Either way the halves
  should agree.

### 24. SDK retries: TypeScript retries inside an attempt, Python does not

**Priority: medium. Decide for `1.0.0`.**

- **Now:** Python sets `retry_total=0` with per-request timeouts at twice `timeout_ms`, on store and
  Key Vault clients, because azure-core sleeps a `Retry-After` uncapped and an abandoned load thread
  would otherwise outlive the bound. The cost: a single transient 5xx or 429 fails the attempt
  (about 10 s at the defaults) and arms the floor, about 40 s without configuration. TypeScript's
  SDK retries usually absorb such a blip, at up to three requests per failure.
- **Options:** keep the difference and document it (current); or find a way to cap `Retry-After`
  in Python and allow one retry; or align TypeScript to no retries.

### 25. Shape differences to confirm or align

**Priority: low. Decide for `1.0.0`.**

- The error cause is `__cause__` in Python and `cause` in TypeScript.
- A missing key is a `LookupError` in Python and a plain `Error` in TypeScript.
- Python keeps one default credential per process, dropped (not closed) by `reset_hydration()`;
  TypeScript builds one per attempt.
- Python's `timeout_ms` is a hard bound on the call; TypeScript returns at the later of the timeout
  and the provider's five-second pad.
- A re-entrant `hydrate()` on the thread constructing the default credential raises an unlogged
  `ConfigLoadError` in Python; TypeScript has no counterpart.
- `gated()` exists only in TypeScript until a Python HTTP consumer appears (decided).

### 26. A message-trigger helper: the wait-once recipe is copied into every consumer

**Priority: low. Idea for `1.0.0` or later. Found by the first Python consumer.**

- **Now:** every consumer with message triggers writes the README recipe by hand: re-raise a
  `ConfigInputError`, otherwise wait `retry_after_ms(error)`, try once more, then let it fail. The
  first Python consumer needs it twice, sync and async, and the TypeScript message-trigger
  consumers have their own copies.
- **Proposal:** a package helper, the message-trigger counterpart of `gated()`, e.g.
  `hydrate_for_message(options)` / `hydrateForMessage(options)` (plus an async form in Python).
  The recipe would then be fixed in one place.
- **Consumer workaround:** the hand-written recipe, in one config module per app.

### 27. Python: `hydrate_async` logs from a worker thread, and the Functions host drops the line

**Priority: medium. Fix in a Python patch. Found by the first Python consumer, in production.**

- **What happened:** an async Service Bus handler on a fresh worker process awaited `hydrate_async`.
  The load succeeded and the invocation completed, but the success line never reached the host's
  logs or Application Insights, at any category, although the consumer logs it at WARNING. The same
  app's sync handlers and timers, calling `hydrate()` on the invocation's own thread, log it every
  time under `Function.<name>.User`.
- **Why:** `hydrate_async` is `asyncio.to_thread(hydrate, options)`, so the success or failure line
  is written on a pool thread. The Python Functions worker evidently does not tie a record from that
  thread to the invocation, and drops it. The failure line has the same exposure, and it matters
  more: an async fail-fast consumer that does not log its own exception would be silent.
- **Proposal:** run the attempt on the pool thread but log on the caller's side. `hydrate_async`
  collects the attempt's lines and writes them through the logger after the `await`, on the event
  loop. That is the invocation's own context, as it is for the sync path. The rules stay the same:
  once per attempt, by the starter, never for joiners.
- **Consumer workaround:** none needed for correctness. The consumer's handler logs its own
  exception on failure, and the store's request count shows the load. On async paths, don't rely
  on the success line.

## Already open

- ESM/CJS dual state (CLAUDE.md, **Status**, deferred to `1.0.0`). The first consumer is CJS-only and adds nothing new.

  **Shipped in 0.3.0.** The state lives on `globalThis` under a symbol keyed on the exact package version, so the two builds of one version share one memo and one floor, and `resetHydration()` clears both. Two versions in one graph keep separate state. The error classes carry brands that `instanceof` checks across copies. Re-importing the package in a test no longer gives fresh state.
- Starvation across key maps (CLAUDE.md, decisions, deferred to `1.0.0`). The retry floor is global, so a key map that fails on every attempt keeps the floor shut for every other key map in the process, and can starve a `hydrateWithBackoff` loop for another map. One key map per process is the supported shape until this is decided.

  **Decided in 0.3.0: the floor stays global.** It bounds the store's quota, which every key map shares. `1.0.0` freezes "one key map per process is the supported shape", so changing it later is a major.
