# azure-app-config

Hydrate `process.env` / `os.environ` from **Azure App Configuration**, with the failure handling
that platform actually needs.

Available for TypeScript and Python from one repository, on the model of a paired
npm + PyPI package.

```bash
npm install @actvalue/azure-app-config       # TypeScript
pip install actvalue.azure-app-config        # Python — not yet written
```

> **Status: pre-1.0.** The TypeScript half is on npm and runs in production in two consumers, both
> on `0.2.0`: an Azure Functions app and a container web app on App Service. `1.0.0` is published
> once both run on it. Until then a minor version may break things;
> [`CHANGELOG.md`](CHANGELOG.md) says what, and which workarounds each release lets you delete.
> The Python half follows.

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
| `WEBSITE_INSTANCE_ID` | Injected by App Service and Azure Functions. Its absence means a developer machine, where precedence inverts — see below | set by the platform |

## Why not just call the provider

`@azure/app-configuration-provider` loads configuration. This package is the thin layer around
it that four things went wrong in, each of which was invisible from reading the provider's
documentation and cost a production incident or a near miss to find.

**A failed load does not say why — and unwrapping the error cannot tell you.** A revoked role
assignment and an unreachable store are indistinguishable in the provider's output: you get
`All fallback clients failed to get configuration settings`, then `The load operation failed`.
No 403, anywhere. The reason is not buried, it is *gone*: the provider catches the underlying
`RestError`, moves to the next client, and on running out throws a sentence it constructs fresh,
with no `cause` attached. So this package hands the provider a pipeline policy through
`clientOptions` and reads the status off the wire as it goes past. `ConfigLoadError.detail` is
what the store actually answered, at the cost of no extra request.

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
re-attempt for `retryFloorMs`, and rejects with a `ConfigFloorError` instead — its own class, so a
caller can tell it from a fresh failure, carrying how long until the floor opens.

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

The ten-minute cap is not arbitrary, but it bounds **attempts, not requests**: what an attempt
costs depends on how it fails. Measured on provider 2.6.0:

- a refused read (403) costs about one request, because the provider backs its client off after
  the 403;
- an unreachable store costs none;
- a failure after a complete read — a missing key, say — costs one request per key, as a success
  does.

Under a persistent 403 the default backoff starts attempts at about 0, 45, 90, 135, 190, 285, 460
and 795 s, then one every ~615 s (the cap plus the startup timeout): about 140 attempts and about
140 requests a day, 14% of a Free store's 1,000. A failure after a full read returns at once, so
at the cap it settles to one attempt every ~600 s, about 144 a day, and costs about 144 × the
number of keys: past the whole Free quota from 7 keys on, from one process. At a one-minute cap
it would be over 1,100 attempts a day, past the quota even at one request each. Nothing is
waiting on a faster poll — role-assignment changes take minutes to propagate in both directions,
so a restored grant is not a restored application either way.

The provider's own `Failed to load … Retrying in 5000 ms` warnings, about three per attempt, are
its internal loop inside the startup timeout, not this retry schedule.

### Azure Functions — and anything else without a bootstrap phase

The host builds a trigger's connection before user code runs, so trigger connections stay app
settings. Everything else is hydrated on first use, awaited at the top of each function. Give every
call the same options object, with a warn-level logger (why is below):

```ts
import { hydrate } from '@actvalue/azure-app-config';

const CONFIG = {
  keys: KEYS,
  logger: { log: (m: string) => console.warn(m), error: (m: string) => console.error(m) },
};

app.serviceBusQueue('Rollup', {
  handler: async (message, context) => {
    await hydrate(CONFIG);    // free after the first success
    await processMessage(message);
  },
});
```

Module-scope initialisation has to become lazy for this to work — a client constructed at import
time reads the environment before hydration can fill it. That is a change in your application,
not something a package can do for you.

**Log the success line at warn level, or `host.json` may drop it.** The success line goes through
`logger.log`, which with the default logger is `console.log`, at Information level. A typical
`host.json` sets `logLevel.default` to `Warning` and raises only `Function` to `Information`, so a
line from an attempt started outside an invocation — by an `appStart` hook — is filtered out. On a
slot where only a health endpoint runs, that line is the only evidence of a load. The logger is per
attempt (below), so whichever call starts an attempt is the one that logs it: that is why every
call here passes `CONFIG`, a retry included.

