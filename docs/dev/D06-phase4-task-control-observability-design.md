# Phase 4 任务控制与本地可观测性设计

> 状态：已确认，作为 `23-a2a-first-real-demo-plan.md` 的 Phase 4 增量设计。本文不扩大 Demo 到持久化、多项目或完整审计系统。

## 1. 目标

本轮补齐真实 QQ Demo 暴露出的四类问题：

1. DeepSeek MainAgent 开启 Thinking，推理强度固定为 `high`。
2. MainAgent 能查询当前会话中的 HuanLink 任务，不再把状态查询误提交给 Codex。
3. Adapter 不再把空结果误报为完成，并支持 `input-required` 回流 MainAgent 后继续同一 A2A Task。
4. HuanLink server 与 Codex A2A Adapter 将关键运行事件写入本地 JSONL，便于按关联 ID 还原链路。

## 2. 统一任务查询

MainAgent 新增只读工具 `get_task_status`。

- 产品主键是 HuanLink taskId；当前 Demo 同时接受 A2A taskId 作为查询别名。
- 只能查询当前 `sessionId` 创建的任务；跨 session 统一按未找到处理。
- 当前实现查询 `AgentCallService` 管理的 Codex/A2A 任务，工具契约保留为 HuanLink 通用任务查询。
- 返回任务状态、执行模式、创建/更新时间、状态说明、错误和 Artifact。
- 查询不得创建、继续或取消任务，也不得调用 Codex。

## 3. `input-required` 与同任务续跑

A2A Task 进入 `input-required` 时视为暂停结果，不视为成功或终态：

1. HuanLink 将暂停快照、问题、Artifact 和当前 session 的全部可用上下文交给新的 MainAgent turn。
2. 上下文包括群内输入、HuanLink 已发送回复和相关任务信息。
3. MainAgent 根据用户已有授权决定下一步：
   - 信息已经足够：调用 `continue_task`，向原 A2A `taskId` 发送补充 Message；
   - 需要新增需求或授权：向原 QQ 会话提问，等待用户回复后再继续原任务。
4. 继续任务必须复用原 A2A Task、context 和 Codex thread，不能新建替代任务。
5. 多个暂停任务有歧义时必须使用明确 taskId。

自动继续只能解释和执行用户已经授权的目标；扩大范围、权限、破坏性操作或关键需求歧义必须询问用户。

## 4. Adapter 结果语义

- 空 `agentMessage` 不得覆盖已有非空消息。
- Codex turn 结束不等于用户任务成功。
- 没有有效最终回答、文件变化或 diff 的代码任务不得报告 `completed`。
- 无关紧要的风格选择由 Codex 自行决定；真正缺少必要输入时进入 `input-required`。
- Adapter 返回的 A2A 状态、status message 和 Artifact 必须表达同一个结果。

## 5. 本地 JSONL 日志

两个进程分别追加写入：

```text
.huanlink/logs/server.jsonl
.huanlink/logs/codex-a2a-adapter.jsonl
```

记录进程和连接生命周期、QQ 收发、MainAgent run、工具调用、AgentCall、A2A 请求与状态、Adapter 任务、Codex thread/turn、Artifact、错误和最终回流。事件使用结构化字段关联：

```text
sessionId
runId
messageId
agentCallId
a2aTaskId
codexThreadId
codexTurnId
```

日志策略：

- `info` 记录脱敏、必要时截断的业务内容。
- `debug` 记录关键事件边界的完整业务内容。
- API Key、Token、Authorization、Cookie 和密码在所有级别强制脱敏。
- 第一版不记录逐 token 或每个 Codex delta，不做轮转、上传或检索界面。
- 文件写入失败报告到 stderr，但不应使业务任务崩溃。
- 本地 Demo 将 `HUANLINK_LOG_LEVEL` 设置为 `debug`。

## 6. 验证

- 单元测试覆盖模型选项、session 查询隔离、查询无提交副作用、暂停回流、同 taskId 续跑、Adapter 空结果判断和日志脱敏。
- 集成测试覆盖 `submitted -> working -> input-required -> working -> completed`。
- 默认 `test`、`typecheck`、`build` 通过后，执行真实 DeepSeek、QQ/A2A/Codex smoke。
- `test.md` 保持未跟踪且不参与任何提交。

## 7. 明确不做

- 服务重启后的任务或会话恢复。
- 跨 session 管理员查询、任务列表和日志 UI。
- 日志轮转、远程采集和完整审计系统。
- 任意文本启发式地把 Codex 问句判为 `input-required`。
- 多项目、每任务 worktree 或 Phase 5 之外的新产品能力。
