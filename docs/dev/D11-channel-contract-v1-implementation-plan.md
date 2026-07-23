# HuanLink v1.0 Channel Contract v1 实施计划

> **状态：执行中，B01 已按新增附件决策更新并等待复核。** D10 的产品边界和本文总体批次已经确认；新增要求是正式代码不得继续使用 `phase4` / `Phase4` 阶段命名。本文只规划 M1 的 Channel 闭环，不授权提交、推送或进入 M2～M5。

## 1. 目标结果

把当前 QQ Demo Channel 渐进迁移为平台无关的 Channel Runtime，并保留已经验证的 QQ -> MainAgent -> A2A -> Codex -> 原会话链路。

完成后应具备：

- Core 不依赖 OneBot 类型或平台名；
- OneBot 11 是内置的一等 Adapter，使用正向 WebSocket 双向收发；
- 群聊按群 ID 共享 session，私聊按私聊会话 ID 隔离；
- 文本、提及和附件引用使用统一 `parts`；
- 远程附件使用 HTTP(S) URL；平台已落地的本地附件进入 HuanLink 受管缓存，合同只携带不透明 ID；
- HuanLink v1 不做代理、转码或自动上传附件；
- Server 按稳定 `channelId` 注册、路由和回复 Channel；
- 正式源码、导出、测试和日志命名不再包含 `phase4` / `Phase4`。

## 2. 当前事实基线

- `packages/core/src/channels/types.ts` 把 `channel` 固定为 `"onebot11"`，消息和发送接口只有纯文本。
- `ForwardWebSocketOneBot11Channel` 同时拥有 WebSocket、重连、Action/`echo` 关联、协议解析和 Channel 映射。
- `group-message.ts` 只解析 OneBot 群消息；私聊、引用回复和附件链接尚未进入统一合同。
- `apps/server/src/phase4-qq-runtime.ts` 固定单个 Channel 和目标群，并用 `onebot11:group:<groupId>` 生成 session。
- `.huanlink/config/server/channels/onebot11.json` 已有稳定 `channelId`，但正式运行入口尚未使用该配置树。
- 现有 QQ 编排、出站顺序、进程关闭和 OneBot WebSocket 测试必须作为回归资产保留。

## 3. 实施边界

### 本计划负责

- Core Channel Contract v1；
- OneBot 11 Codec、正向 WebSocket Transport 和 Channel Adapter；
- Server Channel Runtime、会话路由、实例注册和进程生命周期；
- Channel 配置接入及显式会话白名单；
- HuanLink AttachmentStore 的安全导入、受控解析、容量和过期清理；
- 当前 QQ 真实闭环的回归与复验。

### 本计划不负责

- Telegram 实现；
- OneBot 反向 WebSocket 或 HTTP Transport；
- 编辑、撤回、reaction、typing 和流式消息的实际命令及 Adapter 实现；Contract 保留这些能力位，未实现的 Adapter 必须声明为不支持；
- 主动下载远程附件、附件代理、转码、自动上传或长期归档；
- 多租户权限平台、跨平台身份合并和远程公网鉴权；
- M2～M5 编排、管理界面和工业化扩展。

## 4. 目标职责结构

| 模块 | 拥有状态和职责 | 不拥有 |
|---|---|---|
| Core Channel Contract | 路由、消息 Parts、能力、发送命令、回执、错误、session key | OneBot JSON、WebSocket、配置读取 |
| HuanLink AttachmentStore | 本地附件安全导入、受管缓存、ID 解析、容量与过期清理 | 平台消息映射、远程下载、自动上传 |
| OneBot11 Codec | 纯函数解析事件/响应、编码 API Action 和消息段 | Socket、重连、Server session |
| Forward WebSocket Transport | Socket、鉴权、连接状态、重连、Action/`echo`、超时、关闭 | Channel 业务语义、MainAgent |
| OneBot11 Channel Adapter | OneBot 与统一合同双向映射、能力声明 | HuanLink 会话存储、AgentCall |
| Server Channel Runtime | Adapter 注册、启动/关闭、白名单、session 路由、出站顺序、结果回流 | 平台协议解析、附件内容读写 |

建议的正式文件名使用职责，不使用阶段号：

```text
packages/core/src/channels/
  types.ts
  session-key.ts

packages/core/src/attachments/
  attachment-store.ts
  types.ts

packages/integrations/onebot11/src/
  codec.ts
  forward-websocket-transport.ts
  channel-adapter.ts
  types.ts

apps/server/src/
  channel-runtime.ts
  process-lifecycle.ts
  main.ts
```

文件只在职责确实独立时拆分；不为每个小类型单独建立文件。

## 5. B01：Core Channel Contract 闭环

### 修改

