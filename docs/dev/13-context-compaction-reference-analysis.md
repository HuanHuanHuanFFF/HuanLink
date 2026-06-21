# 上下文压缩机制调研：Claude Code / Codex / Hermes / OpenClaw

本文只分析 agent/harness 项目里的 context compaction / compression：长对话超过模型上下文后，系统如何把旧历史压成可继续工作的上下文。

范围说明：

- Claude Code 使用 `references/claude-code`，当前是 `tanbiralam/claude-code` 的可读 TypeScript 源码快照。该仓库自述为 source-map 泄露源码重建，不等同于 Anthropic 官方完整源码。
- Codex 使用 `references/codex` 的官方开源实现。
- Hermes 使用 `references/hermes-agent`。
- OpenClaw 这里重点看它自己的 agent harness/session/runtime compaction 机制，以下用 OpenClaw/Harness 指代。

## 1. 一句话结论

上下文压缩不是把原始日志删掉，而是生成一个新的“模型可见上下文快照”：通常是 `summary checkpoint + retained tail + later suffix`。原始 run/event/session log 仍然保留，用于审计、恢复、replay 和 debug。

可以先用这个模型理解所有项目：

```txt
完整历史 / trajectory / transcript
  -> 到达阈值或手动触发 compact
  -> 选择要总结的旧段 + 要保留的近期段
  -> LLM 或远端服务生成 summary
  -> 写入一个 compaction checkpoint
  -> 下一轮模型请求只看：固定系统上下文 + summary + retained tail + 后续新增消息
```

关键点：

- `raw log` 是事实源，尽量 append-only。
- `active context` 是每次请求模型前重建出来的工作集。
- `compaction checkpoint` 是恢复点，不是简单的文本摘要。
- 好的实现还会记录 `firstKeptEntryId` / `replacement_history` / `window_id` / `parent_session_id` 等结构化字段，保证 resume/replay 能还原同一条工作链。

## 2. 四个项目的总览对比

| 项目 | 核心形态 | 触发点 | 摘要作为哪个 role | 持久化形态 | 恢复/replay 思路 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | boundary + summary user message + kept messages | `/compact`、auto compact、API prompt-too-long 后 reactive compact | summary 是 `user`；boundary 是内部 `system`，请求模型前过滤 | JSONL transcript，compact boundary 会切断 parent chain；工具大结果另写 `content-replacement` | `loadTranscriptFile()` 遇到 compact boundary 裁剪旧链，再接 summary / preserved segment |
| Codex | rollout compaction checkpoint + replacement history | 手动 compact、pre-turn auto compact、mid-turn token limit compact | 本地 compact 把 summary 写成 `ResponseItem::Message role="user"` | `RolloutItem::Compacted { message, replacement_history, window_id }` | `reconstruct_history_from_rollout()` 从最新 replacement history 开始，再 replay suffix |
| Hermes | active context compression + session rotation | preflight rough token、post-response usage、overflow recovery、`/compress`、ACP `/compact` | 自动选择 `user` 或 `assistant`，避免相邻同 role；可合并进 tail | SQLite session split：旧 session `end_reason="compression"`，新 session `parent_session_id=old`；ACP 路径保持同一个 ACP session | 根据 session parent/end_reason 推导 compression lineage；ACP replay 持久化历史 |
| OpenClaw/Harness | session compaction entry + first kept tail | `AgentHarness.compact()`、上层 session check、overflow retry、embedded runner context engine | harness 内部是 `compactionSummary`，转换给 LLM 时变成 `user` | session tree/transcript 追加 `compaction` entry，字段含 `summary`、`firstKeptEntryId`、`tokensBefore`、`details` | `buildSessionContext()` 注入 synthetic summary，然后只 replay retained tail 和后续 entry |

## 3. Claude Code：boundary 只是内部锚点，真正喂模型的是 user summary

### 3.1 入口和触发

核心文件：

- `references/claude-code/src/commands/compact/compact.ts`
- `references/claude-code/src/query.ts`
- `references/claude-code/src/services/compact/autoCompact.ts`
- `references/claude-code/src/services/compact/compact.ts`
- `references/claude-code/src/services/compact/prompt.ts`
- `references/claude-code/src/utils/messages.ts`
- `references/claude-code/src/utils/sessionStorage.ts`

手动 `/compact` 入口在 `commands/compact/compact.ts`：

```txt
/compact
  -> getMessagesAfterCompactBoundary()
  -> try session memory compact
  -> microcompact
  -> compactConversation()
```

