# HuanLink v1.0 Channel Contract v1 实施计划

> **状态：执行中，B01～B06 已提交并推送；B07 Core Conversation Session 基础已推送，当前会话 `reply` 闭环已在本地实现并待文件级审核，尚未接入正式 Server Channel Runtime 或真实 QQ。** 2026-07-24 起本文不再受原 M1 最小范围约束，改为把 Channel 作为独立模块逐步开发到成熟职责边界。任何后续代码、提交和推送仍须逐批确认。

## 1. 目标结果

把当前 QQ Demo Channel 渐进迁移为平台无关的 Channel Runtime，并保留已经验证的 QQ -> MainAgent -> A2A -> Codex -> 原会话链路。

完成后应具备：

- Core 不依赖 OneBot 类型或平台名；
- OneBot 11 是内置的一等 Adapter，使用正向 WebSocket 双向收发；
- OneBot 11 Adapter 原生覆盖主要标准消息能力，包括群聊、私聊、提及、引用、HTTP(S)/本机媒体和撤回；
- 群聊按群 ID 共享 session，私聊按私聊会话 ID 隔离；
- 入站由 Adapter 生成平台格式字符串和 `contentFormat`，OneBot 统一使用原始 CQ 字符串；
- 出站使用有序 `text | mention | attachmentLink | attachmentLocalPath` Parts，附件支持 HTTP(S) 链接和本机绝对路径；
- Channel 和 Adapter 不下载、缓存、持久化或维护入站附件资源，完整入站内容交给 session；
- Server 按稳定 `channelId` 注册和路由 Channel；Agent 只有显式调用当前会话 `reply` Tool 才产生 Channel 可见回复，普通最终文本、推理和执行过程不自动发送；
- session 结构化保留 Channel 消息以及 Agent Tool Call/Tool Result；发送回执只登记待回流关联，Bot 自身消息事件按 `channelId + messageId` 写入并去重；
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
- 当前会话 `reply` Tool、Agent Tool Call/Tool Result 结构化记录，以及发送回执与自身消息事件关联；
- Channel 配置接入及群聊白名单/黑名单转发策略；
- 轻量入站字符串合同、8 KiB 内容上限、session 转发和日志脱敏；
- 当前 QQ 真实闭环的回归与复验。

### 本计划不负责

- Telegram 实现；
- OneBot 反向 WebSocket 或 HTTP Transport；
- OneBot 11 标准没有定义的编辑、消息 reaction、typing 和原生流式更新；若具体实现提供扩展，必须检测后单独声明，不能默认开启；
- OneBot 隐藏 API、原始 Action 任意透传，以及由 Channel 自动注入 Cookies、CSRF、账号级凭证、远程重启或清理缓存；用户明确授权后由外层权限守卫放行的本机 Agent 操作不属于 Channel 职责；
- 入站附件下载、附件访问代理、持久化缓存、转码或长期归档；
- 多租户权限平台、跨平台身份合并和远程公网鉴权；
- Telegram 等其他平台 Adapter 和工业化扩展。
- 把 Conversation Session 投影为具体模型输入、在后续 turn 重放 Tool 历史、Token 窗口与上下文压缩；这些属于后续 Agent Runtime 模块。
- 后台任务终态读取历史并重新组装 Agent 上下文；Channel 只保证所有可见出站仍须通过显式 Tool 调用。

### OneBot 11 主要能力边界

| 层次 | 本计划原生支持 | 边界 |
|---|---|---|
| 通用入站消息 | 群聊、私聊、发送者、引用关系、原始平台内容字符串、内容格式和触发元数据 | Channel 只转发到 session，不决定是否调用 Agent 或回复 |
| OneBot 入站内容 | CQ 字符串原样保留；消息段数组由 Codec 编码为 CQ 字符串 | 不下载、缓存或维护附件；资源级 `key` 可随用户消息进入 session |
| 通用出站消息 | 有序 `text | mention | attachmentLink | attachmentLocalPath` Parts、引用回复、主动撤回 | 链接只接受 HTTP(S)；本机附件只接受 HuanLink/Adapter 所在机器可读的绝对路径 |
| 当前会话回复 | Agent 显式调用平台无关的 `reply` Tool；Handler 从可信 run context 取得固定 route，再调用 Channel `send()` | Agent 不提供任意群号、私聊 ID 或 `channelId`；普通最终文本不自动投递 |
| OneBot 专属操作 | 消息查询、合并转发查询与发送、登录和运行状态、好友/群/成员查询、禁言、踢人、群名片、群名称、管理员、好友和加群请求、好友赞 | 使用具名、类型化 `OneBot11Operations`，通过受控 Tool 向 Agent 暴露 |
| 实现扩展能力 | 编辑、reaction、typing、流式更新等 | 不属于 OneBot 11 基线；只有运行实现明确支持时才能声明 |
| 敏感维护能力 | Cookies、CSRF、账号级凭证、重启、清缓存、隐藏 API | 不由 Channel 注入消息或提供任意 Action 透传；外层明确授权流程另行负责 |

