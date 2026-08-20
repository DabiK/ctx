## Parent

Implements part of #1.

## What to build

Complete the fast interactive workflow. Add the user-local persisted `yolo` mode and optional desktop notifications. In yolo, a valid visible patch or full-write proposal enters a three-second countdown in the TUI and applies only if the user does not cancel it. The project never stores this personal mode, so collaborators do not inherit an automation preference.

## Acceptance criteria

- [x] The selected mode is persisted in user-local configuration, outside the repository, and restored by a later watcher session.
- [x] In yolo, valid non-sensitive patch and full-write proposals display a cancellable three-second countdown and apply only after it completes.
- [x] Sensitive writes remain blocked even in yolo unless the explicit sensitive-write override is provided.
- [x] Optional notifications report request completion and pending/applied write events without replacing TUI diagnostics.
- [x] Tests cover persisted mode restore, countdown completion/cancellation, sensitive-write refusal, and notification-port behavior with fakes.

## Blocked by

- #8 Watcher TUI safe and auto.

