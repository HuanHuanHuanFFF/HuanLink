# D15：A2A 标准与生态采纳评估（2026-10-04）

> 性质：研究结论与后续候选工作，不是实施授权。检索日期：2026-10-04。本文只新增评估文档，未修改代码、配置或依赖，未启动真实服务。

## 1. 先做什么

**最值得立即处理的是权限暂停语义，而不是先升级 SDK。** D15 把原生操作的授权请求发布为 `INPUT_REQUIRED`，又为此补写暂停后的状态持久化。当前安装的 `@a2a-js/sdk 1.0.0-beta.0` 已支持 `AUTH_REQUIRED` 后继续消费事件；本次纯内存对照确认，换成正确状态后，原生 `InMemoryTaskStore` 能保存恢复后的 Artifact 和终态。这个证据支持开展补丁删除实验，尚不证明 HuanLink 的补丁现在就能直接删除。

另一条独立结论是：A2A 已提供任务延续、授权回流和扩展协商的通用接口，但没有替 HuanLink 判断“对方还缺哪些任务信息”，也没有保证接收回执代表模型理解。用户要求的“先判断信息差，再决定压缩/同步”仍需要 Core 的任务上下文策略；当前实验实际上先执行压缩，再根据输出的 `change` 决定是否发送。

| 优先级 | 建议 | 直接收益 | 停止边界 |
| --- | --- | --- | --- |
| 现在采用 | 用 `AUTH_REQUIRED` 表达权限请求，普通问答保留 `INPUT_REQUIRED`；完成端到端状态迁移后，再尝试删除 `DelegationTaskStore` 的额外 drain | 使用已有标准语义及已安装 SDK 能力，减少自维护状态消费者 | 恢复后终态、Artifact、用户问答任一回流失败，保留补丁并定位具体接缝 |
| 现在采用 | 补齐 D15 扩展的声明、请求、激活和不支持时的拒绝；定义控制回执与 Task 快照的关系 | 防止双方各自认为扩展已启用；让控制路径能接受独立客户端验证 | 不扩展成通用认证/权限平台；D14 普通任务仍可不使用 D15 |
| 最小验证 | 以任务事实增量和远端已接收版本为输入，先判断相关性/缺口，再压缩 | 减少无关消息引发的压缩；更贴近用户目标 | 取消、缩权或新禁令被漏判，或新增判断成本超过节省，退回保守路径 |
| 最小验证 | 单独验证 SDK 1.3.0 升级；筛选终态保护、扩展校验和错误处理收益 | 获得 beta 之后的实际修复，减少底层兼容代码 | 不把依赖升级和权限状态修改捆成一个无法归因的变更 |
| 最小验证，靠后 | 在独立 Adapter 存储试验中复用 `DatabaseTaskStore`，先解决重启后查询历史 | 可复用的持久化实现，避免再造基础 TaskStore | 不声称恢复原生 RPC、Codex turn 或副作用；数据库打不开即停止接受新任务 |
| 暂缓 | OID4VP、通用 capability token、IntentRail 全套协议 | 当前单用户实验不需要身份凭证基础设施 | 只吸收窄化授权、原操作绑定、重放失败场景；出现真实跨信任域需求再启动 |

## 2. 证据基线与版本边界

本地核验对象为 `C:\Users\幻\.codex\worktrees\delegation-context\HuanLink`，分支 `codex/exp-delegation-context`，HEAD `229b0699b0cd5b388cd3c2c81092498a9d100153`，含未提交 D15 实验。下文仓库路径均相对此根目录，行号是本次读取的工作树行号，不能只用 HEAD 还原这些未提交代码。主工作区 `D:\CodingProject\HuanLink` 未写入。

> 迁移说明（2026-10-05）：本文迁入统一 SDK 升级分支 `codex/chore-agent-sdks`，作为后续 A2A 与 OpenAI Agents SDK 升级的参考。文中实验实现与验收记录仍对应原 `codex/exp-delegation-context` 工作区；实验代码未随文档迁入，两个 SDK 的升级将在本分支分批验证。

交付复核时，集成分支已由并行工作推进到 `11981e47453ca91f8650b29639e227748822c34a`，修复任务快照落库失败后的状态分裂，涉及 AgentCall、AsyncToolTask 及其测试。本报告仍以以上 D15 实验工作树为代码对照；没有把该集成修复合入实验树，也未评估它与后续状态迁移的组合。进入开发时应先核对最新集成基线，再复测暂停、控制回执和持久化失败路径。

