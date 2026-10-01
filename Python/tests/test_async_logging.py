"""`hydrate_async` writes its lines on the event loop — 1.0.0, `BACKLOG.md` item 27.

The attempt runs on a worker thread (`asyncio.to_thread`), but the Azure Functions Python worker
does not tie a record written there to the invocation and drops it: an async handler's success
line never reached the host's logs, in production. So the lines are written on the caller's side,
after the `await`, on the event loop — the invocation's own context, as it is for a sync handler.
The rules are the sync path's: one line per attempt, by the call that started it; none for a
joiner, a memo hit or a `ConfigFloorError`; a pre-request rejection once per distinct message; a
logger that raises changes nothing.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
import threading
from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from helpers import (
    KEYS,
    VALUES,
    Behaviour,
    Clock,
    FakeLoad,
    RaisingLogger,
    Wire,
    blocks,
    fails_on_wire,
    http_error,
    options,
    provider_timeout,
    raises,
    returns,
    wait_until,
)

from azure_app_config import (
    ConfigFloorError,
    ConfigInputError,
    ConfigLoadError,
    HydrationResult,
    hydrate,
    hydrate_async,
    hydration_status,
)

pytestmark = pytest.mark.unit

FAILED = "Configuration load failed: "
LOADED = "Configuration loaded from App Configuration, label prod: "


def refused() -> Behaviour:
    return fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))


class ThreadLogger:
    """Records each line with the thread that wrote it."""

    def __init__(self) -> None:
        self.records: list[tuple[str, str, int]] = []
        self._lock = threading.Lock()

    def _record(self, level: str, message: str) -> None:
        with self._lock:
            self.records.append((level, message, threading.get_ident()))

    def info(self, message: str) -> None:
        self._record("info", message)

    def error(self, message: str) -> None:
        self._record("error", message)

    @property
    def lines(self) -> list[str]:
        return [line for _, line, _ in self.records]

    @property
    def threads(self) -> set[int]:
        return {thread for _, _, thread in self.records}


def on_loop(
    make: Callable[[], Coroutine[Any, Any, Any]],
) -> tuple[Any, int]:
    """Runs `make()` under `asyncio.run` and returns what it returned or raised, with the event
    loop's thread."""

    async def main() -> tuple[Any, int]:
        loop_thread = threading.get_ident()
        try:
            value: Any = await make()
        except BaseException as error:
            value = error
        return value, loop_thread

    return asyncio.run(main())


def recording_thread(fake_load: FakeLoad) -> list[int]:
    """Wraps the fake load's behaviour to record the thread the attempt ran on."""
    seen: list[int] = []
    inner = fake_load.behaviour

    def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        seen.append(threading.get_ident())
        return inner(args, kwargs)

    fake_load.behaviour = behaviour
    return seen


