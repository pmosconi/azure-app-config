"""Writing the environment: precedence, the success line, missing keys, all or nothing, and how
the store is addressed."""

from __future__ import annotations

import os
from collections.abc import Iterator, MutableMapping
from typing import Any, cast

import pytest
from helpers import (
    CONNECTION_STRING,
    ENDPOINT,
    KEYS,
    VALUES,
    Clock,
    FakeLoad,
    RaisingLogger,
    RecordingLogger,
    StubCredential,
    http_error,
    options,
    provider_timeout,
    raises,
    returns,
)

from azure_app_config import (
    BackoffOptions,
    ConfigInputError,
    ConfigLoadError,
    _core,
    hydrate,
    hydrate_with_backoff,
    reset_hydration,
)

pytestmark = pytest.mark.unit

PREFIX = (
    "Configuration loaded from App Configuration, label prod: "
    "MONGO_URL, SERVICE_BUS_CONNECTION, HTTP_PORT"
)


class TestWritingTheEnvironment:
    def test_writes_every_mapped_variable_and_reports_what_it_applied(
        self, fake_load: FakeLoad
    ) -> None:
        result = hydrate(options())
        for key, variable in KEYS.items():
            assert os.environ[variable] == VALUES[key]
        assert result.label == "prod"
        assert result.applied == ("MONGO_URL", "SERVICE_BUS_CONNECTION", "HTTP_PORT")
        assert result.kept == ()

    def test_says_when_it_loaded(self, fake_load: FakeLoad, clock: Clock) -> None:
        assert hydrate(options()).loaded_at == clock.now

    def test_closes_the_provider_once_it_has_read_it(self, fake_load: FakeLoad) -> None:
        hydrate(options())
        assert fake_load.configs[0].closed


