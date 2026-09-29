# CLAUDE.md

Guidance for Claude Code in this repo. Keep it terse.

## What this is

A paired npm + PyPI package that hydrates the environment from **Azure App Configuration**:
`@actvalue/azure-app-config` (TypeScript) and `actvalue.azure-app-config` (Python), one
repository, on the model of `@actvalue/mongo-client`. Structure mirrors it — `Typescript/`,
`Python/`, a `Makefile` at the root driving both.

**This repository is public.** No secrets, no connection strings, no tenant or subscription IDs,
no customer or internal project names, in code, tests, fixtures, comments or docs. Examples use
neutral key names (`shared:mongoUrl`, `myapp:httpPort`). Anything specific to the estate this was
extracted from belongs in that estate's private repository, not here.

Order of work: TypeScript first, shaped against real consumers (three Functions apps and a
container), frozen in `0.3.0`; then `1.0.0`, which adds the Python half and republishes the
TypeScript half without a behaviour change. See **Status** below.

## Commands

```bash
make install          # both languages
make test             # both
make test-ts          # vitest, unit
make test-integration-ts  # real provider, no Azure — see below
make lint-ts
make build-ts         # tsup → dist/, esm + cjs + dts
make publish-ts       # npm publish (prepublishOnly builds)
make test-py          # pytest -m unit
make test-integration-py  # real provider: .invalid endpoint + loopback fake store, no Azure
make lint-py          # ruff check + format --check
make typecheck-py     # mypy strict
make build-py         # uv build → Python/dist/
```

## The four invariants

These are the whole reason the package exists. They were each learned from a production failure
and none of them is visible from reading `@azure/app-configuration-provider`. Do not relax one
without a real reason recorded in the commit message.

1. **One attempt per call.** `hydrate()` does not loop. Retry policy belongs to the caller — a
   function invocation with a five-minute timeout must not contain a ten-minute backoff loop.
   `hydrateWithBackoff()` is the separate helper for long-lived processes.
2. **Memoise success, never failure, and rate-limit retrying.** Caching a rejected promise makes
   the first attempt the only one. Not rate-limiting means every queue trigger re-attempts on
   every invocation, which on a capped tier spends the quota in minutes and starves every other
   consumer of the store: past it, every reader gets 429 `Resource utilization has surpassed the
   assigned quota` until the meter resets (observed daily between 00:00 and 01:00 UTC). **The
   meter is not the request count** (`BACKLOG.md` item 19): a Free store's `RequestQuotaUsage`
   was observed charging roughly 2–4 units per request, a ceiling nearer 250–400 requests a day
   than 1,000. Reason in `RequestQuotaUsage`, and in loads per worker start — worker churn, not
   traffic or deploys, drives the load count, and nothing in-process can bound it.
   Hence `retryFloorMs`: inside the floor, reject with a `ConfigFloorError` (`retryAfterMs`,
   `cause: lastError`) without touching the store. **What arms the floor is whether the attempt
   reached the store**, not what kind of error it ended in: a `ConfigInputError` raised after a
   response came back arms it (`reachedStore: true`), one rejected before that does not. A request
   that left and never came back is not a response. A floor rejection is not a failure — it never
   moves `failedAt`, never reaches `onError`, never widens `hydrateWithBackoff`'s delay — or a
   steady trickle of messages would hold the floor shut forever and the backoff schedule would
   drift off it. `retryAfterMs` is rounded up and carries a 50 ms margin, because a timer can fire
   a millisecond early and a retry that lands inside the floor is the dead-letter path again; the
   floor itself is enforced exactly. `hydrationStatus()` reads this bookkeeping and never makes a
   request, so a health endpoint pinging during an outage costs nothing.
