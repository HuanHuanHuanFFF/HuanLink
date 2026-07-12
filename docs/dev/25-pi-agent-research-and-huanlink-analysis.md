# 25. Pi Agent 调查与 HuanLink 借鉴分析

> **文档性质：动态调查草案，不是冻结架构。** 本文基于 2026-07-12 的仓库状态和资料快照，目的是服务 HuanLink 当前 Demo-first 节奏。后续真实群聊、A2A 和框架接入暴露新问题时，应允许调整结论。
>
> **证据标记：**“事实”表示可以由源码或官方文档直接确认；“社区观点”表示作者或用户的经验判断；“建议”表示结合 HuanLink 当前状态作出的设计判断。

## 调查范围与当前基线

- HuanLink 基线：`spike/demo-v0` 分支，已提交到 `f159f97`。Phase 1/2 已完成标准 A2A Server、真实 Codex `app-server` 接入、任务流式状态、取消和结果 Artifact；当前工作区还在推进 Phase 3 的协议无关 `AgentCallService`，该部分尚未作为已完成能力计算。
- Pi 基线：官方仓库已从 `badlogic/pi-mono` 迁移到 [`earendil-works/pi`](https://github.com/earendil-works/pi)，本次源码快照为 `8479bd84743e8889f728acb21a62794102db0529`（2026-07-11），主要包版本为 `0.80.6`。
- OpenClaw 关系：当前 OpenClaw 已直接拥有内建 Agent Runtime，只继续依赖 `@earendil-works/pi-tui`。因此本文不再把“OpenClaw 使用 Pi Agent Core”当作当前事实；历史文章中的关系只能代表当时状态。
- 非目标：不建议用 Pi 替换 OpenAI Agents JS，不重新设计 HuanLink 通用 Agent Loop，不修改业务代码，也不把 Pi 的本地 Coding Agent 权限模型照搬到群聊系统。

## 1. 调查结论

1. **Pi 最值得学习的不是某个功能，而是边界管理。** `pi-agent-core` 只负责一次模型/工具循环及可观察事件；会话树、压缩、资源加载、扩展、RPC 和 UI 都在更高层。这种小核心让不同宿主可以复用同一执行语义，但宿主必须自己承担持久化、安全和产品工作流。
2. **HuanLink 不应引入 Pi Agent Core 作为第二套 Agent Runtime。** 单次 MainAgent Run 已决定交给成熟框架，Codex 也由 `app-server` 驱动。再接 Pi Core 会制造 OpenAI Agents JS、Codex Runtime、Pi Runtime 三套执行语义。应借鉴接口和事件思想，不复用其 Loop 实现。
3. **Pi 的事件模型适合启发 HuanLink 的 Adapter 事件桥，但不能替代 HuanLink EventLog。** Pi 的 `turn/message/tool` 事件描述单个 Agent Run；HuanLink 还必须记录 `AgentCallId <-> A2A taskId`、远端状态、重新进入 MainAgent、群聊来源、审批与策略结果。
4. **Pi 的 Session Tree 是很好的“可追溯会话”模型，但不是 HuanLink 当前 P0 的存储模板。** Pi 用 append-only JSONL 保存完整分支历史，并从当前叶节点重建上下文；HuanLink 当前更需要先跑通跨 Agent 任务链路，不需要马上实现通用分支、回退和跨进程恢复。
5. **Context Manifest 比复制 Pi 的 Prompt Builder 更适合 HuanLink。** Pi 证明了“上下文是动态装配结果，而非完整聊天历史”；HuanLink 应逐步记录任务输入来自哪个群聊快照、Artifact、AgentCall 结果和固定事实，但 P0 只需要最小来源引用，不需要自研压缩器。
6. **Skills 的渐进披露值得借鉴。** Pi 默认只把 Skill 的名称、描述和路径放入系统提示词，需要时再读取正文。这能减少上下文膨胀。HuanLink 的垂类 Agent 能力发现也应先暴露能力摘要，再通过 A2A Agent Card、Skill 或 Artifact 按需取详细内容。
7. **Pi Extension 是受信任的进程内代码，不等同于 MCP 或 A2A。** 它几乎能影响 Loop 的每个阶段，也能覆盖内建工具；灵活性很高，但不适合在多人群聊中动态加载。HuanLink P0 只需要静态 Adapter/Hook 注册，不需要通用热加载插件系统。
8. **Pi 的 Provider 抽象不应被直接复刻。** 它对模型目录、能力差异、流式协议、Tool Call ID、思维签名和用量成本处理得很完整；但 HuanLink 已倾向用 Vercel AI SDK 和 Agent 框架做模型适配。应只学习“稳定模型键 + 能力描述 + 请求时凭据 + 用量事件”。
9. **Pi 没有把 Sub-agent 放进核心是有意的可观察性取舍。** 社区示例通过独立 `pi` 子进程实现并行或链式任务，但缺少标准任务协议、持久恢复和清晰的上下文契约。HuanLink 已完成的标准 A2A Codex Adapter 正好补上这些不足，不应退回到“启动子 CLI、抓 stdout”的委派方式。
10. **当前没有必须推翻 Demo 架构的问题。** 近期真正需要补的是外层任务事件的关联语义、Artifact 边界、执行实例退出原因和一写者约束；数据库、通用 Session Tree、自研 Compaction、动态 Extension 都不应阻塞 Phase 3/4。

## 2. Pi 的核心设计哲学

### 2.1 小核心到底有多小

Pi 的低层核心 [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/src/agent-loop.ts) 主要保留：

- 接收 Agent 状态和新消息；
- 调用模型流；
- 解析 Tool Call，校验参数并执行工具；
- 把 Tool Result 作为消息放回上下文；
- 处理 steering、follow-up、终止和取消；
- 向上层发出生命周期事件。

它不直接负责：

- 会话文件、分支和恢复；
- Coding Agent 的系统提示词和项目文件发现；
- Skill、Extension、命令、主题和 TUI；
- 权限审批、Sandbox 和身份；
- 多 Agent 调度；
- 业务级 Task、A2A、Artifact 和远端恢复。

### 2.2 解决的问题

**事实：**Core 使用内部统一的 `AgentMessage[]`，只在 Provider 边界转换为模型消息；它把执行过程暴露为事件流，而不是把 CLI/UI 写进 Loop。[`types.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/src/types.ts)

这种设计带来四个直接收益：

1. 同一个 Loop 能被 CLI、SDK、RPC 或测试宿主复用。
2. 工具和模型实现可以替换，而不改变会话与 UI。
3. 上层能观察模型流和工具状态，不必解析终端文本。
4. 新能力优先放在 Extension 或 Coding Agent 层，避免核心不断膨胀。

### 2.3 代价和边界

- Core 不提供完整产品安全边界，宿主必须补 Policy、Approval 和 Sandbox。
- 可扩展点很多，扩展组合后实际行为可能比“小核心”本身复杂。
- Session、Extension、Provider 和 UI 分散在多个包，二次开发者仍需理解整套调用关系。
- 小核心不等于运行时功能少。Coding Agent 的 `AgentSession`、SessionManager、ResourceLoader 和 ExtensionRunner 共同形成了一个并不轻的产品 Runtime。
- 官方 `agent-harness.md`、`durable-harness.md` 和 `observability.md` 包含新的 Harness 方向，其中一部分仍是设计目标，不应全部当成已经稳定落地的 API。

**对 HuanLink 的含义：**“小核心”应表现为清晰的所有权，而不是再次自研一个小 Loop。HuanLink 的小核心是 AgentCall/A2A、异步任务和群聊外层调度；框架内部 Tool Loop 仍由框架拥有。

## 3. Pi 架构拆解

### 3.1 模块边界

| 模块 | 主要职责 | 不负责什么 | 对 HuanLink 的意义 |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai` | Provider、模型目录、认证、流式响应、消息兼容转换、Token/成本信息 | Agent Loop、Session、UI | 学习能力描述和统一模型键，不直接复制 |
| `@earendil-works/pi-agent-core` | Agent 状态、Loop、工具协议、事件流、steering/follow-up | 文件会话、Coding Prompt、Extension、权限 | 学习框架 Adapter 应暴露的最小事件和状态 |
| `@earendil-works/pi-coding-agent` | `AgentSession`、SessionManager、Compaction、Skills、Extensions、Coding Tools、SDK、RPC、CLI/TUI | 标准 A2A、多租户安全、分布式恢复 | 主要研究对象，但不能当成群聊服务模板 |
| `@earendil-works/pi-tui` | 终端 UI、增量渲染和交互组件 | Agent 语义 | HuanLink 无需引入 |
| `@earendil-works/pi-orchestrator` | 实验性的多 Pi 进程监督、RPC 桥接和实例状态 | 成熟 Agent Router、持久任务恢复 | 可参考进程状态，不作为依赖 |

Pi Coding Agent 提供五种宿主形态：交互 CLI、一次性 print、JSON 事件输出、RPC 进程和进程内 SDK。官方文档明确建议同一 TypeScript 进程优先使用 `AgentSession` SDK，需要进程隔离或跨语言时才使用 JSONL RPC。[SDK 文档](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/docs/sdk.md) [RPC 文档](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/docs/rpc.md)

### 3.2 Agent Loop 与工具执行

核心流程可简化为：

```text
agentLoop(initialMessages)
  -> emit agent_start
  -> outer loop: 处理 follow-up
     -> inner loop: 模型调用、工具和 steering
        -> emit turn_start
        -> 注入待处理消息
        -> transformContext(messages)
        -> convertToLlm(messages)
        -> streamFn(modelRequest)
        -> emit message_start/update/end
        -> 从最终 assistant message 读取 toolCalls
        -> prepareArguments + schema validation
        -> beforeToolCall
        -> execute(signal, onUpdate)
        -> afterToolCall
        -> 生成 toolResult message
        -> emit tool_execution_start/update/end
        -> emit turn_end
        -> prepareNextTurn
        -> 判断 stop / steering / cancellation
     -> 若有 follow-up，开启下一轮
  -> emit agent_end
```

#### 工具执行细节

| 问题 | Pi 做法 | 适用边界 |
| --- | --- | --- |
| 参数兼容 | 先执行工具的 `prepareArguments`，再做 schema validation | 适合 Provider 产生轻微格式差异时修正参数 |
| 工具不存在 | 生成错误 Tool Result，不让整个进程崩溃 | 上层仍能看到结构化失败 |
| Tool Call 被截断 | 模型 `stopReason=length` 时把调用标记失败，不执行不完整参数 | 防止半截 JSON 触发危险操作 |
| 前置拦截 | `beforeToolCall` 可以阻止执行 | Pi Extension hook，不是完整 Policy 系统 |
| 并行策略 | 工具声明 `executionMode`；先完成 preflight，再按顺序或并行执行 | 并行文件修改仍可能竞争 |
| 增量状态 | 工具通过 `onUpdate` 发出 `tool_execution_update` | 很适合转换为任务进度事件 |
| 取消 | `AbortSignal` 传到模型流和工具 | 工具实现必须真正响应 signal |
| 错误 | 工具抛错转成 `isError` Tool Result；普通模型错误由最终 assistant 的 stop reason 表达 | 便于保持事件流完整 |
| 后置修改 | `afterToolCall` 可改写内容、details、错误标记和 terminate | 权力很大，只适合受信任扩展 |
| 终止 | 结果可声明 `terminate`，并结合整批工具结果决定是否继续 | 是单次 Run 内控制，不是远端 Task 终态 |

#### 与 HuanLink Task 的映射

Pi 的 Tool Call 生命周期和 HuanLink AgentCall 生命周期不是同一层：

```text
Pi/OpenAI tool call        HuanLink AgentCall/A2A Task
----------------------     ---------------------------------
一次 Run 内部动作          可跨进程、跨平台、跨多个 MainAgent turn
toolCallId                 agentCallId + remote taskId
Tool Result                Task Snapshot + Artifact
AbortSignal                CancelTask + 本地 watcher 取消
tool update                A2A status update / progress event
Loop 继续推理              任务终态后创建新的 MainAgent run
```

**建议：**当前 `AgentCallService` 把远端 Transport、双向 ID、watcher、终态去重和 listener 放在 Core，是正确的外层抽象。不要把 AgentCall 伪装成一个必须等待最终 Tool Result 的普通工具；提交工具只返回 accepted receipt，终态由新 turn 消费。

### 3.3 Session、事件记录与状态恢复

#### 文件形态

Pi Coding Agent 默认把会话保存在：

```text
~/.pi/agent/sessions/--<working-directory>--/<timestamp>_<uuid>.jsonl
```

文件由一个 header 和 append-only entries 构成。Entry 通过 `id`、`parentId` 形成树，而不是只能形成线性消息列表。[`session-manager.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/session-manager.ts)

主要 Entry 包含：

- user、assistant、tool 和 custom message；
- model、thinking level、active tools 变化；
- compaction 和 branch summary；
- extension custom data、label、session info；
- 当前 leaf 指针。

#### 会话树和恢复

- 当前上下文不是读取全文件，而是从 active leaf 沿 parent 链回溯，再应用 compaction entry。
- 旧分支、压缩前历史和放弃的路径仍留在 JSONL 中。
- 分支或回退只是切换叶节点；必要时写 Branch Summary 帮助新分支理解被放弃路径。
- RPC 的 `get_entries(since)` 使用稳定 Entry ID 作为游标，适合增量同步；`get_messages` 只返回当前重建后的模型消息。

#### 运行时状态与持久状态

`AgentSession` 的内存状态还包含当前模型流、pending tool calls、steering/follow-up 队列、重试、压缩任务、扩展上下文和 AbortController。这些状态不是全部可由 JSONL 恢复。

Pi 新的 [`durable-harness.md`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/docs/durable-harness.md) 明确把目标限定为“从 durable boundary 重新开始”，而不是恢复 Provider 的半截 stream。Host 仍要重新创建模型、工具、扩展和认证；非幂等工具调用不能无脑自动重试。这是设计方向，不是当前 Coding Agent 已具备的完整分布式恢复能力。

#### 对 HuanLink 的启发

1. EventLog 和运行时 Map 必须明确区分。当前 Codex Adapter 的 in-flight、thread 映射和 subscription 是运行时状态，不应因为已有 JSONL 就宣称可恢复。
2. Durable boundary 应落在明确的业务状态：AgentCall 已受理、远端 Task 终态、Artifact 已登记、MainAgent re-entry 已安排。
3. 一次远端 AgentCall 若状态不明，不应自动重新提交，除非具有幂等键并能先查询远端任务。
4. Pi 的 SessionManager 依赖单进程所有权并直接 append JSONL，没有跨进程文件锁。HuanLink P0 也应优先保证“一个 run/event file 只有一个 writer”，而不是先加复杂锁。
5. Session Tree 可在未来服务“从某次群聊决策创建替代分支”，但当前 Demo 不需要。

### 3.4 Context Engineering 与 Compaction

#### 系统上下文如何装配

Pi 的 [`buildSystemPrompt`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/system-prompt.ts) 会按运行时资源动态装配：

```text
基础 Coding Agent 指令
+ 当前启用工具及工具相关提示
+ 自定义/追加 system prompt
+ <project_context>
   - 全局 AGENTS.md / CLAUDE.md
   - 从项目根到 cwd 的祖先指令文件
+ 可用 Skill 的 name / description / path
+ 当前日期
+ 当前工作目录
```

Extension 还可以：

- 在 `before_agent_start` 增加消息或改系统提示词；
- 在每次模型调用前通过 `context` hook 对消息副本做临时转换；
- 在 Provider request hook 修改请求头或 payload。

这说明 Pi 的上下文分为至少三层：稳定系统规则、当前会话分支、每次调用前动态变换。最终 Provider 输入只是装配结果，不是唯一事实源。

#### Skills 的渐进披露

Pi 扫描全局和项目 Skill，但默认只把元数据写入系统提示词。模型需要某项能力时再用 `read` 读取 `SKILL.md`；显式 `/skill:name` 则把完整 Skill 展开成用户调用内容。[`skills.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/skills.ts)

这比把所有 Skill 正文永久塞入 system prompt 更节省 Token，也降低无关指令互相干扰。但 Skill 描述必须足够准确，否则模型不会主动加载。

#### Compaction 触发与内容

Pi 默认在：

```text
contextTokens > contextWindow - reserveTokens
```

时触发自动压缩。默认预留约 16K Token，并尽量保留最近约 20K Token。它从后向前寻找保留边界，避免留下无法对应的 Tool Result；若边界切在一个 turn 中间，会分别总结更早历史和当前 turn 前缀。[`compaction.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/compaction/compaction.ts)

摘要使用结构化章节：Goal、Constraints & Preferences、Progress、Key Decisions、Next Steps、Critical Context，并累计已读/已改文件。Compaction Entry 保存 `summary`、`firstKeptEntryId`、`tokensBefore` 和 details；原始历史不被删除。

重复压缩会把旧摘要和旧保留区一起纳入新摘要。2026 年的 [Issue #2608](https://github.com/earendil-works/pi/issues/2608) 曾暴露第二次压缩静默丢失信息的问题，现已关闭并在当前代码中专门处理边界。这证明压缩不是简单的“总结历史”，而是容易破坏状态连续性的算法。

#### HuanLink 的 Context Manifest

HuanLink 不应在 P0 自研 Pi 式通用 Compaction。更合适的最小方向是记录“本次任务看到了什么”：

- 群聊消息范围或 snapshot ID；
- 触发者、mention/reply 关系；
- AgentCall terminal snapshot；
- Artifact 引用，而不是把大文件正文复制进消息；
- 必须保留的约束和已确认事实；
- 由哪个框架/模型实际装配和压缩。

Manifest 的价值是可追踪、可重放和可重新装配，不是把最终 prompt 永久固化。真正的模型 Session 压缩仍交给 OpenAI Agents JS、Codex 或对应 Agent Runtime。

### 3.5 Skills、Extensions、Hook 与插件边界

| 机制 | Pi 中解决的问题 | 生命周期/状态 | 与 HuanLink 的关系 |
| --- | --- | --- | --- |
| Skill | 给模型可发现、按需读取的操作知识 | Markdown 资源，可来自全局、项目或 package | 类似能力说明，不是远端执行协议 |
| Tool | 模型可直接调用的执行能力 | 参数 schema、流式 update、result details | 普通同步 Tool 或 AgentCall 提交 Tool |
| Extension | 受信任进程内代码扩展 | 可注册工具、命令、Provider、UI、hook；可写 custom entry | 只适合静态可信 Adapter/Hook，不适合群成员上传 |
| Hook | 在 session/agent/turn/message/tool/provider/input 阶段观察或改写 | ExtensionRunner 调度，错误多数隔离 | 可启发外层事件桥和 Policy hook |
| MCP | 外部工具/资源协议 | 独立进程或远端服务 | Tool transport，不等于 Extension |
| A2A | Agent 能力发现和长任务协作 | Task、状态、Artifact、取消/订阅 | HuanLink 的核心跨平台边界 |

Extension 能影响的阶段非常广，包括项目信任、资源发现、session start/switch/fork/compact、agent/turn/message、context、provider request/response、tool call/result、模型切换和用户输入。[Extension 文档](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/docs/extensions.md)

扩展状态有两种典型保存方式：

- `pi.appendEntry()` 写入不进入模型上下文的 custom session entry；
- 工具结果 `details` 跟随消息树，天然分支感知。

Pi 当前快照没有自动 watch Extension 文件，官方使用文档要求通过 `/reload` 显式重载资源；reload 会关闭旧 Extension Runtime、重建资源并产生新的生命周期。早期 [Issue #645](https://github.com/earendil-works/pi/issues/645) 曾把 `--watch` 列入计划，但本次源码未发现该参数的实现，因此不能把 watch 当成现有能力，也不能确认最终未实现它的官方动机。

**HuanLink 最小方案：**当前只保留编译期/启动期注册的 `AgentAdapter`、`ChannelAdapter`、`Transport` 和少量只观察的 lifecycle subscriber。除非出现至少两个真实扩展需要共享生命周期，否则不设计通用 Extension SDK。

### 3.6 SDK 与 RPC

Pi 的 RPC 模式通过 stdin/stdout JSONL 发送命令和事件。`prompt` 的应答只表示请求已接受，真正结果继续通过 agent/message/tool 事件返回；RPC 也能桥接 confirm/select/input/editor 等 UI 请求。[`rpc-mode.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/modes/rpc/rpc-mode.ts)

对 HuanLink 最有价值的是两个工程约定：

1. **控制面应答与任务完成分离。** 这与当前 `AgentCallReceipt(status=accepted)` 完全一致。
2. **进程协议传结构化事件，不解析人类终端输出。** 当前 Codex Adapter 使用 `app-server` 而不是启动交互 CLI 抓文本，方向正确。

RPC 本身不是 A2A：它没有 Agent Card、标准 Task 状态、跨实现能力发现和 Artifact 语义。HuanLink 应继续把 Codex 私有 RPC 约束封装在 Adapter 内，对外只暴露 A2A。

### 3.7 多模型与 Provider 抽象

Pi 的 `Model` 数据不仅有 `provider/id`，还描述：

- API 类型和 Provider 兼容参数；
- 是否支持 reasoning、图片等输入；
- context window、max tokens；
- thinking level 映射；
- 输入/输出/缓存 Token 单价及用量。

Provider 在请求边界负责认证、模型列表和 stream；转换层还会归一 Tool Call ID、补齐缺失 Tool Result，并剥离其他 Provider 不接受的 reasoning/thought signature。[`pi-ai types.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/ai/src/types.ts) [`transform-messages.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/ai/src/api/transform-messages.ts)

模型切换时，Session 保留统一消息；新的 Provider 在边界重新转换。文本和标准 Tool Result 通常能继续使用，但 Provider 专属思维签名、缓存和元数据可能被丢弃或降级，因此“可切换”不等于无损。

**对 HuanLink 的建议：**

- 继续让 Vercel AI SDK/Agent 框架承担模型协议适配；
- HuanLink 的 Router 只消费统一的能力、成本、上下文窗口和健康状态；
- `provider/model` 使用稳定 ID，不把显示名称当主键；
- 凭据在请求时解析，不写入 Task、EventLog 或 Context Manifest；
- 路由决策写事件，便于解释“为什么把任务交给某模型/专业 Agent”。

### 3.8 多 Agent 与任务委派

Pi 作者早期明确选择不把 Sub-agent 放入核心，原因是子 Agent 会让执行过程难以观察和调试。[Mario Zechner 的设计文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

当前官方仓库提供的是示例 Extension，而非核心默认能力：

- 每个子任务启动独立 `pi --mode json -p --no-session` 进程；
- 支持单任务、最多 8 个并行任务、并发度 4 和链式执行；
- 子进程使用独立上下文，可指定 system prompt、tools 和 model；
- 向父 Agent 返回的文本限制约 50KB，保留 Token/成本统计；
- 取消时先发 SIGTERM，再在超时后 SIGKILL。

源码见 [`examples/extensions/subagent`](https://github.com/earendil-works/pi/tree/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/examples/extensions/subagent)。

它解决了“快速并行跑多个 Pi”的问题，但没有解决：

- 标准能力发现和协议协商；
- 可持久 Task ID 与断线重订阅；
- 跨平台状态机和 Artifact；
- 父子上下文的结构化 Manifest；
- 重启恢复、幂等提交和审批传递；
- 多 Agent 的统一 Trace。

实验性的 [`pi-orchestrator`](https://github.com/earendil-works/pi/tree/8479bd84743e8889f728acb21a62794102db0529/packages/orchestrator) 可以监督多个 Pi RPC 进程，记录 `starting/online/stopping/stopped/error`，并在异常退出时拒绝 pending request。但 README 明确警告它可能变化或被移除；重启后只把原 online 实例标成 stopped，不恢复任务。因此它是“进程管理实验”，不是成熟的 Agent 编排层。

**与 HuanLink 的互补：**Pi 擅长单 Agent 会话与本地执行；HuanLink 已用标准 A2A Task 包装 Codex，拥有跨平台 ID、状态、订阅、取消和 Artifact。HuanLink 可以学习 Pi 的子进程资源上限、取消升级和实例状态，但不应采用其临时子 Agent 文本协议。

### 3.9 可观察性与人类介入

Pi Core 暴露：

```text
agent_start / agent_end
turn_start / turn_end
message_start / message_update / message_end
tool_execution_start / tool_execution_update / tool_execution_end
```

Coding Agent 在其上继续提供 session、compaction、retry、model change、extension 和 UI 事件。用户可以：

- steering：当前 assistant turn/tool batch 结束后，在下一次模型调用前插入方向修正；
- follow-up：Agent 原本将结束时再追加任务；
- abort：取消当前模型/工具执行；
- 通过 RPC/Extension UI 回答 confirm、select、input 和 editor 请求；
- 切换模型、分支、回退或手动压缩。

`agent_settled` 比一次 `agent_end` 更接近“真正空闲”：它会等待 retry、compaction 和 post-run 工作完成。[`agent-session.ts`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/agent-session.ts)

Pi 的新 [`observability.md`](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/docs/observability.md) 提议 vendor-neutral trace/span 事件、外接 OpenTelemetry/Sentry，并强调默认只记录安全元数据，prompt、tool args、headers 不应默认进入遥测。但当前仓库并没有可视为稳定成品的独立 observability package，本文只把它当作设计方向。

HuanLink 映射建议：

| Pi 交互 | HuanLink 外层语义 |
| --- | --- |
| tool update | A2A Task progress / 群聊低频进度通知 |
| steering | 对运行中 AgentCall 的补充消息或新任务修正，需保留 actor/provenance |
| abort | CancelTask + Adapter 内部取消 |
| confirm/select | `input-required` / `auth-required` + Approval 记录 |
| agent settled | Task terminal 后 Artifact 已落定且 re-entry 已安排 |
| trace/span | runId、agentCallId、taskId、contextId、threadId、turnId 关联 |

### 3.10 安全与权限

Pi 官方 README 明确说明它没有内建权限系统，进程拥有启动用户的全部文件、Shell、网络、凭据和进程权限。官方推荐需要隔离时使用 Docker、OpenShell、Gondolin 等外部 Sandbox。[Security 说明](https://github.com/earendil-works/pi#security)

Project Trust 只控制是否加载项目本地 Extension、Skill、prompt template 和设置，不是操作级 Sandbox。并且项目指令文件可能在未信任项目中仍进入上下文，因此它不能防止 prompt injection。

Pi 对个人本地 Coding Agent 合理、但不适合群聊多用户系统的默认包括：

- Bash、文件和网络工具继承用户全部权限；
- Extension 是可执行 TS，可覆盖内建工具；
- 凭据位于本地运行环境，模型工具可能间接接触；
- 没有按群成员、频道、Agent 或项目划分 Policy；
- 没有统一危险操作审批和审计中心。

HuanLink 当前已有的 workspace Git root/branch guard、loopback 绑定、无自动 commit/merge/push 都应保留。后续安全边界至少需要：

```text
actor/principal
-> channel/project/agent scope
-> requested capability
-> Policy decision
-> optional Approval
-> Adapter/Sandbox execution
-> immutable audit event
```

P0 不必完成通用 Policy DSL，但任何群聊触发的代码 AgentCall 都不能只依赖模型自行判断权限。动态加载群成员提供的 Skill/Extension 应明确禁止。

## 4. 社区为什么学习 Pi

### 4.1 被反复称赞的设计

| 来源 | 观点 | 可信边界 |
| --- | --- | --- |
| [Mario Zechner：What I learned building Pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) | 上下文工程比堆叠功能重要；最小提示词、最小工具集、多模型和透明执行更容易调试 | 作者直接说明，适合解释设计动机 |
| [Armin Ronacher：Agentic Coding Recommendations](https://lucumr.pocoo.org/2026/1/31/pi/) | 赞赏可扩展、小核心、工程质量和终端体验，并用 Pi 构建自己的工作流 | 深度用户经验，但明显偏积极，不是中立基准 |
| [Discussion #1632](https://github.com/badlogic/pi-mono/discussions/1632) | 用户认为干净上下文能让本地 32K 模型工作更好，同时指出 bash/文件输出仍会膨胀上下文 | 单个真实用户经验，不代表普遍性能结论 |
| [Discussion #330](https://github.com/earendil-works/pi/discussions/330) | 社区用 custom entries + context hook 实现动态上下文裁剪，并保持分支感知 | 展示 Extension 组合能力，也说明核心不会替所有人决定 pruning |
| [HN 讨论](https://news.ycombinator.com/item?id=46844822) | 一些用户关注会话树、可检查历史和“可塑而非内建一切” | 普通社区观点，只作补充 |

真实吸引力主要来自：

1. 源码规模和模块边界相对容易理解，适合学习 Harness。
2. 默认行为克制，但 Extension 能深入改变系统。
3. Session Tree、Context Hook 和 Skill 渐进披露让长期会话可检查、可调整。
4. Provider 支持广，用户不会被单一模型锁定。
5. CLI、SDK、JSON 和 RPC 共用同一套运行语义。

### 4.2 实际暴露的问题

- [Issue #3274](https://github.com/earendil-works/pi/issues/3274)：并行工具曾导致交互 UI 竞争和文件修改冲突，后来通过每工具执行模式等方式修正。说明“工具并行”不能只由性能目标驱动。
- [Issue #2608](https://github.com/earendil-works/pi/issues/2608)：重复 Compaction 曾静默丢信息。说明摘要和边界必须用多轮压缩测试验证。
- [Issue #645](https://github.com/earendil-works/pi/issues/645)：早期方案同时讨论 `/reload` 和 `--watch`，当前版本实际提供显式 `/reload`，未发现 `--watch` 实现。它说明设计计划与最终产品能力必须分开核验。
- Discussion #1632：即使系统提示词很短，大型工具输出仍然会占满上下文。小核心不会自动解决所有 Token 问题。
- Extension 权限很大，多个 hook 同时改写上下文或工具结果时，行为来源会变得难追踪。
- 官方正在演进 Agent Harness、Durability 和 Observability 设计，当前 API 与未来目标之间仍有变化空间。

### 4.3 热度放大的部分

- “代码少”不等于完成生产所需的权限、租户、恢复和审计。
- 社区子 Agent 示例证明可扩展，不等于 Pi 已有工业级多 Agent Orchestrator。
- 会话 JSONL 易读，不等于跨进程并发写和灾难恢复已解决。
- Provider 很多，不等于每个模型切换都能无损保持 reasoning 和 tool semantics。
- OpenClaw 曾经与 Pi 的历史关系，不能作为当前 OpenClaw Runtime 仍由 Pi 驱动的证据。当前 OpenClaw 源码已明确内建 Runtime，仅继续使用 Pi TUI。

## 5. 值得 HuanLink 学习的设计

| Pi 的做法 | 解决的问题 | 对 HuanLink 的价值 | 建议落地 | 当前状态 |
| --- | --- | --- | --- | --- |
| Core 只暴露 Agent/Turn/Message/Tool 事件 | UI、SDK 不侵入 Loop | Framework Adapter 可输出统一生命周期 | 在 Adapter 边界做可选事件转换，不重写框架 Loop | OpenAI Adapter 目前只返回最终结果，尚未完整暴露 |
| 控制应答与完成事件分离 | 长任务不阻塞调用者 | 正好对应异步 AgentCall | 保持 `accepted receipt -> watcher -> terminal listener` | Phase 3 正在实现 |
| Tool update + AbortSignal | 可见进度和可取消 | 转成 A2A progress/cancel | Adapter 内保留原生取消，外层统一 Task 状态 | Codex Adapter 已部分完成 |
| Session append-only tree | 分支、回退、历史可追踪 | 启发 EventLog 不覆盖原始事实 | P0 继续 append-only；Session Tree 后置 | EventLog 已 append-only，无通用树 |
| Durable boundary | 避免假装恢复半截 stream | 定义 AgentCall 可恢复点 | 记录受理、终态、Artifact、re-entry；不自动重跑未知副作用 | 尚未形成完整恢复语义 |
| Skill 元数据先注入、正文按需读 | 降低上下文膨胀 | 垂类 Agent 能力很多时仍可控 | Agent Card/Registry 只给摘要和 schema，详情按需加载 | A2A Agent Card 已有能力描述 |
| 每轮动态 `prepareNextTurn` | 模型/工具/提示可在安全点更新 | 异步结果到达后读取最新群聊上下文 | 坚持终态后创建新 MainAgent run，不恢复旧 prompt snapshot | 已作为项目边界决定 |
| Extension 状态写 custom entry | 扩展状态与模型消息分离 | Policy/Router 可记录内部决策但不污染 prompt | EventLog 区分可见上下文和内部控制事件 | 事件 schema 尚偏旧 Loop |
| Provider 能力与成本元数据 | 路由可解释 | 支撑未来模型/专业 Agent 路由 | Router 使用 capability/cost/health，不吸收 Provider 协议 | 后续方向 |
| 显式 reload 生命周期 | 资源替换发生在可观察边界 | 配置/Adapter 更新更可控 | P0 启动时加载，变更需显式重启；未来 reload 要发事件 | 当前天然如此 |
| 子进程退出与状态机 | 外部 Agent 故障可见 | Codex `app-server` 断线能正确映射任务 | 统一记录 instance id、exit reason、受影响 task | 已有失败处理，事件层可加强 |

## 6. 不应直接照搬的设计

### 6.1 不照搬 Pi Agent Loop

HuanLink 已明确把单次 Run 交给框架。复制 Pi Loop 会重新引入模型流、Tool schema、错误、重试和 Provider 兼容维护，违背当前路线。可以学习事件命名和取消契约，但实现应由 OpenAI Agents JS、Codex Runtime 等框架 Adapter 提供。

### 6.2 不把 Extension 变成 P0 平台能力

Pi Extension 能改 system prompt、context、Provider 请求和 Tool Result，还能执行任意 TS。群聊系统中，这相当于把宿主进程权限交给插件作者。P0 只允许仓库内静态、可信的 Adapter；未来真正需要第三方插件时，应有签名/来源、权限声明、隔离和生命周期审计。

### 6.3 不复制本地 YOLO 权限模型

个人 Coding Agent 可以由机器所有者承担风险；群聊中的消息发送者未必拥有服务器文件和凭据权限。HuanLink 必须把“谁提出请求”和“宿主以谁的权限执行”分开建模。

### 6.4 不把 Shell 子进程当成多 Agent 协议

Pi 子 Agent 示例适合本地快速并行，但 stdout 文本、cwd 和 SIGTERM 不是跨平台 Agent 协议。HuanLink 已完成 A2A Codex Adapter，应继续让私有进程协议留在 Adapter 内。

### 6.5 不复制 Pi JSONL Schema

Pi Session JSONL 围绕消息树和 Coding Session；HuanLink EventLog 围绕群聊、AgentCall、A2A Task、Artifact、Policy 和重新进入。两者可共享 append-only 思想，但事件语义不能照抄。

### 6.6 暂不实现通用 Compaction 和 Session Tree

压缩需要处理 Tool Result 配对、重复压缩、固定事实、分支和信息损失。当前框架已各自维护模型会话；HuanLink 应先记录 Context Manifest 和 Artifact 引用，等真实群聊长会话暴露问题后再决定是否做外层摘要。

### 6.7 不依赖实验性 Orchestrator

`pi-orchestrator` 明确是实验包，且不恢复中断任务。其进程状态和退出处理可作参考，但不能替代 HuanLink Agent Registry、A2A Router 或 Task Store。

## 7. Pi 与 HuanLink 架构映射

| 概念 | Pi | HuanLink 当前/目标 | 判断 |
| --- | --- | --- | --- |
| Agent Loop | `pi-agent-core` 内部模型/工具循环 | OpenAI Agents JS 或远端 Codex Runtime | **复用框架，不自研** |
| Task / TaskHandle | Core 内无跨进程 Task；工具调用只在 Run 内 | A2A Task + `AgentCallService` + receipt/watcher | **HuanLink 自己掌控** |
| EventLog / Trace | 运行事件 + Session JSONL；Observability 仍在演进 | JSONL EventLog/Replay + A2A 关联事件 | **保留外层事实源，接框架事件** |
| Session / Branch | append-only entry tree、active leaf、fork/compact | MainAgent session、群聊上下文、Codex context/thread | **只学语义，P0 不复制树** |
| Context Manifest | 无同名统一对象；由 ResourceLoader、Session 和 hooks 装配 | 应描述群聊快照、AgentCall、Artifact 和固定事实来源 | **P1 最小实现** |
| Artifact | Tool content/details、文件系统结果 | A2A Artifact、diff、changed files、verification | **已有基础，补元数据和限制** |
| Skill / Tool | Skill 是按需知识；Tool 是执行接口 | Agent Card skill、普通 Tool、AgentCall submit tool | **保持三者边界** |
| Extension | 受信任的进程内代码和深度 hook | Adapter、Transport、Channel 插件、可选 lifecycle subscriber | **只做静态最小机制** |
| A2A Agent | 非核心；社区以子进程 Extension 模拟 | 标准 A2A Agent Card/Task/Artifact | **HuanLink 差异化核心** |
| Policy / Approval | 无统一权限系统；hook 可局部阻断 | 未来身份、Policy、Approval、审计 | **必须由 HuanLink 外层拥有** |
| Provider | `pi-ai` 统一 Provider/Model | Vercel AI SDK + Agent 框架 + Router 元数据 | **复用 SDK，学习能力模型** |
| Process instance | 实验 Orchestrator 记录进程状态 | Codex app-server client/adapter 实例 | **补统一实例事件，不引入包** |

### 7.1 最重要的边界图

```text
群聊 / HTTP / CLI
  -> HuanLink Outer Orchestration
     -> ResponseGate / MainAgent scheduling
     -> AgentCallService
        -> A2A Transport
           -> Codex A2A Adapter
              -> Codex app-server Runtime
     -> EventLog / Trace / Artifact / Policy

MainAgent 单次 Run
  -> OpenAI Agents JS
     -> model/tool loop
     -> 可选 framework event adapter

Pi 提供的是参考：
  - 小 Loop 的职责边界
  - 生命周期事件
  - Session Tree / Context / Skill / Extension 工程实践
  - 不是 HuanLink 的新增 Runtime 依赖
```

## 8. 对当前 Demo 的具体改进建议

### 8.1 已完成能力，不重复建设

根据 [`23-a2a-first-real-demo-plan.md`](./23-a2a-first-real-demo-plan.md)、[`24-codex-a2a-adapter-v1-product-capabilities-draft.md`](./24-codex-a2a-adapter-v1-product-capabilities-draft.md) 和当前 `apps/codex-a2a-adapter`：

- 已有标准 A2A Agent Card 和协议端点；
- 已接真实 Codex `app-server`；
- 已有 task state、streaming、subscription、cancel 和 Artifact；
- 已有 workspace Git root/branch guard；
- 已有 `contextId -> Codex thread` 复用和同 thread 单活控制；
- 已处理 app-server 退出导致 in-flight task 失败；
- 不自动 commit、merge、push。

因此无需再做“把 Codex 包成 A2A Agent”或“给任务增加状态”这类重复建议。

### 8.2 Phase 3 当前实现方向

工作区正在实现的 `packages/core/src/agent-call/AgentCallService` 已体现 Pi 值得学习的控制/完成分离：

```text
submit
-> capability discovery
-> remote task accepted
-> 建立 agentCallId <-> taskId
-> 立即返回 receipt
-> 后台 watch
-> 首个 terminal snapshot 胜出
-> 只触发一次 terminal listener
```

该方向应保持。近期只建议做以下小范围检查，不要求为本文修改代码：

1. **事件关联：**在接入 EventLog 时记录 `runId/sessionId/agentCallId/taskId/contextId`，不要只写最终文本。
2. **订阅断开语义：**当前实现把 watcher 异常直接转成 remote task `failed`。真实 A2A 中“本地失去观察”不一定等于“远端任务失败”；Demo 可先如此，但应在类型或文档中标记这是暂定策略，P1 区分 `observation-lost` 与远端 `failed`。
3. **终态 listener 失败：**listener 使用 `Promise.allSettled` 是合理的隔离，但失败应进入 Runtime Log/EventLog，否则 re-entry 丢失会静默发生。
4. **关闭与恢复：**`close()` 只终止 watcher，不表示远端任务取消。保持这个区别，并避免重启时自动重复提交。
5. **Artifact 上限：**沿用 Pi 子 Agent 的输出上限思想，为文本 Artifact 设置大小/截断元数据；完整 diff 或文件放引用，不无限塞入 MainAgent prompt。

### 8.3 EventLog 最小增量

当前 Core EventLog schema 仍偏向旧自研 Loop 的 `model/tool` 事件。不要现在重构全部事件，只需在 Phase 3/4 首次真实接入时增加最小外层语义：

```text
agent_call.submitted
agent_call.accepted
agent_call.status_changed
agent_call.artifact_received
agent_call.observation_lost
agent_call.terminal
main_agent.reentry_scheduled
main_agent.reentry_started
```

每个事件使用同一 correlation envelope，并保持 JSONL 一写者。框架内部的 Token delta 不必全部复制进 HuanLink EventLog；保留状态边界、用量汇总、错误和必要 Artifact 即可。

### 8.4 Context Manifest 的最小切入点

不要阻塞当前 Phase 3。等 Phase 4 真实群聊进入后，只给“异步任务完成后的 MainAgent 新 turn”生成 Manifest：

- 最近群聊快照范围；
- 原始请求消息 ID；
- AgentCall terminal snapshot；
- Artifact refs；
- 生成时间与过期判断；
- 实际交给哪个 Runtime/Agent。

这样可以验证“任务完成时读取最新群聊上下文”是否真的有效，再决定是否扩展到所有 turn。

### 8.5 安全最小增量

当前 Demo 保持 loopback 和 workspace/branch guard。接真实群聊前至少让 AgentCall 带可审计的 `actor/channel/project` 来源，哪怕 P0 只实现静态 allowlist。不要把 Pi 的 project trust 当作替代品，也不要允许聊天内容触发 Extension/Skill 安装。

## 9. 实施优先级

### P0：当前 Demo 或近期阶段

1. 完成正在推进的 Phase 3：协议无关 AgentCall 生命周期、标准 A2A Client、MainAgent 提交工具和终态 re-entry。
2. 保持 `AgentCallId <-> taskId` 双向关联和终态幂等；补最小 Runtime Log，避免 listener/re-entry 失败静默。
3. 为 AgentCall 增加最小 outer EventLog 事件和 correlation envelope，不记录完整模型流。
4. 明确 watcher 断开、Adapter 进程退出和远端 Task 失败的区别，至少在事件原因中可区分。
5. 为 Artifact 增加输出上限、截断标记或引用策略，避免异步结果直接撑爆 MainAgent 上下文。
6. 接真实群聊前保留静态项目/身份 allowlist、workspace/branch guard 和无自动 push 约束。

### P1：Demo 稳定后

1. 为异步 re-entry 引入最小 Context Manifest，并用真实群聊评估结果过期、上下文漂移和信息遗漏。
2. 将 OpenAI Agents JS/Codex 的关键生命周期转为统一 Adapter 事件；只记录状态边界和用量，不复制全部底层事件。
3. 增加 Agent Runtime instance 状态，记录进程启动、在线、退出原因及受影响 Task。
4. 为 `observation-lost` 做重订阅/查询恢复，不把网络断开直接等同远端失败。
5. 引入最小 Policy/Approval 合约，支持 `input-required`、`auth-required` 和群聊审批回流。
6. Router 读取模型/Agent capability、成本、上下文窗口和健康状态，并记录路由原因。

### P2：验证需求后再做

1. AgentCall/EventLog 的持久任务恢复和幂等重连。
2. Session Branch、回退和 branch summary。
3. 外层长期群聊摘要或跨 Runtime Compaction。
4. 受控 Extension SDK、动态资源 reload 和第三方插件隔离。
5. 多专业 Agent 并行/链式/图式调度及统一 Trace。
6. 数据库派生索引、远端 Trace 后端和 OpenTelemetry exporter。

### 暂不采用

- 直接依赖 Pi Agent Core 运行 MainAgent；
- 复制 `pi-ai` 替代 Vercel AI SDK；
- 以 `pi --mode json` 子进程作为 HuanLink A2A 协议；
- 群聊可安装的任意 TS Extension；
- 没有 Sandbox/Approval 的 Shell 中心化权限模型；
- 为当前 Demo 实现完整 Session Tree、通用 Compaction 或数据库主存储；
- 依赖实验性的 `pi-orchestrator` 作为生产 Agent 调度器。

## 10. 建议的最小接口或数据结构

以下只是接口方向，用于说明边界，不要求当前立即实现。

### 10.1 Context Manifest

```ts
export type ContextSourceRef = {
  kind: "group_snapshot" | "message" | "agent_call" | "artifact" | "fact";
  id: string;
  version?: string;
  reason: string;
};

export type TaskContextManifest = {
  id: string;
  taskId: string;
  assembledAt: string;
  sources: ContextSourceRef[];
  runtime: {
    adapterId: string;
    agentId: string;
    modelId?: string;
  };
};
```

Manifest 不保存凭据，也不强制保存完整 prompt。`reason` 用来回答“为什么把这条内容交给模型”。

### 10.2 外层事件关联头

```ts
export type AgentCallEventEnvelope = {
  eventId: string;
  type: string;
  timestamp: string;
  runId?: string;
  sessionId?: string;
  agentCallId: string;
  remoteTaskId?: string;
  contextId?: string;
  adapterId: string;
};
```

具体 payload 按事件类型定义，避免一个巨型可选字段对象。Prompt、Tool args、headers、凭据默认不进入 EventLog。

### 10.3 任务观察丢失

不建议给 A2A 标准状态增加私有枚举。可在 HuanLink 本地 Record 中区分：

```ts
type ObservationState =
  | { status: "watching" }
  | { status: "lost"; reason: string; retryable: boolean }
  | { status: "closed" };
```

远端 `TaskState` 仍保留最后一次确认值。本地订阅断开不应伪造远端 `failed`，除非 Adapter 已确认远端失败。

## 11. 风险、分歧和待验证假设

### 11.1 已确认风险

1. **事件双层化：**框架 trace 和 HuanLink EventLog 都记录事件时，可能重复、乱序或泄漏敏感内容。必须定义哪些是底层诊断，哪些是业务事实。
2. **异步终态重入：**terminal listener 成功不等于 MainAgent re-entry 成功；两者需要独立事件和幂等键。
3. **订阅与事实混淆：**网络断开只说明观察失败，不能证明远端任务失败。
4. **上下文膨胀：**完整 diff、日志和子 Agent 文本若直接注入新 turn，会抵消异步执行的收益。
5. **权限主体错位：**服务器进程权限远高于普通群成员，不能沿用个人 Coding Agent 的信任假设。

### 11.2 尚待真实 Demo 验证

1. AgentCall 完成后读取最新一到两分钟群聊，是否足以让 MainAgent判断结果是否过期。
2. `accepted -> terminal -> new run` 是否会产生用户感知上的回复延迟或重复回复。
3. MainAgent 是否需要看到中间 progress，还是只需要终态和少量里程碑。
4. Codex Artifact 的 summary/diff/changed files/verification 哪些必须进入模型，哪些只供 UI/审计。
5. 同一群多个 AgentCall 完成时，按完成顺序、提交顺序还是语义优先级 re-entry。
6. OpenAI Agents JS 的 session、approval 和 tracing 能否直接满足 MainAgent，哪些只需 Adapter 翻译。

### 11.3 对 Pi 资料的限制说明

- `AgentHarness`、durability 和 observability 文档含有计划性内容，不能视为全部实现完成。
- `pi-orchestrator` 官方明确标为实验性。
- 社区讨论只能证明具体用户遇到或解决过某类问题，不能证明普遍性能优势。
- 2026-07 的 Pi 已迁移仓库和 npm scope；旧 issue/discussion 链接仍可能位于 `badlogic/pi-mono`，GitHub 会重定向，但引用时保留原讨论地址。
- 本文没有通过 benchmark 比较 Pi、OpenAI Agents JS 与 Codex Runtime 的质量或性能，因此不作“谁更强”的结论。

## 12. 资料来源

### 12.1 Pi 官方源码与文档

- [Pi 官方仓库，调查快照 `8479bd8`](https://github.com/earendil-works/pi/tree/8479bd84743e8889f728acb21a62794102db0529)
- [仓库迁移公告：Pi Has a New Home](https://pi.dev/news/2026/5/7/pi-has-a-new-home)
- [Agent Loop](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/src/agent-loop.ts)
- [Agent Core 类型和事件](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/src/types.ts)
- [AgentSession](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/agent-session.ts)
- [SessionManager](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/session-manager.ts)
- [Compaction 实现](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/compaction/compaction.ts)
- [系统提示词装配](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/system-prompt.ts)
- [Skill 加载](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/src/core/skills.ts)
- [Extension 文档](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/docs/extensions.md)
- [SDK 文档](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/docs/sdk.md)
- [RPC 文档](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/docs/rpc.md)
- [Provider/Model 类型](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/ai/src/types.ts)
- [跨 Provider 消息转换](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/ai/src/api/transform-messages.ts)
- [Sub-agent Extension 示例](https://github.com/earendil-works/pi/tree/8479bd84743e8889f728acb21a62794102db0529/packages/coding-agent/examples/extensions/subagent)
- [实验性 Pi Orchestrator](https://github.com/earendil-works/pi/tree/8479bd84743e8889f728acb21a62794102db0529/packages/orchestrator)
- [Agent Harness 设计](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/docs/agent-harness.md)
- [Durable Harness 设计](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/docs/durable-harness.md)
- [Observability 设计](https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/docs/observability.md)

### 12.2 作者文章、Issue 与社区技术讨论

- [Mario Zechner：What I learned building Pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- [Armin Ronacher：Agentic Coding Recommendations](https://lucumr.pocoo.org/2026/1/31/pi/)
- [Issue #2608：Repeated compaction can silently lose information](https://github.com/earendil-works/pi/issues/2608)
- [Issue #3274：Parallel tools and interactive/race problems](https://github.com/earendil-works/pi/issues/3274)
- [Issue #645：Extension package loading and reload design](https://github.com/earendil-works/pi/issues/645)
- [Discussion #330：Dynamic context pruning Extension](https://github.com/earendil-works/pi/discussions/330)
- [Discussion #1632：Context efficiency and tool output growth](https://github.com/badlogic/pi-mono/discussions/1632)
- [Hacker News 技术讨论](https://news.ycombinator.com/item?id=46844822)

### 12.3 HuanLink 当前代码与文档

- [`docs/dev/23-a2a-first-real-demo-plan.md`](./23-a2a-first-real-demo-plan.md)
- [`docs/dev/24-codex-a2a-adapter-v1-product-capabilities-draft.md`](./24-codex-a2a-adapter-v1-product-capabilities-draft.md)
- `apps/codex-a2a-adapter/src/codex-task-executor.ts`
- `apps/codex-a2a-adapter/src/codex-app-server-client.ts`
- `apps/codex-a2a-adapter/src/workspace-guard.ts`
- `packages/core/src/events/jsonl-event-log.ts`
- `packages/core/src/replay/`
- `packages/integrations/openai-agents/src/openai-agents-runtime.ts`
- 正在推进但尚未提交：`packages/core/src/agent-call/agent-call-service.ts`、`types.ts` 和 `docs/dev/D02-phase3-huanlink-a2a-client-plan.md`

### 12.4 OpenClaw 当前关系核验

- 本地参考快照 `references/openclaw/docs/agent-runtime-architecture.md`：OpenClaw 直接拥有 `src/agents`、`packages/agent-core` 和内建 Runtime。
- 本地参考快照 `references/openclaw/package.json`：仅发现 `@earendil-works/pi-tui` 运行依赖。
- [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)：用于核验维护状态和当前架构，历史文章中的 Pi 关系不外推为当前事实。

## 最终判断

Pi 对 HuanLink 的最大价值是提供一套经过真实使用验证的 Harness 分层样本：小 Loop、富宿主、append-only Session、动态上下文、渐进 Skill、深度 Extension 和统一 Provider。HuanLink 应吸收这些边界和工程经验，但不增加 Pi Runtime 依赖。

当前 A2A-first Demo 路线没有需要立即推翻的架构问题。最需要尽快明确的是：**远端任务事实与本地观察状态必须分开，框架内部事件与 HuanLink 外层业务事件必须分开，Artifact 与上下文正文必须分开。** 这三条边界可以通过 Phase 3/4 的小增量完成，不需要大规模重构。
