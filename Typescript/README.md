# @actvalue/azure-app-config

Hydrate `process.env` from **Azure App Configuration**, with the failure handling that platform
actually needs.

> **Pre-1.0.** A minor version may break things until `1.0.0`; the repository's `CHANGELOG.md`
> says what, and which workarounds each release lets you delete. A Python half,
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
| `WEBSITE_INSTANCE_ID` | Injected by App Service and Azure Functions. Its absence means a developer machine, where precedence inverts | set by the platform |

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

### Azure Functions: four things the handler shape needs

**An `app.hook.appStart()` hook is an early start, never the guarantee.** On the v4 Node worker,
`startApp()` loads every entry-point file first — running all module-scope code — then runs the
`appStart` hooks, and awaits them before it answers `WorkerInitRequest`. A hook runs after every
import and blocks worker initialisation, so never throw from one and never await long work in one.

```ts
app.hook.appStart(() => {
  void hydrate({ keys: KEYS }).catch(() => {});   // an early start; handlers still await hydrate()
});
```

**Inside the retry floor, wait — never a bare rethrow.** After a failed attempt, every call for
`retryFloorMs` rejects with a `ConfigFloorError` and sends nothing to the store. Rethrowing it
abandons the message; Service Bus redelivers at once, each redelivery fails within milliseconds,
`maxDeliveryCount` is spent in seconds and the message is dead-lettered. Wait `retryAfterMs`, try
once more, then let it fail:

```ts
import { ConfigFloorError, hydrate } from '@actvalue/azure-app-config';

async function configured(): Promise<void> {
  try {
    await hydrate({ keys: KEYS });
  } catch (error) {
    if (!(error instanceof ConfigFloorError)) throw error;
    await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
    await hydrate({ keys: KEYS });    // one more attempt; if it fails, the message is retried
  }
}
```

Waiting exactly `retryAfterMs` is enough: it is the time until the floor opens rounded up, plus a
50 ms margin, so a timer that fires a millisecond early still lands outside the floor. The pattern
assumes `retryFloorMs` sits well inside the invocation's timeout, as the 30 s default does; a
handler cannot wait out a floor longer than its invocation.

**`hydrateWithBackoff` does not belong inside an invocation.** It returns only once the store
answers, which can be long after the invocation's timeout.

**A health endpoint reads status; it does not load.** `hydrationStatus()` never makes a request,
so pings during an outage cost the store nothing:

```ts
import { hydrationStatus } from '@actvalue/azure-app-config';

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async () => {
    const config = hydrationStatus(KEYS);
    return {
      status: config.state === 'failing' ? 503 : 200,
      jsonBody: { config: config.state, loadedAt: config.loadedAt, nextAttemptAt: config.nextAttemptAt },
    };
  },
});
```

`none` and `pending` are normal in a Functions app: nothing is loaded until a handler or the hook
asks.

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
   `retryFloorMs` and rejects with a `ConfigFloorError` instead, which says how long until it
   will.
3. **A failed load says why.** The provider reports a refused read as `All fallback clients
   failed to get configuration settings` wrapped in `The load operation failed`, with no 403
   anywhere — a revoked grant and an unreachable store are indistinguishable. And the reason is
   not buried, it is discarded: the provider catches the underlying `RestError`, fails over, and
   throws a sentence it builds fresh with no `cause`. So this package gives the provider a
   pipeline policy through `clientOptions` and reads the status off the wire as it passes.
   `ConfigLoadError.detail` is what the store actually answered, and costs no extra request.
4. **An explicit key map, never a prefix.** Every Key Vault reference the provider loads, it also
   resolves. A selector like `shared:*` therefore tries to resolve secrets your application holds
   no grant on, and turns another application's credential into your startup failure. One
   selector per key means nothing outside the map is ever fetched, and a comma is refused as firmly
   as `*` — App Configuration reads `a,b` as a filter matching both. Escaped, `\*` and `\,` match
   the literal character and are allowed in a key. Values must be strings: a JSON
   content type comes back parsed, and would otherwise land in the environment as the string
   `[object Object]`.

The startup timeout defaults to **15 s**, not the provider's ~100 s: App Service gives a container
less than 100 s to answer its first ping, so the provider's default means the platform kills you
before you can report the failure.

## Precedence

Deployed, **the store wins** — it overwrites whatever the environment held, so a stale app setting
cannot quietly beat the migrated value. On a developer machine that inverts: a value already in the
environment wins, and because precedence is decided before a key is called missing, a `.env` line
also stands in for a key the store has not got yet.

`localOverridesWin` is that dev-only escape hatch: false in every deployed environment, true
locally. It defaults to "not deployed", read on every attempt from `WEBSITE_INSTANCE_ID`, which App
Service and Azure Functions inject on every instance and `func start`, `node` and test runners never
set. **Other hosts — Container Apps, Kubernetes, a VM — inject nothing this reads: pass
`localOverridesWin: false` there.**

`NODE_ENV` plays no part: in a Functions app it is a per-slot setting that often means something
else. Nor is the label derived from it — images bake `ENV NODE_ENV=production`, so a staging
container would otherwise read the production label.

## API

### `hydrate(options): Promise<HydrationResult>`

| Option | Default | |
|---|---|---|
| `keys` | — | **Required.** `{ [storeKey]: envVarName }` |
| `label` | `APP_CONFIG_LABEL` | Throws if neither is set |
| `endpoint` | `APP_CONFIG_ENDPOINT` | |
| `connectionString` | `APP_CONFIG_CONNECTION_STRING` | Takes precedence when set |
| `credential` | `new DefaultAzureCredential()` | Used for the store and for Key Vault references |
| `timeoutMs` | `15_000` | Provider startup timeout. Finite, above 0, at most 2^31-1 |
| `retryFloorMs` | `DEFAULT_RETRY_FLOOR_MS` (`30_000`) | Minimum gap between attempts after a failure. Finite, 0 or more |
| `localOverridesWin` | `!WEBSITE_INSTANCE_ID`, read on every attempt | Dev-only; other hosts pass `false` |
| `logger` | `console` | Per attempt — see below |

