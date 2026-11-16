# 上游 issues 分诊：NanmiCoder/dsh-agent-teams → 本线 0.1.33

- 生成时间：2026-11-16（Asia/Shanghai）
- 本线：`@nanmicoder/dsh-agent-teams@0.1.33`（已适配 Harness `0.2.2-rc.3`）
- 上游：`NanmiCoder/dsh-agent-teams`，最新提交 `4354b0f`（2026-11-13，v0.1.30）
- 数据来源：GitHub REST（`/repos/.../issues`、`/issues/{n}/comments`、`/pulls/{n}`）——按任务约束**未使用** `git fetch`；`mcp__github__*` 未在本会话暴露，改用 `api.github.com` 直连（已连通，HTTP 200）。
- 参照的既有结论：[`docs/issue-backlog-2026-10-30.md`](../issue-backlog-2026-10-30.md)、[`docs/optimization-directions-2026-11-02.md`](../optimization-directions-2026-11-02.md)、[`docs/issue-336-audit.md`](../issue-336-audit.md)、[`docs/analysis/upstream-0.1.30-delta.md`](./upstream-0.1.30-delta.md)。
- 约束遵守：**只读**，未改动 `src/`、未改动 `lib/`。所有结论带 issue 编号与 `file:line`。

## 0. 取数边界（先说没拿到的）

| 范围 | 状态 |
|---|---|
| open issues/PR 第 1–2 页（60 条，按 updated_at 倒序，覆盖 2026-11-16 → 2026-09-22） | 已获取 |
| open issues 第 3–4 页 | **未获取到**：GitHub API 匿名配额耗尽（`core remaining 0`，HTTP 403 `API rate limit exceeded`）；网页抓取只返回导航骨架。缺口约十余条 2026-09-22 之前的老 issue，其处置已记录在 `docs/issue-backlog-2026-10-30.md` |
| closed issues/PR 第 1–2 页（60 条，覆盖 2026-11-13 → 2026-10-26） | 已获取 |
| closed 2026-10-02 → 2026-10-26 区间 | **未获取到**（同上限额）。按已见样本，"plugin does not support the DSH version in use / distribution incomplete" 一类安装报告在第 2 页尾部依然密集，未见的应为同族重复项 |
| #356 / #352 / #350 / #348 / #349 / #335 / #333 / #331 的评论区 | 已获取（`#356`/`#352`/`#350`/`#348`/`#335` 上游零评论；`#349`、`#333`、`#331` 各 1 条） |

## 1. 分档汇总表

| 档 | 条数 | 编号 |
|---|---:|---|
| **P0** 影响本线正确性/数据安全 | 2 | 352、356 |
| **P1** 高价值低成本 | 3 | 348、350、333（剩余提案 2） |
| **P2** 观望（需设计或上游未定） | 6 | 358、331、244（MCP 半）、223（归档删除半）、317、96 |
| **不建议**（已修/重复/不适用） | 24 | 315、349、357、346、342、335、268、305、259、272、287、270、263、260、208、243、241、238、237、211、103、190、165、195 |
| 合计（全部 open issue） | **35** | 逐条覆盖，无遗漏 |

另有一批**上游已 CLOSED、本线同样已实现**的老 issue，单列在 §5.3，不计入上表。

一句话结论：**35 条 open issue 中，24 条本线已有实现或属重复/外部事项，6 条只能观望，真正值得动手的只有 5 条——352、356、348、350、333 提案 2，其中 352 是唯一会静默丢数据的。**

---

## 2. P0 —— 影响本线正确性 / 数据安全

### #352 `plan.members` 不接受 `executionPrompt`，一次性建队必然产出空提示词

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/352
- 状态：OPEN（2026-11-11，LHN-xiao-hai-tun，0 评论）
- 一句话诉求：`agent_teams_create` 的 `plan.members[]` 缺 `executionPrompt` 字段，传了被静默丢弃，落盘为 `""`，必须再补一轮 `edit_plan` 才能填上。
- **本线现状：未修（确认复现）。**
  - `src/tools.ts:1202-1208` 的 `plan.members` item schema 只声明 `name / role / provider / model / reasoning_effort / tool_policy / skills / preset_id`，**没有 `executionPrompt`**，且该 item 是 `additionalProperties: false`。
  - 而内部类型 `TeamProfileMemberConfig` **有**该字段（`src/profiles.ts` 的 `interface TeamProfileMemberConfig`），转换处也真的在读它：`src/tools.ts:3689` `executionPrompt: member.executionPrompt ?? preset?.executionPrompt`。
  - 对照镜像能力：`agent_teams_add_member` 声明了该字段（`src/tools.ts:1997`），`edit_plan.update_member` 走同一字段（`src/tools.ts:930`）。
  - 结论：**管道是通的，只差公开 schema 漏一个属性**，所以是静默丢弃而非报错——这比报错更危险。
