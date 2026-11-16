# Part B — 成员派发失败后的可恢复性需求（R1–R5）

**版本**：`@nanmicoder/dsh-agent-teams` 0.1.33。**范围**：插件侧止损与可执行出口；宿主侧缺陷另见末节。

**事故**：某团队 5 名成员的每一次派发都在启动瞬间失败（宿主 429 `bili_throttle_hold`）。此后三条恢复路径同时不可用：给成员发消息续跑（宿主统一显示 "subagent cannot be resumed"）、给成员改模型、`reset_member_context`；期间 attempt 从 1 静默涨到 16。

## 线索核对（自行复核结果，与任务描述不一致处已标出）

| 线索 | 核对结果 |
| --- | --- |
| `members.ts` ~507 失败路径无租约清扫 | 行号一致（507 原样）。但"置回 idle"在该函数之外还有一处：`members.ts:985-991` 在 `whenIdle()` 后补写 idle。真实缺口是**租约**：catch 调 `stopTeamMemberActivations` 只传 3 个参数，`stateRoot`/`teamId` 为空，`state.ts:287` 的许可释放恒不执行。 |
| `tools.ts` 1457-1462 三道守卫 | **不一致**：实为 `1462`（working/stopping）、`1464`（未终结 attempt）、`1466-1467`（active activation）。`1444` 的工具定义行号正确。 |
| `harness-compat.ts:504` | 完全一致；语义正确，本次不改其 code 与文案。 |
| `ActivityPanel.tsx` ~1032 | 一致；只读徽标 `span` 在 `1036`，数据源为 `1001` 的 `memberRouteLabel`。 |
| `StagingPlanEditor.tsx` 89-229 | **不一致**：`StagedModelPicker` 实为 `114-349`（89 只是 `routeKey` 起点），比线索长出约 120 行。 |

## R1 失败清扫 activation 租约并把成员置回 idle（有上限重试）

**问题** 派发在启动瞬间失败后，`ActivationLease` 停在 `state='pending'`、`permitHeld=true` 且永不回收。唯一的 `rejected` 回滚只在 `task.attemptId` 仍等于该票时执行，失败的 spawn 路径根本走不到。后果：许可计数被永久占用，最终没有任何成员能再拿到 activation；成员也可能残留 `stopping`。

**证据** `src/tools.ts:856-867`（dispatch catch）、`859`（三参调用 `stopTeamMemberActivations`，缺 `stateRoot`/`teamId`）、`src/tools.ts:611-628`（该函数，`625-627` 仅在两个参数齐备时释放许可）、`src/state.ts:287-310`（`releaseActivationPermitsForDrainedMembers`）、`src/scheduler.ts:1654`+`1677-1682`（唯一租约回滚的前置与执行）、`src/scheduler.ts:1570`（置 working）、`1693`（置 idle）、`120-126`（许可计数）、`1476`（准入判断）。

**方案要点**
1. `src/tools.ts:859` 补传 `root`、`teamId`，使 `releaseActivationPermitsForDrainedMembers` 真正执行。
2. 在 `src/scheduler.ts` 新增 `reconcileStaleActivationLeases(stateRoot, teamId, now)`：对 `permitHeld===true && state∈{pending,started}` 且 `ctx.agents.get(memberId)` 非 `running` 且 `createdAt < now - leaseTtlMs` 的租约，执行 `state='rejected'`、`recoveryDecision='rolled_back'`、`permitHeld=false`、`releasedAt=now`；若 `task.attemptActivationId` 命中则复用 `1670-1675` 回滚分支，并 `member.status='idle'`、`delete member.stopping`。
3. 在 `kickMember` 取容量（`1476`）之前调用一次；每次清扫最多重试 2 次（fake clock 可测），超限写一条 durable notice 后停手，不循环。

**验收标准** ① 单测：构造 `pending` 租约 + 无 live agent，调用后 `permitHeld===false`、`state==='rejected'`、`member.status==='idle'`、`activePermitCount===0`。② 集成：mock dispatch 连续 16 次拒绝后，第 17 次能重新分配租约（`activationSeq` 继续增长，而非卡在容量上限）。③ 守卫解除：R1 生效后 `tools.ts:1466` 不再命中。

**成本** 0.5–1 人日（含 fake-clock 测试）。

**风险** TTL 过早回收仍存活的租约会双写。用"`createdAt + TTL` 且 registry 非 running"双条件收敛，`leaseTtlMs` 默认 30s 且可配。

