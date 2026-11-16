# PRD 第三部分：竞品能力取舍 · 里程碑排期 · 风险

> 基线 `@nanmicoder/dsh-agent-teams` 0.1.33 / Harness `0.2.2-rc.3` / 分支 `dsh-1a1d66ea-8c22`（HEAD `e000f8a`）
> 依据：[competitor-features.md](../analysis/competitor-features.md) §7.1/§7.2/§7.3 · [current-capability-map.md](../analysis/current-capability-map.md) · [upstream-0.1.30-merge-analysis-2026-11-16.md](../upstream-0.1.30-merge-analysis-2026-11-16.md) P0/P1/P2 总表
> R1–R5 编号沿用 PRD B 段（失败恢复）定义：R1 失败清扫租约并回 idle · R2 `NOT_RESUMABLE` 分码 · R3 运行中改模型/推理档 · R4 死会话消息自动 reset · R5 连续派发失败熔断。**这五个编号目前不在任何 docs 文件中**，为本次事故研判口头定义。

## 1. 借鉴矩阵

只列**本轮真正落地**的三组来源、五个机制。其余竞品能力一律进 §2。

| 竞品 | 值得借鉴的机制 | 落到哪个需求编号 | 取舍理由 |
|---|---|---|---|
| 8kugames/dsh-team-bots | **派单期写范围准入**：领取任务前比对**在跑**任务的 `inScope`，两个写任务重叠则拒绝或串行；对 `package.json` 类机械改动留豁免名单 | **P0-3** | 仓库已有 `inScope`、`inScopeOverlap`（`src/quality-gates.ts:348`）、`WRITE_KINDS`（`:38`）三块现成积木，只在 `create_task`/`edit_plan` 校验，`reassign_task` 派单路径（`src/scheduler.ts:1595-1626`）完全不查。成本 M，同时提升并行度与正确性——唯一可两全的机制。判定必须只在双方都声明范围时生效，否则会把「串行化」误伤成「死锁」 |
| 8kugames/dsh-team-bots | **任务改写 `expected_revision` 乐观锁** | **P0-4** | `attempt`/`attemptId` 只拦「旧代际写结果」，拦不住「队长读到旧卡片后改写合同」。纯参数级增量，不改现有调用方，成本 S。`TeamTask` 当前**没有** `revision`/`version` 字段（只有 `revisions?: TaskRevision[]` 审计账本），需新增计数器 |
| 8kugames/dsh-team-bots | **只读交付免核验** | **P2** | 用宿主 effective sandbox（read-only）作不可伪造判定，写 `verificationSkipped: 'read-only'`。这是**放宽门禁**，必须与 P2 其余设计项同批出 RFC，不能单点合入 |
| weibaohui/experts-management | **专家目录导入格式**：`plugin.json + agents/*.md + skills/ + avatars/` → `AgentPresetV1`（`role`←frontmatter、`executionPrompt`←正文、`skillIds`←skills 清单） | **P1-4** | 已是社区事实标准格式，本仓库 `src/agent-library.ts` 只有私有 `presets.json`（`schemaVersion:1`，无 import/export）。纯适配、无网络依赖、不触调度，成本 S/M。`skillIds` 必须映射到 `config.skills` 的 owner 声明 id，未知 id 在持久化前失败 |
| limuyang2/agent-team + cao123-2024/dsh-cross-session | **消息 `idempotencyKey` + 反乒乓上限** | **P0-5** | `TeamMessage`（`src/types.ts:498-530`）有 delivery/read 时间戳但无幂等键，`send_message` 无频率/链路上限。不加则两成员互发「收到请回复」时 mailbox 按 tick 无界增长。成本 S、低风险，可立即并入 `pnpm verify` |

**判断口径**：竞品机制只有在「本仓库已有可复用积木」或「宿主已有不可伪造依据」时才立项；需要重写会话模型或引入新宿主人事依赖的一律进 §2，不论其产品完成度多高。

## 2. 明确不借鉴

每条一行 + 一句理由。

