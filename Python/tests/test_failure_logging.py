"""The failure line: once per attempt, by the call that started it, never changing the outcome."""

from __future__ import annotations

import logging
import threading
import warnings
from collections.abc import Callable
from typing import Any

import pytest
from helpers import (
    KEYS,
    VALUES,
    Behaviour,
    Clock,
    FakeLoad,
    InfoOnlyLogger,
    RaisingLogger,
    RecordingLogger,
    Wire,
    fails_after_read,
    fails_on_wire,
    http_error,
    key_vault_invalid_id,
    options,
    provider_timeout,
    raises,
    returns,
)

from azure_app_config import (
    BackoffOptions,
    ConfigFloorError,
    ConfigInputError,
    ConfigLoadError,
    HydrateOptions,
    hydrate,
    hydrate_with_backoff,
    reset_hydration,
)

pytestmark = pytest.mark.unit

PREFIX = "Configuration load failed: "


def refused() -> Behaviour:
    return fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))


class TestOncePerAttempt:
    def test_logs_the_failure_through_error_in_the_text_consumers_logged(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = refused()
        logger = RecordingLogger()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(logger=logger))
        assert logger.errors == [f"{PREFIX}{caught.value}"]
        assert logger.infos == []

    def test_writes_the_line_before_the_failure_reaches_the_caller(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = refused()
        logger = RecordingLogger()
        seen_by_caller: list[int] = []
        try:
            hydrate(options(logger=logger))
        except ConfigLoadError:
            seen_by_caller.append(len(logger.errors))
        assert seen_by_caller == [1]

    def test_falls_back_to_info_when_the_logger_has_no_error(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = refused()
        logger = InfoOnlyLogger()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(logger=logger))
        assert logger.infos == [f"{PREFIX}{caught.value}"]

    def test_logs_through_the_default_logger_at_error(
        self, fake_load: FakeLoad, caplog: pytest.LogCaptureFixture
    ) -> None:
        fake_load.behaviour = refused()
        with caplog.at_level("INFO", logger="azure_app_config"), pytest.raises(ConfigLoadError):
            hydrate(options())
        records = [r for r in caplog.records if r.name == "azure_app_config"]
        assert [r.levelname for r in records] == ["ERROR"]
        assert records[0].getMessage().startswith(PREFIX)

    def test_logs_a_missing_key_which_names_the_keys(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = returns({})
        logger = RecordingLogger()
        with pytest.raises(LookupError):
            hydrate(options(logger=logger))
        assert logger.errors[0].startswith(f"{PREFIX}Missing key-values in App Configuration: ")
        assert "shared:mongoUrl" in logger.errors[0]

    def test_logs_nothing_for_a_floor_rejection(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        logger = RecordingLogger()
        with pytest.raises(ConfigLoadError):
            hydrate(options(logger=logger))
        for _ in range(3):
            with pytest.raises(ConfigFloorError):
                hydrate(options(logger=logger))
        assert len(logger.errors) == 1

    def test_logs_each_real_attempt_once_when_the_floor_lets_it_through(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        logger = RecordingLogger()
        for _ in range(3):
            with pytest.raises(ConfigLoadError):
                hydrate(options(logger=logger))
            clock.advance(30_000)
        assert len(logger.errors) == 3

    def test_logs_no_failure_for_a_success_nor_for_the_memo_hits_after_it(
        self, fake_load: FakeLoad
    ) -> None:
        logger = RecordingLogger()
        hydrate(options(logger=logger))
        hydrate(options(logger=logger))
        assert logger.errors == []
        assert len(logger.infos) == 1

    def test_never_logs_a_value(self, fake_load: FakeLoad, clock: Clock) -> None:
        logger = RecordingLogger()
        fake_load.behaviour = returns({**VALUES, "myapp:httpPort": {"port": 8080}})
        with pytest.raises(LookupError):
            hydrate(options(logger=logger))
        reset_hydration()
        fake_load.behaviour = fails_after_read(key_vault_invalid_id("s3cr3t-pasted-by-mistake"))
        with pytest.raises(ConfigLoadError):
            hydrate(options(logger=logger))
        assert len(logger.errors) == 2
        for line in logger.lines:
            assert "s3cr3t" not in line
            assert "8080" not in line
            for value in VALUES.values():
                assert value not in line


class TestPreRequestRejections:
    """Not attempts, but a fail-fast caller would be silent: once per distinct message."""

    def test_logs_the_same_bad_input_once_however_often_it_is_called(
        self, fake_load: FakeLoad
    ) -> None:
        logger = RecordingLogger()
        for _ in range(5):
            with pytest.raises(ConfigInputError):
                hydrate(options(keys={"shared:*": "ALL"}, logger=logger))
        assert len(logger.errors) == 1
        assert logger.errors[0].startswith(f'{PREFIX}Key "shared:*" is a filter')

    def test_logs_a_different_bad_input_with_its_own_line(self, fake_load: FakeLoad) -> None:
        logger = RecordingLogger()
        with pytest.raises(ConfigInputError):
            hydrate(options(keys={"shared:*": "ALL"}, logger=logger))
        with pytest.raises(ConfigInputError):
            hydrate(options(keys={"a,b": "AB"}, logger=logger))
        assert len(logger.errors) == 2

    def test_logs_it_again_after_reset(self, fake_load: FakeLoad) -> None:
        logger = RecordingLogger()
        with pytest.raises(ConfigInputError):
            hydrate(options(keys={"shared:*": "ALL"}, logger=logger))
        reset_hydration()
        with pytest.raises(ConfigInputError):
            hydrate(options(keys={"shared:*": "ALL"}, logger=logger))
        assert len(logger.errors) == 2

    def test_logs_the_providers_own_pre_request_error_once_though_each_call_attempts(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = raises(ValueError("Invalid connection string."))
        logger = RecordingLogger()
        for _ in range(3):
            with pytest.raises(ConfigInputError):
                hydrate(options(logger=logger))
        assert fake_load.count == 3
        assert len(logger.errors) == 1

    def test_logs_a_value_error_after_the_store_answered_once_per_attempt(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = fails_after_read(
            ValueError("Key Vault reference must have a uri value.")
        )
        logger = RecordingLogger()
        for _ in range(2):
            with pytest.raises(ConfigLoadError):
                hydrate(options(logger=logger))
            clock.advance(30_000)
        assert len(logger.errors) == 2


class TestLoggingNeverChangesTheOutcome:
    def test_raises_the_loads_own_error_when_the_logger_raises(self, fake_load: FakeLoad) -> None:
        thrown = provider_timeout(http_error(403))
        fake_load.behaviour = fails_on_wire(Wire(status=403), thrown)
        logger = RaisingLogger()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(logger=logger))
        assert caught.value.__cause__ is thrown
        assert logger.calls == 1

    def test_raises_the_input_error_when_the_logger_raises_on_a_pre_request_rejection(
        self, fake_load: FakeLoad
    ) -> None:
        with pytest.raises(ConfigInputError):
            hydrate(options(keys={"shared:*": "ALL"}, logger=RaisingLogger()))

    def test_still_arms_the_floor_when_the_logger_raises(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(logger=RaisingLogger()))
        with pytest.raises(ConfigFloorError):
            hydrate(options(logger=RaisingLogger()))
        assert fake_load.count == 1

    def test_closes_an_async_loggers_coroutine_and_leaves_the_outcome(
        self, fake_load: FakeLoad
    ) -> None:
        class AsyncLogger:
            def __init__(self) -> None:
                self.calls = 0

            async def error(self, message: str) -> None:
                self.calls += 1  # never runs: the coroutine is closed unawaited

            def info(self, message: str) -> None:
                pass

        fake_load.behaviour = refused()
        logger = AsyncLogger()
        with warnings.catch_warnings():
            warnings.simplefilter("error")  # "coroutine was never awaited" would fail the test
            with pytest.raises(ConfigLoadError):
                hydrate(options(logger=logger))

    def test_a_logger_attribute_that_raises_still_leaves_the_loads_error(
        self, fake_load: FakeLoad
    ) -> None:
        class BrokenOptions(HydrateOptions):
            def __getattribute__(self, name: str) -> Any:
                if name == "logger":
                    raise RuntimeError("logger attribute down")
                return super().__getattribute__(name)

        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(BrokenOptions(keys=KEYS))


class TestHydrateWithBackoffReportsThroughOnErrorAlone:
    def test_adds_no_line_of_its_own_per_failure_when_on_error_is_custom(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        outcomes = [refused(), refused(), returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        logger = RecordingLogger()
        seen: list[BaseException] = []
        hydrate_with_backoff(
            options(logger=logger), BackoffOptions(on_error=lambda e, d: seen.append(e))
        )
        assert len(seen) == 2
        assert logger.errors == []

    def test_logs_exactly_one_line_per_failure_with_the_default_on_error(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        outcomes = [refused(), returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        logger = RecordingLogger()
        hydrate_with_backoff(options(logger=logger, retry_floor_ms=0))
        assert len(logger.errors) == 1
        assert logger.errors[0].startswith("Configuration load failed, retrying in 5s: ")

    def test_keeps_retrying_until_success_when_the_default_on_error_meets_a_raising_logger(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        outcomes = [refused(), refused(), returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        logger = RaisingLogger()
        result = hydrate_with_backoff(
            options(logger=logger, retry_floor_ms=0), BackoffOptions(initial_ms=1, max_ms=2)
        )
        assert result.applied
        assert fake_load.count == 3

    def test_formats_the_wait_as_the_typescript_half_does(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        outcomes = [refused(), returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        logger = RecordingLogger()
        hydrate_with_backoff(
            options(logger=logger, retry_floor_ms=0), BackoffOptions(initial_ms=1, max_ms=2)
        )
        assert logger.errors[0].startswith("Configuration load failed, retrying in 0.001s: ")

    def test_leaves_a_custom_on_error_that_raises_to_end_the_loop(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        own = RuntimeError("caller gave up")

        def on_error(error: BaseException, delay: float) -> None:
            raise own

        with pytest.raises(RuntimeError) as caught:
            hydrate_with_backoff(options(), BackoffOptions(on_error=on_error))
        assert caught.value is own

    def test_still_writes_the_success_line_on_its_own_thread_when_it_succeeds(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        outcomes = [refused(), returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        logger = RecordingLogger()
        hydrate_with_backoff(
            options(logger=logger, retry_floor_ms=0), BackoffOptions(on_error=lambda e, d: None)
        )
        assert logger.errors == []
        assert len(logger.infos) == 1
        assert logger.infos[0].startswith("Configuration loaded from App Configuration, label prod")

    def test_does_not_log_the_config_input_error_it_re_raises(self, fake_load: FakeLoad) -> None:
        logger = RecordingLogger()
        with pytest.raises(ConfigInputError):
            hydrate_with_backoff(options(keys={"shared:*": "ALL"}, logger=logger))
        assert logger.errors == []

    def test_does_not_spend_hydrates_once_per_message_line(self, fake_load: FakeLoad) -> None:
        logger = RecordingLogger()
        with pytest.raises(ConfigInputError):
            hydrate_with_backoff(options(keys={"shared:*": "ALL"}, logger=logger))
        with pytest.raises(ConfigInputError):
            hydrate(options(keys={"shared:*": "ALL"}, logger=logger))
        assert len(logger.errors) == 1


class TestJoinersLogNothing:
    def test_one_line_for_callers_in_other_threads_joining_one_attempt(
        self, fake_load: FakeLoad, joiners_waiting: Callable[[int], threading.Event]
    ) -> None:
        from helpers import blocks

        everyone = joiners_waiting(4)
        gate = threading.Event()
        started = threading.Event()
        fake_load.behaviour = blocks(gate, refused(), started)
        starter_logger, joiner_logger = RecordingLogger(), RecordingLogger()
        errors: list[BaseException] = []

        def call(logger: RecordingLogger) -> None:
            try:
                hydrate(options(logger=logger))
            except BaseException as error:
                errors.append(error)

        first = threading.Thread(target=call, args=(starter_logger,))
        first.start()
        assert started.wait(5)
        joiners = [threading.Thread(target=call, args=(joiner_logger,)) for _ in range(4)]
        for thread in joiners:
            thread.start()
        assert everyone.wait(5)
        gate.set()
        for thread in [first, *joiners]:
            thread.join(5)
        assert len(starter_logger.errors) == 1
        assert joiner_logger.lines == []
        assert len(errors) == 5
        assert all(error is errors[0] for error in errors)


class TestReentrantLogging:
    """A logging handler that calls hydrate() on the logging thread must find the attempt
    settled — a memo hit or a floor rejection — not join the attempt that is logging."""

    def reentrant_logger(self, reenter: Any) -> logging.Logger:
        logger = logging.getLogger(f"azure_app_config_tests.reentrant.{id(reenter)}")
        logger.setLevel(logging.INFO)
        logger.propagate = False

        class Reenter(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                reenter()

        logger.addHandler(Reenter())
        return logger

    def run_bounded(self, target: Any) -> None:
        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        thread.join(5)
        assert not thread.is_alive(), "hydrate() waited on its own attempt"

    def test_a_handler_calling_hydrate_on_the_success_line_gets_the_memo(
        self, fake_load: FakeLoad
    ) -> None:
        inner: list[Any] = []
        outer: list[Any] = []
        holder: dict[str, HydrateOptions] = {}
        logger = self.reentrant_logger(lambda: inner.append(hydrate(holder["options"])))
        holder["options"] = options(logger=logger)
        self.run_bounded(lambda: outer.append(hydrate(holder["options"])))
        assert inner and inner[0] is outer[0]
        assert fake_load.count == 1

    def test_a_handler_calling_hydrate_on_the_failure_line_gets_the_floor(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = refused()
        inner: list[BaseException] = []
        holder: dict[str, HydrateOptions] = {}

        def reenter() -> None:
            try:
                hydrate(holder["options"])
            except BaseException as error:
                inner.append(error)

        holder["options"] = options(logger=self.reentrant_logger(reenter))

        def outer() -> None:
            with pytest.raises(ConfigLoadError):
                hydrate(holder["options"])

        self.run_bounded(outer)
        assert len(inner) == 1 and isinstance(inner[0], ConfigFloorError)
        assert fake_load.count == 1
