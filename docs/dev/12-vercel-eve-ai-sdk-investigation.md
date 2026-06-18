# Vercel Eve 与 Vercel AI SDK 调研

## 0. 调研范围

本报告基于：

- 联网快速确认：官方仓库为 `vercel/eve`，npm 包名 `eve` 当前指向 Vercel 新框架，版本 `0.11.4`。
- 本地浅克隆源码：`references/eve`
- 三个只读子线程专题分析：
  - execution / durability / event stream
  - tools / approval / sandbox / skills
  - eval runner / client API / AI SDK integration
- 主线程小范围核验：
  - `references/eve/package.json`
  - `references/eve/pnpm-workspace.yaml`
  - `references/eve/packages/eve/package.json`
  - `references/eve/packages/eve/src/protocol/message.ts`
  - `references/eve/packages/eve/src/harness/tool-loop.ts`
  - `references/eve/packages/eve/src/evals/*`

注意：

- `references/eve` 当前是普通浅克隆参考目录，不是 git submodule。
- Eve 仍是 beta 项目，`README.md` 明确说明 API、文档和行为在 GA 前可能变化。
- Eve 要求 `node >=24`，且本地 `pnpm-workspace.yaml` catalog 使用 `ai: "7.0.0-beta.178"`；当前 Huaness Lite 不应直接绑定这条 beta 栈。

## 1. 一句话结论

Eve 值得 Huaness Lite 学习的是 `Session -> Turn -> Step -> Event`、durable step、append-only stream、HITL park/resume、eval artifacts；但不建议直接接入 Eve 作为 Huaness 的核心框架，Vercel AI SDK 也应先作为 `ModelClient` adapter，而不是替代 Huaness 自己的 `AgentLoop / ToolGateway / PolicyEngine / EventLog`。

## 2. Eve 是什么

Eve 的定位是 filesystem-first framework for durable backend AI agents。

典型项目结构来自 `references/eve/README.md` 和 `references/eve/docs/reference/project-layout.md`：

```text
my-agent/
└── agent/
    ├── agent.ts
    ├── instructions.md
    ├── tools/
    ├── skills/
    ├── channels/
    └── schedules/
```

核心约定：

- `agent/instructions.md`：常驻 instructions / system prompt。
- `agent/agent.ts`：模型和 runtime 配置。
- `agent/tools/*.ts`：工具文件，文件名推导 tool id。
- `agent/skills/*.md`：可按需加载的 procedures。
- `agent/channels/*.ts`：HTTP、Slack、Discord 等入口。
- `evals/**/*.eval.ts`：评测用例，与 `agent/` 同级。

这类文件系统约定对 Huaness 有参考价值，但 Huaness 当前不必复制整套目录。Huaness 更应该先稳住 core package 的运行时抽象。

## 3. 依赖与成熟度判断

关键文件：

- `references/eve/package.json`
- `references/eve/packages/eve/package.json`
- `references/eve/pnpm-workspace.yaml`

Eve 发布包：

- npm package：`eve`
- 当前版本：`0.11.4`
- 描述：`Filesystem-first framework for durable backend AI agents that run anywhere.`
- engines：`node >=24`

核心依赖/peer：

- `nitro: 3.0.260610-beta`
- `@workflow/core`
- `@workflow/world`
- `@workflow/world-local`
- `ai: 7.0.0-beta.178`
- `@ai-sdk/*` beta 系列
- `just-bash`
- `microsandbox`
- `@vercel/sandbox`
- `autoevals`
- `zod`

风险判断：

- Eve 是完整 agent framework，不是一个小工具库。
- Eve 绑定了 durable workflow、Nitro route、channel、sandbox、eval、frontend hooks 等一整套生态。
- Eve 依赖 AI SDK 7 beta，而当前稳定 `ai` 包仍在 v6 线；这对秋招项目的工程稳定性不是最优。
- Huaness Lite 当前应把 Eve 当参考架构，不应让 Eve 成为 P0 运行时依赖。

