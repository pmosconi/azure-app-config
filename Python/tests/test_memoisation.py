"""Invariants 1 and 2: one attempt per call; memoise success, never failure; rate-limit retrying."""

from __future__ import annotations

import threading

import pytest
from helpers import (
    KEYS,
    VALUES,
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
    hydrate_with_backoff,
    hydration_status,
    reset_hydration,
)

pytestmark = pytest.mark.unit


def refused() -> Behaviour:
    return fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))


class TestOneAttemptPerCall:
    def test_calls_the_provider_exactly_once_on_success(self, fake_load: FakeLoad) -> None:
        hydrate(options())
        assert fake_load.count == 1

    def test_calls_the_provider_exactly_once_on_failure_and_raises(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=0))
        assert fake_load.count == 1

    def test_does_not_re_read_the_store_when_keys_are_missing(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = returns({})
        with pytest.raises(LookupError):
            hydrate(options(retry_floor_ms=0))
        assert fake_load.count == 1

    def test_puts_the_loop_in_hydrate_with_backoff(self, fake_load: FakeLoad, clock: Clock) -> None:
        outcomes = [refused(), refused(), returns()]

        def behaviour(args: tuple, kwargs: dict) -> object:
            return outcomes.pop(0)(args, kwargs)

        fake_load.behaviour = behaviour
        result = hydrate_with_backoff(options(retry_floor_ms=0))
        assert fake_load.count == 3
        assert result.applied == tuple(KEYS.values())


class TestMemo:
    def test_memoises_a_success_and_later_calls_are_free(self, fake_load: FakeLoad) -> None:
        first = hydrate(options())
        second = hydrate(options())
        assert fake_load.count == 1
        assert second is first

    def test_does_not_memoise_a_failure(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=0))
        fake_load.behaviour = returns()
        hydrate(options(retry_floor_ms=0))
        assert fake_load.count == 2

    def test_does_not_hand_one_key_map_another_key_maps_result(self, fake_load: FakeLoad) -> None:
        hydrate(options(keys={"shared:mongoUrl": "MONGO_URL"}))
        hydrate(options(keys={"myapp:httpPort": "HTTP_PORT"}))
        assert fake_load.count == 2

    def test_shares_one_attempt_when_the_same_keys_are_listed_in_a_different_order(
        self, fake_load: FakeLoad
    ) -> None:
        hydrate(options(keys=dict(KEYS)))
        hydrate(options(keys=dict(reversed(list(KEYS.items())))))
        assert fake_load.count == 1

    def test_reads_again_for_the_same_keys_at_a_different_label(self, fake_load: FakeLoad) -> None:
        hydrate(options(label="prod"))
        hydrate(options(label="staging"))
        assert fake_load.count == 2

    def test_reset_drops_the_memo(self, fake_load: FakeLoad) -> None:
        hydrate(options())
        reset_hydration()
        hydrate(options())
        assert fake_load.count == 2


