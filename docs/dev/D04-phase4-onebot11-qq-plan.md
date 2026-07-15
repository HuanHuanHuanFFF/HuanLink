# Phase 4 OneBot 11 QQ Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task by task, and stop at the Phase 4 gate from `23-a2a-first-real-demo-plan.md`.

**Goal:** 让真实 QQ 群消息通过 LLBot/NapCat 共用的 OneBot 11 正向 WebSocket 触发 MainAgent，立即收到带 taskId 的受理回复，并在 AgentCall 终态后结合最新群聊上下文收到最终回复。

**Architecture:** 新的 OneBot 11 integration 独占 wire 类型、Bearer 鉴权、事件/API frame 分流和 `send_group_msg`；Core 只增加协议无关的 Channel 消息合同与固定窗口会话存储；`apps/server` 将 Channel、现有 Phase 3 runtime 和 QQ egress 组装成可启动进程。沿用现有 AgentCall/A2A/Codex 链路，不实现 HTTP Channel、智能插话、持久化或通用插件系统。

**Tech Stack:** TypeScript/Node.js、Vitest、`ws@8.21.0`、OpenAI Agents JS、OneBot 11、pnpm workspace。

---

## 文件职责

- Create: `packages/core/src/channels/types.ts`：框架无关的 Channel 消息、触发和发送合同。
- Create: `packages/core/src/conversations/in-memory-conversation-store.ts`：按 session 保存固定窗口消息与原会话路由。
- Modify: `packages/core/src/agent-call/agent-call-service.ts`：按 run 查询 AgentCall，供首次回复机械附加 taskId。
- Create: `packages/integrations/onebot11/`：OneBot 11 正向 WebSocket integration，外部协议类型不进入 Core。
- Create: `apps/server/src/phase4-qq-runtime.ts`：QQ ingress、MainAgent 首次 run、最新上下文和终态 egress 的组装。
- Create: `apps/server/src/main.ts`：真实 HuanLink server 启动与关闭入口。
- Modify: `apps/server/src/runtime-config.ts`：OneBot WS URL、token、目标群和命令前缀配置。
- Modify: `.env.example`：列出 Phase 4 启动所需变量，不写真实凭据。

## Task 1：Core Channel 和会话合同

**Files:**

- Create: `packages/core/src/channels/types.ts`
- Create: `packages/core/src/conversations/in-memory-conversation-store.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/agent-call/agent-call-service.ts`
- Test: `packages/core/tests/in-memory-conversation-store.test.ts`
- Test: `packages/core/tests/agent-call-service.test.ts`

1. 先写失败测试，验证不同 session 隔离、固定窗口淘汰、普通未触发消息仍进入最新上下文，以及 session 能找到原 Channel conversation。
2. 定义最小协议无关输入：

   ```ts
   type InboundChannelMessage = {
     channel: "onebot11";
     conversationId: string;
     messageId: string;
     senderId: string;
     senderName: string;
     text: string;
     receivedAt: string;
     trigger?: { kind: "mention" | "command"; text: string };
   };
   ```

3. 实现内存固定窗口 store；Demo 默认每个 session 保留最近 50 条，不做数据库与跨重启恢复。
4. 给 `AgentCallService` 增加 `listByRunId(runId)`，返回克隆记录；Phase 4 用它机械生成 taskId 回执，不解析模型文本。
5. 运行 `corepack.cmd pnpm --filter @huanlink/core test`，确认 RED 后最小实现至 GREEN。

## Task 2：OneBot 11 正向 WebSocket integration

**Files:**

- Create: `packages/integrations/onebot11/package.json`
- Create: `packages/integrations/onebot11/tsconfig.json`
- Create: `packages/integrations/onebot11/tsconfig.build.json`
- Create: `packages/integrations/onebot11/src/types.ts`
- Create: `packages/integrations/onebot11/src/group-message.ts`
- Create: `packages/integrations/onebot11/src/forward-websocket-channel.ts`
- Create: `packages/integrations/onebot11/src/index.ts`
- Create: `packages/integrations/onebot11/tests/group-message.test.ts`
- Create: `packages/integrations/onebot11/tests/forward-websocket-channel.test.ts`
- Modify: `pnpm-lock.yaml`

1. 先写协议失败测试，使用标准 OneBot 11 JSON frame 覆盖：群消息数组、`at.qq === self_id`、`/huanlink` 前缀、自身消息、非群消息、meta event 和畸形 frame。
2. 精确依赖 `ws@8.21.0` 和 `@types/ws@8.18.1`；HuanLink 主动连接 LLBot/NapCat 的根路径 `/`，token 只通过 `Authorization: Bearer ...` 握手头发送。
3. 收到 `post_type` frame 时作为事件分流；收到带 `echo` 的 frame 时匹配 pending action。非法或无关 frame 只报告错误/忽略，不终止 reader loop。
4. `sendMessage()` 使用标准请求：

   ```json
   {
     "action": "send_group_msg",
     "params": {
       "group_id": 20002000,
       "message": [{ "type": "text", "data": { "text": "已受理" } }]
     },
     "echo": "send-group:<uuid>"
   }
   ```

5. 仅在 `status === "ok" && retcode === 0` 时完成发送；非零 retcode、超时和 socket close 都拒绝对应 Promise。
6. 断线后做有界简单退避并重新连接；主动关闭不重连，断线时不自动重放未确认的 `send_group_msg`。
7. 运行 `corepack.cmd pnpm --filter @huanlink/integration-onebot11 test`，逐项确认 RED/GREEN。

## Task 3：Phase 4 QQ 编排

**Files:**