## 4. Execution Model

### 4.1 核心概念

关键文件：

- `references/eve/docs/concepts/execution-model-and-durability.md`
- `references/eve/docs/concepts/sessions-runs-and-streaming.md`
- `references/eve/packages/eve/src/execution/workflow-runtime.ts`
- `references/eve/packages/eve/src/execution/workflow-entry.ts`
- `references/eve/packages/eve/src/execution/turn-workflow.ts`
- `references/eve/packages/eve/src/execution/workflow-steps.ts`
- `references/eve/packages/eve/src/execution/session.ts`
- `references/eve/packages/eve/src/channel/types.ts`

Eve 的核心拆分：

| 概念 | 含义 | Huaness 对应理解 |
| --- | --- | --- |
| `session` | 持久会话/任务根，跨多轮存在；源码里基本等同 root Workflow run | `sessionId`，长期上下文容器 |
| `turn` | 一次用户输入触发的完整工作单元 | `turnId`，一次 user message 的处理过程 |
| `step` | turn 内 durable checkpoint，通常是一轮模型调用和工具动作 | Huaness 应明确引入的 replay/checkpoint 单位 |
| `run` | 底层 Workflow SDK 执行实例 | Huaness 不必照搬，P0 可用本地 runId |
| `continuationToken` | resume hook，不是消息队列 | Huaness 的 pending approval/resume token 可借鉴 |

### 4.2 最小执行伪代码

根据子线程对 `workflow-runtime.ts`、`workflow-entry.ts`、`turn-workflow.ts`、`workflow-steps.ts` 的整理，Eve 的简化流程是：

```ts
runtime.run(input):
  run = startWorkflow(workflowEntry, serializedContext(input))
  return {
    sessionId: run.runId,
    continuationToken,
    events: getRun(runId).getReadable()
  }

workflowEntry:
  state = createSessionStep(input)
  action = dispatchAndAwaitTurn(firstDelivery)

  loop:
    if action.done:
      callbacks()
      return

    if action.dispatchRuntimeActions:
      results = runRuntimeActionsAndWait()
      action = dispatchAndAwaitTurn(results)

    if action.park:
      delivery = waitForNextDeliverOrAuthOrChildResult(continuationToken)
      action = dispatchAndAwaitTurn(delivery)

turnWorkflow:
  stepInput = firstInput

  loop:
    result = turnStep(stepInput)
    if result.action === "continue":
      stepInput = undefined
      continue

    notifyDriver(result.action)
    return

turnStep:
  session = hydrateDurableSession(readDurableSession(state))
  result = createExecutionNodeStep(...)(session, input)
  emit events to workflow stream
  return durable snapshot + next action
```

这里最值得 Huaness 学的是 `StepNext = done | continue | wait`：

- `done`：run/turn 结束。
- `continue`：继续下一次模型 step。
- `wait`：进入 durable waiting，等待用户输入、approval、auth 或子任务结果。

Huaness P0 现在的 `AgentLoop` 已有 max steps / cancellation / tool loop，但还没有把 step 作为事件和恢复边界显式建模。下一步可以先引入 `step` 和 `turnId`，不必引入 Workflow SDK。

## 5. Event Stream

关键文件：

- `references/eve/packages/eve/src/protocol/message.ts`
- `references/eve/packages/eve/src/harness/emission.ts`
- `references/eve/packages/eve/src/harness/tool-loop.ts`
- `references/eve/packages/eve/src/execution/workflow-steps.ts`
- `references/eve/packages/eve/src/public/channels/eve.ts`
- `references/eve/packages/eve/src/client/open-stream.ts`

Eve 的事件类型在 `protocol/message.ts` 中集中定义。主要包括：