**An `app.hook.appStart()` hook is an early start, never the guarantee.** On the v4 Node worker,
`startApp()` first loads every entry-point file — which runs all module-scope code — and only then
runs the `appStart` hooks, and it awaits them before it answers the host's `WorkerInitRequest`. So
a hook runs after every import, and blocks worker initialisation while it runs. Never throw from
one and never await long work in one: start hydration and let it go. Lazy initialisation is the
guarantee.

```ts
app.hook.appStart(() => {
  void hydrate(CONFIG).catch(() => {});   // an early start; handlers still await hydrate()
});
```

**Inside the retry floor, wait — never a bare rethrow.** After a failed attempt, every call for
`retryFloorMs` rejects with a `ConfigFloorError` and sends nothing to the store. A handler that
rethrows it abandons the message, Service Bus redelivers it at once, and every redelivery fails the
same way within milliseconds: `maxDeliveryCount` is spent in seconds, and every message a cold
worker receives during a store failure is dead-lettered. Wait `retryAfterMs`, make one more
attempt, and only then let the invocation fail:

```ts
import { ConfigFloorError, hydrate } from '@actvalue/azure-app-config';

async function configured(): Promise<void> {
  try {
    await hydrate(CONFIG);
  } catch (error) {
    if (!(error instanceof ConfigFloorError)) throw error;
    await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
    await hydrate(CONFIG);    // one more attempt; if it fails, the message is retried
  }
}
```

Waiting exactly `retryAfterMs` is enough. It is the time until the floor opens rounded up, plus a
50 ms margin, so a timer that fires a millisecond early still lands outside the floor. The pattern
assumes `retryFloorMs` sits well inside the invocation's timeout, as the 30 s default does; a
handler cannot wait out a floor longer than its invocation. Invocations
that wake together and ask for the same keys share one attempt. The default floor,
`DEFAULT_RETRY_FLOOR_MS`, is 30 s — well inside a function's timeout.

**What the floor allows.** For `hydrate()` callers on message triggers the floor is the only
limit: at most one attempt per floor window per process. At the 30 s default that is up to 2,880
attempts a day per process while a failure persists and messages keep arriving — each costing
what its kind of failure costs (above), so a 403 alone can pass a Free store's 1,000 from one
process, and a failure after a full read costs a request per key. A Functions app on a Free store
should weigh that against its instance count, and its key count, when it chooses `retryFloorMs`.

**`hydrateWithBackoff` does not belong inside an invocation.** It returns only once the store
answers, which can be long after the invocation's own timeout.

**Report configuration health without spending quota.** A health endpoint that calls `hydrate()`
may start a store attempt whenever the floor opens. Pings arriving on several instances then spend
a Free store's daily requests during a persistent outage: within hours for a refused read, and
faster for a failure after a full read, which costs one request per key. `hydrationStatus()` reads
what `hydrate()` has done and never makes a request:

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

`none` and `pending` are normal here: nothing is loaded until a handler or the hook asks.

**The logger is per attempt, not per call.** An attempt logs through the `logger` of the call that
started it; a call that joins it in flight, or is handed the memoised success, logs nothing through
its own. So a per-invocation logger such as `InvocationContext` records the success line in
whichever invocation happened to be first. Pass a process-level logger, such as `CONFIG`'s above,
if that matters.

## Precedence: who wins when a variable is already set

Deployed, **the store wins** — it overwrites whatever the environment held, so a stale app setting
or a leftover `.env` line cannot quietly beat the migrated value.

On a developer machine that inverts: a value already in the environment wins, so a `.env` line can
point one variable at a local database without reaching into the store. Precedence is decided
before a key is called missing, so a `.env` line also stands in for a key that is not in the store
yet — which is the point of reaching for it in the first place.

`localOverridesWin` is that escape hatch, and it is for local development only: false in every
deployed environment, true locally. Its default is "not deployed", read on every attempt from
`WEBSITE_INSTANCE_ID`, which App Service and Azure Functions inject on every instance and which
`func start`, a plain `node` run and a test runner never set. **Any other host — Container Apps,
Kubernetes, a VM — injects nothing this reads, so pass `localOverridesWin: false` there**, or the
local environment beats the store.