## 4. 目标职责结构

| 模块 | 拥有状态和职责 | 不拥有 |
|---|---|---|
| Core Channel Contract | 路由、发送者、入站字符串与格式、触发元数据、出站 Parts、发送/撤回命令、回执、错误、session key | OneBot JSON、CQ 语义、WebSocket、配置读取 |
| OneBot11 Codec | 纯函数解析事件/响应、CQ 字符串与消息段数组转换、Action 和出站消息段编码 | Socket、重连、Server session |
| Forward WebSocket Transport | Socket、鉴权、连接状态、重连、Action/`echo`、超时、关闭 | Channel 业务语义、MainAgent |
| OneBot11 Channel Adapter | OneBot 与统一合同双向映射、入站 CQ 规范化、发送者/触发识别、主要标准消息能力、能力声明 | HuanLink session、AgentCall、附件下载或资源仓库 |
| OneBot11 Operations | 具名的平台查询、请求处理和群管理操作 | 通用 Channel 语义、任意原始 Action 透传 |
| OneBot11 Operations Tool | Agent 可见参数、策略检查、确认和审计 | WebSocket、OneBot JSON 编码 |
| Conversation Session Store | Channel 消息、Tool Call/Tool Result 结构化记录、发送关联元数据和进程内去重 | 模型输入投影、Token 窗口与压缩、跨重启持久化 |
| Current-session Reply Tool | 只向显式 `external_channel` session 提供，取得可信当前 route、执行 Channel `send()`、返回精简回执并登记发送关联 | 任意目标发送、OneBot 专属 Action、自动发送 Agent 最终文本 |
| Server Channel Runtime | Adapter 注册、启动/关闭、入站访问策略、session 元数据与转发、出站顺序和自身消息回流 | 平台协议解析、CQ 解析、替 Agent 决定是否回复 |

建议的正式文件名使用职责，不使用阶段号：

