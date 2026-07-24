# HuanLink v1.0 Channel Contract v1 实施计划

> **状态：执行中，B01 已提交并推送，B02 已完成代码与自动化验证并进行文件级复核。** 2026-07-24 起本文不再受原 M1 最小范围约束，改为把 Channel 作为独立模块逐步开发到成熟职责边界。B01 合同需要按新增的 OneBot 撤回能力补充修订；任何后续代码、提交和推送仍须逐批确认。

## 1. 目标结果

把当前 QQ Demo Channel 渐进迁移为平台无关的 Channel Runtime，并保留已经验证的 QQ -> MainAgent -> A2A -> Codex -> 原会话链路。

完成后应具备：

- Core 不依赖 OneBot 类型或平台名；
- OneBot 11 是内置的一等 Adapter，使用正向 WebSocket 双向收发；
- OneBot 11 Adapter 原生覆盖主要标准消息能力，包括群聊、私聊、提及、引用、HTTP(S) 媒体和撤回；
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
- OneBot 11 主要标准消息能力，以及通过受控 Tool 暴露的平台专属查询和群管理操作；
- Server Channel Runtime、会话路由、实例注册和进程生命周期；
- Channel 配置接入、群聊白名单/黑名单策略及群消息触发策略；
- HuanLink AttachmentStore 的安全导入、受控解析、容量和过期清理；
- 当前 QQ 真实闭环的回归与复验。

### 本计划不负责

- Telegram 实现；
- OneBot 反向 WebSocket 或 HTTP Transport；
- OneBot 11 标准没有定义的编辑、消息 reaction、typing 和原生流式更新；若具体实现提供扩展，必须检测后单独声明，不能默认开启；
- OneBot 隐藏 API、原始 Action 任意透传，以及向 Agent 暴露 Cookies、CSRF、凭证、远程重启或清理缓存；
- 主动下载远程附件、附件代理、转码、自动上传或长期归档；
- 多租户权限平台、跨平台身份合并和远程公网鉴权；
- Telegram 等其他平台 Adapter 和工业化扩展。

### OneBot 11 主要能力边界

| 层次 | 本计划原生支持 | 边界 |
|---|---|---|
| 通用 Channel 消息 | 群聊、私聊、文本、提及、引用回复、图片/语音/视频 HTTP(S) URL、主动撤回、撤回通知 | 通过统一 Channel 合同调用 |
| 入站附件 | 远程 URL 原样引用；平台已落地的本地文件导入 AttachmentStore | 不把原始路径、Base64 或字节带入 Core |
| 出站普通文件 | 发送 HTTP(S) 链接 | 不主动上传本地文件 |
| OneBot 专属操作 | 消息/合并转发查询、登录和运行状态、好友/群/成员查询、禁言、踢人、群名片、群名称、管理员、好友和加群请求、好友赞 | 使用具名、类型化 `OneBot11Operations`，通过受控 Tool 向 Agent 暴露 |
| 实现扩展能力 | 编辑、reaction、typing、流式更新等 | 不属于 OneBot 11 基线；只有运行实现明确支持时才能声明 |
| 敏感维护能力 | Cookies、CSRF、凭证、重启、清缓存、隐藏 API | 不向 Agent 暴露，也不提供任意 Action 透传 |

## 4. 目标职责结构

