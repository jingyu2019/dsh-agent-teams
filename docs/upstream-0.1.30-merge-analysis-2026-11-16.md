# 上游 v0.1.30 + 同类插件：可合并/可借鉴决策报告

> 2026-11-16 · 仓库 `@nanmicoder/dsh-agent-teams` 0.1.33（Harness `0.2.2-rc.3`）· 分支 `dsh-1a1d66ea-8c22`
> 分报告：[upstream-0.1.30-delta.md](analysis/upstream-0.1.30-delta.md) · [upstream-issues-triage.md](analysis/upstream-issues-triage.md) · [competitor-features.md](analysis/competitor-features.md) · [核查报告](analysis/final-report-verification.md)

## TL;DR

1. **上游 v0.1.30 没有可合并的运行时功能**——它是 Harness `0.2.2-rc.2` 兼容补丁，四条 release note 在本线全部已实现（本线是它的超集）。真正值得搬的只有 **2 处工程性修复**（`2ee0409` 平台 optional 包校验，4 文件 +81/−13；`1f1977b` 发布 job 守卫，1 行）——两者都在上游 `up-v0.1.30` 提交集内，只是 release note 没写。
2. **最该先做的是本仓库自己的 bug，不是上游或竞品**：`plan.members[]` 缺 `executionPrompt` 字段导致静默丢数据（上游 #352，本线复现于 `src/tools.ts:1202-1208` vs `:3689`）。
3. 竞品里唯一同时提升并行度与正确性的是 `8kugames/dsh-team-bots` 的**派单期写范围准入闸**；其余多为产品面扩张，不建议。
4. P0 全做完约 **4–5 人天**；P1 另 3–5 人天。

## 1. 优先级总表

| # | 项 | 来源 | 类型 | 成本 | 风险 | 验收 |
|---|---|---|---|---|---|---|
| P0-1 | `plan.members[]` 补 `executionPrompt` | 上游 #352 | bug | S | 低 | 传该字段后 `resolveTeamProfile` 返回值含它；1 条回归 |
| P0-2 | `requireStagedTeam` 错误文案按工具区分 | 上游 #348 | 文案 | S | 无 | 运行中团队调 `add_member` 不再报"整队上锁" |
| P0-3 | 派单期写范围准入闸 | team-bots | 能力 | M | 中低 | 两成员 inScope 重叠时 `reassign_task` 拒绝或串行（现仅在 `create_task` 校验，`edit_plan` 于 `src/tools.ts:992` 复验，派单路径不查） |
| P0-4 | 任务改写 `expected_revision` 乐观锁 | team-bots | 竞态 | S | 低 | 陈旧 revision 的 `amend_task` 被拒 |
| P0-5 | 消息 `idempotencyKey` + 反乒乓上限 | limuyang2 / cross-session | 竞态 | S | 低 | 重复投递去重；A↔B 互刷超限被拒 |
| P1-1 | 平台 optional 包 cohort 校验 | 上游 `2ee0409` | CI | S | 低 | 新增用例断言 `skipped[].reason === 'optional-platform'`（现有 platform 测试今天已通过、只覆盖 `linkDirectory`，不能当验收） |
| P1-2 | `publish.yml` consumer-resolution 守卫 | 上游 `1f1977b` | CI | S | 低 | job 带 `if: !cancelled() && needs.publish.result == 'success'` |
| P1-3 | `ownEvents()` 改范围读 | 上游 #356 | 性能 | M | 中 | 长会话下不再整份日志读取，改用 `snapshotEvents(SessionLogOffset(from))` |
| P1-4 | 专家目录导入（`plugin.json + agents/*.md`） | experts-management | 能力 | S/M | 低 | 导入后能生成 `AgentPresetV1` |
| P2 | token/成本计量、preset 召唤手势、只读免核验 | 多家 | 设计 | L/S/S | 中 | 先出 RFC；与 backlog `#317`（token-neutral 决议）、`#223`/`#315` 重叠，立项时合并引用 |

## 2. 上游 v0.1.30：为什么"没什么可合并"

区间 `v0.1.29..upstream/main`（本地 `upstream/main` = `4354b0f`）共 5 个提交，23 文件 +1198/-242，其中约 494 变化行是构建产物（`lib/*.js`，+306/−188）。

| 上游声称（release-notes/v0.1.30.md） | 本线证据 | 结论 |
|---|---|---|
| 恢复 `0.2.2-rc.2` 激活（旧的 host 投递入口被移除） | `src/harness-compat.ts:203-225`：识别 rc.2 退役 `deliverPrompt` 符号，回退 `manager.deliverPrompt(...)` | 已实现 |
| 成员创建/排队分配/步边界消息/冷恢复适配 | `src/harness-compat.ts` + `29d1364`/`8e737dc` 两轮 rc 适配 | 已实现 |
| 停成员只清该分支+后代，退役成员模型/网页都唤不醒 | `src/harness-compat.ts:482-542` `NOT_RESUMABLE` 守卫 + `src/members.ts:1442 installRetiredMemberGuard` | 已实现且更严 |
| 成员已回报后不再二次唤醒队长 | `src/mailbox.ts` `isFinalReportForSettlement()` + `FINAL_REPORT_GRACE_MS` | 已实现（路径不同） |

