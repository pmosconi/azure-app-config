"""Hydrate `os.environ` from Azure App Configuration: the four invariants in `CLAUDE.md`.

Synchronous at the core and thread-safe: one module-level state behind one lock, one attempt in
flight per key map and label. A caller in another thread that arrives during an attempt waits for
it and receives the identical exception object, or the memoised success. `hydrate_async` runs the
same call through `asyncio.to_thread`, so both share one memo and one floor, and writes the
attempt's lines itself, on the event loop.

One state per process by construction: a Python process imports a module once, so the dual-build
registry of the TypeScript half has no counterpart here.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import logging
import math
import os
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any

from azure.appconfiguration import provider as _provider

from ._diagnostics import (
    DiagnosticsPolicy,
    WireEvidence,
    argument_error_in_chain,
    explain,
    watch_credential,
)
from ._errors import (
    FLOOR_MARGIN_MS,
    ConfigFloorError,
    ConfigInputError,
    ConfigLoadError,
    message_of,
)
from ._types import BackoffOptions, HydrateOptions, HydrationResult, HydrationStatus, KeyMap

DEFAULT_RETRY_FLOOR_MS = 30_000
"""The default `retry_floor_ms`: after a failed attempt, 30 s during which `hydrate()` raises
`ConfigFloorError` instead of reaching the store. Exported so a caller can line up with it."""

DEFAULT_TIMEOUT_MS = 15_000
MAX_TIMER_MS = 2**31 - 1
"""The TypeScript half's cap on `timeout_ms` (the longest `setTimeout` honours), kept for parity,
and the longest single sleep step."""
DEFAULT_LOGGER_NAME = "azure_app_config"
"""Not under `azure.`: consumers commonly silence that SDK logger tree below WARNING, which would
swallow the success line."""


_Line = Callable[[], None]
"""One line, ready to write: a call to a guarded report function, which never raises."""


def _now_ms() -> int:
    """Milliseconds since the epoch, as `Date.now()` returns them. Patched by the tests."""
    return time.time_ns() // 1_000_000


def _sleep_ms(ms: float) -> None:
    """One sleep step. Patched by the tests."""
    time.sleep(ms / 1000)


# ------------------------------------------------------------------------------------------------
# State.
# ------------------------------------------------------------------------------------------------


@dataclass(eq=False)
class _Attempt:
    """One attempt in flight. The call that started it settles it; joiners wait on `done`."""

    done: threading.Event = field(default_factory=threading.Event)
    result: HydrationResult | None = None
    error: BaseException | None = None
    traceback: TracebackType | None = None
    """The error's traceback below the frame every caller shares. Each caller re-raises with it, so
    the one exception object's traceback does not grow with every joiner's frames and locals
    (retained through `last_error` and `ConfigFloorError`). Every caller reassigns it, so the
    traceback of a shared failure may show another caller's frames; it does not grow."""


@dataclass(eq=False)
class _CallRecord:
    """What one key map and label has done. A failure clears `attempt` and records itself in
    `failed_at`/`last_error`: never memoised, still reported."""

    attempt: _Attempt | None = None
    result: HydrationResult | None = None
    failed_at: int | None = None
    last_error: BaseException | None = None


@dataclass(eq=False)
class _State:
    """Everything the package holds, so `reset_hydration()` clears every part of it."""

    calls: dict[str, _CallRecord] = field(default_factory=dict)
    # The retry floor. Deliberately not per key map: it bounds the store's request quota, which
    # every key map in the process spends from together.
    failed_at: int | None = None
    last_error: BaseException | None = None
    floor_ms: float | None = None
    """The `retry_floor_ms` of the attempt that armed the floor, for `hydration_status`."""
    reported_input_errors: set[str] = field(default_factory=set)
    """Messages of pre-request rejections already logged, so each is said once, not per call."""
    default_credential: Any = None
    """The one `DefaultAzureCredential`, created on first need and reused by every attempt, so its
    token cache and session survive a persistent failure. `reset_hydration()` drops it."""


_lock = threading.Lock()
_state = _State()


def _current_state() -> _State:
    with _lock:
        return _state


# ------------------------------------------------------------------------------------------------
# The public functions.
# ------------------------------------------------------------------------------------------------


