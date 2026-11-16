# 《上游 v0.1.30 + 同类插件：可合并/可借鉴决策报告》事实核查

> 核查对象：`docs/upstream-0.1.30-merge-analysis-2026-11-16.md`（77 行，未跟踪文件）
> 核查方式：只读。全部结论基于本地 git 对象、仓库源码与 `node --test` 实跑；未修改被核查报告。
> 核查环境：worktree `dsh-1a1d66ea-8c22`，`@nanmicoder/dsh-agent-teams@0.1.33`，HEAD `8e737dc`。
> 核查时间：2026-11-16。

## 0. 结论摘要

| 结果 | 数量 |
|---|---:|
| 通过 | 35 项 |
| 不通过（必须改） | 6 项 |
| 不通过（建议收紧） | 3 项 |
| 部分成立 | 1 项 |
| 无法核查 | 3 项 |

报告中所有 `file:line` 引用**全部命中且内容相符**，这是本次核查中最强的一项：15 处行号无一处偏移。问题集中在**时间归属**（把上游 0.1.30 内的提交说成"tag 之外"）与**验收标准空转**（P1-1 的验收命令今天就已经通过）。

---

## 1. 版本与 tag

| 核查项 | 结果 | 证据 | 建议修正 |
|---|---|---|---|
| `package.json` version = 0.1.33 | 通过 | `package.json:3` `"version": "0.1.33"`；`package.json` name = `@nanmicoder/dsh-agent-teams` | — |
| `compatibility.json` recommendedHost = 0.2.2-rc.3 | 通过 | `compatibility.json:3` `"recommendedHost": "0.2.2-rc.3"`；`supportedHosts[0].version` = `0.2.2-rc.3`，其后 rc.2 / rc.1 / 0.2.1-rc.5…rc.1 | — |
| `git tag --list 'v0.1.2*' \| tail -3` 只到 v0.1.29 | 通过（口径需注明） | 输出 `v0.1.27 / v0.1.28 / v0.1.29`；该通配共 12 个 tag，仓库共 43 个 | 补一句"这是 `v0.1.2*` 通配的结果"，避免被读成"仓库没有 v0.1.30+" |
| 报告 §6 "本地 tag 只到 v0.1.29" | **不通过** | 本仓库 fork tag 直至 `v0.1.33`：`v0.1.30`=e344350、`v0.1.31`=181440d、`v0.1.32`=29d1364、`v0.1.33`=8e737dc；上游 tag `refs/tags/v0.1.30` 也确实存在（本地镜像 `up-v0.1.30` = `4354b0f`） | 改为："本仓库 fork tag 到 v0.1.33；**上游** tag 到 v0.1.30（=4354b0f），`ls-remote` 未见 v0.1.31+" |
| §6 "v0.1.31+ 是否存在：未验证" | 部分成立 | `git ls-remote --tags upstream 'v0.1.31' 'v0.1.32' 'v0.1.33'` 首次返回中**只有** `refs/tags/v0.1.30`；后续重试 `exit=124`（超时） | 保留"未验证"，但补上"首次 ls-remote 仅返回 v0.1.30，倾向不存在"这一已获证据 |

## 2. commit 真实性

`git cat-file -t` 对 7 个 SHA 逐个执行，**全部返回 `commit`**，无一个缺失或类型错误。

| SHA | 类型 | 主题 | 日期 | 归属 |
|---|---|---|---|---|
| `2ee0409` | commit | fix: validate platform-specific optional Harness packages | 2026-11-13 | upstream/main |
| `1f1977b` | commit | fix: run desktop channel probe after reused candidate publish | 2026-11-06 | upstream/main |
| `78e24f9` | commit | fix: support Harness 0.2.2-rc.2 and prepare v0.1.30 | 2026-11-13 | upstream/main |
| `4354b0f` | commit | Merge pull request #355 from NanmiCoder/codex/harness-022-rc2-compat | 2026-11-13 | upstream/main（= 本地 `upstream/main`） |
| `181440d` | commit | feat: merge upstream v0.1.29 into the 0.2.2-compatible line | 2026-11-09 | 本线（= `v0.1.31` tag） |
| `8e737dc` | commit | feat: adapt AgentTeams plugin to DSH 0.2.2-rc.3 (v0.1.33) | 2026-11-14 | 本线（HEAD，= `v0.1.33` tag） |
| `29d1364` | commit | feat: adapt AgentTeams plugin to DSH 0.2.2-rc.2 (v0.1.32) | 2026-11-13 | 本线（= `v0.1.32` tag） |