自动 compact 接在主 query loop 里，位置在每次请求模型前。`query.ts` 的顺序大致是：

```txt
messagesForQuery = getMessagesAfterCompactBoundary(messages)
  -> tool result budget replacement
  -> history snip
  -> microcompact
  -> context-collapse projection
  -> autocompact
  -> normalizeMessagesForAPI()
  -> model request
```

这说明 Claude Code 的压缩不是某个独立后台任务，而是 agent loop 发起模型请求前的上下文治理阶段。

此外还有 reactive compact：如果真实 API 返回 prompt-too-long / media-too-large，`query.ts` 会尝试 `tryReactiveCompact()`，压缩成功后用新 messages 继续本轮。

### 3.2 压缩流程

`compactConversation()` 是主流程，核心结构在 `services/compact/compact.ts`：

```txt
compactConversation(messages, context, cacheSafeParams, ...)
  -> 统计 pre compact token
  -> 执行 PreCompact hooks
  -> 构造 summary prompt
  -> 调 summary agent 生成 summary
  -> 如果 compact 请求自己过长，从头丢旧 API round，最多重试
  -> 构造 boundary marker
  -> createUserMessage(summary, isCompactSummary=true)
  -> 收集 post-compact attachments
  -> 返回 CompactionResult
```

`CompactionResult` 的顺序很重要：

```txt
boundaryMarker
summaryMessages
messagesToKeep
attachments
hookResults
```

这说明 Claude Code 的 active context 不是“只剩一段 summary”，而是 summary 之后还保留一段近期原始上下文和一些重新组装的附件，比如最近读过的文件、plan、调用过的 skill、异步 agent 信息等。

### 3.3 role 和模型可见内容

Claude Code 这里最容易误解：它确实创建了一个 `system` 类型的 compact boundary，但这个 boundary 不直接发给模型。

源码点：

- `messages.ts::createCompactBoundaryMessage()` 创建 `system` boundary，`subtype: "compact_boundary"`。
- `compact.ts` 用 `createUserMessage({ isCompactSummary: true, isVisibleInTranscriptOnly: true })` 创建 summary。
- `messages.ts::normalizeMessagesForAPI()` 会过滤普通 internal/system message，注释也明确 boundary 会被过滤。

所以模型实际看到的是：

```txt
role=user
content="Summary: ... 这是之前会话的压缩摘要 ..."
```

而不是：

```txt
role=system
content="历史摘要..."
```

这个设计很值得学：历史对话摘要不应该被提升为最高优先级 system 指令。它本质是“之前发生过什么”的记录，而不是新的规则。

### 3.4 持久化和恢复

Claude Code 的 transcript 是 JSONL。压缩发生后：

- compact boundary 写入 transcript。
- boundary 的 `parentUuid` 会被置空，原父节点写入 `logicalParentUuid`，相当于切断旧 parent chain。
- `loadTranscriptFile()` 恢复时遇到 compact boundary，会裁剪旧历史。
- 如果有 `preservedSegment`，会把保留尾段重新接到 summary 后面。

另外，Claude Code 的 `content-replacement` 不是 summary 压缩，而是工具结果过大时的内容替换记录。它保存“模型实际看到的替代字符串”，resume 时原样重放，避免 prompt cache / replay 语义漂移。

学习重点：

```txt
compact summary = 对话历史摘要
content replacement = 单条大工具结果替换
compact boundary = transcript/replay 的内部锚点
```

## 4. Codex：把 compaction 做成 rollout checkpoint

### 4.1 入口和触发

核心文件：

- `references/codex/codex-rs/core/src/compact.rs`
- `references/codex/codex-rs/core/src/compact_remote.rs`
- `references/codex/codex-rs/core/src/compact_remote_v2.rs`
- `references/codex/codex-rs/core/src/session/turn.rs`
- `references/codex/codex-rs/core/src/session/mod.rs`
- `references/codex/codex-rs/core/src/session/rollout_reconstruction.rs`
- `references/codex/codex-rs/protocol/src/protocol.rs`
- `references/codex/codex-rs/app-server/src/request_processors/thread_processor.rs`

Codex 有三类入口：

```txt
手动 compact:
  SDK / app-server thread compact
  -> Op::Compact
  -> run_compact_task()

pre-turn auto compact:
  session/turn.rs::run_pre_sampling_compact()
  -> 请求模型前检测 token/window/model/context 变化

mid-turn compact:
  模型返回 token limit reached 且还需要 follow-up
  -> compact
  -> 继续本轮
```