**不跟随**：上游把 `compatibility.json` 的 recommended 回退到 `0.2.1-rc.2`；上游 `verify` 聚合脚本比本线少 20+ 个子验证。

**可搬的两处**（在上游 `up-v0.1.30` 提交集内，release note 未提）：
- `2ee0409`：`scripts/harness-runtime-cohort.mjs` 的 `inspectRuntimeCohort()` 按 `os`/`cpu` 约束把其他平台的 optional 包归入 `skipped[{reason:'optional-platform'}]`，避免 macOS/arm64 上 `Missing host package` 误报。本线 `grep optional-platform scripts/harness-runtime*.mjs` 无命中。
- `1f1977b`：`.github/workflows/publish.yml:164-168` 的 `consumer-resolution` 缺 `if: ${{ !cancelled() && needs.publish.result == 'success' }}`。

## 3. 上游 issues：本线真正要修的 3 条

| issue | 诉求 | 本线现状（已核） | 动作 |
|---|---|---|---|
| **#352** | `plan.members[]` 的 `executionPrompt` 被静默丢弃 | schema `src/tools.ts:1202-1208` 是 `additionalProperties:false` 且无该字段；消费端 `src/tools.ts:3689` 却读 `member.executionPrompt` → 传了必丢 | 加 1 行属性 + 1 条回归 |
| **#348** | 运行中团队的"整队上锁"文案误导 | `requireStagedTeam` 仅被 `src/tools.ts:879/1073/1120/1144/1160` 调用，`add_member`/`create_task`/`reassign_task` 不经过 | 文案按工具命名 |
| **#356** | `ownEvents()` 无界读整份会话日志 | `src/harness-compat.ts:348-351` 直接全量返回；本线已有正确范式 `src/scheduler.ts:1153-1155` `snapshotEvents(SessionLogOffset(from))` | 改调用点为范围读 |

其余 32 条：P1 三条（#350 失败与限流混同、#333 归档态暴露）、P2 六条（#358 持久化档案、#331 fork 建队、#244 MCP、#223 删除按钮、#317/#96 token 与工具面），不建议 24 条（20 条本线已实现）。

## 4. 竞品：值得借鉴的 3 个 + 明确不借鉴的

**值得借鉴**

1. **派单期写范围准入闸**（team-bots）—— 把"创建时不冲突"升级为"运行时真并行"。我们已有 `inScopeOverlap`（`src/quality-gates.ts:348`）、`WRITE_KINDS`（`:38`），但只在 `create_task` 阶段校验，`reassign_task` 派单路径（`src/scheduler.ts:1595-1626`）完全不查。成本 M。
2. **`expected_revision` + `idempotencyKey`**（team-bots + limuyang2）—— 补齐 `attemptId` 盖不住的两类竞态：读旧改新、重复投递。`src/types.ts` 目前两者都没有（已 grep 确认）。成本 S。
3. **专家目录导入**（experts-management）—— `plugin.json + agents/*.md + skills/ + avatars/` 已是事实格式；本线 `src/agent-library.ts` 只有私有 `presets.json`。成本 S/M。召唤手势 `/preset-名称` 需先验证宿主 rc.3 是否支持 `userInvocable`（未验证，别先立项）。

**明确不借鉴**：成员=独立 root 会话（limuyang2，会推翻 attempt/lineage/lane，代价 L）、跨 root 会话喊话（cross-session，打穿"一队长一团队"约束且 0★ 无测试）、Director 规划器（team-group，与 captain 重复且每轮一次模型调用违反 token-neutral）、群聊/渠道/SQLite（team-bots 产品面不同）、22 包工作台（dsh-web，1.5 GB）。

## 5. 建议排期

1. **本周（P0-1、P0-2）**：两个 S 级 bug/文案，各 0.5 天，独立可验证。
2. **下周（P1-1、P1-2）**：两处上游工程修复，0.5 天，纯 CI/脚本，不碰 `src/`。
3. **之后（P0-3/4/5）**：写范围准入闸 + 两个小锁，2–3 天，需先定"重叠即拒绝还是串行"的产品口径。
4. **P1-3（#356）** 单独排 1–1.5 天，4 个调用点逐一改（分报告口径：至少 3 处必须改）。

## 6. 未验证项

- 上游是否有 `v0.1.31+`：本地上游 tag 到 `up-v0.1.30`（`git tag --contains` 确认 `78e24f9`/`1f1977b`/`2ee0409` 都在其中，即这两处修复严格在 0.1.30 之内）；本 fork 的 `v0.1.30`–`v0.1.33` 是本线自己的发布 tag。`git fetch upstream --tags` 因到 github.com 连接超时（端口 443，75s）失败，上游更高版本无法确认。
- GitHub 匿名配额耗尽：issues 的 open 第 3–4 页、closed 10-02→10-26 段未取到（见 issues 分报告 §0）。
- dsh-web（10451★）仅文档级验证，源码未读。
- 宿主 `0.2.2-rc.3` 对 `modelInvocable:false / userInvocable:true` 的组合支持性未探测。
