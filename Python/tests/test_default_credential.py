"""The package's own DefaultAzureCredential: created outside the lock and before any attempt, so a
logging handler that calls into the package while the constructor logs cannot deadlock."""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from typing import Any

import azure.identity
import pytest
from helpers import KEYS, FakeLoad, options, returns

from azure_app_config import ConfigLoadError, HydrationStatus, _core, hydrate, hydration_status

pytestmark = pytest.mark.unit

# Captured at import, before conftest swaps in a stub: the real constructor logs at INFO through
# azure.identity ("No environment configuration found.", "ManagedIdentityCredential will use
# IMDS"), which is what makes a handler run on the calling thread. It makes no request.
REAL_DEFAULT_CREDENTIAL = azure.identity.DefaultAzureCredential


@pytest.fixture
def identity_handler() -> Iterator[list[Any]]:
    """Installs a handler on the azure.identity logger; yields the list it fills."""
    seen: list[Any] = []
    holder: dict[str, Any] = {}
    logger = logging.getLogger("azure.identity")
    level = logger.level

    class CallsIn(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            seen.append(hydration_status(KEYS))
            try:
                seen.append(hydrate(holder["options"]))
            except Exception as error:
                seen.append(error)

    handler = CallsIn()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    seen.append(holder)
    yield seen
    logger.removeHandler(handler)
    logger.setLevel(level)


def test_a_handler_calling_in_while_the_credential_is_built_returns(
    fake_load: FakeLoad, monkeypatch: pytest.MonkeyPatch, identity_handler: list[Any]
) -> None:
    monkeypatch.setattr("azure.identity.DefaultAzureCredential", REAL_DEFAULT_CREDENTIAL)
    fake_load.behaviour = returns(answered=False)  # no request, so the real credential is idle
    holder = identity_handler.pop(0)
    holder["options"] = options()
    outcome: list[Any] = []
    thread = threading.Thread(
        target=lambda: outcome.append(hydrate(holder["options"])), daemon=True
    )
    thread.start()
    thread.join(5)
    assert not thread.is_alive(), "the constructor's log line deadlocked a handler"
    assert outcome and outcome[0].applied == tuple(KEYS.values())
    assert identity_handler, "the real constructor logged nothing: the test proves nothing"
    statuses = [s for s in identity_handler if isinstance(s, HydrationStatus)]
    reentrant = [s for s in identity_handler if not isinstance(s, HydrationStatus)]
    assert statuses and all(s.state == "none" for s in statuses)
    # A re-entrant hydrate() on the constructing thread cannot be given a credential: it raises,
    # and nothing was attempted for it.
    assert reentrant and all(isinstance(e, ConfigLoadError) for e in reentrant)
    assert "creating the default credential" in str(reentrant[0])
    assert fake_load.count == 1
    assert isinstance(fake_load.kwargs()["keyvault_credential"], REAL_DEFAULT_CREDENTIAL)


def test_two_threads_racing_to_build_it_share_the_winner_and_close_the_loser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    both_building = threading.Barrier(2, timeout=5)
    made: list[Any] = []

    class Slow:
        def __init__(self) -> None:
            self.closed = False
            made.append(self)
            both_building.wait()  # neither installs until both have built one

        def close(self) -> None:
            self.closed = True

    monkeypatch.setattr("azure.identity.DefaultAzureCredential", Slow)
    got: list[Any] = []
    threads = [
        threading.Thread(target=lambda: got.append(_core._ensure_default_credential()))
        for _ in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    assert len(made) == 2
    assert got[0] is got[1]
    winner = got[0]
    loser = made[1] if made[0] is winner else made[0]
    assert loser.closed and not winner.closed
    assert _core._state.default_credential is winner