### 4.2 本地 compact 流程

`compact.rs` 的本地流程大致是：

```txt
run_compact_task_inner_impl()
  -> clone 当前 history
  -> 追加 summarization prompt
  -> 调模型生成 summary
  -> summary_text = SUMMARY_PREFIX + last assistant output
  -> collect_user_messages(history)
  -> build_compacted_history(initial_context, selected_user_messages, summary_text)
  -> CompactedItem { message, replacement_history, window_id }
  -> Session::replace_compacted_history()
```

这里和 Claude Code 的差异很明显：

- Codex 把最终可恢复的 active context 直接叫 `replacement_history`。
- `protocol.rs::CompactedItem` 明确有 `replacement_history: Option<Vec<ResponseItem>>`。
- `session/mod.rs::replace_compacted_history()` 同时替换内存 history，并写入 `RolloutItem::Compacted`。

### 4.3 role 和 replacement history

`build_compacted_history_with_limit()` 会把 selected user messages 和 summary 都写成：

```txt
ResponseItem::Message {
  role: "user",
  content: InputText(...)
}
```

summary 通过 `SUMMARY_PREFIX` 标记。Codex 也没有把历史摘要当成 system 指令，而是把它作为 user-side conversation artifact。

值得注意的是，本地 compact 不是简单保留最近 K 轮完整原文。它会：

- 收集 user messages。
- 对 user messages 做 token 限制，常量是 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`。
- 再追加 summary。

远程 compact 路径则由 `/responses/compact` 或 v2 `CompactionTrigger` 返回新的 compacted history；客户端侧能确认的是调用、过滤、安装 replacement history，服务端内部算法未确认。

### 4.4 恢复/replay

Codex 的恢复逻辑很适合学习：

```txt
rollout JSONL
  -> 反向扫描最新 surviving RolloutItem::Compacted
  -> 如果有 replacement_history，把它当作重建 base
  -> 再正向 replay 后续 suffix
```

核心在 `session/rollout_reconstruction.rs::reconstruct_history_from_rollout()`。

这比“读完整历史再重新压缩一次”稳定，因为 checkpoint 存的是当时实际安装过的 replacement history。只要 rollout 还在，就可以恢复到同一条模型上下文链。

## 5. Hermes：压缩会旋转 session，同时服务 memory/self-improve

### 5.1 入口和触发

核心文件：

- `references/hermes-agent/agent/context_compressor.py`
- `references/hermes-agent/agent/turn_context.py`
- `references/hermes-agent/agent/conversation_loop.py`
- `references/hermes-agent/agent/conversation_compression.py`
- `references/hermes-agent/acp_adapter/server.py`
- `references/hermes-agent/acp_adapter/provenance.py`
- `references/hermes-agent/gateway/slash_commands.py`

Hermes 不只是 memory/search，也有 active context compression。

触发点：

```txt
preflight:
  turn_context.py::build_turn_context()
  -> rough token estimate
  -> context_compressor.should_compress()
  -> agent._compress_context()

post-response / error recovery:
  conversation_loop.py
  -> update_from_response(real usage)
  -> overflow / 413 / context too large 时触发压缩恢复

手动:
  CLI/gateway /compress
  ACP /compact
```

### 5.2 ContextCompressor 的算法

`context_compressor.py::ContextCompressor.compress()` 的目标是压中间，保两端：

```txt
compress(messages)
  -> prune old tool results / screenshots
  -> protect first N messages
  -> protect recent tail by token budget
  -> middle window = 可被压缩的历史
  -> _generate_summary(middle)
  -> 如果已有 previous summary，做 iterative summary update
  -> 插入 summary message，或合并到 tail
  -> 标记 _compressed_summary
