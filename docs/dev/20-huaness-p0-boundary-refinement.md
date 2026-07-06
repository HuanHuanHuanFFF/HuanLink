# HuanLink P0 边界细化草案

调查日期：2026-07-07

## 声明

这是一份 **P0 阶段的工作草案**，目的是帮助当前选型、架构讨论和最小实现推进。

它 **不是最终规格**，也 **不试图一次性锁死后续设计**。下面的边界、术语和链路主要服务于：

- 当前框架选型
- P0 主链路落地
- 统一讨论语言

后续如果群聊机制、异步任务、A2A 协议、Agent 调度方式发生变化，本草案可以直接调整，不把当前实现绑死。

## 1. 当前项目定位

当前阶段，HuanLink 暂定为：

> 面向群聊场景的多 Agent Orchestrator，同时作为 A2A 跨平台协作实验平台。

它不再自研通用 Agent Loop。单次 Agent Run 交给成熟框架，HuanLink 重点掌控：

- 群聊入口和消息标准化
- 群聊缓冲、触发和外层调度
- 异步任务生命周期
- AgentCall 路由
- A2A 扩展边界
- EventLog / Replay

这里的重点不是“再造一个通用 Agent Runtime”，而是：

```text
把成熟框架降级为单次 Agent Run 执行器，
把 HuanLink 本身抬升为群聊与多 Agent 编排层。
```

## 2. P0 主目标

P0 不追求完整平台能力，只追求先跑通一条可信的主链路：

```text
群聊消息进入
-> buffer / 强制触发
-> ResponseGate
-> MainAgent
-> 发起一次异步 AgentCall
-> 立即返回 taskId
-> 任务完成后唤醒 MainAgent 新 turn
-> MainAgent 读取最新群聊上下文
-> 决定是否回复并生成回复
```

P0 约束：

- 只接入一个群聊渠道
- 只接入一个垂类 Agent
- 只要求一条异步 AgentCall 主链可用
- 不要求完整多 Agent 网络
- 不要求完整远端 A2A 协议落地

## 3. HuanLink 的两层运行边界

当前建议把运行链路分成两层。

### 3.1 内层 run

内层 run 指单次 Agent 执行过程中由框架负责的部分，例如：

- 模型调用
- 基础 tool loop
- streaming
- 最终结果生成
- 框架自带的 session / approval / interrupt / resume（是否采用，后续视选型决定）

### 3.2 外层 orchestration

外层 orchestration 指 HuanLink 自己掌控的部分，例如：

- 群聊消息何时进入一次 run
- 哪些消息被合并
- 是否值得进一步处理
- 是否触发 MainAgent
- 何时发起 AgentCall
- 异步结果何时回流
- 新 turn 如何被唤醒
- 事件如何统一记录

P0 的主要开发重点在第二层，而不是第一层。

## 4. 群聊主链路边界

### 4.1 消息入口

群聊消息进入 HuanLink 后，先经过入口标准化，再进入群级缓冲区。

P0 暂定：

- 以群为粒度维护缓冲
- 支持普通入缓和强制触发两种路径
- 强制触发包括但不限于 `@`、提名、明确要求回复等

这里先不把具体平台绑定死，统一按“标准化后的群聊消息”处理。

### 4.2 缓冲与刷新

P0 暂定：

- 普通消息先进入 buffer
- 根据最近一两分钟发言频率动态调整刷新时机
- 强制触发时可立即刷新

这里的目标不是做复杂算法，而是先证明：

```text
群聊消息不是逐条直接送进 Agent Run，
而是先经过 HuanLink 的外层时序控制。
```

### 4.3 ResponseGate

Gate 只负责判断消息是否值得进一步处理。

输入可以包括：

- 近期消息流
- 最近上下文
- 发送者、时间、引用、提及关系
- 图片等媒体的 `assetId` 和基础元信息

输出至少包含：

```text
respond
wait
ignore
```

当前边界下，Gate 不直接接触：

- 工具调用
- 工具结果
- AgentCall 结果
- 异步任务结果
- 图片内容解析

也就是说，Gate 更像群聊前置筛选层，而不是一个完整 Agent。

## 5. MainAgent 边界

MainAgent 使用框架提供的单次 Agent Run 能力。

P0 阶段，MainAgent 暂定负责：

- 理解群聊消息
- 决定是否回复
- 调用普通工具
- 发起 AgentCall
- 接收任务完成结果
- 结合最新群聊上下文生成最终回复

这里有一个重要边界：

```text
Gate 放行
!=
MainAgent 必须回复
```

Gate 只是决定“是否值得进一步处理”，最终是否发言仍然由 MainAgent 决定。

## 6. AgentCall 统一语义

