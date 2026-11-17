# 需求总清单·状态复核（2026-11-17）

**为什么有这份文件**：`docs/requirements/requirements-inventory-2026-11-17.md` 在我本轮作业期间已被另一成员写完并在 `3137303` 提交（HEAD）。我不覆盖它（并发覆盖会把已提交的成果冲掉），改为把**逐条复核结论、改判、缺口证据**写在这里；两份合起来才满足 t13 的契约：那份给行为/落点/提交，这份给**状态判定 + 用例数 + 不一致清单 + 验证边界**。

- 基线：HEAD `3137303`；本文所有 `file:line` 都在该 HEAD 用 `git grep -n` 复核过（行号会漂移，符号名为准）。
- 实测：本文涉及的 12 个回归脚本本轮实跑 **87 用例，87 通过，0 失败**；`node scripts/git-artifacts.mjs` 通过。
- 结论一句话：**16 项里 7 项可判"已交付"，8 项"部分"，1 项"未开始"**。已提交清单写的"15 项已交付、1 项未开始"不成立，差在 §2 的 9 处（其中 3 处是行为达成但验收/字段口径与 PRD 不同，6 处是 PRD 要求的东西确实没做）。

## §1 状态表（18 行 = 16 项需求，P2 拆三点）

| 编号 | 承诺行为（一句） | 代码落点 · 提交 | 用例证据（脚本 · 数 · 命令） | 状态 |
|---|---|---|---|---|
| R1 | 派发失败清扫 activation 租约、成员回 idle、有上限重试 | `src/tools.ts:843` 补参调用、`:1193` catch 六参调用；`src/state.ts:291` · `4dbadab` | 无本项专属用例；租约回滚只在崩溃重启路径：`scripts/issue-308.test.mjs`（12 例） | 部分 |
| R2 | `NOT_RESUMABLE` 分因："已退休" vs "从未启动" | `src/tools.ts:490`/`:495` 两句文案、`:530` `startedSessionEvidence`、`:1133` 判定 · `4dbadab`+`0ed40c2`；宿主单码仍在 `src/harness-compat.ts:567` | `scripts/m1-dispatch-wiring.test.mjs`（7）+ `scripts/m1-dispatch-diagnostics.test.mjs`（16） | 部分 |
| R5 | 连续 N 次失败熔断 + 记录原因（默认 3） | `src/tools.ts:462`、`:472`、`:1107` 计数、`:1126` 暂停、`:1155` 清零、`:3854` `spawn_failures` · `4dbadab`+`0ed40c2` | `scripts/m1-dispatch-diagnostics.test.mjs`（16，5 例属本项）+ `scripts/m1-dispatch-wiring.test.mjs`（7，1 例） | 部分 |
| P0-1 | `plan.members[]` 补 `executionPrompt`，schema 仍闭合 | `src/tools.ts:568` `planMemberSchema`、`:571` 字段 · `4dbadab`（`f99c838` 抽常量） | `scripts/m1-plan-member-schema.test.mjs`（3） | 部分 |
| P0-2 | `requireStagedTeam` 文案按操作区分 | `src/tools.ts:543`；调用点 `:1213`/`:1414`/`:1461`/`:1485`/`:1501` · `4dbadab` | `scripts/m1-dispatch-wiring.test.mjs`（7）+ `m1-dispatch-diagnostics`（3 例） | 已交付 |
| P0-3 | 派发前 inScope 重叠准入，命中不派发不产生 attempt | `src/quality-gates.ts:401` `writeScopeConflict`；`src/scheduler.ts:1647` · `754e5c7`（用例 `fa0a5e3`） | `scripts/dispatch-write-scope.test.mjs`（5） | 部分 |
| P0-4 | 改写走 `expected_revision` 乐观锁 | `src/task-revision.ts:5`/`:17`/`:28`/`:36`；`src/tools.ts:2351`/`:2878`/`:3129`；`src/types.ts:284` · `5fbf693` | `scripts/p0-4-task-revision.test.mjs`（7） | 部分 |
| P1-3 | 会话事件有界窗口读 | `src/harness-compat.ts:352` `OWN_EVENT_READ_LIMIT=256`、`:380` `sessionOwnEventWindow`、`:414`；调用 `src/mailbox.ts:219`、`src/members.ts:891`/`:1120`/`:1551`、`src/scheduler.ts:404` · `f72ecd0` | `scripts/harness-compat-tdd.mjs`（assert 脚本，退出码 0） | 已交付 |
| R3 | 运行中成员可改 provider/model/reasoning，拒绝可解释 | `src/tools.ts:222`/`:1532`/`:2641`；`src/index.ts:821`/`:859`；`src/client/ActivityPanel.tsx:497` · `1f25bab`+`429f570`+`e17185f` | `scripts/member-route-control.test.mjs`（6） | 已交付 |
| P1-1 | 跨平台 optional 包归 `skipped[reason='optional-platform']` | `scripts/harness-runtime-cohort.mjs:15`/`:24`；`scripts/harness-runtime-verify.mjs:114` · `f72ecd0` | `scripts/harness-runtime-platform.test.mjs`（3；**只在 CI 跑**：`verify.yml:57`/`:106`） | 部分 |
| P1-2 | `consumer-resolution` 加 `if` 门 | `.github/workflows/publish.yml:166` · `f72ecd0`（+1 行） | 无解析用例（`grep -rn consumer-resolution scripts/` 零命中） | 部分 |
| P1-4 | 专家目录导入导出 + 按名解析 | `src/agent-library.ts:114-115`/`:418`/`:478`/`:524`/`:225-234` avatar 引用；`src/tool-names.ts:9`、`src/tools.ts:2191`/`:2251`/`:2267` · `4d801de`+`f3b048b` | `scripts/p1-4-agent-catalog.test.mjs`（6） | 部分 |
| P0-5 | 消息幂等键 + 反乒乓上限 | `src/tools.ts:1019`/`:1021`/`:1027`/`:1036-1037`（默认 12）/`:1067`/`:3482`/`:3547` · `ece6be4`+`63a65e4` | `scripts/p0-5-idempotency.test.mjs`（5） | 已交付 |
| P2-a | 只读交付免 verification 门并留痕 | `src/quality-gates.ts:1703`；`src/tools.ts:3908` · `9120b17` | `scripts/p2-readonly-delivery-token-metering.test.mjs`（10，6 例属本项） | 已交付 |
| P2-b | 成员 token 用量可读，取不到报 unavailable | `src/scheduler.ts:342`（窗口 2000）、`:391`；`src/tools.ts:3850` · `9120b17` | 同上（4 例） | 已交付 |
| P2-c | `/expert-name` 零 token 召唤 | 无（`userInvocable`/`modelInvocable`/`expert-name` 全零命中） | 无 | 未开始 |
| R4 | 死会话投递自动 reset 后重投一次 | `src/tools.ts:408`/`:433`/`:1170-1192`；`src/members.ts:1525`/`:1538` · `784d978` | `scripts/r4-dead-session-recovery.test.mjs`（7） | 已交付 |
| freshContext | 单任务要求干净上下文，宿主不猜 | `src/types.ts:182`；`src/members.ts:1471`；`src/scheduler.ts:1657-1660`；`src/tools.ts:176`/`:2426`/`:2845` · `f30ec3d` | `scripts/fresh-context.test.mjs`（5） | 已交付 |

