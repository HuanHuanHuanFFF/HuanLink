# 29. OpenClaw Channel 静默与长回复调查

> 调查日期：2026-08-01（Asia/Shanghai）
>
> OpenClaw：`https://github.com/openclaw/openclaw`，`main`，锁定 commit `749f5b2e271af41c59a5290cfde67facef2264fd`
>
> 社区 OneBot 参考：`https://github.com/LSTM-Kirigaya/openclaw-onebot`，`main`，锁定 commit `482cf0a949192003d41e0a55f2ed08695dd77fd3`
>
> 范围：只读源码调查；未修改业务代码，未执行 OpenClaw 测试。证据标记：`[S]` 源码事实；`[D]` 官方文档声明；`[C]` 社区插件事实；`[I]` 对 HuanLink 的推断或建议；`[N]` 未找到证据。
>
> **后续确认：** 2026-08-02，HuanLink 已结合 16 号 MaiBot 调查确认采用 Tool 驱动的当前会话回复，不采用本文初稿中的 `AgentTurnOutcome: silent | reply` 建议。下文 OpenClaw 源码事实保持不变，HuanLink 建议已按最新决定修订；实施以 D11 为准。

## 1. 调查版本与范围

调查开始时 OpenClaw `main` 为 `5332641ed3bab552d23fb16c67bc697a373ea9d7`，调查期间远端 HEAD 前进到 `749f5b2e271af41c59a5290cfde67facef2264fd`。本报告最终固定到 `749f5b2e`；最后一段变更只涉及 embedded Agent 准备耗时观测，没有修改本文引用的 Channel、静默和发送文件。

本地 `references/openclaw` 仍固定在较早的 `e3a6da0f518136a4277373afdf4b7f894c9e092f`。为避免把旧快照当作当前实现，本文所有 OpenClaw 链接都固定到 `749f5b2e`。

五条核心结论：

1. OpenClaw 并不默认把所有“通过平台访问控制”的普通群消息写入耐久 Session；`requireMention` 拦下的消息通常只进入 Adapter 的有界内存群历史。[S]
2. OpenClaw 当前实现了另一条更接近“看见但不说话”的路径：把未提及群消息分类为 `room_event`，仍运行 Agent、持久化用户 turn，但把可见回复改为必须显式调用 `message(action=send)`。[S]
3. 普通 Agent 最终文本默认由 Runtime 自动投递到原 Channel；`NO_REPLY` 是文本协议，`message_tool_only` 是发送副作用协议，二者都不是结构化的 `silent | reply` 模型结果。[S]
4. 官方 Telegram、Discord、Slack 都以“平台 Adapter/发送器分段”为主，没有把超长普通文本自动上传为文件或转为 OneBot 合并转发；阈值和 Markdown 修复按平台不同。[S][N]
5. 常用社区 OneBot 插件确实有可配置的自动合并转发，但它不是 OpenClaw 官方 Core：其 `forward` 模式先把内容发给 Bot 自己取得消息 ID，再调用群聊或私聊合并转发 Action。[C]

## 2. 入站消息和触发链路

### 2.1 一条 Telegram 群消息的实际链路

```text
Telegram update
-> Telegram handler
-> groupPolicy / group allowlist
-> 可选媒体组缓冲、文本 debounce
-> mention / command 判断
-> user_request 或 room_event 分类
-> runChannelInboundEvent
-> ChannelTurn kernel
-> route(sessionKey) + session metadata
-> Agent turn + user/assistant transcript
-> ReplyDispatcher
-> Telegram delivery
```

关键分层如下：

