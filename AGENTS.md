# Repository Guidelines

## Project and Current Plans

HuanLink is a local-first multi-agent orchestration project for personal use, group collaboration, and A2A-based cross-platform Agent coordination.

- `docs/dev/23-a2a-first-real-demo-plan.md` records the completed real QQ -> MainAgent -> A2A -> Codex Demo.
- `docs/dev/24-huanlink-v1-product-requirements-draft.md` records the current v1.0 product requirements.
- `docs/dev/26-huanlink-v1-development-plan.md` is the current stage-level development plan.
- Before implementing a milestone, inspect the live code and write or confirm its focused `Dxx` design and implementation plan. Do not implement later milestones early.

## Repository Structure

- `apps/server/` is the HuanLink service process and composition root for Channel ingress/egress, MainAgent wiring, and task re-entry. Keep reusable runtime decisions out of this app shell.
- `apps/codex-a2a-adapter/` is an independent A2A server that bridges standard A2A tasks to the official `codex app-server`.
- `packages/core/` contains framework-independent contracts and outer-orchestration infrastructure such as AgentCall, EventLog, Replay, runtime logging, and scheduling.
- `packages/integrations/` contains the OpenAI Agents JS, A2A Client, and OneBot 11 integrations. Keep external framework and protocol types inside their integration boundaries.
- `docs/dev/` contains active plans, drafts, research, and development notes. `docs/` is reserved for later finalized documentation.
- `references/` contains read-only reference submodules unless a submodule update is explicitly requested.

Keep reusable code under `packages/*/src`, process composition under `apps/*/src`, and tests close to the package they verify.

## Commands

```powershell
git status
git submodule update --init --recursive
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Use package-scoped tests while iterating, then run verification proportional to the affected path. A real integration claim requires a real smoke or log-backed check; unit tests alone do not prove the QQ/A2A/Codex loop.

## Code and Test Conventions

- TypeScript uses strict `NodeNext` settings from `tsconfig.base.json`.
- Follow existing naming. Numbered files are research or product documents; `Dxx` files are focused design and implementation plans.
- Keep changes small. Commit documentation and code separately with clear scope.
- Use descriptive Vitest names that state behavior. Tests are package-local across Core, Server, Codex Adapter, and integrations.
- Commit messages use `<type>(<scope>): <中文说明>` with lowercase English type/scope and no trailing punctuation.

## Agent Instructions

- Inspect relevant files, current git state, and history before editing. For non-trivial work, present a plan before code and verify the result afterward.
- Follow the active milestone in `docs/dev/26-huanlink-v1-development-plan.md`. Refactor only the Demo wiring needed by that milestone; do not start a standalone rewrite or unrelated cleanup.
- HuanLink owns outer orchestration: Channel ingress/egress, buffering and gating, asynchronous task lifecycle, AgentCall/A2A routing, and EventLog/Replay.
- Prefer framework or external-Agent capabilities for single-agent reasoning and Tool Loops. The legacy self-built `AgentLoop`, `ModelClient`, `ToolGateway`, and `PolicyEngine` route has been removed; do not reintroduce it.
- Keep Agent-specific execution configuration in the corresponding Adapter. Do not leak Codex workspace, branch, or execution-model rules into MainAgent or Core configuration.
- Do not claim restart recovery, distributed exactly-once, or full A2A coverage unless the current implementation and fresh evidence support it.
- When dispatching subagents, default to GPT-5.6 Terra with high reasoning and use `$boris-prompts` to keep their tasks short, anchored, and verifiable unless the user specifies otherwise.
