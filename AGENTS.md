# Repository Guidelines

## Project and Plan Authority

HuanLink is a local-first multi-agent orchestration project for personal use, group collaboration, and A2A-based cross-platform Agent coordination.

- When confirmed development documents conflict, use this precedence: the current `Bxx` batch within its active `Dxx` plan, then the `Dxx` module plan, then the `Mxx` milestone plan, then plain-numbered documents. Older or higher-level documents may be stale; do not combine conflicting schemes.
- Plans define intended work, while live code, tests, and runtime evidence determine what is actually implemented.
- Follow the active plan's stop points. Treat commit, push, PR creation, and merge as separate actions; perform each only when the plan or the user explicitly authorizes it.

## Repository Boundaries

- `apps/server/` is the HuanLink service process and composition root for Channel ingress/egress, MainAgent wiring, and task re-entry. Keep reusable runtime decisions out of this app shell.
- `apps/codex-a2a-adapter/` is an independent A2A server that bridges standard A2A tasks to the official `codex app-server`.
- `packages/core/` contains framework-independent contracts and outer-orchestration infrastructure such as AgentCall, EventLog, Replay, runtime logging, and scheduling.
- `packages/integrations/` contains the OpenAI Agents JS, A2A Client, and OneBot 11 integrations. Keep external framework and protocol types inside their integration boundaries.
- `docs/dev/` contains active plans, drafts, research, and development notes. `docs/` is reserved for later finalized documentation.
- `references/` contains read-only reference submodules. Inspect them only when references are in scope or Git reports a mismatch. Compare a mismatched checkout with the parent repository's recorded gitlink and restore that recorded commit without changing the gitlink; if local changes exist, report instead of overwriting them. Update a gitlink only when explicitly requested.

Keep reusable code under `packages/*/src`, process composition under `apps/*/src`, and tests close to the package they verify.

## Working Process

1. **Orient:** inspect the current branch, worktree, relevant files and history, and the latest confirmed plan before editing. Treat existing changes as user-owned; preserve them, stage exact paths only, and stop if they overlap the task.
2. **Frame:** for non-trivial work, state the outcome, scope, authority, hard constraints, acceptance checks, and deferred work in a focused plan.
3. **Implement:** work only within the active batch and module, in small reviewable changes. Avoid unrelated cleanup and standalone rewrites.
4. **Verify:** treat the root `package.json` scripts and affected package configuration as the command source of truth. Use package-scoped checks while iterating, then run verification proportional to the affected path and the active plan. A real integration claim requires a real smoke or log-backed check; unit tests alone do not prove the QQ/A2A/Codex loop.
5. **Hand off:** report the actual result and evidence, identify remaining gaps, and stop at the next approval gate.

## Code, Test, and Git Conventions

- TypeScript uses strict `NodeNext` settings from `tsconfig.base.json`.
- Follow existing naming. Numbered files are research or product documents; `Dxx` files are focused design and implementation plans.
- Keep changes small. Commit documentation and code separately with clear scope.
- Use descriptive Vitest names that state behavior. Tests are package-local across Core, Server, Codex Adapter, and integrations.
- Commit messages use `<type>(<scope>): <中文说明>` with lowercase English type/scope and no trailing punctuation.

## Architecture Guardrails

- HuanLink owns outer orchestration: Channel ingress/egress, buffering and gating, asynchronous task lifecycle, AgentCall/A2A routing, and EventLog/Replay.
- Prefer framework or external-Agent capabilities for single-agent reasoning and Tool Loops. The legacy self-built `AgentLoop`, `ModelClient`, `ToolGateway`, and `PolicyEngine` route has been removed; do not reintroduce it.
- Keep Agent-specific execution configuration in the corresponding Adapter. Do not leak Codex workspace, branch, or execution-model rules into MainAgent or Core configuration.
- Do not claim restart recovery, distributed exactly-once, or full A2A coverage unless the current implementation and fresh evidence support it.

## User Communication

- Make reports decision-ready. Lead with the outcome and the fact most likely to change acceptance. For repository changes, compare the requested and actual scope, then report material requirement or architecture drift, review-driven corrections, fresh verification, remaining uncertainty, and the next approval gate. Clearly distinguish confirmed facts, inferences, plans, and unknowns.
- Use progressive disclosure: write short, direct paragraphs with one concern per paragraph and only the details needed for the current decision. Compress routine success and execution history; explain deviations, risks, and evidence gaps together with their impact. Respect requested brevity or named subsets, and expand file or code details only when asked.
- Teach unfamiliar concepts from a concrete HuanLink problem or contradiction. Give the smallest sufficient causal model—problem → motivation → design/mechanism → effect → cost/boundary—then stop at the current layer unless the user requests a complete treatment.

## Agent and Skill Use

- For non-trivial repository implementation, use `$execute-from-goal` as the default execution workflow unless a more specific skill applies.
- When dispatching subagents, default to GPT-5.6 Terra with xhigh reasoning and use `$prompt-entropy` to keep their tasks short, anchored, and verifiable unless the user specifies otherwise. All subagents share the same worktree: reviewers are read-only by default, and editing subagents must receive non-overlapping file scopes.