```text
session.started
session.waiting
session.completed
session.failed

turn.started
turn.completed
turn.failed

step.started
step.completed
step.failed

message.received
message.appended
message.completed
reasoning.appended
reasoning.completed
result.completed

actions.requested
action.result
input.requested

authorization.required
authorization.completed

compaction.requested
compaction.completed

subagent.called
subagent.started
subagent.child_event
subagent.completed
```

事件生成链路：

- `harness/emission.ts`
  - `emitTurnPreamble`
  - `emitStepStarted`
  - `emitTurnEpilogue`
  - `emitStreamContent`
- `harness/tool-loop.ts`
  - 模型流、工具动作、等待输入、失败恢复时触发 emission。
- `execution/workflow-steps.ts`
  - `emit()` 先交给 channel adapter，再写入 Workflow writable stream。
- `public/channels/eve.ts`
  - `GET /eve/v1/session/:sessionId/stream` 输出 NDJSON。
  - 支持 `startIndex`，用于断线重连和从指定位置 replay。

Huaness 的启发：

- 当前 `AgentEvent.type` 可以逐步向 Eve 这种语义事件靠拢。
- `seq/startIndex` 很关键。Huaness 当前 JSONL 文件顺序能表示顺序，但缺显式 `seq`，不利于 tail/reconnect/replay。
- 不建议 P0 记录完整 reasoning 流；优先记录 run/model/tool/policy/approval/observation/result。
- channel stream 应从 core EventLog 派生，不要反过来让 channel 事件决定 core event model。

## 6. Durable Persistence

关键文件：

- `references/eve/packages/eve/src/execution/durable-session-store.ts`
- `references/eve/packages/eve/src/execution/workflow-runtime.ts`
- `references/eve/packages/eve/src/public/definitions/state.ts`
- `references/eve/packages/eve/test/setup/workflow-setup.ts`

Eve 的 durable 并不是自己写一个 JSONL/SQLite EventLog，而是接在 Workflow SDK 上：

- session 程序状态：`DurableSessionState.snapshot` 写入 Workflow step result。
- event stream：写入 Workflow run readable/writable stream。
- 本地 world：文档说明默认落到 `.workflow-data`。
- 自定义状态：`defineState(name, initial)` 走 durable context。

这和 Huaness 的目标不同。

Huaness Lite 更适合：

- P0：JSONL EventLog 是 source of truth。
- P0：`RunReplay` reducer 从 JSONL 复原状态。
- P1：SQLite 做派生索引。
- P2：再考虑 durable workflow / checkpoint / resumed run。

Eve 的 durable step 值得学，Workflow SDK 不必学。

## 7. Tools 与 ToolGateway

关键文件：

- `references/eve/packages/eve/src/public/definitions/tool.ts`
- `references/eve/packages/eve/src/compiler/normalize-tool.ts`
- `references/eve/packages/eve/src/runtime/tools/registry.ts`
- `references/eve/packages/eve/src/harness/tools.ts`
- `references/eve/packages/eve/src/harness/execute-tool.ts`
- `references/eve/packages/eve/src/harness/tool-loop.ts`
- `references/eve/packages/eve/src/runtime/framework-tools/index.ts`

Eve 的 public tool API：

```ts
defineTool({
  description,
  inputSchema,
  outputSchema?,
  execute?,
  needsApproval?,
  auth?,
  toModelOutput?,
})
```

重要类型/函数：

- `ToolDefinition`
- `ToolContext`
- `NeedsApprovalContext`
- `defineDynamic`
- `disableTool`
- `compileToolEntry`
- `createRuntimeToolRegistry`
- `findRegisteredRuntimeTool`
- `buildToolSet`
- `wrapToolExecute`
- `buildNeedsApprovalFn`
- `buildToolSetWithProviderTools`

执行链路：

```text
agent/tools/*.ts
  -> compiler normalize
  -> runtime tool registry
  -> harness tool definition
  -> AI SDK ToolSet
  -> ToolLoopAgent model/tool loop
  -> Eve harness handles events, approval, pending, result
```

最关键的设计点：

