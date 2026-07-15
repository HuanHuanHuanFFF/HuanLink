# HuanLink / 幻联

> 连接不同平台上的 Agent，让它们围绕你的目标共同工作。

HuanLink 是一个跨平台 Agent 协作与编排项目。

今天的 Agent 能力分散在不同应用、平台和运行环境中。编码、研究、数据分析和自动化 Agent 各有所长，但用户仍然需要反复切换界面、提供上下文，并手动跟踪任务结果。

HuanLink 不试图重新实现所有专业 Agent，而是提供一个统一的协作层：用户通过 MainAgent 提出需求，MainAgent 结合当前上下文选择合适的 Agent，HuanLink 负责调用、跟踪任务，并将结果带回用户所在的会话。

## HuanLink 如何工作

```text
用户 / Channel
      ↓
MainAgent 理解目标并作出决策
      ↓
HuanLink 创建和管理 AgentCall
      ↓
调用不同平台上的专业 Agent
      ↓
汇总状态与结果，返回原会话
```

HuanLink 关注外层协作，包括连接不同 Channel、工具和 Agent，传递任务与上下文，管理异步任务生命周期，以及通过 A2A 等标准协议降低不同平台之间的耦合。

## HuanLink 可以用来做什么

- **个人 Agent**：通过一个长期使用的 MainAgent，调用编码、研究、数据分析等专业 Agent。
- **群聊与团队协作**：让群成员共同提出需求、查看任务状态并接收执行结果。
- **后台任务与自动化**：让耗时任务持续运行，用户无需阻塞等待或手动检查结果。

## 已验证的真实 Demo

HuanLink 已经完成第一条真实的跨平台 Agent 协作链路：

1. 用户在真实 QQ 群中向 DeepSeek MainAgent 提出代码任务。
2. MainAgent 理解需求并创建异步 AgentCall。
3. HuanLink 通过标准 A2A v1.0 调用 Codex。
4. 官方 Codex app-server 在独立进程中执行真实代码修改。
5. 用户可以查询任务状态，并在任务完成后从原 QQ 会话收到结果。

这条链路使用真实 QQ、真实 MainAgent、标准 A2A 通信和真实 Codex，没有使用 mock 替代最终闭环。QQ 和 Codex 是当前用于验证产品方向的第一组实现，并不是 HuanLink 的产品边界。

### Demo 验证截图

**1. 从 QQ 提交任务并接收异步结果**

![QQ 中提交任务并接收异步结果](docs/dev/img/HuanLink%20demo测试0.png)

用户在 QQ 中提交代码任务后，会先收到任务受理信息；Codex 完成执行后，结果自动返回原会话。

**2. Codex 执行真实代码修改**

![Codex 执行真实代码修改](docs/dev/img/HuanLink%20demo测试2.png)

任务通过标准 A2A v1.0 交给官方 Codex app-server，并在真实工作区完成文件修改与结果验证。

## 下一步

真实 Demo 已经证明核心链路可以成立。HuanLink 接下来将进入 v1.0 正式开发阶段，逐步完善个人 Agent 使用体验、项目和工作目录选择、模型配置、通用异步工具调用，以及更多 Channel 和外部 Agent 的接入能力。

## 文档

- [A2A-First 真实 Demo 计划](docs/dev/23-a2a-first-real-demo-plan.md)
- [HuanLink v1.0 产品需求草稿](docs/dev/24-huanlink-v1-product-requirements-draft.md)
