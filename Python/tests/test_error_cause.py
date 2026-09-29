"""Invariant 3 — report the underlying cause.

On the Python provider the chain often carries it (`helpers.py` records where and why), so these
tests check three things: that a preserved cause is reported, that it is attributed to the right
side of the wire, and that where the chain has nothing — the attempt's bound fired — the wire
evidence is stated as facts and candidates, never as a verdict it cannot support.
"""

from __future__ import annotations

import os
import threading

import pytest
from helpers import (
    CONNECTION_STRING,
    INVALID_CONNECTION_STRING,
    Behaviour,
    FakeLoad,
    HangingCredential,
    StubCredential,
    Wire,
    connection_refused_error,
    fails_after_read,
    fails_on_wire,
    hangs,
    http_error,
    key_vault_invalid_id,
    key_vault_no_uri,
    key_vault_unreachable,
    name_resolution_error,
    options,
    provider_timeout,
    raises,
    token_then_raises,
)

from azure_app_config import ConfigInputError, ConfigLoadError, hydrate

pytestmark = pytest.mark.unit


def failure(fake_load: FakeLoad, behaviour: Behaviour, **overrides: object) -> ConfigLoadError:
    fake_load.behaviour = behaviour
    with pytest.raises(ConfigLoadError) as caught:
        hydrate(options(retry_floor_ms=0, **overrides))
    return caught.value


class TestWhatTheStoreAnswered:
    def test_reports_a_403_with_its_status(self, fake_load: FakeLoad) -> None:
        error = failure(
            fake_load, fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))
        )
        assert error.status_code == 403
        assert "HTTP 403" in error.detail
        assert "not authorised" in str(error)

    def test_prefers_the_stores_own_words_when_it_sends_them(self, fake_load: FakeLoad) -> None:
        body = '{"type":"x","title":"Access denied to the requested key-value.","status":403}'
        error = failure(
            fake_load,
            fails_on_wire(Wire(status=403, body=body), provider_timeout(http_error(403, body))),
        )
        assert "Access denied to the requested key-value." in error.detail
        assert "Operation returned an invalid status" not in error.detail

    def test_tells_a_refused_read_apart_from_an_unreachable_store(
        self, fake_load: FakeLoad
    ) -> None:
        refused = failure(
            fake_load, fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))
        )
        lookup = name_resolution_error()
        unreachable = failure(
            fake_load, fails_on_wire(Wire(raises=lookup), provider_timeout(lookup), tries=3)
        )
        assert refused.detail != unreachable.detail
        assert unreachable.status_code is None
        assert "Failed to resolve" in unreachable.detail
        assert "ServiceRequestError" in unreachable.detail
        assert unreachable.observations[0].code == "ServiceRequestError"

    def test_reports_a_refused_connection(self, fake_load: FakeLoad) -> None:
        refused = connection_refused_error()
        error = failure(
            fake_load, fails_on_wire(Wire(raises=refused), provider_timeout(refused), tries=3)
        )
        assert "Connection refused" in error.detail
        assert error.status_code is None

    def test_tells_a_throttled_store_apart_from_a_refused_one(self, fake_load: FakeLoad) -> None:
        error = failure(
            fake_load, fails_on_wire(Wire(status=429), provider_timeout(http_error(429)), tries=3)
        )
        assert error.status_code == 429
        assert "quota" in str(error)

    def test_records_every_distinct_failure_once_across_the_sdks_retries(
        self, fake_load: FakeLoad
    ) -> None:
        error = failure(
            fake_load, fails_on_wire(Wire(status=500), provider_timeout(http_error(500)), tries=3)
        )
        assert len(error.observations) == 1
        assert error.observations[0].status == 500

    def test_a_401_is_reported_as_the_store_rejecting_the_credential(
        self, fake_load: FakeLoad
    ) -> None:
        error = failure(
            fake_load, fails_on_wire(Wire(status=401), provider_timeout(http_error(401)))
        )
        assert error.status_code == 401
        assert "rejected the credential" in error.detail

    def test_keeps_the_provider_error_as_cause_unmodified(self, fake_load: FakeLoad) -> None:
        thrown = provider_timeout(http_error(403))
        error = failure(fake_load, fails_on_wire(Wire(status=403), thrown))
        assert error.__cause__ is thrown

    def test_names_the_store_and_label_that_failed(self, fake_load: FakeLoad) -> None:
        error = failure(
            fake_load, fails_on_wire(Wire(status=403), provider_timeout(http_error(403)))
        )
        assert "https://example.invalid" in str(error)
        assert "label prod" in str(error)

    def test_uses_the_chain_when_the_policy_saw_nothing(self, fake_load: FakeLoad) -> None:
        # Drift, or a failure the policy could not see: the provider's collected errors still say.
        error = failure(fake_load, raises(provider_timeout(http_error(503))))
        assert error.status_code == 503
        assert "Service Unavailable" in error.detail

    def test_survives_an_error_with_no_nesting_at_all(self, fake_load: FakeLoad) -> None:
        error = failure(fake_load, raises(RuntimeError("plain failure")))
        assert error.detail == "plain failure [RuntimeError]"

    def test_does_not_loop_forever_on_a_self_referential_cause(self, fake_load: FakeLoad) -> None:
        circular = RuntimeError("round and round")
        circular.__cause__ = circular
        error = failure(fake_load, raises(circular))
        assert "round and round" in error.detail


