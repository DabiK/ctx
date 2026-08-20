# ctx — Agent instructions

## Product vocabulary

Use the vocabulary in [CONTEXT.md](CONTEXT.md). `ctx` is a local tool runtime: the human is the permission boundary, the LLM is the planner, and `ctx` is the controlled executor using the clipboard as transport.

## Agent skills

- Issue tracker and triage labels: [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) and [docs/agents/triage-labels.md](docs/agents/triage-labels.md)
- Domain documentation: [docs/agents/domain.md](docs/agents/domain.md)

## Architecture

Use a strict hexagonal architecture. The CLI is an inbound adapter; use cases live in the application layer; ports are owned by the application layer; Git, filesystem, clipboard, terminal, and OS concerns are outbound adapters in infrastructure. Do not mix use cases in a god service or make application code import Node/platform implementations.
