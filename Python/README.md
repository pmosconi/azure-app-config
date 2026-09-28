# actvalue.azure-app-config — not yet written

The Python half of this package follows the TypeScript half. `0.3.0` is the candidate for the
frozen TypeScript API; after an API review across both halves, the Python half ships as `1.0.0`,
alongside the TypeScript half republished as `1.0.0` without a behaviour change.

It is the same package: the same option names in snake_case, the same defaults, the same error
semantics, and the same four invariants. Every `0.3.0` behaviour is part of that: `retry_after_ms`,
the failure line logged once per attempt, `hydrate_with_backoff` not logging it twice, and a
`gated` equivalent. The TypeScript half's dual-build state registry has no counterpart here: a
Python process imports a module once, so it has one state by construction. See the root
`README.md` for the interface and `CLAUDE.md` for why each invariant exists.

The `*-py` targets in the root `Makefile` are already in place and expect a `uv`-managed
project here — `pyproject.toml`, `src/`, `tests/`.