按 16 项计：**已交付 7**（P0-2、P1-3、R3、P0-5、P2、R4、freshContext）· **部分 8**（R1、R2、R5、P0-1、P0-3、P0-4、P1-1、P1-2、P1-4 中的 8 项）· **未开始 1**（P2-c）。

## §2 九处"已交付 → 部分"的证据

1. **R1**：`git grep -n "reconcileStaleActivationLeases" -- src` **零命中**。PRD 方案要点 2/3（TTL 清扫 + kick 前调用 + 每次最多重试 2 次）未实现，只补了参传。PRD 验收 ①②（构造 pending 租约 → `permitHeld===false`；16 次拒绝后第 17 次能重新分配）**无对应用例**。
2. **R2**：新码 `NOT_STARTED` 未实现，宿主唯一抛点仍是 `src/harness-compat.ts:567` 的 `NOT_RESUMABLE`；插件改在**消息层**分因。PRD 验收 ②③ 未达成（属口径变更，Part B 已承认需宿主白名单）。
3. **R5**：未加 `dispatchFailure{count,lastError,code,lastFailureAt}`、未置 `status='blocked'`、status 输出是 `spawn_failures` 而非 `dispatch_failure.last_error`。验收 ① ② 按字面不成立；③ 的"attempt 不再 1→16"行为达成（暂停后不再派发）。
4. **P0-1**：验收 ④ `docs/tool-surface-budget.json` 未重算（最后改动 `af1f71c`，早于 `4dbadab`）。`node --test scripts/tool-surface-budget.test.mjs` 仍 2/2 绿 = 只是没记账、未超限。
5. **P0-3**：验收 ④ 与方案要点 3/4 未做 —— `reassign_task` 未接 `writeScopeConflict`（全仓只有 `src/quality-gates.ts:401` 与 `src/scheduler.ts:1647` 两处）；防饥饿未实现；`member_lane` 未放行。
6. **P0-4**：`agent_teams_amend_task`（`src/tools.ts:3389`，参数表 `:3392-3403`）**没有 `expected_revision`** —— 而 PRD 的问题陈述正是"两次 amend 之间被第三方改写"。锁只覆盖 update_task/reassign_task/edit_plan.update_task；验收 ④（并发两次 amend 第二次被拒）无用例。
7. **P1-1**：`grep -rn optional-platform scripts/*.mjs` 只命中生产文件 `harness-runtime-cohort.mjs:24`，**没有任何测试断言 `reason === 'optional-platform'`**；PRD 要求新建的 `scripts/harness-runtime-cohort.test.mjs` 不存在（用例并入 `harness-runtime-platform.test.mjs`，而 PRD 明令该文件不得当本卡验收）；且该脚本不在本地 `pnpm verify` 链，只在 CI 跑。
8. **P1-2**：无任何解析 workflow 的用例（`grep -rn consumer-resolution scripts/` 零命中）；验收①无自动化证据，②（失败运行截图）不可本地获得。
9. **P1-4**：实际目录约定是 `agents/<name>/plugin.json + instructions.md + skills/`，avatar 是 plugin.json 里一个**引用字段**（`src/agent-library.ts:225-234`：托管二进制不可移植，只复制引用），没有 `agents/*.md` frontmatter 解析、没有独立 `avatars/` 目录扫描、没有 PRD 要求的 `scripts/import-experts.mjs` CLI（改工具入口）。