- 为保证当前 QQ 链在 B05 切换前始终可构建，B01 先以 `contract-v1.ts` 暴露新合同，暂时保留现有 Demo 合同；B05 切换所有调用方后删除旧合同并把 v1 名称收敛为正式名称，不长期保留双接口。
- 用 `channelId + platform + accountId + capabilities` 描述 Channel 实例。
- 定义 `direct | group | channel` 会话路由和可选 `threadId`。
- 发送者身份包含必填 `id`、必填 `username` 和可选会话内 `displayName`；基础名称缺失时 Adapter 用 `id` 回退。
- 定义有序 `text`、`mention`、`attachmentRef` Parts。
- `attachmentRef.source` 只接受 HTTP(S) `remoteUrl` 或 HuanLink 受管 `localCache.attachmentId`，并携带少量可选元数据。
- 定义统一入站消息、出站命令、`DeliveryReceipt` 和稳定错误类型。
- 将 Adapter 发送接口升级为 `send(command)`，不再只暴露 `sendText`。
- 增加统一 session key 生成函数；发送者 ID 不参与 session key。

### 验收

- Fake Adapter 不引用 OneBot 类型即可通过统一合同收发。
- 相同平台会话 ID 在不同 `channelId` 下不会冲突。
- 同群不同发送者得到同一个 session；不同群和不同私聊得到不同 session。
- Adapter 可以在合同外接收平台本地路径作为 AttachmentStore 导入来源；非 HTTP(S) 远程链接、路径形式的缓存 ID 和任何未经导入的原始路径字段在合同边界被拒绝。

### 停点

只完成合同和 Core 测试，不修改真实 OneBot 或 Server 运行装配。

## 6. B02：OneBot 职责拆分闭环

### 修改

- 从现有大文件提取纯 `OneBot11Codec`。
- 将 Socket、鉴权、重连、Action/`echo`、超时和关闭集中到 `ForwardWebSocketOneBot11Transport`。
- 建立 `OneBot11ChannelAdapter`，首步只复现当前群文本行为。
- 保持日志脱敏和已有连接失败语义。

### 验收

- Codec 测试不创建真实 WebSocket。
- Transport 测试不依赖 Core 消息和 MainAgent。
- 现有连接、重连、并发 `echo`、超时、关闭和群文本测试继续通过。
- 本批不增加新消息能力，便于确认拆分没有改变行为。

### 停点

报告拆分后的职责、文件规模和全部回归结果，经 review 后再进入功能映射。

## 7. B03：HuanLink AttachmentStore 闭环

### 修改

- 在固定的 `.huanlink/runtime/attachments/` 下建立受管缓存；该目录加入 `.gitignore`，不由配置 JSON 改变。
- 提供最小 `importLocalFile`、`resolve` 和 `removeExpired` 边界；对外只返回或接受不透明 `attachmentId`。
- 导入时复制到受管目录并原子完成，使用安全生成的文件名；不把平台原路径当作缓存路径。
- 校验来源是真实存在的普通文件，拒绝符号链接或越界解析，并应用单文件大小、总容量和存活时间限制。
- 日志和事件只记录 `attachmentId`、类别、大小等安全元数据，不记录原始绝对路径或附件内容。

### 验收

- 使用临时目录覆盖导入、解析、过期清理和容量限制测试。
- 导入后原文件变化不影响缓存副本。
- 路径穿越、符号链接逃逸、目录、超限文件和未知 `attachmentId` 被明确拒绝。
- 测试、日志和 Channel Contract 中不暴露缓存绝对路径。

### 停点

只证明受管缓存模块本身完成，不接入 OneBot 或 Server。

## 8. B04：OneBot Contract v1 映射闭环

### 修改

- 入站映射群聊和私聊路由、发送者、提及、引用关系与有序 Parts。
- OneBot `user_id`、`sender.nickname`、非空 `sender.card` 分别映射为发送者 `id`、`username`、`displayName`；nickname 缺失时 `username` 回退为 `id`。
- 图片、语音、视频和文件直接提供 HTTP(S) URL 时生成 `remoteUrl`。
- OneBot 提供可读本地路径时，通过注入的 `AttachmentStore` 导入后生成 `localCache`；只有文件 ID 时可先调用 OneBot 获取文件能力令其落地，再执行相同导入。
- 无法得到远程链接或安全导入文件时明确报告不支持；路径、Base64 或字节不会进入统一合同。
- 出站映射文本、提及、引用回复和 `remoteUrl`；`localCache` 出站在 v1 返回 `not_supported`，不隐式上传。
- 发送成功从 OneBot 响应生成 `DeliveryReceipt`。
- 将远端失败映射为稳定 Channel 错误；不支持的能力返回 `not_supported`。
- Adapter 准确声明已实现能力，未实现能力不得声明为支持。
- Adapter 根据已实现能力和当前协议/账号条件生成最终能力；配置若提供能力限制，只能从中关闭或收窄，不能将不支持项改为支持。

### 验收

