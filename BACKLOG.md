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

## Already open

- ESM/CJS dual state (CLAUDE.md, **Status**, deferred to `1.0.0`). The first consumer is CJS-only and adds nothing new.
- Starvation across key maps (CLAUDE.md, decisions, deferred to `1.0.0`). The retry floor is global, so a key map that fails on every attempt keeps the floor shut for every other key map in the process, and can starve a `hydrateWithBackoff` loop for another map. One key map per process is the supported shape until this is decided.
