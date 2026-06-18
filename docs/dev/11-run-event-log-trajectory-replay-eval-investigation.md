# Run/Event Log、Trajectory、Replay/Eval/Self-Improve 调研

## 0. 范围与结论

本报告优先基于当前仓库内资料：

- Huaness Lite 当前实现：`packages/core/src/events/*`、`packages/core/src/loop/agent-loop.ts`、`packages/core/src/tools/tool-gateway.ts`、`packages/core/tests/*`
- 已有设计文档：`docs/dev/02-huaness-lite-core-chain.md`、`docs/dev/04-tech-selection-investigation.md`、`docs/dev/05-openclaw-single-project-deep-dive.md`、`docs/dev/10-hermes-agent-self-improve-analysis.md`
- 本地 reference：`references/hermes-agent`、`references/openclaw`、`references/codex`、`references/openhands`、`references/mini-swe-agent`、`references/gemini-cli`

本轮没有额外联网。原因是本地源码和文档已经足够回答本次问题。需要注意：当前 `references/openhands` 更偏平台服务和前端，未完整包含老版本常见的 `openhands/events` agent core 形态，所以 OpenHands 部分只基于本地可见的 App/Event Service、前端 Event 类型和导出链路分析，不脑补缺失实现。

核心结论：

- Huaness Lite P0 应继续以 JSONL EventLog 作为 source of truth，但必须补上 `eventId`、`seq`、`turnId/step/toolCallId`、事件类型语义、状态索引和 replay view。
- 先不要急着上数据库。SQLite 更适合作为 P1 的派生索引，用于跨 run 查询、UI 列表、全文搜索、恢复和 self-improve 候选检索。
- 事件日志不是“为了存聊天记录”，而是为了支撑 replay、eval、debug、审计、恢复、UI 展示和 self-improve。写入点必须接在 agent loop、tool gateway、policy/approval、model client、memory/self-improve，而不是接在 QQ/HTTP 这种外部 channel 上。

## 1. 横向对比

| 项目             | 记录什么                                                                                                   | 持久化形态                                                              | 写入链路挂点                                                                                            | 后续消费                                                                          | 对 Huaness Lite 的启发                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Hermes Agent   | session messages、tool call、trajectory sample、background review 输入、memory/skill 写入候选                    | SQLite SessionDB、trajectory JSONL、session log、memory/skill 文件资产    | run loop、turn finalizer、trajectory saver、SessionDB flush、background review、write approval         | session search、self-improve、trajectory 样本、回忆历史任务、技能/记忆复用                      | self-improve 不直接“训练模型”，而是把任务经验沉淀成可审批的 memory/skill 资产               |
| OpenClaw       | session transcript、ACP session update、tool call/update、agent thought/message chunk、session snapshot    | JSONL transcript、ACP file ledger、SQLite ledger                     | transcript append、ACP translator、tool event handler、session update broadcaster、session write lock | ACP replay、client UI rehydrate、session restore、debug/audit                    | replay 要记录“客户端需要重放的语义事件”，不只是原始消息                                    |
| Codex          | rollout items、response items、event messages、thread metadata、可选 raw trace                               | rollout JSONL、session index JSONL、SQLite state DB、trace bundle 文件树 | core session `send_event`、rollout recorder、event persistence policy、trace writer                  | resume/fork、rollout reconstruction、UI 映射、thread 搜索、memory 过滤、debug trace      | durable log 应分层：可恢复历史、UI 事件、debug raw trace 不是同一层                   |
| OpenHands      | Conversation Event：Action、Observation、Message、AgentError、UserReject、tool call/result                   | 本地文件树、一事件一 JSON；也有 S3/GCS 后端                                       | App EventService、webhook event ingest、conversation export、前端事件查询                                  | UI conversation history、trajectory zip 导出、analytics、callback                  | 平台化可以抽象存储后端，但 Huaness P0 不需要复制平台复杂度                                 |
| mini-swe-agent | 完整 messages trajectory、model/env stats、exit status、submission                                          | 单个 `.traj.json` 文件                                                 | agent loop `finally` 每步 save、query、execute_actions                                                | benchmark eval、inspector、debug                                                | 最小可用 eval/replay 可以非常简单：直接保存模型看到的完整 messages                        |
| Gemini CLI     | session JSONL、message/thought/tool calls/tokens、checkpoint、headless JSON events、auto memory candidates | chat recording JSONL、checkpoint 文件树、shadow Git、memory review inbox | chat recording service、history owner、tool checkpoint、headless formatter、auto-memory extractor     | session resume/list/delete、checkpoint restore、headless automation、auto memory | checkpoint/self-improve 应建立在历史记录之上，但写入 memory 要有 review inbox 和安全边界 |

## 2. Huaness Lite 当前基线

当前代码已经有一个轻量 EventLog 骨架。

关键文件：

- `packages/core/src/types.ts`
- `packages/core/src/events/create-agent-event.ts`
- `packages/core/src/events/jsonl-event-log.ts`
- `packages/core/src/events/in-memory-event-log.ts`
- `packages/core/src/loop/agent-loop.ts`
- `packages/core/src/tools/tool-gateway.ts`
- `packages/core/tests/jsonl-event-log.test.ts`
- `packages/core/tests/mock-agent-run.test.ts`

当前 `AgentEvent` 形态：

```ts
export interface AgentEvent {
  readonly schemaVersion: string;
  readonly type: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly data?: Record<string, unknown>;
}
```