1. **平台访问控制先执行。** Telegram 的 `shouldSkipTelegramGroupMessage()` 先判断群/Topic 是否启用、群策略和发送者 allowlist；拒绝后直接返回，不进入 Agent 链路。[S] [`shouldSkipTelegramGroupMessage`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/bot-handlers.authorization-groups.runtime.ts#L16-L118)
2. **命令和 mention 在 Adapter 上下文构造阶段判断。** `buildTelegramMessageBody()` 先做命令授权，再结合原生 @、配置 mention pattern、回复 Bot 等事实得到 `mentionDecision`。[S] [`buildTelegramMessageBody`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/bot-message-context.body.ts#L193-L217)；[mention/classification](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/bot-message-context.body.ts#L311-L377)
3. **`requireMention` 会在 Agent 前直接截断。** 未命中 mention 时，代码写入 `groupHistories` 后返回 `null`；可选 `ingest` 只触发内部 `message.received` hook，不等于写 Agent transcript。[S] [`recordTelegramGroupHistoryEntry` 与 `return null`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/bot-message-context.body.ts#L378-L433)
4. **未提及消息也可以被分类为 `room_event`。** `classifyChannelInboundEvent()` 仅在配置 `unmentionedInbound: "room_event"`、群/频道消息且没有 mention、命令、abort 时返回 `room_event`。[S] [`classifyChannelInboundEvent`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/inbound-event/classification.ts#L23-L61)
5. **Adapter 把 route 和 delivery 注入通用内核。** Telegram 的 `runTelegramInboundTurn()` 提供 `route.agentId/sessionKey`、`ctxPayload` 和平台 delivery；`room_event` 同时指定 `sourceReplyDeliveryMode: "message_tool_only"`。[S] [`runTelegramInboundTurn`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/bot-message-dispatch-turn.ts#L96-L154)
6. **通用 Kernel 把 admission 和 Agent dispatch 分开。** `runChannelTurn()` 依次执行 `ingest -> classify -> preflight -> resolveTurn -> dispatch`；`handled/drop` 在 preflight 后直接返回，只有 `dispatch/observeOnly` 继续。[S] [`runChannelTurn`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/turn/kernel.ts#L186-L322)；[`ChannelTurnAdmission`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/turn/types.ts#L37-L48)
7. **Session metadata 与消息 transcript 是两次不同写入。** `runPreparedChannelTurnCore()` 在 Agent dispatch 前调用 `recordInboundSession()`；后者只记录 session metadata 和 last route。真正的用户消息由 Agent run 内的 `createUserTurnTranscriptRecorder()` 写入。[S] [`runPreparedChannelTurnCore`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/turn/execution.ts#L237-L322)；[`recordInboundSession`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/session.ts#L29-L83)；[用户 turn recorder](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/reply/get-reply-run-execute.ts#L202-L295)

### 2.2 对调查问题的直接回答

| 问题 | OpenClaw 当前答案 | 证据含义 |
|---|---|---|
| 允许范围内的普通群消息是否都写 Session？ | **否。** 通过群 allowlist 但未满足 `requireMention` 的消息只进内存群历史，随后返回 `null`。 | mention gate 的历史记录不是 Agent transcript。[S] |
| “写入 Session”和“触发 Agent”是否分开？ | **内部职责分开，但不是一个通用的“耐久写入后不运行”功能。** metadata record、transcript record、Agent dispatch 是不同模块；不过 transcript 用户 turn 仍依附 Agent run。 | 不能把 `recordInboundSession()` 误解为写入了聊天正文。[S] |
| mention、命令、白名单、群策略在哪判断？ | 白名单/群策略在 Adapter ingress authorization；mention/命令在 Adapter context/preflight；`room_event` 分类在通用 Channel inbound classifier；最终是否可见回复在 Agent reply policy。 | 是多层组合，不是一个 Gate 函数包办。[S] |
| 是否支持只记录消息、暂不运行 Agent？ | **未发现耐久 Session transcript 的一等实现。** 最接近的是内存 `groupHistories` 和可选内部 hook。 | `[N]` 不应把临时 prompt history 声称为 Session 消息。 |
| 是否支持运行 Agent、最终不回复 Channel？ | **支持。** `room_event + message_tool_only`、`NO_REPLY`、`observeOnly` 均可导致无可见发送。 | 三者语义不同，见下一节。[S] |
| 多条群消息是否缓冲/合并？ | **可选。** 通用 `messages.inbound.debounceMs` 默认 `0`；Telegram 按账号、会话、发送者和 lane 合并文本，控制命令与媒体默认不参与普通 debounce；转发 burst 固定使用 80ms lane。 | [`resolveInboundDebounceMs`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/inbound-debounce.ts#L23-L37)；[`shouldDebounceTextInbound`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/inbound-debounce-policy.ts#L16-L38)；[Telegram 合并](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/bot-handlers.inbound-debounce.runtime.ts#L55-L178) |

Telegram debounce 的多条消息会用换行合并成 synthetic message，并合并媒体和去重 claim；它不是“先逐条写 Session，再批量唤醒 Agent”，而是先合并，再形成一个 Agent turn。[S]

## 3. 静默/不回复机制

### 3.1 OpenClaw 实际存在的四种机制

| 机制 | 谁决定 | 是否运行 Agent | 是否调用 Channel send | 是否结构化 |
|---|---|---:|---:|---:|
| `NO_REPLY` | 系统提示词要求模型输出 | 是 | 否 | 否，文本哨兵 |
| `message_tool_only` 且未调用 `message(send)` | Runtime delivery policy + 模型工具选择 | 是 | 否 | 部分结构化：发送是 Tool Call，静默是“不调用” |
| 空输出 | 模型/Runner | 是 | 通常不直接发送；交互式 automatic 模式可能生成错误 fallback | 否 |
| `ChannelTurnAdmission.observeOnly` | Channel preflight | routed turn 会运行 Agent，但 delivery adapter 永远返回不可见 | 否 | 是，但它是入站 admission，不是 Agent 最终结果 |

OpenClaw **没有找到一个统一的 Agent 最终返回类型**，例如 `{ kind: "silent" } | { kind: "reply", ... }`。`ChannelTurnAdmission` 的 `dispatch/observeOnly/handled/drop` 是 Agent 运行前的入站决策，不应与 Agent 最终答复混为一谈。[S]

`observeOnly` 也不是“只入库不运行”：通用 lifecycle 为它注入不可见的 no-op delivery，但 routed turn 仍进入 Agent core。[S] [`observeOnly` delivery 与 dispatch](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/turn/lifecycle.ts#L353-L358)

### 3.2 `NO_REPLY` 的完整处理

1. `SILENT_REPLY_TOKEN` 固定为 `NO_REPLY`。[S] [`tokens.ts`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/tokens.ts#L1-L7)
2. System Prompt 明确要求“没话说时整条回复只能是 `NO_REPLY`，不得与真实回复混用”。[S] [`system-prompt.ts`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/agents/system-prompt.ts#L1381-L1387)
3. Parser 接受纯 token、JSON 字符串、仅含 `{ "action": "NO_REPLY" }` 的 JSON envelope，以及 reasoning 前缀后的 token。[S] [`isSilentReplyPayloadText`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/tokens.ts#L51-L115)；[payload 汇总判断](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/tokens.ts#L218-L237)
4. `normalizeReplyPayload()` 将纯静默标记归一化为 `null`；混在真实文本前后时会剥离 token，防止发送给用户。[S] [`normalizeReplyPayload`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/reply/normalize-reply.ts#L23-L81)
5. `ReplyDispatcher.enqueue()` 收到 `null` 直接返回，不进入 delivery queue，也不会调用 Adapter 发送。[S] [`ReplyDispatcher.enqueue`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/reply/reply-dispatcher.ts#L410-L432)

**Session 与上下文污染：** Agent session 基类会在 `message_end` 时持久化所有 `user/assistant/toolResult` 消息，因此原始 `NO_REPLY` assistant turn 会进入底层 Session 记录。[S] [`AgentSessionBase` persistence](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/agents/sessions/agent-session-base.ts#L372-L399) 但在构造下一次模型 replay 时，`normalizeAssistantReplayContent()` 会删除纯静默 assistant 内容和只剩 reasoning 的静默 turn，避免继续喂给模型。[S] [`normalizeAssistantReplayTextContent`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/agents/embedded-agent-runner/replay-history.ts#L223-L277)；[`normalizeAssistantReplayContent`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/agents/embedded-agent-runner/replay-history.ts#L306-L354)

因此控制标记不会进入平台可见消息，也不会进入后续模型上下文；但它仍可能存在于低层 Session/调试数据中。源码没有证明所有 UI、导出器都会隐藏该字段，不能把“发送时剥离”扩大成“任何观察面都绝不出现”。

### 3.3 `message_tool_only` 与空输出、失败的区别

`message_tool_only` 的提示词要求当前来源的可见回复必须调用 `message(action=send)`，最终文本保持私有；不调用 Tool 就没有可见消息。[S] [`buildMessagingSection`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/agents/system-prompt.ts#L587-L615) `room_event` 会强制选择该模式。[S] [`resolveSourceReplyDeliveryMode`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/reply/source-reply-delivery-mode.ts#L70-L115)

区分规则：

- `normalizeReplyPayload()` 通过 `empty | silent | heartbeat` 三种 skip reason 区分空文本和 `NO_REPLY`。[S]
- 在普通交互式 automatic 回复中，空输出且没有已提交发送、continuation 或显式静默时，会生成“turn 完成但没有可见回复”的失败 payload；在 `message_tool_only`、预期静默或允许空回复时不生成。[S] [`buildEmptyInteractiveReplyPayload`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/reply/agent-runner-failure-reply.ts#L489-L520)
- Context overflow、rate limit、terminal failure 等走显式错误 payload，而不是自动当成静默。[S] [`agent-runner-execution.ts`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/reply/agent-runner-execution.ts#L379-L453)

## 4. 普通回复发送链路

### 4.1 默认路径

默认情况下，Agent 不需要调用发送 Tool，也不直接接触 Channel Adapter：

```text
Agent runtime 产生 ReplyPayload
-> ReplyDispatcher.enqueue() 归一化
-> dispatchInboundMessageWithRoutedChannelDispatcher()
-> Channel delivery owner
-> delivery.deliver(payload, info)
-> Telegram/Discord/Slack Adapter
-> 平台 API
```

Channel lifecycle 在 `deliver()` 前统一执行 payload preparation、durable delivery、hook 与 delivery observer；真正的 Adapter 调用位于 `delivery.deliver(effectivePayload, info)`。[S] [`dispatchChannelTurnWithDeliveryOwner`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/turn/lifecycle.ts#L442-L598) Telegram 只把这个回调接到自己的 `params.reply.deliver()`。[S] [`bot-message-dispatch-turn.ts`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/bot-message-dispatch-turn.ts#L112-L136)

原路路由由 `route.sessionKey`、`ctxPayload` 和 session last route 共同承载；`recordInboundSession()` 会保存 `channel/to/accountId/threadId`，而不是让 Agent 保存 Adapter 实例。[S] [`recordInboundSession`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/session.ts#L61-L83)

### 4.2 其他发送入口

| 场景 | 入口 | 与普通回复的差异 |
|---|---|---|
| 当前会话普通最终回复 | Reply pipeline 自动 delivery | 默认入口；模型只生成内容。 |
| 当前会话 `message_tool_only` 回复 | `message(action=send)` | Tool 明确产生平台副作用；不调用即静默。 |
| 主动或跨目标发送 | `message` Tool -> `runMessageAction()` | 必须解析 channel、account、target、thread、授权和幂等信息。 |
| 跨 Agent session 消息 | `sessions_send(sessionKey, message)` | 是 Agent/session 通信，不等于向平台发消息。 |
| reaction/edit/delete/poll/管理操作 | `message` Tool 的 plugin-owned action | 经过 capability、action allowlist 和 Adapter action handler。 |

`createMessageTool()` 不自行发送，它将参数、可信 turn context、请求者身份和幂等键交给 `runMessageAction()`。[S] [`createMessageTool`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/agents/tools/message-tool.ts#L1405-L1435)；[Tool 调用 action runner](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/agents/tools/message-tool.ts#L1769-L1824) `runMessageAction()` 再解析 channel/plugin/账号和目标，`handleSendAction()` 最终调用通用 `executeSendAction()`。[S] [`runMessageAction`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/infra/outbound/message-action-runner.ts#L1906-L1956)；[`handleSendAction`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/infra/outbound/message-action-runner.ts#L1470-L1645)

## 5. 长消息与平台差异

### 5.1 通用层做什么

OpenClaw 没有一个适用于所有平台的统一字符数或字节数上限。通用 `ChannelOutboundAdapter` 允许每个平台声明 `chunker`、`chunkerMode` 和 `textChunkLimit`；用户配置也可按 channel/account 覆盖字符限制。[S] [`ChannelOutboundAdapter`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/plugins/outbound.types.ts#L169-L203)；[`CommonChannelMessagingConfig.textChunkLimit`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/config/types.channel-messaging-common.ts#L53-L62)

通用 sender 根据 Adapter 的 chunker 与配置生成多个发送 unit，并按顺序逐条 `await sendText()`；任意一条抛错会停止后续发送，已成功的前序消息不会回滚。[S] [`deliver-core.ts`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/infra/outbound/deliver-core.ts#L106-L150) `chunkMode` 支持：

- `length`：只在超限时拆分，优先换行和空白边界；
- `newline`：优先按空行分段，再在超长段落内按长度拆分；
- Markdown chunker 会避免在 fenced code block 内随意断开，并在必要时闭合、下一段重新打开 code fence。[S] [`chunkTextWithMode`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/chunk.ts#L181-L310)；[`chunkMarkdownText`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/auto-reply/chunk.ts#L383-L457)

### 5.2 平台对比

| 平台 | 默认/硬边界 | 实际策略 | Markdown/富文本 | 部分失败 |
|---|---:|---|---|---|
| Telegram | Adapter 默认 4000 字符；Bot API 普通文本上限 4096，代码留安全余量 | 长文本拆成连续多条；媒体 caption 超限时，媒体先发，文本另发 follow-up | Markdown 先转 Telegram HTML 再分段；HTML 有安全 splitter；富文本有独立上限 | 顺序发送，失败即抛出；已发前段保留，成功时 receipt 可含多个 messageId |
| Discord | 2000 字符；默认软限制 17 行 | 按字符和行高拆成多条 | 维护 code fence 的闭合/重开，并修复 reasoning italics | 顺序发送；失败停止，无回滚；成功结果汇总 `platformMessageIds` |
| Slack | OpenClaw 使用 8000 字符 chunk；Slack `chat.postMessage` 的源码注释记录 40000 字符硬截断 | 发送器内部拆成多条 `chat.postMessage` | 先转 Slack mrkdwn，保护 code marker、mention/link angle token 和转义实体 | 顺序发送；每段附 `partIndex/partCount` metadata 供 reconciliation，失败不回滚前段 |

Telegram 证据：[`TELEGRAM_TEXT_CHUNK_LIMIT`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/outbound-adapter.ts#L39-L64)、[普通文本固定 4000 分段](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/send-message-text.ts#L292-L348)、[顺序发送与 receipt](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/send-message-text.ts#L217-L289)、[caption follow-up](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/telegram/src/send-message.ts#L258-L281)。

Discord 证据：[`DISCORD_TEXT_CHUNK_LIMIT = 2000`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/discord/src/outbound-adapter.ts#L137-L155)、[2000 字符/17 行与 fence 规则](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/discord/src/chunk.ts#L7-L27)、[顺序发送](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/discord/src/send.shared.ts#L329-L397)。

Slack 证据：[`SLACK_TEXT_LIMIT = 8000`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/slack/src/limits.ts#L1-L10)、[配置限制与 mrkdwn 分段](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/slack/src/send.ts#L395-L435)、[分段 metadata 与顺序发送](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/slack/src/send.ts#L1299-L1412)、[受保护 token](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/slack/src/format.ts#L462-L526)。

**没有找到的官方行为：** 对 Telegram、Discord、Slack 的纯文本回复，未发现“超过阈值自动上传 `.txt` 文件”或“自动转换为平台长文对象”的通用逻辑。[N] 图片、文件、富文本 presentation 和普通文本走不同发送分支；已有文件 fallback 不能外推为纯文本自动转文件。

## 6. OneBot/合并转发调查

### 6.1 OpenClaw 官方仓库

固定 commit `749f5b2e` 中没有 `extensions/onebot`，也没有 `send_group_forward_msg` 或 `send_private_forward_msg` 实现。[N] 仓库只有一条兼容旧外部插件配置的注释提到“published undeclared OneBot adapter uses `httpUrl`”，这不能证明官方实现或能力。[S] [`setup-promotion-helpers.ts`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/src/channels/plugins/setup-promotion-helpers.ts#L26-L40)

官方仓库中的 `extensions/qqbot` 是 QQ Bot 插件，不是 OneBot 11；它自己的 README 只声明 QQ Bot 群聊和私聊工作流。[S] [`extensions/qqbot/README.md`](https://github.com/openclaw/openclaw/blob/749f5b2e271af41c59a5290cfde67facef2264fd/extensions/qqbot/README.md#L1-L11)

### 6.2 常用社区 OneBot 插件

社区仓库 `LSTM-Kirigaya/openclaw-onebot` 的固定 commit `482cf0a` 实现了自动长消息模式，但应标为社区证据：

- 配置支持 `normal | og_image | forward`，默认阈值 300 字符；只有选择 `forward` 且最终累计文本超限时才自动转合并转发。[C] [`setup.ts`](https://github.com/LSTM-Kirigaya/openclaw-onebot/blob/482cf0a949192003d41e0a55f2ed08695dd77fd3/src/setup.ts#L70-L112)
- `forward` 模式在非 final payload 阶段先缓存，不直接向原会话发送；final 时统计总长度。[C] [`process-inbound.ts`](https://github.com/LSTM-Kirigaya/openclaw-onebot/blob/482cf0a949192003d41e0a55f2ed08695dd77fd3/src/handlers/process-inbound.ts#L551-L609)
- 它把每个文本/媒体 chunk 先私聊发送给 Bot 自己，取得 `message_id`，再构造 `{ type: "node", data: { id } }` 节点；群聊调用 `send_group_forward_msg`，私聊调用 `send_private_forward_msg`。[C] [节点构造](https://github.com/LSTM-Kirigaya/openclaw-onebot/blob/482cf0a949192003d41e0a55f2ed08695dd77fd3/src/handlers/process-inbound.ts#L698-L719)；[OneBot Actions](https://github.com/LSTM-Kirigaya/openclaw-onebot/blob/482cf0a949192003d41e0a55f2ed08695dd77fd3/src/connection.ts#L394-L433)
- 合并转发失败时，代码关闭 suppression 并回退为普通分段发送。[C] [失败回退分支](https://github.com/LSTM-Kirigaya/openclaw-onebot/blob/482cf0a949192003d41e0a55f2ed08695dd77fd3/src/handlers/process-inbound.ts#L698-L720)

该插件使用模块级 `activeReplyTarget/activeReplySessionId/forwardSuppressDelivery` 管理当前回复并抑制重复发送。[C] [`reply-context.ts`](https://github.com/LSTM-Kirigaya/openclaw-onebot/blob/482cf0a949192003d41e0a55f2ed08695dd77fd3/src/reply-context.ts#L1-L80) 这对 HuanLink 是一个反例：在多群、多账号或并发 turn 下，全局可变状态容易串路由，不能直接照搬。

## 7. 与 HuanLink 的对照表

| HuanLink 初步设计 | 与 OpenClaw 的关系 | 判断 |
|---|---|---|
| 允许范围内消息全部进入对应 Session | 比 OpenClaw `requireMention` 路径更强；OpenClaw 被 gate 的消息只进内存群历史 | **可以保留。** 这是 HuanLink 面向群聊的明确产品选择，不必为了对齐 OpenClaw 改弱。[I] |
| Server 决定是否触发 Agent | 与 OpenClaw admission/classification 分层同方向，但 HuanLink 应把“消息入 Session”与“Agent trigger”真正解耦 | **直接借鉴分层，不照搬 gate 顺序。**[I] |
| Agent 显式调用当前会话 `reply` Tool | 接近 OpenClaw `message_tool_only`，也与 16 号 MaiBot 调查中的 Planner `reply` Action 同方向 | **已确认采用。** 普通最终文本不自动投递，不调用 `reply` 即无可见回复。[I] |
| `reply` Handler 调用 `channel.send()` | Agent 选择是否发言，但不持有 Adapter，也不能覆盖可信当前 route | **已确认采用。**[I] |
| Session 保留 Tool Call/Tool Result 和 Channel 回流消息 | OpenClaw 会持久化 Agent 消息和工具结果，并对 replay 做归一化 | **已确认采用结构化历史和关联投影。** 同一回复正文只在模型上下文中完整出现一次。[I] |
| OneBot Adapter 检查普通文本长度 | 对齐 OpenClaw 把平台限制留在 Adapter/发送器的边界 | **直接采用。**[I] |
| 超限自动转合并转发 | 官方 Core 无此能力，社区 OneBot 已证明协议上可行 | **作为 OneBot delivery policy，而非通用 Server 规则。**[I] |
| Agent 主动合并转发 Operation | 与自动 fallback 的意图、授权和输入不同 | **应共存，但必须是两个入口。**[I] |

### 7.1 回复与静默机制选择

HuanLink v1 已确认采用 Tool 驱动的当前会话回复：

```text
Agent
├─ reply(parts, replyToMessageId?)   -> 当前 session 可见回复
├─ 其他 Tool                         -> 查询或执行操作，不自动发到 Channel
└─ 未调用 reply                      -> 当前 turn 无 Channel 可见消息
```

约束如下：

- `reply` 是平台无关、仅限当前 session 的 Tool；目标 route 来自可信 run context，不接受 Agent 提供任意群号、私聊 ID 或 `channelId`；
- Agent 普通 `finalOutput`、推理过程和其他 Tool 执行过程不自动发送，避免任务处理中间状态刷入群聊；
- Agent session 在有效窗口内保留完整 Tool Call 和成对 Tool Result。`reply` Result 只返回状态、目标摘要和 `messageId`，不重复正文；
- 成功发送回执和 Bot 自身消息事件通过 `channelId + messageId` 关联。同一 session 的模型上下文保留 `reply` Call/Result，并把内容相同的回流事件压成简短确认；若平台实际内容不同，则完整保留平台事实；
- 跨会话发送在来源 session 保留发送 Tool Call/Result，在目标 session 保留完整 Channel 消息并显示简短的“由其他会话发起”标记；
- 不使用 `NO_REPLY` 文本哨兵，也不再建立 `AgentTurnOutcome: silent | reply` 作为主合同。没有调用 `reply` 与 Runner 异常仍由运行时状态区分。

### 7.2 长消息边界选择

- **Server：** 提供当前会话 `reply` Handler、可信 route、Tool 历史、发送关联和错误处理，不知道 OneBot 合并转发细节。
- **通用 Channel 合同：** 保留普通 `send()`、能力声明和稳定 receipt/error；可允许 Adapter 自己选择 delivery presentation，但不加入 `mergedForward` 这种 OneBot 词汇。
- **OneBot Adapter：** 根据配置、内容类型、平台能力和当前 route 决定普通发送、普通分段或合并转发。
- **OneBot Operations：** 显式合并转发继续存在，服务 Agent 主动指定节点、跨目标或平台专属操作，并经过单独 Policy/Approval。

自动合并转发与主动 Operation 共存时，必须避免递归：自动策略只能从普通 `channel.send()` 进入；Operation 必须直接调用具名 OneBot Action，不再经过自动长文本策略。

## 8. 推荐的 HuanLink v1 最小方案

```text
OneBot event
-> Adapter 完成协议解析和 access allow/deny
-> Server 将所有 admitted message 追加到 Conversation Session
-> TriggerPolicy 根据 self/mention/command/群聊策略决定是否启动 Agent
-> Agent framework run
   -> 保留 Tool Call/Tool Result
   -> 调用 reply: Handler 从可信 context 取得 currentRoute，再 channel.send()
   -> 未调用 reply: 不产生 Channel 可见消息
-> OneBot Adapter delivery policy
   -> 短普通文本: send_group_msg / send_private_msg
   -> 长普通文本: 构造受限节点并发送 merged forward
   -> 富媒体/显式 Operation: 走各自入口
-> 成功回执按 channelId + messageId 登记出站消息
-> Bot 自身事件回流后与发送记录幂等合并，且不触发 Agent
```

保持 v1 简单且安全的约束：

1. `reply` 的 route 只来自可信 session；Agent 不调用 `reply` 时无可见回复，Runner 异常不能伪装成正常静默。
2. Tool Call/Tool Result 与 Channel 消息都保存在结构化 session 中；上下文投影按发送关联避免重复展开同一正文。
3. 自动长消息只处理**当前 route 的普通文本回复**；不接收模型提供的目标 ID、节点发送者、任意 OneBot Action 或原始参数。
4. Adapter 必须限制总字符/字节、单节点大小和节点数量，并按段落/代码块优先切分；超出总上限应失败或降级，不能无限创建节点。
5. 合并转发明确失败时可以回退普通分段；若 Action 已发出但结果不确定，不能自动重试或回退，以免重复发送。
6. receipt 至少记录最终 presentation（`plain | chunks | merged_forward`）和已确认的 message IDs；部分成功必须显式返回，不能伪装成完整成功。
7. 不采用社区插件的进程级 `activeReplyTarget` 全局变量；所有状态绑定 `channelId + conversation route + turnId`，随一次 send 调用传递。

这一方案借鉴了 OpenClaw 的“Agent 不接触 Adapter”“平台自己拥有文本限制”和“静默、空输出、失败分开处理”，但不复制其 `NO_REPLY` 文本协议，也不复制社区 OneBot 插件的全局 suppression 状态。

## 9. 尚需决策的问题

Tool 驱动回复、Tool 历史保留、当前会话回流关联、跨会话来源标记和显式合并转发属于 `onebot_standard` 已经确认。仍有三个影响长消息真实 QQ 行为的高价值决策：

1. **自动转换阈值和计量单位：** 按 JavaScript 字符、Unicode code point 还是 UTF-8 字节；建议同时设置展示阈值和硬字节上限。
2. **合并转发节点来源：** 使用自定义节点（固定 Bot 身份 + content）还是像社区插件一样先发给自己、再引用 message ID。前者更轻，后者兼容性可能更好，需要用目标 NapCat/Lagrange 实机验证。
3. **失败降级：** 明确远端拒绝时是否自动改发普通 chunks；`delivery_uncertain` 必须保持不重试。

## 10. 关键源码证据清单

| 结论 | 文件、函数/类型 | 证据证明什么 |
|---|---|---|
| Kernel admission | `src/channels/turn/types.ts` `ChannelTurnAdmission`；`kernel.ts` `runChannelTurn` | 入站有结构化 dispatch/observeOnly/handled/drop，且 gate 在 Agent 前。 |
| mention skip 非 Session | `extensions/telegram/src/bot-message-context.body.ts` `buildTelegramMessageBody` | 未提及消息写内存 group history 后返回 `null`。 |
| room event | `src/channels/inbound-event/classification.ts` `classifyChannelInboundEvent` | 未提及消息可成为会运行 Agent 的被动 room event。 |
| Session metadata | `src/channels/session.ts` `recordInboundSession` | 只写 metadata/last route，不写用户正文。 |
| 用户 turn 持久化 | `src/auto-reply/reply/get-reply-run-execute.ts` `createUserTurnTranscriptRecorder` | Agent run 内写用户 transcript，room event 也走 recorder。 |
| 自动原路回复 | `src/channels/turn/lifecycle.ts` `dispatchChannelTurnWithDeliveryOwner` | Runtime 调 delivery，不把 Adapter 交给 Agent。 |
| 静默 token | `src/auto-reply/tokens.ts` `isSilentReplyPayloadText` | `NO_REPLY` 是兼容多种文本外形的哨兵协议。 |
| 静默不发送 | `src/auto-reply/reply/normalize-reply.ts`；`reply-dispatcher.ts` | 静默归一化为 null，停止进入 delivery。 |
| 静默 replay 清理 | `src/agents/embedded-agent-runner/replay-history.ts` `normalizeAssistantReplayContent` | 原始 Session 可保留，但下一次模型上下文移除。 |
| 空输出与失败 | `src/auto-reply/reply/agent-runner-failure-reply.ts`；`agent-runner-execution.ts` | 空输出、显式静默和执行错误具有不同处理。 |
| 通用长文本分段 | `src/infra/outbound/deliver-core.ts`；`src/auto-reply/chunk.ts` | Adapter 声明限制，Core 规划并顺序发送 chunks。 |
| Telegram | `extensions/telegram/src/send-message-text.ts` `createTelegramTextSender` | 4000 字符安全分段、顺序发送、多 ID receipt。 |
| Discord | `extensions/discord/src/chunk.ts` `chunkDiscordTextWithMode` | 2000 字符、17 行、code fence 修复。 |
| Slack | `extensions/slack/src/send.ts` `resolveSlackTextChunks` | 8000 字符、Slack mrkdwn 分段、part metadata。 |
| 官方 OneBot 缺失 | OpenClaw `extensions/` tree；`setup-promotion-helpers.ts` | 仅承认外部 undeclared adapter 配置兼容，没有可审计官方 OneBot 源码。 |
| 社区合并转发 | `openclaw-onebot/src/handlers/process-inbound.ts`；`src/connection.ts` | 超限后构造引用节点，并分别调用群/私聊 forward Action。 |