```text
packages/core/src/channels/
  contract-v1.ts
  channel-instance-v1.ts
  channel-message-v1.ts
  channel-adapter-v1.ts
  channel-validation-v1.ts
  session-key.ts

packages/integrations/onebot11/src/
  codec.ts
  forward-websocket-transport.ts
  channel-adapter.ts
  operations.ts
  operations-tool.ts
  types.ts

apps/server/src/
  channel-runtime.ts
  channel-reply-tool.ts
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
- B01 首版为入站和出站共用定义有序 `text`、`mention`、`attachmentRef` Parts，并以 `remoteUrl | localCache` 表达附件来源；B04 将按最新确认边界修订入站合同，不能把 B01 首版描述成最终设计。
- 定义统一入站消息、出站命令、`DeliveryReceipt` 和稳定错误类型。
- 将 Adapter 发送接口升级为 `send(command)`，不再只暴露 `sendText`。
- 增加统一 session key 生成函数；发送者 ID 不参与 session key。

### 验收

- Fake Adapter 不引用 OneBot 类型即可通过统一合同收发。
- 相同平台会话 ID 在不同 `channelId` 下不会冲突。
- 同群不同发送者得到同一个 session；不同群和不同私聊得到不同 session。
- 首版附件来源和消息校验测试通过；B04 必须显式迁移相关类型和测试，不能长期保留两套入站合同。

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

## 8. B04：轻量入站字符串合同闭环

### 设计依据

- 28 号调查确认 OpenClaw 会下载并暂存入站附件，但这是其本地 Agent、视觉/音频处理和 Sandbox 链路的实现选择，不是 HuanLink 必须复制的通用边界。
- HuanLink 当前更重视 Channel 集成轻量化：Channel 负责把平台消息送进 session，不负责理解、下载、缓存、持久化或维护附件资源。
- OneBot 11/NapCat 的消息上报支持 CQ 字符串和消息段数组。CQ 字符串更短，适合当前只接受字符串的 MainAgent/AgentRuntime，也能保留 URL、资源级 `key` 和平台扩展字段。
- 因此不实施此前讨论的 `publicUrl | channelResource`、`resourceId` 注册表或 `openAttachment`；该方案作为已评估但未采用的设计，不进入代码。
- 入站和出站有意采用不对称合同：入站保留 Adapter 生成的平台字符串，出站继续使用少量平台无关 Parts。
- v1 默认 HuanLink Server、Channel Adapter 和 OneBot 实现运行在同一台机器并共享可见的本地文件路径；容器部署必须显式挂载目录，否则使用 HTTP(S) 链接。

### 修改

- 将 `InboundChannelMessageV1` 从共享消息 Parts 修订为：
  - `content: string`：Adapter 生成并保持完整顺序的平台内容；
  - `contentFormat: string`：非空、稳定的格式标识，OneBot 使用 `onebot11.cq`；
  - 可选 `contentOmitted`：只在内容超限时记录 `{ reason: "too_large", originalSizeBytes }`，此时 `content` 使用固定、短小的占位文本，不保留原内容；
  - 原有 `messageId`、route、sender、receivedAt、reply 和 trigger 元数据继续保留。
- 入站能力不再使用 `inboundPartTypes`；若能力合同仍需声明格式，改为 `inboundContentFormats`。出站能力继续声明 `outboundPartTypes`。
- 将出站 Parts 收敛为：
  - `text`：普通文本；
  - `mention`：平台内目标 ID；
  - `attachmentLink`：`image | audio | video | file` 类别和 HTTP(S) URL，可携带少量名称/MIME 元数据；
  - `attachmentLocalPath`：相同附件类别和 HuanLink/Adapter 所在机器可读取的绝对路径，可携带少量名称/MIME 元数据。
- Core 只校验本机附件路径是非空绝对路径，不读取、复制或持久化文件；文件存在性、平台上传和不支持错误由具体 Adapter 在发送时处理。
- 引用回复继续使用发送命令上的 `replyToMessageId`，撤回继续使用独立 `retract` 命令；edit、reaction、typing 和 streaming 不作为消息 Part。
- Adapter 可以解析入站内容以生成 sender、trigger 和引用等元数据，但不得修改交给 session 的规范内容；OneBot 原消息中的 @Bot、命令前缀和附件 CQ 段全部保留。
- `channelId`、conversation kind/ID、threadId 和 `contentFormat` 作为固定 session 元数据保存，不在每轮 Agent 文本中重复消耗上下文；每条消息保留 sender `id`、`username`、可选 `displayName` 和完整内容。
- 规范化后的入站 `content` 使用固定 8 KiB UTF-8 上限，即 `Buffer.byteLength(content, "utf8") <= 8192`。上限只计算内容，不计算 session 元数据。
- 超限时不截断、不拆分、不尝试删除 Base64 或附件字段；Channel 向 session 转发一条带原发送者、原始字节数和 `too_large` 原因的占位记录，不直接向群聊或私聊发送提示。是否调用 Agent、如何回复由上层策略决定。
- Channel 和 Adapter 不保存附件映射，不实现附件下载或 `openAttachment`，不把入站资源复制到 HuanLink 目录。
- 完整 CQ 内容允许进入 session，其中平台消息自带的资源级 URL、`key` 和 ID 被视为用户消息的一部分；OneBot Access Token、QQ Cookie、CSRF 等账号级凭证不得由 Channel 自动注入消息。
- 用户明确授权后由外层权限守卫允许 Agent 读取本机配置，不改变上述“Channel 默认不注入账号级凭证”的边界。
- 当前 session 只保证进程存活期间保存，B04 不引入数据库，也不承诺重启后恢复消息。
- 普通运行日志不保存完整入站内容。日志只记录消息/session/发送者标识、内容字节数、消息段类型和触发信息；可选预览必须只包含受长度限制的脱敏文本，并把 CQ 参数替换为 `[image]`、`[mface]` 等类型标记。

### 验收

- Fake Adapter 可以发送带 `content + contentFormat` 的群聊和私聊消息，Core 不解析平台字符串。
- 发送者 `id`、`username`、`displayName` 和原始内容进入 session 消息；固定 route 和格式信息只保存一次，不在每轮 Agent 输入中重复。
- OneBot CQ 中的 @、命令、URL、资源级 `key` 和未知 CQ 段不因 trigger 解析而丢失或改写。
- 8192 字节以内的内容原样转发；超过上限的内容只产生带 `contentOmitted.reason = "too_large"` 和原始字节数的 session 占位记录，不产生 Channel 出站消息。
- 出站 `text | mention | attachmentLink | attachmentLocalPath` 顺序得到保留；链接拒绝非 HTTP(S) URL，路径拒绝相对路径、文件 URI 和 Base64，合同不携带原始字节。
- 普通运行日志不出现完整 CQ 内容、附件 URL、资源级 `key`、本地路径或账号级凭证。
- Core、Adapter 和 Server 不出现附件缓存、资源注册表、`resourceId` 解析或 `openAttachment`。

### 停点

只完成 Core 入站/出站合同、校验和 Fake Adapter 测试，不修改真实 OneBot 或 Server 装配，不建立附件或 session 持久化。

## 9. B05：OneBot 主要消息能力闭环

### 修改

- 入站映射群聊和私聊路由、发送者、引用关系、原始 CQ 内容和触发元数据。
- OneBot `user_id`、`sender.nickname`、非空 `sender.card` 分别映射为发送者 `id`、`username`、`displayName`；nickname 缺失时 `username` 回退为 `id`。
- OneBot `message` 为 CQ 字符串时原样保留；为消息段数组时由 Codec 按 OneBot 转义规则编码成 CQ 字符串。两种输入进入 Channel 后都使用 `contentFormat: "onebot11.cq"`。
- OneBot Adapter 从 CQ 字符串或消息段数组中识别 @当前 Bot、引用和开头连续文本；Core Channel 根据这些临时平台事实统一判断 `mention | command`，不得用清理后的 trigger 文本替换原始 `content`。
- 通用命令以去除开头空白后的 `/名称` 开始；名称至少包含一个 Unicode 字母、数字、`_` 或 `-`，后面只能是空白或字符串结尾。未知命令仍标记为 `command`，具体命令是否合法、如何执行由后续层判断。
- 有效命令优先于 mention，群聊 `/命令` 不强制同时 @Bot。开头允许 reply、空白和一个或多个 @当前 Bot；命令前出现 @其他人时不得识别为命令，但消息中存在 @当前 Bot 时仍可回退为 `mention`。
- 上述平台事实只在 Adapter 调用 Core 判断函数时短暂存在；入站消息和 session 只保存最终 `trigger`，不保存 `mentionedSelf` 或清理后的开头文本。OneBot V1 不再配置固定 `commandPrefix`，旧入口在 B07 迁移前继续保留原配置。
- 图片、语音、视频、文件和商城表情等入站字段留在 CQ 字符串中；URL、`emoji_id`、`emoji_package_id` 和资源级 `key` 不拆成 HuanLink 附件对象。
- 规范化后的 CQ 内容超过 8 KiB 时生成 `too_large` session 占位消息；Adapter 不下载、不缓存、不持久化，也不主动回复原 Channel。
- 出站将 `text`、`mention`、`attachmentLink`、`attachmentLocalPath` 和引用回复映射为 OneBot 消息或 Action；图片/语音/视频使用对应 URL 或本机绝对路径消息段。普通文件不是 OneBot 11 公共消息段能力，B05 对 `kind: "file"` 返回 `not_supported`，扩展实现的文件上传移到 B06。
- 一个 `send(command)` 只映射为一个 OneBot 发送 Action 和一个平台消息；不能可靠合并的 Part 组合返回 `not_supported`，不得静默拆成多条消息。
- 使用 OneBot `delete_msg` 实现 HuanLink 主动撤回。平台上报的群聊与私聊撤回通知属于后续入站事件合同，不在 B05 混入普通消息流。
- 发送成功从 OneBot 响应中的 `message_id` 生成 `DeliveryReceipt`；Transport 的 Action 响应不能继续丢弃 `data`。
- OneBot 自身消息仍作为普通入站事件转发，发送者增加必填 `isSelf`；是否写入 session、是否触发 Agent 不由 Adapter 决定。
- 将远端失败映射为稳定 Channel 错误；不支持的能力返回 `not_supported`。发送请求可能已经到达平台、但因超时或断连无法取得响应时返回 `delivery_uncertain`，不自动重试，也不声称幂等或 exactly-once。
- Adapter 准确声明已实现能力，未实现能力不得声明为支持。
- Adapter 根据已实现能力和当前协议/账号条件生成最终能力；配置若提供能力限制，只能从中关闭或收窄，不能将不支持项改为支持。

### 验收

- 群聊和私聊事件映射测试通过。
- CQ 字符串输入原样保留；等价消息段数组编码后得到规范 CQ 字符串，特殊字符按 OneBot 规则转义。
- Bot 提及、通用 `/命令` 和引用关系得到识别；`command` 优先于 `mention`，@其他人在命令前会阻止命令误判，同时 @Bot、命令文本、附件 URL、资源级 `key` 和未知消息段仍保留在原始内容中。
- 8 KiB 以内内容进入 session；超限内容进入同一 session 的占位记录，不调用 OneBot 出站接口。
- 入站映射过程不产生附件副本、资源注册表或持久状态。
- Bot 自身消息带 `sender.isSelf = true` 进入统一事件流；其他发送者带 `sender.isSelf = false`，Adapter 不因发送者是 Bot 而丢弃消息。
- 主动发送与回复发送都通过同一个 `send(command)` 完成。
- 出站 `text | mention | attachmentLink | attachmentLocalPath` 顺序正确；HTTP(S) 链接和本机绝对路径按类型映射，相对路径、Base64、原始字节和非 HTTP(S) 附件链接返回合同校验错误。
- 成功发送返回 `messageId`；随后可通过统一撤回命令调用 `delete_msg`。
- `kind: "file"` 和无法合并成单条 OneBot 消息的组合稳定返回 `not_supported`，不会发送一部分内容或拆成多条消息。
- 请求已发出但响应结果未知时返回 `delivery_uncertain`，Transport 和 Adapter 都不自动重发。
- 日志只出现脱敏文本预览和消息元数据，不出现完整 CQ、资源级 `key` 或账号级凭证。

### 实际结果

- Core 发送者身份增加必填 `isSelf`，稳定错误码增加 `delivery_uncertain`；合同校验和回归测试已同步。
- Core 新增平台无关的触发判断函数，统一识别通用 `/命令` 并实现 `command` 高于 `mention` 的优先级；临时触发信号不进入消息合同或 session。
- 新 OneBot 11 V1 Adapter 已覆盖群聊/私聊入站、CQ 字符串与消息段数组、发送者/引用/触发映射、8 KiB 超限占位、自身消息转发和准确能力声明。
- OneBot 11 V1 现在只提取 @当前 Bot 和开头连续文本等平台事实，再复用 Core 触发判断；V1 已移除固定 `commandPrefix`，旧入口暂留到 B07。
- 出站已实现群聊/私聊单 Action 发送、引用、提及、图片/语音/视频链接或本机绝对路径、平台 `message_id` 回执和 `delete_msg` 主动撤回；普通文件稳定返回 `not_supported`。
- Transport 现在向 Adapter 返回完整 Action 响应；已发出但超时、断连或收到 `async/1` 的请求返回 `delivery_uncertain`，不自动重发。远端失败只保留 `status/retcode`，标准通信错误映射为稳定 Channel 错误，普通日志不再提供任意消息 payload 或远端原文入口。
- OneBot 11 分包 7 个测试文件、96 个测试通过；Core 16 个测试文件、187 个测试通过；全仓 618 个测试通过、2 个按既有条件跳过，全仓类型检查和构建通过。
- 本批没有修改 Server 装配、session 写入或 Agent 触发逻辑，也未连接真实 OneBot/QQ；这些结果只证明 B05 合同与 Adapter 代码闭环。

### 停点

只证明合同与 OneBot Adapter 代码完成，不声称已经接入 Server 或真实 QQ。

## 10. B06：OneBot 专属操作合同闭环

### 修改

- 建立具名、类型化的 `OneBot11Operations`，不向上层暴露任意 `action + params`。
- 通用 Channel 发送只服务当前 session 的固定路由；跨群、跨私聊发送属于 OneBot Adapter 专属操作，不新增平台无关的任意目标发送 Tool。
- `standard` 覆盖消息发送、消息和合并转发查询、登录/版本/运行状态、好友/群/群成员查询及好友赞；当前不考虑多账号选择，一个 Operations 实例只绑定一个 Transport。
- 对明确支持 NapCat/go-cqhttp 兼容扩展的实现提供群聊和私聊合并转发发送；同时支持引用已有 `messageId` 的节点，以及由 `userId + displayName + content` 构造的自定义节点。自定义 `content` 保持 OneBot CQ 字符串，不开放任意 Action。
- `privileged` 覆盖撤回、禁言、全员禁言、踢人、群名片、群名称、管理员、专属头衔、退群、好友请求和加群请求/邀请；撤回不检测消息归属，统一交由后续特权审批。
- 对明确支持扩展文件 API 的实现提供可选普通本机文件上传扩展；不根据实现名称猜测能力，也不主动探测未知 Action。未注入扩展时抛出稳定的 `not_supported` 错误。
- 所有成功操作直接返回远端原始 `response.data`，不返回完整 OneBot 响应信封，也不做实现相关字段归一化；Transport 继续负责远端失败、断连、超时和结果不确定错误。
- 运行时只接受每个具名操作允许的字段，并校验 ID、布尔值、时长、枚举和本机文件路径；ID 是否真实存在、目标是否在 Agent 允许范围及特权操作是否获批留给后续运行时策略。
- Cookies、CSRF、账号级凭证、远程重启、清缓存和隐藏 API 不通过 `OneBot11Operations` 暴露；用户明确授权后由其他本机 Agent 工具读取配置的行为由外层权限守卫负责。
- B06 只修改 `packages/integrations/onebot11`；`onebot_standard`、`onebot_privileged` Tool Handler、统一审批策略和 Server 注册留到 B07。

### 验收

- 每个暴露操作有类型校验、Action 编码、原始 `response.data` 返回和失败透传测试。
- `OneBot11Operations` 无法构造未登记的 Action，不能通过附加字段绕过参数白名单。
- 群管理操作必须包含合法群号；文件上传或合并转发扩展缺失时稳定返回 `not_supported`。
- Operations 和 Transport 日志不包含 Access Token、Cookies、CSRF 或未经筛选的原始响应。

### 实际结果

- OneBot Adapter 现在直接暴露同一 Transport 上的 `operations.standard` 和 `operations.privileged`；前者包含 21 个普通查询、发送和可选扩展方法，后者包含 11 个撤回、群管理和请求处理方法。
- `standard` 新增群聊和私聊合并转发发送。显式启用 `go-cqhttp-compatible` 扩展后，可按原顺序混合发送引用节点和自定义节点；未启用时稳定返回 `not_supported`。
- 所有标准 OneBot Action 都由内部具名构造器编码；运行时拒绝额外字段、非法 ID、非法时长、非法枚举和错误类型，不向 Agent 或 Server 暴露任意 Action 构造入口。
- 成功响应直接返回同一个原始 `response.data`；Transport 的远端拒绝、未连接和结果不确定错误保持原类型。未注入文件上传扩展时返回带稳定 `not_supported` 代码的专属错误。
- 文件上传只接受当前机器可读的 Windows/POSIX 绝对普通文件路径；具体实现必须显式注入群文件或私聊文件 Action 工厂，当前不按实现名称猜测或探测能力。
- OneBot 分包 9 个测试文件、153 个测试通过，分包及全仓类型检查通过；空输出目录中的 TypeScript 构建发射通过。现有 `dist` 目录因 Windows `EPERM` 无法覆盖，未删除或改写该目录。
- 本批没有实现 Tool Handler、允许范围检查、审批、Server 注册或真实 OneBot/QQ smoke；这些仍属于 B07/B08。

### 停点

只证明 OneBot 专属操作合同和集成代码完成；未在 B07 建立 Handler、统一审批并注册进 Server 前，不声明 Agent 已经可以调用。

## 11. B07：Server Channel Runtime 与正式命名闭环

### 已完成基础

- Core 已提供结构化 Conversation Session 和进程内 Store，区分 Channel 消息、Agent Tool Call 与 Tool Result。
- Store 已实现固定 route/contentFormat、`runId + toolCallId` 配对、发送回执待回流关联、Bot 自身消息事件写入和 `channelId + messageId` 去重。
- 成功回执不构造公开消息；来源 Tool Call 缺失或同一消息 ID 出现冲突关联时明确报错。

### 剩余修改

#### 闭环一：当前会话 `reply`

- 注册平台无关的当前会话 `reply` Tool。它只向元数据显式标记为 `external_channel` 的 session 提供；Adapter 暂时断线时仍保持可见并在调用后返回错误。Agent 不传目标 route，Handler 从可信 session 元数据取得固定 route；跨会话发送继续使用受控平台 Tool。
- `reply` 接受完整有序 Parts 和可选 `replyToMessageId`。引用 ID 不在 Core/Server 检查 session 归属，原样交给 Adapter 和平台判断。一次 Agent run 可调用零次、一次或多次；每次调用最多执行一次 `Channel.send()`，不在 Handler 内自动重试，是否再次调用由 Agent 判断。
- `reply` 使用精简 JSON 结果：成功为 `{ status: "success", tool: "reply", messageId }`；明确失败为 `{ status: "error", tool: "reply", error }`；已发出但结果未知为 `{ status: "uncertain", tool: "reply", error }`；消息已发送但 session 关联失败时返回 `success`、`messageId` 和 `warning`。`error` 尽量保留 Adapter 原始错误，只移除凭证、调用栈和不安全对象展开。
- Agent Runtime 只增加 `reply` 注册、可信 run context 和结构化调用结果所需的最小接口，不读取完整 Session 历史。普通 `finalOutput`、推理过程和其他 Tool 执行过程不自动发送；没有调用 `reply` 的 turn 不产生 Channel 可见消息。
- 每次 `reply` 的 Tool Call/Tool Result 都写入来源 session。成功回执只登记待回流关联；平台自身消息事件才创建公开消息并按 `channelId + messageId` 去重。明确失败不登记；`delivery_uncertain` 或成功响应缺少有效 `messageId` 返回 `uncertain`，不猜测成功。

#### 闭环二：Server Channel Runtime

- 用 `channel-runtime.ts` 取代 `phase4-qq-runtime.ts`，按稳定 `channelId` 注册和查找 Adapter，接入已完成的 Conversation Session Store，并保留每个 session 的出站顺序。
- 把 Channel 配置接入唯一 `.huanlink/config/config.json`。群聊使用显式 `allowlist | denylist` 与唯一群号列表；私聊使用独立允许范围；Server 采用 Adapter 最终公布的能力。
- 群访问策略先于 Store；通过策略的普通消息、@Bot 消息和命令消息都进入整群共享 session。Channel 只保留 trigger，不用 trigger 决定是否转发或回复。
- Bot 自身消息进入目标 session 但不触发 Agent；当前会话 `reply` 与本地 Tool Call 关联，受控平台 Tool 的跨会话发送在来源/目标 session 保存关联元数据。
- 注册 `onebot_standard` 和 `onebot_privileged` 两个受控 Tool。前者检查目标允许范围，后者把审批交给统一策略；不向 Agent 暴露原始 OneBot Action 或凭证。
- 普通日志只记录脱敏摘要，不记录完整消息、Tool 参数、附件 URL 或资源级凭证。

#### 闭环三：正式切换与清理

- 将当前单个 `groupId` 迁移到正式群聊/私聊策略，使用规范 route 保存固定 session 元数据，不重复注入固定路由文本。
- 用 `process-lifecycle.ts` 取代 `phase4-process-lifecycle.ts`，迁移现有测试并保持进程关闭行为。
- 删除旧 `phase4-qq` 入口、旧 Conversation Store 及迁移期 Channel 合同；正式源码、导出、测试、fixture 和日志不再保留 `phase4` / `Phase4`。
- 完成 B07 自动化验证和文件级 review 后停下报告，不在本批增加数据库、重启恢复或可靠投递补偿。

### 明确后移到 Agent Runtime 模块

- 建立统一的 Conversation Session 抽象：普通内部 session 显式标记为 `internal`，外部群聊/私聊 session 标记为 `external_channel` 并保存固定 Channel route；当前 B07 Store 仍只代表外部 Channel session，不宣称已经保存普通 session 历史。
- 把完整 Conversation Session 转换成具体模型或 SDK 输入。
- 在后续 turn 向模型重放历史 Tool Call/Tool Result，并消除 Tool 参数与回流正文的重复展示。
- Token 计算、上下文窗口、裁剪与压缩。
- 后台任务终态读取最新历史并重新触发 MainAgent turn。

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
- `allowlist` 模式只向 session 转发已登记群；`denylist` 模式拒绝已登记群并向 session 转发其他群。
- 缺失策略、非法模式、非正整数字符串群号和重复群号均导致配置启动失败，不猜测默认值。
- 通过群策略的普通消息、@Bot 消息和命令消息全部进入 Conversation Store；trigger 元数据不改变 Channel 转发结果。
- 被群访问策略拒绝的消息不进入 Conversation Store，且不产生 Channel 出站回复。
- 群聊 session 整群共享，私聊 session 按私聊 ID 隔离。
- 固定 route 和 `contentFormat` 只保存在 session 元数据；每条消息保留发送者和完整 CQ 内容，超过 8 KiB 时保存占位记录。
- Channel Runtime 不根据 trigger 替 Agent 决定是否回复；对应 Agent 调用策略由上层测试。Agent普通最终文本不会自动发到 Channel，只有成功执行 `reply` Tool 才产生当前会话可见回复。
- Conversation Session Store 能保存成对的 Tool Call/Tool Result；`reply` 的 Tool Result 不复制正文。本批不验收这些历史是否已经在后续 turn 投影给模型。
- 当前会话 `reply` 只向显式 `external_channel` session 提供，route 不能由 Agent 覆盖；成功回执返回 `messageId` 但不创建公开消息，自身事件回流后才按 `channelId + messageId` 写入并关联 Tool Call，重复事件不会产生第二条上下文记录。
- `delivery_uncertain` 不产生猜测性成功记录；若后续真实自身事件到达，仍可按事件创建消息。
- 跨会话发送在来源 session 中保留 Tool Call/Tool Result，在目标 session 中保留完整公开消息及内部 `cross_session` 元数据；两个 session 不互相复制不属于本会话的公开时间线。
- 当前 Agent turn 显式调用 `reply` 后能回到当前 session 的固定路由；跨群/私聊操作只能通过受控平台 Tool 到达已允许目标。后台任务重新组装上下文不在本批验收。
- `apps/server/src` 和相应测试中不存在活动的 `phase4` / `Phase4` 命名。
- 旧 `phase4-qq` 文件和导出不保留兼容别名，避免形成两套入口。

### 停点

完成自动化验证和 review 后报告“已接入运行”的真实状态；尚未执行真实环境 smoke 时必须明确说明。

## 12. B08：整体回归与真实验证

按以下顺序验证：

1. Core Channel Contract 单元测试。
2. OneBot CQ 字符串/消息段数组 Codec、Transport、Adapter 单元测试。
3. OneBot 撤回、主要消息能力、专属操作和受控 Tool 测试。
4. 当前会话 `reply` Tool、Tool Call/Tool Result 记录、发送回执/自身事件关联和跨会话来源元数据测试。
5. 入站 8 KiB 上限、超限 session 占位、群访问转发和日志脱敏测试。
6. Server Channel Runtime、会话路由、出站顺序和进程关闭测试。
7. package 级测试、全仓 typecheck 和 build。
8. 在用户确认并具备 OneBot 环境时执行真实 QQ smoke。

真实 smoke 至少覆盖：

- QQ 群明确命令或 @ -> MainAgent -> A2A -> Codex -> MainAgent 调用 `reply` -> 原群回复；普通最终文本和执行过程不会自动发群；
- 允许群的普通消息、@Bot 消息和命令消息都进入同一个群 session，Channel 不根据 trigger 丢弃消息；
- HuanLink 主动向已允许群发送文本；
- 同一会话 `reply` 的 Tool Call/Tool Result 被结构化记录，自身消息回流只形成一条公开消息；跨会话发送在目标 session 中形成一条完整公开消息和内部来源元数据；
- HuanLink 从本机绝对路径向允许会话发送一个媒体或文件附件；
- 私聊收发、引用回复和发送后撤回；
- OneBot CQ 字符串和消息段数组都形成规范 CQ 入站内容；至少一条带 URL、资源级 `key` 或扩展字段的附件消息完整进入 session，过程中不下载或缓存附件；
- 超过 8 KiB 的内容只形成 session 占位记录，Channel 不主动向原会话发送提示；
- 至少一个只读 OneBot 查询操作和一个经确认的群管理操作；
- 断开连接后重连并恢复收发；
- 日志不泄漏 Access Token、完整 CQ、附件 URL 或资源级 `key`。

若私聊或真实附件环境不可用，只报告对应自动化结果，不把它们写成真实 smoke 已验证。

## 13. 提交和模块门

- D10 与 D11 作为文档提交，和代码提交分开。
- B01～B07 每批只修改该批职责，完成测试和 review 后先报告。
- 未经用户确认，不提交或推送下一批结果，不 merge 到 `main`。
- 每次报告分别列出：合同已实现、代码已完成、已接入运行、真实 smoke 已验证。
- B08 完成并由用户确认后，才把 Channel 模块标记完成；之后仍不自动进入下一个模块。