| 模块 | 拥有状态和职责 | 不拥有 |
|---|---|---|
| Core Channel Contract | 路由、消息 Parts、能力、发送命令、回执、错误、session key | OneBot JSON、WebSocket、配置读取 |
| HuanLink AttachmentStore | 本地附件安全导入、受管缓存、ID 解析、容量与过期清理 | 平台消息映射、远程下载、自动上传 |
| OneBot11 Codec | 纯函数解析事件/响应、编码 API Action 和消息段 | Socket、重连、Server session |
| Forward WebSocket Transport | Socket、鉴权、连接状态、重连、Action/`echo`、超时、关闭 | Channel 业务语义、MainAgent |
| OneBot11 Channel Adapter | OneBot 与统一合同双向映射、主要标准消息能力、能力声明 | HuanLink 会话存储、AgentCall |
| OneBot11 Operations | 具名的平台查询、请求处理和群管理操作 | 通用 Channel 语义、任意原始 Action 透传 |
| OneBot11 Operations Tool | Agent 可见参数、策略检查、确认和审计 | WebSocket、OneBot JSON 编码 |
| Server Channel Runtime | Adapter 注册、启动/关闭、入站访问策略、session 路由、出站顺序、结果回流 | 平台协议解析、附件内容读写 |

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
  operations.ts
  operations-tool.ts
  types.ts

apps/server/src/
  channel-runtime.ts
  process-lifecycle.ts
  main.ts
