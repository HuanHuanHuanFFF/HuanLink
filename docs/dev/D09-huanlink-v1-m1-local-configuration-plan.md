# HuanLink v1.0 M1 本地单用户配置化设计与实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `test-driven-development` for every behavior change. Execute only one `M1-Bxx` batch at a time, verify it, and update this document before moving to a batch whose decision gate is still open.
>
> **当前状态：** M1 已获准开始。本文件是 M1 的设计台账、问题清单和渐进实施计划；它不会授权 M2～M5，也不会授权 merge 到 `main`。

**Goal:** 在保留真实 QQ → MainAgent → A2A → Codex → Artifact → 原会话回流闭环的前提下，把固定 Demo 转换为可配置、可诊断的本地单用户运行基线。

**Architecture:** HuanLink 主服务只拥有 Channel、MainAgent 和外部 Agent 的发现/调用信息；Codex A2A Adapter 独立拥有项目、workspace、工作目录、分支、Codex 模型和 app-server 运行约束。Core 保持协议中性，标准 A2A Message 承载自然语言和结构化目标信息，不把 Codex 私有规则写入 Core 或 MainAgent。

**Tech Stack:** TypeScript、Node.js、pnpm workspace、Vitest、Zod、OpenAI Agents JS、A2A Protocol v1.0、A2A JS SDK、Codex app-server、OneBot 11。

---

## 1. 依据、推进方式与 Git 门禁

本计划受以下文件约束：

- `AGENTS.md`：仓库结构、配置所有权、测试与 Git 规则。
- `docs/dev/24-huanlink-v1-product-requirements-draft.md`：v1.0 产品语义和暂缓项。
- `docs/dev/26-huanlink-v1-development-plan.md`：阶段级主计划；M1 是唯一允许进入的里程碑。
- `docs/dev/23-a2a-first-real-demo-plan.md`：真实闭环基线，不继续追加 Demo Phase。

推进规则：

1. 所有工作只在 `dev/v1.0` 进行。
2. 每次只执行一个 `M1-Bxx` 小批次；先写失败测试，再做最小实现。
3. 一个批次通过不等于 M1 完成，也不等于真实闭环通过。
4. 文档与代码保持可分开暂存、分开提交。
5. M1 完成后先报告实际结果和未解决项，得到用户确认后才 commit/push。
6. 未经用户确认，不 merge 到 `main`，不提前进入 M2～M5。

## 2. 决策台账

### 2.1 已确认

- HuanLink 对标准 A2A Agent 使用通用 A2A 注册和调用边界；非 A2A 后端使用各自独立 Adapter。
- M1 只把当前单一 Codex 目标从固定装配改为协议中性的“已配置 A2A 目标”，不提前实现 M3 的多 Agent 目录、动态发现刷新、认证和能力路由。
- A2A Agent 必须在 Agent Card 中声明流式任务能力；非流式 Agent 直接返回明确的不兼容错误。
- 五分钟不能成为任务执行上限。当前 Adapter 保留 SSE 心跳，客户端断流后必须查询权威任务状态并重订阅。
- 若使用 Undici `bodyTimeout: 0`，只能作用于 A2A SSE 订阅，不能污染 Agent Card、提交、查询、取消或进程内其他 HTTP 请求。
- 一次订阅错误或一次状态查询错误只表示“观察链路异常”，不能据此把远端任务改成 `failed`。
- `.huanlink/` 当前整体被 Git 忽略；其中只放本机活动配置、日志和运行态，不把它当成受版本控制的正式配置合同。
- 配置按实际职责拆成多个 JSON，而不是强行压缩成两个大 JSON；两个进程入口不等于只能有两个配置文件。
- 密钥不写入普通 JSON；本地 `.env` 或进程环境继续承载 API Key、Token 等秘密。
- M1 配置在进程启动时读取并冻结；热更新留到产品入口稳定后再设计。

