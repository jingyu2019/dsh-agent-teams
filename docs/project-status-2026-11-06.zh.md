# dsh-agent-teams fork：需求与当前进度

整理日期：2026-11-06（Asia/Shanghai）
整理方式：读取 5 个 codex 会话的落盘记录（`~/.codex/sessions/`）+ 仓库实际 git 状态与文档交叉核对。
本文只陈述**有据可查**的状态；未能核实的部分单列在「事实来源与不确定性」。

---

## 0. 一页结论

| 维度 | 现状 |
|---|---|
| 项目目标 | fork 上游 `NanmiCoder/dsh-agent-teams`，逐个评估上游 issue，采纳的自留地实现 + 验证，代码只进自己的 fork |
| 当前版本 | `@nanmicoder/dsh-agent-teams@0.1.29`，目标宿主 `@deepseek-ai/dsh@0.2.1-rc.5` |
| 主线状态 | `main` 已与 `origin/main` 对齐（`0b4469d`，2026-11-06）；功能实现在集成分支 `codex/331-324-integration`（`ad763c1`，已推送、**未合并、无 PR**），另新增 `codex/317-usage-ledger`（`128e29d`） |
| 已交付 | rc.5 基线（11/11 运行时场景、296 包精确 cohort）、7 项性能/体积优化、#330/#333/#335 修复、#331/#324 实现并真机验证、#317 的 captain/member 账本拆分（`metrics.byRole`） |
| 未闭环 | #314（缺外部日志）、#317（账本已拆、缺配对测量）、压缩预算方案（已定性：rc.5 不可表达，封存 design-only）、跨平台证据、分支合并与发布 |
| 最大风险 | 五条改动线（含 #331/#324）全在未合并的分支上，一旦丢分支就是丢交付；另 5 个 worktree 需清理（本会话沙箱删不掉） |

---

## 1. 项目定位与仓库拓扑

- 上游：`NanmiCoder/dsh-agent-teams`（只读，不改 issue/PR）
- fork：`jingyu2019/dsh-agent-teams`（唯一提交目标）
- 本地主工作树：`/Users/openclaw/Documents/ChatGPT/agent-team`（在 `main` = `26d71b1`）
- 运行环境基线：Node `v26.x` / pnpm `11`；`pnpm verify` 为复合校验器（690 条自定义 `PASS` + 301 条 node:test 勾），不是单一测试计数

### 分支与 worktree 实况（实测）

| 位置 | 分支 | 提交 | 与 `origin/main` 关系 |
|---|---|---|---|
| `agent-team`（主工作树） | `main` | `0b4469d` | 已对齐（docs 重放后 +1，已推送） |
| `agent-team-wt/feature-batch-2026-11-04` | `codex/331-324-integration` | `ad763c1` | 9 commits ahead，已推送，未合并（工作树仍有一份未提交实验，见 5.4） |
| `agent-team-wt/317-314-triage` | `codex/317-314-triage` | `b93eaf0` | 内容已在 `main`，worktree 待清理 |
| `agent-team-wt/compaction-policy-design` | `codex/compaction-policy-design` | `2de1198` | 内容已在 `main`，worktree 待清理 |
| `agent-team-wt/324-delegation-config` | `codex/324-delegation-config` | `4f569f2` | 早期方案，已被集成分支取代，worktree 待清理 |
| `agent-team-wt/331-independent-fork-team` | `codex/331-independent-fork-team` | `80077b2` | 早期方案，已被集成分支取代，worktree 待清理 |

> 分叉原因：远端 `main` 上出现过历史重写（`perf: bound polling, mailbox and snapshot payloads` 同名提交重复 9 次）；重建前 `git diff main origin/main -- src lib scripts package.json compatibility.json` **为空**，所以是历史卫生问题，不是代码分叉。2026-11-06 已用「`origin/main` + docs 重放」重建，原 `main` 保留为 `backup/main-26d71b1`。

---

## 2. 需求来源一：上游 issue 分流