```

Hermes 的 summary role 比 Claude/Codex 更复杂。它会根据相邻消息选择 `user` 或 `assistant`，避免出现连续同 role 的无效/劣质消息序列：

```txt
如果 head 前一个 role 是 assistant/tool -> summary_role = user
否则 -> summary_role = assistant
如果和 tail 冲突，尝试翻转
都冲突时，合并到 tail message
```

并且会加 `_compressed_summary` 元数据，方便 UI/gateway 区分“压缩摘要”与真实用户/助手消息。

Hermes 的 summary 前缀也更防御性，强调 summary 是 reference only，不能把摘要里的历史请求当成当前新指令。这是因为 summary 放在 `user` 或 `assistant` 都可能被弱模型误读。

### 5.3 session rotation

Hermes 和 Claude/Codex 最大的不同是：普通路径下，压缩会导致 SQLite session 分裂。

`conversation_compression.py::compress_context()` 做了这些事：

```txt
compress_context()
  -> memory_manager.on_pre_compress(messages)
  -> context_compressor.compress(messages)
  -> 如果压缩失败且返回原 messages，不旋转 session
  -> SessionDB.end_session(old_session_id, "compression")
  -> 创建 new session_id
  -> create_session(parent_session_id=old_session_id)
  -> update_system_prompt(new_session_id, new_system_prompt)
  -> memory_manager.on_session_switch(parent_session_id=old, reason="compression")
```

所以 Hermes 的压缩不只是“消息列表变短”，它还把持久化 session lineage 建出来了。

`acp_adapter/provenance.py` 明确说明 provenance 不新增持久化状态，而是从 `sessions` 表的 `parent_session_id` / `end_reason` 推导：

```txt
old session end_reason = "compression"
new session parent_session_id = old session
  -> sessionKind = continuation
  -> compressionDepth += 1
```

ACP `/compact` 路径比较特殊：`acp_adapter/server.py::_cmd_compact()` 会临时把 `agent._session_db = None`，避免 `_compress_context()` 做 SQLite session split。原因是 ACP/editor-facing `session_id` 要保持稳定。

### 5.4 和 self-improve 的关系

Hermes 的 context compression 和 self-improve 是两条不同但会互相配合的链：

```txt
context compression:
  解决当前模型窗口不够用
  -> 压缩 active messages
  -> 旋转 session / 更新 system prompt

self-improve:
  解决长期经验沉淀
  -> background review
  -> memory / skill candidate
  -> approval
  -> 下次加载
```

压缩前会通知 memory provider，压缩旋转 session 后会通知 memory provider session switch。这说明 Hermes 重数据库和 memory 的设计确实更方便 self-improve，但也带来更重的状态管理和 schema 演进成本。

## 6. OpenClaw/Harness：compaction entry + firstKeptEntryId 是最清晰的轻量结构

### 6.1 核心文件

- `references/openclaw/packages/agent-core/src/harness/compaction/compaction.ts`
- `references/openclaw/packages/agent-core/src/harness/agent-harness.ts`
- `references/openclaw/packages/agent-core/src/harness/session/session.ts`
- `references/openclaw/packages/agent-core/src/harness/messages.ts`
- `references/openclaw/src/agents/sessions/compaction/compaction.ts`
- `references/openclaw/src/agents/sessions/agent-session.ts`
- `references/openclaw/src/agents/embedded-agent-runner/compact.ts`
- `references/openclaw/src/agents/embedded-agent-runner/compaction-successor-transcript.ts`
- `references/openclaw/src/gateway/session-compaction-checkpoints.ts`

### 6.2 harness core 流程

`AgentHarness.compact()` 是最清楚的一条链：

```txt
AgentHarness.compact()
  -> session.getBranch()
  -> prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS)
  -> emit session_before_compact hook
     -> hook 可以 cancel
     -> hook 也可以直接 provide compaction result
  -> compact(preparation, model, apiKey, ...)
  -> session.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook)
  -> emit session_compact
```

`CompactionResult` 的结构非常适合 Huaness Lite 学：

```ts
{
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: {
    readFiles: string[];
    modifiedFiles: string[];
  };
}
```

这比只存一段 summary 好，因为 `firstKeptEntryId` 明确告诉恢复逻辑：从哪里开始保留原始 tail。

### 6.3 prepareCompaction 做了什么

`prepareCompaction()` 的职责：

```txt
prepareCompaction(pathEntries)
  -> 找到 previous compaction
  -> 取 previousSummary
  -> 估算 tokensBefore
  -> 根据 keepRecentTokens 找 cut point
  -> 如果切在 turn 中间，拆出 turnPrefixMessages
  -> messagesToSummarize = 旧历史段
  -> firstKeptEntryId = 保留 tail 的第一条 entry
  -> extractFileOperations(readFiles, modifiedFiles)
```

然后 `compact()` 会：

```txt
compact(preparation)
  -> generateSummary(messagesToSummarize, previousSummary?)
  -> 如果 split turn，另外总结 turn prefix
  -> summary += read/modified files 信息
  -> 返回 summary + firstKeptEntryId + tokensBefore + details