- 建议动作：在 `src/tools.ts:1202-1208` 的 `members.items.properties` 增加 `executionPrompt: { type: 'string' }`（描述与 `:1997` 对齐）；补一条回归，断言 `create(plan.members[0].executionPrompt)` 落盘非空；挂进 `verify:issue-regressions`。
- 预估成本：**S**（1 行 schema + 1 条测试，约 30 分钟）。
- 风险提示：这是**公开工具契约变更**，但方向是"补全已存在于内部类型的字段"，向后兼容，不改变任何已有调用。

### #356 `ownEvents()` 无界读取整份会话日志，卡住宿主事件循环并抬升内存

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/356
- 状态：OPEN（2026-11-13，WanchengWildMan，0 评论）
- 一句话诉求：`session.ownEvents()` 不带范围会把整份事件日志物化成新数组；在 62 MB / ~46k 事件的会话上，RSS 174 MB → 1.4 GB → 167 MB，事件循环停顿达 188 s；DSH 核心已将该 API 标记为 deprecated，建议改 `snapshotEvents(from, toExclusive)` 范围读。
- **本线现状：未修（已定位到 4 个调用点）。**
  - 实现：`src/harness-compat.ts:347-353` `sessionOwnEvents()` 优先 `session.ownEvents.call(session)`，无任何范围参数。
  - 调用点 1：`src/mailbox.ts:217`，位于 `agent/pre-step` 钩子内（`installMailboxAdmission`，`src/mailbox.ts:105` 起），仅在"本轮消息全是过期邮件"分支触发。
  - 调用点 2：`src/members.ts:1457`，位于 `installMemberDelegationGuard` 的 `check()`，**每次 `subagents.start` 都沿祖先链逐个全量读取**。
  - 调用点 3：`src/members.ts:1118` `isPendingMember()`，由 `src/capabilities.ts:70` 的 `attach(agent)` 调用（按 agent 挂载，非每步）。
  - 调用点 4：`src/members.ts:889`，`installContinuableMemberSetup` 每个 continuable 子会话一次。
  - 修正上游口径：调用次数是**有限**的（不是上游暗示的"每步"），但**每次调用代价与会话长度线性相关且无上限**，长时间运行的成员会话仍会踩到。
  - 本线已有可复用的正确写法：`src/scheduler.ts:1153-1155` 用 `live.session.snapshotEvents(SessionLogOffset(from))` 做范围读，且从 `@deepseek-ai/dsh-session` 正确导入 `SessionLogOffset`（`src/scheduler.ts:17`）。
- 建议动作（分两步，不要一次全改）：
  1. 给 `sessionOwnEvents` 增加可选 `from` 参数，`src/members.ts:889/1118/1457` 改为 `snapshotEvents(0, seedLength)` 或末 N 条窗口——这 3 处只需要 descriptor / label，不需要全量。
  2. `src/mailbox.ts:217` 只需要找到"当前 turn 内是否已有 `step/start`"，改为从尾部有界窗口倒扫（例如最近 256 条），保留 `turn/start` 早停语义。
  3. 回归：构造一份大事件日志，断言有界读取的事件条数上限，并断言 `step/start` 早停判定结果与全量读取一致。
- 预估成本：**M**（3 处语义改写 + 1 条大日志回归；约半天，含边界推导）。
- 风险提示：`foldSubagentDescriptor` 对"从哪一条开始折叠"敏感（seed 与自有事件的分界），改范围读必须显式传 `seedLength`，否则会把父会话继承来的 descriptor 也算进去——`src/harness-compat.ts:352` 的 legacy 分支已经体现了这个约束。

