# Repository Guidelines

## Project Structure & Module Organization

This repository is currently a lightweight agent-runtime study and design workspace.

- `apps/server/` is the placeholder server app. It should stay thin and must not own core runtime decisions.
- `packages/core/` contains the first runtime-facing TypeScript types and public core package entrypoint.
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

- Markdown docs use numbered prefixes when they are part of a learning or development sequence, for example `docs/dev/06-mini-swe-agent-learning-summary.md`.
- Use clear English file names for shared project docs.
- Prefer concise explanations over long speculative design rules.

TypeScript uses strict `NodeNext` settings from `tsconfig.base.json`. No formatter is configured yet; add a format script here when one is introduced.

## Testing Guidelines

Vitest is configured for `packages/core`. Once runtime code expands, add focused tests for the agent loop, tool registry, configuration loading, and trace/event logging.

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

When dispatching subagents, default to GPT-5.4 with high reasoning unless the user specifies a different model or effort.

Do not expand project boundaries prematurely. This repository is still defining its runtime architecture through small, testable steps.