```

OpenClaw 的 summary 也支持 iterative update：如果已有 previous summary，就走 update summary prompt。

### 6.4 恢复 active context

最重要的恢复逻辑在 `harness/session/session.ts::buildSessionContext()`。

逻辑是：

```txt
遍历 pathEntries，找到最后一个 compaction entry

如果没有 compaction:
  context.messages = 全部 message/custom/branch summary

如果有 compaction:
  context.messages = [
    createCompactionSummaryMessage(compaction.summary, tokensBefore),
    从 firstKeptEntryId 到 compaction 前的 retained tail,
    compaction 后面的新 entry
  ]
```

然后 `messages.ts::normalizeMessages()` 会把内部 `role: "compactionSummary"` 转成 LLM 可见的 `role: "user"`。

这条链是 Huaness Lite 最适合优先学习的：结构简单、可 JSONL 化、恢复逻辑清晰。

### 6.5 上层 runtime 的复杂度

OpenClaw 上层比 agent-core 更复杂，原因是它需要接真实运行时：

- `agent-session.ts` 做 session-level compaction check。
- `embedded-agent-runner/compact.ts` 调 context engine / native harness compaction。
- `embedded-agent-runner/run.ts` 在 context overflow、timeout、post-compaction continuation 等场景里重试。
- `compaction-successor-transcript.ts` 支持压缩后旋转 successor transcript。
- `gateway/session-compaction-checkpoints.ts` 管理 compaction checkpoint、snapshot trimming 和 fork。

这些是生产化复杂度。Huaness Lite P0 不应该一开始复刻，但要理解它们解决的问题：压缩成功后，下一次 prompt/retry/resume 必须知道自己基于哪份 compacted transcript 继续。

## 7. 关键设计差异

### 7.1 raw log 和 active context 的分离

四个项目都在分离这两件事：

```txt
raw log:
  所有真实事件、消息、工具调用、工具结果、压缩事件
  用于审计、debug、replay、self-improve

active context:
  当前这次请求模型实际看到的消息列表
  可以由 raw log + compaction checkpoint 重建
```

Claude Code 和 Codex 更偏 append-only transcript/rollout；Hermes 更偏 DB session lineage；OpenClaw/Harness 介于中间，用 session tree entry 表达 compaction。

### 7.2 summary 不应该随便当 system

Claude Code、Codex、OpenClaw 最终都把 summary 以 user-like message 喂给模型。Hermes 更复杂，会在 user/assistant 之间选，但也加了强约束前缀。

原因是：历史 summary 是“事实背景”，不是“最高优先级规则”。如果把旧用户请求压成 system，可能会把旧需求错误升级成当前必须执行的指令。

对 Huaness Lite 的启发：

```txt
system:
  只放核心运行规则、policy、工具安全边界

user summary / context summary:
  放历史摘要、旧任务状态、文件状态、已完成/未完成事项

internal event:
  放 compaction boundary、tokens、checkpoint、firstKeptEventId
```

### 7.3 checkpoint 字段比 summary 文本更重要

只存 summary 会导致 replay 不稳。更好的字段包括：

- `reason`: manual / token_pressure / overflow / resume / model_switch
- `summary`
- `tokensBefore`
- `tokensAfter`
- `firstKeptEntryId` 或 `firstKeptEventId`
- `replacementHistory` 或 `activeContextSnapshot`
- `windowId`
- `model`
- `sourceRange`: 被总结的 event/message 范围
- `keptRange`: 保留 tail 的范围
- `createdBy`: local summarizer / remote compaction / hook

Codex 的 `replacement_history` 最稳，OpenClaw 的 `firstKeptEntryId` 最轻量。Claude Code 的 compact boundary + parent chain 更贴近 transcript UI。Hermes 的 `parent_session_id` 更适合重 DB/session lineage。

## 8. Huaness Lite P0 开发指导

P0 推荐学 OpenClaw + Codex，不要一上来学 Hermes 的重 DB session split。

### 8.1 最小模块

```txt
ContextCompactor
  -> decide(messages, budget)
  -> compact(messages)

ContextAssembler
  -> from EventLog 重建 active model messages

EventLog
  -> append context.compaction_requested
  -> append context.compacted
  -> append context.compaction_failed

Replay reducer
  -> 找最新 context.compacted
  -> summary + retained tail + suffix