为了避免后续语义分裂，当前建议统一使用 `AgentCall` 这个概念。

在 HuanLink 里，下列行为都可以先统一看成 `AgentCall`：

- 调用本地垂类 Agent
- 调用远端 A2A Agent
- 同步执行的 agent 子任务
- 异步执行的 agent 子任务

也就是说：

```text
“向某个 agent 发起一次任务请求，并等待结果、状态或回调”
```

都统一归到 `AgentCall` 语义下。

P0 阶段只落地其中一种最小形式：

- 本地垂类 Agent
- 异步执行
- 返回 `taskId`
- 完成后回流 MainAgent

这里先统一语义，不急着把协议完全定死。

## 7. AsyncGateway 边界

P0 里，建议把异步能力收敛到一个自研 `AsyncGateway`。

它的职责暂定为：

- 接收 MainAgent 发起的异步 AgentCall 请求
- 创建任务并返回 `taskId`
- 维护任务状态
- 在任务完成后触发回流

当前最小状态集建议为：

```text
queued
running
succeeded
failed
cancelled
```

当前草案下，任务完成后的结果 **绕过 Gate**，直接投递给 MainAgent，创建新的 MainAgent turn。

这里有一个有意保留的边界：

- 新 turn 读取的是 **任务完成当时的最新群聊上下文**
- 不强制复用发起任务时的旧上下文快照

这样更贴近群聊实时场景，但具体的上下文合并和结果过期策略，后续仍可调整。

## 8. 资产与媒体边界

P0 里，图片先不作为主流程智能解析对象，而是先作为资源处理。

暂定方式：

- 图片进入后分配 `assetId`
- 提前异步下载、缓存或预处理
- 不阻塞群聊消息主流
- Gate 只看到 `assetId` 和基础信息
- MainAgent 需要时再通过 `assetId` 获取图片内容

文件处理先不纳入 P0 主链。

## 9. HuanLink 自己掌控的层

P0 暂定由 HuanLink 自己掌控的层包括：

- Channel ingress 和标准化
- 群聊消息 buffer
- 强制触发规则
- ResponseGate
- MainAgent 外层调度
- AsyncGateway 和任务生命周期
- AgentCall / Router 语义
- EventLog / Replay

这些层决定系统行为，因此不建议直接交给单一框架接管。

## 10. 可交给框架的层

P0 暂定可优先交给成熟框架的层包括：

- 单次 MainAgent run
- 模型调用
- 基础 tool loop
- streaming
- 最终回复生成

下面这些能力是否使用框架原生实现，暂不在本草案中定死：

- session
- 普通工具执行
- approval
- cancel / resume
- 框架内 multi-agent orchestration

这部分应以实际选型结果和接入成本为准。

## 11. P0 最小事件视角

当前还不建议把 EventLog 规格写得过重，但可以先有一个最小视角，帮助后续调试和 replay。

P0 至少应能看见这些阶段：

- 消息进入
- buffer 刷新
- Gate 决策
- MainAgent turn 开始
- AgentCall 发起
- 任务状态变化
- MainAgent 被再次唤醒
- 回复发送或跳过

这里先强调“看得见链路”，不急着一次性设计完整审计模型。

## 12. 当前故意不写死的部分

为了不限制开发，下面这些问题当前只保留方向，不在本草案中定死：

- buffer 的具体算法和阈值
- Gate 的最终实现形式
- MainAgent 的 prompt 结构
- AgentCall 的完整请求/响应协议
- 异步任务结果的过期策略
- 多任务并发冲突策略
- 远端 A2A 的 transport / auth / retry 细节
- 多垂类 Agent 的路由方式
- 复杂上下文压缩策略
- Eval / Self-improve 接入形态

这些点后续都可能边开发边收敛。

## 13. 对后续框架选型的真实要求

基于当前草案，后续框架选型最需要回答的不是“功能最多的是谁”，而是：

1. 谁适合做单次 Agent Run 执行器
2. 谁最不容易干扰 HuanLink 的外层 orchestration
3. 谁更方便承接普通工具、streaming、approval、resume
4. 谁更容易被包在 `LocalAgentRuntimeAdapter` 后面
5. 谁不会把后续 A2A / Router / EventLog 语义绑死

也就是说，HuanLink 当前不是在选“整个系统框架”，而是在选：

```text
最适合作为 HuanLink 内部 leaf-agent runtime 的执行引擎
```

## 最短总结

当前阶段，HuanLink 的核心不再是自研单 agent loop，而是：

- 群聊外层时序控制
- AgentCall 统一语义
- 异步结果回流
- 多 Agent 编排
- A2A 扩展边界

P0 先围绕这一条最小主链落地即可，不要求把所有未来问题一次性定死。
