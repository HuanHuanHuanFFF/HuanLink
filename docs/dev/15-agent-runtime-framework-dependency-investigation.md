# Huaness Lite 可用框架与依赖调研

调查日期：2026-06-23

目标：结合当前开发日记、已有 `docs/dev` 调研、`references/` 参考项目和最新官方资料，整理 Huaness Lite 可以使用的框架/依赖。重点不是追求“全家桶”，而是判断哪些库能减少无意义样板代码，同时不抢走 Huaness 自己的核心架构控制权。

## 一句话结论

Huaness Lite P0 应该采用“轻核心 + 强适配器”的依赖策略：

```txt
Huaness 自己掌控:
  AgentLoop / ContextAssembler / ToolGateway / PolicyEngine / EventLog / Replay / Eval / Self-improve pipeline

依赖库帮助减少样板代码:
  Vercel AI SDK / Fastify / Zod / Execa / p-queue / Pino / Vitest / tsx
```

完整 agent 框架如 Eve、LangGraph、Mastra、VoltAgent 都值得学习，但 P0 不建议作为 Huaness 的 runtime 依赖。它们会直接覆盖 Huaness 最有简历价值的部分：loop、持久化、tool 生命周期、HITL、eval、memory。

## 0. 从当前开发日记提炼出的核心需求

开发日记和现有文档里反复出现的主线不是“接 QQ”，而是 agent/harness runtime：

| 需求 | 对依赖选择的影响 |
| --- | --- |
| Vercel AI SDK 要尽快接入 | `ai` 应作为 `ModelClient` / streaming adapter 的 P0 依赖 |
| JSONL 先作为 EventLog source of truth | P0 不急着引入数据库 ORM，SQLite/DB index 放 P1 |
| 群聊/频道中的长任务不能阻塞会话 | 需要异步任务队列/任务 ID/通知机制；可评估 `p-queue`，但语义由 Huaness 定义 |
| 消息多时要做缓冲/合并 | 需要 session queue / debounce 逻辑；不需要重框架，最多用轻量队列库 |
| 上下文压缩、近期记忆、skills 后续要做 | P0 先稳定 ContextAssembler 和 EventLog；memory provider/RAG 延后 |
| ToolGateway/Policy/EventLog 是核心 | 工具执行、安全审批、事件语义不能交给完整 agent 框架 |
| Linux 单机长期运行 | 依赖应偏 Node 原生、文件系统友好、systemd 友好，不默认 Redis/Postgres/K8s |

## 1. 当前项目依赖基线

当前根 `package.json` 只有开发基础依赖：

| 依赖 | 当前用途 | 判断 |
| --- | --- | --- |
| `typescript` | TypeScript 编译 | 保留 |
| `vitest` | core 单测 | 保留 |
| `@types/node` | Node 类型 | 保留 |
| `rimraf` | clean 脚本 | 保留 |

`packages/core` 和 `apps/server` 当前没有 runtime dependencies。这很好，因为核心边界还干净；下一步加依赖时应按层加，不要一次装一堆。

## 2. 参考项目实际依赖信号

只看源码思想不够，还要看成熟项目用什么“基础设施库”支撑 runtime。

| 项目 | 本地证据 | 实际依赖信号 | 对 Huaness 的启发 |
| --- | --- | --- | --- |
| OpenClaw | `references/openclaw/package.json` | `@modelcontextprotocol/sdk`、`zod`、`typebox`、`express`、`ws`、`commander`、`cross-spawn`、`proper-lockfile`、`glob`、`ignore`、`diff`、`kysely`、`undici` | 大量价值不在“agent 框架”，而在工具、协议、锁、schema、进程、网络、持久化这些 runtime 支撑 |
| Gemini CLI | `references/gemini-cli/package.json` | `ink`、`proper-lockfile`、`simple-git`、`glob`、`node-pty`、`vitest`、`tsx` | CLI/TUI、checkpoint、session 记录、锁、PTY 是成熟 CLI agent 的支撑层，但 Huaness P0 不必上 TUI/PTY |
| Eve | `references/eve/packages/eve/package.json` | `ai`、`@ai-sdk/*`、`@workflow/*`、`nitro`、`zod`、`autoevals`、`microsandbox`、`@vercel/sandbox` | Eve 把 durable workflow、sandbox、eval、tool loop 都打包了；适合学习，不适合 P0 直接接管 Huaness core |
| Claude Code 参考源码 | `references/claude-code/package.json` | `@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`、`execa`、`zod`、`proper-lockfile`、`diff`、`ws`、`undici`、`@opentelemetry/*` | 编码 agent 很依赖进程执行、MCP、diff、锁、观测；这些可以分层吸收 |
| Hermes Agent | `references/hermes-agent` | Node 依赖较少，核心 self-improve 在 Python/SQLite/文件资产链路 | self-improve 重点不是某个 JS 库，而是 session/trajectory -> review -> candidate -> approval -> asset |