当前 JSONL 形态：

- 默认根目录：`.huaness`
- run 目录：`.huaness/runs/<encoded-run-id>/events.jsonl`
- 写入方式：每个事件一行 JSON
- 读取方式：`readByRun(runId)` 读取对应 run 文件并过滤 `event.runId`
- 安全点：通过 `path.relative` 做 run path guard，防止 runId 路径逃逸

当前 agent loop 写入事件：

- `run.created`
- `model.requested`
- `model.responded`
- `run.completed`
- `run.max_steps_exceeded`
- `run.cancelled`
- `run.failed`

当前 ToolGateway 写入事件：

- `tool.requested`
- `policy.decided`
- `tool.blocked`
- `tool.failed`
- `tool.completed`

这个基线是对的：事件已经接在 core loop 和 tool gateway 上，而不是接在 channel adapter 上。但它还缺几个关键能力：

- 没有 `eventId`，无法稳定引用某个事件。
- 没有 per-run `seq`，replay 和 tail 都只能依赖文件顺序。
- 没有 `turnId`、`step`、`toolCallId`、`parentId`，很难把 model response、tool call、observation 串起来。
- 没有 typed event union，事件语义还偏自由字符串。
- 没有 run index/session index，跨 run 列表、按 session 查询、状态过滤会变成扫目录。
- `model.requested` 还没有记录 context/messages 的摘要或引用，后续 replay/eval 不够直接。

已有文档已经给出方向：

- `docs/dev/02-huaness-lite-core-chain.md` 提过 P0 事件应覆盖 `context_built`、`model_request`、`tool_call_requested`、`tool_call_approved/denied/started/finished`、`observation_appended` 等。
- `docs/dev/04-tech-selection-investigation.md` 已经倾向 `JSONL + 文件目录` 作为 P0 source of truth，SQLite 作为 P1 查询索引。

本报告后面的建议会沿用这个方向，不把数据库提前变成核心依赖。

## 3. Hermes Agent

### 3.1 记录哪些事件/轨迹

Hermes 的重点不是单纯 event stream，而是三类资产：

1. 当前 session 的完整消息历史。
2. 可检索的历史 session 数据。
3. 从历史任务中沉淀出来的 memory/skill 候选。

关键文件：

- `references/hermes-agent/run_agent.py`
- `references/hermes-agent/agent/trajectory.py`
- `references/hermes-agent/hermes_state.py`
- `references/hermes-agent/tools/session_search_tool.py`
- `references/hermes-agent/agent/turn_finalizer.py`
- `references/hermes-agent/agent/background_review.py`
- `references/hermes-agent/tools/write_approval.py`
- `references/hermes-agent/tools/memory_tool.py`
- `references/hermes-agent/tools/skill_manager_tool.py`

`references/hermes-agent/agent/trajectory.py` 里的 `save_trajectory` 会把一次任务转换成 ShareGPT-like trajectory JSONL：

- `conversations`
- `timestamp`
- `model`
- `completed`

它区分成功与失败：

- completed 写入 `trajectory_samples.jsonl`
- failed 写入 `failed_trajectories.jsonl`

这类 trajectory 更像训练/eval/debug 样本，不是每个内部事件一行的 EventLog。

### 3.2 持久化形态

Hermes 主要有两层：

- SQLite：`references/hermes-agent/hermes_state.py` 中的 `SessionDB`
- JSONL：`references/hermes-agent/agent/trajectory.py` 中的 trajectory samples

`SessionDB` 使用 SQLite 保存历史 session/message，并且有 FTS5 搜索能力。它还做了比较工程化的处理：

- WAL 模式
- 写入 retry
- checkpoint
- read-only cross-profile attach
- message-level 查询和会话搜索

`references/hermes-agent/run_agent.py` 里的 `_flush_messages_to_session_db` 会把新增 message flush 进 `SessionDB`。它会跟踪已持久化的 message object identity，避免重复写。

### 3.3 写入链路挂点

Hermes 的写入挂点大致是：

- agent run loop 维护 `messages`
- turn finalizer 在每轮结束后触发持久化和 background review
- `_persist_session(messages, conversation_history)` 保存 session log，并 flush 到 SQLite
- `_save_trajectory(messages, user_query, completed)` 保存 trajectory JSONL
- background review 用对话快照生成 memory/skill 候选
- `write_approval.py` 的审批 gate 决定候选能否真正写入 memory/skill

相关函数/类：

- `references/hermes-agent/run_agent.py::_persist_session`
- `references/hermes-agent/run_agent.py::_flush_messages_to_session_db`
- `references/hermes-agent/run_agent.py::_save_trajectory`
- `references/hermes-agent/agent/trajectory.py::save_trajectory`
- `references/hermes-agent/agent/background_review.py`
- `references/hermes-agent/tools/write_approval.py::evaluate_gate`

### 3.4 后续消费

Hermes 的日志和轨迹主要被这些能力消费：

- `references/hermes-agent/tools/session_search_tool.py::session_search`：跨 session 搜索、读取、滚动历史上下文。
- background review：从一次任务中提炼 memory/skill candidate。
- memory/skill manager：把批准后的经验写成下次可加载资产。
- trajectory JSONL：保留成功/失败样本，服务训练/eval/debug。

Hermes 的 self-improve 本质是：

用户任务完成后，不是直接修改模型，而是由 background review 把经验提炼成 memory/skill 候选，再经过 approval/pending/diff/rollback 等机制，变成下次 agent 可加载的资产。

