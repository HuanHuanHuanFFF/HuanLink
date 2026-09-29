# HuanLink 本地配置

这里是 HuanLink 的唯一配置树。Server 与 Codex Adapter 正式入口均固定读取 `.huanlink/config/config.json`，只加载各自进程显式引用的文件；修改后除 Channel 名单外均需重启对应进程。

## 修改规则

- `config.json` 是最终唯一入口，不要新增第二个配置根或备用配置树。
- 引用必须以 `./` 开头、使用 `/`、以 `.json` 结尾，并位于对应进程的目录内：Server 使用 `./server/**`，Codex Adapter 使用 `./adapters/codex/**`。
- 每个路径段都必须非空，不能使用 `.`、`..` 或反斜杠；数组中的重复引用会直接报错。
- 加载器不扫描目录、不按文件名猜配置、不递归 include，也不合并多套配置。未写入 `config.json` 的 JSON 不生效。
- 配置树是本地单用户的可信单写者输入。加载器会拒绝读取时已经存在的符号链接和目录 junction，但该检查不是抵御另一个本机进程并发替换路径的原子安全沙箱。
- JSON 中不得保存 API Key、Token 等秘密。`apiKeyEnv`、`accessTokenEnv` 只写环境变量名；真实秘密放在仓库根目录被 Git 忽略的 `.env` 或进程环境中。
- Codex 项目的 `workspace` 可以是相对于“包含 `.huanlink` 的 HuanLink 项目根”的规范路径，也可以是本机绝对路径，均使用 `/`，不含 `..`。启动时解析真实路径并检查它是 Git 根目录、当前分支与配置一致；派单和完成时再次检查。工作目录不是权限沙箱。

## 增加配置

增加 Channel、外部 Agent 或 Codex 项目时，需要同时完成两步：

1. 在对应职责目录新增一个独立 JSON，例如 `server/channels/qq-secondary.json` 或 `adapters/codex/projects/another-project.json`。
2. 把该文件的规范相对路径加入 `config.json` 对应数组；数组顺序就是加载顺序。

只新增文件而不修改入口不会改变运行配置；入口引用不存在或内容无效的文件会在加载时明确报错。

## 当前阶段边界

Server 正式入口已经只从本配置树装配 Channel；旧的单群号、命令前缀和 OneBot 地址环境变量入口不再生效。环境变量只承载 JSON 明确引用的秘密值。

仓库默认 Server 配置还显式引用 `./server/orchestration.json`。B01 的总 Runtime 静态加载器要求 `mainAgent`、`orchestration` 和 `defaultAgentId` 全部存在；默认 Agent 必须已启用且使用 A2A。它校验 MainAgent 的 `apiKeyEnv` 名称以及目标 Agent 的 `origin`、`skillId`，但不读取任何环境变量中的秘密。`a2aTaskPolicy.maxActiveTasksPerSession` 与 `asyncToolTaskPolicy.maxActiveTasksPerSession` 都必须是正安全整数：前者限制同一 Session 的 A2A 异步与 blocking 调用总数，默认值为 `2`；后者独立限制普通非 A2A 异步 Tool Task，默认值为 `3`。异步 A2A Task 只占用 A2A 配额，不会重复占用普通异步 Tool 配额。

Server 正式入口已接入总 Runtime 与 SQLite；启动时解析实际需要的 MainAgent/Channel 凭证，并在接收消息前完成 A2A 预检。缺少必需密钥会阻止启动。

Codex Adapter 正式入口已使用 `adapters.codex.runtime` 和 `adapters.codex.projects`。旧的 `HUANLINK_CODEX_*` 执行配置环境变量不再生效；`HUANLINK_LOG_LEVEL` 仅控制 Adapter 日志级别，不选择项目、模型或强度。Codex 自身登录凭据仍由官方进程管理，不放入这些 JSON。

当前只把名单变化热重载到正在运行的 Channel：每次保存仍会完整校验 Server 配置树；除 `groups`、`directs` 的 `mode` 与 `ids` 外，任何配置变化都要求重启，`orchestration` 的内容或其入口引用变化同样如此，并且不会与新名单部分混用。无效 JSON、缺失字段或非法 ID 会保留上一份有效名单并记录脱敏告警。文件监听属于本机文件系统上的最佳努力便利能力，确定性校验仍以进程启动为准。

正式入口已接入 Session 写入、MainAgent、异步任务和结果回流；只有非自身 mention/command 启动 fresh turn，普通消息保存但不唤醒。消息聚合队列、门禁 Agent、多 Agent 动态路由与自动任务恢复仍未实现。

