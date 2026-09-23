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

Order of work: TypeScript first, shaped against a real Azure Functions consumer, then a second
container consumer, then `1.0.0`. Python follows. See **Status** below.

## Commands

```bash
make install          # both languages
make test             # both
make test-ts          # vitest, unit
make test-integration-ts  # real provider, no Azure — see below
make lint-ts
make build-ts         # tsup → dist/, esm + cjs + dts
make publish-ts       # npm publish (prepublishOnly builds)
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
   every invocation, which on the Free SKU (1,000 req/day, then 429 to every reader until
   midnight UTC) spends the quota in minutes and starves every other consumer of the store.
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
  at ~0, 45, 90, 135, 190, 285, 460, 795 s, then every ~615 s: ~140 requests a day, 14% of the
  Free tier. A persistent post-read failure settles to one attempt every ~600 s, ~144 a day, so
  ~144 × keys requests a day: past 1,000 from 7 keys, from one process. At a 60 s cap it would be
  over 1,100 attempts a day, past the quota even at one request each. Nothing needs a faster poll
  — RBAC propagation is minutes in both directions, so a restored grant is not a restored
  application. The provider's `Failed to load … Retrying in 5000 ms` warnings (~3 per attempt)
  are its loop inside the startup timeout, not this schedule.
- **The floor alone bounds `hydrate()` callers on message triggers:** at most one attempt per
  floor window per process — up to 2,880 a day per process at the 30 s default while a failure
  persists and messages keep arriving, each costing as above. A Functions app on a Free store
  weighs that against its instance and key counts when it chooses `retryFloorMs`. Documented in
  `0.2.1`; no default changed.
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
- **One key map per process is the supported shape. Known limitation, deferred to `1.0.0`.** The
  floor is global because the quota is, so a key map that fails on every attempt holds the floor
  shut for every other key map in the process, and a `hydrateWithBackoff` loop for another map can
  be starved by it for as long as that lasts. Not changed in `0.2.0`: making the floor per key map
  would spend the quota per map, which is the failure the floor exists to prevent.
- **Timing options are validated before any request.** A NaN `retryFloorMs` makes every floor
  comparison false — the floor fails open — and a zero or NaN backoff delay spins. Large finite
  floors are allowed; `sleep()` steps waits past 2^31-1 ms, which `setTimeout` turns into 1 ms.
  `timeoutMs` is capped at 2^31-1 because the provider hands it to `setTimeout` unstepped.
- **Writes are all or nothing.** Every entry is checked before `process.env` is touched, with no
  await in between, so a rejection means the environment is as it was.
- **The logger is per attempt, not per call.** The call that starts an attempt logs it; joiners
  and memo hits log nothing. Documented rather than fixed: a process-level `configureHydration()`
  would be API for a problem a caller solves by passing a process-level logger.

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
  `ConfigInputError`. `CHANGELOG.md` lists them.

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
- [ ] `1.0.0` published to npm — only after both consumers run on it
- [ ] Python half, then its own second consumer

Open, deferred to `1.0.0`: the memoised state is module-scope, so a consumer graph reaching both
the ESM and the CJS build gets two of it and `resetHydration()` clears one. A `globalThis` symbol
registry fixes it; whether two *versions* of the package in one graph should share state needs
deciding first.

The second consumer's inlined copy of the hydrator is still part of the specification: read it
before changing behaviour it relies on, and delete it when that consumer converts.