| 核查项 | 结果 | 证据 | 建议修正 |
|---|---|---|---|
| 7 个 SHA 均为存在的 commit | 通过 | 见上表，`git cat-file -t` 全为 `commit` | — |
| §2 "可搬的两处（都在 **0.1.30 之后、tag 之外**）" | **不通过** | `git merge-base --is-ancestor 2ee0409 4354b0f` 与 `1f1977b 4354b0f` 均成立 →两者都是上游 **v0.1.30 tag（4354b0f）的祖先**。拓扑：`1f1977b ← 369c278(merge #344) ← 78e24f9 ← 2ee0409 ← 4354b0f(merge #355)` | 改为"**在 v0.1.30 之内、但不在其 release note 里**的两处工程修复"，或"v0.1.30 的 tag 内含、本线未跟进的两处"。§3.1/§3.2 标题"0.1.30 之后"同步改 |
| 上游 v0.1.30 tag 内容 | 通过 | `git show 4354b0f:release-notes/v0.1.30.md` 四条与报告 §2 表格逐条对应（rc.2 激活恢复 / 成员创建与排队适配 / 停成员清分支后代 / 回报后不二次唤醒） | — |

## 3. 文件与行号（15 处抽查，全部命中）

| 报告引用 | 结果 | 实际内容 | 建议修正 |
|---|---|---|---|
| `src/tools.ts:1202-1208` | 通过 | `:1202` `members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {`；`:1203-1207` 仅 name/role/provider/model/reasoning_effort/tool_policy/skills/preset_id；`:1208` 收尾。**确无 `executionPrompt`** | — |
| `src/tools.ts:3689` | 通过 | `executionPrompt: member.executionPrompt ?? preset?.executionPrompt,`（位于 `initializeProfileTeam`，函数起于 `:3653`） | — |
| `src/tools.ts:879` | 通过 | `if (!staged && !allowPendingEdits) requireStagedTeam(fresh)`（`updatePlanBatch` 内，`edit_plan` 路径） | — |
| `src/tools.ts:1073` | 通过 | `requireStagedTeam(fresh)`（`approveStagedTeam`，函数起于 `:1067`） | — |
| `src/tools.ts:1120` | 通过 | `requireStagedTeam(fresh)`（`continueStagedPlanning`，起于 `:1115`） | — |
| `src/tools.ts:1144` | 通过 | `requireStagedTeam(fresh)`（continue 的第二分支） | — |
| `src/tools.ts:1160` | 通过 | `requireStagedTeam(fresh)`（`discardStagedTeam`，起于 `:1155`） | — |
| `src/harness-compat.ts:203-225` | 通过 | `:203-214` 注释明确 `0.2.2-rc.2 retired the process-stable deliverPrompt symbol`；`:215` `export function installModernDelivery`；`:224` `unsupported('missing 0.2.2 host FIFO delivery')`；`:225` `return manager.deliverPrompt(childId, content, { source, signal, delivery })` | — |
| `src/harness-compat.ts:348-351` | 通过 | `:348` 读 `ownEvents`，`:349` `return current.ownEvents.call(session)`（**无范围参数**），`:350-351` legacy 回退。报告"直接全量返回"成立 | — |
| `src/harness-compat.ts:482-542` | 通过 | `:481` `export function guardSubagentDelivery`，`:504` ``throw new SubagentError(`AgentTeams member "${targetId}" was retired and cannot be resumed`, 'NOT_RESUMABLE')``，`:542` 收尾 | — |
| `src/members.ts:1442` | 通过 | `export function installRetiredMemberGuard(ctx: Context, stateDir: string): void {` | — |
| `src/quality-gates.ts:38` | 通过 | `const WRITE_KINDS: readonly TaskKind[] = ['implementation', 'repair']` | — |
| `src/quality-gates.ts:348` | 通过 | `export function inScopeOverlap(` | — |
| `src/scheduler.ts:1153-1155` | 通过 | `if (live !== undefined && typeof live.session.snapshotEvents === 'function')` / `return live.session.snapshotEvents(SessionLogOffset(from))`（`recoveryEvents`，起于 `:1151`） | — |
| `src/scheduler.ts:1595-1626` | 通过 | 位于 `kickMember`（起于 `:1363`）构造 work-order ticket：`:1603` `...task.inScope === undefined ? {} : { inScope: task.inScope }`，`:1626` `assignmentPrompt(...)`。**全程无 scope 冲突判定** | — |
| `.github/workflows/publish.yml:164-168` | 通过 | `:164` `consumer-resolution:`（name "Check desktop npm channel readiness"、`needs: publish`），`:168` `timeout-minutes: 6`；**该 job 无 `if:`**。全文件 `if:` 仅出现在 `:31/:35/:70/:142/:218` | — |