def hydrate(options: HydrateOptions) -> HydrationResult:
    """One attempt to read the store and write `os.environ`. Does not loop.

    A success is memoised against the key map and label it was made with. A failure is not — but
    a further call inside `retry_floor_ms` raises `ConfigFloorError` without touching the store.
    Every failure that reached the store arms the floor; only input refused before any request
    leaves it alone. Concurrent calls for one key map and label, from any thread, share one attempt
    and receive the identical exception object when it fails.

    A failed attempt is logged once, `Configuration load failed: <message>`, through the `error`
    method of the logger of the call that started it (`info` if it has none); joiners, memo hits
    and floor rejections log nothing. A call refused before any request is logged the first time
    its message is seen, until `reset_hydration()`. A logger that raises changes nothing.

    Nothing is written unless every key is usable: a raise leaves `os.environ` as it was.
    """
    return _hydrate_once(options, True, _write_now)


async def hydrate_async(options: HydrateOptions) -> HydrationResult:
    """`hydrate()` for an async caller: the attempt runs on a worker thread via
    `asyncio.to_thread`, and its success or failure line is written here, on the event loop,
    after the `await`.

    The same memo, floor and in-flight attempt as `hydrate()`, and the same logging rules: one line
    per attempt, by the call that started it; none for a joiner, a memo hit or a
    `ConfigFloorError`; a pre-request rejection once per distinct message. The line is written on
    the loop because the Azure Functions Python worker does not tie a record written on a pool
    thread to the invocation, and drops it.

    Cancelling the awaiting task does not stop an attempt already running: it completes, and its
    outcome is kept for the next call. Its line is still written exactly once: on the event loop if
    the attempt had settled when the cancellation landed, otherwise by the worker thread as the
    attempt settles, since nothing is left on the loop to write it. A host that drops pool-thread
    records may lose that one line; dropping it on purpose would lose it everywhere. Cancelled
    while still queued for a worker, the call never runs: no attempt, no line, nothing claimed.

    A logger must not start a load. Its lines are written on the event loop, so a handler that
    calls the sync `hydrate()` for anything but the attempt being logged (a memo hit or a floor
    rejection) makes a new attempt there, and blocks the loop for up to `timeout_ms`.
    """
    handoff = _Handoff()
    try:
        return await asyncio.to_thread(_hydrate_for_async, options, handoff)
    finally:
        # Normally the attempt's call has returned, so its lines are here. Cancelled, they are here
        # only if it had already returned; otherwise this tells the thread to write them itself.
        handoff.collect()