## §3 已提交清单里的事实性问题（3 条）

1. **"15 项已交付"的结论不成立**，差在 §2 的 9 处；其中 6 处是 PRD 明确要求而未做，不是"口径不同"。
2. **P1-2 的"复跑：`npm run verify:release`（脚本存在性 + job 结构）"是错的**：`verify:release` 跑的是 `scripts/release-metadata.test.mjs`，该文件对 `consumer-resolution` / `publish.yml` **0 处提及**（已 grep 证实），证明不了这个门。正确复跑只有 `git show f72ecd0 -- .github/workflows/publish.yml`。
3. **P1-4 的 `avatars/` 目录**描述与代码不符：avatar 是 `plugin.json` 的一个引用字段，导入时原样复制引用并 warn"托管二进制不可移植"，没有目录扫描逻辑。

另外，已提交清单**缺 t13 要求的两项硬内容**：① 每条的"用例数 + 可复跑命令"（只给了命令、没给数）；② 状态列/汇总表（结论只在开头一句话里）。

## §4 与 PRD 的不一致（15 条）

类型：`代码未做` / `口径变更` / `PRD 滞后` / **`代码违反 PRD 约束`**。

| # | 类型 | 条目 | 事实 | 建议 |
|---|---|---|---|---|
| I1 | 代码未做 | P0-3 验收④ + 要点3/4 | `reassign_task` 未接准入；防饥饿缺；`member_lane` 未放行 | 补 reassign 拒绝（含两 task id）与 lane 放行；防饥饿需产品裁定 |
| I2 | 代码未做 | P0-4 主落点 | `amend_task` 无 `expected_revision`（`src/tools.ts:3389-3403`） | 补参数（锁内、写盘前）+ 并发用例 |
| I3 | 代码未做 | P0-1 验收④ | `docs/tool-surface-budget.json` 未重算 | 重算并提交 |
| I4 | 代码未做 | R1 要点2/3 | 无 `reconcileStaleActivationLeases`、无 TTL 清扫 | 实现（`createdAt+TTL` 且 registry 非 running，默认 30s）+ 验收①② |
| I5 | 口径变更 | R2 验收②③ | 无 `NOT_STARTED`；改在消息层分因 | 改 PRD 口径；宿主放码另立事项 |
| I6 | 口径变更 | R5 验收①② | 复用 `spawnError`/`spawnFailures`，无 blocked 状态 | 要么补字段/状态，要么改 PRD |
| I7 | 口径变更 | P1-3 验收①② | `from` 位移语义被 head/tail + `complete` 取代 | 改 PRD 断言为窗口语义 |
| I8 | 代码未做 | P1-1 验收①④ | 无严格 reason 断言、无独立用例文件、本地链不含 | 补断言；PRD 记录"并入"决定 |
| I9 | 代码未做 | P1-2 验收① | 无 workflow 解析用例 | 加 YAML 文本断言（含 `!cancelled()` 与 `needs.publish.result == 'success'`） |
| I10 | 口径变更 | P1-4 要点1/4 | 格式/CLI 与 PRD 不同 | PRD 记录格式裁定 |
| I11 | 口径变更 | P0-5 要点1/3 | key 落 `team.messageKeys` 账本；默认 12；env 而非 zod config | 记录裁定；PRD 阈值改 12 |
| I12 | **代码违反 PRD 约束** | P2-a 要点4 | PRD 硬约束："必须以**不可伪造的 host effective sandbox** 为依据，否则维持固定质量链（宁可慢，不可放闸）"；实现依据是**成员自报的 `changedPaths`**（`src/quality-gates.ts:1703`），少报路径即可换跳核验 | ① 补不可伪造依据（sandbox / 实际 diff 交集）；或 ② 修订 PRD 并把该条降级为"可见留痕"，同时承认可伪造性。**不应静默** |
| I13 | PRD 滞后 | P2 整卡 | PRD 写"只出 RFC、不合入实现"，实际 P2-a/P2-b 已进代码并挂 verify 链 | 更新 PRD 状态 |
| I14 | PRD 滞后 | freshContext | PRD §3 仍 15 行，无此项 | PRD 增补一行（M3） |
| I15 | 依赖缺口 | R3 验收③ | "R1 生效后 429 成员可在面板改路由"不可证：R1 的 TTL 清扫缺失（I4），无真实 429 复现 | 随 I4 补；在此之前 R3 只在 runtime/tool 层被证明 |

