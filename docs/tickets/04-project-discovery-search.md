## Parent

Implements part of #1.

## What to build

Extend the safe context loop with project discovery. A developer or LLM can request bounded trees, globs, inspection summaries, and searches through the same protocol and direct CLI. Search prefers ripgrep and uses a Windows-native fallback only when ripgrep is unavailable; both obey the same roots, ignores, result limits, and response contract.

## Acceptance criteria

- [ ] Tree, glob, inspect, and search operations are available through direct CLI and `@ctx` requests.
- [ ] Tree depth and search/result limits are enforced and explicitly reported when results are limited.
- [ ] Inspect returns a bounded directory tree plus the selected principal files and relevant module metadata without exceeding configured limits.
- [ ] Ripgrep is used when available; a Windows-native fallback produces compatible bounded results when it is absent.
- [ ] All discovery operations honour the established path, allowed-root, `.ctxignore`, and sensitive-content rules.

## Blocked by

- #3 Safe clipboard file context.