class TestTheLinesAreWrittenOnTheEventLoop:
    def test_the_success_line_on_the_loop_while_the_attempt_runs_elsewhere(
        self, fake_load: FakeLoad
    ) -> None:
        load_threads = recording_thread(fake_load)
        logger = ThreadLogger()
        result, loop_thread = on_loop(lambda: hydrate_async(options(logger=logger)))
        assert isinstance(result, HydrationResult)
        assert len(logger.records) == 1
        assert logger.lines[0].startswith(LOADED)
        assert logger.threads == {loop_thread}
        # Still off the loop: the attempt itself must not block it.
        assert load_threads and load_threads[0] != loop_thread

    def test_the_kept_line_too(self, fake_load: FakeLoad) -> None:
        os.environ["HTTP_PORT"] = "9000"
        logger = ThreadLogger()
        _, loop_thread = on_loop(
            lambda: hydrate_async(options(logger=logger, local_overrides_win=True))
        )
        assert [line.split(":")[0] for line in logger.lines] == [
            "Configuration loaded from App Configuration, label prod",
            "Kept from the local environment",
        ]
        assert logger.threads == {loop_thread}

    def test_the_failure_line_on_the_loop(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = refused()
        logger = ThreadLogger()
        error, loop_thread = on_loop(lambda: hydrate_async(options(logger=logger)))
        assert isinstance(error, ConfigLoadError)
        assert logger.records == [("error", f"{FAILED}{error}", loop_thread)]

    def test_a_pre_request_rejection_on_the_loop_once_per_message(
        self, fake_load: FakeLoad
    ) -> None:
        logger = ThreadLogger()

        async def three() -> list[BaseException]:
            errors: list[BaseException] = []
            for _ in range(3):
                try:
                    await hydrate_async(options(keys={"shared:*": "ALL"}, logger=logger))
                except BaseException as error:
                    errors.append(error)
            return errors

        errors, loop_thread = on_loop(three)
        assert len(errors) == 3 and all(isinstance(e, ConfigInputError) for e in errors)
        assert len(logger.records) == 1
        assert logger.lines[0].startswith(f'{FAILED}Key "shared:*" is a filter')
        assert logger.threads == {loop_thread}

    def test_the_providers_own_pre_request_error_on_the_loop_once(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = raises(ValueError("Invalid connection string."))
        logger = ThreadLogger()

        async def twice() -> None:
            for _ in range(2):
                with pytest.raises(ConfigInputError):
                    await hydrate_async(options(logger=logger))

        _, loop_thread = on_loop(twice)
        assert fake_load.count == 2
        assert len(logger.records) == 1
        assert logger.threads == {loop_thread}


class TestOneLinePerAttempt:
    def test_concurrent_async_callers_on_one_success_write_one_line(
        self, fake_load: FakeLoad
    ) -> None:
        logger = ThreadLogger()

        async def many() -> list[Any]:
            return list(
                await asyncio.gather(*(hydrate_async(options(logger=logger)) for _ in range(10)))
            )

        results, loop_thread = on_loop(many)
        assert all(result is results[0] for result in results)
        assert fake_load.count == 1
        assert len(logger.records) == 1
        assert logger.threads == {loop_thread}

    def test_concurrent_async_callers_on_one_failure_write_one_line(
        self,
        fake_load: FakeLoad,
        release: threading.Event,
        joiners_waiting: Callable[[int], threading.Event],
    ) -> None:
        everyone = joiners_waiting(5)
        started = threading.Event()
        fake_load.behaviour = blocks(release, refused(), started)
        logger = ThreadLogger()

        async def many() -> list[BaseException]:
            tasks = [asyncio.ensure_future(hydrate_async(options(logger=logger)))]
            assert await asyncio.to_thread(started.wait, 5)
            tasks += [
                asyncio.ensure_future(hydrate_async(options(logger=logger))) for _ in range(5)
            ]
            assert await asyncio.to_thread(everyone.wait, 5)
            release.set()
            return list(await asyncio.gather(*tasks, return_exceptions=True))

        errors, loop_thread = on_loop(many)
        assert fake_load.count == 1
        assert all(isinstance(e, BaseException) and e is errors[0] for e in errors)
        assert logger.records == [("error", f"{FAILED}{errors[0]}", loop_thread)]

    def test_a_floor_rejection_writes_nothing(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        logger = ThreadLogger()

        async def then_floor() -> BaseException:
            with pytest.raises(ConfigLoadError):
                await hydrate_async(options(logger=logger))
            with pytest.raises(ConfigFloorError) as caught:
                await hydrate_async(options(logger=logger))
            return caught.value

        floor, _ = on_loop(then_floor)
        assert isinstance(floor, ConfigFloorError)
        assert len(logger.records) == 1  # the attempt's, not the floor's

    def test_a_memo_hit_writes_nothing(self, fake_load: FakeLoad) -> None:
        logger = ThreadLogger()

        async def twice() -> None:
            await hydrate_async(options(logger=logger))
            await hydrate_async(options(logger=logger))

        on_loop(twice)
        assert fake_load.count == 1
        assert len(logger.records) == 1


class TestLoggingNeverChangesTheOutcome:
    def test_a_raising_logger_leaves_the_success(self, fake_load: FakeLoad) -> None:
        logger = RaisingLogger()
        result, _ = on_loop(lambda: hydrate_async(options(logger=logger)))
        assert isinstance(result, HydrationResult)
        assert logger.calls == 1
        assert os.environ["MONGO_URL"] == VALUES["shared:mongoUrl"]
        assert hydration_status(KEYS).state == "loaded"

    def test_a_raising_logger_leaves_the_loads_own_error(self, fake_load: FakeLoad) -> None:
        thrown = provider_timeout(http_error(403))
        fake_load.behaviour = fails_on_wire(Wire(status=403), thrown)
        logger = RaisingLogger()
        error, _ = on_loop(lambda: hydrate_async(options(logger=logger)))
        assert isinstance(error, ConfigLoadError)
        assert error.__cause__ is thrown
        assert logger.calls == 1

    def test_a_raising_logger_leaves_a_pre_request_rejection(self, fake_load: FakeLoad) -> None:
        error, _ = on_loop(
            lambda: hydrate_async(options(keys={"shared:*": "ALL"}, logger=RaisingLogger()))
        )
        assert isinstance(error, ConfigInputError)


class TestTheSyncPathIsUnchanged:
    def test_hydrate_still_logs_on_its_own_thread(self, fake_load: FakeLoad) -> None:
        logger = ThreadLogger()
        caller: list[int] = []

        def call() -> None:
            caller.append(threading.get_ident())
            hydrate(options(logger=logger))

        thread = threading.Thread(target=call)
        thread.start()
        thread.join(5)
        assert len(logger.records) == 1
        assert logger.threads == {caller[0]}

    def test_hydrate_still_logs_a_failure_on_its_own_thread(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = refused()
        logger = ThreadLogger()
        with pytest.raises(ConfigLoadError):
            hydrate(options(logger=logger))
        assert logger.threads == {threading.get_ident()}


class TestMixedSyncAndAsyncJoiners:
    def test_a_sync_starter_and_an_async_joiner_write_one_line_on_the_sync_thread(
        self, fake_load: FakeLoad, joiners_waiting: Callable[[int], threading.Event]
    ) -> None:
        everyone = joiners_waiting(1)
        gate, started = threading.Event(), threading.Event()
        fake_load.behaviour = blocks(gate, refused(), started)
        logger = ThreadLogger()
        sync_thread: list[int] = []

        def sync_call() -> None:
            sync_thread.append(threading.get_ident())
            with pytest.raises(ConfigLoadError):
                hydrate(options(logger=logger))

        thread = threading.Thread(target=sync_call)
        thread.start()
        assert started.wait(5)

        async def joined() -> None:
            task = asyncio.ensure_future(hydrate_async(options(logger=logger)))
            assert await asyncio.to_thread(everyone.wait, 5)
            gate.set()
            with pytest.raises(ConfigLoadError):
                await task

        on_loop(joined)
        thread.join(5)
        assert fake_load.count == 1
        assert len(logger.records) == 1
        assert logger.threads == {sync_thread[0]}

    def test_an_async_starter_and_a_sync_joiner_write_one_line_on_the_loop(
        self, fake_load: FakeLoad, joiners_waiting: Callable[[int], threading.Event]
    ) -> None:
        everyone = joiners_waiting(1)
        gate, started = threading.Event(), threading.Event()
        fake_load.behaviour = blocks(gate, returns(), started)
        logger = ThreadLogger()
        joined: list[Any] = []

        async def starter() -> Any:
            task = asyncio.ensure_future(hydrate_async(options(logger=logger)))
            assert await asyncio.to_thread(started.wait, 5)
            joiner = threading.Thread(target=lambda: joined.append(hydrate(options(logger=logger))))
            joiner.start()
            assert await asyncio.to_thread(everyone.wait, 5)
            gate.set()
            result = await task
            await asyncio.to_thread(joiner.join, 5)
            return result

        result, loop_thread = on_loop(starter)
        assert joined == [result]
        assert fake_load.count == 1
        assert len(logger.records) == 1
        assert logger.threads == {loop_thread}


class TestCancellation:
    """The attempt is not cancelled with the task that awaited it: it runs to the end and its
    outcome is kept. Its line is still written exactly once — on the event loop if the attempt had
    settled when the cancellation landed, otherwise by the worker thread as it settles, since no
    one is left on the loop to write it."""

    def test_cancelled_while_the_attempt_runs_the_worker_thread_writes_the_line_once(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        started = threading.Event()
        fake_load.behaviour = blocks(release, returns(), started)
        logger = ThreadLogger()

        async def cancel_it() -> BaseException:
            task = asyncio.ensure_future(hydrate_async(options(logger=logger)))
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            try:
                await task
            except BaseException as error:
                cancelled = error
            else:
                raise AssertionError("expected a cancellation")
            assert logger.records == []  # nothing yet: the attempt has not settled
            # Released inside the loop: asyncio.run waits for the pool's threads on the way out.
            release.set()
            await asyncio.to_thread(wait_until, lambda: len(logger.records) == 1)
            return cancelled

        cancelled, loop_thread = on_loop(cancel_it)
        assert isinstance(cancelled, asyncio.CancelledError)
        assert len(logger.records) == 1
        assert logger.lines[0].startswith(LOADED)
        assert loop_thread not in logger.threads
        # The outcome was kept, and is a memo hit that writes nothing more.
        assert hydration_status(KEYS).state == "loaded"
        hydrate(options(logger=logger))
        assert fake_load.count == 1
        assert len(logger.records) == 1

    def test_cancelled_while_the_attempt_fails_the_failure_line_is_still_written_once(
        self, fake_load: FakeLoad, release: threading.Event, clock: Clock
    ) -> None:
        started = threading.Event()
        fake_load.behaviour = blocks(release, refused(), started)
        logger = ThreadLogger()

        async def cancel_it() -> None:
            task = asyncio.ensure_future(hydrate_async(options(logger=logger)))
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert logger.records == []
            release.set()
            await asyncio.to_thread(wait_until, lambda: len(logger.records) == 1)

        _, loop_thread = on_loop(cancel_it)
        assert len(logger.records) == 1
        assert logger.records[0][0] == "error"
        assert logger.lines[0].startswith(FAILED)
        assert loop_thread not in logger.threads
        assert hydration_status(KEYS).state == "failing"
        with pytest.raises(ConfigFloorError):
            hydrate(options(logger=logger))
        assert len(logger.records) == 1

    def test_cancelled_while_still_queued_nothing_is_attempted_written_or_claimed(
        self, fake_load: FakeLoad
    ) -> None:
        # One worker, kept busy, so the calls wait in the pool's queue when they are cancelled.
        logger = ThreadLogger()
        bad = options(keys={"shared:*": "ALL"}, logger=logger)

        async def cancel_queued() -> list[BaseException]:
            loop = asyncio.get_running_loop()
            loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=1))
            busy = threading.Event()
            occupied = loop.run_in_executor(None, busy.wait, 5)
            tasks = [
                asyncio.ensure_future(hydrate_async(options(logger=logger))),
                asyncio.ensure_future(hydrate_async(bad)),
            ]
            await asyncio.sleep(0)  # both submitted, behind the busy job
            for task in tasks:
                task.cancel()
            outcomes = list(await asyncio.gather(*tasks, return_exceptions=True))
            busy.set()
            await occupied
            await asyncio.to_thread(lambda: None)  # the queue has drained
            return outcomes

        outcomes, _ = on_loop(cancel_queued)
        assert all(isinstance(o, asyncio.CancelledError) for o in outcomes)
        assert fake_load.count == 0
        assert logger.records == []
        assert hydration_status(KEYS).state == "none"
        # The bad call's message was never claimed: the next one logs it.
        with pytest.raises(ConfigInputError):
            hydrate(bad)
        assert len(logger.records) == 1

    def test_cancelled_on_a_pre_request_rejection_writes_one_line_and_claims_it_once(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        started = threading.Event()
        fake_load.behaviour = blocks(
            release, raises(ValueError("Invalid connection string.")), started
        )
        logger = ThreadLogger()

        async def cancel_it() -> None:
            task = asyncio.ensure_future(hydrate_async(options(logger=logger)))
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert logger.records == []
            release.set()
            await asyncio.to_thread(wait_until, lambda: len(logger.records) == 1)

        _, loop_thread = on_loop(cancel_it)
        assert len(logger.records) == 1
        assert logger.lines[0].startswith(FAILED)
        assert "Invalid connection string." in logger.lines[0]
        assert loop_thread not in logger.threads
        # No floor (nothing reached the store), so the next call attempts again — and the message
        # is already claimed, so it writes nothing.
        with pytest.raises(ConfigInputError):
            hydrate(options(logger=logger))
        assert fake_load.count == 2
        assert len(logger.records) == 1

    def test_cancelled_after_the_attempt_settled_the_loop_writes_the_line_once(
        self, fake_load: FakeLoad
    ) -> None:
        # The worker finishes — attempt settled, lines handed over — while the loop is blocked, so
        # the task is cancelled before it can resume with the result. One worker in the pool, so a
        # second job on it runs only once the first has returned.
        logger = ThreadLogger()

        async def cancel_after_settling() -> BaseException:
            loop = asyncio.get_running_loop()
            pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            loop.set_default_executor(pool)
            task = asyncio.ensure_future(hydrate_async(options(logger=logger)))
            await asyncio.sleep(0)  # the task submits the attempt to the pool
            pool.submit(lambda: None).result(5)  # blocks the loop until the attempt has returned
            assert hydration_status(KEYS).state == "loaded"
            assert logger.records == []  # handed over, not written: the loop writes it
            task.cancel()
            try:
                await task
            except BaseException as error:
                return error
            raise AssertionError("expected a cancellation")

        cancelled, loop_thread = on_loop(cancel_after_settling)
        assert isinstance(cancelled, asyncio.CancelledError)
        assert len(logger.records) == 1
        assert logger.threads == {loop_thread}
        assert fake_load.count == 1