## §5 未覆盖的验证边界

1. **全部证据是单元/夹具级**：无真实宿主端到端。真实 429、真实 `subagent/start` 失败、真实面板点击均无运行期证据 → R3 验收③、R1 验收②、R2 验收③ 落在这条边界外。
2. **`pnpm verify` 整链本机跑不完，真实原因**：链中 `scripts/harness-runtime-verify.mjs` 需要一个**真实 Harness 安装路径**，无参调用直接抛错退出（实测）。已单独证明**不是**阻塞项的两段：`node scripts/git-artifacts.mjs` → "Git artifacts match source and build settings." exit 0；`node --test scripts/git-artifacts.test.mjs`（`pnpm test:git-install`）→ 6/6。
3. **CI-only 用例**：`scripts/harness-runtime-platform.test.mjs`（P1-1）只在 `.github/workflows/verify.yml:57`/`:106` 跑，本地绿≠CI 绿。
4. **P1-2 运行期行为**：跳过只会在真实失败/取消的发版 run 里体现，仓库内无该 run 的断言。
5. **P2-a 可伪造性无对抗用例**：10 例只证明"改过路径不免 / 非 verification 门不放"，没有"少报路径能否骗过豁免"的用例（实现上确实能）。
6. **P2-b 数值精度**：只对伪造 usage 验证过；真实会话窗口截断（`complete:false`）时的求和无真机核对。
7. **P0-5 误伤概率**：默认 12 条/10 分钟未在长对话团队上观测。
8. **R1/R5 长跑**：无"连续失败 16 次"的端到端场景（即 PRD R1② 记录的原始事故形态）。

## §6 本轮复跑实测（可原样复跑）

| 命令 | 用例数 | 结果 |
|---|---|---|
| `node --test scripts/dispatch-write-scope.test.mjs` | 5 | 5/5 |
| `node --test scripts/m1-dispatch-diagnostics.test.mjs` | 16 | 16/16 |
| `node --test scripts/m1-dispatch-wiring.test.mjs` | 7 | 7/7 |
| `node --test scripts/m1-plan-member-schema.test.mjs` | 3 | 3/3 |
| `node --test scripts/p0-4-task-revision.test.mjs` | 7 | 7/7 |
| `node --test scripts/p0-5-idempotency.test.mjs` | 5 | 5/5 |
| `node --test scripts/member-route-control.test.mjs` | 6 | 6/6 |
| `node --test scripts/p1-4-agent-catalog.test.mjs` | 6 | 6/6 |
| `node --test scripts/p2-readonly-delivery-token-metering.test.mjs` | 10 | 10/10 |
| `node --test scripts/r4-dead-session-recovery.test.mjs` | 7 | 7/7 |
| `node --test scripts/fresh-context.test.mjs` | 5 | 5/5 |
| `node --test scripts/member-spawn-recovery.test.mjs` | 10 | 10/10 |
| `node --test scripts/issue-308.test.mjs`（R1 相关） | 12 | 12/12 |
| `node --test scripts/harness-runtime-platform.test.mjs` | 3 | 3/3（CI-only） |
| `node --test scripts/tool-surface-budget.test.mjs` | 2 | 2/2 |
| `node --test scripts/git-artifacts.test.mjs` | 6 | 6/6 |

合计新增需求回归 **87 用例全绿**（前 12 行脚本）。