### 2.2 到对应批次时一次只确认一项

| 决策门 | 推荐默认值 | 在哪个批次冻结 | 未确认前的行为 |
|---|---|---|---|
| 活动配置目录 | `.huanlink/config/`；受控示例放 `configs/examples/` | M1-B02 | B02 只按该默认值写测试和合同；用户可在批次开始前调整 |
| 同一 workspace 并发 | 已有修改任务时立即拒绝新任务 | M1-B05 | 不实现内存排队或持久队列 |
| Codex 模型缺省语义 | 项目配置提供 `defaultModelId`，任务可显式覆盖 `modelId` | M1-B03 | MainAgent 模型始终独立，不作为 Codex 缺省值 |
| SSE 失联窗口 | 使用应用层可取消活性计时；具体数值由受控测试和真实日志校准 | M1-B06 | 保留现有 30 秒 Adapter 心跳，不把 300 秒当任务失败条件 |
| 终态 Task 内存保留 | M1 先明确进程期边界；只有长运行测试证明必要时才增加上限 | M1-B07 | 不引入数据库、恢复器或持久队列 |

### 2.3 明确不在 M1 实现

- 多 Agent 产品目录、动态能力刷新、远程公网鉴权和多租户。
- 服务重启后的任务、订阅和 Codex thread 恢复。
- 分布式 exactly-once、事件游标协议、复杂队列和工作流 DSL。
- `scopePaths`、文件级 ACL、每任务 worktree 和工作焦点外修改即失败。
- 自动 commit、push、merge、部署或通用审批中心。
- 自动 Review 的新调用方案、模型成本路由和故障转移平台。
- 通用本地 Worker Agent、递归子 Agent 和 M2 的复杂编排策略。

## 3. 当前实现审计

| 现状 | 代码位置 | M1 影响 |
|---|---|---|
| Server 从 `.env` 聚合 OneBot、MainAgent 和固定 Codex A2A 地址 | `apps/server/src/runtime-config.ts` | 需要拆成按所有权读取的模块化配置 |
| Server 运行时参数和 MainAgent Tool 仍使用 `codexA2aOrigin`、`codexSkillId` 等 Codex 名称 | `apps/server/src/phase3-runtime.ts`、`apps/server/src/main-agent-runtime.ts` | 只替换阻碍 M1 的固定装配，不重写 AgentCall |
| Core 提交请求只有 `skillId`、文本和 `contextId` | `packages/core/src/agent-call/types.ts` | 缺少稳定 `agentId` 和协议中性结构化目标通道 |
| A2A Client 只发送文本 Part | `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts` | M1 需把目标信息映射到标准 Message metadata 或 data Part |
| Adapter 从环境变量读取单一 workspace/model，分支仍硬编码为 `spike/demo-v0` | `apps/codex-a2a-adapter/src/main.ts` | 需要项目注册表和 Adapter 自有配置 |
| Adapter 已限制监听地址为 loopback | `apps/codex-a2a-adapter/src/runtime-config.ts` | 保留；Server 配置的 outbound A2A origin 也应限制 loopback |
| Adapter 每 30 秒写 SSE 注释心跳 | `apps/codex-a2a-adapter/src/server.ts` | 保留并补资源清理/长连接回归 |
| 订阅异常后会 `GetTask` 对账，但一次 `GetTask` 网络异常会直接终止 watcher | `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts` | 已有真实误判风险，M1-B01 先修复 |
| 同一 workspace 的不同 Codex thread 可以同时修改 | `apps/codex-a2a-adapter/src/codex-task-executor.ts` | M1 必须建立最小互斥规则 |
| app-server 失效后 HTTP 入口仍可能接受新任务；取得 `turnId` 前取消可能长期等待 | `apps/codex-a2a-adapter/src/codex-task-executor.ts` | M1-B07 做窄生命周期补口 |
| Core、Adapter TaskStore 和会话状态均含内存实现 | `packages/core`、`apps/codex-a2a-adapter/src/server.ts` | 记录为边界，不宣称重启恢复 |