class _Handoff:
    """The lines of one `hydrate_async` call, passed from the worker thread to the event loop.
    Each line is written once: by `collect()` on the loop, or — when the caller stopped waiting
    before the call returned — by `deposit()` on the worker thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._lines: list[_Line] = []
        self._collected = False

    def deposit(self, lines: list[_Line]) -> None:
        """On the worker thread, as the call returns or raises."""
        with self._lock:
            if not self._collected:
                self._lines = lines
                return
        _write(lines)

    def collect(self) -> None:
        """On the event loop, once the caller stops waiting, normally or by cancellation."""
        with self._lock:
            self._collected = True
            lines, self._lines = self._lines, []
        _write(lines)


def _hydrate_for_async(options: HydrateOptions, handoff: _Handoff) -> HydrationResult:
    """`hydrate()` on the worker thread, with its lines handed to the event loop, not written."""
    pending: list[_Line] = []
    try:
        return _hydrate_once(options, True, pending.append)
    finally:
        handoff.deposit(pending)


def hydration_status(keys: KeyMap, label: str | None = None) -> HydrationStatus:
    """What `hydrate()` has done for this key map and label, without doing anything.

    Never makes a request and never starts an attempt, in any state, so a health endpoint can call
    it on every ping. The label resolves as for `hydrate()`. Raises `ConfigInputError` for a call
    `hydrate()` would refuse before any request; does not check the endpoint or timing options.
    """
    plan = _plan_for(keys, label)
    with _lock:
        state = _state
        record = state.calls.get(plan.fingerprint)
        now = _now_ms()
        if record is not None and record.result is not None:
            return HydrationStatus(state="loaded", loaded_at=record.result.loaded_at)
        failed_at = record.failed_at if record is not None else None
        last_error = record.last_error if record is not None else None
        if record is not None and record.attempt is not None:
            return HydrationStatus(state="pending", failed_at=failed_at, last_error=last_error)
        next_attempt_at: float | None = None
        if state.failed_at is not None:
            opens_at = state.failed_at + _floor_or_default(state.floor_ms)
            if opens_at > now:
                next_attempt_at = opens_at
        if failed_at is not None:
            return HydrationStatus(
                state="failing",
                failed_at=failed_at,
                last_error=last_error,
                next_attempt_at=next_attempt_at,
            )
        return HydrationStatus(state="none", next_attempt_at=next_attempt_at)


def retry_after_ms(error: BaseException) -> int | None:
    """How long to wait after any exception from `hydrate()` before calling it again, in ms.

    - `ConfigFloorError`: its own `retry_after_ms`.
    - `ConfigInputError`, whether or not it reached the store: `None` — waiting won't fix it.
    - Anything else: the time until the armed retry floor opens, by the `retry_floor_ms` of the
      attempt that armed it, rounded up, plus the 50 ms margin; `None` if the floor is open —
      retry now.

    So `None` means "don't retry" for a `ConfigInputError` and "retry now" for anything else:
    branch on `isinstance(error, ConfigInputError)`, never on `None`. Makes no request.

    A floor rejection whose `__cause__` is a `ConfigInputError` — one with `reached_store=True`,
    which armed the floor — still gets the floor's wait, deliberately (decided in 1.0.0): a fix in
    the store heals the next attempt, and the floor is the right pace for it. Unreachable on
    provider 2.5.0, where `reached_store` is always `False`.
    """
    if isinstance(error, ConfigFloorError):
        return error.retry_after_ms
    if isinstance(error, ConfigInputError):
        return None
    with _lock:
        wait = _floor_wait_ms(_state, _floor_or_default(_state.floor_ms))
    return wait if wait > 0 else None


def hydrate_with_backoff(
    options: HydrateOptions, backoff: BackoffOptions | None = None
) -> HydrationResult:
    """Call `hydrate()` until it succeeds, widening the delay from `initial_ms` to `max_ms`.
    **Long-lived processes only**: it sleeps, and returns only once the store answers.

    Retries a failure the store could recover from for as long as that takes — a missing key
    included — and re-raises every `ConfigInputError` at once. A `ConfigFloorError` is not a failed
    attempt: the loop sleeps until the floor opens without calling `on_error`, logging, or widening
    the delay. Failures are reported by `on_error` alone; the attempts it starts do not also log
    `hydrate()`'s failure line, and neither does the `ConfigInputError` it re-raises.
    """
    settings = backoff if backoff is not None else BackoffOptions()
    # A delay of zero or NaN would turn the loop into a spin against a floor of zero.
    initial_ms = _positive_ms("initial_ms", settings.initial_ms)
    max_ms = _positive_ms("max_ms", settings.max_ms)
    floor_ms = _floor_or_default(getattr(options, "retry_floor_ms", None))
    on_error = settings.on_error or _default_on_error(options)

    delay = initial_ms
    while True:
        try:
            return _hydrate_once(options, False, _write_now)
        except ConfigInputError:
            raise
        except ConfigFloorError as error:
            # Nothing was attempted, so nothing failed: wait for the floor and keep the schedule
            # of real attempts where it was. retry_after_ms is never zero, so this cannot spin.
            _sleep(error.retry_after_ms)
            continue
        except Exception as error:
            # Report when the next attempt will really happen: a failure that armed the floor
            # holds the next call back until it opens, however short the backoff delay.
            wait = max(delay, _floor_wait_ms(_current_state(), floor_ms))
            on_error(error, wait)
            _sleep(wait)
            delay = min(delay * 2, max_ms)


def _default_on_error(options: HydrateOptions) -> Callable[[BaseException, float], None]:
    """The default report, guarded like `hydrate()`'s: a broken logger must not end the loop. A
    custom `on_error` is caller code and keeps its own contract — if it raises, the loop ends."""

    def report(error: BaseException, next_delay_ms: float) -> None:
        _report_failure(
            options,
            f"Configuration load failed, retrying in {_seconds(next_delay_ms)}s: "
            f"{message_of(error)}",
        )

    return report


def reset_hydration() -> None:
    """Clear the memoised results, the recorded failures, the retry floor, the set of pre-request
    errors already logged, and the package's own `DefaultAzureCredential`. For tests. An attempt
    still in flight settles against the state it started in, never this one — and keeps the
    credential it started with, which is dropped, not closed, and collected once nothing uses it."""
    global _state
    with _lock:
        _state = _State()


_constructing = threading.local()
"""Set on the thread that is creating the default credential."""


def _ensure_default_credential() -> Any:
    """The state's one `DefaultAzureCredential`, created on first need.

    Created outside `_lock` and before any attempt is registered: its constructor logs through
    `azure.identity`, and a logging handler that calls into this package on this thread must find
    the lock free and no attempt of its own to wait on. A call on this thread while the
    constructor runs cannot be given a credential, so it raises — unlogged, since logging would
    reach the same handler again. Two threads may both create one; the first installed wins, and
    the other, never used, is closed.
    """
    with _lock:
        state = _state
        existing = state.default_credential
    if existing is not None:
        return existing
    if getattr(_constructing, "active", False):
        raise ConfigLoadError(
            "App Configuration not attempted",
            "hydrate() was called on the thread that is creating the default credential — from a "
            "logging handler, presumably — so nothing was attempted; call it again once that "
            "returns",
        )
    from azure.identity import DefaultAzureCredential

    _constructing.active = True
    try:
        made = DefaultAzureCredential()
    finally:
        _constructing.active = False
    with _lock:
        if state.default_credential is None:
            state.default_credential = made
            return made
        winner = state.default_credential
    _close(made)
    return winner


# ------------------------------------------------------------------------------------------------
# One attempt.
# ------------------------------------------------------------------------------------------------


def _hydrate_once(
    options: HydrateOptions, report_failures: bool, emit: Callable[[_Line], None]
) -> HydrationResult:
    """`hydrate()`, with the failure line switched by `report_failures`: `hydrate_with_backoff`
    passes False, because its `on_error` already reports every failure it sees.

    Each line it decides — after the attempt has settled and the memo is set, the once-per-message
    claim made here on the calling thread — goes to `emit`, and the caller decides when it is
    written: `hydrate()` and `hydrate_with_backoff` pass `_write_now`, so it is written here, before
    a failure is raised; `hydrate_async` collects them for the event loop.

    A sink rather than a list the caller writes in a `finally`: a joiner re-raises the one shared
    exception object, and every frame it unwinds adds to that object's traceback while other
    joiners do the same. With no handler between the raise and the caller, nothing runs on the way
    out and their frames cannot interleave (`test_joiners_do_not_pile_their_frames…`)."""
    state = _current_state()
    try:
        plan = _validate(options)
    except Exception as error:
        # Refused before any request, so it neither spends quota nor arms the floor. Not an
        # attempt, but a fail-fast caller would be silent about it, so it is said once per message.
        if report_failures:
            _report_once_per_message(state, options, error, emit)
        raise

    # Before an attempt is registered: see _ensure_default_credential.
    credential = options.credential
    if credential is None:
        credential = _ensure_default_credential()

    with _lock:
        state = _state
        record = state.calls.get(plan.fingerprint)
        if record is not None and record.result is not None:
            return record.result  # a memo hit logs nothing
        if record is not None and record.attempt is not None:
            attempt = record.attempt
            starter = False
        else:
            if state.failed_at is not None:
                opens_in_ms = (
                    state.failed_at + _floor_or_default(options.retry_floor_ms) - _now_ms()
                )
                if opens_in_ms > 0:
                    # Not a failure, so not logged, and it moves nothing: the store was not asked.
                    raise ConfigFloorError(opens_in_ms, state.last_error)
            if record is None:
                record = _CallRecord()
                state.calls[plan.fingerprint] = record
            attempt = _Attempt()
            record.attempt = attempt
            starter = True

    if not starter:
        # A joiner: the attempt that is answering logs for itself.
        attempt.done.wait()
        if attempt.error is not None:
            shared = attempt.error
            # The identical object, with the starter's frames below this one, so a joiner's frames
            # replace the last caller's rather than pile onto them. The traceback of a shared
            # failure may show another caller's frames; it does not grow.
            shared.__traceback__ = attempt.traceback
            raise shared
        assert attempt.result is not None
        return attempt.result

    try:
        result, lines = _attempt_hydration(plan, options, credential)
    except BaseException as error:
        below = error.__traceback__.tb_next if error.__traceback__ is not None else None
        now = _now_ms()
        with _lock:
            record.attempt = None
            # A failure that lands after reset_hydration() must not arm a floor, or record a
            # failure, in the state that replaced the one it started in.
            if _state is state and isinstance(error, Exception):
                record.failed_at = now
                record.last_error = error
                if _arms_floor(error):
                    state.failed_at = now
                    state.last_error = error
                    state.floor_ms = _floor_or_default(options.retry_floor_ms)
        attempt.error = error
        attempt.traceback = below
        attempt.done.set()
        # Decided only now, with the attempt settled: a logging handler that calls hydrate() must
        # find the outcome, not join an attempt that is waiting for it.
        # Once per attempt, whoever else was waiting on it. An input error the provider raised
        # before any request arms no floor, so every call would be a new attempt and a new line:
        # it is a pre-request rejection like _validate()'s, said once per distinct message.
        if report_failures and isinstance(error, Exception):
            if isinstance(error, ConfigInputError) and not error.reached_store:
                _report_once_per_message(_current_state(), options, error, emit)
            else:
                line = f"Configuration load failed: {message_of(error)}"
                emit(functools.partial(_report_failure, options, line))
        error.__traceback__ = below
        raise error

    with _lock:
        record.result = result
        record.attempt = None
    attempt.result = result
    attempt.done.set()
    # Written after the memo is set, for the same reason: a re-entrant hydrate() is a memo hit.
    emit(functools.partial(_report_success, options, lines))
    return result


def _arms_floor(error: BaseException) -> bool:
    """Every failure except an input error refused before the store answered."""
    return not isinstance(error, ConfigInputError) or error.reached_store


def _floor_or_default(floor_ms: float | None) -> float:
    return floor_ms if floor_ms is not None else DEFAULT_RETRY_FLOOR_MS


def _floor_wait_ms(state: _State, floor_ms: float) -> int:
    """How long a call with this floor would wait now, margin included; 0 if open."""
    if state.failed_at is None:
        return 0
    opens_in_ms = state.failed_at + floor_ms - _now_ms()
    return math.ceil(opens_in_ms) + FLOOR_MARGIN_MS if opens_in_ms > 0 else 0


# ------------------------------------------------------------------------------------------------
# Checks before any request.
# ------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Plan:
    entries: tuple[tuple[str, str], ...]
    label: str
    fingerprint: str


def _validate(options: HydrateOptions) -> _Plan:
    if not isinstance(options, HydrateOptions):
        raise ConfigInputError(f"hydrate() needs a HydrateOptions, got {type(options).__name__}")
    plan = _plan_for(options.keys, options.label)
    # NaN would make every floor comparison false: the quota invariant failing open.
    if options.retry_floor_ms is not None:
        _non_negative_ms("retry_floor_ms", options.retry_floor_ms)
    if options.timeout_ms is not None:
        timeout_ms = _positive_ms("timeout_ms", options.timeout_ms)
        if timeout_ms > MAX_TIMER_MS:
            raise ConfigInputError(
                f"timeout_ms must be at most {MAX_TIMER_MS}, got {options.timeout_ms!r}"
            )
    connection_string, endpoint = _address(options)
    if not connection_string and not endpoint:
        raise ConfigInputError(
            "Neither APP_CONFIG_ENDPOINT nor APP_CONFIG_CONNECTION_STRING is set"
        )
    return plan


def _address(options: HydrateOptions) -> tuple[str | None, str | None]:
    connection_string = options.connection_string
    if connection_string is None:
        connection_string = os.environ.get("APP_CONFIG_CONNECTION_STRING")
    endpoint = (
        options.endpoint if options.endpoint is not None else os.environ.get("APP_CONFIG_ENDPOINT")
    )
    return connection_string, endpoint


def _plan_for(keys: KeyMap, label_option: str | None) -> _Plan:
    """The half of `_validate` that identifies a call, shared with `hydration_status`."""
    if not isinstance(keys, Mapping):
        raise ConfigInputError("keys must be a mapping of store key to environment variable name")
    entries = tuple(keys.items())
    if not entries:
        raise ConfigInputError("hydrate() was called with no keys")
    for key, variable in entries:
        if not isinstance(key, str) or not isinstance(variable, str):
            raise ConfigInputError("keys must map store keys (str) to variable names (str)")
        # Invariant 4, enforced: one selector per key, never a filter. A wildcard reaches the
        # provider as a wildcard selector and resolves every Key Vault reference behind it; a
        # comma is the same thing spelled differently. Escaped, `\*` and `\,` match themselves.
        if _has_filter_character(key):
            raise ConfigInputError(
                f"Key \"{key}\" is a filter, not a key: unescaped '*' and ',' are not allowed, "
                "and keys must be listed one by one, because every Key Vault reference the "
                "provider loads it also resolves"
            )
        # The SDK sends an empty key filter as `key=`, a filter this package cannot vouch for;
        # a store key is never empty.
        if key == "":
            raise ConfigInputError("An empty key is not a key: keys must be listed one by one")
        # os.environ refuses these at write time, which would break all-or-nothing halfway.
        if variable == "" or "=" in variable or "\x00" in variable:
            raise ConfigInputError(
                f'Variable name "{variable}" for key "{key}" cannot be set in the environment'
            )
    label = label_option if label_option is not None else os.environ.get("APP_CONFIG_LABEL")
    if not label:
        raise ConfigInputError('APP_CONFIG_LABEL is not set (expected "prod" or "staging")')
    # Exactly one label. The provider's REST filter reads these as filters, escaped or not.
    if "*" in label or "," in label:
        raise ConfigInputError(
            f"Label \"{label}\" is a filter, not a label: '*' and ',' are not allowed, and "
            "exactly one label is read"
        )
    return _Plan(entries=entries, label=label, fingerprint=_fingerprint(entries, label))


def _has_filter_character(text: str) -> bool:
    """Whether `text` holds `*` or `,` as a filter character: one preceded by an even number of
    backslashes. `\\*` and `\\,` are part of a key, not a filter."""
    backslashes = 0
    for character in text:
        if character == "\\":
            backslashes += 1
            continue
        if character in "*," and backslashes % 2 == 0:
            return True
        backslashes = 0
    return False


def _unescape_key(key_filter: str) -> str:
    """The key the store files a setting under, for a filter with escapes in it."""
    out: list[str] = []
    index = 0
    while index < len(key_filter):
        character = key_filter[index]
        if character == "\\" and index + 1 < len(key_filter) and key_filter[index + 1] in "\\*,":
            out.append(key_filter[index + 1])
            index += 2
            continue
        out.append(character)
        index += 1
    return "".join(out)


def _fingerprint(entries: tuple[tuple[str, str], ...], label: str) -> str:
    """Order-insensitive: two modules listing the same keys differently share one attempt."""
    return json.dumps([label, sorted(entries)])


def _number_ms(name: str, value: object, rule: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigInputError(
            f"{name} must be a finite number of milliseconds{rule}, got {value!r}"
        )
    try:
        number = float(value)
    except OverflowError:
        number = math.inf
    if not math.isfinite(number):
        raise ConfigInputError(
            f"{name} must be a finite number of milliseconds{rule}, got {value!r}"
        )
    return number


def _non_negative_ms(name: str, value: object) -> float:
    number = _number_ms(name, value, ", 0 or more")
    if number < 0:
        raise ConfigInputError(
            f"{name} must be a finite number of milliseconds, 0 or more, got {value!r}"
        )
    return number


def _positive_ms(name: str, value: object) -> float:
    number = _number_ms(name, value, " above 0")
    if number <= 0:
        raise ConfigInputError(
            f"{name} must be a finite number of milliseconds above 0, got {value!r}"
        )
    return number


# ------------------------------------------------------------------------------------------------
# The attempt: read, decide precedence, write all or nothing, log.
# ------------------------------------------------------------------------------------------------


def _precedence(option: object) -> tuple[bool, str]:
    """Which side wins this attempt, and why. By truthiness, as the TypeScript half's `??` and
    `Boolean()`: the string "false" is truthy, so local wins and the line says `true`. `None`
    falls through to the platform signal, read now; an empty `WEBSITE_INSTANCE_ID` is absent."""
    if option is not None:
        local_wins = bool(option)
        return local_wins, f"local_overrides_win option {'true' if local_wins else 'false'}"
    local_wins = not os.environ.get("WEBSITE_INSTANCE_ID")
    return local_wins, f"WEBSITE_INSTANCE_ID {'absent' if local_wins else 'present'}"


def _attempt_hydration(
    plan: _Plan, options: HydrateOptions, credential: Any
) -> tuple[HydrationResult, list[str]]:
    """Read, decide precedence, write. Returns the result and the lines to log; the caller logs
    them once the attempt is settled."""
    config = _load_store(plan, options, credential)
    try:
        local_wins, reason = _precedence(options.local_overrides_win)
        unusable: list[str] = []
        writes: list[tuple[str, str]] = []
        kept: list[str] = []
        for key, variable in plan.entries:
            # Precedence first: on a developer machine a local value may stand in for a key the
            # store has not got yet, which is the point of the inversion.
            local = os.environ.get(variable)
            if local_wins and local:
                kept.append(variable)
                continue
            value = config.get(_unescape_key(key))
            if value is None or value == "":
                unusable.append(f"{key} (label {plan.label}, absent or empty)")
                continue
            # A JSON content type comes back parsed; an environment variable is a string.
            if not isinstance(value, str):
                unusable.append(
                    f"{key} (label {plan.label}, {_type_name(value)} rather than a string)"
                )
                continue
            if "\x00" in value:
                unusable.append(f"{key} (label {plan.label}, holds a NUL character)")
                continue
            writes.append((variable, value))
        if unusable:
            # Every name at once, and nothing written: the environment is as it was.
            raise LookupError(f"Missing key-values in App Configuration: {', '.join(unusable)}")
        _write_all(writes)
    finally:
        _close(config)

    applied = [variable for variable, _ in writes]
    lines = [
        f"Configuration loaded from App Configuration, label {plan.label}: "
        f"{', '.join(applied) or 'nothing'} ({'local' if local_wins else 'store'} wins: {reason})"
    ]
    if kept:
        lines.append(f"Kept from the local environment: {', '.join(kept)}")
    result = HydrationResult(
        label=plan.label, applied=tuple(applied), kept=tuple(kept), loaded_at=_now_ms()
    )
    return result, lines


def _write_all(writes: list[tuple[str, str]]) -> None:
    """All or nothing. Every entry was checked first; a write that still fails restores the ones
    before it, so a raise means the environment is as it was."""
    previous = {variable: os.environ.get(variable) for variable, _ in writes}
    written: list[str] = []
    try:
        for variable, value in writes:
            os.environ[variable] = value
            written.append(variable)
    except BaseException:
        for variable in written:
            before = previous[variable]
            if before is None:
                os.environ.pop(variable, None)
            else:
                os.environ[variable] = before
        raise


def _type_name(value: object) -> str:
    if isinstance(value, list):
        return "a JSON array"
    if isinstance(value, dict):
        return "a JSON object"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    return f"a {type(value).__name__}"


def _close(config: object) -> None:
    close = getattr(config, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


# ------------------------------------------------------------------------------------------------
# The load, bounded.
# ------------------------------------------------------------------------------------------------


class _Outcome:
    """What the load thread produced. `abandoned` is set when the bound fired first: the thread
    then closes whatever it gets and touches nothing else."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.value: Any = None
        self.error: BaseException | None = None
        self.abandoned = False


