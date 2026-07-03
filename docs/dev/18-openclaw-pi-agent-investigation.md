# OpenClaw 所用 Pi Agent 调研

## 一句话结论

OpenClaw 早期确实大量借用了 Pi 这套轻量 agent harness，但现在的关系已经不是“直接依赖外部 Pi runtime 跑核心链路”，而是：**保留 Pi 的最小运行时思想，把关键 runtime 内化到 OpenClaw 自己的 `embedded-agent-runner + harness` 体系里，只留下 `runEmbeddedPiAgent` 这类兼容别名给旧插件。**

本报告分两层看：

1. `Pi` 本体到底是什么，轻量在哪里。
2. `OpenClaw` 到底继承了 Pi 的哪些思想，又在哪些地方明显长得更重、更强、更像一个完整平台。

## 0. 先把边界说清楚

这次调研同时使用了两类一手资料：

- 本地 `references/openclaw` 源码、文档、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`
- Pi 上游官方仓库 `earendil-works/pi` 的 README / 包说明

这里有一个非常关键的边界：

- **当前 OpenClaw 仓库里，已经没有“把外部 Pi runtime 当黑盒直接调用”的结构。**
- `CHANGELOG.md` 明确写了：OpenClaw 已经 **internalize the former Pi agent runtime into OpenClaw**，并把 Pi 命名的 SDK alias 降成 deprecated compatibility。
- 所以你现在看到的 `runEmbeddedPiAgent`，更多是**名字兼容层**，不是说明 OpenClaw 仍然把核心 loop 交给外部 Pi 包执行。

因此，理解 Pi 时不能混淆两件事：

```txt
Pi 本体
vs
OpenClaw 当前已经内化后的 embedded runtime
```

## 1. Pi 到底是什么

### 1.1 Pi 不是“大平台”，而是最小 coding harness

Pi 官方仓库首页把自己定义得很直接：

- `@earendil-works/pi-coding-agent`: interactive coding agent CLI
- `@earendil-works/pi-agent-core`: agent runtime with tool calling and state management
- `@earendil-works/pi-ai`: unified multi-provider LLM API
- `@earendil-works/pi-tui`: terminal UI library

对应上游官方仓库：

- 仓库主页：<https://github.com/earendil-works/pi>
- `pi-agent-core` 说明：<https://github.com/earendil-works/pi/tree/main/packages/agent>
- `pi-coding-agent` 说明：<https://github.com/earendil-works/pi/tree/main/packages/coding-agent>

Pi 最核心的定位不是“全家桶 agent 平台”，而是：

```txt
一个尽量小、尽量可嵌入、尽量可扩展的 coding harness
```

这点在 `pi-coding-agent` README 里非常明确：

- 它自称 `minimal terminal coding harness`
- 强调 “Adapt pi to your workflows, not the other way around”
- 明说它**故意不内建** sub agents 和 plan mode
- 倾向通过 skills / prompt templates / extensions / packages 去扩展

也就是说，Pi 的哲学不是：

```txt
平台先把所有高级工作流都内建好
```

而是：

```txt
先给一个最小可用 runtime
再把个性化工作流交给扩展层
```

### 1.2 Pi 的包分层非常清楚

从官方仓库描述看，Pi 其实就是四层：

| 层 | 包 | 作用 |
| --- | --- | --- |
| 模型适配层 | `@earendil-works/pi-ai` | 统一多 provider LLM API |
| agent 运行时 | `@earendil-works/pi-agent-core` | agent state、tool calling、event streaming |
| coding CLI | `@earendil-works/pi-coding-agent` | 默认 coding 工具、session、compaction、交互体验 |
| TUI | `@earendil-works/pi-tui` | 终端 UI 渲染 |

这套拆法很轻量，也很干净：

```txt
pi-ai
  -> pi-agent-core
    -> pi-coding-agent
      -> pi-tui