## Codex 项目与每次派单参数

`adapters/codex/projects/<name>.json` 示例：

```json
{
  "version": 1,
  "projectId": "demo",
  "workspace": "D:/CodingProject/Demo",
  "branch": "main",
  "defaultModelId": "gpt-5.4-mini",
  "defaultReasoningEffort": "high"
}
```

文件名不是派单 ID，`projectId` 才是；它与 Server 的 `agentId` 不同，一个 Codex Agent 可以登记多个项目。必须将项目文件加入 `config.json.adapters.codex.projects`。仓库现有 `huanlink` 项目指向本仓库与 `dev/v1.0-runtime-integration` 分支；需要其他执行目标时，先登记受控目录和实际分支，不让模型传任意路径。Adapter 不自动切分支、创建 worktree、提交或推送，也不清理已有修改。

MainAgent 的 `submit_codex_agent_call` 参数示例：

```json
{
  "task": "只修改约定文件并运行相关测试",
  "projectId": "demo",
  "modelId": "gpt-5.4-mini",
  "reasoningEffort": "high",
  "executionMode": "async"
}
```

`projectId` 必填；`modelId` 与 `reasoningEffort` 可省略，各自采用项目默认值，不继承上一次派单的覆盖。Adapter 启动时读取 Codex `model/list`，检查项目默认值；新派单的覆盖也必须存在于该能力列表。未知项目、未知模型或不支持的强度在受理前拒绝，不静默改成其他模型/强度。没有可用能力列表时启动失败；本批不支持列表外自定义模型或运行中刷新。

原生 A2A 调用需要一个任务文本 Part 加一个 Data Part：

```json
{
  "type": "huanlink.codex-task.v1",
  "projectId": "demo",
  "modelId": "gpt-5.4-mini",
  "reasoningEffort": "high"
}
```

Data Part 的 `type/projectId` 必填，覆盖字段可省略。Core 只传递协议无关的结构化输入，Codex 语义由 Adapter 校验；这不是所有 A2A Agent 都支持的通用参数标准。受理前校验错误使用明确的 `HUANLINK_PREACCEPT_REJECTED:` 标记；网络中断和未标记的 SDK 错误继续保留派发未知，不据此自动重试。

同一真实工作区跨项目别名、跨 Session 共用一个进程内占位，忙时在 A2A 受理前以带 `HUANLINK_PREACCEPT_REJECTED:` 标记的 RPC 错误拒绝，Core 返回 `task-preaccept-rejected`；不会先返回 accepted，也不是新 Task 的 `TASK_STATE_REJECTED`。不同工作区可以并行。暂停等待输入仍占位，续接只能回答原任务的问题，不能更换项目或执行参数。

创建 thread 后、发送 `turn/start` 前再次复验工作区与分支；暂停续接时在入站与回答 Codex 前分别复验。分支不符时不给 Codex 答案，保持原任务暂停与占位，恢复预期分支后可继续同一任务/turn。完成时也会复验。这些是执行检查点，不是阻止其他本机进程更改 Git 状态的原子锁。

`turn/start` 的响应丢失或超时不能证明远端没有启动。此时 Adapter 停止接受新任务并关闭共享 Codex 执行端；已有任务会失败，需要人工核对已发生的修改后再决定是否重试。若关闭失败，状态说明明确标为停止未确认，仍拒绝新任务，不能假定旧进程已退出。不同项目当前共用一个 app-server 进程，这类故障可能同时中止其他项目的活动任务；本批不承诺进程级故障隔离。

Codex thread 按项目、A2A context、工作区和分支隔离；映射不支持跨进程恢复，工作区占位也不是跨进程文件锁。不要让多个 Adapter 或其他写入进程同时修改同一个目录。

迁移时注意：旧 `HUANLINK_CODEX_WORKSPACE` 不再生效。仓库示例的 `workspace: "."` 指向 HuanLink 本仓库，并非历史 B06 smoke 目录；真实运行前应检查并登记自己准备使用的执行目录和分支。本次自动化验收只使用临时项目与受控进程，没有替用户启动真实编码任务。

`runtime.json.expectedCodexVersion` 仍精确校验官方进程版本；仓库示例为已核对协议类型的 `0.145.0`，模型是否可用仍以本机账户能力列表为准。修改项目、模型默认值、运行端口或版本后，重启 Adapter 生效。

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
