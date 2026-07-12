# Codex A2A Adapter v1.0 产品能力草稿

> **状态：草稿。** 本文只记录当前已经形成的产品方向，不是最终架构规范。
>
> `23-a2a-first-real-demo-plan.md` 仍是当前 Demo 的主计划。本文不会自动扩大 Phase 3～Phase 5 的实现和验收边界。

## 1. 定位

Codex A2A Adapter 将真实 Codex app-server 适配为标准 A2A Agent。A2A 负责标准通信，Adapter 负责项目、工作目录、模型和本地运行约束等业务能力。

v1.0 先形成可用的本地单用户产品能力，不提前建设完整权限平台、任务基础设施或多租户系统。语义质量优先依靠 Codex 的自动化执行和 Review；Adapter 只保留必要的机械兜底。

## 2. v1.0 基础能力

### 2.1 项目选择

- 用户可以从已注册的本地项目中选择目标项目。
- 每个项目使用稳定的 `projectId`，映射到本地 workspace 和分支规则。
- A2A 任务只传 `projectId`，不接受任意绝对路径作为任务目标。
- 项目注册方式暂未冻结，优先考虑本机界面选择 Git 项目并保存本地配置。

### 2.2 工作目录选择

- 用户可以选择项目内相对目录作为可选的 `workingDirectory`。
- `workingDirectory` 是工作焦点，不是硬权限范围。
- Codex 必要时可以修改同一项目中的其他目录，例如根配置、测试或依赖文件。
- Adapter 必须完整报告实际修改文件和 diff，不能把工作焦点描述成实际修改边界。
- Adapter 只做基础路径检查：目录必须存在、位于目标项目内部，并且不能通过路径解析逃逸项目。

### 2.3 模型选择

- 用户选择真实的 `modelId`，任务传输中只写模型 ID。
- 产品界面默认直接显示模型原名。
- 用户可以为模型配置本地别名；存在别名时显示别名，否则显示模型原名。
- 别名只属于展示配置，不改变真实模型身份，也不参与 A2A 任务判断。

```text
displayName = alias ?? modelId
```

### 2.4 自动化结果

- 保留标准 A2A 任务提交、订阅、查询、取消、终态和 Artifact。
- 支持通过 `contextId` 复用 Codex thread，承载后续要求和纠正。
- 任务结果应包含摘要、实际变更文件、diff、执行过的验证和自动 Review 结论。
- 自动 Review 负责发现不合理修改和质量问题，但不替代 Adapter 的基础路径与运行约束。

### 2.5 最小机械兜底

- 任务只能操作已注册项目。
- 分支规则由项目配置决定，任务不能任意切换分支。
- 不自动 commit、merge 或 push。
- 同一 workspace 不允许多个修改任务同时执行；采用拒绝还是简单队列后续再定。
- 本地版本默认仍只监听 loopback 地址。

## 3. A2A 目标信息

目标信息可以放入标准 A2A Message 的 metadata 或结构化 Part，不新增自定义传输协议。自然语言任务仍作为标准文本内容传递。

```json
{
  "projectId": "huanlink",
  "workingDirectory": "apps/codex-a2a-adapter",
  "modelId": "gpt-5.4-mini"
}
```

## 4. v1.0 暂不建设

- `scopePaths`、文件级 ACL 和“修改焦点目录外文件即失败”。
- 每任务独立 worktree。
- 完整审批中心和权限回流。
- 多租户、远程公网鉴权和组织级策略。
- 服务重启后的任务与 thread 持久化恢复。
- 模型档位、自动路由、成本策略和故障转移。
- 复杂并发调度和持久化任务队列。
- 自动 commit、push 或 merge。

## 5. 后续需要验证

- 项目注册使用本机界面、配置文件还是两者并存。
- 项目注册信息和模型别名保存在哪里。
- 可选模型列表由 Codex app-server 动态提供，还是由 Adapter 配置维护。
- 自动 Review 在 app-server 上采用什么稳定调用方式。
- 同一 workspace 已有任务时采用立即拒绝还是简单排队。