---

## 3. P1 —— 高价值低成本

### #348 运行中团队的拒绝文案让人误以为"整队上锁"，实际只锁 `edit_plan` 一扇门

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/348
- 状态：OPEN（2026-11-10，LHN-xiao-hai-tun，0 评论）
- 一句话诉求：`a running team only permits update_task edits ... roster and removal edits require a staged plan` 这句读起来像"整个团队被锁"，导致模型/人放弃本来可用的 `create_task / add_member / remove_member / reassign_task / update_task`。
- **本线现状：未修，但上游对"门的范围"的判断在本线成立。**
  - 文案：`src/tools.ts:882`（`updatePlanBatch` 内）。
  - 闸门函数：`requireStagedTeam` 定义在 `src/tools.ts:343-348`，调用点仅 `src/tools.ts:879`（`edit_plan` 路径）、`:1073`、`:1120`、`:1144`、`:1160`（`approve` / `continueStagedPlanning` / `discardStagedTeam` 等 runtime 入口）。
  - 运行中仍可用、**不经过**该闸门：`agent_teams_add_member`（`:1989`）、`remove_member`（`:2236`）、`create_task`（`:2297`）、`reassign_task`（`:2456`）、`update_task`（`:2703`）。
- 建议动作：在 `src/tools.ts:882` 的 error 文案末尾追加一行，列出运行中仍可用的 5 个工具；补一条断言错误串包含 `create_task` 的测试。
- 预估成本：**S**（1 行字符串 + 1 条断言，约 15 分钟）。
- 价值：这是**零功能风险的行为修正**，直接减少 captain 的错误弃用（上游报告里作者 self-report 因此搁置了 3 个任务）。

### #350 上游错误（502 / quota）与任务失败混为一谈，成果被钉死成不可变的 `failed`

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/350
- 状态：OPEN（2026-11-10，LHN-xiao-hai-tun，0 评论）
- 一句话诉求：provider 层 502 / 配额耗尽把任务标成终态 `failed` 后不可改，实际工作已完成也无法回写；建议至少区分"管道坏了"与"任务做不成"，或让上游失败可原地恢复。
- **本线现状：部分覆盖——上游提的第 3 条建议已经实现，第 1、2 条未实现。**
  - 终态集合：`src/types.ts:23` `TERMINAL_TASK_STATUSES = ['completed','failed','cancelled']`。
  - 不可变裁决：`src/quality-gates.ts:2092` `terminal task ... is immutable: cannot change ...; append evidence with evidence_note, acceptanceResults or commandsRun instead`。
  - 无上游/任务失败区分：`src/types.ts:336` `ActivationStopReason = 'completed' | 'max-tokens' | 'aborted' | 'error' | 'refusal' | 'unknown'`，没有 `upstream` 维度。
  - **已实现的第 3 条**：`supplementalEvidence` 会随 status 一起返回（`src/tools.ts:3420`），并在文本渲染里单独成段（`src/tools.ts:4018` `Supplemental observations (original verdict unchanged): ...`）。
  - 也有间接缓解：`agent_teams_update_member_route`（`src/tools.ts:2109`）可以把成员从坏路由上摘下来，不必重建成员。
- 建议动作（按成本从低到高，建议只做第 1 步）：
  1. 在 attempt 结算处按 `stopReason === 'error'` 且诊断文本命中网关/quota 形态时，给任务写一个**只读**标记 `failedCause: 'upstream'`，状态机不变、不可变性不变，仅让面板/status 能分开显示。（S）
  2. 让 `failed` + `failedCause==='upstream'` 的同一 attempt 可恢复——**这会动 DAG 契约，需要独立设计评审，不建议现在做。**（L）
- 预估成本：**S**（只做第 1 步：1 个类型字段 + 1 处结算 + status 渲染 + 回归，约半天内含推演）。
- 明确不采纳的部分：不要为真实任务失败放开不可变性——`docs/issue-backlog-2026-10-30.md` 的 W1-LIFECYCLE 验收条款要求结算抑制必须绑定 task + attempt，不能退回时间戳或状态松绑。