补充佐证（非报告引用行，供交叉验证）：

- `src/tools.ts:882` 即报告所称"整队上锁"文案：`a running team only permits update_task edits to pending, never-started tasks; roster and removal edits require a staged plan`。
- `src/tools.ts:343-348` `requireStagedTeam` 抛 `team "${team.name}" is already running; its plan can no longer be edited`。
- `add_member`（`src/tools.ts:1989`，execute `:2025-2105`）确实**不经过** `requireStagedTeam`，只调 `requireFreshCaptainTeam`。
- `create_task`（`:2297`）在 `:2357` 调 `validateCreateTask`，同样**不经过** `requireStagedTeam`。
- `git show 1f1977b` 的 diff 恰好是 `+    if: ${{ !cancelled() && needs.publish.result == 'success' }}`，1 行插入，与报告 §3 描述一致。

## 4. 缺失断言（4 个标识符）

| 核查项 | 结果 | 证据 | 建议修正 |
|---|---|---|---|
| `idempotencyKey` 不存在 | 通过 | `grep -rn 'idempotencyKey' src/ scripts/` → 无命中（exit 1） | — |
| `expected_revision` 不存在 | 通过 | `grep -rn 'expected_revision\|expectedRevision' src/ scripts/` → 无命中（exit 1） | — |
| `permissionPreset` 不存在 | 通过 | `grep -rn 'permissionPreset' src/ scripts/` → 无命中（exit 1）。注：`permissionPresetId` 只出现在 `docs/analysis/competitor-features.md:29/50/336-338`，是竞品字段，未进 src | 建议把 grep 写成 `permissionPreset*`，避免"是否含 Id 后缀"的歧义 |
| `optional-platform` 不存在 | 通过 | `grep -rn 'optional-platform' src/ scripts/` → 无命中；`grep -rn 'skipped' scripts/harness-runtime*.mjs` → 无命中；`scripts/harness-runtime-cohort.mjs` 文件不存在；`inspectRuntimeCohort` 全仓库无引用 | — |

## 5. 重复推荐（对照 `docs/issue-backlog-2026-10-30.md`）