## 3. 依赖选择原则

P0 引依赖要满足这些条件：

1. 能减少无价值重复代码，比如 provider 适配、HTTP 路由、schema 校验、进程执行封装、日志格式。
2. 不隐藏 AgentLoop / ToolGateway / EventLog 的核心语义。
3. 不要求 Redis、Postgres、K8s、云平台等外部系统。
4. 能被测试替换，比如 fake model、fake tool executor、in-memory queue。
5. 对后续演进友好，即便换掉也不会重写 core 类型。

判断边界：

```txt
可以依赖:
  transport / validation / process wrapper / logger / queue primitive / test helper

谨慎依赖:
  memory provider / workflow engine / eval platform / observability SaaS

避免 P0 依赖:
  完整 agent runtime / 全家桶框架 / 强数据库迁移系统 / Redis queue / 云 sandbox
```

## 4. Agent 框架候选

### 4.1 Vercel AI SDK

资料：
- [AI SDK Introduction](https://ai-sdk.dev/docs/introduction)
- [AI SDK Core Overview](https://ai-sdk.dev/docs/ai-sdk-core/overview)
- [AI SDK Agents Overview](https://ai-sdk.dev/docs/agents/overview)
- [AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

定位：TypeScript AI 应用/agent toolkit。官方文档当前显示 `v6 (Latest)`，核心包含 provider abstraction、`generateText`、`streamText`、structured output、tool calling、`ToolLoopAgent`、MCP、UI、testing、telemetry。

Huaness 接入方式：

```txt
P0 必接:
  ModelClient adapter
  Streaming adapter
  usage / finishReason / error / abort event mapping

P0 预留:
  tool schema / tool call parsing

P1+:
  structured output
  MCP adapter
  UI hooks
  embedding / rerank
  telemetry / middleware
```

不建议：

```txt
不要把 ToolLoopAgent 作为 Huaness 主 AgentLoop。
不要把 AI SDK needsApproval 当成完整 PolicyEngine。
不要把 AI SDK steps 当成唯一 run trajectory。
```

结论：P0 依赖，优先级最高。

### 4.2 Eve

资料：
- 本地：`references/eve`
- 现有文档：`docs/dev/12-vercel-eve-ai-sdk-investigation.md`

定位：filesystem-first durable backend agent framework。它把 agent 目录结构、durable workflow、tool loop、approval、sandbox、eval、channel、AI SDK 都集成了。

价值：

- 学 `Session -> Turn -> Step -> Event`。
- 学 durable step / wait / resume。
- 学 tool descriptor / executor / approval 分离。
- 学 event stream 和 eval artifact。

风险：

- `@workflow/*`、`nitro`、sandbox、eval、channel 等整体绑定太多。
- 直接接入会让 Huaness 变成 Eve app，而不是自己的 harness runtime。
- 本地文档之前已经确认 Eve 依赖 beta 栈，P0 稳定性不合适。

结论：P0 只作为参考，不作为 runtime dependency。

### 4.3 LangGraph.js

资料：
- [LangGraph JS overview](https://docs.langchain.com/oss/javascript/langgraph/overview)

官方定位：low-level orchestration framework/runtime for long-running, stateful agents，强调 durable execution、streaming、human-in-the-loop、persistence、memory。

价值：

- 它的关注点和 Huaness 很接近：长任务、状态化 agent、持久化、HITL、stream。
- 可以学习 graph/state/checkpoint 的表达方式。
- P2 如果 Huaness 想做复杂多节点 workflow，可以做实验对比。

风险：

- 它本身就是 orchestration runtime，会覆盖 Huaness 的 AgentLoop 价值。
- 如果接入 LangSmith/LangGraph platform，基础设施会变重。
- 对 P0 Linux 单机 lite 目标偏重。

结论：P0 不接，P1/P2 作为“复杂 workflow 参考”。

### 4.4 Mastra

资料：
- [Mastra Docs](https://mastra.ai/docs)

官方定位：TypeScript framework for AI apps + agents，包含 agents、memory、workflows、MCP、server、observability、evals、RAG、voice、Studio。

价值：

- 生态能力非常全，适合看“一个 TS agent framework 如何组织 agents/workflows/tools/memory/evals”。
- Studio 和 eval 设计值得参考。
- 可以参考框架目录和 integration 思路。

风险：

- 太完整，容易接管 Huaness 的项目形态。
- Huaness 的目标是自己做 harness lite，不是基于 Mastra 二次开发。

结论：P0 不接，作为 P1/P2 对照项目学习。

### 4.5 VoltAgent

资料：
- [VoltAgent Docs](https://voltagent.dev/docs/)

官方定位：open source TypeScript framework，覆盖 agents、memory、RAG、guardrails、tools、MCP、workflow、observability、evals、deployment。

价值：

- 它直接基于 AI SDK provider 示例，和 Huaness 技术方向接近。
- 可以参考 server-hono、logger、triggers/actions、observability 组织方式。

风险：

- 和 Mastra 类似，完整框架会吞掉 Huaness 的 runtime 设计空间。
- P0 接入会变成“使用 VoltAgent 做一个 bot”，而不是实现 harness。

结论：P0 不接，适合作为“TS agent 框架对照样本”。

## 5. 分层依赖建议

### 5.1 Model / Streaming 层

推荐：

| 依赖 | P0? | 用途 | 说明 |
| --- | --- | --- | --- |
| `ai` | 是 | Vercel AI SDK core，模型调用、stream、tool call signal | P0 必接 |
| `@ai-sdk/openai` | 可选 | 直接接 OpenAI provider | 如果不用 AI Gateway 或 OpenAI-compatible gateway，需要接 |
| `@ai-sdk/anthropic` | 可选 | 直接接 Anthropic provider | 如果服务器上要直接用 Claude，需要接 |
| `@ai-sdk/google` | 可选 | 直接接 Gemini provider | 如果要直接用 Gemini，需要接 |

P0 最小形态：

```txt
packages/model-ai-sdk
  -> AiSdkModelClient
  -> convert Huaness messages to AI SDK messages
  -> streamText fullStream -> Huaness model events
```

建议：

- 如果能接受 Vercel AI Gateway，先只用 `ai` 和 gateway model string。
- 如果想避免 gateway 绑定，使用 `ai + provider packages`。
- 不再单独引 `openai`、`@anthropic-ai/sdk`、`@google/genai`，除非 AI SDK provider 覆盖不了某个特殊能力。

### 5.2 Schema / Tool Protocol 层

推荐：

| 依赖 | P0? | 用途 | 说明 |
| --- | --- | --- | --- |
| `zod` | 是 | 输入校验、tool schema、config validation、structured output schema | AI SDK 示例和 Eve 都大量使用；Zod 4 已稳定 |
| `zod-validation-error` | 否 | 更友好的校验错误 | P1 可接 |
| `typebox` | 否 | JSON Schema-first 类型/schema | OpenClaw 使用，但 Huaness 选 Zod 更自然 |
| `ajv` | 否 | JSON Schema validator | 如果未来插件从外部加载 JSON Schema，再考虑 |

为什么 P0 选 `zod`：

- TypeScript-first。
- 能从 schema 推导类型。
- 能直接服务 tool input validation。
- 能给 AI SDK tool `inputSchema` 使用。
- 也能校验 config、channel event、eval case。

边界：

```txt
Zod 负责校验数据形状。
Huaness PolicyEngine 负责判断是否允许执行。
```

### 5.3 HTTP / Channel API 层

推荐：

| 依赖 | P0? | 用途 | 说明 |
| --- | --- | --- | --- |
| `fastify` | 是 | HTTP/RPC/SSE server 外壳 | 已在 `docs/dev/04` 选定；当前官方 latest v5.8.x |
| `@fastify/websocket` | 否 | approval/cancel 双向通道 | P1，P0 SSE + HTTP POST 足够 |
| `hono` | 否 | 极轻 Web Standards server / typed RPC | P1/P2 如果未来做 edge 或强 typed client 再看 |
| `express` | 否 | 传统 HTTP server | OpenClaw 使用 Express，但 Huaness 新项目更适合 Fastify/Hono |

P0 API 形态：

```txt
POST /runs
GET  /runs/:runId
GET  /runs/:runId/events    # SSE or NDJSON
POST /runs/:runId/approvals/:requestId
POST /runs/:runId/cancel
```

Fastify 只属于 `apps/server` 或 `packages/server-adapter`，不要进入 `packages/core`。

### 5.4 异步任务 / 非阻塞工具层

开发日记里这个需求很关键：长任务不应该阻塞群聊/频道会话。工具调用可以返回任务 ID，agent 后续查询或接收通知。

候选：

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| 无依赖：`Map + Promise + AbortController` | 是 | 最小 AsyncTaskManager | 最可控，适合先跑通语义 |
| `p-queue` | 可选 P0 | 并发控制、排队、限速 | 如果马上要限制并发，很适合 |
| `p-limit` | 可选 P0 | 限制一组 async job 并发 | 比 p-queue 更轻，但不如 queue 语义完整 |
| `bullmq` | 否 | Redis-backed durable queue | P0 太重，需要 Redis |
| `bree` / cron 类库 | 否 | 定时任务 | 和当前 agent loop 核心无关 |

推荐：

```txt
P0:
  先定义 Huaness AsyncTaskManager 接口
  实现 InMemoryTaskManager
  如果并发控制需求出现，再用 p-queue 做内部实现

P1:
  从 EventLog 恢复 pending/running task 状态
  再考虑 SQLite index 或持久化 queue
```

不要把 `p-queue` 暴露给 core 类型。core 应该只知道：

```ts
interface TaskManager {
  start(input: TaskStartInput): Promise<TaskHandle>;
  get(taskId: string): Promise<TaskSnapshot>;
  cancel(taskId: string): Promise<void>;
}
```

### 5.5 Tool Execution / Process Runner 层

候选：

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| Node `child_process.spawn` / `execFile` | 是 | 最小命令执行 | 可控、无依赖，但样板代码多 |
| `execa` | 可选 P0 | 更好的进程执行封装 | 官方 README 强调无 shell injection、Windows 支持、stream/cancel/error 更好 |
| `cross-spawn` | 否 | 跨平台 spawn 修正 | OpenClaw 用；但如果用 Execa，通常不需要单独接 |
| `node-pty` | 否 | 交互式终端/TTY | P1/P2，P0 不做完整 terminal agent |
| `microsandbox` / `@vercel/sandbox` | 否 | sandbox backend | Eve 使用，但 P0 太重 |

推荐：

```txt
P0 可选接 execa:
  ToolExecutor.executeCommand()
    -> workspace guard
    -> approval
    -> execa(command, args, { cwd, timeout, signal, env })
    -> output cap
    -> EventLog
```

如果暂时不想加依赖，也可以先用 Node 原生 `spawn`，但要自己补：

- timeout。
- signal cancel。
- stdout/stderr streaming。
- output cap。
- exit code/error normalization。
- Windows command path 兼容。

因为 Huaness 会实际跑在服务器上，`execa` 是很值得考虑的 P0 依赖。

### 5.6 文件发现、忽略规则、diff

推荐：

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| `glob` / `fast-glob` | 可选 P0 | 文件发现工具 | 如果做 `list_files` / `search`，可以用 |
| `ignore` | 可选 P0 | 解析 `.gitignore` 风格规则 | OpenClaw/Claude Code 都用，适合保护 node_modules/.git |
| `diff` | 可选 P0 | 生成写文件前后的 diff | approval UI/日志很有用 |
| `chokidar` | 否 | 监听 config/skills/tools 热更新 | P1 |

推荐顺序：

```txt
P0:
  ignore
  diff

按需:
  glob / fast-glob

P1:
  chokidar
```

文件写入工具建议不要只做 `writeFile(path, content)`，至少要有：

```txt
read-before-write
expected hash / length
diff preview
approval
EventLog
```

### 5.7 EventLog / Storage 层

P0 不建议引数据库依赖。

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| Node `fs/promises` | 是 | JSONL EventLog | P0 source of truth |
| `proper-lockfile` | 否/可选 | 跨进程文件锁 | P1；当前单核心进程可先不用 |
| `better-sqlite3` | 否 | SQLite derived index | P1 |
| `kysely` | 否 | type-safe SQL builder | OpenClaw 使用；P1 如果接 SQLite 可考虑 |
| `drizzle-orm` | 否 | ORM/migration | 现在会增加 schema 迁移成本，延后 |
| `postgres` / `pg` | 否 | Postgres | P2，多用户/远端部署再看 |

推荐：

```txt
P0:
  JSONL + run index file

P1:
  better-sqlite3 + Kysely
  SQLite 只做 derived index

P2:
  Postgres / remote DB
```

数据库依赖现在不接的原因不是“不好”，而是当前 event schema 还在频繁演进，太早接 ORM/migration 会制造额外负担。

### 5.8 Replay / Eval 层

候选：

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| `vitest` | 是 | 单测和 in-process eval | 当前已有，继续用 |
| 自研 `EvalRunner` | 是 | 从 EventLog 派生 facts/assertions | P0 最适合 |
| `autoevals` | 否 | LLM judge/eval helper | Eve 使用，P1/P2 再看 |
| LangSmith / Braintrust | 否 | 托管 trace/eval 平台 | P2，先不要把数据闭环交给外部平台 |

P0 eval 最小设计：

```txt
EvalCase
  -> FakeModelClient
  -> InMemoryToolGateway
  -> AgentLoop
  -> AgentEvent[]
  -> deriveRunFacts(events)
  -> assertions
```

这比接完整 eval 平台更符合 Huaness 当前目标。

### 5.9 MCP / 外部工具生态层

资料：
- [Model Context Protocol docs](https://modelcontextprotocol.io/docs)
- [AI SDK MCP Tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)

候选：

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | 否/P1 | 直接做 MCP client/server | P1 工具生态入口 |
| `@ai-sdk/mcp` | 否/P1 | 把 MCP tools 转成 AI SDK tools | 如果 AI SDK tool protocol 接入后，可用 |

推荐：

```txt
P0:
  保留 ToolRegistry 抽象，不接 MCP

P1:
  MCPAdapter discovers tools
  -> normalize to Huaness ToolDescriptor
  -> PolicyEngine filters
  -> expose selected schemas to model
```

不要直接：

```txt
mcpClient.tools() -> model
```

中间必须经过 Huaness policy 和 event trace。

### 5.10 Observability / Runtime Log 层

候选：

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| `pino` | 是 | 结构化 runtime log | Fastify 生态天然匹配，适合 systemd/journald |
| `pino-pretty` | dev | 本地开发日志美化 | dev dependency |
| `@opentelemetry/api` | 否 | 标准 tracing API | Claude Code 参考源码使用；P1/P2 |
| `@ai-sdk/otel` | 否 | AI SDK telemetry | P1/P2，不能代替 EventLog |

要区分两类日志：

```txt
runtime log:
  pino -> stdout -> journald

fact log:
  Huaness EventLog -> JSONL
```

P0 推荐接 `pino`，但不要把 pino log 当成 replay source。

### 5.11 CLI / Dev Tooling 层

候选：

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| `commander` | 可选 P0 | CLI 命令解析 | OpenClaw 使用，稳定清楚 |
| `cac` | 可选 | 更轻的 CLI parser | 也可用，但生态证据少于 commander |
| `tsx` | 可选 dev | 直接跑 TS 脚本/demo/eval | 建议加入 dev dependency |
| `ink` | 否 | React TUI | Gemini CLI 使用，但 P0 不做复杂 TUI |
| `chalk` | 否 | 彩色输出 | 不是核心，先不急 |

P0 如果要做 CLI channel：

```txt
commander
  -> huaness run "..."
  -> huaness replay <runId>
  -> huaness eval
```

但 CLI 不应污染 core。

### 5.12 Lint / Format / Build 工具

当前还没有 formatter/linter。可以后置，但越早统一越省心。

候选：

| 依赖 | P0? | 用途 | 判断 |
| --- | --- | --- | --- |
| `prettier` | 可选 P0 | Markdown/TS 格式统一 | 稳定、通用 |
| `eslint` + `typescript-eslint` | 可选 P1 | TS lint | 配置成本略高 |
| `oxlint` | 可选 P1 | 快速 lint | OpenClaw/Eve 用，但生态配置要评估 |
| `tsdown` / `tsup` | 否 | 打包 | 当前 `tsc` 足够 |

推荐：

```txt
P0:
  暂时继续 tsc + vitest

P1:
  prettier
  eslint 或 oxlint 二选一
```

不要为了工具链漂亮影响 agent core 进度。

## 6. P0 推荐依赖组合

如果下一步开始真正接依赖，建议按这个最小组合分批装：

### 第一批：模型与 schema

```txt
ai
zod
```

可选 provider：

```txt
@ai-sdk/openai
@ai-sdk/anthropic
@ai-sdk/google
```

是否装 provider package 取决于是否直接用各家 provider。如果先走 AI Gateway，可能只需要 `ai`。

### 第二批：server 与 runtime log

```txt
fastify
pino
```

dev 可选：

```txt
pino-pretty
tsx
```

### 第三批：工具执行和异步任务

```txt
execa
p-queue
```

这两个都建议通过 Huaness 自己的接口包住，不暴露到 core 类型。

### 第四批：文件工具体验

```txt
ignore
diff
```

`glob` / `fast-glob` 按工具实现需要再接。

### 当前不急

```txt
@modelcontextprotocol/sdk
@ai-sdk/mcp
better-sqlite3
kysely
@opentelemetry/api
@ai-sdk/otel
autoevals
@fastify/websocket
chokidar
```

## 7. 推荐包边界

依赖不要都塞进 `packages/core`。建议按包隔离：

```txt
packages/core
  - 只放 Huaness 稳定接口、AgentLoop、ToolGateway、PolicyEngine、EventLog 抽象
  - 尽量少 runtime deps

packages/model-ai-sdk
  - ai
  - @ai-sdk/*
  - zod if needed for tool schemas

packages/server
  - fastify
  - pino

packages/tools-node
  - execa
  - ignore
  - diff

packages/runtime-queue
  - p-queue

packages/storage-jsonl
  - fs/path only

packages/storage-sqlite
  - better-sqlite3
  - kysely
  - P1+

apps/server
  - wire adapters together
```

如果暂时不拆这么多包，也至少要保持 import 方向：

```txt
core -> no Fastify / no AI SDK / no Execa
adapters -> import core and external libs
```

## 8. 应避免的依赖陷阱

### 8.1 太早接完整 agent framework

不要 P0 接：

```txt
LangGraph as runtime
Mastra as app framework
VoltAgent as app framework
Eve as runtime
LangChain agents
```

原因不是这些框架不好，而是它们会接管 Huaness 要展示的核心能力。

更合适：

```txt
学习它们的概念和事件模型
复刻最小必要机制
保持 Huaness core 自己可解释
```

### 8.2 太早接重数据库

不要 P0 接：

```txt
Postgres
Prisma
完整 migration 系统
Redis queue
```

原因：

- event schema 还会变。
- run/replay 语义还在定。
- 数据库会让开发变慢。
- JSONL 当前更适合 debug/replay/source of truth。

### 8.3 把观测当事实源

不要：

```txt
OpenTelemetry / Pino / AI SDK telemetry = EventLog
```

应该：

```txt
Pino:
  服务运行健康日志

OpenTelemetry:
  tracing/metrics

Huaness EventLog:
  replay/eval/audit/self-improve source of truth
```

### 8.4 让工具库越过 PolicyEngine

不论是：

```txt
AI SDK tools
MCP tools
Execa command
Fastify route
channel plugin
```

都不能绕过：

```txt
ToolRegistry -> PolicyEngine -> Approval -> ToolGateway -> EventLog
```

## 9. 建议接入顺序

### Phase 1：ModelClient Adapter

目标：让 Huaness 用 AI SDK 跑真实模型和流式事件。

建议依赖：

```txt
ai
zod
@ai-sdk/openai / @ai-sdk/anthropic / @ai-sdk/google optional
```

交付：

```txt
AiSdkModelClient
streamText -> Huaness model events
fake/mock tests
```

### Phase 2：Server Shell

目标：让 HTTP/SSE 能创建 run、查看 run、tail events。

建议依赖：

```txt
fastify
pino
```

交付：

```txt
POST /runs
GET /runs/:id/events
POST /runs/:id/cancel
```

### Phase 3：Tool Execution

目标：工具执行更安全、更好记录。

建议依赖：

```txt
execa
ignore
diff
p-queue optional
```

交付：

```txt
read_file
list_files
write_file with diff/approval
shell with timeout/output cap
async task id
```

### Phase 4：Replay/Eval

目标：从 JSONL 还原 run facts，跑 fake model regression。

建议依赖：

```txt
vitest already
tsx optional
```

交付：

```txt
RunReplay reducer
EvalCase runner
deriveRunFacts
eval artifacts
```

### Phase 5：P1 生态扩展

目标：接 MCP、SQLite index、WebSocket approval、memory/search。

候选依赖：

```txt
@modelcontextprotocol/sdk
@ai-sdk/mcp
better-sqlite3
kysely
@fastify/websocket
chokidar
@opentelemetry/api
```

## 10. 最终推荐表

| 层 | P0 推荐 | P1/P2 升级 | 不建议 P0 |
| --- | --- | --- | --- |
| Model | `ai` | `@ai-sdk/*` provider、AI SDK structured output | 直接散落 `openai`/`anthropic` SDK |
| Tool schema | `zod` | `zod-validation-error`、JSON Schema/AJV | 同时混用多套 schema 系统 |
| Server | `fastify` | `@fastify/websocket`、Hono typed client | NestJS、完整 RPC 框架 |
| Runtime log | `pino` | OpenTelemetry | 用 runtime log 替代 EventLog |
| Process | Node `spawn` 或 `execa` | `node-pty`、Docker/microsandbox | 直接执行模型生成 shell |
| Async task | 自研接口 + 可选 `p-queue` | durable queue / SQLite resume | BullMQ/Redis |
| EventLog | Node `fs` JSONL | `proper-lockfile`、SQLite index | P0 上 Postgres/ORM |
| Eval | Vitest + 自研 eval runner | `autoevals`、judge model | 托管 eval 平台先行 |
| MCP | 预留接口 | `@modelcontextprotocol/sdk`、`@ai-sdk/mcp` | 直接把所有 MCP tools 暴露给模型 |
| Agent framework | 自研 Huaness core | LangGraph/Mastra/VoltAgent/Eve 做对照实验 | 直接作为主 runtime |

## 11. 当前最稳的依赖策略

```txt
现在可以大胆接:
  ai
  zod
  fastify
  pino
  execa
  p-queue

先预留接口，后续接:
  @modelcontextprotocol/sdk
  @ai-sdk/mcp
  better-sqlite3
  kysely
  @fastify/websocket
  @opentelemetry/api

只学习，不作为 P0 依赖:
  Eve
  LangGraph
  Mastra
  VoltAgent
```

最关键的边界：

```txt
依赖库帮 Huaness 少写基础设施。
Huaness 自己定义 runtime 语义。
```

## 资料链接

- [AI SDK Introduction](https://ai-sdk.dev/docs/introduction)
- [AI SDK Core Overview](https://ai-sdk.dev/docs/ai-sdk-core/overview)
- [AI SDK Agents Overview](https://ai-sdk.dev/docs/agents/overview)
- [AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [Fastify docs](https://fastify.dev/docs/latest/)
- [Hono docs](https://hono.dev/docs/)
- [Zod docs](https://zod.dev/)
- [MCP docs](https://modelcontextprotocol.io/docs)
- [LangGraph JS overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Mastra docs](https://mastra.ai/docs)
- [VoltAgent docs](https://voltagent.dev/docs/)
- [Execa repository](https://github.com/sindresorhus/execa)
- [p-queue repository](https://github.com/sindresorhus/p-queue)
- [p-limit repository](https://github.com/sindresorhus/p-limit)
- [better-sqlite3 repository](https://github.com/WiseLibs/better-sqlite3)

## 本地参考路径

- `docs/dev/dev daily.md`
- `docs/dev/04-tech-selection-investigation.md`
- `docs/dev/11-run-event-log-trajectory-replay-eval-investigation.md`
- `docs/dev/12-vercel-eve-ai-sdk-investigation.md`
- `docs/dev/14-vercel-ai-sdk-core-capabilities.md`
- `references/openclaw/package.json`
- `references/gemini-cli/package.json`
- `references/eve/packages/eve/package.json`
- `references/claude-code/package.json`
- `references/hermes-agent/package.json`
