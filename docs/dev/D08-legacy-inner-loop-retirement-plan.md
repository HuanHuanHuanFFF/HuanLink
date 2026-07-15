# 旧自研 Inner Loop 退休实施计划

> **执行要求：** 按任务顺序执行；代码改动先写失败测试，再写最小实现；文档与代码分开提交。

**目标：** 删除已经被 OpenAI Agents JS `AgentRuntime` 替代的旧 `AgentLoop / ModelClient / ToolGateway / PolicyEngine` 教学链路，同时保留并最小化改造 HuanLink 自有的 EventLog/Replay。

**边界：** 不改变真实 QQ → MainAgent → AgentCall/A2A → Codex Demo 行为，不把 EventLog 接入 Phase 4，不兼容未发布的旧 `1.0` JSONL schema，不处理工业化持久化或 tracing。

**原子提交说明：** Task 1 切换事件类型后，旧 `AgentLoop/ToolGateway` 源码会立即失去可编译的事件合同，因此 Task 1 和 Task 2 必须连续执行并作为一个可编译的 core 提交落地，不能为了形式上的粒度保留一个故意失败的中间提交。

---

## Task 1：把 EventLog/Replay 改为外层编排语义

**修改：**

- `packages/core/src/events/types.ts`
- `packages/core/src/events/create-agent-event.ts`
- `packages/core/src/events/event-json-codec.ts`
- `packages/core/src/replay/types.ts`
- `packages/core/src/replay/create-run-view.ts`
- `packages/core/tests/core-types.test.ts`
- `packages/core/tests/in-memory-event-log.test.ts`
- `packages/core/tests/jsonl-event-log.test.ts`
- `packages/core/tests/replay.test.ts`

### 1.1 先写失败测试

事件 schema 升为 `2.0`，只保留以下外层事件：

```ts
type HuanLinkEventType =
  | "channel.message.received"
  | "main_agent.run.started"
  | "main_agent.run.completed"
  | "main_agent.run.failed"
  | "main_agent.run.cancelled"
  | "agent_call.created"
  | "agent_call.state.changed"
  | "channel.reply.sent"
  | "channel.reply.failed";
```

事件 envelope 删除 `source / step / toolCallId / parentEventId`。测试必须覆盖：

- 成功 run 能折叠出完成状态、MainAgent 输出、AgentCall 终态和已发送回复。
- `agent_call_terminal` 回流 run 能保留原 `agentCallId/taskId` 原因。
- AgentCall 状态按同一 `agentCallId` 聚合。
- 回复失败不覆盖已经完成的 MainAgent run 状态。
- MainAgent failed/cancelled、空事件、乱序事件。
- JSONL/InMemory EventLog 的逐 run seq、并发写入、路径保护、非法 envelope 拒绝仍成立。
- `1.0`、`tool.requested`、`policy.decided` 等旧事件不能再被解析。

运行：

```powershell
corepack.cmd pnpm --filter @huanlink/core test
```

预期：新测试因 `2.0` schema 和外层事件尚未实现而失败。

### 1.2 写最小实现并转绿

`RunView` 只保留：

```ts
type RunViewStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface RunView {
  runId: RunId;
  sessionId: SessionId;
  status: RunViewStatus;
  trigger?: AgentRuntimeTrigger;
  cause?: { agentCallId: AgentCallId; taskId: string; state: AgentCallTaskState };
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  eventCount: number;
  lastSeq: number;
  input?: ChannelInputView;
  output?: string;
  error?: string;
  agentCalls: AgentCallView[];
  reply: ReplyView;
}
```

不保留旧 `toolCalls/finalAnswer/max_steps_exceeded`。取得新 schema 的测试结果后直接进入 Task 2；此时旧源码尚未删除，允许 core typecheck 暂时失败，不在这里提交。

## Task 2：删除旧 inner loop 实现与公开入口

**删除：**

- `packages/core/src/loop/*`
- `packages/core/src/model/*`
- `packages/core/src/tools/*`
- `packages/core/src/policy/*`
- `packages/core/src/context/*`
- `packages/core/src/demos/mock-agent-run.ts`
- `packages/core/tests/mock-agent-run.test.ts`
- `packages/core/tests/mock-agent-run-demo.test.ts`
- `packages/core/tests/tool-gateway.test.ts`

**修改：**

- `packages/core/src/index.ts`
- `packages/core/src/runtime/runtime-config.ts`
- `packages/core/tests/runtime-config.test.ts`
- `package.json`
- `packages/core/package.json`

### 2.1 先写失败测试

在公共 API 测试中动态检查以下运行时导出不存在：

```ts
[
  "AgentLoop",
  "FakeModelClient",
  "ToolGateway",
  "AllowPolicyEngine",
  "echoTool",
  "StaticContextAssembler"
]
```

同时把 RuntimeConfig 预期改为只包含 `eventLog` 与 `logging`，不再包含 `agent.defaultMaxSteps`。运行 core test，确认旧导出和旧配置导致失败。

### 2.2 删除实现并转绿

- 删除旧源码、专属测试和 `demo:mock-run` scripts。
- 从 core barrel export 删除全部旧导出。
- 删除 RuntimeConfig 的 `agent` 分组。
- 用 `git grep` 确认生产代码和测试不再引用旧类型。

完成后运行 core test、typecheck、build，将 Task 1 和 Task 2 一起提交：

```text
refactor(core): 移除旧自研 AgentLoop 路线
```

## Task 3：清理 Server 旧 RuntimeConfig 入口

**修改：**

- `apps/server/src/runtime-config.ts`
- `apps/server/src/index.ts`
- `apps/server/tests/runtime-config.test.ts`
- `.env.example`

### 3.1 先写失败测试

公共出口不再包含 `loadRuntimeConfigFromEnv`；`.env.example` 不再声明：

```text
HUANLINK_EVENT_LOG_BASE_DIR
HUANLINK_EVENT_LOG_NEXT_SEQ_CACHE_SIZE
HUANLINK_AGENT_DEFAULT_MAX_STEPS
```

保留当前真实入口使用的 `HUANLINK_LOG_LEVEL` 和 `loadPhase4QqRuntimeConfigFromEnv`。

### 3.2 删除实现并转绿

删除只服务于旧 runtime 的 schema、loader、出口和测试，运行 server test、typecheck、build，并提交：

```text
refactor(server): 移除旧 RuntimeConfig 入口
```

## Task 4：完整验证、审查与发布

依次运行：

```powershell
corepack.cmd pnpm test
corepack.cmd pnpm typecheck
corepack.cmd pnpm build
```

然后执行：

- 全仓残余引用审计。
- 独立规格审查与代码质量审查。
- 只 push `spike/demo-v0`，不 merge。
- 创建目标为 `main` 的 PR，描述 Demo 能力、旧路线清理和验证结果。
- 不暂存或修改 `docs/dev/dev daily.md` 的用户本地内容。