- 模型可见 descriptor 和 runtime executor 分离。
- tool name 可以从文件路径派生。
- tool 可以有 `toModelOutput`，用于控制返回给模型的内容。
- provider-managed tool 和 local-executed tool 可以分开。

Huaness Lite 当前 `ToolGateway` 应优先吸收：

- `ToolDescriptor`：给模型看的 name/description/schema。
- `ToolExecutor`：runtime 真正执行。
- `ToolPolicy`：是否允许/拒绝/需要用户审批。
- `ToolObservationFormatter`：把 raw result 转成模型可见 observation。

不要把这些都塞进一个 `Tool` 对象。

## 8. Default Harness Tools

关键文件：

- `references/eve/docs/concepts/default-harness.md`
- `references/eve/packages/eve/src/runtime/framework-tools/*`
- `references/eve/packages/eve/src/execution/sandbox/*`
- `references/eve/packages/eve/src/execution/subagent-tool.ts`

Eve 默认工具：

| 工具 | 用途 | Huaness 借鉴 |
| --- | --- | --- |
| `bash` | sandbox `/workspace` shell | P1/P2，P0 只做严格命令白名单或需要 approval |
| `read_file` | 读文件，输出带行号，记录 read stamp | P0 可借鉴 path guard + read stamp |
| `write_file` | 完整写文件，read-before-write + stale 检测 | P0 可借鉴安全策略，但实际写入要 approval |
| `glob` / `grep` | 文件发现和搜索 | P0 可做只读工具 |
| `web_fetch` | app runtime 发 HTTP 请求 | P1，默认需要 policy |
| `web_search` | provider-managed search | P1，先不接 |
| `todo` | session 内持久 todo 状态 | 可后置 |
| `ask_question` | HITL 输入请求 | P0/P1 值得做 approval/question 统一 pending |
| `load_skill` | 加载技能说明，不增加执行面 | P1 self-improve/skills 可借鉴 |
| `connection_search` | 动态发现连接工具 | 后置 |
| `agent` | 子 agent 委派 | 后置 |

Huaness P0 默认不应像 Eve 一样把工具面铺开。Huaness 的安全默认应是：

- read-only 工具可默认允许。
- write/shell/network 默认需要 approval。
- destructive/write 工具要有 operation id 和 EventLog 记录。
- skill 只能增加 instruction，不能绕过 ToolGateway 增加权限。

## 9. Approval / HITL / Resume

关键文件：

- `references/eve/packages/eve/src/public/tools/approval/approval-helpers.ts`
- `references/eve/packages/eve/src/public/definitions/tool.ts`
- `references/eve/packages/eve/src/harness/input-extraction.ts`
- `references/eve/packages/eve/src/harness/input-requests.ts`
- `references/eve/packages/eve/src/protocol/message.ts`
- `references/eve/packages/eve/src/channel/send.ts`
- `references/eve/packages/eve/src/execution/workflow-runtime.ts`
- `references/eve/packages/eve/src/execution/workflow-entry.ts`

Eve 的 approval API：

- `always()`
- `never()`
- `once()`
- `needsApproval?: boolean | function`

HITL 核心机制：

1. 工具或 `ask_question` 产生输入请求。
2. Eve 写入 pending input batch。
3. Eve 发 `input.requested`。
4. session 发 `session.waiting`。
5. 用户用 `inputResponses` 携带 `requestId` 恢复。
6. workflow hook 被 `deliver` 唤醒。
7. harness 继续执行。

这说明 approval 不应是内存里一个阻塞 Promise。它应该是可持久化状态和事件。

Huaness P0 可以把 PolicyDecision 扩成：

```ts
type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask_user"; requestId: string; prompt: string };
```

并增加事件：

```text
tool.approval_requested
tool.approval_resolved
input.requested
input.responded
run.waiting
run.resumed
```

## 10. Sandbox / Security Model

关键文件：