3. **Report the underlying cause.** The provider *discards* it — a refused read surfaces as
   `All fallback clients failed to get configuration settings` wrapped in `The load operation
   failed`, with no 403 anywhere. A revoked grant and an unreachable store are indistinguishable.
   `ConfigLoadError.detail` must report that cause.

   **Correction, 20 September 2026 — unwrapping does not achieve this.** The provider discards
   the error rather than wrapping it: `#executeWithFailoverPolicy` catches a failoverable error,
   `continue`s to the next client and drops it, then throws a bare `All fallback clients failed…`
   with no `cause` and no `errors`. `isFailoverableError` covers 401/403/408/429/5xx and
   ENOTFOUND/ENOENT/ECONNREFUSED/ECONNRESET/ETIMEDOUT — every failure that matters. So walking
   `errors[]`/`cause` finds nothing; only a *non*-failoverable `RestError` (404, a bad filter)
   survives intact, which is why it looked like it worked.

   **Resolved, 20 September 2026 — by a pipeline policy, not a second request.** The note above
   proposed asking again with one direct `getConfigurationSetting`. That works, but it spends
   another request against the budget invariant 2 exists to protect, and it reports a *different*
   request's outcome. `clientOptions` is a documented provider option that it merges into every
   client it builds (`getClientOptions`, `Object.assign`), so `src/diagnostics.ts` passes a policy
   at `perRetry` — below the SDK's retry policy — which sees the raw response before the generated
   client turns it into an error, and the transport error when there is no response. The status is
   observed on the way past, at no extra request. The provider's own chain still wins wherever it
   does preserve a cause.

   **Zero observations is not a fact about the store, and must not be reported as one.** An
   unreachable store and a refused one are both *observed* — a failed lookup and a refused
   connection each throw in the transport, under the policy. So silence is only ever evidence
   about this side of the wire.

   **Attribute it from in-process evidence, never from the provider's wording.** A hung credential
   and a provider that has stopped honouring `clientOptions` produce a byte-identical chain —
   `The load operation failed.` wrapping `The load operation timed out.`, zero observations, both
   verified against the real provider. No string can separate them. What separates them is whether
   `getToken` resolved, so `src/diagnostics.ts` wraps the store credential the same way it wraps
   the pipeline, and `attributeSilence()` reads that: token arrived and nothing observed means the
   policy did not run (`clientOptions` is the suspect); token never arrived means the credential
   is; no token in play means the cause is unreported, said plainly rather than guessed at.

   An earlier attempt keyed this on the `All fallback clients failed` message. That branch was
   **unreachable** — the message is a plain `Error`, so `#initializeWithRetryPolicy` finds it
   neither an input nor a REST error and backs off on it until the abort, by which point the
   timeout has won the race; it only ever reaches `console.warn`. The message stays in the opaque
   set, but nothing is keyed on it: a guard that reads the provider's wording fails open when the
   wording changes, and this one failed open on day one.

   The fixtures in `test/helpers.ts` are now the provider's real shapes, with source line numbers.
   Restoring the old fabricated `errors: [...]` aggregate fails four tests.

   **Correction, 23 September 2026 — a Key Vault reference failure is not preserved either.**
   Checked against provider 2.6.0 with a local fake store: an unparseable reference, a malformed
   secret path and an unreachable vault are each wrapped in `KeyVaultReferenceError`, which the
   retry loop classes as neither input nor REST, so it re-reads the store and retries until the
   startup timeout. The caller gets `failed ← timed out` after the store answered 200. The earlier
   fixture (`failed ← KeyVaultReferenceError ← 403`) was a shape 2.6.0 never produces at startup,
   and on the endpoint path `attributeSilence()` blamed this case on `clientOptions` drift. The
   diagnostics policy now counts requests by outcome — answered, failed in the transport, still in
   flight — snapshotted when the startup timeout fires, because the provider holds a rejection
   until five seconds after it started and a request answered in that gap would change the
   picture. **`detail` states what was observed and names every cause that leaves open; it never
   rules out one the evidence cannot.** A request in flight keeps the network path and the store
   in play; a complete first read (answered ≥ selectors) keeps a Key Vault reference in play,
   in flight or not, because 2.6.0 re-reads the store every few seconds while it retries one.
   Only an incomplete read rules Key Vault out, since references resolve after it. `answered > 0`
   is the evidence for `reachedStore` (invariant 2). On 2.6.0 no store data reaches the provider's
   post-read input-error path, so `reachedStore` is defensive.

4. **Explicit key map, one selector per key.** Never a prefix or wildcard selector. Every Key
   Vault reference the provider loads it also resolves, so a wildcard attempts to resolve secrets
   the caller holds no grant on and turns another application's credential into this
   application's startup failure. A comma is the same selector spelled differently — App
   Configuration reads `a,b` as both keys — so `validate()` rejects unescaped `*` and `,` in keys
   (`\*` and `\,` match the literal character, and the lookup unescapes them), and any `*` or `,`
   in the label, escaped or not, as the provider does, because exactly one label is read.

## Other decisions that look arbitrary and are not

