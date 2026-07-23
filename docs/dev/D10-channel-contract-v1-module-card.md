# HuanLink v1.0 Channel Contract v1 模块卡片

> **状态：设计边界已确认，并已进入 D11 分批实施。** 本文冻结模块职责和验收边界，不授权提交或推送。

## 1. 目标

建立成熟、平台无关的 Channel 合同，并把 OneBot 11 作为 HuanLink 官方内置、一等支持的首个 Adapter。后续新增 Telegram、Discord、Slack 等平台时，不修改 MainAgent、AgentCall 或 Server 的业务编排语义。

核心原则：**原生支持 OneBot，不等于让 Core 使用 OneBot 数据结构。**

## 2. 当前问题

- `ChannelAdapter` 已有 `start / close / onMessage / sendText` 最小接口，但 `InboundChannelMessage.channel` 被写死为 `"onebot11"`。
- 正式配置已有稳定 `channelId`，当前运行时却仍使用平台名和 `conversationId` 组装会话，多个同平台实例可能冲突。
- 当前合同只有纯文本收发，没有私聊/群聊/thread、引用回复、附件、能力声明、发送回执和标准错误语义。
- `ForwardWebSocketOneBot11Channel` 同时承担连接、协议解析、动作关联和 Channel 映射，后续扩展运输方式或消息能力时容易继续膨胀。

## 3. 职责边界

| 层 | 拥有的职责 | 明确不拥有 |
|---|---|---|
| Core Channel Contract | 平台无关的消息、路由、身份、能力、回执和错误合同 | OneBot/Telegram SDK 类型、网络连接、鉴权 |
| AttachmentStore | 把平台已落地的本地附件导入 HuanLink 受管缓存，并按不透明 ID 解析、限额和清理 | 平台事件解析、消息发送、Agent 决策 |
| Server Channel Runtime | 配置实例注册、启动/关闭、入站交付、会话路由、出站顺序、健康状态 | 平台协议解析、AgentCall 生命周期 |
| Channel Adapter | 平台连接、鉴权、ID 转换、事件规范化、消息渲染、心跳/重连、平台限流 | MainAgent 决策、HuanLink 会话和任务生命周期 |
| MainAgent / AgentCall | 理解请求、外层编排、异步任务状态和结果回流 | 平台原始事件、OneBot API、Channel 重试细节 |

## 4. Channel Contract v1

### 4.1 稳定实例与路由

- `channelId`：配置中的稳定实例 ID，例如 `qq-main`；同一进程内唯一。
- `platform`：协议/平台类型，例如 `onebot11`；不得作为实例 ID。
- `accountId`：Adapter 实际连接的 Bot 或应用账号。
- `conversationKind`：`direct | group | channel`。
- `conversationId`：平台本地会话 ID。
- `threadId`：平台支持 thread 时提供；不支持时省略。

规范会话键由 `channelId + conversationKind + conversationId + threadId?` 组成。它只负责回到原消息来源，不等同于 HuanLink 工作上下文、用户授权、AgentCall ID 或 A2A Task ID。

HuanLink session 按规范会话键隔离：群聊使用群 ID，同一群内所有发送者共享 session；私聊使用平台私聊会话 ID。发送者 ID 只作为消息身份保留，不参与 session 键。平台支持 thread 时，`threadId` 进一步隔离该群或频道中的子会话。

### 4.2 入站消息

统一入站消息至少包含：

- `messageId`、规范会话路由、发送者平台身份、`receivedAt`；
- 有序 `parts`；首批固定为文本、提及和附件引用；
- `replyToMessageId`（平台存在引用关系时）；
- 平台规范化后的触发事实，例如“提及当前 Bot”。

平台原始事件和 SDK 对象不得进入 Core 合同。跨平台用户映射另行设计，平台发送者身份本身不构成权限或授权。

发送者身份包含必填的稳定平台 `id`、必填的基础 `username` 和可选的会话内 `displayName`。Adapter 在平台未提供可用基础名称时以 `id` 作为 `username` 回退，不能因此丢弃消息。OneBot 中 `user_id` 映射为 `id`，`sender.nickname` 映射为 `username`，非空 `sender.card` 映射为群聊中的 `displayName`；未设置群名片时不重复填充 `displayName`。