主文档：[issue-backlog-2026-10-30.md](./issue-backlog-2026-10-30.md)、技术设计：[design/issue-backlog-design.md](./design/issue-backlog-design.md)

### 2.1 分流结论（2026-10-30 基线，48 个非 PR issue）

| 决策 | 数量 | 说明 |
|---|---:|---|
| 采纳进开发 backlog | 24 | 316, 305, 260, 259, 308, 272, 103, 97, 76, 114, 62, 165, 121, 58, 70, 263, 244, 243, 238, 211, 195, 279, 315, 287 |
| 零成本调研（仅 token-neutral） | 1 | 317 |
| TODO（上游已 CLOSED 但本 fork 未复现） | 1 | 314 |
| 需先补证据/设计决策 | 7 | 162, 117, 151, 96, 223, 241, 190 |
| 重复 | 3 | 311, 312, 237 |
| 已修复 | 3 | 313, 270, 208 |
| 超出范围 | 3 | 71, 268, 269 |

后续增量：`#322/#323/#325/#326/#328` 判为 `#327` 重复；`#327` 已在 fork 修复；新采纳 `#330/#333/#335/#331/#324`；`#319` 判为 `#96/#244` 线重复。

### 2.2 八个开发切片（依赖顺序）

| 切片 | 覆盖 issue | 验收主题 |
|---|---|---|
| W0-COMPAT | 316, 305, 260, 259(1), 165 | 分发与低风险完整性：rc.4 精确目标、空 subject 拒绝、`tool_policy` 可选、flag 去重、manifest 随包 |
| W1-LIFECYCLE | 308, 272, 103, 259(2) | 卡死/挂起/过期 attempt：结算绑定 attempt、parking 一次性通知、idle→running 交错 |
| W2-AVAILABILITY | 97, 76, 62(半) | 并发许可、有序回退链/冷却/配额、有界 429 恢复、Parallel Emission 默认关 |
| W3-CONTEXT | 114, 62(半)；证据门 162/190/241/117/96 | 宿主压缩在 durable member 上的连续性、`nextProbeAt` 持久化 |
| W4-COLLAB | 195, 238, 244, 243；211 供证据 | 免 Team 直调 profile、idle member 路由切换、成员级 skill 绑定、确定性 collect |
| W5-UI | 263, 58, 70, 121, 279；270 视觉回归 | 有界时间线、状态渲染器、工作区级附件、本地头像、staged 改名/字号/手动建队 |
| W6-EVIDENCE | 211, 317 | 单 agent / 普通 subagent / AgentTeams 三模式同预算配对评估 |
| W7-PLATFORM | 315, 287 | 全局不可变 agent 预设库、任务级 worktree 绑定与集成/清理 |

---

## 3. 需求来源二：你的四轮决策 + 一条新需求

原话见会话 `01a18a7d`（2026-11-04 01:37 与 03:20）。

| 项 | 你的决策 | 落地口径 |
|---|---|---|
| **#331** | fork 出来的会话**应该拥有自己的 team** | 产品决策 + captain 身份迁移；成员 fork 仍不得升格为 lead |
| **#324** | GUI team size 配置 + delegation skill，**可以升级依赖到新版本** | 目标宿主锁定 `0.2.1-rc.5`（`pnpm-lock.yaml` 有对应包记录） |
| **#317** | **可以改进，但不能因此多耗 token**；需要额外消耗 token 就不改进 | token-neutral 硬门：captain/member 账本逐维不得上升 |
| **#314** | **记录待办** | 上游 CLOSED 不等于本 fork 已闭环，保持 TODO |
| **新增需求** | 优化子 agent 占 token：**降低子 agent 压缩阈值、阈值由主 agent 控制**，且不得显著增加主 agent 开销；主 agent 侧 token 控制同样纳入 | 先出架构图与开发方案，不直接实现 |

新增需求的边界被明确限定为「针对开发中的这个项目要增加的能力」，不是限制当时正在运行的 agent。

---

## 4. 当前进度（按证据强度分三层）

### A. 已实现 + 已在真实 rc.5 宿主验证（但未合并）

