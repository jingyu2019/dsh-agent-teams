# 需求总清单（2026-11-17 复核）

范围：`docs/prd/PRD-agent-teams-2026-11-16.md` 的 15 项需求 + 2026-11-17 新增的 `freshContext`。
基线：`4dbadab^`（M1 开工前）→ HEAD `f30ec3d`，共 19 个提交。
复核方式：每条给「行为 / 代码落点（当前 HEAD 行号）/ 提交 / 可复跑命令」；行号会随编辑漂移，以符号名为准（`git grep -n <符号>`）。

结论：**16 项中 15 项已交付并有用例，1 项未开始**（`/expert-name` 零 token 手势，依赖宿主 `userInvocable`，本仓库无探测代码）。

---

## M1 · 失败恢复与派发可诊断性

### R1 成员永不放行：activation 租约泄漏
- 行为：`reassign_task` / `retire` 等撤销路径停止成员激活时，必须带 `stateRoot` 与 `teamId` 调用，否则 `releaseActivationPermitsForDrainedMembers` 永不执行，activation 租约永久占用 → 成员永不 idle → 改路由、发消息、重置全部被拒。
- 落点：`src/tools.ts:828` `stopTeamMemberActivations`（签名 `(ctx, captain, members, signal?, stateRoot?, teamId?)`）；修复点 `src/tools.ts:1193`（此前只传 3 参）；放行逻辑 `src/state.ts:287` `releaseActivationPermitsForDrainedMembers`。
- 提交：`4dbadab`。
- 复跑：`npm run verify:member-spawn-recovery`。

### R2 retired 成员与「无会话」不可混为一谈
- 行为：向成员投递失败时，先查 retired 集合决定文案——retired 的成员说退役、无会话的成员说无会话；退役成员不再被自动拉起。
- 落点：`src/state.ts:476/483` `readRetiredMemberIdsSync` / `readRetiredMemberIds`；判定 `src/capabilities.ts:72`；文案纯函数 `src/tools.ts` `retiredMemberDeliveryFailure` / `lostSessionDeliveryFailure`。
- 提交：`4dbadab`。
- 复跑：`npm run verify:m1-dispatch-diagnostics`。

### R5 启动失败熔断
- 行为：同一成员连续启动失败达阈值（默认 3，`AGENT_TEAMS_MEMBER_SPAWN_FAILURE_LIMIT` 可覆盖，非法值回落 3）后暂停派发，`agent_teams_status` 暴露 `spawn_failures` 与最后一次 `spawn_error`。
- 落点：`src/types.ts` `TeamMember.spawnFailures?`；`src/tools.ts:462` `memberSpawnFailureLimit`、`:472` `memberDispatchPaused`、`:530` `startedSessionEvidence`（只有真实会话证据才算「已启动」，保留 child id 不算）、`:1105` 计数入口。
- 提交：`4dbadab`（首版）、`0ed40c2`（修真实派发路径不可达——`src/scheduler.ts:876` 先写保留 child id 导致判据恒真）。
- 复跑：`npm run verify:m1-dispatch-diagnostics`、`npm run verify:m1-dispatch-wiring`。

### P0-1 plan.members[] 的 executionPrompt 被静默丢弃
- 行为：内联 `plan.members[]` 条目接受并保留 `executionPrompt`（schema `additionalProperties: false`，过去缺该键会被丢弃，而消费端读它）。
- 落点：`src/tools.ts:564` `export const planMemberSchema`；用于 `src/tools.ts:1650` `members.items`。
- 提交：`4dbadab`（补字段）、`f99c838`（抽常量 + 用例）。
- 复跑：`npm run verify:m1-plan-member-schema`。

### P0-2 「整队被锁」文案与真实阶段不符
- 行为：`requireStagedTeam` 按操作给出具体原因（editing this plan / approving a plan / continuing staged planning / awaiting plan feedback / discarding a plan），不再一律说整队锁定。
- 落点：`src/tools.ts:543` `requireStagedTeam`；调用点 `:1213`、`:1414`、`:1461`、`:1485`、`:1501`。
- 提交：`4dbadab`。
- 复跑：`npm run verify:m1-dispatch-diagnostics`。

---

## M2 · 调度与运行时契约

