"""The limits and the policy reach the clients the real provider builds (no network).

The provider's `load()` runs for real; only its two client classes are replaced by recorders, at
the names the provider looks them up by (`_client_manager.py:18`,
`_key_vault/_secret_provider.py:8`), so what they are constructed with is what it passes.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any

import pytest
from azure.appconfiguration import SecretReferenceConfigurationSetting
from azure.core.pipeline import Pipeline
from azure.core.rest import HttpRequest
from helpers import CONNECTION_STRING, FakeTransport, _FakeHttpResponse, options

from azure_app_config import hydrate
from azure_app_config._diagnostics import DiagnosticsPolicy

pytestmark = pytest.mark.unit

VAULT = "https://vault.example.invalid"


class _Pages:
    etag = "etag"

    def __init__(self, items: list[Any]) -> None:
        self._pages = iter([items])

    def __iter__(self) -> _Pages:
        return self

    def __next__(self) -> list[Any]:
        return next(self._pages)


class _Listing:
    def __init__(self, items: list[Any]) -> None:
        self.items = items

    def by_page(self, **kwargs: Any) -> _Pages:
        return _Pages(self.items)


class RecordingStoreClient:
    built: list[dict[str, Any]] = []
    listed: list[dict[str, Any]] = []

    def __init__(self, base_url: str | None = None, credential: Any = None, **kwargs: Any):
        RecordingStoreClient.built.append(kwargs)

    @classmethod
    def from_connection_string(cls, connection_string: str, **kwargs: Any) -> RecordingStoreClient:
        return cls(**kwargs)

    def list_configuration_settings(self, **kwargs: Any) -> _Listing:
        RecordingStoreClient.listed.append(kwargs)
        reference = SecretReferenceConfigurationSetting(
            key=kwargs["key_filter"], secret_id=f"{VAULT}/secrets/name"
        )
        return _Listing([reference])

    def close(self) -> None:
        pass


class RecordingSecretClient:
    built: list[dict[str, Any]] = []

    def __init__(self, vault_url: str, credential: Any, **kwargs: Any) -> None:
        RecordingSecretClient.built.append({"vault_url": vault_url, **kwargs})

    def get_secret(self, name: str, version: str | None = None) -> Any:
        return SimpleNamespace(value="resolved")

    def close(self) -> None:
        pass


@pytest.fixture
def recorders(monkeypatch: pytest.MonkeyPatch) -> None:
    RecordingStoreClient.built, RecordingStoreClient.listed = [], []
    RecordingSecretClient.built = []
    monkeypatch.setattr(
        "azure.appconfiguration.provider._client_manager.AzureAppConfigurationClient",
        RecordingStoreClient,
    )
    monkeypatch.setattr(
        "azure.appconfiguration.provider._key_vault._secret_provider.SecretClient",
        RecordingSecretClient,
    )


def test_the_limits_reach_the_store_clients_each_operation_and_the_vault_client(
    recorders: None,
) -> None:
    os.environ["APP_CONFIG_CONNECTION_STRING"] = CONNECTION_STRING
    result = hydrate(options(keys={"shared:mongoUrl": "MONGO_URL"}, timeout_ms=4_000))
    assert result.applied == ("MONGO_URL",)
    assert os.environ["MONGO_URL"] == "resolved"

    limits = {"retry_total": 0, "connection_timeout": 8.0, "read_timeout": 8.0}
    [store] = RecordingStoreClient.built
    assert {k: store[k] for k in limits} == limits
    assert isinstance(store["per_retry_policies"][0], DiagnosticsPolicy)
    [listed] = RecordingStoreClient.listed
    assert {k: listed[k] for k in limits} == limits  # per operation, too
    [vault] = RecordingSecretClient.built
    assert vault == {"vault_url": f"{VAULT}/", **limits}


def test_the_real_clients_honour_the_limits() -> None:
    # What the recorders were given, a real client turns into no retries and bounded transports.
    from azure.appconfiguration import AzureAppConfigurationClient
    from azure.core.pipeline.policies import RetryPolicy
    from azure.keyvault.secrets import SecretClient
    from helpers import StubCredential

    limits = {"retry_total": 0, "connection_timeout": 8.0, "read_timeout": 8.0}
    store = AzureAppConfigurationClient.from_connection_string(CONNECTION_STRING, **limits)
    vault = SecretClient(VAULT, StubCredential(), **limits)  # type: ignore[arg-type]
    for pipeline in (store._impl._client._pipeline, vault._client._client._pipeline):
        [retry] = [p for p in pipeline._impl_policies if isinstance(p, RetryPolicy)]
        assert retry.total_retries == 0
        config = pipeline._transport.connection_config
        assert (config.timeout, config.read_timeout) == (8.0, 8.0)


def test_one_policy_serves_two_pipelines_each_keeping_its_own_next() -> None:
    # The provider hands one instance to every client, replicas included; azure-core rewires an
    # HTTPPolicy's `next` per pipeline, which would send the primary's requests down the last
    # replica's chain.
    policy = DiagnosticsPolicy()
    first = FakeTransport(lambda request: _FakeHttpResponse(200, "{}"))
    second = FakeTransport(lambda request: _FakeHttpResponse(403, None))
    primary = Pipeline(first, [policy])  # type: ignore[arg-type]
    replica = Pipeline(second, [policy])  # type: ignore[arg-type]
    primary.run(HttpRequest("GET", "https://primary.example.invalid/kv"))
    replica.run(HttpRequest("GET", "https://replica.example.invalid/kv"))
    assert [r.url for r in first.requests] == ["https://primary.example.invalid/kv"]
    assert [r.url for r in second.requests] == ["https://replica.example.invalid/kv"]
    traffic = policy.traffic()
    assert (traffic.answered, traffic.failed, traffic.pending) == (2, 0, 0)
    assert [o.status for o in policy.observations()] == [403]
