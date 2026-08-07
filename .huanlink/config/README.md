# HuanLink 本地配置

这里是 HuanLink v1.0 唯一的配置树。代码只固定读取 `.huanlink/config/config.json`；其他 JSON 只有被该入口显式引用时才会生效。

## 修改规则

- `config.json` 是唯一入口，不要新增第二个配置根、备用入口或环境变量入口。
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

配置合同已经建立并验证，但两个 loader 尚未接入各自 `main.ts`。当前启动流程仍保留旧环境变量装配；正式入口切换和名单文件监听安排在 B07 闭环三，不要提前删除旧启动参数，也不要把当前状态理解为已经支持文件热重载。

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
- Runtime 已提供完整校验后原子替换名单的接口；闭环三接入正式入口和文件监听后，合法保存会整体替换，非法保存会保留上一份有效名单。现阶段 JSON loader 尚未接入当前旧入口，修改本文件不会改变正在运行的旧 QQ 链路。

## OneBot 特权操作

- `enableUnsafePrivilegedOperations` 必须显式填写，仓库默认值为 `false`。此时不会向 Agent 提供 `onebot_privileged`。
- 改为 `true` 只用于明确的真实测试：禁言、踢人、撤回、群管理和请求处理会直接执行，当前没有审批恢复、名单或消息归属保护；创建 Tool 时会记录风险警告。
- 真实测试前确认所连账号、群聊和操作目标。统一审批链完成前不要把该开关作为日常默认值。