- `references/eve/docs/concepts/security-model.md`
- `references/eve/docs/sandbox.mdx`
- `references/eve/packages/eve/src/public/definitions/sandbox.ts`
- `references/eve/packages/eve/src/shared/sandbox-definition.ts`
- `references/eve/packages/eve/src/shared/sandbox-session.ts`
- `references/eve/packages/eve/src/shared/sandbox-network-policy.ts`
- `references/eve/packages/eve/src/public/sandbox/backends/default.ts`
- `references/eve/packages/eve/src/runtime/sandbox/registry.ts`
- `references/eve/packages/eve/src/context/providers/sandbox.ts`
- `references/eve/packages/eve/src/execution/sandbox/require-sandbox.ts`

Eve 的信任边界：

```text
app runtime
  - process.env
  - secrets
  - Node code
  - host/runtime capability
  - tool executor lives here

sandbox
  - isolated /workspace
  - no app secrets
  - no app code
  - network controlled by policy
```

`SandboxSession` 能力：

- `run`
- `spawn`
- `readTextFile`
- `writeTextFile`
- `resolvePath`
- `removePath`
- `setNetworkPolicy`

文件工具安全点：

- `read_file` 记录 `ReadFileStamp`。
- `write_file` 要求写已有文件前必须先读。
- 写前比较 hash/length，防止 stale read 覆盖。
- 文本工具拒绝二进制/NUL 文件。
- 路径校验集中处理。

Huaness 可直接借鉴：

- P0 做 workspace path guard。
- P0 给 file write 加 read-before-write。
- P0 给 write/shell/network 统一 approval。
- P1 再抽 `SandboxSession` 接口。
- P1/P2 再接 Docker/microsandbox。

风险：

- Eve 文档中 sandbox 网络可能默认 `allow-all`。
- `web_fetch` 在 app runtime 执行。
- `just-bash` 不是强隔离，只能做开发 fallback。

Huaness 不应照搬 Eve 默认安全姿态，而应采用 deny/approval-first。

## 11. Skills / Instructions

关键文件：

- `references/eve/docs/instructions.mdx`
- `references/eve/docs/skills.mdx`
- `references/eve/packages/eve/src/public/definitions/skill.ts`
- `references/eve/packages/eve/src/shared/skill-definition.ts`
- `references/eve/packages/eve/src/shared/skill-package.ts`
- `references/eve/packages/eve/src/runtime/framework-tools/skill.ts`
- `references/eve/packages/eve/src/public/definitions/tool.ts`

Eve 的关系：

- `instructions`：一直在上下文里。
- `skills`：按需加载的 procedure/instruction。
- `tools`：真正有副作用的执行能力。
- `load_skill`：加载 skill 内容，不增加执行权限。
- `ToolContext.getSkill`：工具可访问 skill package。

对 Huaness 的启发：

- skill 不是 tool。
- skill 不能绕过 ToolGateway。
- self-improve 产出的 skill 应只进入 `InstructionStore / SkillStore`。
- 权限必须仍由 `ToolGateway / PolicyEngine` 控制。

这和之前 Hermes self-improve 的结论一致：memory/skill 是可复用资产，不是自动放权机制。

## 12. Vercel AI SDK Integration

关键文件：

- `references/eve/packages/eve/src/shared/agent-definition.ts`
- `references/eve/packages/eve/src/internal/classify-model-routing.ts`
- `references/eve/packages/eve/src/internal/runtime-model.ts`
- `references/eve/packages/eve/src/harness/tool-loop.ts`
- `references/eve/packages/eve/src/harness/tools.ts`
- `references/eve/packages/eve/src/harness/types.ts`

Eve 使用 AI SDK 的方式：

- agent model 可以是 gateway string，也可以是 AI SDK `LanguageModel`。
- `createToolLoopHarness()` 内部创建 AI SDK `ToolLoopAgent`。
- `buildToolSet()` 把 Eve tool 转成 AI SDK `ToolSet`。
- 模型调用走 `agent.stream()` 或 `agent.generate()`。
- 但 session、event stream、approval、pending input、durability、eval artifacts 都由 Eve 自己控制。

