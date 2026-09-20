# @actvalue/azure-app-config

Hydrate `process.env` from **Azure App Configuration**, with the failure handling that platform
actually needs.

> **Pre-1.0, unpublished.** Consume it from an `npm pack` tarball until `1.0.0`. A Python half,
> `actvalue.azure-app-config`, follows from the same repository.

```bash
npm install @actvalue/azure-app-config
```

## Use

You give it a map from store key to environment variable. It loads exactly those keys at exactly
one label, resolves any Key Vault references with your own managed identity, and writes the
values into the environment before your application reads it.

```ts
import { hydrate } from '@actvalue/azure-app-config';

const KEYS = {
  'shared:mongoUrl':   'MONGO_URL',
  'shared:serviceBus': 'SERVICE_BUS_CONNECTION',
  'myapp:httpPort':    'HTTP_PORT',
};

await hydrate({ keys: KEYS });
```

Endpoint, label and credential come from the environment by default:

| Variable | Meaning | Required |
|---|---|---|
| `APP_CONFIG_ENDPOINT` | Store endpoint, read with `DefaultAzureCredential` | yes, unless a connection string is set |
| `APP_CONFIG_LABEL` | The one label to read (`prod`, `staging`, …) | yes |
| `APP_CONFIG_CONNECTION_STRING` | Access-key fallback for runs with no identity to borrow | no |
| `NODE_ENV` | `development` inverts precedence | no |

## Two shapes

**A long-lived process** — container, App Service, anything with a port. Bind the port first,
answer unhealthy, then hydrate with backoff. A configuration failure then reaches the platform as
a container that started and is unhealthy rather than one that never opened its port, and a store
that recovers inside the window heals the application with no restart.

```ts
import { hydrateWithBackoff } from '@actvalue/azure-app-config';

let ready = false;
startHealthcheck(() => ready);            // listening before anything can fail

await hydrateWithBackoff({ keys: KEYS }); // 5 s → 10 s → … → 600 s, forever
ready = true;
```

**Azure Functions**, and anything else with no bootstrap phase. The host builds a trigger's
connection before user code runs, so trigger connections stay app settings; everything else is
hydrated on first use and awaited at the top of each function.

```ts
app.serviceBusQueue('Rollup', {
  handler: async (message, context) => {
    await hydrate({ keys: KEYS });        // free after the first success
    await processMessage(message);
  },
});
```

Module-scope initialisation has to become lazy for this to work: a client constructed at import
time reads the environment before hydration can fill it. That is a change in your application.

## Why not call `@azure/app-configuration-provider` directly

Four things, each learned from a production failure and none of them visible from the provider's
documentation.

1. **One attempt per call.** `hydrate()` does not loop. A function invocation with a five-minute
   timeout must not contain a ten-minute backoff loop, so the loop is a separate helper that only
   a long-lived process calls.
2. **Success is memoised, failure is not — and retrying is rate-limited.** Caching a rejected
   promise makes the first attempt the only one. Not caching it at all means every queue trigger
   re-attempts on every invocation, and on the Free SKU (1,000 requests a day, then HTTP 429 to
   every reader until midnight UTC) that spends the quota in minutes and starves every other
   consumer of the store. So after a failure `hydrate()` refuses to re-attempt for
   `retryFloorMs` and re-throws the previous error instead.
3. **A failed load says why.** The provider reports a refused read as `All fallback clients
   failed to get configuration settings` three times and then `The load operation timed out`,
   with no 403 anywhere — a revoked grant and an unreachable store are indistinguishable.
   `ConfigLoadError.detail` unwraps the aggregate and reports the underlying cause.
4. **An explicit key map, never a prefix.** Every Key Vault reference the provider loads, it also
   resolves. A selector like `shared:*` therefore tries to resolve secrets your application holds
   no grant on, and turns another application's credential into your startup failure. One
   selector per key means nothing outside the map is ever fetched.

The startup timeout defaults to **15 s**, not the provider's ~100 s: App Service gives a container
less than 100 s to answer its first ping, so the provider's default means the platform kills you
before you can report the failure.

## Precedence

Everywhere but a developer machine **the store wins** — it overwrites whatever the environment
held, so a stale app setting cannot quietly beat the migrated value. Under `NODE_ENV=development`
that inverts: a value already in the environment wins. Set `localOverridesWin` explicitly if your
application does not use `NODE_ENV` this way.

The label is its own variable and is never derived from `NODE_ENV`. Images bake
`ENV NODE_ENV=production`, so a staging container would otherwise read the production label.

## API

### `hydrate(options): Promise<HydrationResult>`

| Option | Default | |
|---|---|---|
| `keys` | — | **Required.** `{ [storeKey]: envVarName }` |
| `label` | `APP_CONFIG_LABEL` | Throws if neither is set |
| `endpoint` | `APP_CONFIG_ENDPOINT` | |
| `connectionString` | `APP_CONFIG_CONNECTION_STRING` | Takes precedence when set |
| `credential` | `new DefaultAzureCredential()` | Used for the store and for Key Vault references |
| `timeoutMs` | `15_000` | Provider startup timeout |
| `retryFloorMs` | `30_000` | Minimum gap between attempts after a failure |
| `localOverridesWin` | `NODE_ENV === 'development'` | |
| `logger` | `console` | |

Returns `{ label, applied, kept }` — which variables were written and which were left alone.
Throws `ConfigLoadError` if the store cannot be read, and a plain `Error` naming **every** key
that was absent or empty at that label.

### `hydrateWithBackoff(options, backoff?): Promise<HydrationResult>`

Calls `hydrate` until it succeeds. `backoff` is `{ initialMs = 5_000, maxMs = 600_000, onError }`.
Never returns a rejection — it retries forever, by design. **Long-lived processes only.**

The ten-minute cap is not arbitrary: at a one-minute cap a single stuck application spends a Free
store's entire daily quota in about five hours. Nothing waits on a faster poll, because
role-assignment changes take minutes to propagate in both directions. `hydrate`'s retry floor
still applies, so a delay shorter than `retryFloorMs` produces an attempt that re-throws the
previous error without touching the store.

### `ConfigLoadError`

`message` names the store and label that failed and carries the cause; `cause` is the provider's
error unmodified; `detail` is the unwrapped underlying reason; `statusCode` is the HTTP status of
the innermost error that carried one.

### `resetHydration()`

Clears the memoised result and the retry floor. For tests.

## License

MIT