集成分支 `codex/331-324-integration`（`ad763c1`，9 个提交，50 文件 / +1522 −298）。

> 注意：下表标 ⧉ 的文件只存在于 `ad763c1`，当前 `main` 工作树里没有。

| 项 | 实现位置 | 验证证据 |
|---|---|---|
| #331 fork 独立持有 team | `src/lineage.ts`（`teamLeadDistance` 距离制：精确=0、祖先按最近距离排序）、`src/state.ts`（`findTeamByCaptain` 按距离择优，同距才报歧义）、`src/tools.ts`（仅在「队长本人或活跃成员」时才拒绝新建）、`src/capabilities.ts`（`selectCapabilityTeam` 同步启动/HMR 路径同规则） | ⧉ `scripts/issue-331.test.mjs`；真实宿主场景 `fork-owned-team` 7 项断言通过（`bothTeamsPersisted` / `parentOwnsFirstTeam` / `forkOwnsSecondTeam` / `forkStatusResolvesOwnTeam` / `distinctCaptains` / `productMarker` / `exit0`） |
| #324 GUI 容量配置 | `src/index.ts`（`maxMembers?: Volatile<number>` + `.volatile()` + 运行期读实时引用）、⧉ `src/client/AgentTeamsConfig.tsx`（163 行）、`src/client/locales.ts`、⧉ `src/client/max-members-config.ts`；`src/index.ts` 的 `maxMembers` 改动同样在 `ad763c1` | ⧉ `scripts/issue-324-config.test.mjs`；隔离 rc.5 web profile 真机：默认 8 → 存 13 → profile patch 写入 → 恢复到 8 |
| #324 delegation skill | ⧉ `skills/agent-teams-delegation/SKILL.md`（63 行，派活判据 / 一项目一专员 / 名额满时处理顺序 / 工具映射）；prompt 增加一行指引 | 固定 captain prompt 增加 **78 UTF-8 字节**；完整 token 与调用数未测 |

复现记录：⧉ `docs/harness-0.2.1-rc.5/issue-331-324-integration/README.md`（在 `ad763c1` 分支上，当前工作树没有）（宿主 `0.2.1-rc.5`、296 包 cohort、产物 SHA-256、真机结论、以及「其他操作系统未验证」的自我限定）。

### B. 已实现 + 离线/单测验证（在 `origin/main` 线上）

| 批次 | 内容 | 证据 |
|---|---|---|
| rc.5 基线（0.1.29） | 提升 rc.5 为精确支持目标，21 个 DSH peer 重新生成 | `11/11` 真实运行时场景、296 包精确 cohort、桌面 0.1.29 smoke |
| 优化批次（2026-11-03） | ①内存 trace 只采 OS 元数据 ②`/state` 强 ETag + 304 跳过替换 ③已确认非 final 邮件归档到 `inbox/archive` ④归档快照按 mtime+size 缓存、上限 256 ⑤快照剥离 staged-only 字段、时间线截 50 条 ⑥工具面预算可复现测量 ⑦共享有界测试清理 helper ⑧安装 preflight | 各自专项套件（`scripts/memory-trace.test.mjs`、`activity-etag.test.mjs`、`mailbox-compaction.test.mjs`、`activity-archive-cache.test.mjs`、`snapshot-payload.test.mjs`、`tool-surface-budget.test.mjs`、`test-cleanup.test.mjs`、`install-preflight.test.mjs`） |
| #330 | `/state` 每秒全量重发 | ETag/304 + session 作用域 + workspace root 去重 + 隐藏页降频 + payload 裁剪 |
| #333 | 删 team 遗留 member 宿主会话 | `agent_teams_delete({ archive_member_sessions: true })`，默认不变（opt-in） |
| #335 | Windows 桌面报 `invalid plugin ... received object` | 同时导出默认 `{ name, inject, Config, apply }` 对象；**仅证明导出形状适用，不能证明 Windows 打包路径** |

### C. 仅设计，未实现