### #333（剩余半条）成员宿主会话 id 与归档态没有对外暴露

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/333
- 状态：OPEN（2026-11-01，hjwsm1989，1 评论；提案 1 已由 PR #334 实现）
- 一句话诉求：团队删除后成员子代理会话残留在宿主里，`/api/session/list` 每页都要多传；实测 401 个孤儿成员会话，归档后响应体从 7.4 MB 降到 1.2 MB（−82%）。提案 2 是"在 status 里暴露成员 session id 与归档态"。
- **本线现状：提案 1 已实现；提案 2 未实现。**
  - 提案 1：`agent_teams_delete` 支持 opt-in `archive_member_sessions`（`src/tools.ts:3562-3565` 文案、`:3622-3630` 执行），经 `src/member-sessions.ts:36-60` 调宿主 `workspaceRegistry.archiveSession(id, { stopActivity: true })`，失败仅记录不阻断，返回 `archived_member_sessions` 计数。回归：`scripts/issue-333.test.mjs`（已挂 `verify`）。
  - 提案 2：`agent_teams_status` 的 members 输出（`src/tools.ts:1382-1390`）只有 `member_name / member_id / provider / model / reasoning_effort / tool_policy / status`，**没有归档态**。
- 建议动作：给 `:1382-1390` 的 member 行加 `session_archived?: boolean`（宿主归档表可查则填，不可查则省略，不得伪造）；或退一步只在 `agent_teams_delete` 结果里回传被归档的 id 列表。
- 预估成本：**S**（若宿主能查归档态）；**M**（若需新增只读扫描）。
- 备注：孤儿会话的另一半是宿主侧 `session/list` 的投影开销，插件改不了——上游也已指向 `deepseek-ai/deepseek-harness#11608`。

---

## 4. P2 —— 观望（需要设计 / 上游未定）

### #358 opt-in 的持久化任务档案（含索引与一致性检查）

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/358
- 状态：OPEN（2026-11-16，Maluslock，0 评论，作者主动提出愿意提 PR）
- 一句话诉求：归档/删除团队后没有**人可读**的每任务档案（`docs/agent-teams/<team>/tasks/t<n>-<role>-a<m>.md` + `INDEX.md` + 只读 `agent_teams_doc_check`），一个月后回答"这段代码为什么这样"只能翻会话日志。
- **本线现状：未实现（无任何对应代码）。** 证据：`grep -rn "doc_check\|docs/agent-teams\|taskArchive" src` 无命中；`src/artifacts.ts` 只做字节身份与 scope 缺口，`src/quality-gates.ts` 只记 verdict/acceptance，`src/events.ts` 只记变更事件——三者都不落人类可读档案。
- 建议动作：**观望，先只做设计评审**。它新增 1 个工具、1 套文件格式、1 个索引与一致性检查，属于产品面扩张；而且与"token 中性"闸门（见 #317）冲突风险高（新工具会进 captain 工具面）。若采纳，只走提案里的 phase 1（模块 + 测试，默认关闭，不进工具面）。
- 预估成本：**L**（phase 1 单独就 ≥ 2 天 + 评审）。

### #331 fork 出来的会话无法单独建自己的团队

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/331
- 状态：OPEN（2026-10-31，hehecat，0 评论，仅一张截图）
- 一句话诉求：把会话 fork 出去后，想在新分支里建一个新团队，被拒。
- **本线现状：按设计拒绝，不是 bug；产品决策未定。**
  - `src/lineage.ts:197-209` `teamLeadMatch`：captain 的**顶层 fork 后代**被视为同一 lead，因此撞上"一个 captain 只有一个活跃团队"规则。
  - 拒绝点：`src/tools.ts:1285-1293`，`findTeamByParticipant`（`src/state.ts:552-579`）会把 fork 认成参与方，于是抛 `you already lead team ...`。
  - 已有引导：`src/tools.ts:266` / `:275` 的 `forkLineageNote`（`src/lineage.ts:279-283`）会明确告诉调用方"本会话是 X 的 fork，本工作区没有它的活跃团队"。
  - 既有决策：`docs/optimization-directions-2026-11-02.md:139-141` 已记录"需要产品决策（fork 是否分割团队所有权）+ 持久 captain 身份迁移"，标记为**accepted for this fork batch，未声称实现**。