def _run_bounded(call: Callable[[], Any], timeout_s: float) -> _Outcome | None:
    """Run `call` on a daemon thread and wait at most `timeout_s`. `None` if the bound won.

    The provider checks `startup_timeout` only between passes, so a pass whose request hangs is
    not bounded by it. Only this thread ever touches the value: the environment is written by the
    caller, after this returns, so a load that finishes late cannot write anything.
    """
    outcome = _Outcome()

    def run() -> None:
        try:
            value = call()
        except BaseException as error:
            outcome.error = error
        else:
            with outcome.lock:
                if outcome.abandoned:
                    _close(value)
                else:
                    outcome.value = value
        finally:
            outcome.done.set()

    thread = threading.Thread(target=run, name="azure-app-config-load", daemon=True)
    thread.start()
    if outcome.done.wait(timeout_s):
        return outcome
    with outcome.lock:
        outcome.abandoned = True
        late = outcome.value
        outcome.value = None
    if late is not None:
        _close(late)
    return None


def _client_limits(timeout_s: float) -> dict[str, Any]:
    """The limits every store and vault client gets, so a load this call gave up on ends.

    - `retry_total=0`: no SDK retries, and so no `Retry-After` sleep, which azure-core does not cap
      (`azure/core/pipeline/policies/_retry.py:453-470`). The provider pops it for the store
      clients (`_azureappconfigurationprovider.py:86`) and passes it per operation too
      (`_utils.py:133-164`). Within an attempt the provider's own client back-off (30 s) already
      stops a second pass, so a failure costs one request per selector at most.
    - `connection_timeout` and `read_timeout` at twice the bound: a request still in flight when
      the bound fires is reported as in flight, not raced by its own read timeout. `read_timeout`
      is per socket read, so a server trickling bytes is not bounded by it.
    """
    return {"retry_total": 0, "connection_timeout": timeout_s * 2, "read_timeout": timeout_s * 2}