| 文档 | 内容 | 状态 |
|---|---|---|
| [design/subagent-compaction-budget-2026-11-04.md](./design/subagent-compaction-budget-2026-11-04.md)（32 KB） | 团队级压缩预算：策略形状、成员侧确定性测量、seam 问题、Token 账本、失败模式、Phase 0–5 计划、Rollout flag、宿主缺口 | Phase 0（设计验收）产物；**Phase 1–5 全部未实现**，且明确依赖尚不存在的宿主 team-scoped 钩子 |
| [design/issue-backlog-design.md](./design/issue-backlog-design.md)（93 KB） | 24 个采纳 issue 的逐项技术设计、7 个歧义的裁决、Rollout/回滚 | W0–W7 的设计底稿；实现进度以代码为准 |

---

## 5. 未闭环清单与本次执行记录

| # | 事项 | 缺什么 | 闭环动作 |
|---|---|---|---|
| 1 | **#314** 安装失败 | 报告者的确切版本、宿主/pnpm 版本、完整 `pnpm.log`、干净精确版本重试，以及「镜像超时 vs 兼容性拒绝」的归类 | 等外部证据；不要用推断代替复现 |
| 2 | **#317** token-neutral | 账本已拆（见 5.1），但**还没有配对运行**：缺同一场景下「改一项优化」前后的 captain/member 实际 usage 对照 | 跑配对运行，两轮只差一项改动；差异落在哪一侧由 `metrics.byRole` 直接读出 |
| 3 | **压缩预算方案** | ~~宿主是否提供 team/member 级策略覆盖~~ → **已定性**（见 5.3）：rc.5 无 per-agent 策略入口，只有加载期 `provider/model` 键控配置 | 封存为 design-only；除非宿主新增 per-agent 策略 API，或改走「只触发不控阈值」路线 |
| 4 | **集成分支未合并** | PR（本机无 `gh`，见 5.4） | `origin/main` 已是 `ad763c1` 的祖先，合并无需 rebase；开 PR 后再决定 0.1.30 |
| 5 | **跨平台证据** | Ubuntu / Windows 上的 rc.5 矩阵与插件管理器安装 | 需要另一台机器或 CI 路径；本机只有 darwin/arm64 |
| 6 | **#324 桌面复验** | 用户真实桌面 profile 的交互确认 | 目前只在隔离 web profile 验过；桌面 profile 未被改动 |
| 7 | **worktree 清理** | 5 个 worktree 中 5 个都要处理；本会话沙箱**不能写工作区外路径**，删不掉 | 见 5.4 的手动命令 |
| 8 | **A Team 初始化门槛** | `INIT.md` / `.agent-sync/TEAM.md` / `roster.py` | 会话 `01a1a6b0` 曾因此标 blocked；后续改为直接实现绕过，流程债仍在 |

### 5.1 已执行（2026-11-06，本次）

| 动作 | 结果 | 证据 |
|---|---|---|
| 对齐本地 `main` | 重建在 `origin/main` 之上，仅重放本地独有 docs；推送成功 | `0b4469d`；`git rev-list --left-right --count main...origin/main` = `0 0` |
| 保留回滚点 | 老 `main` 留 ref | 分支 `backup/main-26d71b1`、tag `backup-26d71b1`（均指向 `26d71b1`） |
| #317 账本 | `metrics.byRole.{captain,member}` 实现：requests / 每请求 system 与 tool-schema 字节 / 工具数 / 工具调用（总/成功）/ 分角色 usage（缺失字段保持 null） | 分支 `codex/317-usage-ledger`（`128e29d`，已推送） |
| 堵住测试腐烂 | 该测试此前只被 `.github/workflows/verify.yml` 直接调用，`pnpm verify` 链里没有 → 新增 `verify:model-case` 并挂进 `verify` | `package.json` 改动 3 行 |
| 回归 | `harness-model-case` 4/4、`harness-complex-case`+`benchmark-scope` 5/5、`issue-211` 13/13、`scripts/verify.mjs` all checks passed | 见 5.5 |