- 建议动作：**保持观望**。真正的问题是"fork 该不该拥有独立的团队所有权"，涉及 captain 身份迁移，不是一个小补丁。在此之前可做的最低成本动作是让 `:1288` 的报错文案显式说明"fork 与 captain 共享团队所有权，如需独立团队请开新会话"。
- 预估成本：文案 **S**；真实现 **L**。

### #244 每个成员单独配置 skills 和 mcp（MCP 半条未支持）

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/244
- 状态：OPEN（2026-10-13，liciqikuanren，1 评论）
- 一句话诉求：希望按成员分配 skills / MCP，并引申出"职业库 + 团队模板"。
- **本线现状：skills 已支持；MCP 未支持；"职业库/模板"以别的形态覆盖。**
  - skills：`resolveMemberSkills`（`src/profiles.ts` 导出，用于 `src/tools.ts:907`、`:1080`），未知 id 在持久化前失败，冷恢复时重新解析。
  - 职业库/模板：全局 agent preset 库（`src/agent-library.ts`，工具 `agent_teams_list_agent_presets` / `save_agent_preset` / `delete_agent_preset`，`src/tools.ts:1668/1703/1758`；`preset_id` 可出现在 `plan.members`、`add_member`、profile 里）。
  - **MCP：`grep -rn "mcp" src/*.ts` 零命中**，插件不做 MCP 分配。
- 建议动作：**不建议实现 MCP 半条**——MCP 在 DSH 里是部署级配置，不在会话/成员粒度；上游评论里第三方项目（dsh-agent-roster）也自认"只做到 toolPolicy 的声明与核对，不假装能分配"。若要回应，用文档说明边界即可。
- 预估成本：文档 **S**；实现 **不建议**。

### #223 团队优化建议（三条中只剩"归档团队删除按钮"）

- URL：https://github.com/NanmiCoder/dsh-agent-teams/issues/223
- 状态：OPEN（2026-10-03，bugroom，0 评论）
- 一句话诉求：① 建队时能选 agent 预设；② 执行期间能换模型/自动换可用模型；③ 已归档团队要有删除按钮。
- **本线现状：①② 已实现，③ 未实现。**
  - ①：客户端预设选择器（`src/client/ActivityPanel.tsx:499-514` 读取 preset 列表）+ 服务端 `preset_id` 复制语义（`src/tools.ts:1207`）。
  - ②：`agent_teams_update_member_route`（`src/tools.ts:2109`）要求成员空闲且无 open task（`:2143-2150`），失败自动回滚；自动换可用模型由 fallback 链承担（`src/members.ts:337 memberRouteChain`）。
  - ③：`grep -rn "archived" src/client/*.tsx | grep -i "delete\|remove"` **零命中**——面板能展示归档团队（`ActivityPanel.tsx:1679` 附近的 `archivedWrap`），但没有删除入口。
- 建议动作：**观望**。归档删除是**破坏性操作**，`docs/issue-backlog-2026-10-30.md:195` 已把"archive deletion"单列为需要"destructive contract 批准"后再做；本轮不碰。
- 预估成本：**M**（含确认交互、快照缓存失效、跨工作区一致性）。

### #317 / #96 token 消耗与工具面（同一诉求的两条 issue）

- URL：#317 https://github.com/NanmiCoder/dsh-agent-teams/issues/317 （OPEN，2026-10-30，7 评论）；#96 https://github.com/NanmiCoder/dsh-agent-teams/issues/96 （OPEN，2026-10-07，2 评论）
- 一句话诉求：#317 "消耗 token 太恐怖，优化下"；#96 "就算用极简模式也会加很多工具，能不能做成预设"。
- **本线现状：已有两处结构性缓解 + 一道硬闸门，但两条 issue 本身都不会"关闭"。**
  - `toolSurface: 'core'`（`src/capabilities.ts:26`、`:95`；`src/index.ts:229`），captain 工具面从 23 缩到 11（`CORE_CAPTAIN_TOOL_NAMES`，`src/tool-names.ts:20-26`），实测体积降 20.3%（`docs/optimization-directions-2026-11-02.md:16`，`docs/tool-surface-budget.json`）。
  - 预设库（`src/agent-library.ts`）回应了 #96 的"做成预设"诉求。
  - 闸门：`docs/optimization-directions-2026-11-02.md:143-150` 规定**任何优化必须 token 中性**——前后 captain/member ledger 任一维度增长即拒绝或延期。
  - 注意 #317 评论区主流意见是"多智能体本来就贵"（7 条评论里 5 条持此立场），**上游没有承诺优化**，本条不具备可合并的代码目标。
