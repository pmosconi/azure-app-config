"""The three error classes.

The cause is carried as `__cause__` on all three, the Python idiom, and never as a separate
attribute: `ConfigLoadError.__cause__` is the provider's error unmodified,
`ConfigInputError.__cause__` the provider's error when the provider raised it (else `None`), and
`ConfigFloorError.__cause__` the error of the attempt that armed the floor. No brands and no
registry: a Python process imports a module once, so there is one set of classes and `isinstance`
needs no help.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

from ._types import FailureObservation

FLOOR_MARGIN_MS = 50
"""Added to every wait so that a caller who waits exactly that long lands outside the floor. A
timer can fire a little early, and a retry a millisecond inside the floor is another
`ConfigFloorError` — for a message handler, the dead-letter path. The floor is enforced exactly.
Unexported: `retry_after_ms()` and `ConfigFloorError.retry_after_ms` are where it is added."""


def message_of(error: BaseException | None) -> str:
    """The text of an error for a log line or a message: never raises, never empty."""
    if error is None:
        return "None"
    try:
        text = str(error)
    except Exception:
        return "an error that could not be described"
    return text or type(error).__name__


def _chain(error: BaseException, cause: BaseException | None) -> None:
    if cause is not None:
        error.__cause__ = cause
        error.__suppress_context__ = True


class ConfigInputError(Exception):
    """A call no retry can fix: waiting won't help, a change to the call or to the store will.

    An unescaped `*` or `,` in a key, an empty key map, no label, a label with `*` or `,`, no
    endpoint, a timing option that is not a usable number, or an argument the provider refused
    before any network activity. Anything that fails later is a `ConfigLoadError`, whatever its
    class. `hydrate_with_backoff` re-raises it rather than looping.

    `reached_store` says whether the store had answered a request before the input was refused;
    `True` would arm the retry floor. Since an input error is refused before any network activity
    by definition, it is always `False` here — kept, defensively, for the TypeScript half's shape.
    """

    reached_store: bool

    def __init__(
        self, message: str, cause: BaseException | None = None, reached_store: bool = False
    ) -> None:
        super().__init__(message)
        self.reached_store = reached_store
        _chain(self, cause)


class ConfigFloorError(Exception):
    """A call `hydrate()` refused to make because the retry floor is closed. Nothing was sent.

    Deliberately neither a `ConfigLoadError` — nothing was attempted, and a count of load failures
    must not count it — nor a `ConfigInputError`, so `hydrate_with_backoff` waits it out.
    `retry_after_ms` is the time until the floor opens by this call's `retry_floor_ms`, rounded up,
    plus a 50 ms margin. `__cause__` is the error of the attempt that armed the floor.

    In a message-triggered handler, a bare re-raise abandons the message, the broker redelivers it
    at once, and every redelivery fails the same way: wait `retry_after_ms`, try once more, and
    only then give up. See the README.
    """

    retry_after_ms: int

    def __init__(self, opens_in_ms: float, last_error: BaseException | None) -> None:
        super().__init__(
            "App Configuration not attempted: the retry floor opens in "
            f"{math.ceil(opens_in_ms / 1000)}s. The last attempt failed: {message_of(last_error)}"
        )
        self.retry_after_ms = max(0, math.ceil(opens_in_ms)) + FLOOR_MARGIN_MS
        _chain(self, last_error)


class ConfigLoadError(Exception):
    """A load that failed, with the reason.

    `str(error)` names the store and label and carries the reason. `detail` is the reason: what
    the provider preserved where it preserved something real, otherwise what the diagnostics
    policy saw on the wire. `status_code` is the HTTP status where one was seen. `observations` is
    every distinct failure seen on the store's wire during the attempt. `__cause__` is the
    provider's error, unmodified.
    """

    detail: str
    status_code: int | None
    observations: tuple[FailureObservation, ...]

    def __init__(
        self,
        message: str,
        detail: str,
        *,
        status_code: int | None = None,
        observations: Iterable[FailureObservation] = (),
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(f"{message}: {detail}")
        self.detail = detail
        self.status_code = status_code
        self.observations = tuple(observations)
        _chain(self, cause)
