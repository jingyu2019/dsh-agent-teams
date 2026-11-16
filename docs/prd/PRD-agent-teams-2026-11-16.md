# PRD：AgentTeams 需求整合（代码需求 + 失败恢复 + 竞品借鉴）

- 版本基线：`@nanmicoder/dsh-agent-teams` 0.1.33，HEAD `e000f8a`（分支 `dsh-1a1d66ea-8c22`）
- 日期：2026-11-16
- 组成：本文件为总纲；细则见 [Part A 代码需求](part-a-code-requirements.md) · [Part B 失败恢复](part-b-recovery-requirements.md) · [Part C 竞品与排期](part-c-competitors-roadmap.md)
- 决策来源：[上游 v0.1.30 合并分析](../upstream-0.1.30-merge-analysis-2026-11-16.md) · [能力基线](../analysis/current-capability-map.md) · [竞品对照](../analysis/competitor-features.md) · [事实核查](../analysis/final-report-verification.md)

## 1. 背景

一次真实团队运行暴露了本插件最贵的缺陷：5 个成员每次派发都在启动瞬间失败（宿主 429），此后**三个恢复出口同时关闭**——发消息续跑报 `subagent cannot be resumed`，面板无法改模型，`reset_member_context` 被自身守卫拒绝，attempt 计数器静默从 1 涨到 16。

根因在本仓库而非宿主：`src/tools.ts:859` 调用 `stopTeamMemberActivations(ctx, captain, [orphan])` 时**丢掉了 `signal`/`stateRoot`/`teamId` 三个参数**，于是 `src/tools.ts:625-627` 的 `releaseActivationPermitsForDrainedMembers` 永不执行，activation 许可被永久持有，成员永远不是 idle。

同期还完成了上游 v0.1.30 delta 与 6 个同类插件的对照，结论是：上游只有 2 处值得搬，竞品只有 5 项机制值得借。

## 2. 目标与非目标

**目标**
1. 失败可诊断、可重试：任何派发失败后成员能回到 idle 并再次派发。
2. 正确性补齐：schema 丢字段、文案误导、派单期写范围冲突、并发改写竞态。
3. 能力补齐：运行中改路由、专家目录导入、长会话日志范围读。

**非目标**（已评估并明确不做）
成员=独立 root 会话、root 会话间直接喊话、导演发言规划器、群聊 + SQLite 记忆库、dsh-web 全家桶；本仓库已记录的否决方向（渐进式工具加载、每成员压缩阈值、token-neutral 硬门、自审、宿主级写拦截、自动部署）继续维持。

## 3. 需求索引

| 编号 | 标题 | 类型 | 成本 | 档位 |
|---|---|---|---|---|
| R1 | 失败清扫 activation 租约 + 成员回 idle（吸收上游 #350） | 缺陷 | 0.5–1 人日 | M1 |
| R2 | `NOT_RESUMABLE` 分码：“已退休” vs “从未启动” | 可诊断性 | 0.5 人日 | M1 |
| R5 | 连续 N 次派发失败熔断 + 记录 `lastError` | 缺陷 | 0.5–1 人日 | M1 |
| P0-1 | `plan.members[]` 补 `executionPrompt`（上游 #352） | 缺陷 | S | M1 |
| P0-2 | `requireStagedTeam` 文案按工具区分（上游 #348） | 文案 | S | M1 |
| P0-3 | 派单期写范围准入闸（team-bots） | 能力 | M | M2 |
| P0-4 | 任务改写 `expected_revision` 乐观锁（team-bots） | 竞态 | S | M2 |
| P1-3 | 长会话日志范围读（上游 #356） | 性能 | M | M2 |
| R3 | 运行中团队成员改模型/推理档 | 能力 | 1.5–2 人日 | M2 |
| P1-1 | 平台 optional 包 cohort 校验（`2ee0409`） | CI | S | M2 |
| P1-2 | `publish.yml` consumer-resolution 守卫（`1f1977b`） | CI | S | M2 |
| P1-4 | 专家目录导入（experts-management） | 能力 | S/M | M3 |
| P0-5 | 消息 `idempotencyKey` + 反乒乓上限 | 竞态 | S | M3 |
| P2 | token 计量、`/expert-name` 手势、只读免核验 | 设计 | L/S/S | M3 |
| R4 | 死会话发消息时自动 reset 后投递 | 可用性 | 1 人日 | M3 |