class TestKeyVaultReferences:
    """On 2.5.0 a reference fails at once, after the store answered — not as a timeout."""

    def test_a_vault_that_refuses_is_not_reported_as_the_store_refusing(
        self, fake_load: FakeLoad
    ) -> None:
        error = failure(fake_load, fails_after_read(provider_timeout(http_error(403))))
        assert error.status_code == 403
        assert "did not come from the store" in error.detail
        assert "Key Vault" in error.detail

    def test_an_unparseable_reference_is_a_load_error_naming_the_reference(
        self, fake_load: FakeLoad
    ) -> None:
        error = failure(
            fake_load, fails_after_read(key_vault_invalid_id("s3cr3t-pasted-by-mistake"))
        )
        assert "s3cr3t" not in str(error)  # the provider's message echoes the stored value
        assert "the stored value is withheld" in error.detail
        assert "answered 3 of the 3 requests" in error.detail
        assert "a Key Vault reference" in error.detail

    def test_a_reference_with_no_uri_is_a_load_error(self, fake_load: FakeLoad) -> None:
        error = failure(fake_load, fails_after_read(key_vault_no_uri()))
        assert "must have a uri value" in error.detail
        assert "a Key Vault reference" in error.detail

    def test_an_unreachable_vault_stays_retryable(self, fake_load: FakeLoad) -> None:
        error = failure(fake_load, fails_after_read(key_vault_unreachable()))
        assert not isinstance(error, ConfigInputError)
        assert error.detail.startswith("Failed to retrieve secret from Key Vault [ValueError]: ")
        assert "vault.example.invalid" in error.detail


class TestValueErrorsAfterTheNetwork:
    """A ValueError after any network activity is a load error: transient failures arrive so."""

    def test_a_non_json_identity_endpoint_body_is_a_load_error(self, fake_load: FakeLoad) -> None:
        from helpers import FlakyJsonCredential, returns

        error = failure(fake_load, returns(), credential=FlakyJsonCredential(failures=1))
        assert "JSONDecodeError" in error.detail
        assert error.observations[0].code == "JSONDecodeError"

    def test_a_deserialization_error_after_the_store_answered_is_a_load_error(
        self, fake_load: FakeLoad
    ) -> None:
        from azure.core.exceptions import DeserializationError

        assert issubclass(DeserializationError, ValueError)
        error = failure(
            fake_load, fails_after_read(DeserializationError("Unable to deserialize response"))
        )
        assert "Unable to deserialize response [DeserializationError]" in error.detail