### 5.2 未执行（受环境限制，不是没做）

| 项 | 原因 | 需要的动作 |
|---|---|---|
| worktree 清理 | 沙箱只允许写会话工作区，`/Users/openclaw/agent-team-wt/` 下所有写操作（含 `git checkout --`、`touch`）返回 `Operation not permitted` | 在普通终端执行 5.4 的命令 |
| 开 PR | 本机 `gh` 未安装；`npx`/`npm` 因 `~/.npm` 不可写而失败 | 用 compare URL 手动开，或安装 `gh` |
| 全局反馈记录 | `~/.pua` 不可写 | 已把一行 JSON 暂存到 `/tmp/pua-feedback-2026-11-06.jsonl`，可自行 `cat >> ~/.pua/feedback.jsonl` |

### 5.3 压缩方案的定性依据（详见设计文档 §9）

`ctx.compaction: CompactionEngine` 只有三个入口：`compactIfNeeded(agent, trigger, signal)`、`compactRegion(start, end, agent, signal?)`、`compactNow(agent, signal, sourceCommandId?)`。阈值来自 `BasicCompactionConfig`（`thresholdRatio` 默认 0.8、`headroomTokens` 65536、`retainRatio` 0.16），键是 **provider + model**（`modelPolicies`），配置在加载期冻结为 `readonly config: ResolvedConfig`，**没有 session / agent / team 维度，也没有运行期 setter**。

结论：「主 agent 控制子 agent 压缩阈值」在 rc.5 不可表达。可用的是「主 agent 触发压缩」（`compactNow` 已实现；`compactRegion` 需自选区间）。

### 5.4 手动待办命令

```bash
# 1) 清理 4 个已并入 main 的 worktree（分支保留，只删目录）
cd /Users/openclaw/Documents/ChatGPT/agent-team
git worktree remove --force /Users/openclaw/agent-team-wt/317-314-triage
git worktree remove --force /Users/openclaw/agent-team-wt/324-delegation-config
git worktree remove --force /Users/openclaw/agent-team-wt/331-independent-fork-team
git worktree remove --force /Users/openclaw/agent-team-wt/compaction-policy-design

# 2) 清掉 feature-batch 工作树里那份未提交的实验（内容已进入 128e29d）
cd /Users/openclaw/agent-team-wt/feature-batch-2026-11-04
git checkout -- scripts/fixtures/harness-model-case.test.mjs

# 3) 开 PR（或装 gh 后 gh pr create）
open "https://github.com/jingyu2019/dsh-agent-teams/compare/main...codex/331-324-integration"
open "https://github.com/jingyu2019/dsh-agent-teams/compare/main...codex/317-usage-ledger"
```

### 5.5 本次验证输出

```text
node --test scripts/fixtures/harness-model-case.test.mjs   → pass 4 / fail 0
node --test scripts/fixtures/harness-complex-case.test.mjs \
           scripts/fixtures/harness-benchmark-scope.test.mjs → pass 5 / fail 0
node --test scripts/issue-211.test.mjs                      → pass 13 / fail 0
node scripts/verify.mjs                                     → all checks passed
```

`pnpm verify` 全链**未跑**：本机 `pnpm` 不在 PATH，`npx pnpm` 因 `~/.npm` 不可写而失败。

---

## 6. 建议的下一步（按依赖顺序）

1. **配对测量 #317**（现在就能做）：用 `metrics.byRole` 跑同场景两轮，只差一项优化，读 captain / member 两侧差值。这是「不许多耗 token」唯一的判定依据。
2. **合并集成分支**：开 PR → 合入 → 0.1.30 release notes（跨平台证据不足时明确标注为未验证项）。
3. **压缩方案归档**：设计文档 §9 已定性，等宿主 API 变化再启；不要继续投工时。
4. **#314 保持 TODO**：只等外部证据。
5. **跨平台**：Ubuntu / Windows rc.5 矩阵补完后，前面几条结论才谈得上「通用」。

---

## 7. 五个 codex 会话各是什么