### 3.5 对 Huaness Lite 的启发

Huaness Lite 不需要 P0 就复制 Hermes 的 SQLite FTS 和完整 self-improve，但需要提前把 EventLog 设计成 self-improve 友好：

- 每个 run 要能生成一个 replay/eval view：模型看到了什么、调用了什么工具、观察到了什么、为什么结束。
- tool call、observation、error、approval 必须有稳定 ID，可以被 background review 引用。
- P0 可以先做 `self_improve.candidate_created`、`self_improve.candidate_approved` 这类事件，但真正 memory/skill 写入可以后置。
- 后续如果做 self-improve，JSONL EventLog 是原始事实来源，SQLite 只是检索历史任务的索引。

## 4. OpenClaw

### 4.1 记录哪些事件/轨迹

OpenClaw 有两套特别值得看：

1. session transcript：保存会话消息和 parent-linked 结构。
2. ACP event ledger：保存可重放的客户端 session update。

关键文件：

- `references/openclaw/packages/agent-core/src/harness/session/jsonl-storage.ts`
- `references/openclaw/src/config/sessions/transcript-append.ts`
- `references/openclaw/src/agents/session-write-lock.ts`
- `references/openclaw/src/acp/event-ledger.ts`
- `references/openclaw/src/acp/translator.session-updates.ts`
- `references/openclaw/src/acp/translator.ts`
- `references/openclaw/src/state/openclaw-state-schema.generated.ts`

`jsonl-storage.ts` 的 session header 形态：

```ts
type SessionHeader = {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: { id: string; source: string };
};
```

entry 里有：

- `type`
- `id`
- `parentId`
- `timestamp`
- leaf/target 信息

这说明 OpenClaw 的 transcript 不只是平铺消息，它保留了父子关系，便于 session 分叉、恢复和 leaf 管理。

### 4.2 持久化形态

OpenClaw 同时使用：

- JSONL transcript
- ACP file ledger
- SQLite ACP ledger

`references/openclaw/src/acp/event-ledger.ts` 定义的 ledger entry：

```ts
type AcpEventLedgerEntry = {
  seq: number;
  at: string;
  sessionId: string;
  sessionKey: string;
  runId?: string;
  update: SessionUpdate;
};
```

它支持：

- `startSession`
- `recordUserPrompt`
- `recordUpdate`
- `markIncomplete`
- `readReplay`
- `readReplayBySessionId`
- `readReplayBySessionKey`

本地 file ledger 默认类似状态文件：`acp/event-ledger.json`。SQLite schema 在 `references/openclaw/src/state/openclaw-state-schema.generated.ts` 中，核心表包括：

- `acp_replay_sessions`
- `acp_replay_events`

`acp_replay_events` 用 `(session_id, seq)` 作为主键，这个设计很关键：replay 依赖严格的 per-session sequence。

### 4.3 写入链路挂点

OpenClaw 的写入链路接在 transcript append、ACP translator 和 tool/session update 上。

关键路径：

- `references/openclaw/src/config/sessions/transcript-append.ts`
  - `ensureTranscriptHeader`
  - `withTranscriptAppendQueue`
  - transcript migration
  - idempotency lookup
- `references/openclaw/src/agents/session-write-lock.ts`
  - 跨进程 session 写锁
  - stale lock 检测
  - signal cleanup
- `references/openclaw/src/acp/translator.session-updates.ts`
  - 负责把 ACP client updates 和 replay ledger writes 保持同步
- `references/openclaw/src/acp/translator.ts`
  - `newSession` 启动 ledger session
  - `loadSession` 优先走 ledger replay，失败再 fallback transcript
  - prompt/tool/agent message/session snapshot 都会 record 成 update

这里的重点不是“所有日志都写一份”，而是把 replay 需要的语义事件接在 session update 发送点上。也就是说：客户端看到什么，ledger 就记录什么；load session 时就能重放同样的 session update。

### 4.4 后续消费

OpenClaw 的日志被这些能力消费：

- session transcript：恢复历史、append 新消息、维护 leaf。
- ACP ledger：`loadSession` 时 rehydrate ACP client。
- SQLite ledger：更稳定地按 session/seq 查询 replay events。
- fallback：ledger 不完整时退回 transcript replay。
- debug/audit：transcript + ledger 都能反查一次 run 的过程。

### 4.5 对 Huaness Lite 的启发

OpenClaw 给 Huaness 的最大启发是：replay log 应该记录“系统语义事件”，不只是原始聊天消息。

Huaness P0 可以先不做 ACP 这种协议层 ledger，但需要：

- 每个 run 内递增 `seq`。
- 每个 tool call 有 `toolCallId`。
- model response、tool request、policy decision、tool result、observation appended 之间能被串起来。
- replay view 能复原 agent loop 的关键状态，而不只是展示聊天气泡。
- 如果未来有 UI/channel replay，再从 EventLog 派生 UI event，不要让 UI event 反过来污染 core event。

## 5. Codex

### 5.1 记录哪些事件/轨迹

Codex 的设计最值得 Huaness 学习的是“分层记录”：

- rollout JSONL：用于 session resume/fork/reconstruction 的 durable history。
- EventMsg/ResponseItem：经过 policy 筛选后的可持久化项目。
- session index JSONL：用于线程列表/搜索。
- state DB：SQLite 元数据和状态索引。
- rollout trace：可选 raw debug trace，记录更细粒度、敏感的事件。

