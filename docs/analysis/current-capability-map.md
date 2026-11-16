# 当前能力基线（可信版）

仓库：`@nanmicoder/dsh-agent-teams` `0.1.33`，HEAD `8e737dc`（分支 `dsh-1a1d66ea-8c22`）。
方法：只读源码 + docs 交叉核对，每行给出可复核的 `file:line`。未验证能力不计入「已实现」。

## 能力矩阵

| 能力项 | 状态 | 代码入口 file:line | 备注（限制条件） |
|---|---|---|---|
| 成员独立模型 + reasoning effort | 已实现 | `src/members.ts:721` `resolveMemberLlmSelection`；`src/tools.ts:1989` add_member、`src/tools.ts:2109` update_member_route；`src/profiles.ts:28` 成员键含 `reasoning_effort` | 显式 provider 必须同时给 model（`src/members.ts:754`）；沿用队长路由则继承 effort，换路由自动落目标模型默认档；fallback 链最多 4 条（`:734`）；无逐成员二次弹窗 |
| 成员上下文隔离（durable 子会话） | 已实现 | `src/harness-compat.ts:65` `startContinuable?`、`:155` 实调；`src/members.ts:1322` 冷恢复重建子会话；`src/tools.ts:1444` 重置上下文 | 成员 id 即 durable child session id，跨重启可续聊；`memberMaxDepth` 默认 `0`，成员不能再派子代理（`src/index.ts` config）；重置保留 roster/route/skills/worktree，只换 child |
| 专家预设 preset（含外部格式导入） | 部分 | `src/agent-library.ts:7` `AGENT_LIBRARY_FILE='agent-library/presets.json'`、`:34` load、`:72` save；`src/tools.ts:1668/1703/1758` list/save/delete；`src/index.ts:715` GET 路由 | 私有格式 `schemaVersion:1`，上限 100 条（`agent-library.ts:9`）；**没有** import/export 能力，也不认任何外部 preset 格式（全仓库 grep 无命中）；默认关（`agentLibrary.enabled`，`src/index.ts:222`）；不可变 revision，改版不改已复制它的团队 |
| 成员工具策略 tool policy | 已实现 | `src/tool-policies.ts:205` `resolveMemberToolFilter`；`src/tool-policies.ts:12` 传给 `startContinuable({ toolFilter })`；`src/index.ts:125`/`:210` 配置解析 | 由部署方声明 `toolPolicies`，模型只能按 id 选择，不能提交原始 allow/deny；队长专属工具恒拒、四个协调工具恒可；**不是 OS 沙箱或授权边界**（`src/tool-policies.ts:14`、`README.md:205`） |
| 成员路由热切换 | 已实现 | `src/tools.ts:2109` `agent_teams_update_member_route` | 仅限 running 团队的 idle 成员；staged/halted/removed/stopping、有活跃 turn、有 open attempt 一律拒绝；改动在下一轮生效，不动 attempt 身份 |
| 上下文压缩 / reset member context | 部分 | `src/tools.ts:1444` reset（需 `confirmed_by_user`）；`src/tools.ts:1406` compact_member → `ctx.compaction.compactNow`（`:1432`） | reset 完整；**压缩只能代触发**，阈值不可控：宿主 `CompactionEngine` 只有 provider+model 维度的加载期配置，无 session/agent/team 维，无运行期 setter（`docs/project-status-2026-11-06.zh.md:161`）；「主 agent 控子 agent 阈值」方案封存 design-only（同文件 `:123,134`） |
| worktree lane 工作区隔离 | 已实现（opt-in） | `src/worktrees.ts:47` create、`:93` integrate、`:103` cleanup；`src/tools.ts:1772` `agent_teams_worktree` | 默认关闭；root 必须在仓库外且非符号链接（`src/worktrees.ts:56`）；integrate 拒绝脏 lane/脏主工作区，cleanup 拒绝未合并，绝不 force/prune；动作需 `confirmed_by_user` |
| DAG 调度与并行 | 已实现 | `src/state.ts:173` `unsatisfiedDependencies`；`src/scheduler.ts:1349` kickTeam、`:1363` kickMember、`:120` `canAcquireActivationPermit` | 依赖只认上游 `completed`，`failed/cancelled` 永不解锁；并行受 `maxConcurrentWorkers` 配额（默认 = `maxMembers` = 8，`src/index.ts:264-265`）；`kickTeam` 逐成员串行 `await`（`:1357-1360`），不是 batched fan-out；`parallelToolCalls` 默认 false（`src/index.ts:228`） |
| quality gates 六种 kind + review 循环 | 已实现 | `src/types.ts:26-41` `TaskKind` = requirements/implementation/verification/review/repair/integration(+work)；`src/quality-gates.ts:390` validateCreateTask、`:551` evaluateQualityCompletion、`:935` planQualityFollowUp | review/requirements 只有 `verdict=pass` 能 completed，`needs_revision/reject` 必须 failed 且带 finding；失败后自动开不依赖 failed review 的 repair + 下一轮 review；上限后 `escalated`；**范围控制是完成时审计，不是 host 写入拦截**（`docs/quality-gates.md:83-85`、`docs/usage.md:45`） |
| collect / join barrier | 已实现 | `src/tools.ts:3252` `agent_teams_collect` | 确定性、不调模型；非终态默认 fail-closed，`partial=true` 才放行；失败/取消的必需任务仍 `ok=false`；`digest=extractive` 只是拼接摘要（`:762`），不是模型综合；每 barrier 幂等发一次邮箱通知，barrier 保留最近 32 个（`:3312`） |
| Web 活动面板 / 实时状态 | 已实现 | `src/client/index.tsx:114` `shell.overlay`；`src/client/ActivityPanel.tsx`；`src/index.ts:338` `/state`；`src/web-routes.ts:87` ETag/304 | 1s 轮询（`src/client/activity-monitor.ts:245`），隐藏页降频；真实状态来自 `ctx.agents` 的 running/idle/ready（`src/snapshot.ts:168`），非猜测；**面板只显示当前会话团队**（`captainSessionId` 过滤，`src/client/activity-monitor.ts:285`） |
| 任务看板 / 任务列表 UI | 部分 | `src/client/ActivityPanel.tsx:750` 依赖 DAG（SVG 曲线）；`:747` 无依赖时切平行网格；`src/client/activity-model.ts:199` `usesParallelTaskGrid`；`src/client/StagingPlanEditor.tsx:617` 计划期编辑 | 有任务可视化（DAG / 平行网格 / 状态标签 / 模型短名），但**没有独立任务看板页，也没有按状态分列的 Kanban**；任务列表只作为团队面板内的一段存在 |
| 跨会话协作（root 会话之间） | 部分 | `src/lineage.ts:197` `teamLeadMatch`（top-level fork 后代继承 lead）、`:112` `isTopLevelSession`；`src/state.ts:513` `findTeamByCaptain` | 同链 fork 会话可继续领导同一团队；但**两个独立 root 会话之间没有任何共享通道**——一队长一团队（`README.md:261`、`docs/usage.md:154`），同一 captain 命中多个团队直接报错（`src/state.ts:534`）；`teamLeadDistance` 距离制择优不在本 HEAD |
| 群聊 / 广播消息 | 缺失 | `src/tools.ts:3050` `to` 只接受 `"captain"` 或单个成员名 | 无 `@all`、无广播、无群聊视图；grep 全仓库无 broadcast 实现；消息是点对点 mail（`src/mailbox.ts`） |
| 共享记忆 | 缺失 | — | 无团队级共享记忆/KB；跨成员的信息传递只有 mailbox 消息与任务 `output`（`src/scheduler.ts:1610` 依赖输出注入，单条 2 000 字符、合计 12 000 字符，`:50-52`） |
| token 计量 / 成本账本 | 缺失 | — | 本 HEAD 无 usage 账本：全仓库 grep `byRole` 无命中；`metrics.byRole` 只存在于分支 `codex/317-usage-ledger`（`128e29d`），未合入（`docs/project-status-2026-11-06.zh.md:147`）；`agent_teams_status` 不返回 token |

