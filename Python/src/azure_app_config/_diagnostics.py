"""Why this file exists, on the Python provider (azure-appconfiguration-provider 2.5.0).

The Python provider does not discard the cause as the JavaScript one does. `_load_all`
(`_azureappconfigurationprovider.py:223-249`) retries every `AzureError` a pass raises — a
refused or throttled read, a failed name lookup, a refused connection, a Key Vault read the vault
refused — collecting each into `startup_exceptions` (`:314-319`), and when the next back-off would
overrun `startup_timeout` it raises `TimeoutError("The provider timed out while attempting to
load.", startup_exceptions)` (`:243-246`). So the chain carries the real errors, and where it does,
`detail` reports them. Anything that is not an `AzureError` escapes the loop at once and is
re-raised bare after `delay_failure` pads the call to five seconds (`_load.py:201-205`,
`_utils.py:30-41`): that is how a Key Vault reference the provider cannot parse arrives.

What the chain cannot say is where an HTTP status came from, or what happened when a pass never
finished. `startup_timeout` is checked only between passes (`:240-246`), so a request that hangs
holds the pass, and `load()`, for as long as the transport lets it — the provider does not bound
it. `hydrate()` therefore bounds the attempt itself (`_core.py`) and, when that bound wins, has no
provider error at all. For both, this module watches the store's pipeline:

- The provider forwards every keyword it does not consume to each `AzureAppConfigurationClient`
  it builds, the replicas it discovers included (`_client_manager.py:431-437`, `:507-531`, via
  `ConfigurationClientManagerBase._args`, `_client_manager_base.py:41`), and azure-core inserts
  `per_retry_policies` directly after the `RetryPolicy` (`azure/core/_pipeline_client.py:155-172`).
  So `DiagnosticsPolicy` sees every try at no extra request.
- One instance is handed to every client, so it is a `SansIOHTTPPolicy`: azure-core wraps that in
  a fresh runner per pipeline (`azure/core/pipeline/_base.py:170-176`), whereas an `HTTPPolicy`
  instance has its `next` rewired by each pipeline built with it — with replicas, the primary's
  requests would run down another client's chain. The instance holds only the shared counts.
- It sits *above* the authentication policy in that list, unlike the JavaScript pipeline, so a
  token is asked for inside the policy's `next`. A request waiting on a credential that never
  answers therefore counts as in flight, and the credential watch says why.
- Key Vault requests go through `SecretClient`s the provider builds from its own config
  (`_key_vault/_secret_provider.py:48-56`), which this policy is not given. A status in the chain
  that the store's pipeline never saw came from outside it.
"""

from __future__ import annotations

import json
import re
import sys
import threading
from dataclasses import dataclass
from typing import Any

from azure.core.credentials import (
    AccessToken,
    AccessTokenInfo,
    TokenCredential,
    TokenRequestOptions,
)
from azure.core.exceptions import AzureError
from azure.core.pipeline import PipelineRequest, PipelineResponse
from azure.core.pipeline.policies import SansIOHTTPPolicy

from ._errors import message_of
from ._types import FailureObservation

MAX_BODY_CHARACTERS = 300

PROVIDER_TIMEOUT_MESSAGE = "The provider timed out while attempting to load."
"""`_azureappconfigurationprovider.py:244`. Opaque only when it carries no errors."""

# `azure/keyvault/secrets/_shared/__init__.py:50-57` echoes the stored reference into its message:
# `'<source_id>' is not a valid ID`. That is the key-value's own value, and no line this package
# writes may carry a value — a mistyped reference can hold the secret itself.
_VALUE_ECHO = re.compile(r"^'.*' is not a valid ID$", re.DOTALL)
WITHHELD_REFERENCE = (
    "a Key Vault reference's URI is not a valid Key Vault secret identifier "
    "(the stored value is withheld)"
)

# The provider's own argument checks raise these before any request (`_utils.py:78-120`,
# `_azureappconfigurationprovider.py:46-48`, `appconfiguration/_utils.py:16-38`): Python's
# counterparts of the JavaScript provider's ArgumentError/TypeError/RangeError. The same classes
# also arrive after network activity from failures waiting can fix, so the class alone never makes
# an input error: see `argument_error_in_chain`.
_INPUT_ERRORS = (ValueError, TypeError, IndexError)