关键文件：

- `references/codex/codex-rs/rollout/src/lib.rs`
- `references/codex/codex-rs/rollout/src/recorder.rs`
- `references/codex/codex-rs/rollout/src/policy.rs`
- `references/codex/codex-rs/rollout/src/search.rs`
- `references/codex/codex-rs/rollout/src/session_index.rs`
- `references/codex/codex-rs/rollout/src/state_db.rs`
- `references/codex/codex-rs/core/src/session/rollout_reconstruction.rs`
- `references/codex/codex-rs/core/src/session/mod.rs`
- `references/codex/codex-rs/core/src/event_mapping.rs`
- `references/codex/codex-rs/rollout-trace/README.md`
- `references/codex/codex-rs/rollout-trace/src/writer.rs`

### 5.2 持久化形态

Codex rollout recorder 的注释目标很明确：把 session rollout 持久化成 `.jsonl`，便于之后 replay 或 inspect。

`references/codex/codex-rs/rollout/src/recorder.rs` 中的 `RolloutRecorder` 使用后台 writer task 写 JSONL：

- `record_canonical_items`
- `persist`
- `resume_rollout`
- `append_rollout_item_to_path`
- `JsonlWriter::write_rollout_item`

`resume_rollout` 会逐行读取 rollout：

- `SessionMeta`
- `ResponseItem`
- `Compacted`
- `TurnContext`
- `EventMsg`

它还会统计 parse error，但尽量恢复可用历史。

Codex 还有：

- `references/codex/codex-rs/rollout/src/session_index.rs`：append-only `session_index.jsonl`
- `references/codex/codex-rs/rollout/src/state_db.rs`：SQLite state DB
- `references/codex/codex-rs/rollout-trace/README.md`：可选 trace bundle

rollout trace 的文件树大致是：

- `manifest.json`
- `trace.jsonl`
- `payloads/*.json`
- 可选 `state.json`

`references/codex/codex-rs/rollout-trace/src/writer.rs` 中的 `TraceWriter` 会给 raw trace event 分配：

- `schema_version`
- `seq`
- `wall_time_unix_ms`
- `rollout_id`
- `thread_id`
- `codex_turn_id`
- `payload`

### 5.3 写入链路挂点

Codex 的写入链路接在 core session event dispatch 上。

关键点：

- `references/codex/codex-rs/core/src/session/mod.rs`
  - `send_event` 一边发送事件给客户端，一边记录协议/tool 事件到 rollout trace。
  - `record_initial_history` 用 rollout reconstruction 恢复历史，支持 resume/fork。
  - `flush_rollout`、`ensure_rollout_materialized` 管理持久化。
- `references/codex/codex-rs/rollout/src/policy.rs`
  - 决定哪些 `ResponseItem` 和 `EventMsg` 应该进入 durable rollout。
  - 很多 streaming delta、warning、begin 类事件不会进入 durable history。

这个 policy 很重要：Codex 没有把所有 UI/过程噪音都塞进持久化历史。它区分：

- durable history：恢复和记忆需要。
- UI stream：用户实时看到即可。
- debug trace：需要时额外开启。

### 5.4 后续消费

Codex 的日志被这些能力消费：

- `references/codex/codex-rs/core/src/session/rollout_reconstruction.rs`
  - 反向 replay
  - 处理 compaction、rollback、replacement history
  - 重建 history、previous turn settings、reference context、window id
- `references/codex/codex-rs/core/src/event_mapping.rs`
  - 把 `ResponseItem` 映射成用户界面的 `TurnItem`
- `references/codex/codex-rs/rollout/src/session_index.rs`
  - 线程列表和搜索
- memory 相关过滤
  - `policy.rs` 里有 `should_persist_response_item_for_memories`
- rollout trace reducer/debug
  - `rollout-trace` 的设计目标是 observe first, interpret later

### 5.5 对 Huaness Lite 的启发

Codex 给 Huaness 的关键启发：

1. 不同日志层服务不同需求。
   - EventLog：核心事实。
   - ReplayView：恢复/调试视角。
   - UIEvent：界面展示视角。
   - RawTrace：深度 debug，可选开启。

2. 持久化要有 policy。
   - 不应把所有 streaming token/delta 都永久保存。
   - P0 可以只保存完整 model response、tool call、tool result、error、approval 和 summary。

3. reconstruction 是一等能力。
   - 只 append 事件还不够，需要有一个 reducer 能把事件流还原成 `RunReplay` 或 `AgentStateSnapshot`。

4. SQLite 更适合作为派生状态。
   - JSONL 保存原始事实。
   - SQLite 保存 list/search/index/status/metadata。

## 6. OpenHands

### 6.1 记录哪些事件/轨迹

当前本地 OpenHands 更明显的是平台化 Event Service，而不是单文件 agent loop。

关键文件：