- 群聊和私聊事件映射测试通过。
- Parts 顺序、Bot 提及触发、命令触发和引用关系得到保留。
- 附件 URL 原样映射；本地文件只有 AttachmentStore 发生受控文件读写。
- Adapter 可以读取导入前的平台本地路径；完成导入后的统一合同只出现 URL 或 `attachmentId`，不会继续携带原始路径、缓存文件名、Base64 或原始字节。
- 主动发送与回复发送都通过同一个 `send(command)` 完成。

### 停点

只证明合同与 OneBot Adapter 代码完成，不声称已经接入 Server 或真实 QQ。

## 9. B05：Server Channel Runtime 与正式命名闭环

### 修改

- 用 `channel-runtime.ts` 取代 `phase4-qq-runtime.ts`，支持按 `channelId` 注册和查找 Adapter。
- 用规范路由生成 session，并按 session 保留现有出站顺序控制。
- 后台任务终态仍从 Conversation Store 读取原路由并返回原 Channel。
- 把 Channel 配置接入唯一 `.huanlink/config/config.json` 配置树。
- 配置只表达用户策略和能力限制，不重复维护完整能力表；Server 使用 Adapter 最终公布的 `capabilities`。
- 在 composition root 创建唯一 AttachmentStore，并注入需要导入或解析本地附件的 Adapter/本机 Tool；Server 不直接拼接缓存路径。
- 将当前单个 `groupId` 迁移为显式允许会话列表，区分 `group` 和 `direct`；v1 不提供隐式“允许全部”。
- 用 `process-lifecycle.ts` 取代 `phase4-process-lifecycle.ts`。
- 清理正式源码、导出、函数、类型、测试、fixture 和日志中的 `phase4` / `Phase4`。
- 逐步迁移已有测试，不先做一次无行为价值的全局改名。

### 正式命名

| 旧名 | 新名 |
|---|---|
| `phase4-qq-runtime.ts` | `channel-runtime.ts` |
| `Phase4QqRuntime` | `ChannelRuntime` |
| `createPhase4QqRuntime` | `createChannelRuntime` |
| `phase4-process-lifecycle.ts` | `process-lifecycle.ts` |
| `Phase4ShutdownSignal` | `ShutdownSignal` |
| `loadPhase4QqRuntimeConfig` | 由正式 Server 配置装配取代 |
| `createPhase4ServerRuntimeLogger` | `createServerRuntimeLogger` |
| `phase4.qq` 等日志前缀 | `channel.runtime` 等职责前缀 |
| `phase4-qq-*.test.ts` | `channel-runtime-*.test.ts` |
| `phase4-process-lifecycle.test.ts` | `process-lifecycle.test.ts` |

历史 D04、D06、D07 等文档记录真实开发阶段，不追溯改名。

### 验收

- 多个配置 Channel 使用稳定 `channelId`，相同平台会话 ID 不会串线。
- 白名单外消息不进入 Conversation Store 或 MainAgent。
- 群聊 session 整群共享，私聊 session 按私聊 ID 隔离。
- 主动消息、即时回复和后台终态都能回到指定路由。
- `apps/server/src` 和相应测试中不存在活动的 `phase4` / `Phase4` 命名。
- 旧 `phase4-qq` 文件和导出不保留兼容别名，避免形成两套入口。

### 停点

完成自动化验证和 review 后报告“已接入运行”的真实状态；尚未执行真实环境 smoke 时必须明确说明。

## 10. B06：整体回归与真实验证

按以下顺序验证：

1. Core Channel Contract 单元测试。
2. OneBot Codec、Transport、Adapter 单元测试。
3. AttachmentStore 安全导入、解析、限额和清理测试。
4. Server Channel Runtime、会话路由、出站顺序和进程关闭测试。
5. package 级测试、全仓 typecheck 和 build。
6. 在用户确认并具备 OneBot 环境时执行真实 QQ smoke。

真实 smoke 至少覆盖：

- QQ 群明确命令或 @ -> MainAgent -> A2A -> Codex -> 原群回复；
- HuanLink 主动向已允许群发送文本；
- 附件 URL 的 OneBot 映射，以及 OneBot 已落地本地附件的受管缓存导入；
- 断开连接后重连并恢复收发；
- 日志不泄漏 Access Token 或附件内容。

若私聊或真实附件环境不可用，只报告对应自动化结果，不把它们写成真实 smoke 已验证。

## 11. 提交和阶段门

- D10 与 D11 作为文档提交，和代码提交分开。
- B01～B05 每批只修改该批职责，完成测试和 review 后先报告。
- 未经用户确认，不提交或推送下一批结果，不 merge 到 `main`。
- 每次报告分别列出：合同已实现、代码已完成、已接入运行、真实 smoke 已验证。
- B06 完成并由用户确认后，才把 Channel 模块标记完成；之后仍不自动进入下一个模块或 M2。
