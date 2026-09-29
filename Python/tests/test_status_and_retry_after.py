"""`hydration_status()` never makes a request; `retry_after_ms()` gives the wait for each kind."""

from __future__ import annotations

import os
import threading

import pytest
from helpers import (
    KEYS,
    Behaviour,
    Clock,
    FakeLoad,
    Wire,
    blocks,
    fails_after_read,
    fails_on_wire,
    http_error,
    options,
    provider_timeout,
    raises,
    returns,
)

from azure_app_config import (
    DEFAULT_RETRY_FLOOR_MS,
    ConfigFloorError,
    ConfigInputError,
    ConfigLoadError,
    hydrate,
    hydration_status,
    reset_hydration,
    retry_after_ms,
)

pytestmark = pytest.mark.unit


def refused() -> Behaviour:
    return fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))


class TestStatusMakesNoRequestInEveryState:
    def test_none_before_any_attempt_and_starts_none(self, fake_load: FakeLoad) -> None:
        assert hydration_status(KEYS).state == "none"
        assert fake_load.count == 0

    def test_pending_while_an_attempt_is_in_flight(self, fake_load: FakeLoad) -> None:
        gate, started = threading.Event(), threading.Event()
        fake_load.behaviour = blocks(gate, returns(), started)
        thread = threading.Thread(target=lambda: hydrate(options()))
        thread.start()
        assert started.wait(5)
        assert hydration_status(KEYS).state == "pending"
        assert fake_load.count == 1
        gate.set()
        thread.join(5)

    def test_loaded_with_the_loaded_at_the_result_carries(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        result = hydrate(options())
        status = hydration_status(KEYS)
        assert status.state == "loaded"
        assert status.loaded_at == result.loaded_at
        assert status.next_attempt_at is None
        assert fake_load.count == 1

    def test_failing_inside_the_floor_with_the_error_and_when_it_opens(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options())
        status = hydration_status(KEYS)
        assert status.state == "failing"
        assert status.failed_at == clock.now
        assert status.last_error is caught.value
        assert status.next_attempt_at == clock.now + DEFAULT_RETRY_FLOOR_MS
        assert fake_load.count == 1

    def test_failing_after_the_floor_opened_with_no_next_attempt_at(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        clock.advance(DEFAULT_RETRY_FLOOR_MS)
        status = hydration_status(KEYS)
        assert status.state == "failing"
        assert status.next_attempt_at is None
        assert fake_load.count == 1

    def test_pending_retry_still_carries_the_failure_before_it(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(retry_floor_ms=0))
        gate, started = threading.Event(), threading.Event()
        fake_load.behaviour = blocks(gate, returns(), started)
        thread = threading.Thread(target=lambda: hydrate(options(retry_floor_ms=0)))
        thread.start()
        assert started.wait(5)
        status = hydration_status(KEYS)
        assert status.state == "pending"
        assert status.last_error is caught.value
        assert status.next_attempt_at is None
        gate.set()
        thread.join(5)
        assert fake_load.count == 2


class TestWhatTheStatusIsAbout:
    def test_is_per_key_map_and_label(self, fake_load: FakeLoad) -> None:
        hydrate(options())
        assert hydration_status(KEYS).state == "loaded"
        assert hydration_status(KEYS, "staging").state == "none"
        assert hydration_status({"shared:mongoUrl": "MONGO_URL"}).state == "none"

    def test_resolves_the_label_from_app_config_label(self, fake_load: FakeLoad) -> None:
        hydrate(options(label="staging"))
        os.environ["APP_CONFIG_LABEL"] = "staging"
        assert hydration_status(KEYS).state == "loaded"

    def test_reports_a_floor_another_key_map_armed(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(keys={"shared:mongoUrl": "MONGO_URL"}))
        status = hydration_status({"myapp:httpPort": "HTTP_PORT"})
        assert status.state == "none"
        assert status.next_attempt_at == clock.now + DEFAULT_RETRY_FLOOR_MS

    def test_reports_next_attempt_at_with_the_floor_of_the_attempt_that_armed_it(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=60_000))
        assert hydration_status(KEYS).next_attempt_at == clock.now + 60_000

    def test_never_reports_next_attempt_at_when_loaded_even_with_the_floor_closed(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(keys={"shared:mongoUrl": "MONGO_URL"}, retry_floor_ms=60_000))
        fake_load.behaviour = returns()
        hydrate(options(retry_floor_ms=0))
        assert hydration_status(KEYS).next_attempt_at is None

    def test_reports_a_broken_key_vault_reference_with_the_floor_it_armed(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = fails_after_read(
            ValueError("Key Vault reference must have a uri value.")
        )
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        status = hydration_status(KEYS)
        assert status.state == "failing"
        assert status.next_attempt_at == clock.now + DEFAULT_RETRY_FLOOR_MS

    def test_reports_a_pre_request_input_error_with_no_floor(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = raises(ValueError("Invalid connection string."))
        with pytest.raises(ConfigInputError):
            hydrate(options())
        status = hydration_status(KEYS)
        assert status.state == "failing"
        assert status.next_attempt_at is None

    def test_is_cleared_by_reset(self, fake_load: FakeLoad) -> None:
        hydrate(options())
        reset_hydration()
        assert hydration_status(KEYS).state == "none"

    def test_needs_no_endpoint_because_it_never_reaches_the_store(self) -> None:
        del os.environ["APP_CONFIG_ENDPOINT"]
        assert hydration_status(KEYS).state == "none"

    def test_raises_for_a_call_hydrate_would_refuse_before_any_request(self) -> None:
        del os.environ["APP_CONFIG_LABEL"]
        with pytest.raises(ConfigInputError):
            hydration_status(KEYS)


def test_a_health_endpoint_beside_loading_handlers_costs_no_request(
    fake_load: FakeLoad, clock: Clock
) -> None:
    fake_load.behaviour = refused()
    with pytest.raises(ConfigLoadError):
        hydrate(options())
    for _ in range(100):
        assert hydration_status(KEYS).state == "failing"
        clock.advance(1_000)
    fake_load.behaviour = returns()
    hydrate(options())
    for _ in range(100):
        assert hydration_status(KEYS).state == "loaded"
    assert fake_load.count == 2


class TestRetryAfterMs:
    def test_is_a_floor_rejections_own(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        clock.advance(1_234)
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options(retry_floor_ms=10_000))
        clock.advance(5_000)
        assert retry_after_ms(floor.value) == floor.value.retry_after_ms == 10_000 - 1_234 + 50

    def test_is_the_time_until_a_fresh_failures_floor_opens_plus_the_margin(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options())
        clock.advance(4_000)
        assert retry_after_ms(caught.value) == DEFAULT_RETRY_FLOOR_MS - 4_000 + 50

    def test_agrees_with_next_attempt_at_plus_the_margin(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(retry_floor_ms=12_345))
        next_attempt_at = hydration_status(KEYS).next_attempt_at
        assert next_attempt_at is not None
        assert retry_after_ms(caught.value) == next_attempt_at - clock.now + 50

    def test_measures_with_the_floor_of_the_attempt_that_armed_it(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(retry_floor_ms=45_000))
        assert retry_after_ms(caught.value) == 45_000 + 50

    def test_rounds_a_fractional_wait_up(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(retry_floor_ms=100.2))
        assert retry_after_ms(caught.value) == 101 + 50

    def test_lets_a_caller_who_waits_that_long_on_a_timer_one_ms_early_reach_the_store(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options())
        wait = retry_after_ms(caught.value)
        assert wait is not None
        clock.advance(wait - 1)
        fake_load.behaviour = returns()
        hydrate(options())
        assert fake_load.count == 2

    def test_is_none_once_the_floor_has_opened(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options())
        clock.advance(DEFAULT_RETRY_FLOOR_MS)
        assert retry_after_ms(caught.value) is None

    def test_is_none_for_a_fresh_failure_with_a_floor_of_zero(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options(retry_floor_ms=0))
        assert retry_after_ms(caught.value) is None

    def test_is_none_for_an_input_error_refused_before_any_request(
        self, fake_load: FakeLoad
    ) -> None:
        with pytest.raises(ConfigInputError) as caught:
            hydrate(options(keys={"shared:*": "ALL"}))
        assert retry_after_ms(caught.value) is None

    def test_is_the_floor_for_a_broken_key_vault_reference_which_waiting_can_fix(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = fails_after_read(
            ValueError("Key Vault reference must have a uri value.")
        )
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options())
        assert retry_after_ms(caught.value) == DEFAULT_RETRY_FLOOR_MS + 50

    def test_is_none_for_any_config_input_error_even_one_that_reached_the_store(self) -> None:
        assert retry_after_ms(ConfigInputError("x", reached_store=True)) is None

    def test_is_none_for_anything_else_when_no_floor_is_armed(self) -> None:
        assert retry_after_ms(RuntimeError("anything")) is None

    def test_makes_no_request_in_any_state(self, fake_load: FakeLoad, clock: Clock) -> None:
        retry_after_ms(RuntimeError("before"))
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options())
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options())
        for error in (caught.value, floor.value, RuntimeError("other")):
            retry_after_ms(error)
        assert fake_load.count == 1
