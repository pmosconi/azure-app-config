"""Fixtures for the unit suite: the provider's real error shapes, and a fake `load()` that drives
the diagnostics policy the way the provider's pipeline does.

Neutral keys only — this repository is public, and nothing here names a real store or estate.

-------------------------------------------------------------------------------------------------
The provider's real shapes — azure-appconfiguration-provider 2.5.0 (azure-core 1.41,
azure-appconfiguration 1.9, azure-keyvault-secrets 4.11), each verified against the real provider
with a local fake store (see `test_provider_contract_integration.py` for the ones that run in CI).
Paths are relative to `azure/appconfiguration/provider/` unless they say otherwise.

- `_load.py:185-206` — `load()` builds the provider outside its `try` (`:191-198`), so an argument
  the provider refuses arrives bare and unpadded, before any request. Inside the `try`, any error
  is re-raised after `delay_failure` pads the call to five seconds (`_utils.py:30-41`).
- `_azureappconfigurationprovider.py:223-249` — `_load_all` loops passes; `_try_initialize`
  (`:251-321`) catches only `AzureError` (`:314`), logs `Failed to load configurations from
  endpoint`, backs the client off and files the error in `startup_exceptions`. When the next
  back-off would overrun `startup_timeout`, it raises `TimeoutError("The provider timed out while
  attempting to load.", startup_exceptions)` (`:243-246`). **The causes survive**, unlike on the
  JavaScript provider, which is why these fixtures carry them.
- Back-off: every `AzureError` backs the only client off for 30 s (`:76-77` and
  `_client_manager_base.py:46-63`: min = max = refresh_interval 30), so inside a 15 s startup
  timeout there is one pass that sends requests, then passes that find no active client.
- A status reaches the chain as azure-core's `HttpResponseError` —
  `ClientAuthenticationError` for 401 (`appconfiguration/_generated/_operations/_patch.py:51-54`)
  — with message `Operation returned an invalid status '<reason>'`
  (`azure/core/exceptions.py:392`). A failed lookup or refused connection is a
  `ServiceRequestError` raised by the transport, under the diagnostics policy.
- A Key Vault reference is resolved inside the pass (`:278`, `:386-388`). What goes wrong there is
  *not* an `AzureError` unless the vault answered, so it escapes the loop at once:
  - an unparseable URI: `ValueError("'<the stored URI>' is not a valid ID")`
    (`azure/keyvault/secrets/_shared/__init__.py:50-57`) — which echoes the stored value;
  - no URI: `ValueError("Key Vault reference must have a uri value.")`
    (`_key_vault/_secret_provider_base.py:60-61`);
  - an empty secret: `ValueError("No Secret Client found for Key Vault reference <vault>")`
    (`_key_vault/_secret_provider_base.py:42-47`);
  - an unreachable vault: `ValueError("Failed to retrieve secret from Key Vault")` raised *from*
    the `ServiceRequestError` (`_key_vault/_secret_provider.py:65-66`).
  A vault that answers with an error raises `HttpResponseError`, an `AzureError`, which the loop
  files beside the store's own errors (`:314-319`), backing the *store* client off.
- Before any request: a connection string with no `=` in its first segment raises `IndexError`
  (`_azureappconfigurationprovider.py:46`); a malformed one `ValueError("Invalid connection
  string.")` (`appconfiguration/_utils.py:16-38`); an empty endpoint `ValueError("No endpoint
  specified.")` (`_azureappconfigurationprovider.py:47-48`).
- The pipeline: the provider forwards unconsumed keywords to every `AzureAppConfigurationClient`
  (`_client_manager.py:431-437`, `:507-531`), and azure-core puts `per_retry_policies` right after
  the `RetryPolicy` and *before* the authentication policy (`azure/core/_pipeline_client.py:155-172`
  with the explicit list at `appconfiguration/_generated/_client.py:52-68`). So the fake below asks
  for the token inside the policy's `next`, as the real authentication policy does.
-------------------------------------------------------------------------------------------------
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from azure.core.credentials import AccessToken
from azure.core.exceptions import (
    AzureError,
    ClientAuthenticationError,
    HttpResponseError,
    ResourceNotFoundError,
    ServiceRequestError,
)
from azure.core.pipeline import Pipeline
from azure.core.pipeline.transport import HttpTransport
from azure.core.rest import HttpRequest

from azure_app_config import HydrateOptions

KEYS: dict[str, str] = {
    "shared:mongoUrl": "MONGO_URL",
    "shared:serviceBus": "SERVICE_BUS_CONNECTION",
    "myapp:httpPort": "HTTP_PORT",
}

VALUES: dict[str, Any] = {
    "shared:mongoUrl": "mongodb://example.invalid:27017/app",
    "shared:serviceBus": "Endpoint=sb://example.invalid/;SharedAccessKeyName=n;SharedAccessKey=k",
    "myapp:httpPort": "8080",
}

ENDPOINT = "https://example.invalid"
CONNECTION_STRING = "Endpoint=https://example.invalid;Id=x;Secret=c2VjcmV0"


def options(**overrides: Any) -> HydrateOptions:
    values: dict[str, Any] = {"keys": KEYS}
    values.update(overrides)
    return HydrateOptions(**values)


# ------------------------------------------------------------------------------------------------
# The provider's error shapes.
# ------------------------------------------------------------------------------------------------

PROVIDER_TIMEOUT = "The provider timed out while attempting to load."
_REASONS = {
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    429: "Too Many Requests",
    500: "Internal Server Error",
    503: "Service Unavailable",
}


def provider_timeout(*errors: BaseException) -> TimeoutError:
    """`_azureappconfigurationprovider.py:243-246`: what `load()` raises when every pass failed."""
    return TimeoutError(PROVIDER_TIMEOUT, list(errors))


class _AzureResponse:
    """Just enough of an azure-core response for `HttpResponseError(response=...)`."""

    def __init__(self, status: int, body: str | None = None) -> None:
        self.status_code = status
        self.reason = _REASONS.get(status, "Error")
        self._body = body

    def text(self, encoding: str | None = None) -> str:
        return self._body or ""


def http_error(status: int, body: str | None = None) -> HttpResponseError:
    """The SDK's error for a status, built by azure-core's own constructor."""
    kind: type[HttpResponseError] = HttpResponseError
    if status == 401:
        kind = ClientAuthenticationError
    elif status == 404:
        kind = ResourceNotFoundError
    return kind(response=_AzureResponse(status, body))  # type: ignore[arg-type]


def name_resolution_error(host: str = "example.invalid") -> ServiceRequestError:
    return ServiceRequestError(
        f"HTTPSConnection(host='{host}', port=443): Failed to resolve '{host}' "
        "([Errno 8] nodename nor servname provided, or not known)"
    )


def connection_refused_error() -> ServiceRequestError:
    return ServiceRequestError(
        "HTTPConnection(host='127.0.0.1', port=1): Failed to establish a new connection: "
        "[Errno 61] Connection refused"
    )


def key_vault_invalid_id(stored: str) -> ValueError:
    return ValueError(f"'{stored}' is not a valid ID")


def key_vault_no_uri() -> ValueError:
    return ValueError("Key Vault reference must have a uri value.")


def key_vault_unreachable() -> ValueError:
    try:
        raise ValueError("Failed to retrieve secret from Key Vault") from name_resolution_error(
            "vault.example.invalid"
        )
    except ValueError as error:
        return error


INVALID_CONNECTION_STRING = "Invalid connection string."


# ------------------------------------------------------------------------------------------------
# A fake load() that behaves like the provider on the wire.
# ------------------------------------------------------------------------------------------------


class FakeConfig:
    """What `load()` returns, as far as this package uses it: `get(key)` and `close()`."""

    def __init__(self, values: Mapping[str, Any]) -> None:
        self._values = dict(values)
        self.closed = False
        self.gets: list[str] = []

    def get(self, key: str) -> Any:
        self.gets.append(key)
        return self._values.get(key)

    def close(self) -> None:
        self.closed = True


class _FakeHttpResponse:
    def __init__(self, status: int, body: str | None) -> None:
        self.status_code = status
        self._body = body

    def text(self, encoding: str | None = None) -> str:
        return self._body or ""


class FakeTransport(HttpTransport):  # type: ignore[type-arg]
    """The bottom of a real azure-core pipeline: answers each request with `respond`."""

    def __init__(self, respond: Callable[[HttpRequest], Any]) -> None:
        self.respond = respond
        self.requests: list[HttpRequest] = []

    def send(self, request: HttpRequest, **kwargs: Any) -> Any:
        self.requests.append(request)
        return self.respond(request)

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass

    def __enter__(self) -> FakeTransport:
        return self

    def __exit__(self, *args: Any) -> None:
        pass


@dataclass
class Wire:
    """What one request meets below the diagnostics policy: a response, or a raise."""

    status: int = 200
    body: str | None = None
    """Defaults to an empty page for a 2xx and to no body for an error."""
    raises: BaseException | None = None
    wait_for: threading.Event | None = None
    reached: threading.Event | None = None
    """Set once the request has passed the diagnostics policy and is below it."""


def _policies(kwargs: Mapping[str, Any]) -> list[Any]:
    return list(kwargs.get("per_retry_policies") or [])


def _credential(args: tuple[Any, ...]) -> Any:
    return args[1] if len(args) >= 2 else None


def send(args: tuple[Any, ...], kwargs: Mapping[str, Any], wire: Wire) -> None:
    """One request through a real azure-core pipeline carrying the per-retry policies, as the
    provider's client would send it. The token is asked for below the policy, as azure-core's
    authentication policy does. An `AzureError` the provider catches, so does this; anything else
    escapes the provider's loop (`_azureappconfigurationprovider.py:314`), so it escapes here."""
    credential = _credential(args)

    def respond(request: HttpRequest) -> _FakeHttpResponse:
        if wire.reached is not None:
            wire.reached.set()
        if credential is not None:
            credential.get_token("https://azconfig.io/.default")
        if wire.wait_for is not None:
            wire.wait_for.wait(30)
        if wire.raises is not None:
            raise wire.raises
        body = wire.body
        if body is None and wire.status < 400:
            body = '{"items":[]}'
        return _FakeHttpResponse(wire.status, body)

    pipeline = Pipeline(FakeTransport(respond), _policies(kwargs))  # type: ignore[arg-type]
    try:
        pipeline.run(HttpRequest("GET", f"{ENDPOINT}/kv"))
    except AzureError:
        pass


