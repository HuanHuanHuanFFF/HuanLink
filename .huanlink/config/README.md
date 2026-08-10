# HuanLink 本地配置

这里是 HuanLink v1.0 的目标唯一配置树。Server 正式入口只固定读取 `.huanlink/config/config.json`；其他 Server JSON 只有被该入口显式引用时才会生效。Codex A2A Adapter 进程仍有一项尚未完成的迁移边界，见“当前阶段边界”。

## 修改规则

- `config.json` 是最终唯一入口，不要新增第二个配置根或备用配置树。
- 引用必须以 `./` 开头、使用 `/`、以 `.json` 结尾，并位于对应进程的目录内：Server 使用 `./server/**`，Codex Adapter 使用 `./adapters/codex/**`。
- 每个路径段都必须非空，不能使用 `.`、`..` 或反斜杠；数组中的重复引用会直接报错。
- 加载器不扫描目录、不按文件名猜配置、不递归 include，也不合并多套配置。未写入 `config.json` 的 JSON 不生效。
- 配置树是本地单用户的可信单写者输入。加载器会拒绝读取时已经存在的符号链接和目录 junction，但该检查不是抵御另一个本机进程并发替换路径的原子安全沙箱。
- JSON 中不得保存 API Key、Token 等秘密。`apiKeyEnv`、`accessTokenEnv` 只写环境变量名；真实秘密放在仓库根目录被 Git 忽略的 `.env` 或进程环境中。
- Codex 项目的 `workspace` 使用预期相对于“包含 `.huanlink` 的 HuanLink 项目根”的路径。当前仓库写 `.`；B02R 只保存该相对表示，B03 再负责解析、存在性、Git 仓库和分支校验。

## 增加配置

增加 Channel、外部 Agent 或 Codex 项目时，需要同时完成两步：

1. 在对应职责目录新增一个独立 JSON，例如 `server/channels/qq-secondary.json` 或 `adapters/codex/projects/another-project.json`。
2. 把该文件的规范相对路径加入 `config.json` 对应数组；数组顺序就是加载顺序。

只新增文件而不修改入口不会改变运行配置；入口引用不存在或内容无效的文件会在加载时明确报错。

## 当前阶段边界

Server 正式入口已经只从本配置树装配 Channel；旧的单群号、命令前缀和 OneBot 地址环境变量入口不再生效。环境变量只承载 JSON 明确引用的秘密值。

仓库默认 Server 配置还显式引用 `./server/orchestration.json`。B01 的总 Runtime 静态加载器要求 `mainAgent`、`orchestration` 和 `defaultAgentId` 全部存在；默认 Agent 必须已启用且使用 A2A。它校验 MainAgent 的 `apiKeyEnv` 名称以及目标 Agent 的 `origin`、`skillId`，但不读取任何环境变量中的秘密；`agentCallPolicy.maxActiveTasksPerSession` 必须是正安全整数，仓库默认值为 `2`。

当前 Channel-only 入口仍只解析实际建连所需的 Channel Token；它在 B05 前可以不声明 `orchestration`。即使声明了 MainAgent，也只校验 `apiKeyEnv` 名称而不读取对应 API Key。MainAgent 凭证会在 Agent Runtime 正式接线时再解析，因此缺少模型密钥不会阻塞纯 Channel 启动。

Codex A2A Adapter 的配置加载器已经能读取 `./adapters/codex/**`，但该进程的 `main.ts` 尚未切换到加载器，当前仍使用 `HUANLINK_CODEX_*`、`HUANLINK_LOG_LEVEL` 等遗留环境变量和内置默认值。因而，现阶段修改 `adapters/codex` JSON 不会改变正在运行的 Codex Adapter；该迁移后移到 Codex Adapter 自身批次，不属于本次 Server Channel 闭环。这里记录的是已知过渡状态，不代表允许长期保留第二套正式配置来源。

当前只把名单变化热重载到正在运行的 Channel：每次保存仍会完整校验 Server 配置树；除 `groups`、`directs` 的 `mode` 与 `ids` 外，任何配置变化都要求重启，`orchestration` 的内容或其入口引用变化同样如此，并且不会与新名单部分混用。无效 JSON、缺失字段或非法 ID 会保留上一份有效名单并记录脱敏告警。文件监听属于本机文件系统上的最佳努力便利能力，确定性校验仍以进程启动为准。

正式入口目前只把名单允许的事件按 route 顺序交给统一下游出口，保留 `sender.isSelf` 和 `trigger`。消息缓冲队列、Session 写入、Agent 触发和多个外部 Agent 路由尚未接入；因此不能把“Server 已连接 Channel”理解为 QQ -> Agent 全链路已经可用。

## Channel 接收名单

每个 OneBot Channel 都必须显式声明群聊和私聊的独立黑白名单：

```json
{
  "inboundPolicy": {
    "groups": {
      "mode": "allowlist",
      "ids": ["20002000"]
    },
    "directs": {
      "mode": "denylist",
      "ids": []
    }
  },
  "enableUnsafePrivilegedOperations": false
}
```

- `groups` 和 `directs` 都必须配置，模式可以分别按需切换。
- `mode: "allowlist"`：只转发 `ids` 中群聊或私聊的后续事件；空列表表示全部拒绝。
- `mode: "denylist"`：拒绝 `ids` 中的群聊或私聊，转发其他事件；空列表表示全部允许。
- 群号或私聊 ID 使用正整数安全字符串，并且同一策略中的 `ids` 不能重复。缺少策略、模式非法或 ID 非法时启动失败，不使用隐式默认值。
- 同一份名单也限制当前会话 `reply` 和 `onebot_standard` 的明确群聊/私聊目标，调用时读取最新已生效名单。这样不会出现普通 Tool 能向一个完全不接收回流事件的会话发送消息。
- 通过名单的普通消息、@ Bot 消息、斜杠命令和 Bot 自身消息都由 Channel Runtime 原样转发；`trigger` 和 `sender.isSelf` 只是下游判断依据。Runtime 不决定是否写 Session、去重或启动 Agent。
- Runtime 会先校验所有配置 Channel 的候选名单，再一次性整体替换；任一名单非法时不会让其他 Channel 先应用一半。已有处理不会被取消，保存成功后的后续事件使用新名单。

## OneBot 特权操作

- `enableUnsafePrivilegedOperations` 必须显式填写，仓库默认值为 `false`，并且变化后必须重启。
- `onebot_privileged` 合同仍是无审批测试能力：以后正式注入 Agent Runtime 后，改为 `true` 会允许禁言、踢人、撤回、群管理和请求处理直接执行。当前消息队列、Session 和 Agent Tool 组合尚未接入，因此本开关不会单独使 Tool 出现在正在运行的 Agent 中。
- 真实测试前确认所连账号、群聊和操作目标。统一审批链完成前不要把该开关作为日常默认值。
