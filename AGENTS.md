# Repository Guidelines

## Project Structure & Module Organization

HuanLink is a multi-agent orchestration project specialized for group-chat scenarios and an experimental platform for A2A-based cross-platform agent collaboration.

- `apps/server/` is the placeholder server app. It should stay thin and must not own core runtime decisions.
- `packages/core/` contains framework-independent runtime contracts and shared infrastructure such as EventLog, Replay, runtime logging, and configuration.
- `packages/integrations/` contains adapters for external agent frameworks. The current OpenAI Agents JS adapter lives under `packages/integrations/openai-agents/`.
- `docs/` is reserved for future finalized project documents.
- `docs/dev/` contains the current development notes, design drafts, reference analysis, learning summaries, prompts, and other process-oriented materials that are not final formal docs.
- `references/` contains Git submodules for external agent projects. Treat these as read-only references unless explicitly updating the submodule pointer.
- `README.md` and `LICENSE` come from the main repository root.

This is now a pnpm TypeScript workspace. Keep runtime code under `packages/*/src`, app shells under `apps/*/src`, and tests close to the package they verify.

## Build, Test, and Development Commands

Current useful commands:

```powershell
git status
git submodule status
git submodule update --init --recursive
corepack pnpm install
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Use `git submodule update --init --recursive` after cloning so `references/*` resolves to the recorded commits.

## Coding Style & Naming Conventions

Keep changes small and easy to review. Follow existing file naming:

- Research and reference docs use numbered prefixes, for example `docs/dev/06-mini-swe-agent-learning-summary.md`; active implementation docs use `Dxx` prefixes, for example `docs/dev/D01-openai-agents-js-mock-spike-plan.md`.
- Use clear English file names for shared project docs.
- Prefer concise explanations over long speculative design rules.

TypeScript uses strict `NodeNext` settings from `tsconfig.base.json`. No formatter is configured yet; add a format script here when one is introduced.

## Testing Guidelines

Vitest is configured for `packages/core`, `packages/integrations/openai-agents`, and `apps/server`. Add focused tests for runtime contracts, framework adapters, configuration, runtime logging, EventLog/Replay, and HuanLink-owned orchestration behavior. Do not expand the legacy self-built generic agent loop or tool registry unless explicitly requested.

Use descriptive test names that state behavior, not implementation details.

## Commit & Pull Request Guidelines

Commit messages use short Conventional Commits with Chinese subjects:

```text
<type>(<scope>): <中文变更说明>
```

Use lowercase English `type`/optional `scope`, keep technical names as-is, and do not add trailing punctuation.

```text
docs: 更新项目当前状态
feat(frontend): 支持 Sources Markdown 渲染
refactor(rag): 移动 RagTextFormatter
```

Pull requests should include:

- What changed.
- Why it changed.
- How it was checked.

## Agent-Specific Instructions

Before editing, inspect the relevant files and follow the current repository shape. For non-trivial work, make a short plan first. After changes, run whatever verification exists; if no verification exists yet, state that clearly.

When dispatching subagents, default to GPT-5.6 Terra with high reasoning unless the user specifies a different model or effort.
When dispatching subagents, default to using the `$boris-prompts` skill to write the task prompt unless the user specifies otherwise.

Keep HuanLink-owned concerns focused on outer orchestration: group-chat ingress, buffering and gating, asynchronous task lifecycle, AgentCall/A2A routing, and EventLog/Replay. Prefer framework capabilities such as OpenAI Agents JS for single-agent run internals instead of expanding a self-built generic agent loop.
