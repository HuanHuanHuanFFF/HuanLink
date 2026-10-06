# D16 Agent SDK 升级计划与验收

更新日期：2026-10-06。分支：`codex/chore-agent-sdks`。基线：`b20400f`。状态：B01 至 B03 已完成验收，用户已授权将本轮成果推送到本分支远端。

## 范围与授权

用户已授权在本分支升级 A2A 和 OpenAI Agents SDK。本计划承接 D15 的独立 SDK 升级建议；实验代码仍留在原实验工作区，本轮不移植。

| 依赖                        | 原锁定版本     | 本轮目标                             |
| --------------------------- | -------------- | ------------------------------------ |
| `@a2a-js/sdk`               | `1.0.0-beta.0` | `1.3.0`，Client 与 Adapter 同步      |
| `@openai/agents`            | `0.12.0`       | `0.19.0`，Integration 与 Server 同步 |
| `@openai/agents-extensions` | `0.12.0`       | `0.19.0`，与 Agents 同步             |

目标来自本日公开 npm 稳定版本元数据。D15 的 Agents `0.18.0` 是先前候选，本轮更新为 `0.19.0`；保留现有 AI SDK、DeepSeek provider 和 Zod 版本，仅处理必要的兼容变更。

Core 合同保持框架无关，SDK 类型和适配留在对应 Integration/Adapter。此前确认的 AGENTS.md 模型规则单独提交；OneBot 本地配置及其他未跟踪文件保留，不将它们纳入 SDK 改动。用户已授权推送本分支，本轮按模型规则、SDK 代码和验收记录分别提交后推送；PR 和合并分别等待用户授权。

## B01 A2A 升级

- 两处依赖同步到 `1.3.0`，更新锁文件；以现有真实 HTTP、受控 Codex 进程测试验证 Task/Context、输入续接、取消、Artifact、终态、流式断线对账及 JSON-RPC 错误。
- 运行受影响包测试和类型检查，必要时修正升级接缝。保留现有生命周期语义。
- 若升级导致请求构造、终态/取消或现有 D14 路径失败，先定位 SDK/适配层，不混入实验算法或授权状态迁移。

## B02 OpenAI Agents 与扩展升级

- Agents 两处依赖及 Server 扩展同步到 `0.19.0`，更新锁文件。
- 用真实 Runner、AI SDK 桥接和可控提供方验证文本、工具 schema/strict、结构化输出和取消/超时。只有原生 strict 透传与现有行为一致时才移除兼容 middleware。
- 运行 Integration/Server 测试和类型检查。有可用 DeepSeek 配置时运行现有真实模型烟测；它的 AgentCall 执行端是替身，不代表真实 Codex/QQ 闭环。

## B03 组合验收与停点

- 以根 package.json 为命令来源，运行整仓 build、typecheck、test；检查受影响文件格式、锁文件可重现性和最终差异。
- 记录升级前后版本、测试分母、跳过原因、兼容修改及未验证项；旧版已有的 stderr 不作为新增故障。
- 本轮在已授权的本分支提交、推送后交付新鲜证据，停止于 PR/合并之前。D15 的 AUTH_REQUIRED 实验迁移、扩展合同、上下文策略、数据库 TaskStore 及真实 QQ/Codex 编码烟测仍为后续独立批次。

## 本轮记录

- 升级前整仓测试：912 passed / 2 conditional skipped，66 个测试文件，退出码 0。
- B01：A2A Client/Adapter 类型检查通过；Client、Adapter、Server 的 418 个测试通过、2 个条件跳过。新版错误类从 client/server 入口迁至公共 `@a2a-js/sdk/errors`，已修正生产代码和测试替身导入；保留 preaccept marker 和未知受理结果处理。
- B02：Agents/扩展均锁定到 `0.19.0`。保留新版 SDK 的工具错误脱敏和组合取消信号；回归改为检查业务边界及取消传播。SDK 已原生透传 strict，移除强制 strict middleware，并验证默认 strict 和显式 `strict:false` 均保留。
- 新增 6 个兼容回归：多段文本拼接、跨段结构化输出、非 strict schema、正文与工具调用混合输出、单次模型超时、运行取消。后两项验证请求确实取消且没有新增模型调用或工具执行；没有默认启用新的生产超时配置。

### 消息序列兼容修正

首次真实 DeepSeek 烟测出现 `tool_calls` 后缺少配对工具消息的错误。使用“同一响应含 reasoning、正文与工具调用”的可控提供方响应，本地稳定复现了相同的非法序列：assistant/tool_calls → assistant/text → tool/result。

在现有 DeepSeek 模型绑定处增加消息归并：前一条 assistant 有工具调用且下一条仍是 assistant 时，合并它们的内容和 provider options，再交给 DeepSeek provider。这样保留正文、推理内容、调用 ID 和结果，工具结果紧跟调用。它只处理模型适配，不改变 Core、任务受理/续接或 Tool Loop。对应本地回归先失败、修复后通过；临时诊断探针已移除。

### 最终验证

| 检查                                | 本轮结果                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| 根 `build`                          | 通过                                                                            |
| 根 `typecheck`                      | 通过                                                                            |
| 根 `test`                           | 918 passed / 2 conditional skipped；67 个测试文件，共 920 个用例                |
| 真实 DeepSeek MainAgent 烟测        | 修复后 1/1 通过；真实 `deepseek-v4-flash` 调用一次 AgentCall 替身并返回非空文本 |
| `pnpm install --frozen-lockfile`    | 通过，锁文件无需解析更新                                                        |
| 受影响文件格式与 `git diff --check` | 通过；临时诊断探针已清理                                                        |

两项跳过与升级前一致，均为 Windows 文件符号链接权限条件；不是新增跳过。终态 Task 无法再订阅的 SDK stderr 在升级前已经存在，对应测试通过 GetTask 对账完成。

Agents 自带的传递依赖 `openai` 随之从 `6.45.0` 变为 `7.28.0`；Agents 的 ws peer 解析为 `8.22.0`，OneBot 的 `8.21.0` 保持原样。pnpm 为刚发布的五个 Agents 包自动生成了精确到 `0.19.0` 的 `minimumReleaseAgeExclude`；保留这些版本级例外以便本日复现安装，未放宽其他包的版本等待策略。

验证日志保存在本机临时目录 `huanlink-sdk-upgrade-20261006/`。本轮真实烟测没有调用真实 Codex 执行端或 QQ，也未实测真实提供方的结构化输出/超时质量。消息混合场景由确定性回归覆盖；一次真实烟测通过不代表长对话或全部提供方组合已经验证。

实际交付限于四处依赖声明、lock/workspace 配置、A2A 错误导入、DeepSeek 消息兼容、相关回归与本计划；此前确认的 AGENTS.md 修改单独保存。下一停点为本分支提交并推送后的交付；PR/合并需另行授权，不承接 D15 后续实验，不合并旧实验分支。

## 资料

- [A2A JS 1.3.0 发布](https://github.com/a2aproject/a2a-js/releases/tag/v1.3.0)
- [OpenAI Agents SDK 官方说明](https://developers.openai.com/api/docs/guides/agents/sdk)
- [OpenAI Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [D15 升级后实验边界](D15-experiment-retrospective-and-next-plan.md)