```

### 8.2 最小事件

```ts
type ContextCompactedEvent = {
  type: "context.compacted";
  runId: string;
  reason: "manual" | "token_pressure" | "overflow";
  summary: string;
  tokensBefore?: number;
  tokensAfter?: number;
  firstKeptEventId: string;
  summarizedEventIds?: string[];
  keptEventIds?: string[];
  model?: string;
  windowId?: string;
};
```

如果以后想更像 Codex，可以加：

```ts
replacementHistory?: ModelMessage[];
```

含义是“这次 compact 后安装到 active context 的完整替代历史”。这会让 resume/replay 更稳定，但 P0 可以先用 `firstKeptEventId + summary`。

### 8.3 最小 active context 重建

```txt
assembleContext(events):
  fixedSystem = buildSystemPrompt(policy, tools)
  latest = findLatest("context.compacted")

  if no latest:
    return fixedSystem + messagesFrom(events)

  summaryMessage = {
    role: "user",
    content: "[CONTEXT SUMMARY]\n" + latest.summary
  }

  tail = messagesFrom(events after latest.firstKeptEventId)
  suffix = messagesFrom(events after latest event)

  return fixedSystem + summaryMessage + tail + suffix
```

实际实现时要避免 tail/suffix 重复，可以用 event id 或 message id 做去重。

### 8.4 先延后的东西

P0 不建议做：

- Hermes 式 session DB split。
- Claude Code 的 session memory compact。
- Claude Code 的 context-collapse projection。
- Codex remote `/responses/compact` 这种服务端压缩协议。
- OpenClaw successor transcript rotation。
- 多阶段 partial summary fallback。

这些都很有价值，但它们解决的是生产化复杂度，不是 Huaness Lite 第一个可用版本的核心闭环。

### 8.5 可以先采用的东西

P0 应该采用：

- OpenClaw 的 `summary + firstKeptEntryId + tokensBefore`。
- Codex 的 `replacement_history` 思想，但可以先不落完整字段。
- Claude Code 的“boundary/internal event 不发模型，summary 作为 user message 发模型”。
- Hermes 的 summary 前缀警告：摘要只是 reference，不是当前新指令。
- 大工具结果单独做 `observation.replaced`，不要混进 context summary。

## 9. 学习源码顺序

建议按这个顺序读：

1. OpenClaw/Harness：
   - `packages/agent-core/src/harness/session/session.ts::buildSessionContext()`
   - `packages/agent-core/src/harness/compaction/compaction.ts::prepareCompaction()`
   - `packages/agent-core/src/harness/agent-harness.ts::compact()`
   - 先理解 `firstKeptEntryId`。

2. Codex：
   - `codex-rs/core/src/compact.rs::build_compacted_history_with_limit()`
   - `codex-rs/core/src/session/mod.rs::replace_compacted_history()`
   - `codex-rs/core/src/session/rollout_reconstruction.rs::reconstruct_history_from_rollout()`
   - 重点理解 `replacement_history`。

3. Claude Code：
   - `src/query.ts` 的 compact 调用顺序。
   - `src/services/compact/compact.ts::compactConversation()`
   - `src/utils/messages.ts::createCompactBoundaryMessage()` 和 `normalizeMessagesForAPI()`
   - `src/utils/sessionStorage.ts::loadTranscriptFile()`
   - 重点理解 boundary 不等于 model-visible summary。

4. Hermes：
   - `agent/context_compressor.py::ContextCompressor.compress()`
   - `agent/turn_context.py` preflight compression
   - `agent/conversation_compression.py::compress_context()`
   - `acp_adapter/provenance.py`
   - 重点理解 session rotation 和 memory/self-improve 的配合。

## 10. 最终建议

Huaness Lite 的 P0 上下文压缩可以这样定义：

```txt
AgentLoop
  -> ContextAssembler 组装 messages
  -> ContextBudget 判断是否需要 compact
  -> ContextCompactor 生成 summary
  -> EventLog.append(context.compacted)
  -> ContextAssembler 用 summary + firstKeptEventId 重建 active context
  -> ModelClient.request(active context)
```

不要物理删除 JSONL 里的旧事件。压缩只改变“下一次模型看到什么”，不改变“系统真实发生过什么”。

P0 最小目标不是压缩得多聪明，而是保证：

- 超上下文时能继续跑。
- replay/resume 能从 checkpoint 恢复。
- summary 不会变成高优先级 system 指令。
- 工具大输出可以单独替换。
- 所有压缩行为都有事件可查。