@dataclass(frozen=True)
class Traffic:
    """Requests counted by outcome, not by departure: a request that left and never came back is
    not evidence that the store answered."""

    answered: int
    """Requests the store answered with a response, of any status."""
    failed: int
    """Requests that raised before a response: the transport, or the credential below this."""
    pending: int
    """Requests sent and not yet settled either way."""

    @property
    def sent(self) -> int:
        return self.answered + self.failed + self.pending


@dataclass(frozen=True)
class CredentialEvidence:
    """Whether a token was asked for during an attempt, and whether it ever came back."""

    requested: bool
    resolved: bool


@dataclass(frozen=True)
class WireEvidence:
    traffic: Traffic
    selectors: int
    """One per key: the number of list requests a complete first read takes."""
    at_timeout: bool


class DiagnosticsPolicy(SansIOHTTPPolicy[Any, Any]):
    """Counts and records what the store's pipeline does, per try. Stateless towards the pipeline
    (no `next`), so one instance can serve every client; thread-safe, because the load runs on a
    worker thread and the caller reads the counts when the attempt's bound fires."""

    name = "actvalue-azure-app-config-diagnostics"

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._sent = 0
        self._answered = 0
        self._failed = 0
        self._observed: list[FailureObservation] = []

    def on_request(self, request: PipelineRequest[Any]) -> None:
        with self._lock:
            self._sent += 1

    def on_response(
        self, request: PipelineRequest[Any], response: PipelineResponse[Any, Any]
    ) -> None:
        status = _status_of_response(response)
        observation: FailureObservation | None = None
        if status >= 400:
            observation = _from_response(response, status)
        with self._lock:
            self._answered += 1
            if observation is not None:
                self._record(observation)

    def on_exception(self, request: PipelineRequest[Any]) -> None:
        # Called inside the runner's `except Exception` (`azure/core/pipeline/_base.py:96-101`).
        error = sys.exc_info()[1]
        raised = _from_raised(error) if error is not None else FailureObservation("unknown")
        with self._lock:
            self._failed += 1
            self._record(raised)

    def _record(self, observation: FailureObservation) -> None:
        if observation not in self._observed:
            self._observed.append(observation)

    def observations(self) -> tuple[FailureObservation, ...]:
        with self._lock:
            return tuple(self._observed)

    def traffic(self) -> Traffic:
        with self._lock:
            return Traffic(
                answered=self._answered,
                failed=self._failed,
                pending=self._sent - self._answered - self._failed,
            )


def _status_of_response(response: PipelineResponse[Any, Any]) -> int:
    status = getattr(response.http_response, "status_code", 0)
    return status if isinstance(status, int) else 0


def _from_response(response: PipelineResponse[Any, Any], status: int) -> FailureObservation:
    body: str | None
    try:
        body = response.http_response.text()
    except Exception:
        body = None
    return FailureObservation(
        message=_reason_from_body(body) or _default_reason(status), status=status
    )


def _reason_from_body(body: str | None) -> str | None:
    """App Configuration answers an error with RFC 7807 problem+json; `title` is the sentence
    worth reporting. An error body names the reason a read was refused, never a value."""
    if not isinstance(body, str) or not body.strip():
        return None
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        for field_name in ("title", "detail", "message"):
            candidate = parsed.get(field_name)
            if isinstance(candidate, str) and candidate.strip():
                return _truncate(candidate.strip())
    return _truncate(body.strip())


def _default_reason(status: int) -> str:
    if status == 401:
        return "The store rejected the credential"
    if status == 403:
        return "The credential is not authorised to read this store"
    if status == 404:
        return "The store or key was not found"
    if status == 429:
        return "The store is throttling: the request quota is spent"
    if status >= 500:
        return "The store reported a server error"
    return "The store refused the request"


def _from_raised(error: BaseException) -> FailureObservation:
    status = getattr(error, "status_code", None)
    return FailureObservation(
        message=_truncate(_message_without_body(error)),
        status=status if isinstance(status, int) else None,
        code=type(error).__name__,
    )


def _truncate(text: str) -> str:
    return text if len(text) <= MAX_BODY_CHARACTERS else f"{text[:MAX_BODY_CHARACTERS]}…"


def describe_observations(observations: tuple[FailureObservation, ...]) -> str:
    return "; ".join(_describe_observation(o) for o in observations)