```

OpenClaw 早期看中的，显然就是这种“层次很清楚、可嵌入”的结构。

### 1.3 `pi-agent-core` 的本质：状态型 agent + tool loop + event stream

`pi-agent-core` 官方说明把它定义为：

```txt
Stateful agent with tool execution and event streaming.
```

它最值得注意的不是“又一个 while loop”，而是这三个点：

1. 有状态
2. 工具调用是一等能力
3. 事件流是一等输出

官方 README 给出的核心概念是：

- `AgentMessage[] -> transformContext() -> convertToLlm() -> Message[] -> LLM`
- agent 工作在自己的 `AgentMessage` 抽象上，而不是直接等于 provider message
- 在真正调用 LLM 前，会经过：
  - `transformContext()`
  - `convertToLlm()`

这很重要，因为它说明 Pi 很早就把“agent 内部消息”与“provider LLM 输入消息”分开了。

### 1.4 Pi 的 loop 是事件驱动的，不只是拿最终字符串

`pi-agent-core` README 还给了事件序列：

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `turn_end`
- `agent_end`

这说明 Pi 从一开始就不是“同步返回一个 answer”的黑盒，而是适合：

- TUI
- 流式 UI
- 进度感知
- 工具过程展示
- 嵌入式 host 集成

换句话说，Pi 轻量，但不是“简陋”；它在运行时边界上其实很现代。

### 1.5 Pi 默认工具面很小，但足够形成 coding loop

`pi-coding-agent` README 明确写了，默认给模型四个工具：

- `read`
- `write`
- `edit`
- `bash`

这个默认面很小，但已经足够形成最基本的 coding agent 闭环：

```txt
读文件
-> 改文件
-> 执行命令
-> 再根据结果继续
```

这也是 Pi “轻量”的一个核心原因：

- 不先追求几十个工具
- 先把最通用的几个编码工具做成稳定默认面

### 1.6 Pi 的 session 设计很有代表性：JSONL + 树

`pi-coding-agent` README 对 session 的描述也很关键：

- session 存成 `JSONL`
- 每条 entry 有 `id` 和 `parentId`
- 因此可以在**同一个文件里做树状分叉**
- 支持 `/tree`、`/fork`、`/clone`

这说明 Pi 不是只把会话当“线性聊天记录”，而是把它当：

```txt
可分支、可回看、可压缩、可继续执行的工作轨迹
```

这个设计对 agent 很重要，因为很多真正的开发轨迹都不是线性的。

### 1.7 Pi 有 compaction，但哲学仍然偏“轻”

`pi-coding-agent` README 提到：

- 长 session 会触发 compaction
- 支持手动 `/compact`
- 也支持自动 compaction
- full history 仍留在 JSONL 里

这说明 Pi 已经意识到 context window 管理是核心问题，但它的做法仍偏：

```txt
CLI harness 内的实用 compaction
```

而不是像 OpenClaw 现在那样，围绕 compaction 发展出更厚的：

- hook
- diag
- timeout recovery
- overflow recovery
- transcript rotation
- post-compaction guard

### 1.8 Pi 明确不内建强权限系统

Pi 官方仓库首页有一句话非常值得记住：

```txt
Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access.
```

它建议如果你要更强隔离，就自己做：

- Docker
- micro-VM
- sandbox

这其实也是 Pi 轻量的另一面：

- 它把 agent runtime 做小了
- 但安全边界默认并不重

这对个人 CLI 很合理，对平台型产品就不够了。

## 2. OpenClaw 和 Pi 的真实关系

### 2.1 OpenClaw 不是“参考过 Pi”，而是确实吸收过它

本地 `references/openclaw/THIRD_PARTY_NOTICES.md` 说得很明确：

- OpenClaw 的一部分代码是从 `Pi / pi-mono` 适配来的
- OpenClaw 还依赖 `@earendil-works/pi-tui` 做 terminal UI render
- 上游就是：<https://github.com/earendil-works/pi-mono>，现已重定向到 `earendil-works/pi`

这说明 OpenClaw 和 Pi 不是松散“灵感关系”，而是有实打实的代码与运行时血缘关系。

### 2.2 早期 OpenClaw 确实直接跟 Pi 包族一起演进

`references/openclaw/CHANGELOG.md` 里还能看到早期痕迹：

- 依赖过 `@mariozechner/pi-agent-core`
- 依赖过 `@mariozechner/pi-ai`
- 依赖过 `@mariozechner/pi-coding-agent`
- 依赖过 `@mariozechner/pi-tui`

后期又能看到：

- Pi models catalog 继续被借用
- `runEmbeddedPiAgent(...)` 继续在插件 SDK 里保留兼容
- compaction / hook / lifecycle 继续强调与 Pi 语义对齐

这说明 OpenClaw 不是简单“彻底抛弃 Pi”，而是：

```txt
先依赖 Pi
-> 再逐步吸收 Pi runtime
-> 再把 Pi 语义保留成兼容面和设计参照
```

### 2.3 关键拐点：OpenClaw 已把前 Pi runtime 内化

`CHANGELOG.md` 的一句话最关键：

```txt
internalize the former Pi agent runtime into OpenClaw
```

这意味着当前 OpenClaw 架构的正确理解应该是：

- Pi 提供了早期的轻量 runtime 母型
- OpenClaw 把这套母型吃进自己仓库里继续演化
- 现在 `runEmbeddedPiAgent` 只剩兼容意义

本地证据非常直接：

- `docs/plugins/sdk-runtime.md`：`runEmbeddedAgent(...)` 是 neutral helper
- 同文件写明：`runEmbeddedPiAgent(...)` remains as a deprecated compatibility alias
- `src/plugins/runtime/runtime-agent.ts`：`runEmbeddedPiAgent` 实际上直接映射到 `runEmbeddedAgent`
- `src/extensionAPI.ts`：`runEmbeddedAgent as runEmbeddedPiAgent`
- `src/plugins/compat/registry.ts`：把这套 alias 标记为 `deprecated SDK compatibility only`

## 3. OpenClaw 现在把 Pi 的哪些东西吸收进来了

### 3.1 最核心的对应关系

| Pi 原始概念 | Pi 里的意思 | OpenClaw 当前对应物 | 关键文件 |
| --- | --- | --- | --- |
| `pi-ai` | 多 provider 统一模型层 | provider/model/harness policy | `src/agents/harness/policy.ts`, `src/agents/agent-runtime-metadata.ts` |
| `pi-agent-core.Agent` | 有状态 loop、tool 执行、事件流 | `runEmbeddedAgent(...)` | `src/agents/embedded-agent-runner/run.ts` |
| `tool execution + event stream` | 工具前后、流式增量、turn 事件 | `EmbeddedAgentRunResult` + 事件回调 + diagnostics | `src/agents/embedded-agent-runner/types.ts`, `src/agents/harness/lifecycle.ts` |
| `coding-agent` 默认工具面 | `read/write/edit/bash` 为中心 | OpenClaw agent tools + policy pipeline | `src/agents/agent-tools*.ts`, `src/agents/tool-policy*.ts` |
| `JSONL session tree` | 可分支、可 compact、可恢复 | OpenClaw transcript/session 文件体系 | `src/config/sessions/*`, `src/agents/embedded-agent-runner/*` |
| `manual/auto compaction` | 长会话压缩 | OpenClaw 自主 compaction runtime | `src/agents/embedded-agent-runner/compact*.ts`, `run.ts`, `agent-settings.ts` |
| `extensions/skills` | 轻量扩展面 | plugin runtime + hook system | `docs/plugins/sdk-runtime.md`, `src/plugins/runtime/*` |

### 3.2 `runEmbeddedAgent(...)` 就是当前 OpenClaw 的“前 Pi 核心入口”

如果你要在 OpenClaw 当前源码里找“Pi runtime 的后代”在哪里，看这个入口最直接：

- `src/agents/embedded-agent-runner/run.ts`
- 导出函数：`runEmbeddedAgent(...)`

这个入口已经不只是一个简陋 loop，而是大编排层：

- 先回填 `sessionKey`
- 解析 session lane / global lane
- 进入队列和优先级系统
- 处理 transcript / sessionFile / persistence
- 运行 harness attempt
- 处理 compaction / retry / overflow / timeout
- 最后生成 `EmbeddedAgentRunResult`

这和 Pi 原本“最小 stateful agent runtime”是一条清晰的演化线。

### 3.3 OpenClaw 保留了 Pi 的“事件化思路”，但做得更工程化

Pi 的一个核心优势是事件流。OpenClaw 没有丢这点，反而更进一步：

- `src/agents/harness/lifecycle.ts` 里 `runAgentHarnessLifecycleAttempt(...)`
- 明确包装了：
  - context-engine support checks
  - diagnostic events
  - trace propagation
  - result classification

并会发：

- `harness.run.started`
- `harness.run.completed`
- `harness.run.error`

这和 Pi 原本的 `agent_start / turn_start / tool_execution_* / agent_end` 是同一思路，但更偏平台化 observability。

### 3.4 OpenClaw 仍然保留“嵌入式 agent helper”这个 Pi 风格接口

`docs/plugins/sdk-runtime.md` 很值得看，因为它相当于告诉你：

- 新插件应该用 `api.runtime.agent.runEmbeddedAgent(...)`
- 旧名字 `runEmbeddedPiAgent(...)` 只是兼容别名
- 它会沿用同样的 provider/model 解析和 harness 选择逻辑

这说明 OpenClaw 仍然保留了 Pi 那种很实用的能力：

```txt
让别的宿主模块/插件可以方便地发起一个内嵌 agent turn
```

这其实是 Pi 轻量架构里很值钱的一点，因为它天然适合：

- CLI
- 插件
- channel adapter
- workflow 节点
- host app 内嵌 agent

## 4. OpenClaw 比 Pi 明显“变重”在哪里

### 4.1 harness 选择层比 Pi 厚得多

Pi 更像：

```txt
统一 harness
+ 模型和 provider 选择
```

OpenClaw 现在是：

```txt
统一 gateway / session / plugin 外壳
+ 可切不同 harness runtime
  - openclaw
  - codex
  - acp 等
```

对应 `src/agents/harness/policy.ts` 的 `resolveAgentHarnessPolicy(...)`，它已经不是单一 embedded runtime，而是“先决定这次到底该用哪个 harness”。

这一步就是 OpenClaw 超出 Pi 轻量定位的典型体现。

### 4.2 compaction 在 OpenClaw 里已经不是“小功能”，而是大运行时子系统

Pi 的 compaction 更偏会话内实用功能。

OpenClaw 当前则把它做成了一个完整子系统：

- timeout 触发 compaction
- overflow 触发 compaction
- compaction safety timeout
- post-compaction loop guard
- compaction hook messages
- compaction transcript adoption / rotation
- tool result truncation 与 compaction 联动

最关键的代码都集中在：

- `src/agents/embedded-agent-runner/run.ts`
- `src/agents/embedded-agent-runner/compact*.ts`
- `src/agents/agent-settings.ts`

从 `run.ts` 的实现可以清楚看到：

- timeout 时，如果 prompt token 占比高，会先 compact 再 retry
- overflow 时，会计算 overflow token，再走 compact/retry/truncate/give-up 分支
- compaction 成功后，还会更新 `compactionCount`、`compactionTokensAfter`
- 如果 compaction 把最终回答打断了，还会再来一次 continuation retry

这已经远超 Pi README 里那种“有手动/自动 compact”的层级了。

### 4.3 OpenClaw 在 hook / diagnostics / compatibility 上也比 Pi 重很多

从 `CHANGELOG.md` 可以看出，OpenClaw 很多新补丁都在做“让其他 harness 和 Pi 语义对齐”：

- `before_prompt_build`
- `before_compaction`
- `after_compaction`
- `llm_input`
- `llm_output`
- `agent_end`

这说明 Pi 原本有一套较清晰的 hook/lifecycle 语义，而 OpenClaw 在扩展 Codex、本地 app-server、插件时，需要不断补齐这些语义的一致性。

换句话说：

```txt
Pi 是轻量语义母型
OpenClaw 是把这些语义推广到多 runtime、多插件、多入口的大平台
```

### 4.4 安全和策略层也是 OpenClaw 变重的重要原因

Pi 官方明确说自己**不内建强权限系统**。

OpenClaw 则不能停在这一步，因为它要跑：

- channel
- plugin
- embedded tool
- network / message delivery
- host-side workflow

所以你会看到它在工具、策略、timeout、allowlist、审批、loop guard 上都明显更厚。

从工程角度说，Pi 像：

```txt
给开发者自己拿去玩和改的最小 agent harness
```

而 OpenClaw 更像：

```txt
要长期在线跑、要接很多入口、要兼容很多 runtime 的 agent platform
```

## 5. 为什么 OpenClaw 当初会看中 Pi

我认为最关键的是这五点。

### 5.1 Pi 足够小，容易嵌入

Pi 的原始拆分非常适合被别的宿主系统吸收：

- 模型层单独包
- agent-core 单独包
- coding CLI 单独包
- TUI 单独包

这比“一个不可拆的大成品”更适合被 OpenClaw 这种平台型项目拿来做二次组装。

### 5.2 Pi 已经有 agent 最核心的几根骨架

虽然轻，但它已经有：

- tool loop
- stateful session
- JSONL history
- compaction
- event streaming
- extension / skills

也就是说，它不是玩具，而是一个足够完整的“轻 runtime 骨架”。

### 5.3 Pi 明确支持 embedding

Pi 官方 README 直接说自己有：

- interactive
- print / JSON
- RPC
- SDK for embedding in your own apps

还专门拿 `openclaw/openclaw` 当 real-world SDK integration 例子。

这和 OpenClaw 的需求天然契合。

### 5.4 Pi 默认工具面很小，适合做宿主再加壳

默认四工具：

- `read`
- `write`
- `edit`
- `bash`

这种设计的好处是：

- 宿主平台容易理解
- 容易控制表面积
- 容易在外层再接 policy / approval / channel / plugin

### 5.5 Pi 没有把高级工作流写死

Pi 明说不内建：

- subagents
- plan mode

这反而给 OpenClaw 留下了很大自由度：

- 可以自己做 gateway
- 可以自己做 channel 驱动
- 可以自己做插件 runtime
- 可以自己做多 harness 路由

也就是说，Pi 给的是“runtime 底盘”，不是“产品路线绑定”。

## 6. Huaness Lite 能从 Pi 学什么

### Adopt

- **先做小而清楚的 runtime 分层。**
  Pi 的 `model API -> agent core -> coding shell` 拆分非常适合你学。

- **把事件流当一等输出。**
  不要只想着最终 answer；turn、tool、compaction、retry、done 都应可观察。

- **默认工具面先小。**
  P0 先围绕 `read/write/edit/exec` 这种最小闭环，不要一开始铺太多工具。

- **session / transcript 从一开始就落可读轨迹。**
  Pi 的 JSONL session tree 思路非常适合 Huaness 这种要 replay、要 debug、要长期自己用的项目。

- **扩展机制放在 core 之外。**
  Pi 的轻量感，很大程度来自“高级工作流不写死在 loop 里”。

### Defer

- **像 OpenClaw 那样的大编排层。**
  `runEmbeddedAgent` 现在已经包含大量 fallback、rotation、loop guard、compaction recovery。你现在不该直接照抄这层厚度。

- **多 harness runtime 选择层。**
  `resolveAgentHarnessPolicy(...)` 这种结构是 OpenClaw 平台化后的需求，不是 Huaness Lite P0 的必需品。

- **完整 plugin/runtime SDK。**
  Pi 和 OpenClaw 都很重视 embedding，但你现在先把 core 跑通更重要。

### Avoid

- **不要学 Pi 的“默认无强权限边界”。**
  这对个人 CLI 可能能接受，对你要长期挂服务器的 agent 不够。

- **不要一开始就把 OpenClaw 现在的重型容错矩阵抄进去。**
  你现在更该学的是 Pi 的“轻骨架”，不是 OpenClaw 的“平台厚壳”。

- **不要把兼容别名误当架构本体。**
  `runEmbeddedPiAgent` 这个名字现在在 OpenClaw 里已经主要是历史兼容，不是设计主轴。

## 7. 推荐阅读顺序

如果你想按“从轻到重”的顺序理解，建议这样读：

1. Pi 上游仓库主页
   - <https://github.com/earendil-works/pi>
2. `pi-agent-core` README
   - 看 `AgentMessage`、`transformContext()`、事件流、tool execution
3. `pi-coding-agent` README
   - 看默认工具、JSONL sessions、`/tree`、`/compact`、skills/extensions
4. OpenClaw 的 `THIRD_PARTY_NOTICES.md`
   - 确认 Pi 和 OpenClaw 的代码血缘关系
5. OpenClaw 的 `CHANGELOG.md`
   - 看 internalize Pi runtime、兼容 alias、hook 对齐
6. `src/plugins/runtime/runtime-agent.ts`
   - 看 `runEmbeddedPiAgent -> runEmbeddedAgent` 兼容映射
7. `src/agents/embedded-agent-runner/run.ts`
   - 看 OpenClaw 如何把 Pi 式轻 runtime 演化成大编排层
8. `src/agents/harness/policy.ts` 与 `src/agents/harness/lifecycle.ts`
   - 看 OpenClaw 如何在 Pi 思路上再加 runtime routing 和 diagnostics

## 8. 给初学者的最短总结

把这件事压成最短的话：

```txt
Pi 像一个很轻的、可嵌入的 coding agent runtime。
OpenClaw 早期借它起步，后来把它吃进自己体系里，继续长成了更重的 agent 平台。
```

所以对 Huaness Lite 来说，真正该学的是：

```txt
Pi 的“小而清楚的 runtime 骨架”
+ OpenClaw 的“哪些地方后来必须变重”
```

而不是二选一地站队。