- `references/openhands/openhands/app_server/event/event_service.py`
- `references/openhands/openhands/app_server/event/event_service_base.py`
- `references/openhands/openhands/app_server/event/filesystem_event_service.py`
- `references/openhands/openhands/app_server/event/aws_event_service.py`
- `references/openhands/openhands/app_server/event/google_cloud_event_service.py`
- `references/openhands/openhands/app_server/event_callback/webhook_router.py`
- `references/openhands/openhands/app_server/app_conversation/app_conversation_router.py`
- `references/openhands/openhands/app_server/app_conversation/live_status_app_conversation_service.py`
- `references/openhands/frontend/src/types/v1/core/base/event.ts`
- `references/openhands/frontend/src/types/v1/core/events/action-event.ts`
- `references/openhands/frontend/src/types/v1/core/events/observation-event.ts`
- `references/openhands/frontend/src/types/v1/core/events/message-event.ts`
- `references/openhands/frontend/src/api/event-service/event-service.api.ts`
- `references/openhands/frontend/src/hooks/query/use-conversation-history.ts`
- `references/openhands/.openhands/microagents/glossary.md`

OpenHands 的基础抽象是 Conversation Event。

前端类型里可以看到：

- `BaseEvent`
  - `id`
  - `timestamp`
  - `source`
- `MessageEvent`
  - role/content/tool_calls/reasoning/thinking blocks
- `ActionEvent`
  - thought/reasoning/action/tool_name/tool_call_id/raw tool_call/security_risk
- `ObservationEvent`
  - observation/tool_name/tool_call_id/action_id
- `AgentErrorEvent`
- `UserRejectObservation`

`.openhands/microagents/glossary.md` 也把 Conversation 定义为一系列 Events，Event 可以是 Action 或 Observation，Event Stream 是 agent 与 environment 之间的连续流。

### 6.2 持久化形态

OpenHands 使用 EventService 抽象存储后端。

`references/openhands/openhands/app_server/event/event_service.py` 定义接口：

- `get_event`
- `search_events`
- `count_events`
- `save_event`
- `batch_get_events`

`references/openhands/openhands/app_server/event/event_service_base.py` 定义路径布局：

- `prefix[/user_id]/v1_conversations/<conversation_id.hex>/`
- 每个 event 一个 `<event_id>.json`

后端实现包括：

- `filesystem_event_service.py`
  - 本地文件树，一事件一 JSON
- `aws_event_service.py`
  - S3 object
- `google_cloud_event_service.py`
  - GCS object

这是一种平台化设计：事件模型稳定，存储后端可替换。

### 6.3 写入链路挂点

本地可见的写入入口主要在 app server：

- `references/openhands/openhands/app_server/event_callback/webhook_router.py`
  - `POST /events/{conversation_id}` 接收一批 `Event`
  - 调用 `event_service.save_event`
  - 同时处理 analytics、callback、terminal status
- app conversation export/read path 通过 `event_service.search_events` 读取事件

这说明 OpenHands 更像把 agent event stream 暴露成平台服务事件，再由服务层做保存、查询、导出和 UI 消费。

### 6.4 后续消费

OpenHands 的事件被这些能力消费：

- 前端 conversation history
  - `references/openhands/frontend/src/api/event-service/event-service.api.ts`
  - `references/openhands/frontend/src/hooks/query/use-conversation-history.ts`
- trajectory zip 导出
  - `references/openhands/openhands/app_server/app_conversation/live_status_app_conversation_service.py::export_conversation`
  - 导出时会把 event 写成 `event_000000_<event.id>.json`，再加 `meta.json`
- analytics/callback
  - `webhook_router.py`
- UI 渲染
  - action/observation/message event 类型分别渲染

### 6.5 对 Huaness Lite 的启发

OpenHands 对 P0 的启发不是“马上做平台化事件服务”，而是：

- core event model 要能表达 Action 和 Observation。
- EventLog 的存储实现可以抽象，但 P0 只需要本地 JSONL。
- 每个事件有稳定 `id` 很重要，因为 UI、导出、批量查询都依赖 event identity。
- 如果未来做 web UI，可以从 core EventLog 派生 UI event，不要让 UI 事件类型主导 agent core。

Huaness Lite P0 应避免复制：

- S3/GCS 多后端。
- 一事件一 JSON 文件树。
- app server event callback 平台化链路。

这些属于多人/云平台场景，不是当前 Linux 单机 agent runtime 的第一优先级。

## 7. mini-swe-agent

### 7.1 记录哪些事件/轨迹

mini-swe-agent 的设计非常轻：trajectory 就是模型实际看到的 messages。

关键文件：

- `references/mini-swe-agent/src/minisweagent/agents/default.py`

`DefaultAgent.messages` 是完整线性历史。它没有把 trajectory 和 prompt messages 分成两套复杂结构。

`serialize` 输出：

- `info`
  - model stats
  - config
  - mini version
  - exit status
  - submission
- `messages`
- `trajectory_format: mini-swe-agent-1.1`
- model/env serialize 信息

### 7.2 持久化形态

mini-swe-agent 使用单个 `.traj.json` 文件，而不是 JSONL event stream。

`run` 的循环里会在 `finally` 调用 `self.save(self.config.output_path)`，所以即使中途异常、中断、达到限制，也尽量把当前 trajectory 保存下来。

### 7.3 写入链路挂点

写入挂在 agent loop 上：

- `query`：调用 model，把 assistant message append 到 `messages`
- `execute_actions`：执行 tool/action，把 observation append 到 `messages`
- `run`：每步 finally save

错误和停止条件也被记录进 serialize 的 `exit_status` 和 trajectory。

### 7.4 后续消费

主要消费者：

- benchmark eval
- trajectory inspector
- debug
- 结果提交文件

### 7.5 对 Huaness Lite 的启发

mini-swe-agent 证明 P0 replay/eval 可以先很简单：