def _describe_observation(observation: FailureObservation) -> str:
    qualifiers = []
    if observation.status is not None:
        qualifiers.append(f"HTTP {observation.status}")
    if observation.code:
        qualifiers.append(observation.code)
    return f"{observation.message} [{' '.join(qualifiers)}]" if qualifiers else observation.message


class _WatchedCredential:
    """Delegates unchanged, and records whether a token was asked for and whether it arrived.

    A credential that never answers and a policy that never runs leave the same silence on the
    wire; only this tells them apart. Only the store credential is watched: the Key Vault client
    gets the caller's own object.
    """

    def __init__(self, inner: TokenCredential) -> None:
        self._inner = inner
        self.requested = False
        self.resolved = False

    def get_token(
        self,
        *scopes: str,
        claims: str | None = None,
        tenant_id: str | None = None,
        enable_cae: bool = False,
        **kwargs: Any,
    ) -> AccessToken:
        self.requested = True
        if claims is not None:
            kwargs["claims"] = claims
        if tenant_id is not None:
            kwargs["tenant_id"] = tenant_id
        if enable_cae:
            kwargs["enable_cae"] = enable_cae
        token = self._inner.get_token(*scopes, **kwargs)
        self.resolved = True
        return token

    def evidence(self) -> CredentialEvidence:
        return CredentialEvidence(requested=self.requested, resolved=self.resolved)


class _WatchedTokenInfoCredential(_WatchedCredential):
    """The same, for a credential that also offers `get_token_info`, which azure-core's
    `BearerTokenCredentialPolicy` prefers when it exists (`_authentication.py:125-132`)."""

    def get_token_info(
        self, *scopes: str, options: TokenRequestOptions | None = None
    ) -> AccessTokenInfo:
        self.requested = True
        info: AccessTokenInfo = self._inner.get_token_info(  # type: ignore[attr-defined]
            *scopes, options=options
        )
        self.resolved = True
        return info

    def close(self) -> None:
        close = getattr(self._inner, "close", None)
        if callable(close):
            close()

    def __enter__(self) -> _WatchedTokenInfoCredential:
        return self

    def __exit__(self, *args: object) -> None:
        return None


def watch_credential(inner: TokenCredential) -> _WatchedCredential:
    if hasattr(inner, "get_token_info"):
        return _WatchedTokenInfoCredential(inner)
    return _WatchedCredential(inner)


# ------------------------------------------------------------------------------------------------
# Reading the provider's error.
# ------------------------------------------------------------------------------------------------


def _children(value: BaseException) -> list[BaseException]:
    """What an error wraps: an exception group's members, the provider's collected startup errors,
    or an explicit `__cause__`. An `AzureError` is a leaf — the SDK's own classification, and its
    message already carries what it wraps. Implicit `__context__` is not followed: it leads into
    library internals, as JavaScript's `cause` walk never did."""
    if isinstance(value, AzureError):
        return []
    if isinstance(value, BaseExceptionGroup):
        return list(value.exceptions)
    args = value.args
    if (
        len(args) >= 2
        and isinstance(args[1], list)
        and args[1]
        and all(isinstance(item, BaseException) for item in args[1])
    ):
        return list(args[1])
    if value.__cause__ is not None:
        return [value.__cause__]
    return []


def _walk(error: BaseException) -> list[BaseException]:
    """Every error in the chain, root first, each once — a self-referential chain terminates."""
    seen: set[int] = set()
    order: list[BaseException] = []
    stack = [error]
    while stack:
        value = stack.pop(0)
        if id(value) in seen:
            continue
        seen.add(id(value))
        order.append(value)
        if not _withheld(value):
            stack.extend(_children(value))
    return order


def _leaves(error: BaseException) -> list[BaseException]:
    return [
        value
        for value in _walk(error)
        if _withheld(value) or not [c for c in _children(value) if c is not value]
    ]


def _withheld(value: BaseException) -> bool:
    return isinstance(value, ValueError) and bool(_VALUE_ECHO.match(_first_arg(value)))


def argument_error_in_chain(error: BaseException) -> bool:
    """The shape of the provider's own argument checks: a `ValueError`, `TypeError` or
    `IndexError` in the chain, and no `AzureError` anywhere in it.

    Not by itself an input error. The same classes arrive from failures waiting can fix once the
    network is involved — an identity endpoint's non-JSON body re-raised as `JSONDecodeError`,
    azure-core's `DeserializationError`, a Key Vault response that does not decode, an unreachable
    vault (`ValueError` raised from a `ServiceRequestError`, `_key_vault/_secret_provider.py:65-66`)
    — so `_core` also requires that nothing touched the network. After it, the shape only decides
    whether `detail` names what the store returned as a candidate."""
    chain = _walk(error)
    if any(isinstance(value, AzureError) for value in chain):
        return False
    return any(isinstance(value, _INPUT_ERRORS) for value in chain)


