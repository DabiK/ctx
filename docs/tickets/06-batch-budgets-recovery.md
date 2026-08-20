## Parent

Implements part of #1.

## What to build

Make multi-operation context requests safe and efficient. A developer can use `@ctx batch` to compose supported reads into one response. ctx measures bytes and approximates tokens before copying, applies per-file and total response limits, and turns malformed, denied, or oversized requests into a structured LLM-readable recovery response instead of silently truncating content.

## Acceptance criteria

- [ ] A batch executes supported read operations in the declared order and emits one stable response.
- [ ] File and total-output budgets fail closed before an oversized context is copied; the copied recovery response identifies costly requested items and asks the LLM to reduce scope.
- [ ] Tree, search, and log use explicit capped-result notices rather than pretending the result is complete.
- [ ] Byte counts and token estimates are visible in copied context metadata.
- [ ] Tests cover mixed batches, malformed nesting, budget boundaries, deterministic estimates, and no-silent-truncation behavior.

## Blocked by

- #3 Safe clipboard file context.