### P0-3 派发期写域准入（重叠 inScope 串行化）
- 行为：已 claimed/in-progress 的写任务（implementation | repair）占住的 `inScope` 若与 ready 任务的 `inScope` 重叠，则本轮不派发、不消耗 attempt、成员回 idle，占域任务结束后重试。
- 落点：`src/quality-gates.ts:401` `writeScopeConflict`（复用 `inScopeOverlap`）；`src/scheduler.ts:1647` 调用（位于 `nextReadyTask` 之后、`beginTaskAttempt` 之前）。
- 提交：`754e5c7`、用例 `fa0a5e3`。
- 复跑：`npm run verify:dispatch-write-scope`。

### P0-4 任务改写乐观锁
- 行为：任务从 `revision = 1` 起，每次契约/状态/负责人改写 +1；`update_task`、`reassign_task`、`edit_plan` 的 update 操作接受 `expected_revision`，过期即拒并报当前修订号；省略保持旧的无条件行为。旧记录读作 1 但**不落盘伪造字段**（否则审计误报漂移）。
- 落点：`src/task-revision.ts`（`taskRevision` / `bumpTaskRevision` / `expectedRevisionError:28` / `isExpectedRevision`）；入口 `src/tools.ts:1280`（edit_plan）、`:2912`（reassign）、`:3222`（update）；`src/types.ts:284` `revision?: number`。
- 提交：`5fbf693`。
- 复跑：`npm run verify:p0-4-task-revision`。

### P1-3 会话事件读取有界化
- 行为：不再整本读会话日志；现代宿主按 `snapshotEvents(SessionLogOffset(start), SessionLogOffset(end))` 取窗口，旧宿主回落物化数组切窗；邮件判定改 tail 窗口 + `decided` 语义（截断且未定论按进行中处理）。
- 落点：`src/harness-compat.ts:380` `sessionOwnEventWindow`（`OWN_EVENT_READ_LIMIT = 256`）；调用 `src/mailbox.ts:219`（tail）、`src/scheduler.ts:404`（token 尾窗）、`src/members.ts` 描述符（head）。
- 提交：`f72ecd0`。
- 复跑：`npm run verify:harness-contract`、`node scripts/harness-compat-tdd.mjs`。

### R3 运行中成员改模型/推理档
- 行为：running 团队的成员可在任务之间改 provider/model/reasoning；拒绝时说明缺哪一条件（团队必须 running、成员 idle 且无 open attempt、无活跃 turn）。工具与 Web 面板共用同一实现。
- 落点：`src/tools.ts:1532` `updateMemberRoute`（工具入口 `:2641`）；HTTP `src/index.ts:859`（`POST /plugins/dsh-agent-teams/member-route`，path `:821`）；客户端 `src/client/ActivityPanel.tsx:497` `MemberRouteControl`，复用 `src/client/StagingPlanEditor.tsx:114` `StagedModelPicker`。
- 提交：`1f25bab`、`429f570`（lib + 挂链）、`e17185f`（补测试桩导出）。
- 复跑：`npm run verify:member-route-control`。

### P1-1 运行时队列的跨平台可选包
- 行为：lock 中属于其他 `os`/`cpu` 的可选宿主包归入 `skipped[{reason:'optional-platform'}]`，不再当成缺包报错；非可选缺包、版本不符、无安装仍分别抛错。
- 落点：`scripts/harness-runtime-cohort.mjs:15` `inspectRuntimeCohort`；消费 `scripts/harness-runtime-verify.mjs:114`。
- 提交：`f72ecd0`。
- 复跑：`npm run verify:harness-contract`、`node --test scripts/harness-runtime-platform.test.mjs`。

### P1-2 发布 workflow 的 consumer-resolution 门
- 行为：`consumer-resolution` 仅在 `publish` 成功且未取消时运行，避免发布失败仍去扫消费者。
- 落点：`.github/workflows/publish.yml:166` `if: ${{ !cancelled() && needs.publish.result == 'success' }}`。
- 提交：`f72ecd0`。
- 复跑：`npm run verify:release`（脚本存在性+job 结构；真实 CI 未在本机跑）。

---

## M3 · 专家目录、消息闸、只读交付、死会话