class _EveryVault(dict[str, dict[str, Any]]):
    """`keyvault_client_configs` with one config for every vault. The provider builds a vault's
    `SecretClient` from `configs.get(vault_url, {})` and pops `credential` from it
    (`_key_vault/_secret_provider.py:48-56`), so each lookup returns a fresh copy. Empty as a dict,
    so the provider's other reads of it are unchanged; the Key Vault credential still comes from
    `keyvault_credential`."""

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__()
        self._config = config

    def get(self, key: str, default: Any = None) -> dict[str, Any]:
        return dict(self._config)


def _load_store(plan: _Plan, options: HydrateOptions, credential: Any) -> Any:
    keys = [key for key, _ in plan.entries]
    connection_string, endpoint = _address(options)
    timeout_ms = float(options.timeout_ms) if options.timeout_ms is not None else DEFAULT_TIMEOUT_MS
    timeout_s = timeout_ms / 1000
    diagnostics = DiagnosticsPolicy()
    load_kwargs: dict[str, Any] = {
        "selects": [
            _provider.SettingSelector(key_filter=key, label_filter=plan.label) for key in keys
        ],
        # The Key Vault client gets the caller's credential unchanged; only the store's is watched.
        "keyvault_credential": credential,
        "startup_timeout": timeout_s,
        # Forwarded to every store client the provider builds; below the SDK's retry policy.
        "per_retry_policies": [diagnostics],
        # What bounds a load this call has given up on: see _client_limits().
        **_client_limits(timeout_s),
        "keyvault_client_configs": _EveryVault(_client_limits(timeout_s)),
    }
    watch = None if connection_string else watch_credential(credential)

    def call() -> Any:
        # Looked up at call time, so a test that replaces the provider's `load` reaches this.
        if watch is None:
            # The access-key path, for a run with no identity to borrow.
            return _provider.load(connection_string=connection_string, **load_kwargs)
        return _provider.load(str(endpoint), watch, **load_kwargs)

    outcome = _run_bounded(call, timeout_s)
    # Counted the moment the bound fired, or when the load raised: a request answered later must
    # not turn "in flight at the timeout" into "answered".
    traffic = diagnostics.traffic()
    if outcome is not None and outcome.error is None:
        return outcome.value

    where = "the configured connection string" if connection_string else endpoint
    message = f"Could not read App Configuration at {where}, label {plan.label}"
    observations = diagnostics.observations()
    credential_evidence = watch.evidence() if watch is not None else None
    wire = WireEvidence(traffic=traffic, selectors=len(keys), at_timeout=outcome is None)

    if outcome is None:
        shown = _number_text(timeout_ms)
        cause: BaseException = TimeoutError(
            f"The load did not finish within the startup timeout (timeout_ms {shown})."
        )
        detail, status = explain(None, observations, credential_evidence, wire, timed_out_ms=shown)
        raise ConfigLoadError(
            message, detail, status_code=status, observations=observations, cause=cause
        )

    assert outcome.error is not None
    error = outcome.error
    if not isinstance(error, Exception):
        raise error
    untouched = traffic.sent == 0 and not (credential_evidence and credential_evidence.requested)
    if untouched and argument_error_in_chain(error):
        # The provider refused an argument before any network activity: no token asked for, no
        # request seen. Anything later is a load error, whatever its class — a transient failure
        # can arrive as a ValueError, and a ConfigInputError would stop every retry for good. So
        # reached_store is always False here, kept for the TypeScript half's shape.
        detail, _ = explain(error, observations, credential_evidence, wire)
        raise ConfigInputError(f"{message}: {detail}", error, reached_store=traffic.answered > 0)
    detail, status = explain(error, observations, credential_evidence, wire)
    raise ConfigLoadError(
        message, detail, status_code=status, observations=observations, cause=error
    )