The success line ends with which side won and why, on every successful attempt, whether or not
anything was kept — so a missing signal shows up in the first log line, not as a stale value
winning:

```
Configuration loaded from App Configuration, label prod: MONGO_URL, HTTP_PORT (store wins: WEBSITE_INSTANCE_ID present)
Configuration loaded from App Configuration, label prod: MONGO_URL, HTTP_PORT (local wins: WEBSITE_INSTANCE_ID absent)
Configuration loaded from App Configuration, label prod: MONGO_URL, HTTP_PORT (store wins: localOverridesWin option false)
Configuration loaded from App Configuration, label prod: MONGO_URL, HTTP_PORT (local wins: localOverridesWin option true)
```

With the option passed, the line states the decision it produced: a JavaScript caller passing the
string `"false"`, which is truthy, gets local-wins and `localOverridesWin option true`. `null` is
treated as not passed. The line names variables, never values. When something was kept, a second
line, `Kept from the local environment: …`, names those.

`NODE_ENV` plays no part. In a Functions app it is an ordinary per-slot app setting that often
means something else, and a staging slot carrying `development` would let leftover settings beat
the store without a warning, so the staging run would prove nothing. For the same reason the label
is its own variable and never derived from `NODE_ENV`: images bake `ENV NODE_ENV=production`, so a
staging container would otherwise read the production label and load production databases.

## Why an explicit key map and not a prefix filter

`keys` is a map, not a wildcard, for two reasons. The store key and the variable name are
generally not the same string. And more seriously: **every Key Vault reference the provider
loads, it also resolves.** A selector like `shared:*` therefore tries to resolve secrets your
application holds no grant on, and turns another application's credential into your startup
failure. One selector per key means nothing outside the map is ever fetched. A comma is refused
as firmly as `*`: App Configuration reads `a,b` as a filter matching both keys. Escaped, `\*` and
`\,` match the literal character, and are allowed in a key. The label gets the same check,
escapes included — the provider refuses any `*` or `,` in a label — because exactly one label is
read.

The values must be strings. A key-value with a JSON content type comes back from the provider
parsed, and the provider's `get<string>()` does not prevent that — so an object would otherwise
land in the environment as the string `[object Object]`, reported as applied. Those are refused
by name alongside the absent ones.

## API

### `hydrate(options): Promise<HydrationResult>`

One attempt. Resolves once and is memoised on success; on failure the rejection is not cached,
but a further call inside `retryFloorMs` rejects with `ConfigFloorError` without touching the
store.

| Option | Default | |
|---|---|---|
| `keys` | — | **Required.** `{ [storeKey]: envVarName }` |
| `label` | `process.env.APP_CONFIG_LABEL` | Throws if neither is set |
| `endpoint` | `process.env.APP_CONFIG_ENDPOINT` | |
| `connectionString` | `process.env.APP_CONFIG_CONNECTION_STRING` | Takes precedence when set |
| `credential` | `new DefaultAzureCredential()` | |
| `timeoutMs` | `15_000` | Provider startup timeout. Finite, above 0, at most 2^31-1 |
| `retryFloorMs` | `DEFAULT_RETRY_FLOOR_MS` (`30_000`) | Minimum gap between attempts after a failure. Finite, 0 or more — NaN would switch it off |
| `localOverridesWin` | `!process.env.WEBSITE_INSTANCE_ID`, read on every attempt | Dev-only. Hosts other than App Service and Functions pass `false` |
| `logger` | `console` | Per attempt: the call that starts an attempt logs it |

Returns `{ label, applied, kept, loadedAt }` — which variables were written, which were left
alone, and when (milliseconds since the epoch). Throws `ConfigLoadError` if the store cannot be
read, `ConfigInputError` for a call no retry can fix, `ConfigFloorError` inside the retry floor,
and a plain `Error` naming every key that was absent, empty, or not a string at that label.

All or nothing: every key is checked before anything is written, so a rejection leaves the
environment exactly as it was.

Every failure that reached the store arms the floor — a refused or failed read, a missing key,
and an input error raised after the store had answered. Only input rejected before any request
leaves it alone.

A success is memoised against the `keys`/`label` pair it was made with, not globally: one worker
process hosting several functions must not hand the second one the first one's result.

### `hydrateWithBackoff(options, backoff?): Promise<HydrationResult>`

