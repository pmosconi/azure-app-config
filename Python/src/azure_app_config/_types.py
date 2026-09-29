"""The public shapes: options in, results and status out. Behaviour lives in `_core.py`."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    from azure.core.credentials import TokenCredential

KeyMap = Mapping[str, str]
"""`{store_key: environment_variable_name}`. A map, never a prefix: see `HydrateOptions.keys`."""


class Logger(Protocol):
    """What `hydrate()` logs through. A `logging.Logger` fits, and so does any object with `info`.

    `info` receives the success line. `error`, when the object has one, receives the failure line;
    without it the failure line goes to `info`. Synchronous: a coroutine returned by either is
    closed unawaited, so an async logger loses the line rather than leaking a warning.
    """

    def info(self, message: str, /) -> object: ...


@dataclass(frozen=True)
class HydrateOptions:
    """One call's configuration. Build it once and pass the same object to every call.

    The same option names as the TypeScript half, in snake_case, with the same defaults.
    """

    keys: KeyMap
    """The keys to read and the variables to write them into.

    Explicit, never a prefix or a wildcard. Every Key Vault reference the provider loads it also
    resolves, so a selector like `shared:*` attempts to resolve secrets the caller holds no grant
    on, and turns another application's credential into this application's startup failure.
    """

    label: str | None = None
    """The one label to read. Defaults to `APP_CONFIG_LABEL`; refused if neither is set. Its own
    variable, never derived from anything else."""

    endpoint: str | None = None
    """Store endpoint. Defaults to `APP_CONFIG_ENDPOINT`."""

    connection_string: str | None = field(default=None, repr=False)
    """Access-key fallback for a run with no identity to borrow. Defaults to
    `APP_CONFIG_CONNECTION_STRING`. Takes precedence over `endpoint` when set. Never printed."""

    credential: TokenCredential | None = field(default=None, repr=False)
    """Credential for the store and for resolving Key Vault references. Defaults to
    one `DefaultAzureCredential()` per process, created on first need and reused; a credential you
    pass is never closed."""

    timeout_ms: float | None = None
    """Bound on one attempt, in milliseconds. Defaults to 15 000, not the provider's 100 s: App
    Service gives a container less than 100 s to answer its first ping. Finite, above 0, at most
    2**31 - 1. `hydrate()` returns within it: see `CLAUDE.md` for how it is enforced."""

    retry_floor_ms: float | None = None
    """Minimum gap between attempts after a failure, in milliseconds. Defaults to
    `DEFAULT_RETRY_FLOOR_MS` (30 000). Inside it, `hydrate()` raises `ConfigFloorError` without
    touching the store. Finite, 0 or more — NaN would switch the floor off."""

    local_overrides_win: bool | None = None
    """Whether a value already in the environment beats the store. A dev-only escape hatch: false
    in every deployed environment. `None` means "not deployed", read on every attempt from
    `WEBSITE_INSTANCE_ID`, which App Service and Azure Functions inject on every instance. Any other
    host — Container Apps, Kubernetes, a VM — must pass `False`. Decided by truthiness."""

    logger: Logger | None = None
    """Defaults to `logging.getLogger("azure_app_config")`. Per attempt, not per call: the call
    that starts an attempt logs it; a call that joins it or hits the memo logs nothing."""


@dataclass(frozen=True)
class BackoffOptions:
    """`hydrate_with_backoff`'s schedule. Delays in milliseconds, finite and above 0."""

    initial_ms: float = 5_000
    """First delay after a failed attempt."""

    max_ms: float = 600_000
    """Cap on the delay. It bounds attempts, not requests: see the README's quota section."""

    on_error: Callable[[BaseException, float], object] | None = None
    """Called with every failed attempt and the wait before the next one, in milliseconds. Never
    for a `ConfigFloorError`, which is not a failed attempt. Defaults to logging
    `Configuration load failed, retrying in <s>s: <message>` through the logger's `error`
    (else `info`), guarded so a broken logger cannot end the loop."""


@dataclass(frozen=True)
class HydrationResult:
    """What one successful attempt did. Shared by every caller the memo answers."""

    label: str
    """The label that was read."""
    applied: tuple[str, ...]
    """Variables written from the store."""
    kept: tuple[str, ...]
    """Variables left alone because the local environment won."""
    loaded_at: int
    """When the environment was written, in milliseconds since the epoch."""


@dataclass(frozen=True)
class HydrationStatus:
    """What `hydration_status()` reports for one key map and label. Milliseconds since the epoch.

    - `loaded`: a success is memoised; `loaded_at` says when.
    - `pending`: an attempt is in flight; `failed_at`/`last_error` describe the one before, if any.
    - `failing`: the last attempt failed; `failed_at`/`last_error` are that attempt's.
    - `none`: no attempt yet for this key map and label.

    `next_attempt_at` appears only in `failing` and `none`, and only while the retry floor is
    closed, whichever key map armed it: when it opens, by the floor of the attempt that armed it.
    """

    state: Literal["loaded", "failing", "pending", "none"]
    loaded_at: int | None = None
    failed_at: int | None = None
    last_error: BaseException | None = None
    next_attempt_at: float | None = None


@dataclass(frozen=True)
class FailureObservation:
    """One failure seen on the wire by the diagnostics policy."""

    message: str
    status: int | None = None
    """HTTP status, when the failure was a response rather than a raised error."""
    code: str | None = None
    """The raised error's class, when there was no response — `ServiceRequestError` and the like."""
