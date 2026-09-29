# azure-app-config

Hydrate `process.env` / `os.environ` from **Azure App Configuration**, with the failure handling
that platform actually needs.

Available for TypeScript and Python from one repository, on the model of a paired
npm + PyPI package.

```bash
npm install @actvalue/azure-app-config       # TypeScript
pip install actvalue.azure-app-config        # Python — see Python/README.md
```

> **Status: pre-1.0.** The TypeScript half is on npm and runs in production in four consumers:
> three Azure Functions apps and a container web app on App Service. `0.3.0` is the candidate for
> its frozen API. The Python half is written as `0.3.0`, matching it except for `gated()` (see
> [`Python/README.md`](Python/README.md)), and awaits its first consumer. `1.0.0` follows an API
> review across both halves, and republishes the TypeScript half without a behaviour change.
> Until then a minor version may break things;
> [`CHANGELOG.md`](CHANGELOG.md) says what, and which workarounds each release lets you delete.

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
re-attempts on every invocation, and on a capped tier such as Free — where, past the daily quota,
every reader gets HTTP 429 until the meter resets (see [the store's quota](#the-stores-quota)) — a
handful of triggers spend the day's quota in minutes and take down every other consumer of the
store with them. So after a failure `hydrate()` refuses to re-attempt for `retryFloorMs`, and
rejects with a `ConfigFloorError` instead — its own class, so a caller can tell it from a fresh
failure, carrying how long until the floor opens.

## The store's quota

On a capped tier, such as Free, **the quota meter is not the request count.** The store meters
`RequestQuotaUsage`, and a Free-tier store was observed charging it roughly 2 to 4 units per
request, all day: the meter reached 100% with the request metric (`HttpIncomingRequestCount`) at
about 400. Plan for a ceiling nearer 250 to 400 requests a day than the 1,000 a request count
suggests. The meter reset daily between 00:00 and 01:00 UTC; past it, every reader of the store
gets HTTP 429, `Resource utilization has surpassed the assigned quota`, until then.

- **Watch `RequestQuotaUsage`**, not request counts.
- **Count one load per worker start, not per deploy.** Each new worker loads the store again, so
  on a host that starts a new worker every few minutes the load count follows worker churn, not
  traffic. Nothing in-process can bound it: the memo and the floor are per process.
- **On a capped tier, a fail-fast consumer turns quota exhaustion into a hard outage at its next
  worker start.** The new worker cannot load and answers 503 to every request until the meter
  resets, while workers that had already loaded keep serving from what they hold.
- **For more than one consumer with churning workers, use a paid tier.**

The request costs below — per attempt, measured on provider 2.6.0 — are requests. On a capped tier
turn them into quota units before comparing them with anything.

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
140 requests a day, from one process. A failure after a full read returns at once, so at the cap
it settles to one attempt every ~600 s, about 144 a day, and costs about 144 × the number of keys
in requests. Against a Free store's ceiling (above), one process under a persistent 403 spends a
third or more of the day's quota, and a failure after a full read with three keys all of it. At a
one-minute cap it would be over 1,100 attempts a day. Nothing is waiting on a faster poll —
role-assignment changes take minutes to propagate in both directions, so a restored grant is not a
restored application either way.

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
  logger: {
    log: (m: string) => console.warn(m),    // the success line, at warn so host.json keeps it
    error: (m: string) => console.error(m), // a failed attempt, logged once by hydrate()
  },
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
slot where only a health endpoint runs, that line is the only evidence of a load. A failed attempt
goes through `logger.error`, once (see [`hydrate`](#hydrateoptions-promisehydrationresult)), so a
handler does not log it again. The logger is per attempt (below), so whichever call starts an
attempt is the one that logs it: that is why every call here passes `CONFIG`, a retry included.

**An HTTP handler that fails fast: `gated()`.** A handler that reads hydrated values and answers
503 while configuration is not loaded registers through `gated()`, so no handler can forget the
check:

```ts
import { gated } from '@actvalue/azure-app-config';

app.http('orders', {
  methods: ['GET'],
  handler: gated(CONFIG, async (request, context) => {
    return { jsonBody: await listOrders() };    // runs only once the environment is written
  }),
});
```

While `hydrate(CONFIG)` rejects, the wrapper answers `{ status: 503, body: 'Service Unavailable' }`
with a `Retry-After` in whole seconds — the time until the retry floor opens, margin included — and
no `Retry-After` for a `ConfigInputError`, which waiting will not fix. It never rejects because of
configuration, and logs nothing itself: `hydrate()` has already logged the attempt, once. The
handler's own errors reach the host untouched. The response is a plain object that fits
`HttpResponseInit`; the package does not depend on `@azure/functions`.

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

The `catch` only keeps the rejection handled: `hydrate()` has logged the failure itself.

**With no single entry file, give the hook its own entry module.** Under the v4 model `main` can be
a glob, and then every matched module is an entry point. Registering the hook in a module several
handlers import works only because of module caching. Register it in one dedicated entry module
that does nothing else, and keep `CONFIG` in a module with no side effects that every handler
imports:

```ts
// package.json: "main": "dist/src/functions/*.js"

// src/config.ts — no side effects; every handler imports CONFIG from here
export const CONFIG = { keys: KEYS, logger: { log: (m: string) => console.warn(m), error: (m: string) => console.error(m) } };

// src/functions/start.ts — an entry module that registers the hook and nothing else
import { app } from '@azure/functions';
import { hydrate } from '@actvalue/azure-app-config';
import { CONFIG } from '../config';

app.hook.appStart(() => {
  void hydrate(CONFIG).catch(() => {});
});
```

**On a message trigger, wait for the floor — never a bare rethrow.** After a failed attempt, every
call for `retryFloorMs` rejects with a `ConfigFloorError` and sends nothing to the store. A handler
that rethrows abandons the message, Service Bus redelivers it at once, and every redelivery fails
the same way within milliseconds: `maxDeliveryCount` is spent in seconds, and every message a cold
worker receives during a store failure is dead-lettered. Wait as long as `retryAfterMs(error)`
says, make one more attempt, and only then let the invocation fail:

```ts
import { ConfigInputError, hydrate, retryAfterMs } from '@actvalue/azure-app-config';

async function configured(): Promise<void> {
  try {
    await hydrate(CONFIG);
  } catch (error) {
    if (error instanceof ConfigInputError) throw error;   // waiting won't fix it
    const wait = retryAfterMs(error) ?? 0;                // undefined here: the floor is open, go now
    await new Promise(resolve => setTimeout(resolve, wait));
    await hydrate(CONFIG);    // one more attempt; if it fails, the message is retried
  }
}
```

`retryAfterMs(error)` covers both rejections: a `ConfigFloorError`'s own `retryAfterMs`, and for a
fresh failure the time until the floor it armed opens. Its `undefined` means two things — don't
retry, for a `ConfigInputError`; retry now, for anything else, when the floor is already open
(`retryFloorMs: 0`, or a rejection that landed after `resetHydration()`) — so branch on
`instanceof ConfigInputError`, not on `undefined`. Nothing to log here: `hydrate()` logged the
failed attempt, and logs nothing for a floor rejection.

Waiting exactly that long is enough. It is the time until the floor opens rounded up, plus a
50 ms margin, so a timer that fires a millisecond early still lands outside the floor. The pattern
assumes `retryFloorMs` sits well inside the invocation's timeout, as the 30 s default does; a
handler cannot wait out a floor longer than its invocation. Invocations
that wake together and ask for the same keys share one attempt. The default floor,
`DEFAULT_RETRY_FLOOR_MS`, is 30 s — well inside a function's timeout.

**What the floor allows.** For `hydrate()` callers on message triggers the floor is the only
limit: at most one attempt per floor window per process. At the 30 s default that is up to 2,880
attempts a day per process while a failure persists and messages keep arriving — each costing
what its kind of failure costs (above), so on a capped store a 403 alone can use up the day's
quota from one process, and a failure after a full read costs a request per key. A Functions app on
a capped store should weigh that against its instance count, its key count and its worker churn
when it chooses `retryFloorMs`, and read [the store's quota](#the-stores-quota) first.

**`hydrateWithBackoff` does not belong inside an invocation.** It returns only once the store
answers, which can be long after the invocation's own timeout.

**Report configuration health without spending quota.** A health endpoint that calls `hydrate()`
may start a store attempt whenever the floor opens. Pings arriving on several instances then spend
a capped store's daily quota during a persistent outage: within hours for a refused read, and
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
started it — its success line, or its one failure line; a call that joins it in flight, or is
handed the memoised success, logs nothing through its own. So a per-invocation logger such as
`InvocationContext` records those lines in whichever invocation happened to be first. Pass a
process-level logger, such as `CONFIG`'s above, if that matters.

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

The signal is verified on App Service and on Functions Premium/Elastic Premium. **On Flex
Consumption and Linux Consumption it is unverified** — the host may leave it empty, which reads as
a developer machine — so pass `localOverridesWin: false` (`local_overrides_win=False` in Python)
explicitly there until it is confirmed. The success line's mode is how you confirm it:
`(store wins: WEBSITE_INSTANCE_ID present)` from a deployed instance means the signal is there.

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

**Local precedence still reads the store.** With local precedence on and every mapped variable
already set locally, `hydrate()` still makes its request, and fails if the store cannot be read.
That is deliberate: the request also checks that the store exists and that this identity holds the
grants the deployed application will need, which is what a local run is for. A developer needs
`az login` — or, for a run with no identity to borrow, `APP_CONFIG_CONNECTION_STRING`.

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
| `logger` | `console` | Per attempt: the call that starts an attempt logs it. `log` gets the success line, `error` (else `log`) a failure |

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

Concurrent calls for the same `keys`/`label` pair share one attempt, and when it fails **every one
of them receives the identical rejection object**.

**A failure is logged once, by the attempt.** A failed attempt writes one line through
`logger.error` — `logger.log` if the logger has no `error` — of the call that started it:

```
Configuration load failed: <the error's message>
```

The message names the store, the label, the keys or the cause; never a value. Callers that join
the attempt, memo hits and `ConfigFloorError` rejections log nothing, so a caller does not log the
rejection again. A call rejected before any request — no endpoint, no label, a filter character, a
timing option that is not a usable number, or input the provider refuses before its first request
— is not an attempt, but it is logged the same way the first time its message is seen, and not
again until `resetHydration()`. Build one options object and reuse it: every distinct message is
logged, and remembered until the reset. A logger that throws
changes nothing: the call rejects with the same error it would have. Attempts that
`hydrateWithBackoff` starts are reported by its `onError` instead.

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

Its failures are reported by `onError` alone: the default logs `Configuration load failed,
retrying in <seconds>s: <message>` once per failure, and a custom `onError` replaces that line.
The attempts the loop starts do not also log `hydrate()`'s failure line, and neither does the
`ConfigInputError` it rethrows.

### `gated(options, handler)`

Wraps an HTTP handler: `(...args) => Promise<handler's result | ConfigUnavailableResponse>`. Each
call awaits `hydrate(options)`, then calls `handler` with the original arguments and returns its
result; the handler's own errors propagate untouched. When `hydrate()` rejects it returns
`{ status: 503, body: 'Service Unavailable' }`, plus `headers: { 'Retry-After': '<seconds>' }` —
`Math.max(1, Math.ceil(retryAfterMs(error) / 1000))` — whenever `retryAfterMs(error)` gives a wait.
It never rejects because of configuration and logs nothing itself. See the Functions section.

### `retryAfterMs(error): number | undefined`

How long to wait after any rejection from `hydrate()` before calling it again, in milliseconds.
Makes no request.

| `error` | Returns |
|---|---|
| `ConfigFloorError` | Its `retryAfterMs` |
| `ConfigInputError`, whether or not it reached the store | `undefined` — waiting won't fix it |
| Anything else | The time until the armed retry floor opens, by the `retryFloorMs` of the attempt that armed it, rounded up, plus the 50 ms margin; `undefined` if the floor is already open — retry now |

So `undefined` means "don't retry" for a `ConfigInputError` and "retry now" for anything else: tell
them apart with `instanceof ConfigInputError`.

### `ConfigUnavailableResponse`

`{ status: 503; body: string; headers?: Record<string, string> }`, what `gated()` answers.
Structural: it is assignable to an Azure Functions `HttpResponseInit`, without a dependency on
`@azure/functions`.

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

Clears the memoised results, the recorded failures, the retry floor and the set of pre-request
errors already logged. For tests.

**One state per version, shared by both builds.** The package ships an ESM and a CJS build, and a
process can load both. They share one state — one memo, one retry floor — kept on `globalThis`
under a symbol that carries the exact package version, and `resetHydration()` from either clears
it for both. The error classes' brands carry no version, so `instanceof` matches an instance from
either build of any version of the package; the state is shared only by the two builds of one
exact version. Two *different* versions in one process therefore keep separate state: each version
has its own floor.

## Testing a consumer

This section is the TypeScript half's; the Python half's is in
[`Python/README.md`](Python/README.md#testing-a-consumer).

To run your tests against the real package with only the provider's `load()` replaced, make your
test runner process the package itself. For vitest:

```ts
// vitest.config.mts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: { deps: { inline: ['@actvalue/azure-app-config'] } },
  },
});
```

Without it, vitest hands the package to Node untransformed, and `vi.mock` of the provider never
reaches the package's own import of it: your tests would call the real `load()`. Then mock
`load()`, which needs to resolve to an object with a `get(key)`, and reset both the package and
the variables it writes between tests:

```ts
import { beforeEach, it, vi } from 'vitest';
import { load } from '@azure/app-configuration-provider';
import { resetHydration } from '@actvalue/azure-app-config';

vi.mock('@azure/app-configuration-provider', () => ({ load: vi.fn() }));

const KEYS = { 'shared:mongoUrl': 'MONGO_URL' };

beforeEach(() => {
  resetHydration();
  vi.mocked(load).mockReset();
  for (const variable of Object.values(KEYS)) delete process.env[variable];
  process.env.APP_CONFIG_ENDPOINT = 'https://example.invalid';
  process.env.APP_CONFIG_LABEL = 'test';
});

it('serves once configuration is loaded', async () => {
  const values: Record<string, string> = { 'shared:mongoUrl': 'mongodb://example.invalid/app' };
  vi.mocked(load).mockResolvedValue({ get: (key: string) => values[key] } as never);
  // … call the handler
});
```

**Re-importing the package no longer gives fresh state; call `resetHydration()` in `beforeEach`.**
The state is shared across module instances (above), so `vi.resetModules()`,
`jest.resetModules()` or `jest.isolateModules()` followed by a fresh import hands back the same
memo and floor. It does not leak between test files: Jest, and vitest with its default isolation,
give each file its own global scope.

**Clear the mapped variables too.** A test runner sets no `WEBSITE_INSTANCE_ID`, so local
precedence is on, and a value one test's `hydrate()` wrote into `process.env` would beat the next
test's fake store — delete them (or snapshot and restore `process.env`) beside `resetHydration()`.

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
├── Python/
│   ├── src/azure_app_config/
│   ├── tests/
│   ├── pyproject.toml
│   └── README.md
├── CHANGELOG.md
├── Makefile
└── README.md
```

## License

MIT
