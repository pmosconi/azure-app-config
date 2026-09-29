"""Invariant 4 — one selector per key, never a filter — and every call no retry can fix."""

from __future__ import annotations

import math
import os
from typing import Any, cast

import pytest
from helpers import (
    CONNECTION_STRING,
    KEYS,
    VALUES,
    Behaviour,
    Clock,
    FakeLoad,
    Wire,
    fails_after_read,
    fails_on_wire,
    http_error,
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
    hydrate,
    hydrate_with_backoff,
    hydration_status,
)
from azure_app_config._diagnostics import DiagnosticsPolicy

pytestmark = pytest.mark.unit


def refused() -> Behaviour:
    return fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))


class TestSelectors:
    def test_sends_one_selector_per_key_at_the_label_and_nothing_else(
        self, fake_load: FakeLoad
    ) -> None:
        hydrate(options())
        selects = fake_load.kwargs()["selects"]
        assert [(s.key_filter, s.label_filter, s.snapshot_name) for s in selects] == [
            (key, "prod", None) for key in KEYS
        ]

    @pytest.mark.parametrize("key", ["shared:*", "*", "shared:mongoUrl,myapp:httpPort", "a\\\\,b"])
    def test_never_lets_a_filter_reach_the_provider(self, fake_load: FakeLoad, key: str) -> None:
        with pytest.raises(ConfigInputError, match="is a filter, not a key"):
            hydrate(options(keys={key: "VARIABLE"}))
        assert fake_load.count == 0

    def test_lets_an_escaped_comma_or_asterisk_through_and_looks_it_up_unescaped(
        self, fake_load: FakeLoad
    ) -> None:
        keys = {"myapp:a\\,b": "A_B", "myapp:star\\*": "STAR"}
        fake_load.behaviour = returns({"myapp:a,b": "1", "myapp:star*": "2"})
        hydrate(options(keys=keys))
        assert [s.key_filter for s in fake_load.kwargs()["selects"]] == list(keys)
        assert os.environ["A_B"] == "1"
        assert os.environ["STAR"] == "2"
        assert fake_load.configs[0].gets == ["myapp:a,b", "myapp:star*"]

    @pytest.mark.parametrize("label", ["prod,staging", "*", "prod\\,x", "prod\\*"])
    def test_refuses_any_filter_character_in_the_label_escaped_or_not(
        self, fake_load: FakeLoad, label: str
    ) -> None:
        with pytest.raises(ConfigInputError, match="is a filter, not a label"):
            hydrate(options(label=label))
        os.environ["APP_CONFIG_LABEL"] = label
        with pytest.raises(ConfigInputError, match="is a filter, not a label"):
            hydrate(options())
        assert fake_load.count == 0

    def test_refuses_an_empty_key_map_rather_than_reading_everything(
        self, fake_load: FakeLoad
    ) -> None:
        with pytest.raises(ConfigInputError, match="no keys"):
            hydrate(options(keys={}))
        assert fake_load.count == 0

    def test_refuses_an_empty_key(self, fake_load: FakeLoad) -> None:
        # The SDK sends it as `key=`, a filter this package cannot vouch for.
        with pytest.raises(ConfigInputError, match="empty key"):
            hydrate(options(keys={"": "VARIABLE"}))
        assert fake_load.count == 0

    @pytest.mark.parametrize("variable", ["", "A=B", "A\x00B"])
    def test_refuses_a_variable_name_the_environment_cannot_hold(
        self, fake_load: FakeLoad, variable: str
    ) -> None:
        with pytest.raises(ConfigInputError, match="cannot be set in the environment"):
            hydrate(options(keys={"shared:mongoUrl": variable}))
        assert fake_load.count == 0

    def test_refuses_keys_that_are_not_a_mapping_of_strings(self, fake_load: FakeLoad) -> None:
        with pytest.raises(ConfigInputError):
            hydrate(options(keys=cast(Any, ["shared:mongoUrl"])))
        with pytest.raises(ConfigInputError):
            hydrate(options(keys=cast(Any, {"shared:mongoUrl": 1})))
        assert fake_load.count == 0

    def test_shares_the_checks_with_hydration_status(self) -> None:
        for keys in ({"shared:*": "A"}, {"a,b": "A"}, {}):
            with pytest.raises(ConfigInputError):
                hydration_status(keys)
        with pytest.raises(ConfigInputError):
            hydration_status(KEYS, "prod,staging")

    def test_hands_the_provider_one_diagnostics_policy_per_retry_on_both_paths(
        self, fake_load: FakeLoad
    ) -> None:
        hydrate(options())
        os.environ["APP_CONFIG_CONNECTION_STRING"] = CONNECTION_STRING
        hydrate(options(label="staging"))
        for index in (0, 1):
            policies = fake_load.kwargs(index)["per_retry_policies"]
            assert len(policies) == 1
            assert isinstance(policies[0], DiagnosticsPolicy)
            assert policies[0].name == "actvalue-azure-app-config-diagnostics"
            assert "per_call_policies" not in fake_load.kwargs(index)