class TestInputErrorsFromTheProvider:
    @pytest.mark.parametrize(
        "thrown",
        [
            ValueError(INVALID_CONNECTION_STRING),
            IndexError("list index out of range"),
            ValueError("No endpoint specified."),
            TypeError("Unexpected positional parameters."),
        ],
    )
    def test_reports_a_pre_request_refusal_as_an_input_error_that_spent_nothing(
        self, fake_load: FakeLoad, thrown: Exception
    ) -> None:
        fake_load.behaviour = raises(thrown)
        with pytest.raises(ConfigInputError) as caught:
            hydrate(options(retry_floor_ms=0))
        assert not isinstance(caught.value, ConfigLoadError)
        assert caught.value.reached_store is False
        assert str(thrown) in str(caught.value)
        assert caught.value.__cause__ is thrown


class TestSilence:
    """No failure on the store's wire. Stated from in-process evidence, never from wording."""

    def test_names_the_credential_when_a_token_was_asked_for_and_never_came(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        error = failure(
            fake_load, hangs(release), credential=HangingCredential(release), timeout_ms=100
        )
        assert "never answered" in error.detail
        assert "rather than the store" in error.detail
        assert "per_retry_policies" not in error.detail
        assert "network path" not in error.detail

    def test_names_the_policy_when_the_token_arrived_and_no_request_was_seen(
        self, fake_load: FakeLoad
    ) -> None:
        error = failure(
            fake_load, token_then_raises(provider_timeout()), credential=StubCredential()
        )
        assert "no longer passing per_retry_policies" in error.detail
        assert "credential is the suspect" not in error.detail
        assert "unreachable" not in error.detail

    def test_reports_a_complete_read_with_nothing_in_flight_and_names_a_key_vault_reference(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        error = failure(
            fake_load,
            hangs(release, answered=3, request=False),
            credential=StubCredential(),
            timeout_ms=100,
        )
        assert error.observations == ()
        assert error.status_code is None
        assert "when the startup timeout fired" in error.detail
        assert "the store had answered 3 of the 3 requests" in error.detail
        assert "0 were still in flight" in error.detail
        assert "for 3 selectors" in error.detail
        assert "Not ruled out: a Key Vault reference" in error.detail
        assert "network path" not in error.detail
        assert "per_retry_policies" not in error.detail

    def test_reports_the_same_on_the_access_key_path(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        os.environ["APP_CONFIG_CONNECTION_STRING"] = CONNECTION_STRING
        error = failure(fake_load, hangs(release, answered=3, request=False), timeout_ms=100)
        assert "answered 3 of the 3 requests" in error.detail
        assert "Key Vault reference" in error.detail
        assert "the cause is unreported" not in error.detail

    def test_names_the_network_and_the_store_when_a_request_never_came_back(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        error = failure(fake_load, hangs(release), credential=StubCredential(), timeout_ms=100)
        assert "answered 0 of the 1 request this" in error.detail
        assert "1 was still in flight" in error.detail
        assert "the network path to the store" in error.detail
        assert "the store not answering" in error.detail
        assert "Key Vault" not in error.detail

    def test_keeps_the_network_in_play_when_one_selector_answered_and_the_next_hung(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        error = failure(
            fake_load, hangs(release, answered=1), credential=StubCredential(), timeout_ms=100
        )
        assert "answered 1 of the 2 requests" in error.detail
        assert "the network path to the store" in error.detail
        assert "Key Vault" not in error.detail

    def test_keeps_a_key_vault_reference_in_play_with_a_request_in_flight_after_a_full_read(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        error = failure(
            fake_load, hangs(release, answered=3), credential=StubCredential(), timeout_ms=100
        )
        assert "answered 3 of the 4 requests" in error.detail
        assert "the network path to the store" in error.detail
        assert "a Key Vault reference" in error.detail

    def test_says_the_reads_had_not_finished_when_fewer_selectors_were_answered(
        self, fake_load: FakeLoad
    ) -> None:
        error = failure(
            fake_load, fails_after_read(provider_timeout(), answered=1), credential=StubCredential()
        )
        assert "when the load failed" in error.detail
        assert "answered 1 of the 1 request" in error.detail
        assert "reads that had not finished" in error.detail
        assert "Key Vault" not in error.detail

    def test_counts_what_was_in_flight_when_the_bound_fired_not_later(
        self, fake_load: FakeLoad, release: threading.Event
    ) -> None:
        # The request is answered after the bound fired: that must not turn "in flight" into
        # "answered".
        error = failure(fake_load, hangs(release), credential=StubCredential(), timeout_ms=50)
        release.set()
        assert "when the startup timeout fired" in error.detail
        assert "answered 0 of the 1 request" in error.detail
        assert "1 was still in flight" in error.detail

    def test_names_nothing_when_no_token_was_ever_requested(self, fake_load: FakeLoad) -> None:
        error = failure(fake_load, raises(provider_timeout()), credential=StubCredential())
        assert "the cause is unreported" in error.detail
        assert "unreachable" not in error.detail

    def test_names_nothing_on_the_access_key_path_where_no_token_is_in_play(
        self, fake_load: FakeLoad
    ) -> None:
        os.environ["APP_CONFIG_CONNECTION_STRING"] = CONNECTION_STRING
        error = failure(fake_load, raises(provider_timeout()))
        assert "no token was in play" in error.detail
        assert "the cause is unreported" in error.detail
        assert "credential is the suspect" not in error.detail


class TestTheCredentialWatch:
    """azure-core prefers `get_token_info` when a credential has it (DefaultAzureCredential does),
    so the watch must offer it exactly when the credential does, and record it."""

    def test_watches_get_token_info_when_the_credential_offers_it(self) -> None:
        from azure.core.credentials import AccessTokenInfo

        from azure_app_config._diagnostics import watch_credential

        class InfoCredential:
            def __init__(self) -> None:
                self.closed = False

            def get_token(self, *scopes: str, **kwargs: object) -> object:
                raise AssertionError("get_token_info is preferred")

            def get_token_info(self, *scopes: str, options: object = None) -> AccessTokenInfo:
                return AccessTokenInfo("not-a-real-token", 0)

            def close(self) -> None:
                self.closed = True

        inner = InfoCredential()
        watch = watch_credential(inner)  # type: ignore[arg-type]
        assert not watch.evidence().requested
        assert watch.get_token_info("scope").token == "not-a-real-token"  # type: ignore[attr-defined]
        assert watch.evidence().requested and watch.evidence().resolved
        with watch:  # type: ignore[attr-defined]
            pass
        watch.close()  # type: ignore[attr-defined]
        assert inner.closed

    def test_offers_only_get_token_to_a_credential_without_get_token_info(self) -> None:
        from azure_app_config._diagnostics import watch_credential

        seen: dict[str, object] = {}

        class PlainCredential:
            def get_token(self, *scopes: str, **kwargs: object) -> object:
                seen.update(kwargs)
                return object()

        watch = watch_credential(PlainCredential())  # type: ignore[arg-type]
        assert not hasattr(watch, "get_token_info")
        watch.get_token("scope", claims="c", tenant_id="t", enable_cae=True)
        assert seen == {"claims": "c", "tenant_id": "t", "enable_cae": True}
        assert watch.evidence().resolved

    def test_records_a_credential_that_raises_as_asked_and_not_answered(self) -> None:
        from azure_app_config._diagnostics import watch_credential

        class Failing:
            def get_token(self, *scopes: str, **kwargs: object) -> object:
                raise RuntimeError("no identity")

        watch = watch_credential(Failing())  # type: ignore[arg-type]
        with pytest.raises(RuntimeError):
            watch.get_token("scope")
        assert watch.evidence().requested and not watch.evidence().resolved


def test_reports_every_member_of_an_exception_group(fake_load: FakeLoad) -> None:
    group = ExceptionGroup("several", [http_error(503), name_resolution_error()])
    error = failure(fake_load, raises(group))
    assert "HTTP 503" in error.detail
    assert "Failed to resolve" in error.detail
    assert error.status_code == 503