class TestPrecedence:
    def test_lets_the_store_win_when_deployed_even_under_node_env_development(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        os.environ["NODE_ENV"] = "development"
        os.environ["MONGO_URL"] = "mongodb://local"
        hydrate(options())
        assert os.environ["MONGO_URL"] == VALUES["shared:mongoUrl"]

    def test_keeps_the_local_value_when_not_deployed_even_under_node_env_production(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["NODE_ENV"] = "production"
        os.environ["MONGO_URL"] = "mongodb://local"
        result = hydrate(options())
        assert os.environ["MONGO_URL"] == "mongodb://local"
        assert result.kept == ("MONGO_URL",)

    def test_treats_an_empty_website_instance_id_as_not_deployed(self, fake_load: FakeLoad) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = ""
        os.environ["MONGO_URL"] = "mongodb://local"
        hydrate(options())
        assert os.environ["MONGO_URL"] == "mongodb://local"

    def test_reads_the_signal_on_every_attempt_not_once_at_import(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["MONGO_URL"] = "mongodb://local"
        hydrate(options())
        assert os.environ["MONGO_URL"] == "mongodb://local"
        reset_hydration()
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        hydrate(options())
        assert os.environ["MONGO_URL"] == VALUES["shared:mongoUrl"]

    def test_takes_local_overrides_win_true_from_the_caller_on_a_deployed_instance(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        os.environ["MONGO_URL"] = "mongodb://local"
        hydrate(options(local_overrides_win=True))
        assert os.environ["MONGO_URL"] == "mongodb://local"

    def test_takes_local_overrides_win_false_from_the_caller_with_no_signal(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["MONGO_URL"] = "mongodb://local"
        hydrate(options(local_overrides_win=False))
        assert os.environ["MONGO_URL"] == VALUES["shared:mongoUrl"]

    def test_lets_a_local_value_stand_in_for_a_key_the_store_has_not_got(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = returns({k: v for k, v in VALUES.items() if k != "myapp:httpPort"})
        os.environ["HTTP_PORT"] = "9090"
        result = hydrate(options())
        assert result.kept == ("HTTP_PORT",)
        assert os.environ["HTTP_PORT"] == "9090"

    def test_still_fails_on_a_missing_key_the_local_environment_does_not_supply(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = returns({k: v for k, v in VALUES.items() if k != "myapp:httpPort"})
        with pytest.raises(LookupError, match="myapp:httpPort"):
            hydrate(options())

    def test_treats_an_empty_local_value_as_absent(self, fake_load: FakeLoad) -> None:
        os.environ["MONGO_URL"] = ""
        result = hydrate(options())
        assert os.environ["MONGO_URL"] == VALUES["shared:mongoUrl"]
        assert "MONGO_URL" in result.applied

    def test_still_reads_the_store_when_every_variable_is_set_locally(
        self, fake_load: FakeLoad
    ) -> None:
        for variable in KEYS.values():
            os.environ[variable] = "local"
        result = hydrate(options())
        assert fake_load.count == 1
        assert result.applied == ()


class TestTheSuccessLine:
    """Which side wins, and why — after the 0.2.0 prefix, in all four modes."""

    def line(self, fake_load: FakeLoad, **overrides: Any) -> str:
        logger = RecordingLogger()
        hydrate(options(logger=logger, **overrides))
        assert logger.errors == []
        return logger.infos[0]

    def test_store_wins_because_website_instance_id_is_present(self, fake_load: FakeLoad) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        assert self.line(fake_load) == f"{PREFIX} (store wins: WEBSITE_INSTANCE_ID present)"

    def test_local_wins_because_website_instance_id_is_absent_with_nothing_kept(
        self, fake_load: FakeLoad
    ) -> None:
        assert self.line(fake_load) == f"{PREFIX} (local wins: WEBSITE_INSTANCE_ID absent)"

    def test_counts_an_empty_website_instance_id_as_absent(self, fake_load: FakeLoad) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = ""
        assert self.line(fake_load).endswith("(local wins: WEBSITE_INSTANCE_ID absent)")

    def test_names_the_option_when_true_is_passed(self, fake_load: FakeLoad) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        line = self.line(fake_load, local_overrides_win=True)
        assert line == f"{PREFIX} (local wins: local_overrides_win option true)"

    def test_names_the_option_when_false_is_passed(self, fake_load: FakeLoad) -> None:
        line = self.line(fake_load, local_overrides_win=False)
        assert line == f"{PREFIX} (store wins: local_overrides_win option false)"

    def test_states_the_decision_for_the_string_false_which_is_truthy(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        os.environ["MONGO_URL"] = "mongodb://local"
        line = self.line(fake_load, local_overrides_win=cast(Any, "false"))
        assert line.endswith("(local wins: local_overrides_win option true)")
        assert os.environ["MONGO_URL"] == "mongodb://local"

    def test_treats_none_as_not_passed_and_names_the_signal(self, fake_load: FakeLoad) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        line = self.line(fake_load, local_overrides_win=None)
        assert line.endswith("(store wins: WEBSITE_INSTANCE_ID present)")

    def test_keeps_the_0_2_0_prefix_intact(self, fake_load: FakeLoad) -> None:
        assert self.line(fake_load).startswith(PREFIX + " (")

    def test_leaves_the_kept_line_as_it_was_and_never_logs_a_value(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["MONGO_URL"] = "mongodb://local-secret"
        logger = RecordingLogger()
        hydrate(options(logger=logger))
        assert logger.infos == [
            "Configuration loaded from App Configuration, label prod: "
            "SERVICE_BUS_CONNECTION, HTTP_PORT (local wins: WEBSITE_INSTANCE_ID absent)",
            "Kept from the local environment: MONGO_URL",
        ]
        for line in logger.infos:
            assert "local-secret" not in line
            for value in VALUES.values():
                assert value not in line

    def test_logs_once_per_successful_attempt_not_per_call(self, fake_load: FakeLoad) -> None:
        logger = RecordingLogger()
        hydrate(options(logger=logger))
        hydrate(options(logger=logger))
        assert len(logger.infos) == 1

    def test_goes_to_the_default_logger_not_under_azure(
        self, fake_load: FakeLoad, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level("INFO", logger="azure_app_config"):
            hydrate(options())
        records = [r for r in caplog.records if r.name == "azure_app_config"]
        assert [r.levelname for r in records] == ["INFO"]
        assert records[0].getMessage().startswith(PREFIX)
        assert not _core.DEFAULT_LOGGER_NAME.startswith("azure.")

    def test_a_logger_that_raises_on_success_leaves_the_success(self, fake_load: FakeLoad) -> None:
        # The environment is written by then: a raise would report a failure that changed it.
        result = hydrate(options(logger=RaisingLogger()))
        assert result.applied
        assert os.environ["MONGO_URL"] == VALUES["shared:mongoUrl"]


class TestMissingKeys:
    def test_names_every_missing_key_at_once(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = returns({"myapp:httpPort": "8080"})
        with pytest.raises(LookupError) as caught:
            hydrate(options())
        message = str(caught.value)
        assert message.startswith("Missing key-values in App Configuration: ")
        assert "shared:mongoUrl (label prod, absent or empty)" in message
        assert "shared:serviceBus (label prod, absent or empty)" in message
        assert not isinstance(caught.value, (ConfigLoadError, ConfigInputError))

    def test_treats_an_empty_stored_value_as_missing(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = returns({**VALUES, "myapp:httpPort": ""})
        with pytest.raises(LookupError, match="myapp:httpPort"):
            hydrate(options())

    def test_refuses_a_json_key_value_rather_than_writing_its_repr(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = returns({**VALUES, "myapp:httpPort": {"port": 8080}})
        with pytest.raises(LookupError) as caught:
            hydrate(options())
        assert "myapp:httpPort (label prod, a JSON object rather than a string)" in str(
            caught.value
        )
        assert "HTTP_PORT" not in os.environ

    def test_refuses_a_number_and_a_list_as_firmly(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = returns({**VALUES, "myapp:httpPort": 8080, "shared:mongoUrl": [1]})
        with pytest.raises(LookupError) as caught:
            hydrate(options())
        assert "a number rather than a string" in str(caught.value)
        assert "a JSON array rather than a string" in str(caught.value)

    def test_refuses_a_nul_character_which_the_environment_cannot_hold(
        self, fake_load: FakeLoad
    ) -> None:
        fake_load.behaviour = returns({**VALUES, "myapp:httpPort": "80\x0080"})
        with pytest.raises(LookupError, match="holds a NUL character"):
            hydrate(options())
        assert "MONGO_URL" not in os.environ

    def test_writes_nothing_when_any_key_is_unusable(self, fake_load: FakeLoad) -> None:
        fake_load.behaviour = returns({**VALUES, "myapp:httpPort": None})
        before = dict(os.environ)
        with pytest.raises(LookupError):
            hydrate(options())
        assert dict(os.environ) == before

    def test_leaves_a_value_it_would_have_overwritten_exactly_as_it_was(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        os.environ["MONGO_URL"] = "mongodb://before"
        fake_load.behaviour = returns({**VALUES, "myapp:httpPort": None})
        with pytest.raises(LookupError):
            hydrate(options())
        assert os.environ["MONGO_URL"] == "mongodb://before"

    def test_restores_the_writes_before_a_write_that_fails(
        self, fake_load: FakeLoad, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        os.environ["WEBSITE_INSTANCE_ID"] = "instance"
        os.environ["MONGO_URL"] = "mongodb://before"

        class FailingEnviron(MutableMapping[str, str]):
            """os.environ, refusing the third write."""

            def __init__(self) -> None:
                self.writes = 0

            def __getitem__(self, key: str) -> str:
                return real[key]

            def __setitem__(self, key: str, value: str) -> None:
                self.writes += 1
                if self.writes == 3:
                    raise OSError("the environment refused the write")
                real[key] = value

            def __delitem__(self, key: str) -> None:
                del real[key]

            def __iter__(self) -> Iterator[str]:
                return iter(real)

            def __len__(self) -> int:
                return len(real)

        real = os.environ
        before = dict(real)
        monkeypatch.setattr(_core.os, "environ", FailingEnviron())
        with pytest.raises(OSError):
            hydrate(options())
        monkeypatch.undo()
        assert dict(os.environ) == before

    def test_arms_the_floor_and_keeps_hydrate_with_backoff_retrying(
        self, fake_load: FakeLoad, clock: Clock
    ) -> None:
        partial = {k: v for k, v in VALUES.items() if k != "myapp:httpPort"}
        stores = [returns(partial), returns(partial), returns(VALUES)]
        seen: list[str] = []
        written_before_attempt: list[bool] = []

        def behaviour(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            # Recorded, not asserted: an assertion here would be one more failure to retry.
            written_before_attempt.append("MONGO_URL" in os.environ)
            return stores.pop(0)(args, kwargs)

        fake_load.behaviour = behaviour
        result = hydrate_with_backoff(
            options(), BackoffOptions(on_error=lambda error, _: seen.append(str(error)))
        )
        assert fake_load.count == 3
        assert written_before_attempt == [False, False, False]  # nothing until every key is there
        assert len(seen) == 2 and all("myapp:httpPort" in s for s in seen)
        assert result.applied == tuple(KEYS.values())


class TestHowTheStoreIsAddressed:
    def test_requires_a_label_and_does_not_invent_one(self, fake_load: FakeLoad) -> None:
        del os.environ["APP_CONFIG_LABEL"]
        os.environ["NODE_ENV"] = "production"
        with pytest.raises(ConfigInputError, match="APP_CONFIG_LABEL is not set"):
            hydrate(options())
        assert fake_load.count == 0

    def test_does_not_fall_back_to_the_environment_for_an_empty_label(
        self, fake_load: FakeLoad
    ) -> None:
        with pytest.raises(ConfigInputError, match="APP_CONFIG_LABEL is not set"):
            hydrate(options(label=""))

    def test_requires_an_endpoint_or_a_connection_string(self, fake_load: FakeLoad) -> None:
        del os.environ["APP_CONFIG_ENDPOINT"]
        with pytest.raises(ConfigInputError, match="Neither APP_CONFIG_ENDPOINT"):
            hydrate(options())
        assert fake_load.count == 0

    def test_prefers_the_connection_string_when_one_is_set(self, fake_load: FakeLoad) -> None:
        os.environ["APP_CONFIG_CONNECTION_STRING"] = CONNECTION_STRING
        hydrate(options())
        args, kwargs = fake_load.calls[0]
        assert args == ()
        assert kwargs["connection_string"] == CONNECTION_STRING

    def test_passes_the_endpoint_and_a_watched_caller_credential_otherwise(
        self, fake_load: FakeLoad
    ) -> None:
        credential = StubCredential()
        hydrate(options(credential=credential))
        args, kwargs = fake_load.calls[0]
        assert args[0] == ENDPOINT
        assert args[1] is not credential  # the watch, which delegates to it
        assert credential.calls == 3  # one per request, as the stub is asked below the policy
        assert kwargs["keyvault_credential"] is credential  # Key Vault gets it untouched

    def test_reuses_one_default_credential_and_a_reset_drops_it_without_closing(
        self, fake_load: FakeLoad, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        made: list[Any] = []

        class Counted(StubCredential):
            def __init__(self) -> None:
                super().__init__()
                self.closed = False
                made.append(self)

            def close(self) -> None:
                self.closed = True

        monkeypatch.setattr("azure.identity.DefaultAzureCredential", Counted)
        fake_load.behaviour = raises(provider_timeout(http_error(503)))
        for _ in range(2):
            with pytest.raises(ConfigLoadError):
                hydrate(options(retry_floor_ms=0))
        assert len(made) == 1
        assert (
            fake_load.kwargs(0)["keyvault_credential"] is fake_load.kwargs(1)["keyvault_credential"]
        )
        reset_hydration()
        # An attempt still holding it, or an abandoned load thread, keeps working with it.
        assert not made[0].closed
        with pytest.raises(ConfigLoadError):
            hydrate(options(retry_floor_ms=0))
        assert len(made) == 2
        assert fake_load.kwargs(2)["keyvault_credential"] is made[1]

    def test_never_closes_a_callers_credential(self, fake_load: FakeLoad) -> None:
        class Owned(StubCredential):
            closed = False

            def close(self) -> None:
                self.closed = True

        credential = Owned()
        hydrate(options(credential=credential))
        reset_hydration()
        assert not credential.closed

    def test_uses_default_azure_credential_when_none_is_passed(self, fake_load: FakeLoad) -> None:
        hydrate(options())
        assert isinstance(fake_load.kwargs()["keyvault_credential"], StubCredential)

    def test_defaults_the_startup_timeout_to_15_s_not_the_providers_100_s(
        self, fake_load: FakeLoad
    ) -> None:
        hydrate(options())
        assert fake_load.kwargs()["startup_timeout"] == 15.0

    def test_lets_the_caller_set_the_startup_timeout(self, fake_load: FakeLoad) -> None:
        hydrate(options(timeout_ms=2_500))
        assert fake_load.kwargs()["startup_timeout"] == 2.5

    def test_does_not_print_the_connection_string_in_the_options_repr(self) -> None:
        text = repr(options(connection_string=CONNECTION_STRING))
        assert "c2VjcmV0" not in text