- **成员 = 独立 root 会话**（limuyang2/agent-team）— 毁掉 attempt/attemptId 代际围栏、`lineage.ts` 父链身份、worktree lane 三层语义（三者都以「子代理」为前提），需重写 `members.ts`(1507 行)+`scheduler.ts`(1820 行)；该仓库自身 3 个月无更新、宿主锁在 `0.1.1-rc.2`，代价 L 收益不抵。
- **root 会话间直接喊话**（cao123-2024/dsh-cross-session）— 直接打穿「一队长一团队」这条刻意约束（`docs/usage.md:154`、`src/state.ts:534`），且用标题前缀当角色是 UI 约定而非持久身份，与 `lineage.ts` 相反。
- **导演发言规划器**（DandanLLab/dsh-plugin-team-group）— 与 captain 规划职责重复、两个规划器互相覆盖，且每轮多一次模型调用，直接违反 token-neutral gate。
- **team-bots 群聊三模式 + SQLite 记忆库** — 产品面完全不同（它是「团队工作区 OS」，我们是「单会话内的团队协议」）；SQLite 迁移栈 + 微信/Lark 渠道 SDK 会把插件从 2.2 MB 抬到不可接受，且与 quality gates / tool policy 无交集。
- **dsh-web 全家桶**（22 包 / ~1.5 GB）— 是 GUI 工作台不是团队协作能力，任何借鉴都是重量级耦合；且本次仅文档级验证、源码未读，不足以支撑立项。只作文档参照。

### 本仓库已记录为不做的方向

取自 `current-capability-map.md` 否决清单（原文 §「明确记录为不做」）：

| 方向 | 理由与出处 |
|---|---|
| Host 级 bash/fs 写入拦截 | 宿主无统一写入拦截接口，第一版只保证完成时审计（`docs/quality-gates.md:808`、`:83-85`） |
| 实现者自审自己的实现 | 「不要让实现者批准自己的实现或修复」（`docs/quality-gates.md:70`） |
| 多团队并行（一 captain 多团队） | 一队长一团队是刻意约束（`README.md:261`、`docs/usage.md:154`） |
| 自动部署 / 生产发布 / 人类会签投票 | 不在插件职责内（`docs/quality-gates.md:80,809-810`） |
| 每成员独立压缩阈值 | 宿主 `CompactionEngine` 无 session/agent/team 维度、无运行期 setter，design-only 封存（`docs/project-status-2026-11-06.zh.md:123,134,161`） |

## 3. 里程碑

| 档位 | 需求编号 | 可交付物 | 验收门槛 | 预估 | 前置依赖 |
|---|---|---|---|---|---|
| **M1 止血** | P0-1、P0-2、R1、R2、R5 | 目标一句话：**失败可诊断、可重试**。① `plan.members[]` 补 `executionPrompt`（schema `src/tools.ts:1202-1208` 是 `additionalProperties:false`，消费端 `:3689` 却读它，传了必丢）；② `requireStagedTeam` 错误文案按工具区分并列出运行中仍可用的 5 个工具；③ 失败路径清扫 activation 租约 + 成员回 `idle`（现状 `src/members.ts:507` 仅在非 running 时置 idle）；④ `NOT_RESUMABLE` 拆「已退休」/「从未启动」两码并给出口提示；⑤ 连续 N 次派发失败熔断 + `lastError` | ① 传该字段后 `resolveTeamProfile` 返回值含它，1 条回归；② 断言错误串包含 `create_task`；③ 失败后成员 `idle`、无残留 `permitHeld`，attempt 不再静默 1→16；④ 两种错误码可区分且文案不同；⑤ 超限后不再涨 attempt，status 显示 `lastError` | **3–4 人日** | 无（可立即开工，互不依赖） |
| **M2 正确性** | P0-3、P0-4、P1-3、R3、P1-1、P1-2 | ① 派单期范围准入闸；② `expected_revision` 乐观锁；③ `sessionOwnEvents` 改范围读（4 个调用点，至少改 `src/members.ts:889/1118/1457` 三处）；④ 面板成员行加路由编辑入口（现 `src/client/ActivityPanel.tsx:1035-1037` 只有非交互徽标）；⑤ 平台 optional 包 cohort 校验；⑥ `publish.yml` consumer-resolution 守卫 | ① 两成员 `inScope` 重叠时 `reassign_task` 拒绝或串行；② 陈旧 revision 的 `amend_task` 被拒；③ 大日志下断言有界读取条数上限、`step/start` 早停结果与全量一致；④ 运行中 idle 成员改路由后下一轮生效；⑤ **test 数 2→3 且新用例断言 `skipped[].reason === 'optional-platform'`**（现有 platform 测试只覆盖 `linkDirectory`，不能当验收）；⑥ job 带 `if: !cancelled() && needs.publish.result == 'success'` | **5–7 人日** | M1。P0-3 需先定「重叠即拒绝还是串行」的产品口径；④ 依赖 R2 的错误码先落地 |
| **M3 扩展** | P1-4、P0-5、P2、R4 | ① 专家目录导入（新 `src/agent-library-import.ts`）；② 消息 `idempotencyKey` + 反乒乓上限；③ P2 设计包：token/成本计量、`/expert-name` 召唤手势、只读免核验，**先出 RFC 再编码**；④ 死会话消息自动 reset 后投递（或明确告知需先 reset） | ① 导入后生成合法 `AgentPresetV1`，未知 skill id 原子失败；② 重复投递去重，A↔B 互刷超限被拒；③ RFC 通过 token-neutral 对照（前后 captain/member ledger 任一维度不得增长）；④ **死成员收到一条消息后能跑完一轮**（不是「记录了一条 reset」） | **8–10 人日** | M2。③ 强依赖宿主能力探测（见 §4）；④ 依赖 M1 的 R2 错误码分类 |