**依赖** 与上游 **issue #350「限流与任务失败混为一谈」** 直接相关，**建议把 #350 升级并入 R1**：#350 未修时 429 被当作可重试的空转信号，R1 的 TTL 清扫是唯一止损手段。

## R2 `NOT_RESUMABLE` 分码："已退休" vs "从未启动"

**问题** 派发失败时，若 child id 已被分配（managed 宿主在 `allocateActivation` 阶段就写入 `member.id`）但从未产生任何会话，catch 分支会把它写进退役名单；此后任何投递都被我们自己的守卫以 `NOT_RESUMABLE` 拒绝，宿主再统一显示成 "subagent cannot be resumed"。于是"我们主动退役"与"它从未启动"共用同一码，用户看不到任何出口。

**证据** `src/tools.ts:850-859`（`orphan` 赋值与 `recordRetiredMemberIds`）、`src/state.ts:62`、`462-500`（退役名单持久化）、`src/harness-compat.ts:496-506`（guard 安装）、`504`（唯一抛点）。

**方案要点** 保留 `504` 的拒绝语义与文案不变。在 `retired-members.json` 之外补记 `retiredReason: 'removed' | 'reset' | 'never_started'`；`check()` 内先判定来源：`never_started`（无 session 文件且 `hostMessageId===undefined`）抛新码 `NOT_STARTED`，文案带出口提示（"member never started; call agent_teams_reset_member_context then re-dispatch"）；`removed`/`reset` 继续抛 `NOT_RESUMABLE`。

**验收标准** ① 回归锁：`removed` 成员仍抛 `NOT_RESUMABLE`，文案逐字不变。② `never_started` 抛 `NOT_STARTED` 且 message 含 `agent_teams_reset_member_context`。③ 宿主映射后 `RemoteError.code === 'subagent/not-started'`（需末节的上报同步落地）。

**成本** 0.5 人日。

**风险** 新码未进宿主白名单会被归入 unknown，等于白做；R2 必须与末节"上报宿主"同批发布。

**依赖** 不依赖 #350；但 #350 修复后 `never_started` 分支的触发率会显著下降，故不等 #350。

## R3 运行中团队成员支持改模型/推理档（面板入口 → `update_member_route`）

**问题** 运行中成员的模型/推理档无法修改：面板只有只读徽标，而工具 `agent_teams_update_member_route` 要求"无未终结 attempt、无活跃租约、live 非 running"。R1 未修时第三条件恒真，于是工具与面板双双不可用。

**证据** `src/client/ActivityPanel.tsx:1001`、`1032-1039`（只读 `span[role=img]`）；`src/tools.ts:2109`（工具定义）、`2138-2150`（staged/halted/removed/stopping/open task/active lease/running 六道前置）；可用的选择器仅存在于 staged 路径：`src/client/StagingPlanEditor.tsx:114-349`，唯一调用点 `460`。

**方案要点** 把 `StagedModelPicker` 提取为共享 `MemberModelPicker`（继续只读 `ModelDirectory`，不触碰 captain composer）。面板把 `1036` 的 `span` 换成 `button`（`aria-haspopup="menu"`，`disabled = activity !== 'idle' || openAttempt`），选择后 POST `/plugins/dsh-agent-teams/member-route`（沿用 `src/index.ts:378` 的 `webServer.register` 模式），handler 复用 `requireCaptainTeam` + `withTeamLock`，主体下沉为 `applyMemberRoute()` 供工具与路由共调；成功后刷新 `data-member-model`。

**验收标准** ① idle 成员渲染可点按钮，running 成员 `disabled`。② 成功后 `team.json` 的 `provider/model/reasoningEffort` 变更且 `attemptId` 不变。③ R1 生效后，被 429 卡住的成员可在面板改路由（本次事故的核心出口）。

**成本** 1.5–2 人日（提取 + 路由 + 面板）。

**风险** 面板入口绕开 captain 会话鉴权；handler 必须走同一套 `requireFreshCaptainTeam` 与团队锁，不得直接改盘。

**依赖** **强依赖 R1**：租约不清扫，`2145-2149` 会一直拦住运行中成员，面板入口只是死按钮。

## R4 对死会话发消息时自动 reset 上下文后投递，或明确告知需先 reset

**问题** 对从未成功启动或会话已死的成员发消息，`deliverToMember` 吞掉异常只返回 `false`，调用方只看到 `accepted: false`；用户既不知道原因，也不知道该先 reset。

