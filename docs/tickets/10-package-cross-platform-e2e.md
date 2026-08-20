## Parent

Implements part of #1.

## What to build

Make ctx distributable and prove the full clipboard workflow on both supported platforms. Package the Node CLI for npm installation, document prerequisites and the `ctx doctor` recovery path, and run end-to-end fixture tests on macOS and Windows. The scenario covers init/prompt, a clipboard context round trip, a tagged multi-file change, and TUI-mediated verification.

## Acceptance criteria

- [ ] The package exposes the `ctx` executable through npm and documents installation plus all required platform prerequisites.
- [ ] macOS and Windows CI execute the supported fixture workflow; Windows verifies the search fallback when ripgrep is unavailable.
- [ ] The end-to-end scenario covers initial prompt copying, context request/response, a multi-file patch or full write, post-write verification, and a visible failure case.
- [ ] Documentation clearly distinguishes supported macOS/Windows behavior from future platform work.
- [ ] Release verification includes `ctx doctor` output for a ready and a missing-prerequisite environment.

## Blocked by

- #2 Bootstrap CLI, init, prompt and doctor.
- #4 Project discovery and search.
- #5 Git context operations.
- #6 Batch, budgets and recovery.
- #7 Controlled writes and sequences.
- #9 Yolo user mode and notifications.