def _number_text(value: float) -> str:
    """A number as JavaScript prints it — `5`, not `5.0` — so lines match the TypeScript half."""
    if float(value).is_integer():
        return str(int(value))
    return repr(float(value))


def _seconds(ms: float) -> str:
    return _number_text(ms / 1000)


def _sleep(ms: float) -> None:
    """Sleep in steps of at most 2**31 - 1 ms, so a huge floor's wait cannot overflow or spin."""
    remaining = ms
    while True:
        step = min(max(remaining, 0), MAX_TIMER_MS)
        _sleep_ms(step)
        remaining -= step
        if remaining <= 0:
            return


# ------------------------------------------------------------------------------------------------
# Logging. Never allowed to change the outcome.
# ------------------------------------------------------------------------------------------------


def _logger_of(options: object) -> Any:
    target = getattr(options, "logger", None)
    return target if target is not None else logging.getLogger(DEFAULT_LOGGER_NAME)


def _call_logger(method: Any, line: str) -> None:
    returned = method(line)
    # An async logger's coroutine cannot be awaited here; close it rather than leak a warning.
    if inspect.iscoroutine(returned):
        returned.close()


def _report_failure(options: object, line: str) -> None:
    """A failure line through the logger's `error`, else its `info`. A logger that raises, or
    a broken `logger` attribute, is swallowed: the caller still gets the load's own error."""
    try:
        target = _logger_of(options)
        method = getattr(target, "error", None)
        if not callable(method):
            method = target.info
        _call_logger(method, line)
    except Exception:
        pass


def _report_success(options: object, lines: list[str]) -> None:
    """The success line through `info`. Guarded too: the environment is already written, and a
    raise here would report a failure that left it changed."""
    try:
        target = _logger_of(options)
        for line in lines:
            _call_logger(target.info, line)
    except Exception:
        pass


def _report_once_per_message(
    state: _State, options: object, error: BaseException, emit: Callable[[_Line], None]
) -> None:
    """Claimed now, on the calling thread, so two calls cannot both claim the message; written
    when `emit` writes it."""
    line = message_of(error)
    with _lock:
        if line in state.reported_input_errors:
            return
        state.reported_input_errors.add(line)
    report = f"Configuration load failed: {line}"
    emit(functools.partial(_report_failure, options, report))


def _write_now(line: _Line) -> None:
    """The sink of the sync callers: the line is written where it is decided, on this thread."""
    line()


def _write(lines: list[_Line]) -> None:
    for line in lines:
        line()