- 先保证每个 run 可以导出一个“模型可见 messages + tool observations + final status”的 replay JSON。
- 不必一开始就做复杂数据库或 UI。
- 但 Huaness 仍然应该保留事件流，因为 Huaness 的目标包含 ToolGateway/Policy/EventLog，比 mini-swe-agent 更像 harness runtime。

## 8. Gemini CLI

### 8.1 记录哪些事件/轨迹

Gemini CLI 在本地资料中体现出四条线：

1. session management
2. chat recording
3. checkpointing
4. auto memory

关键文件：

- `references/gemini-cli/docs/cli/session-management.md`
- `references/gemini-cli/docs/cli/headless.md`
- `references/gemini-cli/docs/cli/checkpointing.md`
- `references/gemini-cli/docs/cli/auto-memory.md`
- `references/gemini-cli/packages/core/src/services/chatRecordingService.ts`
- `references/gemini-cli/packages/core/src/services/memoryService.ts`
- `references/gemini-cli/packages/core/src/core/agentChatHistory.ts`
- `references/gemini-cli/packages/core/src/output/stream-json-formatter.ts`
- `references/gemini-cli/packages/core/src/utils/checkpointUtils.ts`
- `references/gemini-cli/packages/cli/src/utils/sessions.ts`
- `references/gemini-cli/packages/cli/src/utils/autoMemory.ts`

session 文档说明它会自动保存：

- conversation history
- prompts/responses
- tool executions inputs/outputs
- token usage
- assistant thoughts/reasoning summaries

headless 模式会输出 JSONL stream：

- `init`
- `message`
- `tool_use`
- `tool_result`
- `error`
- `result`

### 8.2 持久化形态

Gemini CLI 使用：

- chat recording JSONL：`~/.gemini/tmp/<project_hash>/chats/`
- checkpoint 文件树：`~/.gemini/tmp/<project_hash>/checkpoints`
- shadow Git snapshot：`~/.gemini/history/<project_hash>`
- auto memory review inbox/state

`references/gemini-cli/packages/core/src/services/chatRecordingService.ts` 处理 JSONL 记录：

- initial metadata record
- message record
- `$set` metadata update
- `$rewindTo` record

它还支持从旧 `.json` 迁移到 `.jsonl`。

### 8.3 写入链路挂点

关键挂点：

- `references/gemini-cli/packages/core/src/core/agentChatHistory.ts`
  - 维护 agent history，作为模型请求的历史来源。
- `references/gemini-cli/packages/core/src/services/chatRecordingService.ts`
  - `recordMessage`
  - `recordSyntheticMessage`
  - `recordThought`
  - `recordMessageTokens`
  - `recordToolCalls`
  - `saveSummary`
  - `rewindTo`
- `references/gemini-cli/packages/core/src/utils/checkpointUtils.ts`
  - 在 approved file-modifying tool 之前创建 checkpoint。
  - 保存 `ToolCallData`：history、clientHistory、commitHash、toolCall、messageId。
- `references/gemini-cli/packages/core/src/output/stream-json-formatter.ts`
  - headless JSONL 输出。
- `references/gemini-cli/packages/core/src/services/memoryService.ts`
  - 扫描 session transcript，运行 extraction agent，生成 memory candidates。

### 8.4 后续消费

Gemini CLI 的记录被消费在：

- session list/resume/delete
- rewind
- checkpoint restore
- headless automation
- token/tool stats
- auto memory extraction
- review inbox

auto memory 文档里有几个边界很重要：

- 只处理 idle 足够久、用户消息数足够多的 session。
- 使用 lock/state 防止并发提取。
- extraction agent 生成候选，不直接修改活动记忆。
- 候选进入 review inbox，用户再 promote/apply/discard。
- 不能直接编辑 active memory、settings、credentials、project GEMINI.md 等敏感目标。

### 8.5 对 Huaness Lite 的启发

Gemini CLI 给 Huaness 的启发：

- `checkpoint` 不一定要等 Docker sandbox，P0 可以先记录“工具执行前后的状态引用”和 approval 决策。
- self-improve 应该从 transcript/EventLog 异步提取候选，不能在主 loop 里直接写 memory。
- memory 写入必须有 review inbox/pending/diff。
- headless JSONL stream 可以作为 CLI/HTTP adapter 的输出格式，但它不应该替代 core EventLog。

## 9. 抽象出的通用模式

### 9.1 日志分层

成熟项目通常不是只有一种日志。

| 层级 | 目的 | 典型内容 | 例子 |
| --- | --- | --- | --- |
| Transcript / Messages | 恢复模型上下文、eval | user/assistant/tool messages | mini-swe-agent `.traj.json`、Gemini chat recording |
| EventLog / Ledger | replay、审计、恢复状态 | run/model/tool/policy/approval/session update | OpenClaw ACP ledger、Huaness 当前 EventLog |
| UI Event | 展示用户界面 | action/observation/message/agent state | OpenHands EventService、Codex event mapping |
| Index / State DB | 查询、列表、搜索 | run metadata、session metadata、status、FTS | Hermes SessionDB、Codex state_db、OpenClaw SQLite ledger |
| Raw Trace | 深度 debug | 原始请求/响应/payload/source edge | Codex rollout-trace |
| Self-Improve Assets | 下次表现变好 | memory、skill、candidate、approval diff | Hermes memory/skill、Gemini auto memory |

Huaness Lite 不要把这些揉成一个巨大的事件类型。P0 可以只有 EventLog，但要预留派生 view：