Behaviour = Callable[[tuple[Any, ...], dict[str, Any]], Any]


@dataclass
class FakeLoad:
    """Installed as `azure.appconfiguration.provider.load` by the `fake_load` fixture."""

    behaviour: Behaviour = field(default_factory=lambda: returns(VALUES))
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = field(default_factory=list)
    configs: list[FakeConfig] = field(default_factory=list)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        self.calls.append((args, kwargs))
        result = self.behaviour(args, kwargs)
        if isinstance(result, FakeConfig):
            self.configs.append(result)
        return result

    @property
    def count(self) -> int:
        return len(self.calls)

    def kwargs(self, index: int = 0) -> dict[str, Any]:
        return self.calls[index][1]


def returns(values: Mapping[str, Any] = VALUES, answered: bool = True) -> Behaviour:
    """A success: one answered list request per selector, then the configuration."""

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> FakeConfig:
        if answered:
            for _ in kwargs.get("selects", []):
                send(args, kwargs, Wire())
        return FakeConfig(values)

    return behaviour


def raises(thrown: BaseException) -> Behaviour:
    """Fails with no request at all: an argument check, or a pass that never sent."""

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        raise thrown

    return behaviour


def fails_on_wire(wire: Wire, thrown: BaseException, tries: int = 1) -> Behaviour:
    """Meets `wire` `tries` times (the SDK retries 429 and 5xx twice: retry_total=2), then raises
    `thrown` — the provider's `TimeoutError` carrying the collected errors, or whatever it is."""

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        for _ in range(tries):
            send(args, kwargs, wire)
        raise thrown

    return behaviour