**为什么 M1 必须先行**：今天这个仓库连「失败之后怎么恢复」都答不出来——失败只写 `task.status='failed'` 加一条 notice，成员状态、租约、attempt 三者可能互相不一致，诊断信息落在 `lease.diagnostic` 里但 status 不聚合成一句可读原因。在这种状态下，M2/M3 的任何新能力都**无法在真实团队里被验证**：测试跑不到「派单期范围冲突」就会先撞上「成员卡死在 running」；压测 token 计量时会先被无界 attempt 拖垮。M1 的 3–4 人日不是功能投入，是**把后续所有验收变成可能**的前置成本——它把「失败」从不可观测的黑洞，变成一个有错误码、有 `lastError`、可 reset 可重试的状态。

## 4. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| **宿主 member spawn 路径缺陷未修**（平台侧，不在本仓库） | 插件只能在**自己这一层**止损：清扫租约、回 idle、熔断、给错误码；真因在宿主则复发只是时间问题 | 把 R1/R5 设计成**幂等且可重入**的止损，不假设宿主何时修；面板与 status 显式标注「宿主侧异常」；同步向宿主提 issue 并留复现脚本 |
| **真实回归验证依赖可用的团队运行时** | 单测只能证明纯函数分支，证明不了「成员真的跑完一轮」。本机 `pnpm` 不在 PATH（`docs/upgrade/0.2.2-verification-rerun.md:103`）、真机矩阵跨平台证据仍缺（`README.md:39,71`） | 每个 P0 都配一条**最小真机脚本**（建 2 人队 → 制造失败 → 断言 `idle`+`lastError`）；CI 只跑纯函数层，真机层列为发版门禁 |
| **`/expert-name` 依赖宿主 `userInvocable: true` 支持（未验证）** | 若宿主不支持 `modelInvocable:false / userInvocable:true` 组合，P2 的召唤手势需整体换方案（改走 `ctx.commands`），P1-4 的导入成果无法闭环 | **未验证前不得立项**；先做一次独立宿主能力探测（`grep -rn 'userInvocable\|modelInvocable' src/` 当前零命中），探测结果写成一次性 decision note 再决定 P2 范围 |
| **token 计量与 #317 token-neutral 决议冲突** | `docs/optimization-directions-2026-11-02.md:143-150` 规定任何优化新增 prompt/tool/schema footprint 必须为零；计量本身要新增持久化与事件折叠，容易被判违规 | 论证口径固定为「**纯旁路观测**」：只读宿主 `session/event` 的 usage 事件、不新增任何 prompt 段落或工具 schema，并附前后 ledger 对照；若仍需新增足迹则降级为可选 `usageLedger.enabled` 默认关 |
| **P2 与 backlog `#223`/`#315` 重叠** | 重复投入风险；且两份文档对同一条 issue 结论相反（见下「冲突」） | 立项时合并引用 backlog 而非新建条目；`#223` 只取「归档删除」这一条未实现部分，`#315` 只取 preset 库剩余拆分，其余判为已完成不重做 |
| R3 改路由与「attempt 身份冻结」语义摩擦 | 运行中改模型可能被误读为「换人」，动摇审计前提 | 复用现成 `agent_teams_update_member_route`（`src/tools.ts:2109`，仅限 idle 且无 open attempt），面板入口只是给它加 UI，不新增服务端路径 |
| 写范围准入闸误伤成串行死锁 | 并行度反而下降，团队卡在互相等待 | 只在**双方都声明** `inScope` 时判定；worktree lane 开启时恒放行（成员各占独立工作树，闸门无意义）；机械改动留豁免名单（team-bots 的 `DSHBOTS-133` 教训） |