附件统一表示为 `attachmentRef`，包含 `source`、`kind`（`image | audio | video | file`）及可选的 `name`、`mimeType`、`sizeBytes`。`source` 只有两种：

- `remoteUrl`：只接受 HTTP(S) URL；
- `localCache`：只包含由 HuanLink `AttachmentStore` 签发的不透明 `attachmentId`。

允许 Adapter 接收平台提供的本地路径作为导入来源。平台已经下载到本机的附件必须先由 Adapter 交给 `AttachmentStore` 导入受管缓存，再把 `attachmentId` 交给 Core；原始本地路径、`file://`、Base64、原始字节、平台缓存文件名和 SDK 文件对象不会作为消息字段进入 Channel Contract。Agent 或本机 Tool 需要读取时只能通过受控 resolver 解析，不能根据消息字段直接访问任意路径。

`AttachmentStore` 是唯一拥有附件缓存文件读写的模块；Channel Contract 和 Server 不隐式下载或解析内容。远程链接的可访问性、有效期和权限由来源负责。v1 不做代理、转码或自动上传。

### 4.3 出站命令与回执

统一出站命令至少包含目标路由、有序 `parts` 和可选 `replyToMessageId`。发送成功返回 `DeliveryReceipt`，至少记录 `channelId` 和平台消息 ID。

Adapter 只把 `remoteUrl` 映射为平台原生的链接发送参数。v1 不把 `localCache` 自动上传到平台；若目标平台不能直接接受远程链接，或发送必须先上传本地内容，则返回 `not_supported`，不得在内部隐式补做文件传输。

发送失败使用稳定错误类型，区分：`not_supported`、`rate_limited`、`temporarily_unavailable`、`authentication_failed`、`invalid_target` 和 `permanent_failure`。不得把不支持的能力静默降级为成功。

### 4.4 能力声明

每个 Channel 实例显式声明实际能力，至少覆盖：

- 私聊、群聊、thread；
- 文本、提及、入站/出站附件；
- 引用回复、编辑、撤回、reaction；
- typing、流式消息。

Server 只能使用已声明能力；平台差异由 Adapter 处理，Core 不假设所有平台功能一致。

能力声明不是要求用户在配置中维护的功能开关。每个 Adapter 根据自身已实现能力、当前协议和账号条件生成实际 `capabilities`；配置只能进一步关闭或限制能力，不能把 Adapter 未实现或当前不可用的能力强制打开。Server 只依赖 Adapter 最终公布的能力，不自行推测平台支持情况。

Contract 保留编辑、撤回、reaction、typing 和流式消息的能力位，便于后续平台实现时使用同一组稳定语义。保留能力位不代表 v1.0 已实现；只有具备对应命令、事件映射和测试的 Adapter 才能声明为支持。

### 4.5 最小 Adapter 接口

```text
descriptor: channelId + platform + accountId + capabilities
start(onInbound): 启动并把规范消息交给 Server
send(command): 发送并返回 DeliveryReceipt
close(): 停止接收、释放连接和等待中的发送
```

Adapter 负责底层心跳、断线重连和协议响应关联；Server 负责会话级出站顺序。更复杂的持久化去重和跨进程投递不属于 v1。

## 5. OneBot 11 原生支持

OneBot 11 是内置 Adapter，无需动态安装插件。内部职责按以下方向分离：

```text
OneBot11Codec
  事件、API、消息段、echo 响应和协议错误

OneBot11Transport
  当前正向 WebSocket；后续可增加反向 WebSocket 或 HTTP

OneBot11ChannelAdapter
  OneBot 事件与 Channel Contract 的双向映射、能力声明
```

第一阶段必须保留现有正向 WebSocket、鉴权、重连、群消息、命令/@触发、纯文本回复和安全日志行为。OneBot 入站图片、语音、视频或文件按以下顺序规范化：事件直接提供 HTTP(S) URL 时生成 `remoteUrl`；事件提供可读本地路径时先导入 `AttachmentStore` 再生成 `localCache`；只有平台文件 ID 时，Adapter 可调用 OneBot 获取文件能力令其落地后再导入。无法得到远程链接或可安全导入文件时明确记为不支持。Base64 不进入统一合同。

