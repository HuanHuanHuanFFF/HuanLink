# HuanLink 本地配置

这里是 HuanLink v1.0 唯一的配置树。代码只固定读取 `.huanlink/config/config.json`；其他 JSON 只有被该入口显式引用时才会生效。

## 修改规则

- `config.json` 是唯一入口，不要新增第二个配置根、备用入口或环境变量入口。
- 引用必须以 `./` 开头、使用 `/`、以 `.json` 结尾，并位于对应进程的目录内：Server 使用 `./server/**`，Codex Adapter 使用 `./adapters/codex/**`。
- 每个路径段都必须非空，不能使用 `.`、`..` 或反斜杠；数组中的重复引用会直接报错。
- 加载器不扫描目录、不按文件名猜配置、不递归 include，也不合并多套配置。未写入 `config.json` 的 JSON 不生效。
- 配置树是本地单用户、启动时读取的可信单写者输入。加载器会拒绝读取时已经存在的符号链接和目录 junction，但该检查不是抵御另一个本机进程并发替换路径的原子安全沙箱；修改配置时不要同时启动或重载 HuanLink。
- JSON 中不得保存 API Key、Token 等秘密。`apiKeyEnv`、`accessTokenEnv` 只写环境变量名；真实秘密放在仓库根目录被 Git 忽略的 `.env` 或进程环境中。
- Codex 项目的 `workspace` 使用预期相对于“包含 `.huanlink` 的 HuanLink 项目根”的路径。当前仓库写 `.`；B02R 只保存该相对表示，B03 再负责解析、存在性、Git 仓库和分支校验。

## 增加配置

增加 Channel、外部 Agent 或 Codex 项目时，需要同时完成两步：

1. 在对应职责目录新增一个独立 JSON，例如 `server/channels/qq-secondary.json` 或 `adapters/codex/projects/another-project.json`。
2. 把该文件的规范相对路径加入 `config.json` 对应数组；数组顺序就是加载顺序。

只新增文件而不修改入口不会改变运行配置；入口引用不存在或内容无效的文件会在加载时明确报错。

## 当前阶段边界

M1-B02R 只建立并验证配置合同，两个 loader 尚未接入各自 `main.ts`。当前启动流程仍保留旧环境变量装配；运行入口切换属于 M1-B04，不要在本批次提前接入或删除旧启动参数。