- **发布事实：** A2A 核心最新 release 是 [v1.0.1][S1]，GitHub `published_at` 为 2026-05-28，release notes 标题日期为 05-26；两者含义不同。规范发布内容以 [v1.0.1 tag][S2] 为准。
- **主干事实：** [PR #2081][S3] 于 2026-07-30 合并，commit `6550d344b39c11f3ba64131f4841c8f6fd8e2754` 增补 §7.6.4，明确授权范围、有效期、撤销等不由核心协议定义。它是已合并主干说明，不能倒算成 05 月 release 的条款。官网 `latest` 顶部仍显示 1.0.0，页面已包含该后续段落，因此不以页眉推断内容版本。
- **SDK 事实：** GitHub [v1.3.0 release][S4] 与 npm `latest` 均为 1.3.0；release 时间 2026-09-29，commit `29417a5bb4038f804f310ce4fffd267a9375aa90`。HuanLink 两个 package.json 和 lockfile 仍锁定 1.0.0-beta.0，本次也读取安装包确认相同版本。
- **证据等级：** “事实”来自本次源码、发布元数据或本次复现；“分析/建议”是据此提出的设计；“未验证”不因历史测试通过而消失。D15 文档中的 917 passed / 2 skipped 和真实模型四检查点属于 2026-09-30 的历史记录，本次没有重跑。

## 3. 权限暂停与回流：已有标准能力被错误状态遮住

### 3.1 当前实现与标准差异

**本地事实：**

| 接缝 | 当前证据 | 影响 |
| --- | --- | --- |
| 发布权限请求 | `apps/codex-a2a-adapter/src/codex-task-executor.ts:459–485`，特别是 470 行 | 原生 command/file-change 审批使用 `INPUT_REQUIRED` |
| 补充消费者 | `apps/codex-a2a-adapter/src/delegation-task-store.ts:11–73` | 在带 `permissionRequest` 的 INPUT_REQUIRED 后另挂事件监听并调用 `ResultManager` |
| Core 暂停门 | `packages/core/src/delegation/coordinator.ts:127–132,193–198` | 只有 input-required 才进入权限复核 |
| 状态映射 | `packages/integrations/a2a-client/src/a2a-task-snapshot.ts:139–142,165–166` | 已能表示 auth-required，但两种暂停被统一处理 |
| 观察链路 | `packages/integrations/a2a-client/src/a2a-agent-call-transport.ts:361–450` | 收到任一种暂停就结束订阅 |
| 决策后重订阅 | `packages/core/src/agent-call/agent-call-service.ts:1192–1218` | 本地决策先停止旧 watcher，应用回执快照，再视状态重启；这是当前能继续观察的应用机制 |

**标准事实：** 发布规范 v1.0.1 §7.6 已包含人工批准破坏性操作这一场景；向客户端委派授权请求须用 `AUTH_REQUIRED`。客户端可以自行满足请求、调用其他服务，或向其上游继续回流；并不要求每次都询问人。带内授权交换须有带外约定或扩展。[发布规范 §7.6][S2]

**边界：** 这解决“怎样表达暂停、谁继续处理”，不判断用户原话是否授权某条命令。已有 owner 原话校验、独立 Reviewer、Adapter 硬上限和单次审批绑定仍有作用。语义摘要不是 credential；`AUTH_REQUIRED` 本身也不是授权凭证。

### 3.2 本次最小复现：当前 beta 已有后台消费能力

执行位置为实验工作树的 `apps/codex-a2a-adapter`；通过 PowerShell 把内存脚本传给 `node --input-type=module`。使用实际安装的 1.0.0-beta.0，不写文件、不启动 HTTP、不调用 Codex 或模型。

可重做的 API 步骤：每场景创建原生 `InMemoryTaskStore`、`DefaultExecutionEventBusManager`、`ServerCallContext`、`DefaultRequestHandler`；合成 executor 发布 Task 与暂停状态后立即返回；分别用 blocking / `returnImmediately:true` 发送。等待事件队列进入暂停后，在同一个 bus 发布 WORKING → 一个 Artifact → COMPLETED；读取 store 并断言状态与 Artifact 数量。未使用 HuanLink 的 `DelegationTaskStore`。

| returnImmediately | 暂停状态 | 初始返回状态 | 后续 store 状态 | Artifact 数 | 断言 |
| --- | --- | --- | --- | ---: | --- |
| false | AUTH_REQUIRED | AUTH_REQUIRED | COMPLETED | 1 | 通过 |
| false | INPUT_REQUIRED | INPUT_REQUIRED | INPUT_REQUIRED | 0 | 通过（对照预期） |
| true | AUTH_REQUIRED | SUBMITTED | COMPLETED | 1 | 通过 |
| true | INPUT_REQUIRED | SUBMITTED | INPUT_REQUIRED | 0 | 通过（对照预期） |

原始结果字段为 `sdk, returnImmediately, pause, initial, after, artifacts, expected`，四行 `sdk=1.0.0-beta.0`、`expected=true`；进程退出码 0。这里“对照通过”意为复现了 INPUT_REQUIRED 停止保存的机制，不表示该应用行为正确。

安装包 `dist/server/index.js:327` 的队列停止集合含 INPUT_REQUIRED、不含 AUTH_REQUIRED；801–808、1021 附近已有授权快照与继续消费路径。官方 [beta 冻结测试][S5] 已有 `background consumer persists post-AUTH_REQUIRED events into the task store`；[变更记录][S6] 将相应 #523 / `68826c2` 归入 1.0.0-beta.0。因此“需升级才有此能力”不成立。

**限制：** 复现未覆盖 HuanLink HTTP 控制拦截、watcher 重订阅、`turn/steer`、普通问题与授权交叉、真实权限 RPC 或 SSE 断线。它证明 SDK 基础能力与状态选择的因果关系，不等于端到端迁移完成。

### 3.3 最小改动与验收

**建议：** Adapter 发布及控制回执中的权限状态改为 auth-required；Core 权限协调入口识别该状态；普通问题保持 input-required。授权等待期间，客户端优先保留观察流；若保留现有暂停即退出模式，必须明确由什么事件恢复观察，尤其不能假定所有授权都由本进程 `controlTask` 完成。完成这一步才用原生 TaskStore 替换额外 drain 做对照。

责任模块是 Adapter、A2A Client 和 Core 的状态协调，依赖成本低：当前 SDK 即可做第一轮，暂不增加包。不得将 Codex command、工作区或沙箱规则移入 Core。

验收必须覆盖：已有证据自动批准；疑义只问一次后续接原 approvalId；明确拒绝/过期/取消；权限完成后 Artifact 与终态回流；AUTH_REQUIRED → INPUT_REQUIRED → 原问题回答 → 完成；普通问题待答期间同步上下文；外部授权恢复或决策回执丢失后仍可用 GetTask 对账；每个事件只写一次，无重复 Artifact。任一场景需要新建 Task、丢失原问题或吞掉终态，停止删除补丁。

## 4. 扩展协商与控制消息：先让双方明确同一份合同

**本地事实：** Agent Card 在实验开启时声明 `urn:huanlink:delegation:v1`，`required:false`（`apps/codex-a2a-adapter/src/agent-card.ts:23–35`）。但 capability discovery 只核对协议、streaming 和 skill（`packages/integrations/a2a-client/src/a2a-agent-call-transport.ts:64–100`）；控制发送只有 Data Part 和 signal（250–265 行），未请求扩展激活。`server.ts:67–87` 在默认 handler 前截获控制消息，`controlMessage` 签名只接收 Message，不接收 `ServerCallContext`。

**标准及可复用对象：** v1.0.1 §3.2.6、§4.6 定义扩展 URI、版本兼容与 `A2A-Extensions` 服务参数；当前 beta 安装包已经导出 `ServiceParameters.create(withA2AExtensions(uri))`，服务端有 `ServerCallContext.requestedExtensions`、`addActivatedExtension(uri)`。官方 [JS 扩展示例][S7] 展示请求、激活、响应携带扩展信息的接缝。URI 使用 URN 本身不是问题，缺的是可核对的扩展合同和实际协商。

**建议：**

1. 继续允许不依赖 D15 的普通 D14 请求；D15 派单必须先确认对端声明精确 URI/版本，并在请求中显式激活。服务器在执行或更新状态前检查激活条件并返回激活结果；不支持时停止 D15 派单，不静默降级掉权限语义。不能仅把整张 Agent Card 改成 `required:true` 就认为问题解决。
2. 把 taskId/contextId/delegationId、revision、approvalId、超时、重复与冲突、receipt 阶段、不确定结果的处理写成一个窄扩展合同。保留当前带内 Data Part 可以落地，无需为实验先设计新 RPC。
3. 控制入口取得 `ServerCallContext`，在调用控制器前完成任务存在性、调用范围、终态和扩展校验。SDK 升级后的默认保护不会自动覆盖这条提前返回路径。当前是本地单用户实验；这里是互操作和未来信任边界，不据此宣称已验证的多租户漏洞。

**控制响应的特别边界：** `codex-task-executor.ts:383–451` 返回 Message，其中私有 `data.receipt` 同时携带一份私有 snapshot；客户端 267–304 行拒绝 Task 响应。这是双方配套合同。官方 [Life of a Task 指南][S8] 倾向任务创建后继续返回 Task，而发布规范 §3.1.1 本身允许 Task/Message 两种结果；本次不把这一点直接判成违反核心 MUST。

当前本地实验推荐先采用 B：保留明确激活的扩展 Message 回执，以 GetTask 为规范状态查询入口，约定回执不产生新任务、不作为普通任务输出。这样可先修正状态与协商，并保留既有原操作绑定。开始接入不理解私有回执的独立客户端、或需要对外提供统一任务接口时，切换候选 A：返回规范 Task，回执放命名空间 metadata，执行结果仍单独确认。A 的采用门槛是 metadata 实际保存/读取、断线后 GetTask 可对账、普通问答和控制不分叉全部通过；只换返回类型不算完成。见下一节 SDK metadata 版本差异。

责任模块：A2A Client 负责协商与线格式，Adapter 负责接收和执行端校验；Core 只保留通用控制合同。成本主要是 HTTP 对照测试和错误映射，不需要身份服务。验收：关闭一侧、缺 URI、未知版本、未激活、错误 Task/Context、终态控制、重复控制、普通任务不带扩展均有确定结果；未知 taskId 不能统一伪装成语法错误。出现未协商仍执行或私有快照与 GetTask 分叉，停止推广到其他 Agent。

## 5. 上下文信息差与回执：A2A 提供关联，不提供算法

**本地事实：** `context-manager.ts:78–121` 仅在事实游标未改变时跳过；有新增事实就调用 `model.compact`。`change` 是压缩返回的一部分（`packages/integrations/openai-agents/src/delegation-model.ts:8–21,28–39`），之后 `coordinator.ts:143–160` 才决定是否发包。现有“无关消息不同步”避免了传输，却没有避免压缩调用。

`types.ts:25–64,82–94` 记录 version、throughEntryIndex、receivedRevision 和 receipt；`delegation-execution.ts:157–176` 拒绝同版本不同内容、旧版本和旧游标，调用 steer 成功后返回 received。初次 receivedRevision 由成功派单结果推得（`coordinator.ts:103–106`），后续有显式控制回执；两类证据也应区分。当前没有字段能证明模型已理解或按最新限制行动。

**标准事实与边界：** v1.0.1 §3.4 用 contextId 关联会话、taskId 延续任务；它们不是共享记忆对象。§3.7 明确消息历史与断线后的状态消息不保证完整，不能拿“发送过/历史里有”推导可靠同步。[规范][S2] 本次未在已核对核心规范、官方 SDK 或下述上下文示例中发现可直接替换任务相关性判断/压缩的标准算法。

**可学习但不直接照搬：** 官方 samples 的 [Secure Passport][S9] 使用 `callerContext`、`supportedStateKeys` 表达选择共享的结构化上下文。可借鉴“接收方声明理解哪些字段”和最小必要共享；不能当成双向同步、信息差判断或授权标准。冻结示例仍出现旧 `tasks/send` 与旧 Message 形状，signature 的必选描述也不一致；Python 示例和概念性签名流程不能原样作为当前 TS/v1.0 的安全实现。签名最多证明来源与完整性，不证明状态正确或动作被用户授权。

**建议的最小策略：** Core 先比较本任务新增事实、原始 owner 证据、远端已接收事实/版本，以及远端可观察的当前阶段、已有 Artifact、待答问题。候选状态记录应带观测时间、对端时间戳（如有）、相关 revision/Artifact ID，区分过期观测和当前反馈；不推断远端内部记忆。输出 `无需更新 / 需要同步 / 需要压缩 / 需澄清` 和依据。优先在任务边界或受阻时让对端定向报告缺失事实、产物引用或待答项；状态不足时只做有界澄清，现有证据无法消除的任务或权限疑义才回到用户，不持续要求对端复述整个上下文。

可先用稳定事实 ID、内容 hash、任务归属、接收游标过滤重复，但同文新消息不能一律去重：提问后的新确认必须保留 messageId、owner、时序与 approval 目标，不能因为正文与旧确认相同而丢弃。语义有疑义时进入保守压缩/同步路径；取消、缩权、新禁令不能经过一个可能返回“无关”的通用过滤器就消失。初次派单仍按任务整理最小上下文，不必为无既有对端状态的首次派单硬加一轮 LLM 判断。

模型只处理确有语义需求的判断，保留原话引用及程序校验。不要为了“先判断”固定增加每条消息两次 LLM 调用；独立判断和合并判断应以质量/成本样本选择。也不要以全会话一致为目标引入 CRDT、向量时钟或通用共享记忆平台。

若需要更强回执，分开记录：远端收到版本；执行器接受补充输入；实际操作产生的可观察结果。最后一层必须由操作/日志/测试证据支持，不能让模型自报“已理解”代替。失败后丢回执只说明未知，不能推断未执行并重放。

责任模块：Core 的 `DelegationContextManager/Coordinator` 和存储负责差异策略；模型集成只提供有限结构化推断；Adapter 仅报告能证实的接收/执行器事实。初版可不加第三方依赖。验收使用同一组带人工标注的多任务消息，比较当前方案与候选方案的漏同步、错同步、压缩次数、发送量、询问次数，并单列取消/缩权遗漏与错误放行。先验证相关事实覆盖，任何关键限制漏掉就退出优化，不能用压缩率换取授权漏判。

## 6. SDK 升级与数据库：可复用什么，不能替代什么

### 6.1 SDK 1.3.0 应单独验证，不能只改版本号

**本地依据：** `apps/codex-a2a-adapter/package.json:26`、`packages/integrations/a2a-client/package.json:24`；`pnpm-lock.yaml:29,84,118,1312`；Adapter 直接继承默认 handler/内存 store、使用 RequestContext/EventBus/ResultManager。这些是升级检查重点。

从 [冻结 CHANGELOG][S6] 筛出的相关变化：

| 官方版本 / 变更 | 对 HuanLink 的实际价值与限制 |
| --- | --- |
| 1.0.0-beta.0，#523 / `68826c2` | AUTH_REQUIRED 后台消费已存在；不是本轮升级新增收益 |
| 1.0.0，#581 / #587 | RequestContext 构造与错误类型层级有破坏性变化；现有 `userMessage` getter 仍存在，但测试构造和错误判断须编译及回归验证 |
| 1.2.0，#636 / `7b87c94` | 终态转换保护与 cancel 原子处理，可减少 SDK 内并发异常；不等于 Codex 副作用可撤销或分布式 exactly-once |
| 1.2.0，#690 / `3b4ef3f` | 缺 required extension 在修改任务 history 前拒绝；提前截获的 HuanLink control 分支仍需自己接入校验 |
| 1.2.1，#748 / `72588af` | 修复 status/artifact event 的 metadata 传播到 Task，直接影响“回执放 Task metadata”的候选方案 |
| 1.3.0，#756 / `0f2e563` | 新增数据库 TaskStore/PushNotificationStore；Adapter 当前不声明 push，后者暂不引入 |

另一个升级组合风险是：1.2.0 起 EventBus 按 tenant/owner 分桶，1.3.0 的 get/create/cleanup 接口接受可选 ServerCallContext。当前 `DelegationTaskStore.ts:34` 调用 `getByTaskId(task.id)` 未传已有 context；旧调用可能仍能编译，但未来接入身份/租户时会查到默认桶，须连同调用上下文一起验收。当前本地未认证路径不能据此认定已经发生跨租户问题。[冻结 EventBusManager](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/events/execution_event_bus_manager.ts)

这里只核对了相关实现、测试与变更记录，未安装或运行 1.3.0。建议先在独立升级批次比较两端编译、序列化、JSON-RPC 错误、终态竞态、扩展及暂停恢复；再选择稳定版本。跨入口错误识别、请求构造失败或既有 D14 路径回归即停止升级交付，保留当前锁定版本并记录原因。

### 6.2 DatabaseTaskStore 是具体复用项，但只覆盖存储层

**当前状态：** `server.ts:65–66` 创建进程内 bus 和继承 InMemoryTaskStore 的 `DelegationTaskStore`；`delegation-execution.ts:38–52,199–212` 的 pending/consumed 也在内存，consumed 有 128 条上限。Core SQLite 保存对话和委派记录，不能恢复 Adapter 的原生 RPC 或内存事件队列。

**官方可复用代码：** 1.3.0 公共子路径 `@a2a-js/sdk/server/database` 导出 `DatabaseTaskStore`；构造方式为 `new DatabaseTaskStore(kysely, options)`，有 ownerResolver/tableName，load/list 按 tenant/owner 过滤。迁移是显式操作，不会首次读取时自动建表。官方 [store 实现][S10] 的 save 是按键 upsert 替换整个 Task；没有因此获得原生操作事务、执行检查点或跨进程抢占锁。

**成本：** 需要 Kysely 和数据库驱动/方言以及迁移。官方已支持 SQLite/PostgreSQL/MySQL；npm 声明 SQLite 驱动 peer 为 `better-sqlite3`。本地 Core 用 `node:sqlite`（`packages/core/src/conversations/sqlite-database-connection.ts:1–20`），不是原样传进去的 Kysely 连接。优先在 Adapter 独立数据库试验，避免为 TaskStore 顺带改 Core 存储。若必须自写驱动桥接才能复用，先比较薄 TaskStore 实现的维护成本，不以“统一数据库”作为扩范围理由。

**验收分三层：**

1. 第一层只承诺“重启后能查询旧 Task 的状态、Artifact 与记录”；校验 owner 范围、旧 schema、损坏记录、迁移失败、并发保存和状态回退。
2. 活跃任务重启后标记为需对账/恢复未知；不得凭数据库里的 WORKING 宣称进程仍工作，也不得把 AUTH_REQUIRED 直接恢复成批准。
3. 真正恢复执行需另外证实 Codex thread/turn 可续接、原 approvalId/RPC 仍有效、资源占用正确、重复请求不会执行第二次。未满足前停止于第一层，不建设自动重试执行器。

责任模块是 Adapter 的任务存储与进程恢复边界；Core 仅消费对账结果。现阶段先完成授权/控制合同，再安排这一试验。

## 7. 恢复、幂等与可靠回执的真实保证

**已实现的局部保证：** `delegation-execution.ts:157–166` 对上下文版本做重复/冲突/乱序处理；180–220 行把 decision 与原 approvalId、当前 contextRevision、有效期绑定，在写原生决定前记录消费。`coordinator.ts:139–142,187–190` 对同步结果不明进入 uncertain，阻止继续批准。这些保守行为值得保留。

**没有的保证：** 进程内 Map 加单次 approvalId 不构成持久化执行账本；先记消费、后写 RPC 的失败窗口也不能证明操作执行成功。A2A v1.0.1 §3.3.1 仅允许 SendMessage 实现自行用 messageId 去重，未保证所有服务的发送都幂等；§3.7 未保证消息完整补发。[规范][S2] 新 SDK 数据库存储同样不是执行副作用与回执的原子事务。

**建议：** 先固定 `operationId/approvalId + 原操作内容标识 + contextRevision + receiver` 的边界与查询方式，保留 received/decided/unknown 的差别。只对已证实未受理的操作自动重试；受理未知先 GetTask/扩展状态查询，若仍无法判断则保持冻结并交由上层处理。不要把“用户已授权”误当成“重复执行安全”。

责任模块：Core 记录决策和对账状态；Adapter 绑定原生请求与效果；A2A Client 处理传输未知，不替执行端猜测。成本可先限于合同和受控故障注入。验收必须覆盖：决定已执行但响应丢失、决定未送达、过期响应、同 ID 改内容、两次并发决定、重启后旧 approvalId、取消与完成竞争。若不能区分未知结果，退出自动重放而不是扩大批准范围。

## 8. 只跟踪与当前问题有关的研究

| 对象 / 截至检索日成熟度 | 值得采纳的思想 | 当前不直接采用的原因 | 重新评估触发条件 |
| --- | --- | --- | --- |
| [IntentRail，A2A issue #2098][S11]：2026-08-03 提案，仍 open；作者称原型仓库未公开 | 规范化操作意图、授权引用、稳定执行身份、结果四者绑定；变更或重放时确定拒绝 | 不是已发布扩展，无公开实现可独立审计；不能把作者描述当现成 exactly-once | 出现公开版本化规范、实现和跨实现故障测试；可先把其失败场景纳入本地验收 |
| [Capability-based authorization discussion #1404][S12]：Draft/Ideas | 按任务授予最小能力、子委派只能收窄、能力有期限/撤销、接收端执行约束 | 提议的能力 RPC/Agent Card 字段不是 A2A 核心能力；自然语言 scope 与 cwd 检查不能冒充不可伪造的资源能力 | 接入真正跨用户/跨服务的可隔离资源，且下游能实际执行资源/操作边界 |
| [OID4VP In-Task Authorization][S13]：官方组织实验仓库，README 明示 Experimental，v1 Draft | 把 AUTH_REQUIRED 挑战与机器可验证凭证交互分开；说明不必每次通过人类问答 | 需要 issuer/verifier/wallet/信任策略；证明身份/资格并不能解释本地用户是否授权这次 git push | 出现合作方已使用可验证凭证的真实场景，并有必要的信任与撤销要求 |

三者均不提供本次所需的信息差压缩算法。不为了跟踪提案在 Core 恢复旧自建 AgentLoop/PolicyEngine，也不把“授权模型判断”升级成全局权限平台。对当前场景最有价值的是原操作绑定、最小授权、未知结果不重放，而不是采用完整凭证生态。

## 9. 最小实施顺序与检验方式

1. **状态纠偏批次：** 基于当前 beta 复现扩成 HuanLink 受控 HTTP/脚本协议检查，联动 Adapter、Core 暂停门、A2A watcher、控制快照与普通问答。通过后单独做额外 drain 的移除对照。验收只宣称受控链路；真实 Codex/QQ 仍单列。
2. **扩展合同批次：** 明确 D15 URI/版本、请求激活、控制回执与规范 Task 状态、错误/未知结果规则；选一个独立客户端验证，先不变更语义压缩策略。
3. **SDK 升级批次：** 两端同批升级候选 1.3.0，编译/类型/受影响包检查及上述生命周期回归。仅按需要启用 metadata/终态保护等收益，不因数据库功能存在就一起迁移。
4. **信息差策略批次：** 用人工标注样本比较当前压缩优先和候选差异优先；报告分母、关键漏判和成本，再决定是否采用。用真实合成模型调用补充受控模型测试，不能只测返回字段形状。
5. **可选持久化批次：** 先落 Adapter 历史查询，待真实恢复需求和协议证据明确后才讨论活跃任务恢复。

可复用官方验证资产：[A2A TCK][S14] 按传输和 MUST/SHOULD/MAY 检查，优先选已核对目录中的 JSON-RPC 任务生命周期、history、SSE 顺序场景，再核对版本与扩展规则的实际覆盖；[A2A ITK][S15] 验证跨 SDK/版本的消息、流和重订阅，可借用最小 TS↔另一官方 SDK 的组合。TCK/ITK 的通用用例不会自动理解私有审批合同，仍需 D15 专属场景。两者本次均未安装运行；ITK 有 Linux/容器环境成本，不要求在 Windows 本轮搭整套矩阵。工具通过只能说明对应协议场景，不能证明模型理解、授权语义正确或 QQ/Codex 工作质量。

以上均是候选分批工作，进入实施前应在 active plan 中明确批次、验收和停止点；本评估不授权 commit、push、PR 或 merge。

## 10. 尚待解答与本次未验证项

- AUTH_REQUIRED 迁移后，D15 控制响应与订阅退出/重启是否能完全采用 SDK 原生机制，特别是普通 requestUserInput 的交叉序列？本次只证实 SDK 的纯内存基础路径。
- 控制 Message 是否保留为显式扩展，还是统一返回 Task？需要独立客户端和错误路径证据，而非直接按指南文字重写。
- 谁能被视为可信 owner 是当前本地配置约定；跨 Agent/跨用户传播证据时需要什么身份绑定，尚未有真实需求与验收。
- 所谓“双方状态”当前只涵盖本地事实、远端接收与 Task 生命周期；对端究竟已使用哪些事实没有可验证通用接口，不能把变量改名为 known/understood 就宣称解决。
- 新 SDK 的数据库组件尚未在 HuanLink 安装/编译/运行；SQLite 驱动方案、迁移和恢复合同尚待最小试验。
- 未跑本次全套测试、真实 QQ、真实 Codex 编码或原生批准闭环；未验证模型误放行率、漏同步率、长对话压缩质量、用户打扰频率。

## 来源索引

所有外部条款作为研究资料处理。优先使用冻结 tag/commit；issue/discussion 状态以 2026-10-04 的 GitHub 页面/API 为准，不视为发布能力。

- [S1：A2A v1.0.1 release][S1]；[GitHub release API](https://api.github.com/repos/a2aproject/A2A/releases/latest)。
- [S2：v1.0.1 冻结规范][S2]，重点 §3.3、§3.4、§3.7、§4.6、§7.6；[权威 proto](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto)。
- [S3：#2081 合并记录][S3]；[冻结主干改动](https://github.com/a2aproject/A2A/commit/6550d344b39c11f3ba64131f4841c8f6fd8e2754)。
- [S4：JS SDK v1.3.0 release][S4]；[npm 版本元数据](https://registry.npmjs.org/@a2a-js/sdk/1.3.0)。
- [S5：beta AUTH_REQUIRED 回归源码][S5]；[beta 事件队列](https://github.com/a2aproject/a2a-js/blob/v1.0.0-beta.0/src/server/events/execution_event_queue.ts)；[v1.3.0 请求处理器](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/request_handler/default_request_handler.ts)。
- [S6：v1.3.0 冻结 CHANGELOG][S6]；[升级后的 RequestContext](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/agent_execution/request_context.ts)。
- [S7：SDK 扩展激活示例][S7]；[扩展示例说明](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/samples/extensions/README.md)。
- [S8：v1.0.1 任务生命周期指南][S8]，解释性指南，与规范 MUST 的证据等级分开。
- [S9：Secure Passport 示例规范][S9]，samples commit `6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3`。
- [S10：v1.3.0 DatabaseTaskStore][S10]；[database 公共导出](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/database/index.ts)；[方言检测](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/database/dialect.ts)。
- [S11：IntentRail open proposal][S11]；[S12：Capability authorization draft discussion][S12]。
- [S13：OID4VP 实验 README][S13]，冻结 commit `e86356d4a330ede795eb5b458fd2a838ffea0064`。
- [S14：TCK README][S14]，冻结 commit `263b9cfaf16a554bdfb166a7ba5b67716e946349`；[S15：ITK README][S15]，冻结 commit `b57c5332aa883b27c1e5c915fe61cac76d2a1de9`。

[S1]: https://github.com/a2aproject/A2A/releases/tag/v1.0.1
[S2]: https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md
[S3]: https://github.com/a2aproject/A2A/pull/2081
[S4]: https://github.com/a2aproject/a2a-js/releases/tag/v1.3.0
[S5]: https://github.com/a2aproject/a2a-js/blob/v1.0.0-beta.0/test/server/request_handler/auth_required.spec.ts
[S6]: https://github.com/a2aproject/a2a-js/blob/v1.3.0/CHANGELOG.md
[S7]: https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/samples/extensions/extensions.ts
[S8]: https://github.com/a2aproject/A2A/blob/v1.0.1/docs/topics/life-of-a-task.md
[S9]: https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/extensions/secure-passport/v1/spec.md
[S10]: https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/database/task/store.ts
[S11]: https://github.com/a2aproject/A2A/issues/2098
[S12]: https://github.com/a2aproject/A2A/discussions/1404
[S13]: https://github.com/a2aproject/experimental-ext-oid4vp-auth/blob/e86356d4a330ede795eb5b458fd2a838ffea0064/README.md
[S14]: https://github.com/a2aproject/a2a-tck/blob/263b9cfaf16a554bdfb166a7ba5b67716e946349/README.md
[S15]: https://github.com/a2aproject/a2a-itk/blob/b57c5332aa883b27c1e5c915fe61cac76d2a1de9/README.md
