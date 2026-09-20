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
   Hence `retryFloorMs`: inside the floor, re-throw the previous error without touching the store.
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

4. **Explicit key map, one selector per key.** Never a prefix or wildcard selector. Every Key
   Vault reference the provider loads it also resolves, so a wildcard attempts to resolve secrets
   the caller holds no grant on and turns another application's credential into this
   application's startup failure.

## Other decisions that look arbitrary and are not

- **`timeoutMs` defaults to 15 s, not the provider's ~100 s.** App Service gives a container less
  than 100 s to answer its first ping, so the provider's default means the platform kills you
  before you can report the failure.
- **Backoff caps at 600 s.** At a 60 s cap one stuck app spends the Free store's daily quota in
  ~5 hours; at 600 s it is a few dozen requests a day. Nothing needs a faster poll — RBAC
  propagation is minutes in both directions, so a restored grant is not a restored application.
- **The label is its own variable, never derived from `NODE_ENV`.** Images bake
  `ENV NODE_ENV=production`, so a staging container would read the production label and hit
  production databases.
- **The diagnostics stop at the access-key path, and that is accepted.** With no token there is
  no second in-process signal, so a provider that stopped honouring `clientOptions` and a
  genuinely silent failure are indistinguishable there; `detail` says the cause is unreported
  rather than picking one. That path exists for a run with no identity to borrow — a developer
  machine, since a store with local auth disabled puts every deployed consumer on the endpoint
  path, where the credential watch works. The failure surfaces to someone already reading the
  stack trace, not to a container answering 503 at four in the morning. Do not file this as a
  defect; closing it means a new signal for the one path carrying no production traffic.
- **Precedence inverts under `NODE_ENV=development` only.** Store wins everywhere else, so a
  stale app setting cannot beat a migrated value. Safe precisely because no deployed container
  can take the development branch.

## Conventions

- TypeScript strict; build with `tsup`, emit esm + cjs + `.d.ts`; `files: ["dist/"]`.
- Tests are **vitest**, no live Azure — fake the provider's `load()` at the module boundary.
  Every invariant above gets a test that fails if it is relaxed: single attempt, failure not
  memoised, floor enforced, cause surfaced, no wildcard selector reaches the provider.
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
  defaults, same error semantics. A divergence is a bug in whichever half moved.

## Status

- [x] TypeScript `src/index.ts` — `hydrate`, `hydrateWithBackoff`, `ConfigLoadError`, `resetHydration`
- [x] Tests for the four invariants
- [ ] First consumer: an Azure Functions app, on its staging slot, from an `npm pack` tarball
- [ ] Second consumer: a container web app, converted from its inlined copy
- [ ] `1.0.0` published to npm — only after both consumers run on it
- [ ] Python half, then its own second consumer

Open, deferred to `1.0.0`: the memoised state is module-scope, so a consumer graph reaching both
the ESM and the CJS build gets two of it and `resetHydration()` clears one. A `globalThis` symbol
registry fixes it; whether two *versions* of the package in one graph should share state needs
deciding first.

Two copies of the hydrator exist in consumer repositories today. They are the specification;
read them before writing this one, and delete them as each consumer converts.