出站只把 `remoteUrl` 交给 OneBot 的网络 URL 发送参数，不由 HuanLink 下载；`localCache` 出站在 v1 返回 `not_supported`。私聊、引用回复、附件消息段及其他 OneBot API 必须逐项声明、测试和验收，不能以“支持 OneBot”笼统代表完整协议覆盖。

## 6. 多平台接入规则

- 每个平台位于独立 integration 包；平台 SDK 和原始类型不得泄漏到 Core 或 MainAgent。
- v1 使用配置显式装配和内置 Adapter registry，不建设动态插件下载、自动发现或插件市场。
- 新增平台必须通过同一组 Channel Contract 测试，并提供自己的能力矩阵和平台映射测试。
- 第二个真实 Channel 暂定 Telegram，用于后续验证抽象，但不属于 v1.0 范围或验收条件。v1.0 不实现 Telegram，也不为尚未接入的平台增加额外通用层。
- Channel 会话只解决消息来源与回传；跨 Channel 用户身份、权限和 Agent 工作流是独立模块。

## 7. 验收条件

- 两个相同平台、相同本地 `conversationId` 的不同 `channelId` 不会共享会话或回错实例。
- Fake Adapter 可仅依赖 Core Channel Contract 完成入站和出站测试，不引用 OneBot 类型。
- OneBot 原始事件、消息段和 API 类型只存在于 OneBot integration 内。
- `remoteUrl` 在 Core 和 Server 中不会触发网络读取或文件读写，并原样到达目标 Adapter 映射点。
- 平台本地附件只会被导入 HuanLink 受管缓存；统一合同只出现 `attachmentId`，不会泄漏任意路径。
- `AttachmentStore` 拒绝越界路径、符号链接逃逸、超限或非普通文件，并具有明确的容量和过期清理策略。
- Base64、原始字节和未导入的平台缓存文件名不会进入统一合同；需要 HuanLink 主动下载或上传的平台返回 `not_supported`。
- 不支持的发送能力返回稳定 `not_supported`，不会静默丢失内容。
- 当前 QQ 文本主链自动化回归通过；接入运行后再执行真实 OneBot smoke。
- 自动化测试、运行接入和真实 smoke 的状态分别报告，互不替代。

## 8. 实施前决策门

已确认：

- Channel Contract v1 首批 `parts` 只包含文本、提及和附件引用。
- Adapter 允许接收平台本地路径并导入固定的受管缓存；Channel Contract 最终只携带 HTTP(S) `remoteUrl` 或 `localCache.attachmentId`，不携带导入前的原始路径。
- `AttachmentStore` 负责导入、解析、限额和过期清理；v1 不做代理、转码或自动上传，出站仍只支持远程链接。
- Channel 能力由 Adapter 根据真实实现和运行条件声明；配置只允许收窄能力，不允许开启 Adapter 未实现的能力。
- OneBot 首批只支持现有正向 WebSocket Transport：由 HuanLink 主动建立一条长连接，在同一连接内双向接收事件、发送 API Action 并按 `echo` 接收响应。反向 WebSocket 和 HTTP Transport 后续分别设计、实现和验收。
- HuanLink session 按 Channel 会话隔离：群聊按群 ID 整群共享，私聊按私聊会话 ID 隔离；发送者 ID 不参与 session 键。
- 第二个真实 Channel 暂定 Telegram，但明确排除在 v1.0 范围和验收条件之外。

本模块卡片的产品决策已全部确认；实施顺序、批次停点和当前状态以 D11 为准。

## 9. 参考

- [OneBot 11 标准](https://11.onebot.dev/)
- [OpenClaw Channels](https://docs.openclaw.ai/channels)
- [Vercel Chat Adapter](https://github.com/vercel/chat/blob/25f30998ce7379ef301238c8e0d46e2e07ed505f/packages/chat/src/types.ts#L220)
- [LangBot 平台 Adapter](https://docs.langbot.app/en/workshop/impl-platform-adapter)
- [AstrBot UMO](https://docs.astrbot.app/en/use/command.html)