**证据** `src/members.ts:1396-1412`（try/catch 后 `return false`）、`src/tools.ts:840`、`3231`（mailbox steer 调用点）、`src/scheduler.ts:1427`。

**方案要点** `deliverToMember` 捕获 `NOT_RESUMABLE` / `NOT_STARTED` 时返回结构化结果（`{ ok:false, recoverable, code }`）而非布尔。对 `NOT_STARTED` 自动执行一次 reset 的等价状态转换（`recordRetiredMemberIds` → `id=''`、`generation++`、清 `spawnError`/`active*`、`status='idle'`）后重投，至多 1 次；对 `removed`/`reset` 不自动 reset，返回含 `agent_teams_reset_member_context` 的可执行提示。

**验收标准** ① 死会话 + 文本消息 → 自动 reset 后 `delivered ∈ {wake, mailbox}` 且 `generation` +1。② `removed` 成员不触发自动 reset，错误文本含 reset 工具名。③ 自动 reset 至多重试 1 次，无循环。

**成本** 1 人日。

**风险** 自动 reset 丢弃旧上下文；只在"从未启动"（本无上下文）时启用，并写 durable timeline。

**依赖** 依赖 R2 分码；无 R2 无法区分两种情况。

## R5 连续 N 次派发失败熔断 + 记录 `lastError`，不再静默涨 attempt

**问题** attempt 静默增长：每次 claim 都 `+1`，而失败回滚分支不递减（崩溃回滚分支却递减），也没有 `lastError`；`spawnError` 只在成员 id 仍为空时才记录，一旦 id 已分配就完全静默。

**证据** `src/state.ts:246-247`（`beginTaskAttempt`）、`src/scheduler.ts:1554`（claim 处调用）、`1670-1675`（失败回滚不递减）对比 `1265`（崩溃回滚 `Math.max(0, attempt-1)`）、`src/tools.ts:820-826`（`823` 的 `failed.id !== ''` 早退）、`824`（唯一的 spawnError 写入）。

**方案要点** `TeamMember` 增 `dispatchFailure?: { count, lastError, code, lastFailureAt }`。在 `dispatchMember` catch 内无条件写入：id 为空按 name 匹配，id 非空按 id 匹配（移除 `823` 的早退语义）。`count >= N`（默认 3、可配）时置 `status='blocked'`、写 durable notice、面板展示红色徽标并停止自动 kick；成功启动时在既有 `delete member.spawnError` 处一并清零。

**验收标准** ① 连续 3 次失败后 `status==='blocked'`、`dispatchFailure.count===3`，且不再自动重试。② `agent_teams_status` 在既有 `spawn_error` 位置输出 `dispatch_failure.last_error`（`src/tools.ts:3406`）。③ 3 次失败后 `attempt <= 3`，不再出现 1→16。

**成本** 0.5–1 人日。

**风险** 熔断误伤真实限流的短暂抖动；`N` 可配 + 保留手动 kick/resume 出口。

**依赖** 与 #350 互补：#350 修"限流不该算失败"，R5 修"失败不该静默"；两者都要，但不能互相替代。

## 不可由插件修复的部分

1. **429 出现在 member spawn 路径**：宿主把 provider 限流（`bili_throttle_hold`）当作 subagent 启动失败抛出。插件只看到一次失败，无法区分"稍后可用"与"永久不可用"，因此只能止损（R1/R2/R5），不能消除。
2. **宿主 `NOT_RESUMABLE` 映射是扁平的**：宿主自身另有三处抛点（含 "has no supported continuation state and cannot be resumed"），与插件抛点一起被映射为 `RemoteError('subagent/not-resumable')`。插件的分码必须宿主侧同步放开才在 UI 可见。
3. **无 targeted forget，也没有"从未启动"字段**：插件只能用 `retired-members.json` 自建黑名单，故 R4 的自动 reset 只能基于自建状态推断。

**上报宿主时的最少复现信息** ① 宿主版本串 + 插件 0.1.33 版本串。② 触发时刻的 provider 错误原始响应（status/headers/是否有 `retry-after`）。③ 失败前后的 `team.json`：`tasks[].attempt`、`attemptId`、`activations[]`（id 可脱敏保留前缀）。④ 宿主编排日志中同一 child id 的 spawn 段。⑤ 期望断言：同一次 429 应重试或明确标注"限流中"，不得登记为不可恢复失败。
