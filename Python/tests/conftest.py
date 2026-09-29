"""Every test starts from a clean package state and a known environment, and leaves both as it
found them. The provider's `load()` is replaced at the module boundary — the attribute the package
looks up at call time — so no test reaches Azure."""

from __future__ import annotations

import dataclasses
import os
import threading
from collections.abc import Callable, Iterator

import pytest
from helpers import ENDPOINT, KEYS, Clock, FakeLoad, StubCredential

import azure_app_config
from azure_app_config import _core


@pytest.fixture(autouse=True)
def clean_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    saved = dict(os.environ)
    azure_app_config.reset_hydration()
    for name in [
        *KEYS.values(),
        "WEBSITE_INSTANCE_ID",
        "APP_CONFIG_CONNECTION_STRING",
        "APP_CONFIG_ENDPOINT",
        "APP_CONFIG_LABEL",
        "NODE_ENV",
    ]:
        os.environ.pop(name, None)
    os.environ["APP_CONFIG_ENDPOINT"] = ENDPOINT
    os.environ["APP_CONFIG_LABEL"] = "prod"
    # The default credential would go looking for a real identity.
    monkeypatch.setattr("azure.identity.DefaultAzureCredential", StubCredential)
    yield
    azure_app_config.reset_hydration()
    os.environ.clear()
    os.environ.update(saved)


@pytest.fixture
def fake_load(monkeypatch: pytest.MonkeyPatch) -> FakeLoad:
    fake = FakeLoad()
    monkeypatch.setattr("azure.appconfiguration.provider.load", fake)
    return fake


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr(_core, "_now_ms", fake.now_ms)
    monkeypatch.setattr(_core, "_sleep_ms", fake.sleep_ms)
    return fake


@pytest.fixture
def release() -> Iterator[threading.Event]:
    """Released at teardown, so a thread a test left blocked always ends."""
    event = threading.Event()
    yield event
    event.set()


@pytest.fixture
def joiners_waiting(monkeypatch: pytest.MonkeyPatch) -> Callable[[int], threading.Event]:
    """Arms a count of callers waiting on an attempt: returns an event set once `expected` of
    them are blocked on it. Only joiners wait on an attempt's `done`; the starter settles it."""

    def arm(expected: int) -> threading.Event:
        everyone = threading.Event()
        lock = threading.Lock()
        waiting = [0]

        class CountingEvent(threading.Event):
            def wait(self, timeout: float | None = None) -> bool:
                with lock:
                    waiting[0] += 1
                    if waiting[0] >= expected:
                        everyone.set()
                return super().wait(timeout)

        @dataclasses.dataclass(eq=False)
        class CountedAttempt(_core._Attempt):
            done: threading.Event = dataclasses.field(default_factory=CountingEvent)

        monkeypatch.setattr(_core, "_Attempt", CountedAttempt)
        return everyone

    return arm