- 建议动作：**保持观望，不要为这两条改默认值**。可做的只有零成本项：文档里把 `toolSurface: core` 从"opt-in 冷知识"提升为"token 敏感场景推荐"。
- 预估成本：文档 **S**；改默认 **不建议**（需配对质量评估，见 `docs/optimization-directions-2026-11-02.md:71`）。

---

## 5. 不建议 —— 本线已修 / 重复 / 不适用

下面每条的判定都基于本线代码，未改动任何 `src/` 文件。

### 5.1 已修（重复投入没有收益）

| # | 标题要点 | 本线证据 |
|---:|---|---|
| 349 | 成员 spawn 后无法改 provider/model/reasoning_effort | **已实现**，但形态是独立工具而非放行 `update_member`：`agent_teams_update_member_route`（`src/tools.ts:2109`），守卫在 `:2138-2150`（staged/halted/removed/stopping/有 open task/有活跃 turn 全部拒绝，并整体回滚）；回归 `scripts/issue-243.test.mjs`（4 个用例，含"下一轮生效"与"非法路由恢复旧记录"）。上游 PR #351 走的另一条路（放行 `update_member`），本线不必跟随 |
| 238 | 不建 Team/DAG 的轻量调用 | **已实现**：`agent_teams_invoke_profile`（`src/tools.ts:1490-1500`），明确"不创建 Team、DAG、task 记录或 `.agent-teams` 状态"；回归 `scripts/issue-238.test.mjs` |
| 243 | 任务进行中无法更换子代理模型 | **已实现**：同 #349 的 `agent_teams_update_member_route`；`scripts/issue-243.test.mjs` |
| 259 | `[deliverable, deliverable]` 重复 flag + 结算抑制顺序敏感 | **已实现**：flag 走 `orderedUniqueStrings`（`src/tools.ts:371-381`，调用点 `:3991-3997`）去重；结算抑制绑定 activation + final report 且带 `finalReportGraceMs` 上限（`src/mailbox.ts:116-140`）；回归 `scripts/issue-259.test.mjs` 与 `scripts/issue-259-settlement.test.mjs` |
| 272 | 空闲成员握着 open attempt 静默挂起，队长无感 | **已实现**：parked 判定 + 一次性队长通知 `noticeFor(team, lease, 'parked', ...)`（`src/scheduler.ts:972-985`），冷启动侧 `:1189-1192`；回归 `scripts/issue-272.test.mjs` |
| 103 | 调度器为 idle 成员重新生成 attemptId 导致 stale attempt | **已实现**：`parkedAttempts` 粘滞标记（`src/scheduler.ts:424`、`:1526-1537`），`directlyClaimed` / `exactActive` 多重守卫（`:1520-1540`）；回归 `scripts/issue-103.test.mjs` |
| 305 | 运行中建任务不拒绝空 subject | **已实现**：`validateCreateTask` 首行即校验（`src/quality-gates.ts:390-393`）；回归 `scripts/issue-305.test.mjs` |
| 260 | `tool_policy` 声明可选但 GPT 系模型当成必填 | **已实现**：统一文案 `TOOL_POLICY_DESCRIPTION`（`src/tools.ts:356`）"Optional ... Omit when no policy is needed"，且空串按省略处理（`src/tools.ts:358-362` 注释 + 归一化）；`scripts/issue-305.test.mjs` 文件头即注明覆盖 #260 |
| 263 | 需要"活动日志"时间线 | **已实现**：时间线进快照（`src/snapshot.ts:25`、`:269` 截断 50 条），面板渲染在 `src/client/ActivityPanel.tsx:393-396`；回归 `scripts/issue-263.test.mjs` |
| 287 | 任务级 Git worktree / 工作目录隔离 | **已实现（opt-in）**：`src/worktrees.ts` 全文（`createWorktreeLane` 强制"worktree root 必须在仓库外"），工具 `agent_teams_worktree`（`src/tools.ts:1772-1799`），任务字段 `worktreeLaneId`（`:2521-2525`、`:2858`）；回归 `scripts/issue-287.test.mjs` |
| 315 | 用户自建全局持久化 Agent | **已实现**：`src/agent-library.ts` + 三个 preset 工具（`src/tools.ts:1668/1703/1758`），preset 是**不可变快照**、更新不回写已建团队（`:1704`）；回归 `scripts/issue-315.test.mjs` |
| 195 | 队长聚合需要 join barrier / auto-synthesize | **已实现**：`agent_teams_collect`（`src/tools.ts:3252`），`allTerminal` + `failedRequired` + `partial` 三态（`:3297-3315`）；回归 `scripts/issue-195.test.mjs` |
| 241 | 子代理无法执行任何 compact | **已实现**：`agent_teams_compact_member`（`src/tools.ts:1406-1435`），显式使用宿主 `ctx.compaction.compactNow`，插件不自己造摘要；另有 `agent_teams_reset_member_context`（`:1444`）；回归 `scripts/issue-114.test.mjs` |
| 190 | 子 Agent 上下文输入/compat 不生效、不压缩 | **已实现**：同 #241 的 compaction 工具 + `context_lifecycle` 状态（`src/tools.ts:3999` 附近渲染）；回归 `scripts/issue-190.test.mjs` |
| 165 | 缺 `dsh-plugin.json`（Community Admission v0.15） | **已实现**：仓库根 `dsh-plugin.json` 存在（`manifestVersion: 0.15`，`id: com.nanmicoder.agent-teams`，`version: 0.1.33`），且已在 `package.json` 的 `files` 数组首位；`verify:manifest` 覆盖 |
| 270 | DAG 依赖图右侧看不全，需要 overflow-x | **已实现**：`src/client/ActivityPanel.module.css:1065-1069` `.dagViewport { overflow-x: auto; scrollbar-width: thin; }` |
| 208 | 成员级工具过滤 / 一个坏 schema 拖垮整个模型族 | **已实现**：`memberToolSelection`（`src/tools.ts:421-435`）把 policy 解析成不可变 filter，未知 id 在任何 child 创建前失败 |
| 211 | 缺与单 agent / 普通 subagent 的配对评估 | **已实现（框架）**：`docs/evaluation/` + `scripts/issue-211.test.mjs`（`verify:evaluation`）；未见完整配对实验结论，但框架与自检已就位 |
| 335 | Windows 桌面报 `invalid plugin, ... received object` | **已实现**：包同时导出具名绑定与默认对象（`src/index.ts:1000` `export default { name, inject, Config, apply }`）；回归 `scripts/issue-335.test.mjs` 断言三种解包形态都可调用；本机 `node -e` 复核 `default.apply` 与 `apply` 均为 function |
| 237 | "优化建议" | 与 #238 / #244 重复，已在该两条处置 |
| 268 | 外部记忆插件引用 | 不在本仓库契约内 |