这点非常重要：Eve 自己也没有把完整 agent/harness 语义交给 AI SDK。

对 Huaness 的判断：

- 可以接 `ai` 作为 `AiSdkModelClient`。
- 可以用 AI SDK provider 统一模型调用、streaming、tool schema 表达。
- 不建议把 AI SDK `ToolLoopAgent` 放入 Huaness core P0。
- 也不建议让 AI SDK tool loop 决定 Huaness 的 EventLog/replay/eval 语义。

推荐分层：

```text
Huaness AgentLoop
  -> Huaness ContextAssembler
  -> AiSdkModelClient
      -> Vercel AI SDK LanguageModel / streamText / generateText
  -> Huaness ToolGateway
  -> Huaness PolicyEngine
  -> Huaness EventLog
```

可选实验：

- P1/P2 做 `AiSdkLoopAdapter`，用于对比 AI SDK `ToolLoopAgent`。
- 但默认 runtime 不应依赖它。

## 13. Eval Runner

关键文件：

- `references/eve/docs/evals/overview.mdx`
- `references/eve/docs/evals/running.mdx`
- `references/eve/docs/evals/assertions.mdx`
- `references/eve/docs/evals/cases.mdx`
- `references/eve/docs/evals/judge.mdx`
- `references/eve/packages/eve/src/evals/define-eval.ts`
- `references/eve/packages/eve/src/evals/define-eval-config.ts`
- `references/eve/packages/eve/src/evals/context.ts`
- `references/eve/packages/eve/src/evals/session.ts`
- `references/eve/packages/eve/src/evals/target.ts`
- `references/eve/packages/eve/src/evals/assertions/run.ts`
- `references/eve/packages/eve/src/evals/assertions/collector.ts`
- `references/eve/packages/eve/src/evals/judge.ts`
- `references/eve/packages/eve/src/evals/runner/run-evals.ts`
- `references/eve/packages/eve/src/evals/runner/execute-task.ts`
- `references/eve/packages/eve/src/evals/runner/derive-run-facts.ts`
- `references/eve/packages/eve/src/evals/runner/artifacts.ts`

Eve eval 的特点：

- eval 是黑盒测试，不直接调内部函数。
- eval target 是 HTTP URL，本地 CLI 可以启动 dev server，远程可用 `--url`。
- eval case 从 `evals/**/*.eval.ts` 发现。
- eval id 从路径派生，用户不手写 id/name。
- `EvalContext` 提供：
  - `t.send`
  - `t.respond`
  - `t.newSession`
  - `t.completed`
  - `t.calledTool`
  - `t.check`
  - `t.judge`
- `AssertionCollector` 支持 run-level assertion 延后判定。
- `deriveRunFacts()` 从 event stream 派生 tool calls、subagent calls、input requests、failure code 等。
- artifacts 写到 `.eve/evals/<timestamp>/`：
  - `summary.json`
  - `results.jsonl`
  - per-eval `.json`
  - per-eval `.events.ndjson`

Eve 没看到独立的“从 artifacts 重新跑 eval”的 replay runner。它更像：

```text
runtime event stream
  -> eval assertions
  -> deriveRunFacts
  -> artifacts
```

Huaness 可复刻的最小 eval：

```text
evals/**/*.eval.ts
  -> defineEval({ async test(t) { ... } })
  -> InProcessEvalTarget runs AgentLoop
  -> collect AgentEvent[]
  -> deriveRunFacts(events)
  -> assertions
  -> .huaness/evals/<timestamp>/
```

P0 先做 in-process target，比 Eve 的 HTTP target 更轻：

- `t.send("...")`
- `t.events()`
- `t.completed()`
- `t.calledTool("echo")`
- `t.finalMessageContains("...")`

Artifacts：