## 4. 目标配置结构与所有权

M1 推荐的活动配置目录如下；实际文件是本机配置，不提交：

```text
.huanlink/config/
├── server/
│   ├── main-agent.json
│   ├── channels/
│   │   └── onebot11.json
│   └── agents/
│       └── codex-local.json
└── codex-adapter/
    ├── runtime.json
    └── projects/
        └── huanlink.json
```

仓库跟踪同形状的脱敏示例：

```text
configs/examples/
├── server/main-agent.json
├── server/channels/onebot11.json
├── server/agents/codex-local.json
├── codex-adapter/runtime.json
└── codex-adapter/projects/huanlink.json
```

### 4.1 MainAgent 配置

```json
{
  "version": 1,
  "provider": "deepseek",
  "modelId": "deepseek-v4-flash",
  "baseURL": "https://api.deepseek.com/beta",
  "apiKeyEnv": "DEEPSEEK_API_KEY"
}
```

该文件属于 Server。`apiKeyEnv` 只保存环境变量名；解析结果可以包含实际 key，但错误和日志不得输出该值。

### 4.2 Channel 配置

```json
{
  "version": 1,
  "channelId": "qq-main",
  "type": "onebot11-forward-websocket",
  "url": "ws://127.0.0.1:3001/",
  "groupId": "20002000",
  "commandPrefix": "/huanlink",
  "accessTokenEnv": "HUANLINK_ONEBOT_ACCESS_TOKEN"
}
```

该文件属于 Server。M1 仍只启用一个 QQ Channel，不提前实现 M4 的 Channel 管理界面。

### 4.3 通用 A2A 目标配置

```json
{
  "version": 1,
  "agentId": "codex-local",
  "displayName": "Codex Local",
  "transport": "a2a",
  "origin": "http://127.0.0.1:4000",
  "skillId": "codex-code-task",
  "enabled": true
}
```

Server 只理解上述发现和调用字段，不理解 Codex workspace、分支、可执行文件或模型规则。M1 只加载一个启用的代码任务目标；多个目标的发现和选择留给 M3。