def fails_after_read(thrown: BaseException, answered: int | None = None) -> Behaviour:
    """The store answers every selector (or `answered` requests) 200, then the pass fails."""

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        count = answered if answered is not None else len(kwargs.get("selects", []))
        for _ in range(count):
            send(args, kwargs, Wire())
        raise thrown

    return behaviour


def hangs(
    release: threading.Event,
    answered: int = 0,
    request: bool = True,
    then: BaseException | Mapping[str, Any] | None = None,
) -> Behaviour:
    """`answered` requests answered, then one that does not come back until `release` (or no
    request at all, with `request=False`), then raises `then` or returns a configuration from it.
    The attempt's bound fires while this is blocked."""

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        for _ in range(answered):
            send(args, kwargs, Wire())
        if request:
            send(args, kwargs, Wire(wait_for=release))
        else:
            release.wait(30)
        if isinstance(then, BaseException):
            raise then
        return FakeConfig(then if then is not None else VALUES)

    return behaviour


def blocks(
    gate: threading.Event, then: Behaviour, started: threading.Event | None = None
) -> Behaviour:
    """Holds the attempt open until `gate`, then behaves as `then`."""

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        if started is not None:
            started.set()
        gate.wait(30)
        return then(args, kwargs)

    return behaviour


def token_then_raises(thrown: BaseException) -> Behaviour:
    """Provider drift: the token is fetched, and no request passes the diagnostics policy."""

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        credential = _credential(args)
        if credential is not None:
            credential.get_token("https://azconfig.io/.default")
        raise thrown

    return behaviour