```text
.huaness/evals/<timestamp>/summary.json
.huaness/evals/<timestamp>/results.jsonl
.huaness/evals/<timestamp>/<eval-id>.json
.huaness/evals/<timestamp>/<eval-id>.events.jsonl
```

## 14. 对 Huaness Lite 的推荐

### 14.1 P0 应采用

1. 明确 `Session -> Turn -> Step -> Event`
   - 当前 `AgentEvent` 应补 `seq`、`turnId`、`step`、`toolCallId`。

2. EventLog 支持 replay/tail
   - JSONL 仍是 source of truth。
   - 明确 `seq` 类似 Eve `startIndex`。

3. StepNext 模型
   - `continue`
   - `done`
   - `wait`

4. ToolDescriptor / ToolExecutor 分离
   - 模型可见 schema 和真实 executor 分开。

5. PolicyDecision 支持 HITL
   - `allow`
   - `deny`
   - `ask_user`

6. 文件写入安全
   - workspace path guard
   - read-before-write
   - stale hash 检测
   - write/shell/network approval-first

7. EvalRunner 最小闭环
   - in-process target
   - event-derived facts
   - artifacts

8. Vercel AI SDK 作为 ModelClient adapter
   - 不替代 AgentLoop。

### 14.2 P1 可升级

- SQLite derived index。
- HTTP eval target。
- `AiSdkModelClient` 支持 streaming。
- `SandboxSession` 抽象。
- Docker/microsandbox 后端。
- skills/instructions store。
- approval pending queue。
- eval judge。

### 14.3 应延后或避免

- 直接依赖 Eve 作为 runtime。
- 直接依赖 AI SDK `ToolLoopAgent` 作为核心 AgentLoop。
- 照搬 Eve Workflow SDK / Nitro route / channel / subagent / connection system。
- 默认启用 `bash/write/web/agent` 大工具面。
- 让 skill 动态绕过 ToolGateway。
- 用 channel adapter 事件反向定义 core EventLog。

## 15. Huaness P0 接 AI SDK 的建议接口

建议先加一个 adapter，而不是重构 loop：

```ts
export interface ModelClient {
  createResponse(input: ModelRequest): Promise<ModelResponse>;
}

export interface AiSdkModelClientOptions {
  model: unknown;
  temperature?: number;
  maxOutputTokens?: number;
}

export class AiSdkModelClient implements ModelClient {
  async createResponse(input: ModelRequest): Promise<ModelResponse> {
    // Convert Huaness messages to AI SDK messages.
    // Call AI SDK generateText/streamText.
    // Convert result back to Huaness ModelResponse.
  }
}
```

关键原则：

- Huaness messages 是内部标准。
- AI SDK messages 是 provider adapter 细节。
- ToolGateway 不交给 AI SDK。
- EventLog 不交给 AI SDK。
- Tool call parsing 可以借 AI SDK 的 typed tool schema，但执行、审批、回写 observation 仍归 Huaness。

## 16. 最小可复刻设计图

```text
Huaness Channel Adapter
  -> RunService
  -> AgentLoop
    -> turn.started
    -> step.started
    -> ContextAssembler
    -> AiSdkModelClient
      -> Vercel AI SDK provider/model call
    -> model.responded
    -> ToolGateway
      -> ToolDescriptor registry
      -> PolicyEngine
        -> allow / deny / ask_user
      -> ToolExecutor
      -> observation.appended
    -> step.completed / run.waiting / run.completed
  -> JsonlEventLog
    -> ReplayReducer
    -> EvalRunner
      -> deriveRunFacts
      -> assertions
      -> artifacts
```

## 17. 最终判断

Eve 的架构方向和 Huaness Lite 的目标高度相关，但 Eve 是完整平台框架，不适合作为 Huaness P0 依赖。Huaness 应吸收 Eve 的语义模型和工程边界：durable step、event stream、HITL pending、tool descriptor/executor 分离、eval artifacts；AI SDK 则应先作为模型调用 adapter 接入，而不是接管 agent loop。