Returns `{ label, applied, kept, loadedAt }` — which variables were written, which were left
alone, and when (milliseconds since the epoch). Throws `ConfigLoadError` if the store cannot be
read, `ConfigInputError` for a call no retry can fix, `ConfigFloorError` inside the retry floor,
and a plain `Error` naming **every** key that was absent, empty, or not a string at that label.
All or nothing: a rejection writes nothing to the environment.

Every failure that reached the store arms the floor, including an input error raised after the
store had answered. Only input rejected before any request leaves it alone.

The logger is **per attempt, not per call**: the call that starts an attempt logs it, and a call
that joins it or is handed the memoised success logs nothing. A per-invocation logger such as a
Functions `InvocationContext` records the success line only in whichever invocation was first.

A success is memoised against the `keys`/`label` pair, not globally — one Functions worker hosts
every function in the app, and a handler declaring its own subset of keys must not be handed
another handler's result and told it succeeded. The retry floor stays global, because the memo is
about correctness and the floor is about the store's request quota.

### `hydrateWithBackoff(options, backoff?): Promise<HydrationResult>`

Calls `hydrate` until it succeeds. `backoff` is `{ initialMs = 5_000, maxMs = 600_000, onError }`.
It retries a failure the store could recover from for as long as that takes — a missing key
included — and rejects immediately with `ConfigInputError` on one it cannot. A `ConfigFloorError`
is not a failure: it sleeps until the floor opens and calls again, without calling `onError`,
logging a failure or widening the delay. After a real failure, `onError` and the default log report
when the next attempt will really happen: the backoff delay, or the time until the floor opens if
that is longer. `initialMs` and `maxMs` must be finite and above 0. Waits longer than `setTimeout`
honours (about 24.8 days) are slept in steps. **Long-lived processes only**, never inside a
function invocation.

The ten-minute cap is not arbitrary: at a one-minute cap a single stuck application spends a Free
store's entire daily quota in about five hours. Nothing waits on a faster poll, because
role-assignment changes take minutes to propagate in both directions. `hydrate`'s retry floor
still applies: a delay shorter than `retryFloorMs` meets a `ConfigFloorError`, and the loop waits
for the floor to open rather than counting it as a failure.

### `hydrationStatus(keys, label?): HydrationStatus`

What `hydrate()` has done for this key map and label, as
`{ state: 'loaded' | 'pending' | 'failing' | 'none', loadedAt?, failedAt?, lastError?, nextAttemptAt? }`.
**Never makes a request and never starts an attempt.** The label resolves as for `hydrate()`.
Throws `ConfigInputError` for no keys, an unescaped `*` or `,` in a key, no label, or a `*` or `,`
in the label. It does not check the endpoint or the timing options, and cannot run the provider's
own pre-request checks, so a status of `none` does not promise `hydrate()` will get as far as a
request.

- `loaded` — memoised success, with `loadedAt`.
- `pending` — an attempt in flight; `failedAt`/`lastError` describe the failure before it, if any.
- `failing` — the last attempt failed; `failedAt`/`lastError` are that attempt's.
- `none` — no attempt yet for this key map and label.

`nextAttemptAt` appears only in the `failing` and `none` states, and there only while the retry
floor is closed, whichever key map armed it. It is when the floor opens, exactly, by the
`retryFloorMs` of the attempt that armed it; a caller passing a different `retryFloorMs` sees a
different window, measured in its own `ConfigFloorError.retryAfterMs`.

### `ConfigFloorError`

The rejection inside the retry floor. Nothing was sent to the store. `retryAfterMs` is how long to
wait: the time until the floor opens by this call's `retryFloorMs`, rounded up, plus a 50 ms
margin. The floor itself is exact. `cause` is the error of the attempt that armed it. Neither
a `ConfigLoadError` — a count of load failures must not count it — nor a `ConfigInputError`, so
`hydrateWithBackoff` waits it out.

### `DEFAULT_RETRY_FLOOR_MS`

`30_000`, the default `retryFloorMs`.

### `ConfigLoadError`

`message` names the store and label that failed and carries the reason; `cause` is the provider's
error unmodified; `detail` is what the store actually answered; `statusCode` is the HTTP status
where one was seen; `observations` lists every distinct failure seen on the wire.

### `ConfigInputError`

A call no retry can fix: an unescaped `*` or `,` in a key, an empty key map, no label, a label with
`*` or `,`, no endpoint, a timing option that is not a usable number, or input the provider
rejected as malformed. `hydrateWithBackoff`
re-throws it instead of looping. `reachedStore` is `false` when it was rejected before a response
came back from the store — nothing spent, floor not armed — and `true` when the provider rejected
something after the store answered, which armed the floor like any other failure. On provider
2.6.0 it is `false` in practice: no store data we found reaches the provider's post-read
input-error path.

### `resetHydration()`

Clears the memoised results, the recorded failures and the retry floor. For tests.

## Tests

```bash
npm test               # unit; the provider's load() is faked at the module boundary
npm run test:integration   # the real provider against a reserved .invalid endpoint
```

The integration run exists for one assertion. `detail` depends on the provider honouring
`clientOptions`, and with `load()` mocked nothing would notice if it stopped — the unit suite
would stay green while a refused read was reported as an unreachable store. It needs no Azure,
no credentials and no egress, but the provider pads a startup failure to five seconds.

## License

MIT