- Create: `apps/server/src/phase4-qq-runtime.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/package.json`
- Create: `apps/server/tests/phase4-qq-orchestration.test.ts`

1. 先写失败黑盒测试：普通群消息只更新上下文；明确 @ 或 `/huanlink` 才运行 MainAgent；首次回复回原群并机械包含 HuanLink taskId 与 A2A taskId。
2. 所有非自身群消息先写入 store；触发消息使用稳定 session：

   ```text
   onebot11:group:<groupId>
   ```

3. Channel 消息回调只启动受监管 Promise，不等待 MainAgent；同一 socket 必须继续接收 Codex 工作期间的新群消息。
4. 首次 MainAgent 结果返回后，从 `listByRunId(runId)` 取得本次 AgentCall，并把 ID 追加到群回复。
5. 复用 Phase 3 的 `getLatestContext(sessionId)` 与 `onReentry(result)`：终态 fresh turn 读取当时最新窗口，并只向该 session 绑定的原群发送一次结果。
6. 用确定性 Runner 和受控 AgentCall transport 验证：远端未完成时第二条群消息已经被处理；释放终态后 re-entry 输入包含第二条消息；其他群不会收到回复。
7. 运行 `corepack.cmd pnpm --filter @huanlink/server test`。

## Task 4：真实启动配置和进程入口

**Files:**

- Create: `apps/server/src/main.ts`
- Modify: `apps/server/src/runtime-config.ts`
- Modify: `apps/server/tests/runtime-config.test.ts`
- Modify: `apps/server/package.json`
- Modify: `.env.example`

1. 先写配置失败测试，验证仅接受 `ws:`/`wss:` URL、目标群 ID 必须为正整数文本、命令前缀非空、token 可选。
2. 增加以下启动变量：

   ```text
   HUANLINK_ONEBOT_WS_URL=ws://127.0.0.1:3001/
   HUANLINK_ONEBOT_ACCESS_TOKEN=
   HUANLINK_ONEBOT_GROUP_ID=
   HUANLINK_ONEBOT_COMMAND_PREFIX=/huanlink
   HUANLINK_CODEX_A2A_ORIGIN=http://127.0.0.1:4000
   ```

3. `main.ts` 创建真实 OneBot channel、Phase 4 runtime 和默认真实 OpenAI Agents Runner；监听 `SIGINT/SIGTERM` 并有序关闭 Channel 与 AgentCall watcher。
4. 增加 `start` script，构建产物从 `dist/main.js` 启动；不增加 CLI 输入作为 Channel 替代。
5. 运行 server test、typecheck 和 build，并对本地不可达 WS 验证启动错误可读且不会泄露 token。

## Task 5：Phase 4 真实 QQ 核验、记录与推送

**Files:**

- Modify: `docs/dev/23-a2a-first-real-demo-plan.md`
- Modify: `docs/dev/D04-phase4-onebot11-qq-plan.md`（仅记录实际偏差与核验结果）

1. 运行全仓 `test`、`typecheck`、`build`，检查 `git diff --check`。
2. 启动真实 Codex A2A Adapter 和 HuanLink server，连接真实 LLBot/NapCat 正向 WebSocket。
3. 在配置的真实 QQ 群发送明确 @/命令，观察群里先收到两个 task ID；Codex 工作期间继续发送一条上下文消息，确认消息处理没有阻塞。
4. 等待终态 fresh turn，确认最终结果发回同一群且包含最新消息语义。自动测试或 CLI 输入不能替代该步骤。
5. 文档提交和代码提交保持分离，使用清楚的中文 Conventional Commit；Phase 4 完成后推送 `origin/spike/demo-v0`，不 merge、不建 PR，并停在 Phase 4 gate 等待用户确认。

## Phase 4 实际验收记录（2026-07-14）

- 真实入口为 LLBot OneBot 11 正向 WebSocket，触发方式为 `/huanlink`；连接测试、MainAgent 回复和 QQ 原群路由均正常。
- 真实任务要求 Codex 将 HuanLink 项目概况写入仓库根目录的 `test.md`。群内先收到 HuanLink taskId 和 A2A taskId，任务以 `async` 模式在后台执行。
- 任务处于 `working` 时，用户可以继续查询同一任务、询问功能并发送其他群消息；MainAgent 使用任务状态查询能力，没有创建替代任务。
- Adapter 启动的 `codex app-server` 是独立进程，不依赖 Codex 桌面应用持续打开。Codex 最终完成真实文件修改，A2A 返回 Artifact，HuanLink 触发一次终态 re-entry 并将结果发回原群。
- 实际结果为 `test.md` 32 行、2365 bytes；QQ 回复中的项目摘要、文件路径和状态与 Codex 结果一致。本地两个 JSONL 文件能够关联同一个 AgentCall、A2A Task、Codex thread/turn、Artifact 与终态回流。
- 非阻塞观察：状态时间当前按 UTC 输出但没有标注时区；MainAgent 曾错误推测关闭 Codex 桌面应用会中断任务；自动完成通知与手动查询重叠时会连续产生两条完成说明。这些属于后续体验优化，不阻塞 Phase 4。
- 验收结论：Phase 4 通过。未引入 OneBot HTTP、反向 WebSocket、持久化任务或其他非目标；真实 `input-required` 场景按用户确认留待后续验证。

## 明确非目标

- OneBot HTTP、反向 WebSocket 和私有 LLBot/NapCat API。
- 智能插话、动态 buffer、完整 ResponseGate。
- 多群权限系统、持久化任务、消息补偿和发送重试。
- 通用 Channel 插件注册中心。
- 清理旧自研 AgentLoop、重写 Replay 或扩大 EventLog schema。
- Phase 5 的最终真实代码任务验收。
