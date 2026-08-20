## Parent

Implements part of #1.

## What to build

Deliver controlled repository modification from tagged LLM proposals. ctx recognises an explicit `@ctx patch` containing one multi-file unified diff and an explicit `@ctx write` containing full-file content. It validates paths and sensitive-write rules, preflights patches with Git, creates necessary directories for accepted full writes, and supports ordered sequences that verify the repository only after a write succeeds.

The slice deliberately uses Git as recovery; it does not implement fuzzy repair, partial application, ctx backups, or persistent write history.

## Acceptance criteria

- [ ] A tagged multi-file patch is recognised separately from ordinary `ctx diff` read output and is preflighted before any file changes.
- [ ] A valid full-file write creates or replaces only a validated non-sensitive path; missing parent directories are created as part of the accepted operation.
- [ ] Invalid patches and denied writes change no files and produce a structured diagnostic for the LLM/user.
- [ ] A sequence runs its verification reads only after the proposed patch/write succeeds; failures skip later steps and report why.
- [ ] Integration tests cover patch success/failure, multiple files, full writes, sensitive-write refusal, and sequence conditional behavior in a temporary Git repository.

## Blocked by

- #3 Safe clipboard file context.

