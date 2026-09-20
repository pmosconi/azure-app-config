# actvalue.azure-app-config — not yet written

The Python half of this package follows the TypeScript half, after `1.0.0` is published to npm.

It is the same package: the same option names in snake_case, the same defaults, the same error
semantics, and the same four invariants. See the root `README.md` for the interface and
`CLAUDE.md` for why each invariant exists.

The `*-py` targets in the root `Makefile` are already in place and expect a `uv`-managed
project here — `pyproject.toml`, `src/`, `tests/`.
