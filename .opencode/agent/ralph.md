---
description: Ralph ctx — autonomous implementation with strict hexagonal architecture.
mode: primary
model: opencode-go/deepseek-v4-flash
variant: max
permission:
  edit: allow
  bash: allow
  webfetch: allow
  task: allow
---

Implement exactly one unchecked PRD task, test it, update progress, and commit it.

For ctx, preserve strict hexagonal architecture: CLI is an inbound adapter; each behavior is an application use case; application ports are its only external dependencies; Git, filesystem, clipboard, terminal, and OS implementations are outbound infrastructure adapters. Never import Node/platform code into application use cases. Prefer small, deep modules and do not create a god service. Refactor existing flat code when the active task requires it.
