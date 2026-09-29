"""The provider's half of the contract — what the unit suite, with `load()` faked, cannot check.

Everywhere else `load()` is replaced, so the unit tests prove that this package builds the policy
and reads what it is shown. They assume the rest: that the provider still forwards
`per_retry_policies` to every client it builds, that azure-core still puts it below the retry
policy, and that the error shapes in `helpers.py` are the ones the provider raises. A provider
upgrade that broke any of that would leave every unit test green.

So these run the real `load()`. No Azure, no credentials, no egress: `nope.example.invalid` is
reserved by RFC 2606 and can never resolve, and the fake store listens on 127.0.0.1 and is reached
through the access-key path, which (unlike a bearer token) azure-core lets travel over plain HTTP.
The provider pads a failure to five seconds (`_utils.py:30-41`), which is why these are not in the
unit run: `make test-integration-py`.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from helpers import HangingCredential, StubCredential

from azure_app_config import ConfigLoadError, HydrateOptions, hydrate, retry_after_ms

pytestmark = pytest.mark.integration

KEYS = {"shared:mongoUrl": "INTEGRATION_MONGO_URL", "myapp:httpPort": "INTEGRATION_HTTP_PORT"}
KEY_VAULT_REF = "application/vnd.microsoft.appconfig.keyvaultref+json;charset=utf-8"


class FakeStore:
    """A local App Configuration that answers list requests as `mode` says, and counts them."""

    def __init__(self) -> None:
        self.mode = "ok"
        self.requests: list[str] = []
        store = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def do_GET(self) -> None:
                store.requests.append(self.path)
                if store.mode == "403":
                    self._send(403, {"title": "Access denied to the requested key-value."})
                    return
                if store.mode == "503":
                    self._send(503, {"title": "Service unavailable."})
                    return
                if store.mode == "429-long":
                    # A long Retry-After, which azure-core would sleep uncapped if it retried.
                    self._send(429, {"title": "Too many requests."}, {"Retry-After": "3600"})
                    return
                key = parse_qs(urlparse(self.path).query).get("key", [""])[0]
                item: dict[str, Any] = {"key": key, "label": "prod", "value": f"value-of-{key}"}
                if store.mode == "bad-reference":
                    item["value"] = json.dumps({"uri": "stored-value-that-is-not-a-uri"})
                    item["content_type"] = KEY_VAULT_REF
                self._send(200, {"items": [item]})

            def _send(
                self, status: int, body: dict[str, Any], headers: dict[str, str] | None = None
            ) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def connection_string(self) -> str:
        return f"Endpoint=http://127.0.0.1:{self.port};Id=local;Secret=bG9jYWw="


@pytest.fixture
def store() -> Iterator[FakeStore]:
    fake = FakeStore()
    yield fake
    fake.server.shutdown()
    fake.server.server_close()


@pytest.fixture(autouse=True)
def no_leftovers() -> Iterator[None]:
    yield
    for variable in KEYS.values():
        os.environ.pop(variable, None)


def invalid_endpoint(**overrides: Any) -> HydrateOptions:
    values: dict[str, Any] = {
        "keys": KEYS,
        "label": "prod",
        "endpoint": "https://nope.example.invalid",
        "credential": StubCredential(),
        "timeout_ms": 8_000,
        "retry_floor_ms": 0,
        "local_overrides_win": False,
    }
    values.update(overrides)
    return HydrateOptions(**values)


def local(store: FakeStore, **overrides: Any) -> HydrateOptions:
    values: dict[str, Any] = {
        "keys": KEYS,
        "label": "prod",
        "connection_string": store.connection_string,
        "credential": StubCredential(),
        "timeout_ms": 6_000,
        "retry_floor_ms": 0,
        "local_overrides_win": False,
    }
    values.update(overrides)
    return HydrateOptions(**values)


class TestTheRealProvider:
    def test_still_lets_the_diagnostics_policy_see_a_failure(self) -> None:
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(invalid_endpoint())
        error = caught.value
        # The contract, in one assertion: per_retry_policies reached the client and the policy ran.
        assert len(error.observations) > 0
        assert error.observations[0].code == "ServiceRequestError"
        assert "the cause is unreported" not in error.detail
        assert "no request" not in error.detail
        assert "nope.example.invalid" in error.detail

    def test_keeps_the_cause_in_its_timeout_as_helpers_records(self) -> None:
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(invalid_endpoint(timeout_ms=12_000))
        cause = caught.value.__cause__
        # The provider's own TimeoutError, carrying what each pass raised.
        assert isinstance(cause, TimeoutError)
        assert cause.args[0] == "The provider timed out while attempting to load."
        assert cause.args[1]
        assert type(cause.args[1][0]).__name__ == "ServiceRequestError"

    def test_attributes_a_hung_credential_to_the_credential(self) -> None:
        release = threading.Event()
        credential = HangingCredential(release)
        try:
            began = time.monotonic()
            with pytest.raises(ConfigLoadError) as caught:
                hydrate(invalid_endpoint(credential=credential, timeout_ms=2_000))
            assert time.monotonic() - began < 4
        finally:
            release.set()
        assert credential.requested.is_set()
        detail = caught.value.detail
        assert "never answered" in detail
        assert "rather than the store" in detail
        assert "per_retry_policies" not in detail
        assert "network path" not in detail


class TestALocalFakeStore:
    def test_a_success_costs_one_request_per_key(self, store: FakeStore) -> None:
        result = hydrate(local(store))
        assert len(store.requests) == 2
        assert result.applied == tuple(KEYS.values())
        assert os.environ["INTEGRATION_MONGO_URL"] == "value-of-shared:mongoUrl"

    def test_a_403_costs_one_request_and_reports_the_stores_words(self, store: FakeStore) -> None:
        store.mode = "403"
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(local(store))
        assert len(store.requests) == 1
        assert caught.value.status_code == 403
        assert "Access denied to the requested key-value. [HTTP 403]" in caught.value.detail

    def test_an_unparseable_key_vault_reference_is_a_retryable_load_error(
        self, store: FakeStore
    ) -> None:
        store.mode = "bad-reference"
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(local(store))
        assert retry_after_ms(caught.value) is None  # retry_floor_ms=0 here: retry now
        assert "a Key Vault reference" in caught.value.detail
        assert len(store.requests) == 2
        assert "stored-value-that-is-not-a-uri" not in str(caught.value)
        assert "withheld" in str(caught.value)
        assert isinstance(caught.value.__cause__, ValueError)

    def test_a_503_costs_one_request_because_the_sdk_does_not_retry(self, store: FakeStore) -> None:
        store.mode = "503"
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(local(store))
        assert len(store.requests) == 1
        assert caught.value.status_code == 503

    def test_a_429_with_a_long_retry_after_is_not_slept(self, store: FakeStore) -> None:
        store.mode = "429-long"
        began = time.monotonic()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(local(store))
        # The provider's own error, before the bound: the load thread did not sleep 3600 s.
        assert time.monotonic() - began < 6
        assert caught.value.status_code == 429
        assert "did not finish" not in caught.value.detail
        assert len(store.requests) == 1

    def test_a_refused_connection_sends_nothing_to_the_store(self, store: FakeStore) -> None:
        options = local(store)
        store.server.shutdown()
        store.server.server_close()
        with pytest.raises(ConfigLoadError) as caught:
            hydrate(options)
        assert store.requests == []
        assert "Connection refused" in caught.value.detail or "refused" in caught.value.detail