### P1-4 专家目录导入导出与按名解析
- 行为：`agent_teams_agent_catalog` 的 import / export / resolve 三动作；目录约定 `agents/<name>/{plugin.json, instructions.md, skills/, avatars/}` 或单 JSON（对象 / 数组 / `{schemaVersion:1, presets:[...]}`）；报告 conflicts / warnings / skipped / unchanged，不半途导入；不执行被导入内容；拒绝 `..`、绝对路径、盘符、UNC。
- 落点：`src/agent-library.ts:418` `importAgentCatalog`（同文件 `exportAgentCatalog` / `resolvePresetByName` / `resolveAgentPresetByName`）；工具入口 `src/tools.ts:2251`；工具名 `src/tool-names.ts:9`。
- 提交：`4d801de`、`f3b048b`（lib + 挂链）。
- 复跑：`npm run verify:p1-4-agent-catalog`。

### P0-5 消息幂等键 + 反乒乓
- 行为：`send_message` 接受 `idempotency_key`，同一 from→to→key 24 小时内重放返回 `delivered:'duplicate'` 并回带首次 `messageId`，不写新邮件（每团队最多保留 512 键）；同一对成员 10 分钟内超过 12 条判为 ping-pong 并拒投（`AGENT_TEAMS_PINGPONG_MESSAGE_LIMIT` 可抬）。按内容去重的旧路径保留。
- 落点：`src/tools.ts:1050` `findMessageKey`、`:3551` 重放分支；`src/types.ts` `TeamState.messageKeys`。
- 提交：`ece6be4`、`63a65e4`（lib + 挂链）。
- 复跑：`npm run verify:p0-5-idempotency`。

### P2 只读交付免核验 + 成员 token 计量
- 行为：三条同时成立才免核验——有已完成交付物、`changedPaths` 全空、存在未结束的 verification；只 continue 命中的 verification，豁免写入 `DeliveryResult.exemptions` + warnings 并带证据。`agent_teams_status` 报每成员 token 用量，取不到报 `unavailable` 而不是 0，**只报数不设门**。
- 落点：`src/quality-gates.ts:1703` `readOnlyDeliveryExemption`、`:1738` 调用；`src/scheduler.ts:391` `memberTokenUsage`（尾窗 2000 事件）；`src/tools.ts:3828` 状态渲染。
- 提交：`9120b17`。
- 复跑：`npm run verify:p2-readonly-token`。

### R4 死会话派发自动重置后重投一次
- 行为：投递因成员会话消失而失败时，自动重置该成员上下文并重投一次；仍失败才报错。retired 成员不自动重置；重置走既有守卫；重置在 timeline 留痕。
- 落点：`src/tools.ts:368` `resetMemberContextLocked`（工具入口 `:1903`）；`src/tools.ts:431` `recoverLostSessionDelivery`、`:1165` 调用；`deliveryCause: 'retired' | 'lost-session'`。
- 提交：`784d978`。
- 复跑：`npm run verify:r4-auto-reset`。

### `/expert-name` 零 token 手势 — **未开始**
- 现状：`src/` 无任何 `userInvocable` 探测或斜杠手势注册代码；`importAgentCatalog` 只解决「装得进来」，不解决「零 token 召唤」。
- 阻塞：需要宿主提供 userInvocable skill/preset 注册能力；未验证 `0.2.2-rc.3` 是否有该接口。
- 结论：本分支不具备落地条件，不做猜测实现。

---

## 追加需求（不在原 PRD）

### freshContext 任务级新会话
- 行为：任务可要求「派发前退休成员旧子会话」，保留 roster 行、route、skills、tool policy、worktree lane；成员不满足安全条件时**保旧会话并记原因**，不静默换。5 条拒绝原因：`member has no session yet` / `member is working` / `member is stopping` / `member owns another open attempt` / `member has an active activation`。
- 落点：`src/types.ts:182` `TeamTask.freshContext?`；`src/members.ts:1471` `freshContextEligibility`、`:1502` `resetMemberContextForDispatch`；`src/scheduler.ts:1661` 派发前调用；`src/tools.ts` `create_task.fresh_context` / `edit_plan.fresh_context`。
- 提交：`f30ec3d`；设计文档 `docs/design/member-fresh-context.md`。
- 复跑：`npm run verify:fresh-context`。

---

## 已知不一致与遗留

1. `expected_revision` 可选 → 老调用方不获保护（PRD 明确要求「省略保持旧行为」，属设计取舍，非遗漏）。
2. token 计量与 upstream #317 的 token-neutral 决议存在潜在冲突（我们只报数不设门，风险可控）。
3. 用户已否掉 token 预算门（m01296），本清单不含该需求。
4. `npm run verify` 整链依赖 pnpm，本机无 pnpm，只能逐项跑 `verify:*`。