```

文件只在职责确实独立时拆分；不为每个小类型单独建立文件。

## 5. B01：Core Channel Contract 闭环

### 修改

- 为保证当前 QQ 链在 B07 切换前始终可构建，B01 先以 `contract-v1.ts` 暴露新合同，暂时保留现有 Demo 合同；B07 切换所有调用方后删除旧合同并把 v1 名称收敛为正式名称，不长期保留双接口。
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

### 实际结果

- 原 `ForwardWebSocketOneBot11Channel` 收敛为 40 行迁移期兼容外观，现有 Server 构造方式未改变。
- `codec.ts` 只负责 OneBot JSON frame 和群文本 Action 编码；`forward-websocket-transport.ts` 只拥有 WebSocket、鉴权、连接/重连、Action/`echo`、超时与关闭状态。
- `channel-adapter.ts` 只保留当前群文本事件映射、命令/@触发和旧 `sendText` 组合；未接入 B01 新合同，也未增加私聊、附件或引用回复。
- OneBot 复用 Server 注入的 Core JSONL/Pino RuntimeLogger 完成统一日志脱敏与异常隔离；`connection-error-sanitizer.ts` 只负责清理可能返回调用方的连接错误文本，现有 Server 实际日志语义保持不变。
- OneBot package 5 个测试文件、63 个测试通过；全仓类型检查、Server 现有回归和 OneBot 临时 emit build 通过。

### 停点

报告拆分后的职责、文件规模和全部回归结果，经 review 后再进入功能映射。

当前 B02 只证明拆分不改变原群文本行为，不代表 OneBot 11 Adapter 的最终能力范围已经完成。

## 7. B03：撤回命令合同修订

### 修改

- 将出站命令明确区分为发送消息和撤回消息，撤回使用稳定 `messageId`。
- `retract` 从仅保留的能力位改为可执行的通用 Channel 能力；Adapter 不支持时返回 `not_supported`。
- 编辑、reaction、typing 和流式更新继续保留能力描述，但不伪装成 OneBot 11 标准命令；具体实现扩展由 OneBot 专属操作层承接。
- `DeliveryReceipt` 必须保留平台返回的消息 ID，使后续引用、查询和撤回能够定位同一条消息。

### 验收

- Fake Adapter 可以发送消息、取得消息 ID 并撤回该消息。
- 缺失或非法 `messageId` 被合同边界拒绝。
- 不支持撤回的 Adapter 返回稳定 `not_supported`，不能静默成功。
- Core 合同不出现 OneBot Action 名称。

### 停点

只修订合同和 Core 测试，不提前修改 OneBot 或 Server 装配。

## 8. B04：HuanLink AttachmentStore 闭环

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

## 9. B05：OneBot 主要消息能力闭环

### 修改

- 入站映射群聊和私聊路由、发送者、提及、引用关系与有序 Parts。
- OneBot `user_id`、`sender.nickname`、非空 `sender.card` 分别映射为发送者 `id`、`username`、`displayName`；nickname 缺失时 `username` 回退为 `id`。
- 图片、语音、视频和文件直接提供 HTTP(S) URL 时生成 `remoteUrl`。
- OneBot 提供可读本地路径时，通过注入的 `AttachmentStore` 导入后生成 `localCache`；只有文件 ID 时可先调用 OneBot 获取文件能力令其落地，再执行相同导入。
- 无法得到远程链接或安全导入文件时明确报告不支持；路径、Base64 或字节不会进入统一合同。
- 出站映射文本、提及、引用回复和图片/语音/视频 `remoteUrl`；普通文件只发送 HTTP(S) 链接，`localCache` 出站返回 `not_supported`，不隐式上传。
- 使用 OneBot `delete_msg` 实现主动撤回，并把群聊与私聊撤回通知映射为统一事件。
- 发送成功从 OneBot 响应中的 `message_id` 生成 `DeliveryReceipt`；Transport 的 Action 响应不能继续丢弃 `data`。
- 将远端失败映射为稳定 Channel 错误；不支持的能力返回 `not_supported`。
- Adapter 准确声明已实现能力，未实现能力不得声明为支持。
- Adapter 根据已实现能力和当前协议/账号条件生成最终能力；配置若提供能力限制，只能从中关闭或收窄，不能将不支持项改为支持。

### 验收

- 群聊和私聊事件映射测试通过。
- Parts 顺序、Bot 提及触发、命令触发和引用关系得到保留。
- 附件 URL 原样映射；本地文件只有 AttachmentStore 发生受控文件读写。
- Adapter 可以读取导入前的平台本地路径；完成导入后的统一合同只出现 URL 或 `attachmentId`，不会继续携带原始路径、缓存文件名、Base64 或原始字节。
- 主动发送与回复发送都通过同一个 `send(command)` 完成。
- 成功发送返回 `messageId`；随后可通过统一撤回命令调用 `delete_msg`。
- 群聊和私聊撤回通知包含原消息 ID 和发生路由。

### 停点

只证明合同与 OneBot Adapter 代码完成，不声称已经接入 Server 或真实 QQ。

## 10. B06：OneBot 专属操作与受控 Agent Tool 闭环

### 修改

- 建立具名、类型化的 `OneBot11Operations`，不向上层暴露任意 `action + params`。
- 第一组覆盖消息和合并转发查询、登录/版本/运行状态、好友/群/群成员查询。
- 第二组覆盖禁言、全员禁言、踢人、群名片、群名称、管理员、专属头衔和退群。
- 第三组覆盖好友请求、加群请求/邀请和好友赞。
- 建立受控 Agent Tool：按操作类型校验参数、会话上下文、允许范围和必要确认，并记录审计日志。
- Cookies、CSRF、凭证、远程重启、清缓存和隐藏 API 不进入 Agent Tool。
- 具体 OneBot 实现未支持的操作返回稳定 `not_supported`；实现扩展能力单独检测和声明。

### 验收

- 每个暴露操作有类型校验、Action 编码、响应解析和失败映射测试。
- Agent Tool 无法构造未登记的 Action，不能通过附加字段绕过参数白名单。
- 群管理操作不能脱离明确群路由执行；需要确认的操作未经确认不得发送。
- 日志不包含 Access Token、Cookies、CSRF 或未经筛选的原始响应。

### 停点

只证明 OneBot 专属操作和受控 Tool 完成；未注册进 Server 前不声明 Agent 已经可以调用。

## 11. B07：Server Channel Runtime 与正式命名闭环

### 修改

- 用 `channel-runtime.ts` 取代 `phase4-qq-runtime.ts`，支持按 `channelId` 注册和查找 Adapter。
- 用规范路由生成 session，并按 session 保留现有出站顺序控制。
- 后台任务终态仍从 Conversation Store 读取原路由并返回原 Channel。
- 把 Channel 配置接入唯一 `.huanlink/config/config.json` 配置树。
- 配置只表达用户策略和能力限制，不重复维护完整能力表；Server 使用 Adapter 最终公布的 `capabilities`。
- OneBot Channel 配置增加显式 `inboundPolicy.groups`：
  - `mode` 只接受 `allowlist | denylist`；
  - `ids` 保存唯一的群号字符串列表；
  - `requireMention` 控制群消息是否必须明确 @ Bot。
- `allowlist` 只允许 `ids` 中的群进入 Agent；`denylist` 允许除 `ids` 外的群进入 Agent。`denylist` 是用户显式选择的开放策略，空 `ids` 表示允许所有群，不提供隐式模式或默认回退。
- `requireMention: true` 时只有明确 @ Bot 的群消息可以进入 Agent，命令前缀不能绕过；为 `false` 时保留“@ Bot 或匹配 `commandPrefix`”的触发方式。
- 访问策略先于消息解析、Conversation Store 和 MainAgent 执行；被群策略或 mention 策略拒绝的消息不创建会话、不调用 Agent、也不发送回复。
- 在 composition root 创建唯一 AttachmentStore，并注入需要导入或解析本地附件的 Adapter/本机 Tool；Server 不直接拼接缓存路径。
- 注册受控 OneBot Operations Tool；Agent 只能看到允许的具名操作，不获得原始 OneBot Action 或凭证。
- 将当前单个 `groupId` 迁移到上述群策略；私聊继续使用独立、显式的允许会话配置，不与群号列表混用。
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
- `allowlist` 模式只接收已登记群；`denylist` 模式拒绝已登记群并接收其他群。
- 缺失策略、非法模式、非正整数字符串群号和重复群号均导致配置启动失败，不猜测默认值。
- `requireMention: true` 拒绝未 @ 和仅命令前缀消息；为 `false` 时 @ 与命令前缀均可触发。
- 被群策略或 mention 策略拒绝的消息不进入 Conversation Store 或 MainAgent，且不产生出站回复。
- 群聊 session 整群共享，私聊 session 按私聊 ID 隔离。
- 主动消息、即时回复和后台终态都能回到指定路由。
- `apps/server/src` 和相应测试中不存在活动的 `phase4` / `Phase4` 命名。
- 旧 `phase4-qq` 文件和导出不保留兼容别名，避免形成两套入口。

### 停点

完成自动化验证和 review 后报告“已接入运行”的真实状态；尚未执行真实环境 smoke 时必须明确说明。

## 12. B08：整体回归与真实验证

按以下顺序验证：

1. Core Channel Contract 单元测试。
2. OneBot Codec、Transport、Adapter 单元测试。
3. OneBot 撤回、主要消息能力、专属操作和受控 Tool 测试。
4. AttachmentStore 安全导入、解析、限额和清理测试。
5. Server Channel Runtime、会话路由、出站顺序和进程关闭测试。
6. package 级测试、全仓 typecheck 和 build。
7. 在用户确认并具备 OneBot 环境时执行真实 QQ smoke。

真实 smoke 至少覆盖：

- QQ 群明确命令或 @ -> MainAgent -> A2A -> Codex -> 原群回复；
- HuanLink 主动向已允许群发送文本；
- 私聊收发、引用回复和发送后撤回；
- 附件 URL 的 OneBot 映射，以及 OneBot 已落地本地附件的受管缓存导入；
- 至少一个只读 OneBot 查询操作和一个经确认的群管理操作；
- 断开连接后重连并恢复收发；
- 日志不泄漏 Access Token 或附件内容。

若私聊或真实附件环境不可用，只报告对应自动化结果，不把它们写成真实 smoke 已验证。

## 13. 提交和模块门

- D10 与 D11 作为文档提交，和代码提交分开。
- B01～B07 每批只修改该批职责，完成测试和 review 后先报告。
- 未经用户确认，不提交或推送下一批结果，不 merge 到 `main`。
- 每次报告分别列出：合同已实现、代码已完成、已接入运行、真实 smoke 已验证。
- B08 完成并由用户确认后，才把 Channel 模块标记完成；之后仍不自动进入下一个模块。