- **`timeoutMs` defaults to 15 s, not the provider's ~100 s.** App Service gives a container less
  than 100 s to answer its first ping, so the provider's default means the platform kills you
  before you can report the failure.
- **Backoff caps at 600 s. The cap bounds attempts, not requests.** Per-attempt cost depends on
  the failure, measured on provider 2.6.0: a 403 ≈ 1 request (the provider backs its client off
  after it, so its later passes inside the attempt send nothing); unreachable 0; a failure after
  a full read — a missing key — one per key, as a success. Under a persistent 403 attempts start
  at ~0, 45, 90, 135, 190, 285, 460, 795 s, then every ~615 s: ~140 requests a day. A persistent
  post-read failure settles to one attempt every ~600 s, ~144 a day, so ~144 × keys requests a
  day. Those are requests, not quota units: against a Free store's observed 250–400-request
  ceiling (invariant 2), one process under a persistent 403 spends a third or more of the day,
  and a post-read failure with three keys all of it. At a 60 s cap it would be over 1,100
  attempts a day. Nothing needs a faster poll — RBAC propagation is minutes in both directions,
  so a restored grant is not a restored application. The provider's `Failed to load … Retrying in
  5000 ms` warnings (~3 per attempt) are its loop inside the startup timeout, not this schedule.
- **The floor alone bounds `hydrate()` callers on message triggers:** at most one attempt per
  floor window per process — up to 2,880 a day per process at the 30 s default while a failure
  persists and messages keep arriving, each costing as above. A Functions app on a capped store
  weighs that against its instance, key and worker-start counts when it chooses `retryFloorMs`.
  Documented in `0.2.1`, the quota meter corrected in `0.3.0`; no default changed. **On a capped
  tier a fail-fast consumer turns quota exhaustion into a hard outage at its next worker start**
  (observed: 35 minutes of 503s from a new worker while loaded workers kept serving), so the docs
  recommend a paid tier for more than one consumer with churning workers.
- **The label is its own variable, never derived from `NODE_ENV`.** Images bake
  `ENV NODE_ENV=production`, so a staging container would read the production label and hit
  production databases. And in a Functions app `NODE_ENV` is an ordinary per-slot setting that
  often means something else — which is why precedence no longer reads it either (below).
- **The diagnostics stop at the access-key path, and that is accepted.** With no token there is
  no second in-process signal, so a provider that stopped honouring `clientOptions` and a
  genuinely silent failure are indistinguishable there; `detail` says the cause is unreported
  rather than picking one. That path exists for a run with no identity to borrow — a developer
  machine, since a store with local auth disabled puts every deployed consumer on the endpoint
  path, where the credential watch works. The failure surfaces to someone already reading the
  stack trace, not to a container answering 503 at four in the morning. Do not file this as a
  defect; closing it means a new signal for the one path carrying no production traffic.
- **Precedence inverts only when not deployed, detected by `WEBSITE_INSTANCE_ID` alone.**
  `localOverridesWin` is a dev-only escape hatch: false in every deployed environment, true
  locally. Default `options.localOverridesWin ?? !process.env.WEBSITE_INSTANCE_ID`, read on every
  attempt. App Service and Functions inject it on every instance; `func start`, `node` and test
  runners never set it. `NODE_ENV` plays no part: 0.1.0 keyed on `NODE_ENV === 'development'`, and
  a Functions slot is free to carry that value, which let leftover settings beat the store on
  staging without a warning. No Container Apps or Kubernetes signal yet — the only known hosts are
  App Service and Functions — so every other host must pass `localOverridesWin: false`, and the
  docs say so. Add a signal only with a consumer on that host. **The success line states the mode
  and why** (`0.2.1`), kept or not, after the variable list so the `0.2.0` prefix is unchanged:
  `…, label prod: A, B (store wins: WEBSITE_INSTANCE_ID present)`, `(local wins:
  WEBSITE_INSTANCE_ID absent)` — empty counts as absent — or `(… wins: localOverridesWin option
  true|false)` when the option is passed. The reason is the *effective* decision, never the raw
  option: the string `"false"` is truthy, so it says `local wins: localOverridesWin option true`;
  `null` falls through to the signal, as `??` does, and the reason names the signal. Otherwise a
  missing signal shows first as a stale value winning, and a consumer with no local settings left
  can never confirm the signal. Names only, never a value; still one `logger.log` line per
  successful attempt.
- **Local precedence still reads the store — decided in `0.3.0`, `BACKLOG.md` item 17.** With
  local wins and every mapped variable set locally, `attemptHydration` still loads first and
  applies precedence after. Kept, not skipped: the request also checks that the store exists and
  that the identity holds the grants the deployed application will need, which is what a local
  run is for. A developer needs `az login`, or the connection-string path. Skipping would also add
  a success that never touched the store, which a caller could not tell from a real one.
- **`ConfigFloorError` extends `Error`, not `ConfigLoadError` or `ConfigInputError`.** A catch on
  `ConfigLoadError` means "a store attempt just failed" and counts it; a floor rejection attempted
  nothing, and its `cause` may be any of the three kinds. Not an input error, so
  `hydrateWithBackoff` waits it out — the floor says nothing about the caller's own key map.
- **A store-rejected input error is a `ConfigInputError` with `reachedStore: true`, not a
  subclass.** `instanceof ConfigInputError` keeps one meaning — don't wait, waiting won't fix it —
  and `hydrateWithBackoff` still stops on both. The only difference is quota, which is the floor's
  business, so a property the floor reads is enough; a subclass would be a second export meaning
  the same thing to every catch.
- **`hydrateWithBackoff` stops on a `reachedStore: true` input error too — decided in `0.2.1`,
  `BACKLOG.md` item 10.** `reachedStore` is `answered > 0` for a response of any status, and the
  input classification covers a `TypeError` or `RangeError` anywhere in the chain, so it does not
  prove a store-side defect: retrying could loop for ever on one no store fix heals. And
  `ConfigInputError` means "don't wait" wherever it is caught, and `onError` never receives one;
  a consumer whose `onError` treats it as fatal relies on that. Unreachable on provider 2.6.0;
  revisit if a provider version can produce it.
- **`hydrationStatus().nextAttemptAt` uses the floor of the attempt that armed it.** The status
  has no caller, and `hydrate()` enforces each caller's own `retryFloorMs`, so a caller passing a
  different value sees a different window in its own `ConfigFloorError`. Documented, not
  reconciled: a process passing one value, or none, sees the two agree.
- **One key map per process is the supported shape — decided in `0.3.0`, frozen by `1.0.0`.** The
  floor is global because the quota is: it bounds requests to the store, and every key map in
  the process spends from the same quota. So a key map that fails on every attempt holds the
  floor shut for every other key map in the process, and a `hydrateWithBackoff` loop for another
  map can be starved by it for as long as that lasts. Making the floor per key map would spend
  the quota per map, which is the failure the floor exists to prevent. Changing this after
  `1.0.0` is a major.
- **Timing options are validated before any request.** A NaN `retryFloorMs` makes every floor
  comparison false — the floor fails open — and a zero or NaN backoff delay spins. Large finite
  floors are allowed; `sleep()` steps waits past 2^31-1 ms, which `setTimeout` turns into 1 ms.
  `timeoutMs` is capped at 2^31-1 because the provider hands it to `setTimeout` unstepped.
- **Writes are all or nothing.** Every entry is checked before `process.env` is touched, with no
  await in between, so a rejection means the environment is as it was.
- **The logger is per attempt, not per call.** The call that starts an attempt logs it — the
  success line through `log`, or since `0.3.0` the failure line through `error` (else `log`);
  joiners, memo hits and floor rejections log nothing. Documented rather than fixed: a
  process-level `configureHydration()` would be API for a problem a caller solves by passing a
  process-level logger.
- **`hydrate()` logs a failed attempt once — `0.3.0`, `BACKLOG.md` item 12.** Text
  `Configuration load failed: <error.message>`, the line two fail-fast consumers logged
  themselves, so deleting theirs changes no log. Logged in the attempt's rejection handler, which
  runs once however many callers joined, so it is once per attempt by construction; joiners get
  the identical rejection object (item 14, pinned). A pre-request rejection is not an attempt, but
  a fail-fast caller answering 503 for it would be silent, so it is logged the first time its
  message is seen in the current state (`reportedInputErrors`, cleared by `resetHydration()`).
  That covers `validate()`'s rejections and a `ConfigInputError` with `reachedStore: false` from
  the provider, which arms no floor and so would otherwise log on every call; a `reachedStore:
  true` one logs per attempt like any failure, and the floor spaces those out. The set grows once
  per distinct message and is cleared only by `resetHydration()` — the same growth class as the
  per-fingerprint memo, and deliberately uncapped: options built per request with varying bad
  values log, and store, each distinct message. One constant options object is the supported
  shape. The options and the logger are read inside the guard, so `hydrate(undefined)` and a
  throwing `logger` getter still reject rather than throw, and a throw, or an async logger's
  rejection, is swallowed, because logging must never change the outcome. Never a value — the
  line is the message.
- **`hydrateWithBackoff` does not double-log.** Its `onError` — default or custom — already
  reports every failure with the delay, and a container consumer's custom `onError` logs the
  failure itself. So the attempts it starts go through the internal `hydrateOnce(options, false)`,
  and its pre-request rethrow is unlogged too. Its default `onError` goes through the same guarded
  helper, so a broken logger neither ends the loop nor leaves a rejection unhandled; a custom
  `onError` that throws still ends it — caller code keeps its contract. An internal flag, not a
  public option: no caller of
  `hydrate()` needs to switch its failure line off. A `hydrate()` call joining an attempt the loop
  started logs nothing (it is a joiner); a loop joining an attempt a `hydrate()` call started gets
  that attempt's line and its own `onError` line — an accepted edge of mixing both in one process.
- **`retryAfterMs(error)` — `0.3.0`, item 13 — replaces the consumers' hardcoded margin.** A
  `ConfigFloorError`: its own. Any `ConfigInputError`: `undefined`, waiting won't fix it, even when
  it armed the floor. Anything else: the floor armed now, by `state.floorMs` (as
  `hydrationStatus` measures it), ceil'd, plus `FLOOR_MARGIN_MS`; `undefined` if open, meaning
  retry now. So `undefined` has two meanings, and callers branch on `instanceof
  ConfigInputError`, never on `undefined` — the README's message-trigger recipe does. It reads
  the current floor rather than the error, so an old error asked about later gets today's wait —
  which is what a caller about to retry needs. `FLOOR_MARGIN_MS` stays unexported: the helper is
  the one place it is added.
- **`gated(options, handler)` — `0.3.0`, item 18 — is structural.** It returns
  `ConfigUnavailableResponse` (`{ status: 503; body; headers? }`), assignable to `HttpResponseInit`,
  with no runtime or type dependency on `@azure/functions`; `test/gated.test.ts` proves the fit
  against the real types, a devDependency. It never rejects because of configuration and never
  logs (item 12 does); the handler's own errors are not its business. `Retry-After` is whole
  seconds, at least 1, from `retryAfterMs`, and omitted when that is `undefined` or the value is
  not a safe integer — a floor too big for one prints in exponent notation. One wrapper, one
  export: an HTTP-only shape, because only HTTP consumers fail fast.
- **Two builds, one state — `0.3.0`.** tsup emits ESM and CJS, and a graph reaching both used to
  get two module-scope states: two floors (the quota invariant spent twice), a `resetHydration()`
  that cleared one, and `instanceof` failing across copies — a `hydrateWithBackoff` in one copy
  joining the other's attempt would retry a `ConfigInputError`. The state now lives at
  `globalThis[Symbol.for('@actvalue/azure-app-config/state@<version>')]`, created on first use,
  the version bundled from `package.json` at build time (never a hand-kept constant).
  **Keyed on the exact version**: both builds of one version share it; two versions in one graph
  keep separate state — each has its own floor — because nothing guarantees one version's state
  shape means the same to another. `resetHydration()` replaces the registry entry; a late
  rejection still compares against the state object it captured. The error classes carry brands
  (`Symbol.for(...)`, non-enumerable) and `static [Symbol.hasInstance]` checking them. The error
  classes' brands carry no version, so `instanceof` matches an instance from either build of any
  version of the package; the state is shared only by the two builds of one exact version. Each
  class has its own brand, so
  `ConfigFloorError` is still not a `ConfigLoadError`; a consumer's subclass keeps prototype
  semantics. The cost: re-importing the package in a test (`vi.resetModules`,
  `jest.isolateModules`) no longer gives fresh state — call `resetHydration()`. Test files stay
  isolated: Jest and vitest (default isolation) give each file its own `globalThis`. The unit
  suite simulates the second build with `vi.resetModules()`; `scripts/check-dist.mjs` (run by
  `prepublishOnly` after the build, and as `npm run check:dist`) loads the real `dist/index.mjs`
  and `dist/index.js` in one process and checks the shared floor, the shared reset, cross-build
  `instanceof`, and that `dist/index.d.ts` does not import `@azure/functions`.

## Conventions

- TypeScript strict; build with `tsup`, emit esm + cjs + `.d.ts`; `files: ["dist/"]`.
- Tests are **vitest**, no live Azure — fake the provider's `load()` at the module boundary.
  Every invariant above gets a test that fails if it is relaxed: single attempt, failure not
  memoised, floor enforced, cause surfaced, no wildcard selector reaches the provider. So does
  every decision above: the floor error's class and `retryAfterMs`, the floor armed by a
  store-rejected input error and not by a pre-request one, zero `load()` calls from
  `hydrationStatus()` in every state, all-or-nothing writes, the `WEBSITE_INSTANCE_ID` default in
  both directions, the floor margin against a timer firing early, `hydrateWithBackoff` sleeping
  through a floor rejection without reporting it and reporting the real wait after a failure, a
  huge floor slept in steps, invalid timing options refused, unescaped commas refused and escaped
  ones allowed, and the wire evidence reported as facts and candidates, counted at the timeout.
  And from `0.2.1`: the success line's precedence mode in all four cases (signal present or
  absent, option true or false), the string `"false"` and `null`, and the `0.2.0` prefix intact.
  And from `0.3.0`: the failure line once per attempt, through `error` with the `log` fallback,
  and none for joiners, memo hits or floor rejections; joiners receiving the identical rejection;
  a pre-request rejection logged once per message and again after a reset, the provider's own
  `reachedStore: false` input error included; no value in the line; a throwing or rejecting
  logger leaving the outcome unchanged, `hydrate(undefined)` and a throwing `logger` getter
  rejecting rather than throwing, and `hydrateWithBackoff`'s default `onError` surviving a broken
  logger; `hydrateWithBackoff` adding no
  line with a custom `onError` and exactly its own with the default; `retryAfterMs` for each kind,
  with the margin and no request; `gated` returning the handler's result, passing its errors
  through, answering 503 with and without `Retry-After`, never rejecting, and fitting
  `app.http()` at compile time; and two module instances sharing memo, floor and reset, with
  errors matching across them and no brand matching another class.
- **Error fixtures must match the provider's real shape**, which `test/helpers.ts` records with
  source line numbers. A fixture easier to unwrap than reality certifies the bug it was written
  to catch.
- **The provider's half of the contract gets a real test.** `load()` is mocked everywhere else,
  so nothing in the unit run would notice a provider upgrade that dropped or renamed
  `clientOptions` — every test would stay green while `detail` fell through to the
  no-observations branch and reported a 403 as an unreachable store. One integration test
  (`test/*.integration.test.ts`, its own config, excluded from `npm test`) runs the real `load()`
  against an RFC 2606 `.invalid` endpoint and asserts at least one observation. It needs no
  Azure, credentials or egress.
- Public API stays small and additive. Pre-1.0 it can change; after 1.0 a change to any of the
  four invariants is a major.
- Keep the two implementations behaviourally identical. Same option names in snake_case, same
  defaults, same error semantics. A divergence is a bug in whichever half moved. **Every 0.2.0
  behaviour is part of the spec the Python half must match** — `ConfigFloorError` with
  `retry_after_ms`, `DEFAULT_RETRY_FLOOR_MS`, `reached_store` and the floor it arms,
  `hydration_status()` that never makes a request, `loaded_at`, all-or-nothing writes, the
  `WEBSITE_INSTANCE_ID` default, the per-attempt logger. So is the `0.2.1` success line: the
  `0.2.0` prefix, then ` (store|local wins: <reason>)` after the list, word for word, with the
  reason built from the effective decision (`local_overrides_win option true|false`, or the
  signal when the option is `None`), and `hydrate_with_backoff` still re-raising every
  `ConfigInputError`. **Every `0.3.0` behaviour is spec too:** `retry_after_ms(error)` with the
  same three branches; the failure line `Configuration load failed: <message>` once per attempt
  through the logger of the call that started it (`error`, else `log`), once per distinct message
  for a pre-request rejection, never for a joiner, a memo hit or a floor rejection, and never
  changing the outcome; joiners receiving the identical exception object; `hydrate_with_backoff`
  not double-logging; and a `gated` equivalent answering the same 503 and `Retry-After` for
  whatever HTTP shape Python consumers use — **not in Python `0.3.0`**: no Python consumer has
  HTTP triggers yet, so it is a known additive gap, added with the first one. The dual-build registry and the error brands have no
  Python counterpart: a Python process imports a module once, so there is one state and one set
  of classes by construction — say so in the Python half rather than inventing a registry.
  `CHANGELOG.md` lists them.

## Python-specific decisions

The Python half runs on `azure-appconfiguration-provider` 2.5.0, which behaves differently from
the JavaScript provider. `tests/helpers.py` records its shapes with source line numbers; the
integration test checks them against the real provider.

- **Sync core, async wrapper.** `hydrate()` is synchronous: one module-level state behind one
  lock, joiners in other threads wait on the attempt's event and re-raise its exception object.
  `hydrate_async` is `asyncio.to_thread(hydrate)`, so both share memo and floor. Consumers mix
  sync handlers (the worker's thread pool) with async ones and call `hydrate` at module top.
- **Every caller re-raises with the starter's traceback below the shared frame**
  (`_Attempt.traceback`). A plain re-raise piles every joiner's frames and locals (a Service Bus
  message) onto the one object, retained through `last_error` and the floor error. The limit, since
  identity is the spec: the traceback of a shared failure may show another caller's frames; it
  does not grow.
- **Lines are logged after the attempt is settled** — result or error recorded, attempt cleared,
  `done` set — still once, by the starter. A logging handler calling `hydrate()` on that thread
  otherwise joins its own attempt and waits for ever. The default credential is built on the
  calling thread, before the attempt is registered and outside `_lock`, because its constructor
  logs through `azure.identity`; a `hydrate()` from a handler during that construction raises an
  unlogged `ConfigLoadError` (a thread-local guard), since it cannot be given a credential and
  logging would re-enter the handler. Only the provider's and SDK clients' loggers run on the load
  thread; a handler there calling `hydrate()` waits until the bound: documented, not fixable here.
- **`timeout_ms` bounds the call, on a daemon thread.** The provider checks `startup_timeout` only
  between passes (`_azureappconfigurationprovider.py:240-246`), so a hanging request holds `load()`
  for the transport's 300 s and more. `_run_bounded` waits `timeout_ms`; only the calling thread
  writes `os.environ`, so a late load writes nothing, and a late provider is closed. Traffic is
  counted at the bound. Below 5 000 ms the provider's five-second pad puts its error past the
  bound: the wire evidence reports it instead. Accepted; the default is 15 s.
- **What ends an abandoned load thread: `_client_limits`, on store and vault clients alike.**
  `retry_total=0`, because azure-core sleeps a `Retry-After` uncapped before re-checking its
  absolute `timeout` (`azure/core/pipeline/policies/_retry.py:453-470`, `:514-575`); no retry is
  the only cap. The provider pops it for the store clients (`_azureappconfigurationprovider.py:86`)
  and passes it per operation (`_utils.py:133-164`). `connection_timeout`/`read_timeout` at 2 × the
  bound, so a request in flight at the bound is reported in flight, not raced by its own timeout.
  The vault clients get the same through `keyvault_client_configs` as a mapping that answers every
  vault URL (`_EveryVault`; the provider does `configs.get(vault_url, {})`,
  `_key_vault/_secret_provider.py:48-56`). Worst case, every request answering just inside its
  limits: (selectors + pages + 2 × references) × 4 × the bound. Unbounded by us: the credential's
  own token calls, a server trickling bytes (read timeout is per read), the resolver, and the
  provider's SRV replica discovery (`_discovery.py:81-90`). One request per selector per attempt,
  since the provider backs its only client off for 30 s after a failure. **A trade, decided:** a
  single transient 5xx or 429 fails the attempt (about 10 s at the defaults) and arms the 30 s
  floor, about 40 s without configuration, where the TypeScript half's SDK retries would usually
  absorb it; bought with it, one request per failure and an abandoned thread that ends.
- **The provider keeps the cause; the chain wins, with provenance.** `_load_all` raises
  `TimeoutError(msg, startup_exceptions)` carrying every `AzureError` (`:243-246`), so `detail`
  unwraps it — but prefers the observations when they saw the same statuses (the store's own
  words). A status in the chain the store's pipeline never saw, while it saw the store answer, is
  stated as not the store's: Key Vault's `SecretClient` is the provider's only other client, and it
  does not carry the policy.
- **The policy sits above authentication** (`per_retry_policies` goes directly after
  `RetryPolicy`, `azure/core/_pipeline_client.py:155-172`). A request waiting on a token is
  counted in flight, so the credential check comes first in `_attribute_silence`: asked and never
  answered means the request never reached the transport.
- **The policy is a `SansIOHTTPPolicy`.** One instance goes to every client the provider builds;
  `Pipeline` rewires an `HTTPPolicy` instance's `next` per pipeline (`azure/core/pipeline/_base.py:
  170-176`), so with replicas the primary's requests would run down the last replica's chain. A
  SansIO policy gets its own runner per pipeline and holds only the shared counts.
- **An input error happens before any network activity, or it is not one.** A `ValueError`,
  `TypeError` or `IndexError` from the provider is a `ConfigInputError` only when no token was
  asked for and no request seen: the provider's argument checks. After that the same classes come
  from failures waiting can fix — msal's `JSONDecodeError` on a non-JSON identity-endpoint body,
  which `ManagedIdentityCredential` re-raises unwrapped; azure-core's `DeserializationError`; a
  vault response that does not decode — and an input error stops `hydrate_with_backoff` and the
  message-trigger recipe for good. So a Key Vault reference 2.5.0 cannot parse (raised at once
  after the read) is a retryable `ConfigLoadError`, as the same defect is on TypeScript, and its
  `detail` still names the reference. `reached_store` is always `False`: defensive, as in TS.
- **One `DefaultAzureCredential` per process**, in the state, created on first need.
  `reset_hydration()` drops it without closing it: an in-flight attempt or an abandoned thread may
  still be using it, and closing it would fail them ("transport has already been closed"); the GC
  collects it. Two threads racing to build it: the first installed wins, the loser is closed
  unused. One per attempt would be up to 2,880 a day under a persistent failure, each with its own
  session and an empty token cache. A caller's credential is never touched.
- **A stored value the provider echoes is withheld.** `parse_key_vault_id` puts the reference URI
  in its message (`azure/keyvault/secrets/_shared/__init__.py:50-57`); a mistyped reference can
  be the secret itself.
- **The success line is guarded too.** The environment is written before it; a raising logger
  there would report a failure that changed the environment. The TypeScript half does not guard
  `logger.log` on success — a gap for the API review.
- **Refused before any request, beyond TypeScript:** an empty key (the SDK sends `key=`, a filter
  nobody has verified), a variable name `os.environ` cannot hold. A NUL in a value is unusable, and
  `_write_all` restores what it wrote if a write still fails.
- **A missing key raises `LookupError`**, the plain-`Error` counterpart; the cause is `__cause__`
  on all three error classes; timestamps are `int` milliseconds; results hold tuples.

## Status

- [x] TypeScript `src/index.ts` — `hydrate`, `hydrateWithBackoff`, `ConfigLoadError`, `resetHydration`
- [x] Tests for the four invariants
- [x] First consumer: an Azure Functions app, consuming `0.1.0` from the registry. Its findings
      are `BACKLOG.md`, all shipped in `0.2.0`
- [x] `0.2.0` published, and the first consumer's workarounds deleted (`CHANGELOG.md` lists them)
- [x] Second consumer: a container web app on App Service, converted from its inlined copy onto
      `0.2.0` with no library change. The default `WEBSITE_INSTANCE_ID` signal was confirmed in
      production inside the container under pm2-runtime, so it passes no option. Its findings are
      `BACKLOG.md` items 8–11
- [x] Decide `BACKLOG.md` items 8–11: 8, 9 and 11 shipped in `0.2.1`, a patch release no
      consumer has to change code for; 10 decided not done
- [x] Third and fourth consumers: Functions apps with HTTP triggers only, failing fast, converted
      onto `0.2.1` with no library change. Their findings are `BACKLOG.md` items 12–19
- [x] `0.3.0`: items 12–19 shipped or decided, and both items once deferred to `1.0.0` settled —
      the dual-build state (a version-keyed `globalThis` registry) and starvation across key maps
      (global floor, documented). The TypeScript API freeze candidate
- [ ] `0.3.0` published, and the consumers' workarounds deleted (`CHANGELOG.md` lists them)
- [ ] API review across both halves, then `1.0.0`: the Python half, and the TypeScript half
      republished without a behaviour change
- [x] Python half written as `0.3.0` (unpublished): parity with TypeScript `0.3.0` except `gated`,
      a known additive gap for the first Python HTTP consumer
- [ ] Python `0.3.0` published and validated by its first consumer: a Functions app with Service
      Bus and timer triggers
- [ ] The Python half's own second consumer

The second consumer's inlined copy of the hydrator is still part of the specification: read it
before changing behaviour it relies on, and delete it when that consumer converts.