Calls `hydrate` until it succeeds. `backoff` is `{ initialMs = 5_000, maxMs = 600_000, onError }`.
It retries a failure the store could recover from for as long as that takes, and rejects
immediately with `ConfigInputError` on one it cannot — a wildcard or a comma in a key, a missing
label, input the provider rejects as malformed. A container looping forever on a typo looks exactly
like one waiting out an outage, and only one of those is worth waiting for. A missing key is
retried: adding it to the store heals the process.

A `ConfigFloorError` is not a failed attempt, and the loop does not treat it as one: it sleeps
until the floor opens and calls again, without calling `onError`, logging a failure, or widening
the delay. So the delay doubles once per real failure, and real attempts land on the floor's
schedule. After a real failure, `onError`'s `nextDelayMs` and the default "retrying in" log say
when the next attempt will really happen: the backoff delay, or the time until the floor opens if
that is longer. `initialMs` and `maxMs` must be finite and above 0. A wait longer than
`setTimeout` honours (about 24.8 days) is slept in steps, so a huge floor cannot spin the loop. **Long-lived processes only** — never inside a function invocation.

### `hydrationStatus(keys, label?): HydrationStatus`

What `hydrate()` has done for this key map and label. **Never makes a request and never starts an
attempt**, in any state, so a health endpoint can call it on every ping. The label resolves as it
does for `hydrate()`. Throws `ConfigInputError` for a call `hydrate()` would reject before any
request: no keys, an unescaped `*` or `,` in a key, no label, or a `*` or `,` in the label. It
does not check the endpoint or the timing options, and cannot run the provider's own pre-request
checks.

Returns `{ state, loadedAt?, failedAt?, lastError?, nextAttemptAt? }`, timestamps in milliseconds
since the epoch:

| `state` | Meaning |
|---|---|
| `loaded` | A success is memoised. `loadedAt` says when |
| `pending` | An attempt is in flight. `failedAt`/`lastError` describe the failure before it, if any |
| `failing` | The last attempt failed. `failedAt`/`lastError` are that attempt's, never a floor rejection |
| `none` | No attempt yet for this key map and label |

`nextAttemptAt` appears only in the `failing` and `none` states, and there only while the retry
floor is closed, whichever key map armed it. It is when the floor opens, exactly, by the
`retryFloorMs` of the attempt that armed it. `hydrate()` enforces each caller's own
`retryFloorMs`, so a caller passing a different value sees a different window — its
`ConfigFloorError.retryAfterMs` is measured with its own. Pass one value everywhere, or none, and
the two agree.

### `ConfigFloorError`

What `hydrate()` rejects with inside the retry floor. Nothing was sent to the store. `retryAfterMs`
is how long to wait: the time until the floor opens by this call's `retryFloorMs`, rounded up, plus
a 50 ms margin, so a timer that fires slightly early still clears it. The floor itself is enforced
exactly. `cause` is the error of the attempt that armed it. Deliberately neither a `ConfigLoadError` — nothing was attempted, and a count of load failures
must not count it — nor a `ConfigInputError`, so `hydrateWithBackoff` waits it out.

### `DEFAULT_RETRY_FLOOR_MS`

`30_000`. The default `retryFloorMs`, exported so a caller can line up with it.

### `ConfigLoadError`

`message` names the store and label that failed and carries the reason; `cause` is the provider's
error, unmodified; `detail` is what the store actually answered; `statusCode` is the HTTP status
where one was seen; `observations` is every distinct failure seen on the wire during the attempt.

### `ConfigInputError`

A call no retry can fix: an unescaped `*` or `,` in a key, an empty key map, no label, a label
with `*` or `,`, no endpoint, a timing option that is not a usable number, or input the provider
rejected as malformed. `hydrateWithBackoff`
re-throws it rather than looping. `reachedStore` says whether a response had already come back from
the store: `false` means rejected before that, which spent nothing and leaves the retry floor
alone; `true` means the provider rejected something after the store answered, and that attempt
armed the floor like any other. On provider 2.6.0 it is `false` in practice — no store data we
found reaches the provider's post-read input-error path — so it is there for a provider that does.

### `resetHydration()`

Clears the memoised results, the recorded failures and the retry floor. For tests.

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
├── CHANGELOG.md
├── Makefile
└── README.md
```

## License

MIT