## 明确记录为不做 / 被否决的方向

| 方向 | 结论 | 理由与出处 |
|---|---|---|
| 渐进式工具加载（先 open 再补工具面） | **已撤回并删除** | 长会话实测切换 system/tools 后缓存读显著下降；`open` 已删除，规则改为首次请求即固定（`docs/progressive-loading.md:21-25`） |
| 每成员独立压缩阈值 | **不可表达 → design-only 封存** | 宿主 `CompactionEngine` 无 session/agent/team 维度、无运行期 setter；Phase 1–5 全部未实现（`docs/project-status-2026-11-06.zh.md:123,134,161`） |
| 任何增加 prompt/tool/schema 足迹的优化 | **硬门拒绝** | Token-neutral gate：新增足迹 > 0 即拒绝或延后，须 captain/member 逐维账本对照（`docs/optimization-directions-2026-11-02.md:143-150`） |
| 自建 workflow 引擎 | 不做 | 复用现有 DAG/attempt/halt/scheduler（`docs/quality-gates.md:67`） |
| 实现者自审自己的实现 | 禁止 | 「不要让实现者批准自己的实现或修复」（`docs/quality-gates.md:70`） |
| Host 级 bash/fs 写入拦截 | 不做 | 无 host 统一写入拦截接口，第一版只保证完成时审计（`docs/quality-gates.md:808`、`:83-85`） |
| 人类会签投票组件 | 不做 | `docs/quality-gates.md:809` |
| 自动部署 / 生产发布 | 不做 | `docs/quality-gates.md:80,810` |
| 多团队并行（一 captain 多团队） | 不做 | `docs/quality-gates.md:811`、`README.md:261`、`docs/usage.md:154` |
| 修改官方 DeepSeek Harness | 不做 | `docs/quality-gates.md:812` |
| 多命令派发 / 命令元数据本地化（#71） | 超出范围 | 需要更新的 host command registry/locale 契约（`docs/issue-backlog-2026-10-30.md:110`） |
| 外部记忆插件契约（#268）、awesome-list 提交（#269） | 超出范围 | 非本仓库契约（`docs/issue-backlog-2026-10-30.md:85-86`） |
| 活动面板卡死问题（#151） | 超出范围 | 截图是 host 任务管理器+后台 Bash，不是 AgentTeams 面板（`docs/issue-backlog-2026-10-30.md:29`） |

> 历史注意：`docs/quality-gates.md:804-812` 的「不做」清单写在实现之前，其中「Staging UI」「独立 worktree」后来已实现（见上表），只有「写入拦截 / 会签 / 自动部署 / 多团队并行 / 改官方宿主」仍然成立。

## 证据边界

- 上述「已实现」只代表代码路径存在且被 `pnpm verify` 覆盖，不等于真机全绿。跨平台证据仍缺：Windows 与 Ubuntu 的 rc 矩阵、Web GUI 运行时评估（`README.md:39,71`）。
- 本 HEAD 无 `teamLeadDistance`、无 `byRole`；引用 `docs/project-status-2026-11-06.zh.md` 里标记 ⧉ 的能力时，注意那些文件在未合并分支 `ad763c1` 上，不在当前工作树。
- `docs/tool-surface-budget.json` 的 token 是「字节 ÷ 4」估算，不是 tokenizer 实测（`docs/project-status-2026-11-06.zh.md:247`）。
