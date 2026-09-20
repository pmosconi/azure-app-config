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
make test-ts          # vitest
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
3. **Report the underlying cause.** The provider hides it — a refused read surfaces as
   `All fallback clients failed to get configuration settings` ×3 and then `The load operation
   timed out`, with no 403 anywhere. A revoked grant and an unreachable store are
   indistinguishable. `ConfigLoadError.detail` must unwrap the aggregate.
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
- **Precedence inverts under `NODE_ENV=development` only.** Store wins everywhere else, so a
  stale app setting cannot beat a migrated value. Safe precisely because no deployed container
  can take the development branch.

## Conventions

- TypeScript strict; build with `tsup`, emit esm + cjs + `.d.ts`; `files: ["dist/"]`.
- Tests are **vitest**, no live Azure — fake the provider's `load()` at the module boundary.
  Every invariant above gets a test that fails if it is relaxed: single attempt, failure not
  memoised, floor enforced, cause surfaced, no wildcard selector reaches the provider.
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

Two copies of the hydrator exist in consumer repositories today. They are the specification;
read them before writing this one, and delete them as each consumer converts.