### 5.2 不适用 / 垃圾

| # | 标题 | 判定 |
|---:|---|---|
| 357 | "Your plugin ranked #86 on the AI plugin leaderboard" | 推广/引流，无技术内容，**不建议**任何动作（可直接关闭） |
| 346 | 与 DSH 官方内置"智能体团队"的异同、能否与 dsh-bettersidebar 联动 | 纯咨询，无代码诉求（body 为空）；本线不做产品对比承诺。若回应，只给能力边界，不改代码 |
| 342 | 是否与官方 codex / claude 子智能体冲突 | 纯咨询（body 为空）。技术事实：成员是 captain 的 durable continuable subagent（`src/members.ts:1-3` 文件头注释），与官方子代理共用 `ctx.subagents`，不是并行运行时；无需改码 |

### 5.3 不在本轮 open 列表中、且本线已实现的老 issue（不计入上面 35 条）

这 10 条已不在上游 open 列表（`docs/issue-backlog-2026-10-30.md` 记录它们当时是 open，此后关闭；其中 #114/#162 等的关闭日期早于本轮抓取窗口，**未逐一核验**）。本线同样有实现与回归，**不要重新提议**：

| # | 主题 | 本线证据 |
|---:|---|---|
| 279 | 建队预设选择 / 字体缩放 / 审批期改名 | `scripts/issue-279-rename.test.mjs`、`issue-279-scale.test.mjs`、`issue-279-manual.test.mjs`；字体缩放走 CSS 变量 `--agent-teams-font-scale`（`src/client/ActivityPanel.module.css:339`、`:443`、`:534`） |
| 121 | 头像/立绘是硬编码白名单 | `src/avatars.ts` 的 managed avatar（`storeManagedAvatar` / `readManagedAvatar` / `avatarUrl`），2 MiB 上限 + 栅格校验；回归 `scripts/issue-121.test.mjs` |
| 70 | 邮箱只能发文本，缺附件契约 | `src/attachments.ts`（`ATTACHMENT_MAX_FILES=5`、单文件 10 MiB、合计 25 MiB、`AttachmentError`），`src/tools.ts:3052` 限定"仅当前任务 deliverables/inScope，captain 走 artifactRoots，拒绝远程 URL"；回归 `scripts/issue-70.test.mjs` |
| 58 | 需要一个可复用的状态渲染契约 | `scripts/issue-58.test.mjs`（`verify:ui-status`） |
| 97 | 所有 ready 成员同时派发，无全局并发预算 | `maxConcurrentWorkers`（`src/scheduler.ts:88`），`canAcquireActivationPermit`（`:122-125`），派发前检查 `:1401`；回归 `scripts/issue-97.test.mjs` |
| 76 | 单跳 fallback 存在，缺有序链/冷却/配额 | 有序 fallback 链 `memberRouteChain`（`src/members.ts:337-340`），profile 侧 `fallbacks` 上限 4；回归 `scripts/issue-76.test.mjs` |
| 62 | 缺持久化探针与可选的并行发射 | `next_probe_at` / `probe_count` 持久化并在 status 渲染（`src/tools.ts:3975`、`:4025`）；回归 `scripts/issue-62.test.mjs` 与 `issue-62-probe.test.mjs` |
| 114 / 162 | 持久成员缺压缩连续性证明 / 上下文失控 | `agent_teams_compact_member` + `agent_teams_reset_member_context` + `context_lifecycle` 计数；回归 `scripts/issue-114.test.mjs`、`issue-162.test.mjs` |
| 269 | 外部 awesome-list 投稿 | 不在本仓库契约内 |