- `ReplayView`
- `RunSummary`
- `ToolTimeline`
- `EvalSample`
- `SelfImproveCandidate`

### 9.2 写入点优先级

高价值写入点：

1. agent loop lifecycle
   - run start/end/fail/cancel/max steps
2. context assembly
   - model request 前到底拼了哪些消息
3. model client
   - request metadata、response、tool calls、usage/error
4. tool gateway
   - requested、policy decision、approval requested/resolved、started、completed、failed、blocked
5. observation append
   - 哪个 tool result 以什么形式回写给模型
6. policy/approval
   - 为什么允许/拒绝/等待
7. memory/self-improve
   - candidate created、approved、written、rejected
8. eval/replay
   - replay started/completed、eval case generated、score attached

低优先级写入点：

- QQ adapter 收到什么消息。
- HTTP request 原始细节。
- WebSocket 推送细节。

这些可以作为 channel log，但不应该决定 core EventLog 结构。

### 9.3 Append-only 与索引

多数项目都偏向 append-only source：

- JSONL transcript
- JSONL rollout
- JSONL chat recording
- event ledger

数据库常见角色不是一开始替代 append-only log，而是：

- 查询索引
- session/run 列表
- 状态快照
- FTS 搜索
- replay ledger 优化

这和 Huaness 当前方向一致：P0 JSONL，P1 SQLite 派生索引。

## 10. Huaness Lite P0 建议

### 10.1 Event schema 先补字段

建议把当前 `AgentEvent` 从自由字符串事件升级为“最小可 replay 事件”。

建议形态：

```ts
export interface AgentEvent {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly type: HuanessEventType;
  readonly source:
    | "channel"
    | "loop"
    | "context"
    | "model"
    | "tool_gateway"
    | "tool"
    | "policy"
    | "approval"
    | "memory"
    | "eval";
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly turnId?: string;
  readonly step?: number;
  readonly parentId?: string;
  readonly toolCallId?: string;
  readonly data?: Record<string, unknown>;
}
```

其中：

- `id` 用于引用单个事件。
- `seq` 用于 run 内稳定 replay/tail。
- `turnId` 用于把用户输入、上下文、模型响应和工具观察串起来。
- `step` 用于 max step/debug。
- `toolCallId` 用于串 tool request、policy、execution、observation。
- `parentId` 用于表达因果关系，例如 observation 来自哪个 tool.completed。

### 10.2 P0 事件类型

建议先收敛成这组：

```text
run.created
run.completed
run.failed
run.cancelled
run.max_steps_exceeded

turn.started
turn.completed

context.built

model.requested
model.responded
model.failed

tool.requested
tool.policy_decided
tool.approval_requested
tool.approval_resolved
tool.started
tool.completed
tool.failed
tool.blocked

observation.appended

replay.started
replay.completed
eval.sample_created
self_improve.candidate_created
self_improve.candidate_approved
self_improve.candidate_rejected
```

P0 不一定全部实现，但类型应先稳定下来。当前已有：

- `run.created`
- `model.requested`
- `model.responded`
- `tool.requested`
- `policy.decided`
- `tool.blocked`
- `tool.failed`
- `tool.completed`
- run terminal events

建议把 `policy.decided` 改名或兼容映射为 `tool.policy_decided`，让工具链事件更好聚合。

### 10.3 context/messages 记录策略

不要把所有大内容都无脑 inline 到事件里。建议分三层：

1. `context.built`
   - 记录 context 组成摘要：
     - system prompt version/name
     - recent message count
     - memory ids
     - skill ids
     - tool descriptions hash/version
     - token estimate
     - messages hash
   - 可选记录 artifact path。

2. `model.requested`
   - 记录：
     - model name
     - temperature 等参数
     - input message count
     - context event id
     - request hash

3. `replay artifact`
   - 保存真正用于 replay/eval 的模型可见 messages。
   - P0 可以直接存到同一个 run 目录：
     - `.huaness/runs/<runId>/model-input-<step>.json`
     - `.huaness/runs/<runId>/replay.json`

这样能兼顾：

- EventLog 轻量可扫。
- replay/eval 有完整输入。
- 敏感内容未来可做 redaction。

### 10.4 P0 查询能力

当前只有 `readByRun`。建议先补这些读模型，不必上数据库：

```ts
interface EventReader {
  readByRun(runId: string): Promise<AgentEvent[]>;
  tailRun(runId: string, afterSeq?: number): Promise<AgentEvent[]>;
  listRuns(filter?: RunFilter): Promise<RunSummary[]>;
  readRunSummary(runId: string): Promise<RunSummary>;
  readToolTimeline(runId: string): Promise<ToolTimelineItem[]>;
  readReplayView(runId: string): Promise<RunReplay>;
  readErrors(runId: string): Promise<AgentEvent[]>;
}
```

P0 可以用文件扫描实现：

- 每个 run 写 `.huaness/runs/<encoded-run-id>/events.jsonl`
- 每个 run 写 `.huaness/runs/<encoded-run-id>/run.json`
- 维护 append-only `.huaness/runs/index.jsonl`
- session 视角可以后置，或维护 `.huaness/sessions/<sessionId>/runs.jsonl`

`run.json` 可以由 EventLog append 时顺手更新，或者由 `summarizeRun` 懒生成。

### 10.5 P0 ReplayView

Huaness P0 需要一个明确的 replay view reducer：

输入：