def _first_arg(value: BaseException) -> str:
    return value.args[0] if value.args and isinstance(value.args[0], str) else ""


def _message_without_body(value: BaseException) -> str:
    """An `AzureError`'s `message`, which unlike `str()` carries no response body
    (`HttpResponseError.__str__` appends `Content: …`)."""
    if isinstance(value, AzureError) and isinstance(value.message, str) and value.message:
        return value.message
    if isinstance(value, TimeoutError) and _first_arg(value):
        # OSError's str() of TimeoutError(msg, errors) reads "[Errno msg] [...]".
        return _first_arg(value)
    return message_of(value)


def _status_of(value: BaseException) -> int | None:
    status = getattr(value, "status_code", None)
    return status if isinstance(status, int) else None


def _describe(value: BaseException) -> str:
    if _withheld(value):
        return f"{WITHHELD_REFERENCE} [{type(value).__name__}]"
    qualifiers = []
    status = _status_of(value)
    if status is not None:
        qualifiers.append(f"HTTP {status}")
        error_code = getattr(value, "error_code", None)
        if isinstance(error_code, str) and error_code:
            qualifiers.append(error_code)
    else:
        qualifiers.append(type(value).__name__)
    return f"{_message_without_body(value)} [{' '.join(qualifiers)}]"


def _opaque(value: BaseException) -> bool:
    return (
        isinstance(value, TimeoutError)
        and _first_arg(value) == PROVIDER_TIMEOUT_MESSAGE
        and not _children(value)
    )


@dataclass(frozen=True)
class _Unwrapped:
    detail: str
    status_code: int | None
    statuses: frozenset[int]
    opaque: bool


def _unwrap(error: BaseException) -> _Unwrapped:
    leaves = _leaves(error) or [error]
    found = [s for s in (_status_of(leaf) for leaf in leaves) if s is not None]
    status_code = found[0] if found else None
    messages: list[str] = []
    for leaf in leaves:
        text = _describe(leaf)
        if text not in messages:
            messages.append(text)
    detail = "; ".join(messages)
    # A root that is neither a leaf nor the provider's own sentence says what was being done when
    # the leaf failed — "Failed to retrieve secret from Key Vault" — so it leads.
    if error not in leaves and _first_arg(error) != PROVIDER_TIMEOUT_MESSAGE and str(error):
        detail = f"{_describe(error)}: {detail}"
    opaque = status_code is None and all(_opaque(leaf) for leaf in leaves)
    return _Unwrapped(
        detail=detail, status_code=status_code, statuses=frozenset(found), opaque=opaque
    )


def explain(
    cause: BaseException | None,
    observations: tuple[FailureObservation, ...],
    credential: CredentialEvidence | None,
    wire: WireEvidence,
    *,
    timed_out_ms: str | None = None,
) -> tuple[str, int | None]:
    """What to report as the reason, and the HTTP status if one was seen.

    The provider's chain wins when it holds anything real. When it holds only the provider's own
    sentence, or nothing — the attempt's bound fired before `load()` returned — the observations
    are all there is, and without them the evidence of silence is stated rather than guessed at.
    """
    if cause is not None and timed_out_ms is None:
        unwrapped = _unwrap(cause)
        observed_statuses = {o.status for o in observations if o.status is not None}
        if unwrapped.status_code is not None and unwrapped.statuses <= observed_statuses:
            # The same responses, seen on the wire with the store's own words ("Access denied…")
            # rather than azure-core's "Operation returned an invalid status 'Forbidden'".
            return describe_observations(observations), unwrapped.status_code
        if not unwrapped.opaque:
            note = _provenance(unwrapped.status_code, cause, observations, wire)
            detail = f"{unwrapped.detail} {note}" if note else unwrapped.detail
            return detail, unwrapped.status_code
        lead = unwrapped.detail
    else:
        lead = f"The load did not finish within the startup timeout (timeout_ms {timed_out_ms})."

    if observations:
        status = next((o.status for o in observations if o.status is not None), None)
        return describe_observations(observations), status
    return f"{lead} {_attribute_silence(credential, wire)}", None