def pending_request_then_raises(thrown: BaseException, release: threading.Event) -> Behaviour:
    """A request left and has not come back when the provider raises: in flight, not answered."""

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        reached = threading.Event()

        def background() -> None:
            send(args, kwargs, Wire(wait_for=release, reached=reached))

        threading.Thread(target=background, daemon=True).start()
        reached.wait(5)
        raise thrown

    return behaviour


# ------------------------------------------------------------------------------------------------
# Credentials and loggers.
# ------------------------------------------------------------------------------------------------


class StubCredential:
    """Answers at once. Stands in for DefaultAzureCredential, which would reach for a real one."""

    def __init__(self) -> None:
        self.calls = 0

    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        self.calls += 1
        return AccessToken("not-a-real-token", int(time.time()) + 3600)


class FlakyJsonCredential:
    """Raises what ManagedIdentityCredential lets through when the identity endpoint answers with
    a body msal cannot parse — a bare `json.JSONDecodeError` — `failures` times, then answers."""

    def __init__(self, failures: int) -> None:
        self.failures = failures

    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        if self.failures > 0:
            self.failures -= 1
            raise json.JSONDecodeError("Expecting value", "<html>", 0)
        return AccessToken("not-a-real-token", int(time.time()) + 3600)


class HangingCredential:
    """Asked, and never answers until `release`."""

    def __init__(self, release: threading.Event) -> None:
        self.release = release
        self.requested = threading.Event()

    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        self.requested.set()
        self.release.wait(30)
        raise ClientAuthenticationError("released at teardown")


class RecordingLogger:
    def __init__(self) -> None:
        self.infos: list[str] = []
        self.errors: list[str] = []

    def info(self, message: str) -> None:
        self.infos.append(message)

    def error(self, message: str) -> None:
        self.errors.append(message)

    @property
    def lines(self) -> list[str]:
        return self.infos + self.errors


class InfoOnlyLogger:
    def __init__(self) -> None:
        self.infos: list[str] = []

    def info(self, message: str) -> None:
        self.infos.append(message)


class RaisingLogger:
    def __init__(self) -> None:
        self.calls = 0

    def info(self, message: str) -> None:
        self.calls += 1
        raise RuntimeError("logger down")

    def error(self, message: str) -> None:
        self.calls += 1
        raise RuntimeError("logger down")


class Clock:
    """Replaces the package's clock and sleep: time moves only when a test or a sleep moves it."""

    def __init__(self, now: int = 1_800_000_000_000) -> None:
        self.now = now
        self.sleeps: list[float] = []

    def now_ms(self) -> int:
        return self.now

    def sleep_ms(self, ms: float) -> None:
        self.sleeps.append(ms)
        self.now += int(ms) if float(ms).is_integer() else int(ms) + 1

    def advance(self, ms: int) -> None:
        self.now += ms


def wait_until(condition: Callable[[], bool], timeout_s: float = 5.0) -> None:
    """Wait for a condition another thread makes true. Not a timing assumption: the loop only
    returns once the condition holds, and fails the test if it never does."""
    deadline = time.monotonic() + timeout_s
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        time.sleep(0.001)