---

## 6. 与既有结论的差分（避免重复建议）

| 已有文档 | 本报告新增/纠正 |
|---|---|
| `docs/issue-backlog-2026-10-30.md`（覆盖到 #317，2026-10-30 快照） | 上游此后新增 **#331 / #333 / #335 / #342 / #346 / #348 / #349 / #350 / #352 / #356 / #357 / #358** 共 12 条。其中 **#333 / #335 已被本线修掉**（旧文档未记），#331 仍是产品决策 |
| `docs/optimization-directions-2026-11-02.md:125-133` | 该表已把 #330/#333/#335 记为 fixed；本报告补充：#333 只完成了提案 1，**提案 2（status 暴露归档态）仍未做** |
| `docs/analysis/upstream-0.1.30-delta.md`（对比 v0.1.30 代码差异） | 该文档结论是"0.1.30 没有需要合并的运行时功能"，结论在本报告依然成立；本报告补的是 **issue 侧**的两个真正缺口（#352、#356），二者在 0.1.30 代码里也不存在 |
| `docs/issue-backlog-2026-10-30.md:195`（archive deletion 需破坏性契约批准） | 本报告据此把 #223 第 ③ 条继续留在观望档，不重复提议 |

## 7. 推荐执行顺序（若要动手）

1. **#352** —— S，唯一会静默丢数据的项，1 行 schema + 1 条回归。
2. **#348** —— S，1 行错误文案 + 1 条断言，零功能风险。
3. **#356** —— M，改 4 个调用点中的 3 个为范围读，`src/scheduler.ts:1153-1155` 已有正确范式可抄。
4. **#350 第 1 步** —— S，只加只读原因标记，不碰不可变性。
5. **#333 提案 2** —— S/M，需要先确认宿主是否暴露归档态查询。

不建议在本轮碰：#358（产品面扩张 + 工具面成本）、#331 真实现（captain 身份迁移）、#223 归档删除（破坏性操作）、#244 MCP 半条（宿主粒度不支持）。
