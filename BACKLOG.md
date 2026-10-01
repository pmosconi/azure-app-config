# Backlog

Open items only. Every item that shipped or was decided up to `1.0.0` (items 1–25 and 27) is in
`CHANGELOG.md`, under the release that settled it. The full write-ups, with the problem, the options
and the consumers' workarounds, are in this file's history (`git log -p -- BACKLOG.md`). References
to "`BACKLOG.md` item N" elsewhere in the repository point there.

Numbers are never reused. A new item takes the next number after the highest one ever used (27).
Every item applies to both halves (see the parity rule in CLAUDE.md).

## 26. A message-trigger helper: the wait-once recipe is copied into every consumer

**Deferred to `1.1.0`: additive, so a minor release; the `1.0.0` consumers keep their hand-written
recipe.**

**Priority: low. Found by the first Python consumer.**

- **Now:** every consumer with message triggers writes the README recipe by hand: re-raise a
  `ConfigInputError`, otherwise wait `retry_after_ms(error)`, try once more, then let it fail. The
  first Python consumer needs it twice, sync and async, and the TypeScript message-trigger
  consumers have their own copies.
- **Proposal:** a package helper, the message-trigger counterpart of `gated()`, e.g.
  `hydrate_for_message(options)` / `hydrateForMessage(options)` (plus an async form in Python).
  The recipe would then be fixed in one place.
- **Consumer workaround:** the hand-written recipe, in one config module per app.