class TestHydrateWithBackoffDoesNotRetryWhatRetryingCannotFix:
    @pytest.mark.parametrize(
        "bad",
        [
            {"keys": {"shared:*": "ALL"}},
            {"keys": {}},
        ],
    )
    def test_raises_on_a_bad_key_map_instead_of_looping(
        self, fake_load: FakeLoad, clock: Clock, bad: dict[str, Any]
    ) -> None:
        with pytest.raises(ConfigInputError):
            hydrate_with_backoff(options(**bad))
        assert fake_load.count == 0
        assert clock.sleeps == []

    def test_raises_on_a_missing_label_or_endpoint(self, fake_load: FakeLoad, clock: Clock) -> None:
        del os.environ["APP_CONFIG_LABEL"]
        with pytest.raises(ConfigInputError):
            hydrate_with_backoff(options())
        os.environ["APP_CONFIG_LABEL"] = "prod"
        del os.environ["APP_CONFIG_ENDPOINT"]
        with pytest.raises(ConfigInputError):
            hydrate_with_backoff(options())
        assert fake_load.count == 0

    def test_raises_the_providers_own_argument_error_after_one_attempt(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = raises(ValueError("Invalid connection string."))
        with pytest.raises(ConfigInputError, match="Invalid connection string"):
            hydrate_with_backoff(options())
        assert fake_load.count == 1

    def test_retries_a_broken_key_vault_reference_until_the_store_is_fixed(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        from helpers import key_vault_invalid_id

        broken = fails_after_read(key_vault_invalid_id("not-a-uri"))
        outcomes = [broken, broken, returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        errors: list[BaseException] = []
        result = hydrate_with_backoff(
            options(), BackoffOptions(on_error=lambda e, d: errors.append(e))
        )
        assert result.applied
        assert [type(e) for e in errors] == [ConfigLoadError, ConfigLoadError]

    def test_retries_a_credential_that_got_a_non_json_body(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        # msal parses the identity endpoint's body with json.loads, and ManagedIdentityCredential
        # re-raises the JSONDecodeError unwrapped: a ValueError, after network activity.
        from helpers import FlakyJsonCredential

        credential = FlakyJsonCredential(failures=2)
        errors: list[BaseException] = []
        result = hydrate_with_backoff(
            options(credential=credential), BackoffOptions(on_error=lambda e, d: errors.append(e))
        )
        assert result.applied
        assert [type(e) for e in errors] == [ConfigLoadError, ConfigLoadError]
        assert "JSONDecodeError" in str(errors[0])

    def test_holds_back_a_second_key_maps_loop_without_stopping_it(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(keys={"shared:mongoUrl": "MONGO_URL"}))
        fake_load.behaviour = returns()
        errors: list[BaseException] = []
        result = hydrate_with_backoff(
            options(keys={"myapp:httpPort": "HTTP_PORT"}),
            BackoffOptions(on_error=lambda e, _: errors.append(e)),
        )
        assert result.applied == ("HTTP_PORT",)
        assert errors == []  # the floor is not a failure
        assert clock.sleeps == [30_000 + 50]


class TestWhatMustStayRetryable:
    def test_retries_a_revoked_grant_and_recovers_with_no_restart(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        outcomes = [refused(), refused(), returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        result = hydrate_with_backoff(options(), BackoffOptions(on_error=lambda e, d: None))
        assert fake_load.count == 3
        assert result.applied

    def test_retries_a_throttled_store_rather_than_giving_up(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        throttled = fails_on_wire(Wire(status=429), provider_timeout(http_error(429)), tries=3)
        outcomes = [throttled, returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        errors: list[BaseException] = []
        hydrate_with_backoff(options(), BackoffOptions(on_error=lambda e, d: errors.append(e)))
        assert isinstance(errors[0], ConfigLoadError)
        assert errors[0].status_code == 429

    def test_widens_the_delay_and_reports_the_real_wait(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        outcomes = [refused()] * 4 + [returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        waits: list[float] = []
        hydrate_with_backoff(
            options(retry_floor_ms=0),
            BackoffOptions(initial_ms=5_000, max_ms=15_000, on_error=lambda e, d: waits.append(d)),
        )
        assert waits == [5_000, 10_000, 15_000, 15_000]
        assert clock.sleeps == waits

    def test_reports_the_floor_when_it_outlasts_the_backoff_delay(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        outcomes = [refused(), returns()]
        fake_load.behaviour = lambda args, kwargs: outcomes.pop(0)(args, kwargs)
        waits: list[float] = []
        hydrate_with_backoff(
            options(), BackoffOptions(initial_ms=1_000, on_error=lambda e, d: waits.append(d))
        )
        assert waits == [30_000 + 50]

    def test_sleeps_through_a_floor_rejection_without_reporting_it(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options())
        clock.advance(10_000)
        fake_load.behaviour = returns()
        errors: list[BaseException] = []
        hydrate_with_backoff(options(), BackoffOptions(on_error=lambda e, d: errors.append(e)))
        assert errors == []
        assert clock.sleeps == [20_000 + 50]
        assert fake_load.count == 2

    def test_never_sleeps_more_than_one_step_at_a_time_so_a_huge_floor_cannot_spin(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        huge = 3 * (2**31 - 1) + 5
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=huge))
        fake_load.behaviour = returns()
        hydrate_with_backoff(options(retry_floor_ms=huge))
        assert all(0 <= step <= 2**31 - 1 for step in clock.sleeps)
        assert sum(clock.sleeps) == huge + 50
        assert len(clock.sleeps) == 4


class TestTimingOptionsAreCheckedBeforeAnyRequest:
    @pytest.mark.parametrize(
        "value", [math.nan, math.inf, -math.inf, -1, "30000", True, None.__class__, 10**400]
    )
    def test_refuses_an_unusable_retry_floor(self, fake_load: FakeLoad, value: Any) -> None:
        with pytest.raises(ConfigInputError, match="retry_floor_ms must be a finite number"):
            hydrate(options(retry_floor_ms=value))
        assert fake_load.count == 0

    @pytest.mark.parametrize("value", [0, -5, math.nan, math.inf, 2**31, "15000", False])
    def test_refuses_an_unusable_timeout(self, fake_load: FakeLoad, value: Any) -> None:
        with pytest.raises(ConfigInputError, match="timeout_ms must be"):
            hydrate(options(timeout_ms=value))
        assert fake_load.count == 0

    def test_allows_the_largest_timeout_a_timer_honours(self, fake_load: FakeLoad) -> None:
        hydrate(options(timeout_ms=2**31 - 1))
        assert fake_load.count == 1

    @pytest.mark.parametrize("field", ["initial_ms", "max_ms"])
    @pytest.mark.parametrize("value", [0, -1, math.nan, math.inf])
    def test_refuses_an_unusable_backoff_delay(
        self, fake_load: FakeLoad, clock: Clock, field: str, value: float
    ) -> None:
        with pytest.raises(ConfigInputError, match=f"{field} must be"):
            hydrate_with_backoff(options(), BackoffOptions(**{field: value}))
        assert fake_load.count == 0

    def test_allows_a_huge_finite_floor_and_a_floor_of_zero(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        fake_load.behaviour = refused()
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=1e300))
        with pytest.raises(ConfigFloorError):
            hydrate(options(retry_floor_ms=1e300))
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=0))
        assert fake_load.count == 2

    def test_refuses_something_that_is_not_hydrate_options(self, fake_load: FakeLoad) -> None:
        with pytest.raises(ConfigInputError, match="needs a HydrateOptions"):
            hydrate(cast(Any, {"keys": KEYS}))
        with pytest.raises(ConfigInputError, match="needs a HydrateOptions"):
            hydrate(cast(Any, None))
        assert fake_load.count == 0


def test_fixture_values_cover_the_keys() -> None:
    assert set(VALUES) == set(KEYS)
