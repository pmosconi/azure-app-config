# azure-app-config

Hydrate `process.env` / `os.environ` from **Azure App Configuration**, with the failure handling
that platform actually needs.

Available for TypeScript and Python from one repository, on the model of a paired
npm + PyPI package.

```bash
npm install @actvalue/azure-app-config       # TypeScript — in development
pip install actvalue.azure-app-config        # Python — not yet written
```

> **Status: pre-1.0, unpublished.** The TypeScript half is being written against two real
> consumers — an Azure Functions app and a container web app — and `1.0.0` is published only
> once both run on it. The Python half follows. Until then, consume it from an `npm pack`
> tarball, not from the registry.

## What it does

You give it a map from store key to environment variable. It loads exactly those keys at
exactly one label, resolves any Key Vault references with your own managed identity, and writes
the values into the environment before your application reads it.

```ts
import { hydrate } from '@actvalue/azure-app-config';

await hydrate({
  keys: {
    'shared:mongoUrl':     'MONGO_URL',
    'shared:serviceBus':   'SERVICE_BUS_CONNECTION',
    'myapp:httpPort':      'HTTP_PORT',
  },
});
```

Everything else — endpoint, label, credential — comes from the environment by default:

| Variable | Meaning | Required |
|---|---|---|
| `APP_CONFIG_ENDPOINT` | Store endpoint, read with `DefaultAzureCredential` | yes, unless a connection string is set |
| `APP_CONFIG_LABEL` | The one label to read (`prod`, `staging`, …) | yes |
| `APP_CONFIG_CONNECTION_STRING` | Access-key fallback for runs with no identity to borrow | no |
| `NODE_ENV` | `development` inverts precedence — see below | no |

## Why not just call the provider

`@azure/app-configuration-provider` loads configuration. This package is the thin layer around
it that four things went wrong in, each of which was invisible from reading the provider's
documentation and cost a production incident or a near miss to find.

**A failed load does not say why.** A revoked role assignment and an unreachable store are
indistinguishable in the provider's output: you get `All fallback clients failed to get
configuration settings` three times, then `The load operation timed out`. No 403, anywhere.
`ConfigLoadError` unwraps the aggregate and reports the underlying cause, so the next person to
hit this does not need a runbook open to attribute it.

**The default startup timeout is longer than the platform's patience.** The provider retries
internally for about 100 seconds before it reports failure. App Service gives a container less
than that to answer its first ping. The default here is 15 seconds, so the failure arrives while
you can still do something about it.

**Retry policy belongs to the caller, not to the load.** A long-lived process wants to retry for
as long as it takes, staying up and unhealthy. A function invocation with a five-minute timeout
must not contain a ten-minute backoff loop. So `hydrate()` makes a **single attempt**, and the
backoff loop is a separate helper that only a long-lived process calls.

**Success is memoised; failure is not — but retrying is rate-limited.** Caching a rejected
promise makes the first attempt the only one. Not caching it at all means every queue trigger
re-attempts on every invocation, and on the Free SKU (1,000 requests a day, then HTTP 429 to
every reader until midnight UTC) a handful of triggers spend the daily quota in minutes and take
down every other consumer of the store with them. So after a failure `hydrate()` refuses to
re-attempt for `retryFloorMs` and re-throws the last error instead.

## Two shapes

### Long-lived process — container, App Service, anything with a port

Bind the port **first**, answer unhealthy, then hydrate with backoff. A configuration failure
then reaches the platform as a container that started and is unhealthy, rather than one that
never opened its port — and a store that recovers inside the window heals the application with
no restart at all.

```ts
import { hydrateWithBackoff } from '@actvalue/azure-app-config';

let ready = false;
startHealthcheck(() => ready);          // listening before anything can fail

await hydrateWithBackoff({ keys: KEYS });   // 5 s → 10 s → … → 600 s, forever
ready = true;

