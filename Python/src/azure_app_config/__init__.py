"""Hydrate `os.environ` from Azure App Configuration, with the failure handling that platform
actually needs. The Python half of `@actvalue/azure-app-config`: the same option names in
snake_case, the same defaults, the same error semantics. See the README and `CLAUDE.md`."""

from importlib.metadata import PackageNotFoundError, version

from ._core import (
    DEFAULT_RETRY_FLOOR_MS,
    hydrate,
    hydrate_async,
    hydrate_with_backoff,
    hydration_status,
    reset_hydration,
    retry_after_ms,
)
from ._errors import ConfigFloorError, ConfigInputError, ConfigLoadError
from ._types import (
    BackoffOptions,
    FailureObservation,
    HydrateOptions,
    HydrationResult,
    HydrationStatus,
    KeyMap,
    Logger,
)

try:
    __version__ = version("actvalue.azure-app-config")
except PackageNotFoundError:  # pragma: no cover - running from a source tree without metadata
    __version__ = "0.0.0"

__all__ = [
    "DEFAULT_RETRY_FLOOR_MS",
    "BackoffOptions",
    "ConfigFloorError",
    "ConfigInputError",
    "ConfigLoadError",
    "FailureObservation",
    "HydrateOptions",
    "HydrationResult",
    "HydrationStatus",
    "KeyMap",
    "Logger",
    "__version__",
    "hydrate",
    "hydrate_async",
    "hydrate_with_backoff",
    "hydration_status",
    "reset_hydration",
    "retry_after_ms",
]