| 核查项 | 结果 | 证据 | 建议修正 |
|---|---|---|---|
| P0-1 #352 / P0-2 #348 / P1-3 #356 是否已被 backlog 覆盖 | 通过（未覆盖） | backlog 是 2026-10-30 快照，覆盖到 **#317**；`grep '352\|348\|356' docs/issue-backlog-2026-10-30.md` 无命中；`docs/analysis/upstream-issues-triage.md:242` 明确记录"上游此后新增 #331/#333/#335/#342/#346/#348/#349/#350/#352/#356/#357/#358 共 12 条" | — |
| P0-4 `expected_revision` / P0-5 `idempotencyKey` / P1-1 `optional-platform` 是否重复 | 通过（未覆盖） | backlog 无这些条目；`docs/analysis/competitor-features.md:302/307/385` 是首次提出处 | — |
| P2 "token/成本计量"、"preset 召唤手势" | **不通过（低风险重复）** | backlog `:25/:37/:59/:72` 已把 **#317** 立为 "accepted zero-cost investigation, token-neutral only"；`#223`/`#315` 已覆盖 preset 相关产品决策（`:21/:74/:91`） | P2 行加一句"与 backlog #317 / #223 / #315 部分重叠，出手前先看这三条的既有决议" |

## 6. 过度断言 / 未验证写成确定事实

| 核查项 | 结果 | 证据 | 建议修正 |
|---|---|---|---|
| P1-1 验收标准 `node --test scripts/harness-runtime-platform.test.mjs` 通过 | **不通过（验收空转）** | 实跑：`2 tests pass / 0 fail`，且该文件仅 31 行、只含 2 个 `linkDirectory` 用例，**与 optional 包无关**。今天的仓库不搬 `2ee0409` 也能通过 → 该验收无法证明 P1-1 做没做 | 换成"新增 cohort 用例后 test 数从 2 变 3 且新用例覆盖 `skipped[].reason==='optional-platform'`"，或直接写"`grep -n optional-platform scripts/harness-runtime-cohort.mjs` 有命中且 `verifyCohort()` 已改为调用它" |
| TL;DR "每个约 30 行/1 行" | **不通过（低估）** | `git show 2ee0409 --numstat`：`docs/harness-0.2.2-rc.2/README.md 2/0`、`scripts/harness-runtime-cohort.mjs 35/0`、`scripts/harness-runtime-platform.test.mjs 41/0`、`scripts/harness-runtime-verify.mjs 3/13` = **4 文件 +81/−13** | 改为"cohort 模块 ~35 行 + 用例 41 行 + verify 改写，合计 +81/−13" |
| §2 "~470 行是构建产物（`lib/*.js`）" | 建议收紧 | `git diff --numstat v0.1.29..upstream/main \| grep lib/`：client.js 177/177、harness-compat.js 120/4、mailbox.js 3/5、git-artifact-stamp.json 2/2、types/harness-compat.d.ts 4/0 → **ins 306 + del 188 = 494 变化行** | 数量级成立，可写"约 494 行（+306/−188）"更准确 |
| P0-3 "只在 `create_task` 阶段校验" | 建议收紧 | `validateCreateTask` 有两处调用：`src/tools.ts:2357`（create_task）**和 `:992`（edit_plan 的 update_task 改动后复验）** | 改为"只在 create_task 与 edit_plan 复验阶段校验" |
| §5 "注意 **4 个**调用点都要换" | 建议收紧 | 本线 `sessionOwnEvents` 调用点确为 4 个（`src/mailbox.ts:217`、`src/members.ts:889/1118/1457`），但同一报告引用的分报告 `docs/analysis/upstream-issues-triage.md:251` 写的是"改 **4 个调用点中的 3 个**为范围读" | 与分报告统一口径，或注明"mailbox 那处走倒扫窗口、不传 from" |
| §2 "上游 `verify` 比本线少 20+ 个子验证" | 通过（数值可再精确） | verify:* 键：本地 36 / 上游 19（少 17 个）；`verify` 聚合串分段：本地 42 / 上游 25 | 可写"少 17 个 verify 子命令、聚合串少 17 段" |
| §1 P1-2 "job 带 `if: !cancelled() && needs.publish.result == 'success'`" | 通过 | 与 `1f1977b` 的实际 diff 逐字一致 | — |
| §4 "专家目录导入…`src/agent-library.ts` 只有私有 `presets.json`" | 通过 | `src/agent-library.ts:7` `export const AGENT_LIBRARY_FILE = 'agent-library/presets.json'`；`AgentPresetV1` 引自 `src/types.ts` | — |
| §4 "召唤手势需先验证宿主是否支持 `userInvocable`（未验证）" | 通过（已正确标注未验证） | `grep -rn 'userInvocable\|modelInvocable' src/` 无命中 → 本仓库确实没有相关探测 | — |
| §6 "dsh-web 仅文档级验证" | 通过（已标注） | `docs/analysis/competitor-features.md:7` 与 `:253` 自述只读了文档 | — |
| §6 "宿主 rc.3 对 `modelInvocable:false / userInvocable:true` 未探测" | 通过（已标注） | 同上，仓库内无该组合的验证脚本 | — |