排期：M1 3–4 人日 · M2 5–7 人日 · M3 8–10 人日，合计 16–21 人日（按 Part C）。

## 4. 关键设计结论（来自本次核对）

1. **R1 是唯一止血项**：`src/tools.ts:859` 补参即可让 `releaseActivationPermitsForDrainedMembers`（`src/state.ts:287`）生效；`src/members.ts:507` 的 idle 判定需要同时覆盖“失败”而非仅“非 running”。
2. **P0-3 的拦截点要前移**：`src/scheduler.ts:1595-1626` 位于 `beginTaskAttempt` 之后，太晚；应在 `nextReadyTask`（约 `:1534-1536`）与 `beginTaskAttempt`（约 `:1554`）之间判定。
3. **P1-3 改的是 `sessionOwnEvents`（`src/harness-compat.ts:347`）**，不是 `ownEvents()`；调用点 4 处：`src/mailbox.ts:217`、`src/members.ts:889/1118/1457`；`scripts/harness-compat-tdd.mjs:233-241` 当前断言全量读语义，**必须同改**。
4. **P0-5 不是从零做去重**：`src/tools.ts:3118-3126` 已有内容级去重并返回 `delivered:'duplicate'`，缺的是调用方可声明的 key。
5. **P0-4 需要新增计数器**：`TeamTask` 只有 `revisions?: TaskRevision[]` 审计账本，没有可比较的 `revision` 标量，成本由此上涨。
6. **P1-1 的验收不能空转**：现有 `scripts/harness-runtime-platform.test.mjs` 今天已通过且只覆盖 `linkDirectory`，必须新增用例断言 `skipped[].reason === 'optional-platform'`。

## 5. 竞品取舍（摘要）

借：team-bots 派单期写范围准入 / `expected_version` 乐观锁 / 只读免核验；experts-management 专家目录导入格式；limuyang2 + cross-session 的消息幂等与反乒乓。
不借：5 项明确否决 + 本仓库 6 项已记录否决方向（详见 Part C §2）。

## 6. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 宿主 member spawn 路径缺陷未修 | 插件只能止损，无法根治 429 | R1/R2/R5 让失败可见可重试；同时按 Part B §「不可由插件修复的部分」上报宿主 |
| 真实回归依赖可用的团队运行时 | M2 之后的需求难以端到端验证 | 用 `subagent` + 单元测试先验，团队运行时恢复后补做组合验证 |
| `/expert-name` 依赖宿主 `userInvocable` | 可能做不到零 token 召唤 | 先做 RPC 探测，不可行则降级为面板入口 |
| token 计量与 `#317` token-neutral 决议冲突 | 可能整条被否 | P2 先出 RFC，与 `#223`/`#315` 一并评议 |
| `#223` 关闭状态存疑 | R3 与归档删除的排期判断 | 以 `upstream-issues-triage.md:170` 实测为准：归档删除未实现 |

## 7. 证据索引

- 上游 delta：`docs/analysis/upstream-0.1.30-delta.md`（5 提交 / 23 文件 / +1198−242）
- issues 分档：`docs/analysis/upstream-issues-triage.md`（35 open，P0 2 / P1 3 / P2 6）
- 竞品：`docs/analysis/competitor-features.md`（6 项目 + §7 逐项对照）
- 能力基线：`docs/analysis/current-capability-map.md`（已实现 9 / 部分 4 / 缺失 3）
- 事实核查：`docs/analysis/final-report-verification.md`（9 处修正，已全部应用）

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-16 | 首版：整合上游 0.1.30 结论、35 条 issues 分档、6 个竞品对照、事故驱动的 R1–R5 需求 |
