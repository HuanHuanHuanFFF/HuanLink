# HuanLink P0 框架选型对比

调查日期：2026-07-07

## 声明

这是一份 **面向当前阶段的选型草案**。

它服务于当前的 HuanLink P0 方向：

- 面向群聊场景的多 Agent Orchestrator
- 不再自研通用 Agent Loop
- HuanLink 自己掌控外层 orchestration、AgentCall、AsyncGateway、EventLog、A2A 边界

它 **不是最终技术决议**，也 **不试图提前锁死后续 P1 / P2 设计**。如果后续项目定位、群聊链路或 A2A 方向变化，本报告可直接调整。

## 1. 当前选型问题到底是什么

基于 `docs/dev/20-huaness-p0-boundary-refinement.md`，HuanLink 当前不是在选“整个系统框架”，而是在选：

```text
最适合作为 HuanLink 内部 leaf-agent runtime 的执行引擎
```

也就是说，要回答的不是：

- 哪个框架功能最多
- 哪个框架最像完整平台

而是：

- 谁最适合承接单次 Agent Run
- 谁最不容易干扰 HuanLink 的群聊外层控制
- 谁更容易被包在 `LocalAgentRuntimeAdapter` 后面
- 谁对后续 AgentCall / A2A / Router 预留空间最好

## 2. 本次重点比较的候选

这次只重点比较三套 TypeScript / JavaScript 候选：

1. `Vercel AI SDK`
2. `OpenAI Agents JS`
3. `Inngest AgentKit`

选择这三套的原因是：

- 都是 TS/JS 主栈
- 都仍然活跃
- 都和 agent / tool / model / orchestration 直接相关
- 三者分别代表三种不同层级：

```text
AI SDK
  = 更偏基础设施 / provider / tool-loop 能力层

OpenAI Agents JS
  = 更偏单次 agent runtime 层

AgentKit
  = 更偏多 agent orchestration / network 层
```

## 3. 先给结论

如果只看 HuanLink 当前 P0 方向，我的推荐是：

### P0 推荐

```text
HuanLink outer orchestration
  + OpenAI Agents JS 作为 local leaf-agent runtime
  + 视需要接 Vercel AI SDK 做 model/provider 统一层
```

### 当前不推荐

- **不推荐只用 AI SDK 直接起步**
  - 原因不是它不好，而是它对 HuanLink 当前阶段来说偏薄。
  - 如果你已经决定不再自研通用 Agent Loop，那么只用 AI SDK 会让你重新补回太多运行时工作。

- **不推荐让 AgentKit 在 P0 直接成为主 orchestration 框架**
  - 原因不是它不强，而是它的强项正好和 HuanLink 想自己掌控的外层 orchestration 高度重叠。
  - 这样容易出现“HuanLink 和框架都想当 orchestrator”的冲突。

最短结论就是：

```text
P0 最稳的路线：
HuanLink 自己做外层，
OpenAI Agents JS 做单次 run，
AI SDK 作为可选 provider 统一层。
```

## 4. 比较维度

本次对比只看和 HuanLink 当前目标最相关的维度：

1. 它在系统里更像哪一层
2. 是否自带单次 agent loop
3. 是否会强接管 orchestration
4. multi-agent 能力在什么层级
5. 对群聊外层控制是否友好
6. 对异步 AgentCall 是否友好
7. 对后续 A2A / Router 是否容易衔接
8. Demo 速度和接入成本

## 5. 候选一：Vercel AI SDK

## 5.1 它到底是什么

从官方文档看，AI SDK 的核心定位仍然是：

- 统一模型 / provider 调用层
- `generateText` / `streamText`
- tool calling
- structured output
- middleware / provider 扩展

文档中确实已经出现了：

- 多步 tool calling
- `stopWhen: isStepCount(...)`
- `Agent` 接口

但整体上，它仍然更像：

```text
AI 基础设施工具箱
```

而不是一套强运行时立场的完整 agent orchestration 框架。

## 5.2 对 HuanLink 的优点

- 轻
- TS 体验很好
- 多 provider / 多模型适配非常自然
- streaming 很成熟
- tool calling 边界清楚
- 更容易保持 HuanLink 外层控制权

如果 HuanLink 仍然坚持大量自定义 runtime 逻辑，AI SDK 会非常合适。

## 5.3 对 HuanLink 当前阶段的限制

HuanLink 当前已经明确：

> 不再自研通用 Agent Loop

而 AI SDK 的问题恰恰在这里。

它虽然已经有 agent 能力，但从当前官方材料看，它更像：

- 让你更容易搭 agent
- 给你多步 tool loop 和 agent 抽象

而不是像 `OpenAI Agents JS` 那样，把：

- 单次 run loop
- approval / interrupt / resume
- session
- tracing

