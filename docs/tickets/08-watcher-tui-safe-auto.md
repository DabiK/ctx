## Parent

Implements part of #1.

## What to build

Deliver the foreground `ctx watch` mini-TUI in safe and auto modes. It observes clipboard changes, ignores ctx’s own responses and duplicate clipboard content, displays current mode and recent events, accepts manual read commands, and copies their structured results. It surfaces tagged patch/write proposals with preview and an explicit application action, while keeping all activity visible in the foreground terminal.

## Acceptance criteria

- [ ] `ctx watch` launches a keyboard-operable foreground TUI showing mode, recent events, pending proposed writes, and the latest copied response.
- [ ] Safe mode confirms read requests and proposed writes; auto mode runs valid reads automatically but keeps writes awaiting an explicit TUI action.
- [ ] The TUI command entry executes supported read operations and automatically copies their structured response.
- [ ] Watcher loop prevention ignores `# CTX RESPONSE` and duplicate clipboard hashes.
- [ ] Deterministic watcher/TUI tests use fake clipboard and clock ports to cover events, mode transitions, pending-write preview, application, and cancellation.

## Blocked by

- #4 Project discovery and search.
- #5 Git context operations.
- #6 Batch, budgets and recovery.
- #7 Controlled writes and sequences.

