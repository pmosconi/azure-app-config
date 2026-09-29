"""Threads, the async wrapper, and the bound on one attempt.

Joiners are real threads, released by events once every one of them is waiting on the attempt —
never by a sleep that hopes they got there.
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest
from helpers import (
    KEYS,
    VALUES,
    Behaviour,
    Clock,
    FakeLoad,
    StubCredential,
    Wire,
    blocks,
    fails_on_wire,
    hangs,
    http_error,
    options,
    provider_timeout,
    returns,
    wait_until,
)

from azure_app_config import (
    ConfigFloorError,
    ConfigLoadError,
    HydrationResult,
    hydrate,
    hydrate_async,
    hydration_status,
    reset_hydration,
)

pytestmark = pytest.mark.unit


def refused() -> Behaviour:
    return fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))


def run_joined(
    fake_load: FakeLoad,
    outcome: Behaviour,
    joiners: int,
    arm: Callable[[int], threading.Event],
) -> tuple[list[Any], list[threading.Thread]]:
    """One caller starts an attempt that holds until every joiner is waiting on it."""
    gate, started = threading.Event(), threading.Event()
    fake_load.behaviour = blocks(gate, outcome, started)
    results: list[Any] = []
    lock = threading.Lock()

    def call() -> None:
        try:
            value: Any = hydrate(options())
        except BaseException as error:
            value = error
        with lock:
            results.append(value)

    everyone = arm(joiners)
    threads = [threading.Thread(target=call)]
    threads[0].start()
    assert started.wait(5)
    threads += [threading.Thread(target=call) for _ in range(joiners)]
    for thread in threads[1:]:
        thread.start()
    if joiners:
        assert everyone.wait(5)
    gate.set()
    for thread in threads:
        thread.join(5)
    return results, threads


class TestJoiners:
    def test_joiners_in_other_threads_receive_the_identical_exception_object(
        self, fake_load: FakeLoad, joiners_waiting: Callable[[int], threading.Event]
    ) -> None:
        results, _ = run_joined(fake_load, refused(), 7, joiners_waiting)
        assert len(results) == 8
        assert isinstance(results[0], ConfigLoadError)
        assert all(result is results[0] for result in results)
        assert fake_load.count == 1

    def test_joiners_receive_the_identical_success(
        self, fake_load: FakeLoad, joiners_waiting: Callable[[int], threading.Event]
    ) -> None:
        results, _ = run_joined(fake_load, returns(), 5, joiners_waiting)
        assert isinstance(results[0], HydrationResult)
        assert all(result is results[0] for result in results)
        assert fake_load.count == 1


def traceback_length(error: BaseException) -> int:
    length, tb = 0, error.__traceback__
    while tb is not None:
        length, tb = length + 1, tb.tb_next
    return length


def test_joiners_do_not_pile_their_frames_onto_the_shared_exception(
    fake_load: FakeLoad, joiners_waiting: Callable[[int], threading.Event]
) -> None:
    # Every joiner re-raises the identical object. Its traceback must hold one caller's frames,
    # as a lone failure's does, not every joiner's frames and locals, which last_error and
    # ConfigFloorError.__cause__ would retain.
    [alone], _ = run_joined(fake_load, refused(), 0, joiners_waiting)
    reset_hydration()
    results, _ = run_joined(fake_load, refused(), 6, joiners_waiting)
    assert all(result is results[0] for result in results)
    assert traceback_length(results[0]) == traceback_length(alone)


class TestAsync:
    def test_shares_the_memo_with_hydrate(self, fake_load: FakeLoad) -> None:
        first = hydrate(options())
        second = asyncio.run(hydrate_async(options()))
        assert second is first
        assert fake_load.count == 1

    def test_hydrate_shares_the_memo_of_hydrate_async(self, fake_load: FakeLoad) -> None:
        first = asyncio.run(hydrate_async(options()))
        assert hydrate(options()) is first
        assert fake_load.count == 1

    def test_shares_the_floor_with_hydrate(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options())
        with pytest.raises(ConfigFloorError) as floor:
            asyncio.run(hydrate_async(options()))
        assert floor.value.__cause__ is caught.value
        assert fake_load.count == 1

    def test_joins_an_attempt_a_sync_caller_started_and_gets_the_identical_error(
        self, fake_load: FakeLoad, joiners_waiting: Callable[[int], threading.Event]
    ) -> None:
        everyone = joiners_waiting(1)
        gate, started = threading.Event(), threading.Event()
        fake_load.behaviour = blocks(gate, refused(), started)
        sync_result: list[BaseException] = []

        def sync_call() -> None:
            try:
                hydrate(options())
            except BaseException as error:
                sync_result.append(error)

        thread = threading.Thread(target=sync_call)
        thread.start()
        assert started.wait(5)

        async def joined() -> BaseException:
            task = asyncio.ensure_future(hydrate_async(options()))
            assert await asyncio.to_thread(everyone.wait, 5)
            gate.set()
            try:
                await task
            except BaseException as error:
                return error
            raise AssertionError("expected a failure")

        async_error = asyncio.run(joined())
        thread.join(5)
        assert async_error is sync_result[0]
        assert fake_load.count == 1

    def test_runs_concurrent_async_callers_as_one_attempt(self, fake_load: FakeLoad) -> None:
        async def many() -> list[HydrationResult]:
            return list(await asyncio.gather(*(hydrate_async(options()) for _ in range(10))))

        results = asyncio.run(many())
        assert all(result is results[0] for result in results)
        assert fake_load.count == 1


class TestTheBoundOnOneAttempt:
    """The provider checks `startup_timeout` only between passes; `timeout_ms` bounds the call."""

    def test_raises_within_timeout_ms_while_the_load_is_still_blocked(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        fake_load.behaviour = hangs(release, request=False)
        began = time.monotonic()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(timeout_ms=150, credential=StubCredential()))
        elapsed = time.monotonic() - began
        assert 0.14 <= elapsed < 2
        assert "did not finish within the startup timeout (timeout_ms 150)" in caught.value.detail
        assert isinstance(caught.value.__cause__, TimeoutError)

    def test_a_load_that_succeeds_after_the_bound_writes_nothing_and_is_closed(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        release = threading.Event()
        finished = threading.Event()
        inner = hangs(release, request=False)

        def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            try:
                return inner(args, kwargs)
            finally:
                finished.set()

        fake_load.behaviour = behaviour
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        with pytest.raises(ConfigLoadError):
            hydrate(options(timeout_ms=50))
        status_before = hydration_status(KEYS)
        release.set()
        assert finished.wait(5)
        wait_until(lambda: bool(fake_load.configs) and fake_load.configs[0].closed)
        for variable in KEYS.values():
            assert variable not in os.environ
        assert hydration_status(KEYS) == status_before
        assert status_before.state == "failing"

    def test_a_load_that_fails_after_the_bound_moves_nothing(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        release = threading.Event()
        finished = threading.Event()
        inner = hangs(release, request=False, then=provider_timeout(http_error(403)))

        def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            try:
                return inner(args, kwargs)
            finally:
                finished.set()

        fake_load.behaviour = behaviour
        logger_lines: list[str] = []

        class Logger:
            def info(self, message: str) -> None:
                logger_lines.append(message)

        with pytest.raises(ConfigLoadError):
            hydrate(options(timeout_ms=50, logger=Logger()))
        before = hydration_status(KEYS)
        clock.advance(10)
        release.set()
        assert finished.wait(5)
        assert hydration_status(KEYS) == before
        assert len(logger_lines) == 1

    def test_a_load_that_finishes_inside_the_bound_is_used(self, fake_load: FakeLoad) -> None:
        release = threading.Event()
        release.set()
        fake_load.behaviour = hangs(release, request=False, then=VALUES)
        assert hydrate(options(timeout_ms=5_000)).applied == tuple(KEYS.values())
