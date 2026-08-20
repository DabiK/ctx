## Parent

Implements part of #1.

## What to build

Add read-only Git context operations to ctx. A developer or LLM can obtain compact structured status, changed files, working or staged diffs, recent logs, and safe historical show results, optionally scoped to a validated repository path. The operations expose a fixed allowlist of Git behavior and do not become arbitrary Git or shell execution.

## Acceptance criteria

- [ ] `status`, `changed`, `diff`, `log`, and `show` work through direct CLI and protocol requests with stable copied sections.
- [ ] Status clearly distinguishes staged, modified, untracked, deleted, and branch information.
- [ ] Diff supports whole working tree, a validated path, and staged content; log is bounded by default and may be scoped to a validated path.
- [ ] Show accepts only safe revision/path forms defined by ctx and refuses arbitrary command fragments.
- [ ] Temporary-repository tests cover normal results, empty states, invalid inputs, and non-repository failure behavior.

## Blocked by

- #3 Safe clipboard file context.