await main();
```

The ten-minute cap is not arbitrary. At a one-minute cap a single stuck application spends the
Free store's entire daily quota in about five hours; at ten minutes it is a few dozen requests
across a day. Nothing is waiting on a faster poll — role-assignment changes take minutes to
propagate in both directions, so a restored grant is not a restored application either way.

### Azure Functions — and anything else without a bootstrap phase

The host builds a trigger's connection before user code runs, so trigger connections stay app
settings. Everything else is hydrated on first use, awaited at the top of each function:

```ts
import { hydrate } from '@actvalue/azure-app-config';

app.serviceBusQueue('Rollup', {
  handler: async (message, context) => {
    await hydrate({ keys: KEYS });    // free after the first success
    await processMessage(message);
  },
});
```

Module-scope initialisation has to become lazy for this to work — a client constructed at import
time reads the environment before hydration can fill it. That is a change in your application,
not something a package can do for you.

If you use the v4 `app.hook.appStart()` hook, verify on your worker version that it completes
before module-scope code runs. If the ordering does not hold, lazy initialisation is the
guarantee and the hook is only an optimisation.

## Precedence: who wins when a variable is already set

Everywhere but a developer machine, **the store wins** — it overwrites whatever the environment
held, so a stale app setting or a leftover `.env` line cannot quietly beat the migrated value.

Under `NODE_ENV=development` that inverts: a value already in the environment wins, so a `.env`
line can point one variable at a local database without reaching into the store. This is safe
because a Dockerfile that bakes `ENV NODE_ENV=production` means no deployed container can take
the branch — and it is exactly why the label is its own variable and not derived from `NODE_ENV`.
Those are two different questions about the same run. A staging container reading
`NODE_ENV=production` from its own image would otherwise load production databases.

Set `localOverridesWin` explicitly if your application does not use `NODE_ENV` this way.

## Why an explicit key map and not a prefix filter

`keys` is a map, not a wildcard, for two reasons. The store key and the variable name are
generally not the same string. And more seriously: **every Key Vault reference the provider
loads, it also resolves.** A selector like `shared:*` therefore tries to resolve secrets your
application holds no grant on, and turns another application's credential into your startup
failure. One selector per key means nothing outside the map is ever fetched.

## API

### `hydrate(options): Promise<HydrationResult>`

One attempt. Resolves once and is memoised on success; on failure the rejection is not cached,
but a further attempt inside `retryFloorMs` re-throws the previous error without touching the
store.

| Option | Default | |
|---|---|---|
| `keys` | — | **Required.** `{ [storeKey]: envVarName }` |
| `label` | `process.env.APP_CONFIG_LABEL` | Throws if neither is set |
| `endpoint` | `process.env.APP_CONFIG_ENDPOINT` | |
| `connectionString` | `process.env.APP_CONFIG_CONNECTION_STRING` | Takes precedence when set |
| `credential` | `new DefaultAzureCredential()` | |
| `timeoutMs` | `15_000` | Provider startup timeout |
| `retryFloorMs` | `30_000` | Minimum gap between attempts after a failure |
| `localOverridesWin` | `process.env.NODE_ENV === 'development'` | |
| `logger` | `console` | |

Returns `{ label, applied, kept }` — which variables were written and which were left alone.
Throws `ConfigLoadError` if the store cannot be read, and a plain `Error` naming every key that
was absent or empty at that label.

### `hydrateWithBackoff(options, backoff?): Promise<HydrationResult>`

Calls `hydrate` until it succeeds. `backoff` is `{ initialMs = 5_000, maxMs = 600_000, onError }`.
Never returns a rejection — it retries forever, by design. **Long-lived processes only.**

### `ConfigLoadError`

`message` names what failed; `cause` is the provider's error; `detail` is the unwrapped
underlying reason, which is the part the provider hides.

### `resetHydration()`

Clears the memoised result. For tests.

## Development

```bash
make install        # both languages
make test
make build-ts
make publish-ts
```

```
azure-app-config/
├── Typescript/
│   ├── src/index.ts
│   ├── test/
│   ├── package.json
│   └── README.md
├── Python/                  # to follow
├── Makefile
└── README.md
```

Consumers take it from a tarball until `1.0.0` is published:

```bash
cd Typescript && npm pack
cd ../../your-app && npm install ../azure-app-config/Typescript/actvalue-azure-app-config-0.1.0.tgz
```

## License

MIT