- `AgentEvent[]`
- 可选 model input artifact
- 可选 tool result artifact

输出：

```ts
interface RunReplay {
  runId: string;
  sessionId: string;
  status: "completed" | "failed" | "cancelled" | "max_steps_exceeded";
  startedAt: string;
  endedAt?: string;
  turns: ReplayTurn[];
  errors: ReplayError[];
}
```

每个 `ReplayTurn` 至少包含：

- context summary
- model request metadata
- assistant content
- tool calls
- policy/approval decision
- tool result
- observation appended

这一步比数据库更重要。没有 reducer，就算事件写了一堆，也很难用于 eval/debug/self-improve。

### 10.6 P0 EvalSample

P0 eval 不需要复杂 harness，可以先从 EventLog 导出：

```ts
interface EvalSample {
  runId: string;
  sessionId: string;
  input: {
    userTask: string;
    replayMessages: unknown[];
  };
  output: {
    finalAnswer?: string;
    toolCalls: unknown[];
    status: string;
  };
  labels?: {
    success?: boolean;
    notes?: string;
  };
}
```

导出路径可以是：

- `.huaness/runs/<runId>/eval-sample.json`
- `.huaness/evals/<date>/samples.jsonl`

这对应 mini-swe-agent 的 `.traj.json` 思路，也方便后续做 regression eval。

### 10.7 P0 Self-Improve 事件

不要 P0 就自动改 prompt/skill。建议只先留事件和文件结构：

```text
self_improve.review_started
self_improve.candidate_created
self_improve.candidate_approved
self_improve.candidate_rejected
self_improve.asset_written
```

候选可以先是文件：

```text
.huaness/self-improve/pending/<candidate-id>.json
.huaness/self-improve/approved/<candidate-id>.json
.huaness/self-improve/rejected/<candidate-id>.json
```

候选引用 EventLog：

```ts
interface SelfImproveCandidate {
  id: string;
  runId: string;
  sourceEventIds: string[];
  kind: "memory" | "skill" | "prompt_note" | "tool_note";
  proposedPatch: unknown;
  rationale: string;
  status: "pending" | "approved" | "rejected";
}
```

这样可以学习 Hermes/Gemini 的模式：先沉淀候选，再审批写入。

## 11. 什么时候接 SQLite

不要因为“成熟项目有数据库”就提前接数据库。SQLite 应该在以下情况出现：

1. run 数量多，`listRuns`、`readBySession`、状态过滤开始慢。
2. 需要跨 run 全文搜索历史任务、错误、tool output。
3. 要做 UI dashboard，频繁分页查询。
4. self-improve 需要按关键词/工具/错误类型检索历史经验。
5. 需要跨进程并发读取/写入更稳定。
6. 需要保存派生状态，例如 run summary、tool timeline、eval score。

接入方式建议：

- JSONL 继续是 source of truth。
- SQLite 是 derived index。
- 启动时可以 replay JSONL 修复 SQLite。
- schema 先小：
  - `runs`
  - `events`
  - `sessions`
  - `tool_calls`
  - `eval_samples`
  - `self_improve_candidates`

不要 P1 就上 Postgres。Postgres 更适合：

- 多用户
- 远端服务
- 多 worker
- 需要远程 dashboard
- 团队共享日志

Huaness Lite 当前目标是 Linux 单机，SQLite 已经足够。

## 12. 建议开发顺序

建议下一步不要先写数据库，而是按这个顺序：

1. 扩展 `AgentEvent`
   - 加 `id`、`seq`、`source`、`turnId`、`step`、`toolCallId`、`parentId`。

2. 改 EventLog 写入
   - `JsonlEventLog.append` 分配或校验 seq。
   - 保证同 run 内 seq 递增。
   - 写入后可更新 `run.json` summary。

3. 统一事件命名
   - 把 `policy.decided` 归入 tool 语义链，或兼容映射。

4. 增加 `context.built` 和 `observation.appended`
   - 这是 replay/eval/self-improve 的关键缺口。

5. 增加 `RunReplay` reducer
   - 从 `AgentEvent[]` 生成可读 replay view。

6. 增加 JSONL/file index
   - `listRuns`
   - `readRunSummary`
   - `tailRun`

7. 增加 eval sample 导出
   - 先导出 JSON，不接真实 eval runner。

8. 再考虑 SQLite
   - 当 list/search/replay 已经有真实需求时，把 JSONL replay 到 SQLite index。

## 13. 最小架构图

```text
Channel Adapter
  -> AgentLoop
    -> context.built
    -> model.requested
    -> ModelClient
    -> model.responded
    -> ToolGateway
      -> tool.requested
      -> PolicyEngine
        -> tool.policy_decided
        -> tool.approval_requested/resolved
      -> ToolExecutor
        -> tool.started/completed/failed/blocked
      -> observation.appended
    -> run.completed/failed/cancelled
  -> JsonlEventLog
    -> events.jsonl
    -> run.json / index.jsonl
    -> ReplayReducer
      -> RunReplay
      -> EvalSample
      -> Debug View
      -> SelfImproveCandidate
    -> SQLite Index (P1)
```

## 14. 一句话决策

Huaness Lite P0 应把 JSONL EventLog 做成“可 replay 的语义事件流”，先补事件 ID、seq、上下文摘要、tool 因果链、run index 和 replay reducer；SQLite 只在跨 run 查询、UI、self-improve 检索真正需要时作为派生索引接入。
