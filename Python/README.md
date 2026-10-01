# actvalue.azure-app-config

Hydrate `os.environ` from **Azure App Configuration**, with the failure handling that platform
actually needs. The Python half of [`@actvalue/azure-app-config`](https://github.com/pmosconi/azure-app-config/blob/main/README.md): the same option
names in snake_case, the same defaults, the same error semantics and the same four invariants.

```bash
pip install actvalue.azure-app-config
```

```python
from azure_app_config import HydrateOptions, hydrate

CONFIG = HydrateOptions(
    keys={
        "shared:mongoUrl": "MONGO_URL",
        "shared:serviceBus": "SERVICE_BUS_CONNECTION",
        "myapp:httpPort": "HTTP_PORT",
    },
)

hydrate(CONFIG)
```

> **Status: `1.0.0`. The API is frozen**, together with the TypeScript half's: additions are minor
> releases, and a change to any of the four invariants, or to a signature, is a major. It matches
> the TypeScript `1.0.0` release except where [Differences between the halves](#differences-between-the-halves)
> says otherwise — `gated()` is not here yet. Python 3.11 or later. See the [root README](https://github.com/pmosconi/azure-app-config/blob/main/README.md) for why each behaviour exists
> and [`CHANGELOG.md`](https://github.com/pmosconi/azure-app-config/blob/main/CHANGELOG.md) for what changed.

Everything else comes from the environment by default:

| Variable | Meaning | Required |
|---|---|---|
| `APP_CONFIG_ENDPOINT` | Store endpoint, read with `DefaultAzureCredential` | yes, unless a connection string is set |
| `APP_CONFIG_LABEL` | The one label to read (`prod`, `staging`, …) | yes |
| `APP_CONFIG_CONNECTION_STRING` | Access-key fallback for runs with no identity to borrow | no |
| `WEBSITE_INSTANCE_ID` | Injected by App Service and Azure Functions. Its absence means a developer machine, where precedence inverts. Verified on App Service and Functions Premium/Elastic; **unverified on Flex Consumption and Linux Consumption**, see [Precedence](#precedence) | set by the platform |

## What it does, in one paragraph

`hydrate()` makes **one attempt**: it loads exactly the keys in the map, at exactly one label,
resolves any Key Vault references with your identity, and writes the values into `os.environ`,
all or nothing. A success is memoised. A failure is not, but for `retry_floor_ms` (30 s) after
one, further calls raise `ConfigFloorError` without touching the store, so a stream of messages
cannot spend a capped store's daily quota. A failure says why: `ConfigLoadError.detail` is what
the store, the network or the credential actually did. Read [the store's quota](https://github.com/pmosconi/azure-app-config/blob/main/README.md#the-stores-quota)
before choosing a tier.

## Long-lived processes

Bind the port first, answer unhealthy, then hydrate with backoff:

```python
from azure_app_config import hydrate_with_backoff

ready = False
start_healthcheck(lambda: ready)      # listening before anything can fail

hydrate_with_backoff(CONFIG)          # 5 s → 10 s → … → 600 s, until it succeeds
ready = True
main()
```

It sleeps, and returns only once the store answers, so it belongs in a process's startup and
never inside a function invocation. It re-raises every `ConfigInputError` at once — a typo is
not an outage. There is no async variant: an asyncio process that wants one runs
`await asyncio.to_thread(hydrate_with_backoff, CONFIG)`, knowing that cancelling the task does not
stop the thread.

## Azure Functions

The host builds a trigger's connection before your code runs, so trigger connections stay app
settings. Everything else is hydrated on first use, at the top of each function. Build one
options object in a module with no side effects and pass it to every call:

```python
# config.py
import logging
from types import SimpleNamespace

from azure_app_config import HydrateOptions

log = logging.getLogger("myapp")

CONFIG = HydrateOptions(
    keys=KEYS,
    # The success line at warning, so a host that keeps only warnings still shows it; a failed
    # attempt through error, logged once by hydrate() itself.
    logger=SimpleNamespace(info=log.warning, error=log.error),
)
```

Module-level clients have to become lazy: a client built at import reads the environment before
hydration can fill it.

**The logger is per attempt, not per call.** The call that starts an attempt logs it — the
success line, or one failure line; calls that join it, and memo hits, log nothing. That is why
every call passes `CONFIG`. The default logger is `logging.getLogger("azure_app_config")`, outside
the `azure` logger tree on purpose: consumers commonly silence `azure` below WARNING. From an async
handler, `hydrate_async` writes the line on the event loop after the `await`, not on the worker
thread that ran the attempt: the Python worker drops a record written on a pool thread rather than
attribute it to the invocation.

**A logger must not start a load.** A logging handler may call `hydrate()` or
`hydration_status()` for the attempt it is logging: the lines are written once the attempt is
settled, so it gets the memoised result or a `ConfigFloorError`. Anything else from a handler — a
different key map, or a call after `reset_hydration()` — is a whole new attempt on the logging
thread, and since `1.0.0` the lines of a `hydrate_async` call are written on the event loop: a
sync `hydrate()` there blocks the loop, and every other task on it, for up to `timeout_ms`. The default credential is created before an
attempt starts and outside the package's lock, so a handler on `azure.identity`, which its
constructor logs to on the calling thread, may call in too; a `hydrate()` from there raises
`ConfigLoadError` ("creating the default credential"), unlogged, and nothing is attempted for it.
Not from a handler on the provider's and SDK clients' loggers (`azure.appconfiguration.provider`
and the like), though: those run on the load thread, and such a call waits for the attempt it is
part of until `timeout_ms` fires.

### On a message trigger, wait for the floor

After a failed attempt, every call for `retry_floor_ms` raises `ConfigFloorError` and sends
nothing. A handler that re-raises abandons the message, Service Bus redelivers it at once, and
every redelivery fails the same way within milliseconds: `maxDeliveryCount` is spent in seconds
and the message is dead-lettered. Wait as long as `retry_after_ms(error)` says, make one more
attempt, and only then let the invocation fail:

```python
import time

import azure.functions as func

from azure_app_config import ConfigInputError, hydrate, retry_after_ms
from config import CONFIG

app = func.FunctionApp()


def configured() -> None:
    try:
        hydrate(CONFIG)
    except ConfigInputError:
        raise                                   # waiting won't fix it
    except Exception as error:
        wait = retry_after_ms(error) or 0       # None here: the floor is open, go now
        time.sleep(wait / 1000)
        hydrate(CONFIG)                         # one more attempt; if it fails, the message is retried


@app.service_bus_queue_trigger(arg_name="message", queue_name="rollup", connection="SERVICE_BUS_CONNECTION")
def rollup(message: func.ServiceBusMessage) -> None:
    configured()
    process(message)
```

`retry_after_ms(error)` covers both: a `ConfigFloorError`'s own `retry_after_ms`, and for a fresh
failure the time until the floor it armed opens — rounded up, plus a 50 ms margin, so a timer
that fires a little early still lands outside the floor. Its `None` means two things — don't
retry, for a `ConfigInputError`; retry now, for anything else — so branch on
`isinstance(error, ConfigInputError)`, never on `None`. Nothing to log: `hydrate()` logged the
failed attempt, and logs nothing for a floor rejection. The pattern assumes `retry_floor_ms` sits
well inside the invocation's timeout, as the 30 s default does.

An **async handler** does the same through `hydrate_async`, which runs the attempt on a worker
thread, shares `hydrate`'s memo, floor and in-flight attempt, and writes its line on the event
loop:

```python
import asyncio

from azure_app_config import ConfigInputError, hydrate_async, retry_after_ms


async def configured_async() -> None:
    try:
        await hydrate_async(CONFIG)
    except ConfigInputError:
        raise
    except Exception as error:
        await asyncio.sleep((retry_after_ms(error) or 0) / 1000)
        await hydrate_async(CONFIG)
```

Callers that arrive while an attempt is in flight — from any thread, sync or async — join it: one
request, and on failure every one of them receives the identical exception object.

### Timers

Call `configured()` (or `hydrate(CONFIG)`) at the top of the function. A failed run fails; the
next schedule tries again, and the 30 s floor is far shorter than a typical schedule.

### Starting early at import

A `hydrate(CONFIG)` at module top is an early start, never the guarantee — handlers still call it.
Never let it raise at import, which fails the worker's indexing:

```python
try:
    hydrate(CONFIG)
except Exception:
    pass            # hydrate() logged it; handlers will call again
```

Import blocks for up to `timeout_ms` while it runs.

### Health without spending quota

A health endpoint that calls `hydrate()` starts a store attempt whenever the floor opens, and
pings from several instances spend a capped store's quota during an outage. `hydration_status()`
reads what `hydrate()` has done and never makes a request:

```python
import json

from azure_app_config import hydration_status


@app.route(route="health", auth_level=func.AuthLevel.ANONYMOUS)
def health(req: func.HttpRequest) -> func.HttpResponse:
    config = hydration_status(KEYS)
    return func.HttpResponse(
        json.dumps({"config": config.state, "loadedAt": config.loaded_at, "nextAttemptAt": config.next_attempt_at}),
        status_code=503 if config.state == "failing" else 200,
        mimetype="application/json",
    )
```

`none` and `pending` are normal: nothing is loaded until a handler asks.

## Precedence

Deployed, **the store wins**. On a developer machine a value already in the environment wins, so
a `.env` line can point one variable somewhere local. `local_overrides_win` defaults to "not
deployed", read on every attempt from `WEBSITE_INSTANCE_ID`, which App Service and Functions
inject and `func start`, `python` and pytest never set. **Any other host — Container Apps,
Kubernetes, a VM — must pass `local_overrides_win=False`.** Local precedence still reads the
store: the request also checks that the store exists and that the identity holds its grants.

The signal is verified on App Service and on Functions Premium/Elastic Premium. **On Flex
Consumption and Linux Consumption it is unverified** — the host may leave it empty, which reads as
a developer machine — so pass `local_overrides_win=False` explicitly there until it is confirmed.
The success line's mode is how you confirm it: `(store wins: WEBSITE_INSTANCE_ID present)` from a
deployed instance means the signal is there.

The success line says which side won and why:

```
Configuration loaded from App Configuration, label prod: MONGO_URL, HTTP_PORT (store wins: WEBSITE_INSTANCE_ID present)
Configuration loaded from App Configuration, label prod: MONGO_URL, HTTP_PORT (local wins: WEBSITE_INSTANCE_ID absent)
Configuration loaded from App Configuration, label prod: MONGO_URL, HTTP_PORT (store wins: local_overrides_win option false)
Configuration loaded from App Configuration, label prod: MONGO_URL, HTTP_PORT (local wins: local_overrides_win option true)
```

The option is read by truthiness, so the string `"false"` gives `local wins: … option true`;
`None` is not passed. An empty `WEBSITE_INSTANCE_ID` is absent. Names only, never values; when
something was kept, a second line, `Kept from the local environment: …`, names it.

## API

### `hydrate(options: HydrateOptions) -> HydrationResult`

One attempt, memoised on success against the key map and label. Raises `ConfigLoadError` when
the store cannot be read, `ConfigInputError` for a call no retry can fix, `ConfigFloorError`
inside the retry floor, and a `LookupError` naming every key that was absent, empty, not a string
or holding NUL at that label. All or nothing: a raise leaves `os.environ` as it was.

Every failure that reached the store arms the floor — a refused or failed read, a missing key, an
input error raised after the store answered. Input refused before any request leaves it alone.

A failed attempt is logged once, through the `error` method of the starting call's logger
(`info` if it has none):

```
Configuration load failed: <the error's message>
```

Joiners, memo hits and floor rejections log nothing. A call refused before any request is logged
the first time its message is seen, and not again until `reset_hydration()`. A logger that raises
changes nothing; a coroutine a logger returns is closed unawaited.

| `HydrateOptions` field | Default | |
|---|---|---|
| `keys` | — | **Required.** `{store_key: variable_name}`. No unescaped `*` or `,`; `\*` and `\,` match the literal character. No empty key, and no variable name that is empty or contains `=` or NUL: refused before any request |
| `label` | `APP_CONFIG_LABEL` | Refused if neither is set, or if it holds `*` or `,` |
| `endpoint` | `APP_CONFIG_ENDPOINT` | |
| `connection_string` | `APP_CONFIG_CONNECTION_STRING` | Takes precedence when set. Never in the `repr` |
| `credential` | one `DefaultAzureCredential()` per process | Used for the store and for Key Vault references. The default one is created on first need, reused by every attempt (its token cache survives a failure), and dropped — not closed — by `reset_hydration()`; yours is never touched |
| `timeout_ms` | `15_000` | Bound on one attempt. Finite, above 0, at most 2**31 - 1 |
| `retry_floor_ms` | `DEFAULT_RETRY_FLOOR_MS` (`30_000`) | Finite, 0 or more — NaN would switch it off |
| `local_overrides_win` | `not WEBSITE_INSTANCE_ID`, read every attempt | Dev-only. Other hosts pass `False` |
| `logger` | `logging.getLogger("azure_app_config")` | `info` gets the success line, `error` (else `info`) a failure |

`HydrationResult` is `label`, `applied`, `kept` (tuples of variable names) and `loaded_at`
(milliseconds since the epoch).

**The bound.** `hydrate()` returns within `timeout_ms`. The provider checks its own startup
timeout only between passes, so a request that hangs would hold it far longer; the load therefore
runs on a daemon thread, and when the bound fires the call raises and the thread is abandoned —
anything it later returns is closed, and it never writes the environment, which only the calling
thread does. The provider holds a failure until five seconds after it started; below 5 000 ms such
a failure arrives after the bound and is reported from the wire evidence instead.

**What ends an abandoned thread, and what does not.** Every store client and every Key Vault
client the provider builds gets `retry_total=0` and connection and read timeouts of twice
`timeout_ms` (call it 2T):

- No SDK retries, and so no `Retry-After` sleep — azure-core sleeps whatever the header says,
  uncapped, before it re-checks its own timeout, so the only way to bound it is not to retry. The
  caller's floor and backoff do the retrying; the price is below.
- Each connection attempt is bounded at 2T, and each socket read at 2T of silence.
- The provider's own loop sends nothing after a failed pass (it backs its only client off for
  30 s) and raises once its next 5 s delay would overrun `timeout_ms`.

Requests inside one pass run one after another: one list request per selector (more if the
result is paged), then, per Key Vault reference, up to two vault requests (the challenge, then the
read). So the worst case, if every request answers just inside its limits, is about
(selectors + pages + 2 × references) × 4T after the load started. Not bounded by this package:
the credential's own token requests, which have their own timeouts and retries; a server that
trickles bytes more often than every 2T, since the read timeout is per read; the system resolver;
and the provider's DNS replica discovery for real `*.azconfig.io` endpoints, a few lookups of up
to about ten seconds each before the first request.

### `hydrate_async(options) -> HydrationResult` (coroutine)

The attempt runs on a worker thread via `asyncio.to_thread`, with the same memo, floor and
in-flight attempt as `hydrate()`; its success or failure line is written on the event loop, after
the `await`, under the same rules (one per attempt, by the call that started it). Cancelling the
task does not stop an attempt already running: it completes, its outcome is kept, and its line is
still written once — on the event loop if the attempt had settled when the cancellation landed,
otherwise by the worker thread when it settles, since nothing is left on the loop to write it.
Cancelled while still queued for a worker thread, it never runs. A logger must not start a load:
see [Azure Functions](#azure-functions).

### `hydrate_with_backoff(options, backoff: BackoffOptions | None = None) -> HydrationResult`

Calls `hydrate` until it succeeds. `BackoffOptions(initial_ms=5_000, max_ms=600_000,
on_error=None)`. Re-raises every `ConfigInputError`; sleeps through a `ConfigFloorError` without
calling `on_error`, logging or widening the delay. After a real failure, `on_error(error,
next_delay_ms)` gets the real wait — the backoff delay or the time until the floor opens, whichever
is longer. The default `on_error` logs `Configuration load failed, retrying in <s>s: <message>`,
guarded so a broken logger cannot end the loop; a custom one that raises ends it. The attempts it
starts do not also log `hydrate()`'s failure line. A wait longer than 2**31 - 1 ms is slept in
steps.

### `retry_after_ms(error) -> int | None`

| `error` | Returns |
|---|---|
| `ConfigFloorError` | Its `retry_after_ms` |
| `ConfigInputError`, whether or not it reached the store | `None` — waiting won't fix it |
| Anything else | Time until the armed floor opens (by the `retry_floor_ms` of the attempt that armed it), rounded up, plus 50 ms; `None` if open — retry now |

Makes no request. A `ConfigFloorError` whose `__cause__` is a `ConfigInputError` with
`reached_store=True` still gets the floor's wait, on purpose: a fix in the store heals the next
attempt, and the floor is the right pace for it. On provider 2.5.0 `reached_store` is always
`False`, so none arises.

### `hydration_status(keys, label=None) -> HydrationStatus`

`state` is `loaded`, `pending`, `failing` or `none`, with `loaded_at`, `failed_at`, `last_error`
and `next_attempt_at` (milliseconds since the epoch) as in the TypeScript half. Never makes a
request and never starts an attempt. Raises `ConfigInputError` for a call `hydrate()` would refuse
before any request. `next_attempt_at` appears only in `failing` and `none`, while the floor —
armed by any key map — is closed.

### `reset_hydration()`

Clears the memo, the recorded failures, the floor and the set of pre-request errors already
logged, and drops the package's own `DefaultAzureCredential` without closing it. For tests. An
attempt still in flight, or an abandoned load thread, settles against the state it started in and
keeps using the credential it started with; the garbage collector takes it afterwards.

### Errors

The cause is always `__cause__`, the Python idiom — there is no separate `cause` attribute.

- **`ConfigLoadError`** — `detail` (the reason), `status_code`, `observations` (every distinct
  failure the store's pipeline saw), `__cause__` (the provider's error, unmodified).
- **`ConfigInputError`** — a call no retry can fix: this package's own checks, and an argument
  the provider refused **before any network activity** (no token asked for, no request sent).
  Anything that fails later is a `ConfigLoadError`, whatever its class — a transient failure can
  arrive as a `ValueError`, and an input error stops every retry for good. `reached_store` is
  therefore always `False` in this release; it stays for parity with the TypeScript half, where it
  is equally defensive, and `hydrate_with_backoff` stops on any `ConfigInputError`.
- **`ConfigFloorError`** — `retry_after_ms`; `__cause__` is the error of the attempt that armed
  the floor. Neither of the other two, so a count of load failures does not count it and
  `hydrate_with_backoff` waits it out.

`DEFAULT_RETRY_FLOOR_MS` is `30_000`.

## What a failure costs, on provider 2.5.0

Measured against a local fake store, per attempt at the default 15 s timeout:

| Failure | Store requests | Arrives after |
|---|---|---|
| Success, or a missing key | one per key | at once |
| 401 or 403 | 1 (the provider backs its only client off for 30 s) | ~10 s |
| 429 or 5xx | 1 (no SDK retries, and no `Retry-After` sleep) | ~10 s |
| Unreachable: failed lookup, refused connection | 0 | ~10 s |
| A Key Vault reference it cannot parse, or with no URI | one per key, then `ConfigLoadError` naming the reference, with the stored URI withheld | 5 s |
| A vault that refuses a reference | one per key, then `ConfigLoadError` | ~10 s |

A broken Key Vault reference is retried like any other load failure: fixing the reference in the
store heals the process.

**The price of `retry_total=0`, plainly: it is a trade, not a saving.** A single transient 5xx
or 429 now fails the attempt: at the defaults it arrives after about 10 s (the provider benches its
only client for 30 s, then waits out its startup timeout) and arms the 30 s floor, so the process
goes about 40 s without configuration. On the TypeScript half the SDK's own retries would usually
absorb such a blip inside the attempt, at up to three requests per failure. What it buys: one
request per failure, and an abandoned load thread that ends, since azure-core sleeps a
`Retry-After` uncapped. If a blip matters more than those, the caller retries — the floor and
`hydrate_with_backoff` are built for that. Reviewed for `1.0.0` and kept.


Requests, not quota units: on a capped tier each one costs several. The provider also logs its
own warning, `Failed to load configurations from endpoint …`, once per failing attempt, through
the `azure.appconfiguration.provider` logger.

## Testing a consumer

Replace the provider's `load()` at the module boundary — the package looks it up on
`azure.appconfiguration.provider` at call time — and reset the package and the variables it
writes between tests:

```python
import os

import pytest

from azure_app_config import reset_hydration

KEYS = {"shared:mongoUrl": "MONGO_URL"}


class FakeConfig:
    def __init__(self, values: dict[str, str]) -> None:
        self.values = values

    def get(self, key: str) -> str | None:
        return self.values.get(key)


@pytest.fixture(autouse=True)
def config(monkeypatch: pytest.MonkeyPatch) -> None:
    reset_hydration()
    for variable in KEYS.values():
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setenv("APP_CONFIG_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("APP_CONFIG_LABEL", "test")
    values = {"shared:mongoUrl": "mongodb://example.invalid/app"}
    monkeypatch.setattr("azure.appconfiguration.provider.load", lambda *a, **k: FakeConfig(values))
```

**Clear the mapped variables too.** A test run sets no `WEBSITE_INSTANCE_ID`, so local precedence
is on, and a value one test's `hydrate()` wrote would beat the next test's fake store. Do not
`importlib.reload` the package for fresh state: that makes a second set of error classes that
`except` clauses elsewhere will not match. Call `reset_hydration()`.

## Differences between the halves

Everything not listed here behaves as in the TypeScript half, and the text of every line it logs
is the same word for word; when and how a logger is called differs as the table says. Each
difference was reviewed for `1.0.0` and kept.

| | TypeScript | Python | Why |
|---|---|---|---|
| The error's cause | `cause` | `__cause__`, on all three error classes; no `cause` attribute | Each language's idiom |
| A missing or unusable key | a plain `Error` | `LookupError` | The plain-`Error` counterpart, and what an `except` for a lookup expects |
| The default credential | a new `DefaultAzureCredential` per attempt | one per process, created on first need, reused by every attempt, and dropped — not closed — by `reset_hydration()` | Its token cache and session survive a persistent failure (up to 2,880 attempts a day); closing it would fail an attempt or an abandoned thread still using it |
| `timeout_ms` | the provider's startup timeout: the call settles at the later of it and the provider's five-second pad | a hard bound on the call: the load runs on a daemon thread, abandoned when the bound fires, and it never writes the environment | Provider 2.5.0 checks its startup timeout only between passes, so a hanging request would hold `load()` far longer |
| SDK retries inside an attempt | the SDK's defaults: a transient 5xx or 429 is usually absorbed, at up to three requests per failure | none (`retry_total=0`): a single blip fails the attempt and arms the floor — about 40 s without configuration at the defaults — for one request | azure-core sleeps a `Retry-After` uncapped, and not retrying is the only way an abandoned load thread is sure to end. See [What a failure costs](#what-a-failure-costs-on-provider-250) |
| `hydrate()` from a logging handler on the thread constructing the default credential | no counterpart | raises `ConfigLoadError`, unlogged; nothing is attempted | That call cannot be given a credential, and logging it would re-enter the same handler |
| An input error from the provider | an argument, type or range error anywhere in the chain; `reachedStore` is defensive | only an argument refused before any network activity, so `reached_store` is always `False`; a Key Vault reference provider 2.5.0 cannot parse is a retryable `ConfigLoadError` naming it, with the stored URI withheld | After a token or a request, the same exception classes come from failures waiting can fix, and an input error stops every retry for good |
| `gated()` | yes | not yet | No Python consumer has HTTP triggers. It will be added, additively, with the first one; until then, on any exception from `hydrate`, answer 503 with `Retry-After: max(1, ceil(retry_after_ms(error) / 1000))` seconds when `retry_after_ms` gives a wait, and without it otherwise |
| Sync and async | `hydrate()` returns a promise | `hydrate()` is synchronous and thread-safe; `hydrate_async()` runs it on a worker thread and writes its line on the event loop | Consumers mix sync handlers on the worker's thread pool with async ones |
| A backoff loop for asyncio | `hydrateWithBackoff()` is async | no async `hydrate_with_backoff`; use `asyncio.to_thread(hydrate_with_backoff, CONFIG)` | See [Long-lived processes](#long-lived-processes): cancelling the task does not stop the thread |
| The logger | `log` for the success line, `error` (else `log`) for a failure; default `console` | `info` and `error` (else `info`); default `logging.getLogger("azure_app_config")` | Each language's logging idiom; outside the `azure` tree, which consumers silence below WARNING |
| When the success line is written | inside the attempt, before the memo is set: a logger calling `hydrationStatus` sees `pending`, and one calling `hydrate` joins the attempt it is logging | after the attempt has settled and the memo is set: `hydration_status` says `loaded`, and `hydrate` is a memo hit | A sync call joining its own attempt from the logging thread would wait for ever; a promise joining it does not. The failure line comes after the bookkeeping in both |
| An async logger | the method is called, so the line is written, and a rejection is swallowed | a coroutine the method returns is closed unawaited, so the line is lost | `hydrate()` is synchronous and cannot await it; pass a sync logger |
| A logger that raises | anything it throws is swallowed | only an `Exception` is swallowed; a `BaseException` (`KeyboardInterrupt`, `SystemExit`, a cancellation) propagates — after a successful load too, from `hydrate()` or from `hydrate_async` once the environment is written | Swallowing a `BaseException` would hide an interrupt or a shutdown |
| Two builds in one process | a version-keyed state on `globalThis`, and branded error classes | none | A Python process imports a module once: one state and one set of classes by construction |
| Shapes | timestamps are `number` milliseconds; results hold arrays | `int` milliseconds; results hold tuples | Immutable results |

## Development

From the repository root: `make install-py`, `make test-py`, `make test-integration-py` (the real
provider against an RFC 2606 `.invalid` endpoint and a loopback fake store — no Azure, no egress),
`make lint-py`, `make typecheck-py`, `make build-py`.

## License

MIT