### 4.4 Codex Adapter 运行配置

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 4000,
  "codexExecutable": "codex.cmd",
  "expectedCodexVersion": "0.144.1",
  "heartbeatIntervalMs": 30000
}
```

该文件属于 Adapter。`host` 只接受 `127.0.0.1`、`localhost` 或 `::1`。

### 4.5 Codex 项目配置

```json
{
  "version": 1,
  "projectId": "huanlink",
  "workspace": "D:\\CodingProject\\HuanLink",
  "branch": "dev/v1.0",
  "defaultModelId": "gpt-5.4-mini"
}
```

该文件属于 Adapter。任务只能提交稳定 `projectId`；绝对 `workspace` 只存在本机配置中，不能从 QQ、MainAgent 或 A2A 自然语言参数直接注入。

## 5. 协议中性 AgentCall 与 A2A 合同

M1 的最小 Core 目标形状为：

```ts
export type AgentCallTarget = {
  agentId: string;
  parameters?: Record<string, unknown>;
};
```

```ts
export type AgentCallRequest = {
  runId: RunId;
  sessionId: SessionId;
  skillId: string;
  input: string;
  executionMode: TaskExecutionMode;
  target: AgentCallTarget;
  contextId?: string;
  signal?: AbortSignal;
};
```

约束：

- `agentId` 写入 AgentCall 记录和关联日志，保证任务可审计。
- Core 只透传 `parameters`，不校验 `projectId`、`workingDirectory` 或 `modelId` 的业务语义。
- A2A integration 把 `parameters` 放入标准 Message metadata 或 data Part，不新增自定义传输协议。
- Codex Adapter 只接受以下任务参数：

```ts
type CodexTaskTarget = {
  projectId: string;
  workingDirectory?: string;
  modelId?: string;
};
```

- `workingDirectory` 必须是已注册 workspace 内已存在的相对目录，不能是绝对路径、UNC、盘符路径或包含解析后逃逸的 `..`。
- `workingDirectory` 是工作焦点，不是文件修改硬边界；Artifact 继续如实报告实际变更、diff 和验证。
- `modelId` 只影响 Codex Adapter；MainAgent 模型不会被隐式覆盖。

## 6. 仅流式 A2A 与长任务连接合同

### 6.1 能力和状态

- Agent Card 协议版本、目标 skill 和 `capabilities.streaming` 在任务受理前校验。
- Agent 必须返回 Task-backed 结果；只返回普通 Message 视为协议不兼容。
- 流式订阅负责接收状态变化；`GetTask` 负责断线对账和取得包含 Artifact 的权威终态快照。
- 重复的非终态事件允许被覆盖；终态只向 HuanLink 生命周期提交一次。
- `input-required` / `auth-required` 是暂停态，不被当作失败或完成。

### 6.2 超时、心跳和失联

- `bodyTimeout: 0` 只用于 SSE 流请求，取消底层“响应体数据块静默五分钟即失败”的通用规则。
- Adapter 继续每 30 秒发送 SSE 注释心跳，并在响应 `close` / `finish` 时清理定时器。
- 普通 Agent Card、提交、查询、继续和取消请求保留有限请求超时。
- 应用层活性计时收到任意 SSE 字节后续期；超过失联窗口时主动 abort 当前订阅，然后执行 `GetTask` 对账和重订阅。
- 第三方 A2A Agent 若不发心跳且长时间无业务事件，可能发生周期性重连；这属于观察链路维护，不能改变远端任务状态。
- 调用方取消、HuanLink 关闭或明确协议错误可以终止 watcher；单次网络错误不可以。

### 6.3 对账和重试

- SSE 明确断开、应用层活性 abort、收到终态事件或订阅在终态前结束后，都先执行 `GetTask`。
- `GetTask` 的瞬时网络异常进入同一可取消、退避状态机；成功取得快照后再决定终态、暂停或重订阅。
- 明确的协议不兼容、远端认证/权限拒绝、调用方 abort 可以直接结束。
- 日志至少区分 `stream_failed`、`reconcile_failed`、`reconciled`、`retry` 和 `aborted`，并安全提取嵌套网络错误码，不记录响应体或秘密。

## 7. 并发、取消、不可用与内存边界

### 7.1 同 workspace 修改互斥

推荐默认规则：Adapter 以解析后的 canonical workspace 为锁键；已有活动修改任务时，新任务在创建 Codex turn 前进入 A2A `rejected`，错误说明已有任务 ID。M1 不实现排队、公平性、优先级或跨进程锁。

锁在 `completed / failed / canceled / rejected` 后释放；`input-required` 仍持有锁，因为原任务可能继续修改同一 workspace。

### 7.2 取消与 app-server 不可用

- 已取得 `turnId`：调用 Codex `turn/interrupt`，等待真实终态；不能伪造 canceled。
- 尚未取得 `turnId`：取消等待必须有界；超时后关闭失效 client，并把任务置为解释清楚的失败状态。
- app-server 运行中断开后，Adapter 进入 `unavailable`，拒绝创建新 A2A Task；M1 依靠进程管理器重启，不在进程内恢复原 turn。

### 7.3 内存状态

Adapter 的 TaskStore、任务执行映射和 HuanLink AgentCall 状态在 M1 仍可使用内存实现。进程重启后旧 taskId 不保证可查询；M1 不声称重启恢复、持久消费或 exactly-once。

## 8. 渐进实施批次

### M1-B01：观察连接失败不误判远端任务失败

**目标：** 订阅断开后，即使第一次或多次 `GetTask` 瞬时网络失败，watcher 仍可取消地退避、重新对账，并最终取得带 Artifact 的终态。

**Files:**

- Modify: `packages/integrations/a2a-client/tests/a2a-agent-call-transport.test.ts`
- Modify: `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts`

- [x] **Step 1: 写失败测试**

  新增用例：第一次订阅抛出 `TypeError("terminated")`，紧随其后的 `GetTask` 抛出 `TypeError("fetch failed")`；下一次对账返回 `completed` 和 Artifact。断言 watcher 最终 fulfilled、没有 `a2a.watch.failed`，并记录一次安全的 `a2a.watch.reconcile_failed`。

- [x] **Step 2: 运行测试并确认按预期失败**

  ```powershell
  corepack.cmd pnpm --filter @huanlink/integration-a2a-client test -- a2a-agent-call-transport.test.ts
  ```

  预期：新增用例因第一次 `GetTask` 异常直接冒出而失败。

- [x] **Step 3: 写最小实现**

  只在 watcher 的对账边界处理可重试观察错误：调用方 abort 立即抛出；`A2aProtocolError` 等明确协议错误仍失败；`TypeError` 或 cause 链中的已知网络错误码记录安全日志、执行现有退避并进入下一次订阅/对账。不得修改任务状态、Artifact 映射或提交/取消语义。

- [x] **Step 4: 局部验证**

  ```powershell
  corepack.cmd pnpm --filter @huanlink/integration-a2a-client test
  corepack.cmd pnpm --filter @huanlink/integration-a2a-client typecheck
  ```

**实际结果：** 初始 RED 为 15 项中新增用例 1 项按预期失败，失败值是对账阶段直接冒出的 `TypeError("fetch failed")`。质量审查后将回归扩展为连续多次网络失败恢复、非网络 `TypeError` 不重试、退避期间 abort 和日志不含原始错误文本；最终包级测试 17/17 通过、包级 typecheck 通过、`git diff --check` 通过。规格审查和代码质量复审均通过。文档提交 `c0eaecb` 与代码提交 `94a0a08` 已分别推送到 `origin/dev/v1.0`，未 merge `main`。

### M1-B01R：A2A Client 内部职责拆分（纯重构）

**目标：** 在不改变公共 API、协议语义、日志字段或 watch/对账时序的前提下，从 `a2a-agent-call-transport.ts` 下沉纯任务快照映射和错误处理，降低后续 M1-B03、M1-B06 修改同一大文件的冲突与审查成本。

**Files:**

- Create: `packages/integrations/a2a-client/src/a2a-task-snapshot.ts`
- Create: `packages/integrations/a2a-client/src/a2a-transport-errors.ts`
- Modify: `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts`
- Modify: `docs/dev/D09-huanlink-v1-m1-local-configuration-plan.md`

**拆分边界：**

- `a2a-task-snapshot.ts` 只拥有 A2A `Task`、`Artifact`、`Message` 到 Core snapshot 的纯映射，以及任务状态的终态/暂停态判断；不得依赖 Client、logger 或 transport。
- `a2a-transport-errors.ts` 只拥有唯一的 `A2aProtocolError`、安全日志字段提取、cause 链检查、网络错误重试判断和 SDK 错误识别；不得依赖 transport 或 snapshot。
- `a2a-agent-call-transport.ts` 继续作为唯一公开适配器，保留 Client 缓存与重建、discover/submit/continue/cancel、watch/reconcile、退避等待、任务 ID 校验和日志事件顺序。
- 不新增公共导出，不拆 watcher 类，不改变错误白名单、问题解析、Artifact 映射、重试次数、延迟或 abort 行为。

**验收：**

```powershell
git diff --check
corepack.cmd pnpm --filter @huanlink/integration-a2a-client test -- a2a-agent-call-transport.test.ts
corepack.cmd pnpm --filter @huanlink/integration-a2a-client typecheck
corepack.cmd pnpm --filter @huanlink/integration-a2a-client build
```

现有 17 项黑盒测试必须原样通过，`src/index.ts` 公共导出保持不变；本批只做机械迁移，独立 review 后再报告并等待 commit/push 确认。

**实际结果：** 主文件从 775 个物理行降至 491 行；新增的 snapshot 和 errors 内部模块分别为 161、145 行。主类、watch/reconcile 状态机、测试文件和 `src/index.ts` 均未发生行为或公共导出修改。两次独立只读 review 均未发现 Critical、Important 或 Minor 问题；最终包级测试 17/17 通过、typecheck 通过、build 通过、`git diff --check` 通过。本批必须按文档与代码分开提交，并且只推送到 `dev/v1.0`；未经确认不 merge `main`。

### M1-B02：模块化本地配置合同

**目标：** 建立第 4 节的多 JSON 目录、版本字段、文件级错误和秘密引用规则；先冻结合同，不切换真实启动入口。

**Files:**

- Create: `configs/examples/server/main-agent.json`
- Create: `configs/examples/server/channels/onebot11.json`
- Create: `configs/examples/server/agents/codex-local.json`
- Create: `configs/examples/codex-adapter/runtime.json`
- Create: `configs/examples/codex-adapter/projects/huanlink.json`
- Create: `apps/server/src/local-user-config.ts`
- Create: `apps/server/tests/local-user-config.test.ts`
- Modify: `apps/codex-a2a-adapter/src/runtime-config.ts`
- Modify: `apps/codex-a2a-adapter/tests/runtime-config.test.ts`
- Modify: `apps/codex-a2a-adapter/package.json`
- Modify: `pnpm-lock.yaml`

**合同冻结：**

- `loadServerLocalUserConfig` 和 `loadCodexAdapterLocalConfig` 默认从 `<cwd>/.huanlink/config/` 读取，并允许测试注入显式配置根；B02 不接入 `main.ts`，不监听或热更新。
- 信任锚边界固定为：显式 `configRoot` 本身是调用方信任锚点，只校验根自身及根内路径；默认路径以 `cwd` 为信任锚点，逐段拒绝 `.huanlink`、`config` 及配置树内的符号链接或目录 junction，但不审计 `cwd`、卷根或更高祖先目录。
- `server/main-agent.json` 与 `codex-adapter/runtime.json` 是固定必需文件；`channels/`、`agents/`、`projects/` 各自至少包含一个当前目录的常规 `*.json` 文件。目录只扫描一层、按文件名字典序读取、不递归且不跟随符号链接；其他扩展名不参与配置发现。
- 所有 JSON 必须是 UTF-8 对象、`version` 严格等于 `1`、拒绝未知字段；字符串字段读取时 trim 后不得为空。`channelId`、`agentId`、`projectId` 在各自集合内唯一，并使用字母或数字开头、随后只含字母、数字、点、下划线或连字符的稳定 ID 格式。
- `apiKeyEnv` 和可选 `accessTokenEnv` 只保存环境变量名；名称必须是合法环境变量标识符。只要声明引用，对应值缺失或 trim 后为空即报错；异常不得包含秘密值、原始 JSON、`.env` 内容或底层 JSON 解析消息。
- Server 只读取 `server/**` 并返回 MainAgent、Channel 和通用 A2A 目标配置；Adapter 只读取 `codex-adapter/**` 并返回 runtime 和项目列表。B02 允许解析多个静态文件并检查重复 ID，不做多个目标选择或路由。
- A2A `origin` 必须使用 HTTP(S) 且 host 为 `127.0.0.1`、`localhost` 或 `::1`。项目 `workspace` 本批只验证为绝对路径；路径存在性、canonical workspace、Git 分支、任务 `workingDirectory` 和模型覆盖留给 M1-B03。
- Adapter 必须直接声明与 Server 相同主版本的 Zod 依赖，不能依赖 SDK 的传递依赖。

测试覆盖：逐文件 schema、固定文件/目录缺失、空目录、损坏 JSON、重复稳定 ID、loopback origin、绝对 workspace、密钥环境变量缺失以及错误信息不泄密。解析器只返回本进程拥有的配置，不让 Server 解析 Codex 项目内容。

**实际结果：** Server 与 Codex Adapter 已分别新增进程自有的本地配置加载器，并新增同形状的 5 份脱敏示例；Adapter 已直接声明 `zod@^4.4.3`。两侧加载器均默认读取 `<cwd>/.huanlink/config/`，实现严格 UTF-8、对象与 `version: 1` schema、稳定 ID、字典序单层发现、符号链接/目录 junction 拒绝、文件级安全错误和秘密不回显；真实 `main.ts` 启动入口未接入，项目存在性、canonical workspace、Git 分支及任务目标解析仍留在 B03。TDD 期间先后捕获并修复了非法 UTF-8 替换解码、显式配置根本身、默认 `.huanlink` 段与配置树内父目录的链接逃逸、秘密值被错误 trim、重复 `projectId` 未定位具体文件等问题；规格审查与代码质量复审最终均无阻断项。最终 Server 测试 98 项通过、1 项跳过，Adapter 测试 112 项通过、1 项跳过；两个跳过均因当前 Windows 无权限创建文件符号链接，默认 `.huanlink`、配置根与树内目录 junction 拒绝用例实际执行并通过。最终仓库级测试共 37 个测试文件、457 项通过、2 项跳过；此前一次仓库并发回归曾出现既有 Codex app-server `initialize` 的 2 秒瞬时超时，隔离用例 9/9、Adapter 全包及后续仓库级复验均通过，未为此修改无关超时逻辑。仓库级 typecheck、build、5 份示例 JSON 解析和 `git diff --check` 均通过。文档先行提交；代码、测试、示例配置和依赖改动仍未 commit/push，需在用户确认后另行提交，并且只推送到 `dev/v1.0`。

### M1-B03：Codex 项目注册和任务目标校验

**目标：** Adapter 根据 `projectId` 解析 workspace/branch/defaultModelId，并校验可选工作目录和模型覆盖；任务不能传任意绝对 workspace。

**主要文件:**

- `packages/core/src/agent-call/types.ts`
- `packages/core/tests/agent-call-service.test.ts`
- `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts`
- `packages/integrations/a2a-client/tests/a2a-agent-call-transport.test.ts`
- `apps/codex-a2a-adapter/src/runtime-config.ts`
- `apps/codex-a2a-adapter/src/workspace-guard.ts`
- `apps/codex-a2a-adapter/src/codex-task-executor.ts`
- 对应 Adapter 测试

验收：目标参数通过标准 A2A Message 透传；已注册项目可受理；未知项目、路径逃逸、错误分支或空模型在创建 Codex turn 前明确拒绝。

### M1-B04：Server 配置接入与通用单一 A2A 目标

**目标：** Server 启动时从模块化配置读取 Channel、MainAgent 和一个通用 A2A 目标；移除固定 Codex 变量名，但不实现多个 Agent 的能力选择。

**主要文件:**

- `apps/server/src/runtime-config.ts`
- `apps/server/src/main.ts`
- `apps/server/src/phase3-runtime.ts`
- `apps/server/src/phase4-qq-runtime.ts`
- `apps/server/src/main-agent-runtime.ts`
- `packages/integrations/openai-agents/src/agent-call-tool.ts`
- 对应 Server / integration 测试

验收：稳定 `agentId` 贯穿 AgentCall 记录和日志；MainAgent 模型与 Codex `modelId` 独立；非流式、错误协议版本、缺失 skill 和非 loopback origin 在启动或首次受理前给出明确错误。

### M1-B05：同 workspace 最小并发保护

**目标：** 按第 2.2 节的单项确认结果实现立即拒绝或简单队列；推荐并默认计划为立即拒绝。

**主要文件:**

- `apps/codex-a2a-adapter/src/codex-task-executor.ts`
- `apps/codex-a2a-adapter/tests/codex-task-executor.test.ts`
- `apps/codex-a2a-adapter/tests/task-lifecycle.test.ts`

验收：同 workspace 的第二个修改任务不能同时创建 turn；不同 workspace 不互相阻塞；暂停任务继续占用锁；所有终态都可靠释放锁。

### M1-B06：SSE 专用传输与活性策略

**目标：** 把 `bodyTimeout: 0` 限定在 SSE 请求，保留普通请求超时，并用可测试的应用层活性 abort → 对账 → 重订阅替代底层五分钟误失败。

**主要文件:**

- `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts`
- `packages/integrations/a2a-client/tests/a2a-agent-call-transport.test.ts`
- `apps/codex-a2a-adapter/src/server.ts`
- `apps/codex-a2a-adapter/tests/task-lifecycle.test.ts`

验收：长静默任务不会变成本地失败；丢失心跳可触发恢复；普通 HTTP 请求仍有界；关闭/取消能释放流、socket 和心跳 timer。

### M1-B07：Adapter 生命周期窄补口

**目标：** app-server 失效后拒绝新任务；取得 `turnId` 前的取消等待有界；补充嵌套网络错误码诊断和进程期内存边界说明。

**主要文件:**

- `apps/codex-a2a-adapter/src/codex-task-executor.ts`
- `apps/codex-a2a-adapter/tests/codex-task-executor.test.ts`
- `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts`
- 对应测试和运行说明

不在本批加入自动 app-server 重启、任务恢复、数据库或复杂 TaskStore 淘汰器。

### M1-B08：Demo 命名收敛、全链路复验与实施记录

**目标：** 只移除仍阻碍 M1 产品配置的 `phase3` / `phase4` 和固定 Codex 装配命名，运行完整验证和真实闭环，不做独立重写。

验证顺序：

```powershell
corepack.cmd pnpm test
corepack.cmd pnpm typecheck
corepack.cmd pnpm build
```

随后使用至少两个已注册项目配置或两个受控项目 fixture 验证配置切换，并执行一次真实 QQ → MainAgent → A2A → Codex → Artifact → 原会话回流 smoke。日志必须能关联 `sessionId`、HuanLink `agentCallId`、稳定 `agentId` 和外部 A2A taskId。

## 9. M1 总体验收目标

M1 只有同时满足以下条件才可以报告完成：

- 用户无需修改 TypeScript 源码即可切换已注册项目、工作目录和 Codex 模型。
- MainAgent 模型配置不会覆盖外部 Agent 模型。
- Server 只保存通用 A2A 目标信息；Codex Adapter 独立验证项目、路径、分支和模型。
- 非流式 Agent、无效配置、未知项目、路径逃逸、并发冲突和 app-server 不可用都有明确错误。
- 长任务不会因响应体静默五分钟被本地误判失败；断流与瞬时对账错误可以恢复。
- 原有 AgentCall async/blocking、状态查询、取消、input-required、Artifact 和终态回流回归通过。
- package tests、typecheck、build 通过；真实 QQ/A2A/Codex smoke 和关联日志提供闭环证据。
- 文档明确说明内存状态、重启不恢复、无分布式 exactly-once、无自动 Git 操作。

## 10. 提交与发布计划

M1 完成并经用户确认后，至少拆成两个提交：

```text
docs(m1): 编写本地单用户配置化实施计划
feat(m1): 建立本地单用户配置化基线
```

如果代码规模要求按职责拆分多个代码提交，仍保持文档提交独立，并遵守 `<type>(<scope>): <中文说明>`。确认后只 push `dev/v1.0`；不 merge 到 `main`。