class TestRetryFloor:
    def test_raises_inside_the_floor_without_touching_the_store(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError) as first:
            hydrate(options())
        clock.advance(1_000)
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options())
        assert fake_load.count == 1
        assert floor.value.__cause__ is first.value

    def test_is_its_own_class_neither_load_nor_input_error(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options())
        assert not isinstance(floor.value, ConfigLoadError)
        assert not isinstance(floor.value, ConfigInputError)
        assert isinstance(floor.value, Exception)

    def test_counts_retry_after_ms_down_to_the_floor_plus_the_margin(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        clock.advance(10_000)
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options())
        assert floor.value.retry_after_ms == 20_000 + 50
        assert "opens in 20s" in str(floor.value)

    def test_rounds_a_fractional_wait_up(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=1_000.25))
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options(retry_floor_ms=1_000.25))
        assert floor.value.retry_after_ms == 1_001 + 50

    def test_is_enforced_exactly_and_a_timer_one_ms_early_still_clears_it(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options())
        clock.advance(DEFAULT_RETRY_FLOOR_MS - 1)
        with pytest.raises(ConfigFloorError):
            hydrate(options())  # exact: one millisecond inside is still inside
        reset_count = fake_load.count
        clock.advance(1)
        fake_load.behaviour = returns()
        hydrate(options())
        assert fake_load.count == reset_count + 1
        # And the margin: waiting retry_after_ms on a timer that fires 1 ms early lands outside.
        assert floor.value.retry_after_ms - 1 > DEFAULT_RETRY_FLOOR_MS

    def test_measures_retry_after_ms_with_the_calling_floor(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=60_000))
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options(retry_floor_ms=5_000))
        assert floor.value.retry_after_ms == 5_000 + 50

    def test_exports_its_default_and_uses_it_when_none_is_given(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        assert DEFAULT_RETRY_FLOOR_MS == 30_000
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options())
        assert floor.value.retry_after_ms == DEFAULT_RETRY_FLOOR_MS + 50

    def test_is_not_moved_by_its_own_rejections(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        failed_at = hydration_status(KEYS).failed_at
        for _ in range(5):
            clock.advance(5_000)
            with pytest.raises(ConfigFloorError):
                hydrate(options())
        assert hydration_status(KEYS).failed_at == failed_at
        clock.advance(5_000)
        fake_load.behaviour = returns()
        hydrate(options())
        assert fake_load.count == 2

    def test_is_global_because_the_quota_is(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(keys={"shared:mongoUrl": "MONGO_URL"}))
        with pytest.raises(ConfigFloorError):
            hydrate(options(keys={"myapp:httpPort": "HTTP_PORT"}))
        assert fake_load.count == 1

    def test_is_cleared_by_reset_timestamp_included(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        reset_hydration()
        fake_load.behaviour = returns()
        hydrate(options())
        assert fake_load.count == 2

    def test_is_not_armed_by_a_failure_that_lands_after_reset(self, fake_load: FakeLoad) -> None:
        gate = threading.Event()
        started = threading.Event()
        fake_load.behaviour = blocks(gate, refused(), started)
        caught: list[BaseException] = []

        def run() -> None:
            try:
                hydrate(options())
            except BaseException as error:
                caught.append(error)

        thread = threading.Thread(target=run)
        thread.start()
        assert started.wait(5)
        reset_hydration()
        gate.set()
        thread.join(5)
        assert isinstance(caught[0], ConfigLoadError)
        status = hydration_status(KEYS)
        assert status.state == "none"
        assert status.next_attempt_at is None
        fake_load.behaviour = returns()
        hydrate(options())  # no ConfigFloorError: the new state has no floor

    def test_arms_on_a_403_so_eight_triggers_cost_one_request(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        kinds = []
        for _ in range(8):
            try:
                hydrate(options())
            except Exception as error:
                kinds.append(type(error))
        assert fake_load.count == 1
        assert kinds == [ConfigLoadError] + [ConfigFloorError] * 7

    def test_arms_on_a_throttled_store(self, fake_load: FakeLoad, clock: Clock) -> None:
        fake_load.behaviour = fails_on_wire(
            Wire(status=429), provider_timeout(http_error(429)), tries=3
        )
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        with pytest.raises(ConfigFloorError):
            hydrate(options())
        assert fake_load.count == 1


class TestWhatArmsTheFloor:
    """Whether the attempt reached the store, not what kind of error it ended in."""

    def test_input_refused_before_any_request_leaves_the_floor_open(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        with pytest.raises(ConfigInputError):
            hydrate(options(keys={"shared:*": "ALL"}))
        hydrate(options())
        assert fake_load.count == 1

    def test_the_providers_own_pre_request_check_leaves_it_open(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = raises(ValueError("Invalid connection string."))
        with pytest.raises(ConfigInputError) as caught:
            hydrate(options())
        assert caught.value.reached_store is False
        fake_load.behaviour = returns()
        hydrate(options())
        assert fake_load.count == 2

    def test_a_value_error_after_the_store_answered_is_a_load_error_that_arms_it(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = fails_after_read(
            ValueError("Key Vault reference must have a uri value.")
        )
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options())
        with pytest.raises(ConfigFloorError) as floor:
            hydrate(options())
        assert floor.value.__cause__ is caught.value
        assert fake_load.count == 1

    def test_a_value_error_after_a_request_left_is_a_load_error_even_unanswered(
        self, fake_load: FakeLoad, clock: Clock, release: threading.Event
    ) -> None:
        from helpers import pending_request_then_raises

        fake_load.behaviour = pending_request_then_raises(ValueError("refused input"), release)
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        with pytest.raises(ConfigFloorError):
            hydrate(options())

    def test_a_value_error_after_only_a_token_request_is_a_load_error(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        from helpers import StubCredential, token_then_raises

        fake_load.behaviour = token_then_raises(ValueError("identity endpoint said no"))
        with pytest.raises(ConfigLoadError):
            hydrate(options(credential=StubCredential()))

    def test_still_arms_the_floor_for_an_input_error_that_reached_the_store(self) -> None:
        # Defensive: nothing produces one now (an input error is pre-network by definition), but
        # the rule stays the TypeScript half's.
        from azure_app_config import _core

        assert _core._arms_floor(ConfigInputError("x", reached_store=True)) is True
        assert _core._arms_floor(ConfigInputError("x", reached_store=False)) is False


def test_values_are_the_fixture_values() -> None:
    assert set(VALUES) == set(KEYS)