这些都更完整地组织成一个现成 runtime。

所以如果 P0 直接只用 AI SDK，你大概率仍然要自己补：

- 更多单次 run 管理
- 更多 agent 结果组织
- 更多中断恢复语义
- 更多工具流程控制

### 5.4 结论

AI SDK 对 HuanLink **非常值得接入**，但更适合作为：

```text
model/provider 统一层
可复用的 tool-calling / streaming 基础设施层
```

而不适合在当前阶段单独承担全部 leaf-agent runtime 职责。

## 6. 候选二：OpenAI Agents JS

## 6.1 它到底是什么

从官方文档和本地源码看，`OpenAI Agents JS` 已经是一套明确的 agent runtime：

- built-in agent loop
- tools
- guardrails
- human in the loop
- sessions
- tracing
- agents as tools
- handoffs

也就是说，它不是“帮你拼一套 run loop 的工具包”，而是：

```text
已经能独立跑单次 Agent Run 的执行框架
```

## 6.2 对 HuanLink 的优点

对于 HuanLink 当前 P0，这恰好解决了最现实的问题：

- 你不想再自己做通用单次 loop
- 你仍然需要工具调用
- 你仍然希望后续有 approval / resume 空间
- 你需要较快做出可信 demo

它的优势是：

- P0 接入最快
- 单次 run 概念最完整
- multi-agent 至少已有两种内建模式：
  - `agent.asTool()`
  - `handoff`
- 对“本地垂类 Agent”很容易先做出原型
- 官方还有和 AI SDK 的桥接层

## 6.3 它对 HuanLink 的真实代价

它的问题也很明确：

- runtime ownership 比 AI SDK 强得多
- session / tracing / approvals / run state 都有自己的语义
- 如果把它放到系统最外层，很容易把 HuanLink 做成“某框架上的 app”

但基于 20 草案，这个问题已经可以被重新解释。

现在 HuanLink 自己不再抢单次 loop ownership，而是要做：

- group chat outer orchestration
- AgentCall / AsyncGateway
- A2A / Router
- EventLog

在这个新定位下，`OpenAI Agents JS` 的合适位置就变成了：

```text
被 HuanLink 调用的 local leaf-agent runtime
```

而不是“整个平台的总框架”。

### 6.4 对群聊和异步 AgentCall 的适配性

这套框架对 HuanLink 的好处不是它懂群聊，而是：

- 它负责单次 run
- HuanLink 负责什么时候发起 run
- HuanLink 负责 AgentCall 生命周期
- HuanLink 负责异步任务完成后的再唤醒

也就是说，它不需要直接理解群聊时序，只需要作为被调用的单次执行器即可。

### 6.5 结论

如果你当前接受：

```text
框架负责单次 run
HuanLink 负责外层 orchestration
```

那么 `OpenAI Agents JS` 是当前三者里 **最适合 P0 起步** 的。

## 7. 候选三：Inngest AgentKit

## 7.1 它到底是什么

从官方文档看，AgentKit 的核心概念是：

- Agents
- Networks
- Router
- State
- Tracing

它天然强调：

- 多 agent 协作
- network 级共享状态
- 路由
- 编排

所以它更像：

```text
多 Agent orchestration framework
```

而不是单个 leaf-agent run 引擎。

## 7.2 对 HuanLink 的吸引力

它吸引人的地方很明显，因为它和你长期目标很像：

- 主控 agent
- 垂类 agent
- router
- state
- orchestration

从方向上说，它比 `OpenAI Agents JS` 更接近你长期想做的 “Agent Gateway / A2A / Routing” 气质。

## 7.3 为什么我仍然不推荐它作为 P0 主框架

问题不在于它不好，而在于：

```text
AgentKit 擅长的，正是 HuanLink 现在自己想掌控的那一层。
```

如果 P0 直接让 AgentKit 成为主 orchestration 框架，很容易出现：

- HuanLink 想做 Router
- AgentKit 也有 Router
- HuanLink 想做外层状态和调度
- AgentKit 也已经把 Network / State / Agent 协作组织起来了

这样就会产生两个风险：

1. **项目身份被稀释**
   - HuanLink 会更像 AgentKit 上的应用层封装

2. **边界容易打架**
   - 到底谁管 state
   - 到底谁管 routing
   - 到底谁管 agent collaboration

### 7.4 结论

AgentKit 很值得继续研究，但更适合：

- 作为 P1 / P2 的对照对象
- 用来借鉴 network / router / shared state 设计
- 在未来如果 HuanLink 决定减少自家 orchestration 负担时再重新评估

当前 P0 不建议直接把它放到最外层。

## 8. 三者对比表