def _provenance(
    status: int | None,
    cause: BaseException,
    observations: tuple[FailureObservation, ...],
    wire: WireEvidence,
) -> str | None:
    """Where a preserved error came from, when the chain alone would mislead.

    A vault that refuses a reference raises an `HttpResponseError` the provider files beside the
    store's own (`_azureappconfigurationprovider.py:314-319`): a 403 from Key Vault and a 403 from
    the store read identically. Every store request passes the diagnostics policy, so a status it
    never saw, while it saw the store answer, did not come from the store.
    """
    traffic = wire.traffic
    if status is not None and traffic.answered > 0:
        if not any(o.status == status for o in observations):
            return (
                f"(the store answered {traffic.answered} of the {_plural(traffic.sent, 'request')} "
                f"this attempt sent and none with HTTP {status}, so it did not come from the "
                "store: the provider's other client is the one resolving Key Vault references)"
            )
        return None
    if argument_error_in_chain(cause) and traffic.answered > 0:
        return (
            f"(raised after the store had answered {traffic.answered} of the "
            f"{_plural(traffic.sent, 'request')} this attempt sent, for "
            f"{_plural(wire.selectors, 'selector')}: what it returned is in play — a Key Vault "
            "reference, or a snapshot reference, the provider could not use)"
        )
    return None


def _attribute_silence(credential: CredentialEvidence | None, wire: WireEvidence) -> str:
    """Nothing failed on the store's wire. Say what that is evidence of, and where it is evidence
    of nothing, say so. A failed lookup and a refused connection each raise under the policy, so
    silence is never evidence about the store — only about this side of the wire."""
    traffic = wire.traffic
    if credential is not None and credential.requested and not credential.resolved:
        # The authentication policy runs below this one, so a request waiting on the token has not
        # reached the transport: neither the network nor the store has been asked yet.
        return (
            "(the credential was asked for a token and never answered, so the credential is the "
            "suspect rather than the store)"
        )
    if traffic.answered + traffic.pending > 0:
        return _describe_traffic(wire)
    if credential is None:
        # Accepted limit, as in the TypeScript half: on the access-key path there is no token, so
        # a policy that stopped being installed and a genuinely silent failure look alike here.
        return (
            "(no request was observed, and no token was in play on this path, so the cause is "
            "unreported; the provider's replica discovery, a DNS lookup, runs before its first "
            "request)"
        )
    if not credential.requested:
        return (
            "(no request was observed and no token was ever requested, so the cause is "
            "unreported; the provider's replica discovery, a DNS lookup, runs before its first "
            "request)"
        )
    # The token is asked for below this policy, so it cannot arrive without a request passing it.
    return (
        "(the credential answered but no request was observed, which cannot happen while the "
        "diagnostics policy is running — so the provider is no longer passing per_retry_policies "
        "to its clients, and the request it made is not visible here)"
    )


def _describe_traffic(wire: WireEvidence) -> str:
    """The store was asked and nothing failed. State what was seen, and name every cause it
    leaves open — never rule one out the evidence cannot.

    A request still in flight keeps the network path and the store in play. A complete first read
    — one answered request per selector — keeps a Key Vault reference in play, since references
    resolve after the read and the vault's requests are not observed here. Fewer answers than
    selectors, with nothing in flight, means the reads had not finished.
    """
    traffic = wire.traffic
    when = "when the startup timeout fired" if wire.at_timeout else "when the load failed"
    verb = "was" if traffic.pending == 1 else "were"
    facts = (
        f"{when}, the store had answered {traffic.answered} of the "
        f"{_plural(traffic.sent, 'request')} this attempt sent, {traffic.pending} {verb} still in "
        f"flight and none had failed, for {_plural(wire.selectors, 'selector')}"
    )
    candidates = []
    if traffic.pending > 0:
        candidates.append("the network path to the store (a private endpoint, a firewall rule)")
        candidates.append("the store not answering")
    if traffic.answered >= wire.selectors:
        candidates.append(
            "a Key Vault reference whose vault did not answer (references resolve after the read, "
            "and the vault's requests are not observed here)"
        )
    elif traffic.pending == 0:
        candidates.append("reads that had not finished when the load gave up")
    return f"({facts}. Not ruled out: {'; '.join(candidates)})"


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"