## 7. 其他

| 核查项 | 结果 | 证据 | 建议修正 |
|---|---|---|---|
| 报告头部三个分报告相对链接 | **不通过（链接全部失效）** | `docs/upstream-0.1.30-delta.md` / `docs/upstream-issues-triage.md` / `docs/competitor-features.md` 均不存在；真实路径在 `docs/analysis/` 下 | 三处链接前面补 `analysis/` |
| 区间统计 5 commits / 23 files / +1198−242 | 通过 | `git rev-list --count v0.1.29..upstream/main` = 5；`git diff --shortstat` = `23 files changed, 1198 insertions(+), 242 deletions(-)` | — |
| 上游把 recommended 回退到 0.2.1-rc.2 | 通过 | `git show 4354b0f:compatibility.json` → `"recommendedHost": "0.2.1-rc.2"`，`0.2.2-rc.2` 为 preview | — |
| 本线 mailbox 两条实现 | 通过 | `src/mailbox.ts:11` `export const FINAL_REPORT_GRACE_MS = 500`；`:36` `export function isFinalReportForSettlement(`；env 覆写上界 2000ms | — |
| GitHub issue #352/#348/#356 原文 | 无法核查 | `curl api.github.com/repos/NanmiCoder/dsh-agent-teams/issues/352` → **403 `API rate limit exceeded for 49.65.68.51`**，348/356 同 | 保留报告 §6 的披露即可；标注"匿名配额耗尽未核查" |
| issue 状态（OPEN / 日期 / 0 评论） | 无法核查 | 同上，API 403；仅能从 `docs/analysis/upstream-issues-triage.md:41/55/79` 转述 | 注明"状态转引自分报告，未回源" |
| 竞品 star / 仓库体积等元数据 | 无法核查 | 需 GitHub API，配额耗尽；只能引用 `docs/analysis/competitor-features.md:231`（10451★ / ~1.5 GB） | 同上 |

---

## 总裁决

**需修正 9 处**。6 处必须改：① §2"可搬的两处（都在 0.1.30 之后、tag 之外）"归属错误——`2ee0409`/`1f1977b` 都是上游 `v0.1.30` tag（`4354b0f`）的祖先；② P1-1 验收空转——`node --test scripts/harness-runtime-platform.test.mjs` 今天就已通过（2 用例，与 optional 包无关）；③ §6"本地 tag 只到 v0.1.29"——fork tag 实到 `v0.1.33`，上游 tag 到 `v0.1.30`；④ 头部三个相对链接全部失效（应为 `analysis/` 前缀）；⑤ TL;DR"约 30 行"低估——`2ee0409` 实为 4 文件 `+81/−13`；⑥ P2"token 计量/preset 手势"与 backlog `#317`/`#223`/`#315` 重叠未声明。3 处建议收紧：`~470` 行构建产物应为 494 变化行、P0-3"只在 `create_task` 校验"漏了 `edit_plan` 复验（`src/tools.ts:992`）、§5"4 个调用点"与分报告"改 4 个中的 3 个"口径不一致。**除此之外报告可信**：15 处 `file:line` 全部命中、7 个 SHA 全为真实 commit、4 条缺失断言全部成立、区间统计与 `publish.yml` 守卫判断均准确。3 项无法核查均因 GitHub 匿名配额耗尽，报告自身已在 §6 披露。