| 维度 | Vercel AI SDK | OpenAI Agents JS | Inngest AgentKit |
| --- | --- | --- | --- |
| 更像哪一层 | 基础设施层 | 单次 agent runtime 层 | 多 agent orchestration 层 |
| 是否自带完整单次 run loop | 有一定能力，但整体偏轻 | 是 | 是，但更偏 network orchestration |
| 对外层控制权友好度 | 最高 | 中高 | 中 |
| P0 Demo 速度 | 中 | 最高 | 中 |
| 群聊外层接入难度 | 低 | 低到中 | 中 |
| 异步 AgentCall 衔接 | 需要自己补更多语义 | 比较合适 | 可做，但容易和 HuanLink 外层重叠 |
| 内建 multi-agent | 有限 | 有，`asTool` / `handoff` | 强，network / router / state |
| 对未来 A2A 的直接帮助 | 低到中 | 中 | 中到高 |
| 当前最主要问题 | 对你现在来说偏薄 | runtime ownership 强，但可放到内层 | orchestration ownership 太强，容易重叠 |

## 9. 对 HuanLink P0 的推荐接法

当前最推荐的接法是：

```text
Channel Adapter
  -> Buffer / Force Trigger
  -> ResponseGate
  -> HuanLink Orchestrator
       -> LocalAgentRuntimeAdapter
            -> OpenAI Agents JS
       -> AsyncGateway
       -> AgentCall Router
       -> EventLog
  -> Egress Sender
```

其中：

### HuanLink 自己做

- 群聊 ingress
- buffer
- 强制触发
- ResponseGate
- MainAgent 外层调度
- AsyncGateway
- AgentCall 统一语义
- EventLog / Replay

### `OpenAI Agents JS` 做

- MainAgent 单次 run
- 垂类 Agent 单次 run
- 工具调用
- 可选的 approval / resume / session

### `Vercel AI SDK` 可选接入

放在模型 / provider 层：

```text
OpenAI Agents JS
  -> AI SDK bridge / provider adapter
  -> openai / anthropic / google / gateway ...
```

这样做的好处是：

- P0 能快
- HuanLink 的新定位不丢
- 后面要替换 provider 不会太痛

## 10. 为什么不是 “AI SDK + 全自研外层 + 自补 run”

如果你现在仍然想完全自己控制内层 run，这条路线没问题。

但你前面已经明确决定：

> 不再自研通用 Agent Loop

那这条路线的代价就又会回到：

- 自己补更多单次 run 语义
- 自己补更多工具流程控制
- 自己补更多任务组织

这会重新把你拖回 runtime 内核工作。

所以在当前前提下，不推荐把 AI SDK 单独当主方案。

## 11. 为什么不是 “直接让 AgentKit 做总 orchestration”

因为 HuanLink 当前最珍贵的东西已经不是单个 agent 的 loop 了，而是：

- 群聊外层时序
- ResponseGate
- AsyncGateway
- AgentCall
- A2A / Router

如果现在就把 orchestration 主权交给 AgentKit，虽然能少写不少东西，但 HuanLink 的项目身份会迅速偏向：

```text
AgentKit-based multi-agent app
```

而不是：

```text
拥有自己群聊调度和 A2A 边界的 orchestrator
```

## 12. 当前推荐决策

### 推荐结论

P0 首推：

```text
OpenAI Agents JS
```

作为：

```text
HuanLink 内部的 local leaf-agent runtime
```

### 配套建议

- 如需尽早统一多 provider，补接 `Vercel AI SDK`
- `AgentKit` 暂列为继续观察对象，不作为 P0 主路线

### 这条路线最适合当前你的原因

它同时满足三件事：

1. 不再自己写通用单次 loop
2. 还能保住 HuanLink 的外层 orchestration 身份
3. 能尽快做出群聊 + 异步 AgentCall + 垂类 Agent 的可信 demo

## 13. 下一步最值得做什么

基于当前结论，下一步不该继续泛泛研究“还有哪些框架”，而应该直接做：

1. 定义 `LocalAgentRuntimeAdapter` 边界
2. 设计 `MainAgent` 和 `SpecialistAgent` 的最小接入方式
3. 确定是否在 P0 同时接入 AI SDK provider 层
4. 做一条最小 spike：
   - MainAgent 单次 run
   - 发起一次异步 AgentCall
   - task 完成后再唤醒 MainAgent
   - 回复回群

## 最短总结

三套候选里：

- `AI SDK` 最轻，但对你当前阶段来说偏薄
- `OpenAI Agents JS` 最适合当前 P0，当 local leaf-agent runtime 最稳
- `AgentKit` 很像你长期方向，但现在放到最外层会和 HuanLink 的外层 orchestration 打架

所以当前最推荐的路径是：

```text
HuanLink 做外层 orchestration
+ OpenAI Agents JS 做单次 run
+ AI SDK 作为可选 provider 统一层
```