| 会话 | 时间窗 | 作用 | 主要产出 |
|---|---|---|---|
| `01a18a7d` | 10-30 09:47 → 11-04 16:48 | **主线**：fork、issue 审计、rc.5 兼容、优化批次、四轮决策 | issue backlog、优化文档、Gate 1 报告、#330/#333/#335 实现 |
| `01a1a498` | 11-04 11:26 | 「先理解任务目标及需求，以及当前的项目进度。复述给我」 | 首次目标/进度复述，并如实标注「这批需求代码尚未开始」 |
| `01a1a6b0` | 11-04 21:12 | 「推进 Team Skills Platform 需求」：Gate 1 核对 | 确认 #331 身份继承风险、#324 目标版本、压缩方案依赖未验证的宿主路径；因 A Team 初始化门槛最终标记 blocked |
| `01a1a6d8` | 11-04 21:56 | 由 `01a18a7d` fork 出的短会话（`/goal` 同一目标） | 无独立产出 |
| `01a1a6df` | 11-04 22:03 → 16:48 | 「梳理目标进度并继续开发」：真正落地的一轮 | #331/#324 实现 + rc.5 真机验证 + 推送集成分支（3 次提交推进，最终 `ad763c1`） |

> 会话角色说明：`01a1a6b0` 的 blocked 是**流程性阻塞**（缺 A Team 初始化入口），不是技术不可行；`01a1a6df` 换成直接实现路径后同一批需求当天就落地了。这条经验值得记住：卡流程时不要空转，先确认哪条路径是被授权的。

---

## 8. 关键文件索引

| 用途 | 路径 |
|---|---|
| issue 分流与决策矩阵 | [docs/issue-backlog-2026-10-30.md](./issue-backlog-2026-10-30.md) |
| 优化方向与实现状态 | [docs/optimization-directions-2026-11-02.md](./optimization-directions-2026-11-02.md) |
| 24 个采纳 issue 的技术设计 | [docs/design/issue-backlog-design.md](./design/issue-backlog-design.md) |
| 子 agent 压缩预算方案 | [docs/design/subagent-compaction-budget-2026-11-04.md](./design/subagent-compaction-budget-2026-11-04.md) |
| #331/#324 真机验证记录 | ⧉ `docs/harness-0.2.1-rc.5/issue-331-324-integration/README.md` |
| rc.5 优化批次矩阵 | [docs/harness-0.2.1-rc.5/optimization-2026-11-03/README.md](./harness-0.2.1-rc.5/optimization-2026-11-03/README.md) |
| 工具面预算基线 | `docs/tool-surface-budget.json` |
| 派活规则 skill | ⧉ `skills/agent-teams-delegation/SKILL.md` |
| #331 实现 | `src/lineage.ts`、`src/state.ts`、`src/capabilities.ts`、`src/tools.ts`（改动内容在 `ad763c1`） |
| #324 实现 | `src/index.ts`、⧉ `src/client/AgentTeamsConfig.tsx`、⧉ `src/client/max-members-config.ts` |

---

## 9. 事实来源与不确定性

**来自会话记录**：你的原始指令与四轮决策、各轮 agent 的自述进度、被标记为未闭环的事项。

**本次实测核对**：`git worktree list`、分支领先/落后计数、`git diff --stat main origin/main`（确认代码零差异）、集成分支文件清单、`maxMembers` 的 `.volatile()` 改动、`teamLeadDistance` 距离制实现、`node --test scripts/fixtures/harness-model-case.test.mjs` 的失败输出。

**未做**：没有运行完整 `pnpm verify`（复合校验器，耗时长），因此「#331/#324 全套回归仍绿」只能引用会话记录与集成报告，不是本次复跑结论；没有修改任何源码；没有推送任何分支。

**可能过时**：会话记录里的 token/字节数（19 工具 20,356 B 等）随代码演进会变，引用时请以 `docs/tool-surface-budget.json` 当前值为准（该文件里的 token 是「字节 ÷ 4」的估算，不是 tokenizer 实测）。
